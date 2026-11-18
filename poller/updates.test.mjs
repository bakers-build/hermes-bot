import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { forget, previewZones, updates } from './updates.mjs';

const messages = JSON.parse(readFileSync(new URL('./messages.json', import.meta.url), 'utf8')).de;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MIN = 60 * 1000;
const INTERVAL = 30 * MIN;
const where = { channel: 'C0000000001' };

const run = (id, state, at = 'working', started = NOW / 1000 - 60) => ({ uuid: id, state, state_at_start: at, started_at: started, closed: !['claimed', 'running'].includes(state) });
const summary = (id, body, created = '2026-11-05T11:59:00Z') => ({ id, type: 'summary', created, body });
const ticket = (fields = {}) => ({ identifier: 'ACME-1', state: 'working', labels: [], conversation: where, links: [], runs: [], comments: [], ...fields });
const seen = { runs: {}, summaries: [], links: [], lastStart: null };
// A pass after the ticket was first seen, with the conversation's last post `quiet` ago.
const pass = (tickets, { previous = { 'ACME-1': seen }, quiet = 0, now = NOW, zones } = {}) =>
  updates({ previous, posted: { C0000000001: now - quiet }, tickets, now, interval: INTERVAL, messages, zones });
const texts = (result) => result.posts.map((p) => p.text);

test('a ticket seen the first time records its runs, summaries and links and posts nothing', () => {
  const t = ticket({
    runs: [run('r2', 'running'), run('r1', 'failed')],
    comments: [summary('c1', '### Outcome\n\nThe price list is updated.')],
    links: [{ uri: 'https://acme-135.ddev.site/prices', title: 'Price list' }],
  });
  const result = updates({ previous: {}, posted: {}, tickets: [t], now: NOW, interval: INTERVAL, messages });
  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.next.records['ACME-1'], { runs: { r2: 'running', r1: 'failed' }, summaries: ['c1'], links: ['https://acme-135.ddev.site/prices'], lastStart: null, pending: {} });
  assert.deepEqual(result.next.posted, { C0000000001: NOW });
});

test('a new run posts the start line of the state it starts in, once', () => {
  const first = pass([ticket({ runs: [run('r1', 'running', 'working')] })]);
  assert.deepEqual(first.posts, [{ identifier: 'ACME-1', channel: 'C0000000001', text: messages.runStart.working, run: ['r1', undefined], lastStart: null }]);
  const again = pass([ticket({ runs: [run('r1', 'running', 'working')] })], { previous: first.next.records });
  assert.deepEqual(again.posts, []);
  for (const state of ['qualification', 'plan', 'review']) {
    assert.deepEqual(texts(pass([ticket({ state, runs: [run('r1', 'claimed', state)] })])), [messages.runStart[state]]);
  }
});

test('a run starting within 5 minutes of the last posted start is recorded but not posted', () => {
  const recent = { ...seen, lastStart: NOW - 4 * MIN };
  const collapsed = pass([ticket({ runs: [run('r2', 'running')] })], { previous: { 'ACME-1': recent } });
  assert.deepEqual(collapsed.posts, []);
  assert.equal(collapsed.next.records['ACME-1'].runs.r2, 'running');
  const later = pass([ticket({ runs: [run('r2', 'running')] })], { previous: { 'ACME-1': { ...seen, lastStart: NOW - 6 * MIN } } });
  assert.deepEqual(texts(later), [messages.runStart.working]);
  assert.equal(later.next.records['ACME-1'].lastStart, NOW);
});

test('a run that ends failed, expired or cancelled in the same state posts the paused line once, on the next pass that still finds the ticket open', () => {
  for (const end of ['failed', 'expired', 'cancelled']) {
    const seenEnd = pass([ticket({ runs: [run('r1', end)] })], { previous: { 'ACME-1': { ...seen, runs: { r1: 'running' } } } });
    assert.deepEqual(seenEnd.posts, [], end);
    const next = pass([ticket({ runs: [run('r1', end)] })], { previous: seenEnd.next.records });
    assert.deepEqual(next.posts, [{ identifier: 'ACME-1', channel: 'C0000000001', text: messages.runPaused, pending: ['r1', 'running'] }], end);
    assert.deepEqual(pass([ticket({ runs: [run('r1', end)] })], { previous: next.next.records }).posts, [], end);
  }
});

test('a run that ended not done on a frozen ticket posts nothing, also when its label comes a pass later', () => {
  const previous = { 'ACME-1': { ...seen, runs: { r1: 'running' } } };
  for (const end of ['failed', 'expired', 'cancelled']) {
    const frozen = pass([ticket({ frozen: true, runs: [run('r1', end)] })], { previous });
    assert.deepEqual(frozen.posts, [], end);
    for (const label of ['Question', 'technical problem']) {
      assert.deepEqual(pass([ticket({ frozen: true, labels: [label], runs: [run('r1', end)] })], { previous: frozen.next.records }).posts, [], `${end}, ${label}`);
    }
  }
});

test('a pending paused line is dropped when the next pass finds the ticket frozen, labelled or in another state', () => {
  const seenEnd = pass([ticket({ runs: [run('r1', 'failed')] })], { previous: { 'ACME-1': { ...seen, runs: { r1: 'running' } } } });
  for (const later of [{ frozen: true }, { frozen: true, labels: ['technical problem'] }, { labels: ['Question'] }, { state: 'review' }]) {
    const next = pass([ticket({ ...later, runs: [run('r1', 'failed')] })], { previous: seenEnd.next.records });
    assert.deepEqual(next.posts, [], JSON.stringify(later));
    assert.deepEqual(pass([ticket({ runs: [run('r1', 'failed')] })], { previous: next.next.records }).posts, [], JSON.stringify(later));
  }
});

test('a refused pending paused line is posted on the following pass, once', () => {
  const seenEnd = pass([ticket({ runs: [run('r1', 'failed')] })], { previous: { 'ACME-1': { ...seen, runs: { r1: 'running' } } } });
  const refused = pass([ticket({ runs: [run('r1', 'failed')] })], { previous: seenEnd.next.records });
  forget(refused.next.records, refused.posts[0]);
  const retried = pass([ticket({ runs: [run('r1', 'failed')] })], { previous: refused.next.records });
  assert.deepEqual(texts(retried), [messages.runPaused]);
  assert.deepEqual(pass([ticket({ runs: [run('r1', 'failed')] })], { previous: retried.next.records }).posts, []);
});

test('a run that ends done in the same state posts the waiting line, and no run in any end state posts while a question or technical problem is open', () => {
  const previous = { 'ACME-1': { ...seen, runs: { r1: 'running' } } };
  assert.deepEqual(texts(pass([ticket({ runs: [run('r1', 'done')] })], { previous })), [messages.runWaiting]);
  for (const label of ['Question', 'technical problem']) {
    for (const end of ['done', 'failed', 'expired', 'cancelled']) {
      assert.deepEqual(pass([ticket({ labels: [label], runs: [run('r1', end)] })], { previous }).posts, [], `${label}, ${end}`);
    }
  }
});

test('a run whose ticket changed state posts no end line; the state line says it', () => {
  const previous = { 'ACME-1': { ...seen, runs: { r1: 'running' } } };
  assert.deepEqual(pass([ticket({ state: 'review', runs: [run('r1', 'done', 'working')] })], { previous }).posts, []);
  assert.deepEqual(pass([ticket({ state: 'review', runs: [run('r1', 'failed', 'working')] })], { previous }).posts, []);
});

test('a run first seen already ended, as after an outage, posts its start line and then its end line, once', () => {
  const first = pass([ticket({ runs: [run('r1', 'failed')] })]);
  assert.deepEqual(texts(first), [messages.runStart.working]);
  const next = pass([ticket({ runs: [run('r1', 'failed')] })], { previous: first.next.records });
  assert.deepEqual(texts(next), [messages.runPaused]);
  assert.deepEqual(pass([ticket({ runs: [run('r1', 'failed')] })], { previous: next.next.records }).posts, []);
  assert.deepEqual(texts(pass([ticket({ runs: [run('r1', 'done')] })])), [messages.runStart.working, messages.runWaiting]);
  assert.deepEqual(texts(pass([ticket({ labels: ['Question'], runs: [run('r1', 'done')] })])), [messages.runStart.working]);
  assert.deepEqual(texts(pass([ticket({ state: 'review', runs: [run('r1', 'failed', 'working')] })])), [messages.runStart.working]);
});

test('a refused end line of a run first seen ended is retried alone; a refused start line retries both', () => {
  const failed = () => [ticket({ runs: [run('r1', 'failed')] })];
  const first = pass(failed());
  const next = pass(failed(), { previous: first.next.records });
  forget(next.next.records, next.posts[0]);
  assert.deepEqual(texts(pass(failed(), { previous: next.next.records })), [messages.runPaused]);
  const both = structuredClone(first.next.records);
  forget(both, first.posts[0]);
  const again = pass(failed(), { previous: both });
  assert.deepEqual(texts(again), [messages.runStart.working]);
  const paused = pass(failed(), { previous: again.next.records });
  assert.deepEqual(texts(paused), [messages.runPaused]);
  assert.deepEqual(pass(failed(), { previous: paused.next.records }).posts, []);
  const done = pass([ticket({ runs: [run('r1', 'done')] })]);
  forget(done.next.records, done.posts[1]);
  assert.deepEqual(texts(pass([ticket({ runs: [run('r1', 'done')] })], { previous: done.next.records })), [messages.runWaiting]);
});

test('summary sentences with a run ID or an agent name are left out', () => {
  const body = '## Outcome\n\nRun 0b6a3f0e-5c1d-4a7e-9f21-3d4c5b6a7e8f stopped. Opus wrote the price importer.';
  assert.deepEqual(pass([ticket({ comments: [summary('c1', body)] })]).posts, []);
});

test('plain sentences with everyday words or lower-case codes are kept', () => {
  const body = '## Outcome\n\nThe bug is fixed and the review page is done. Files are read as utf-8 now.';
  assert.deepEqual(texts(pass([ticket({ comments: [summary('c1', body)] })])), ['The bug is fixed and the review page is done. Files are read as utf-8 now.']);
});

test('a new summary posts the first two sentences of its Outcome, without Markdown, once', () => {
  const body = '### 🎯 Outcome\n\nThe price list now updates **every night**. Old prices stay in the [history](https://x.example/h). Nothing else changed.\n\n### ✅ Success\n\nAll fine.';
  const result = pass([ticket({ comments: [summary('c1', body)] })]);
  assert.deepEqual(result.posts, [{ identifier: 'ACME-1', channel: 'C0000000001', text: 'The price list now updates every night. Old prices stay in the history.', summary: 'c1' }]);
  assert.deepEqual(pass([ticket({ comments: [summary('c1', body)] })], { previous: result.next.records }).posts, []);
});

test('summary sentences with code, ticket identifiers, AC IDs or state, recipe and type names are left out', () => {
  const body = '## Outcome\n\nI qualified ACME-12 *Price updater*. The recipe is `matt` and the type is feature.';
  assert.deepEqual(pass([ticket({ comments: [summary('c1', body)] })]).posts, []);
  const mixed = '## Outcome\n\nAC-3 passes now. Prices of <b>shops</b> & suppliers update at night.';
  assert.deepEqual(texts(pass([ticket({ comments: [summary('c1', mixed)] })])), ['Prices of &lt;b&gt;shops&lt;/b&gt; &amp; suppliers update at night.']);
});

test('a summary without an Outcome section or other comment types post nothing', () => {
  const t = ticket({ comments: [summary('c1', '### Next action\n\nApprove it.'), { id: 'c2', type: 'plan', created: '2026-11-05T11:00:00Z', body: '## Outcome\n\nPlain words.' }] });
  assert.deepEqual(pass([t]).posts, []);
});

test('a new ddev page or design link is posted once with its title; other links are only recorded', () => {
  const links = [
    { uri: 'https://acme.slack.com/archives/C0000000001', title: 'Slack channel' },
    { uri: 'https://gitlab.example/acme/-/merge_requests/7', title: 'MR' },
    { uri: 'https://gitlab.example/acme/-/pipelines/9', title: 'Pipeline' },
    { uri: 'https://acme-135.ddev.site/-/tree/feat', title: 'Branch' },
    { uri: 'https://acme-135.ddev.site/prices?a=1&b=2', title: 'Price list <new>' },
    { uri: 'https://acme-135.ddev.site/designbook/?path=/story/price', title: 'Price card design' },
  ];
  const result = pass([ticket({ links })]);
  assert.deepEqual(result.posts, [
    { identifier: 'ACME-1', channel: 'C0000000001', text: `${messages.previewLead} Price list &lt;new&gt;\nhttps://acme-135.ddev.site/prices?a=1&amp;b=2`, link: 'https://acme-135.ddev.site/prices?a=1&b=2' },
    { identifier: 'ACME-1', channel: 'C0000000001', text: `${messages.previewLead} Price card design\nhttps://acme-135.ddev.site/designbook/?path=/story/price`, link: 'https://acme-135.ddev.site/designbook/?path=/story/price' },
  ]);
  assert.deepEqual(result.next.records['ACME-1'].links, links.map((l) => l.uri));
  assert.deepEqual(pass([ticket({ links })], { previous: result.next.records }).posts, []);
});

test('a preview link whose title holds a run ID or an agent name is posted with the bare lead and its URI', () => {
  for (const title of ['Run 0b6a3f0e-5c1d-4a7e-9f21-3d4c5b6a7e8f preview', 'Opus build']) {
    const links = [{ uri: 'https://acme-135.ddev.site/prices', title }];
    assert.deepEqual(texts(pass([ticket({ links })])), [`${messages.previewLead}\nhttps://acme-135.ddev.site/prices`]);
  }
});

test('a running ticket in a conversation quiet for the interval gets one heartbeat with a sentence of the newest summary since the run started', () => {
  const runs = [run('r1', 'running', 'working', NOW / 1000 - 3600)];
  const comments = [
    summary('c0', '## Outcome\n\nAn older step.', '2026-11-05T10:00:00Z'),
    summary('c1', '## Outcome\n\nThe import reads the supplier file. More to come.', '2026-11-05T11:10:00Z'),
  ];
  const previous = { 'ACME-1': { ...seen, runs: { r1: 'running' }, summaries: ['c0', 'c1'] } };
  const result = pass([ticket({ runs, comments })], { previous, quiet: INTERVAL });
  assert.deepEqual(result.posts, [{ identifier: 'ACME-1', channel: 'C0000000001', text: `${messages.stillWorking} The import reads the supplier file.`, heartbeat: true }]);
  assert.deepEqual(pass([ticket({ runs, comments })], { previous, quiet: INTERVAL - 1 }).posts, []);
});

test('the heartbeat is the bare line without a summary since the run started, also in review', () => {
  const runs = [run('r1', 'running', 'review', NOW / 1000 - 600)];
  const comments = [summary('c0', '## Outcome\n\nAn older step.', '2026-11-05T10:00:00Z')];
  const previous = { 'ACME-1': { ...seen, runs: { r1: 'running' }, summaries: ['c0'] } };
  assert.deepEqual(texts(pass([ticket({ state: 'review', runs, comments })], { previous, quiet: INTERVAL })), [messages.stillWorking]);
});

test('no heartbeat without a running run, outside working and review, or when the conversation got another post this pass', () => {
  const previous = { 'ACME-1': { ...seen, runs: { r1: 'running' } } };
  assert.deepEqual(pass([ticket({ runs: [run('r1', 'claimed')] })], { previous, quiet: INTERVAL }).posts, []);
  assert.deepEqual(pass([ticket({ state: 'plan', runs: [run('r1', 'running', 'plan')] })], { previous, quiet: INTERVAL }).posts, []);
  const ended = pass([ticket({ runs: [run('r1', 'failed'), run('r2', 'running')] })], { previous: { 'ACME-1': { ...previous['ACME-1'], runs: { r1: 'failed' }, pending: { r1: 'running' }, lastStart: NOW } }, quiet: INTERVAL });
  assert.deepEqual(texts(ended), [messages.runPaused]);
});

test('sub-tickets sharing a conversation get one heartbeat between them, naming the one that works', () => {
  const running = (identifier) => ticket({ identifier, inherited: true, runs: [run(`${identifier}-r`, 'running')] });
  const previous = { 'ACME-2': { ...seen, runs: { 'ACME-2-r': 'running' } }, 'ACME-3': { ...seen, runs: { 'ACME-3-r': 'running' } } };
  assert.deepEqual(texts(pass([running('ACME-2'), running('ACME-3')], { previous, quiet: INTERVAL })), [`ACME-2 · ${messages.stillWorking}`]);
});

test('one pass orders a sub-ticket\'s lines paused run, summary, preview, run start, each naming it', () => {
  const t = ticket({
    identifier: 'ACME-2',
    inherited: true,
    runs: [run('r2', 'running'), run('r1', 'failed')],
    comments: [summary('c1', '## Outcome\n\nPrices import now.')],
    links: [{ uri: 'https://acme-135.ddev.site/prices', title: 'Price list' }],
  });
  const result = pass([t], { previous: { 'ACME-2': { ...seen, runs: { r1: 'failed' }, pending: { r1: 'running' } } } });
  assert.deepEqual(texts(result), [
    `ACME-2 · ${messages.runPaused}`,
    'ACME-2 · Prices import now.',
    `ACME-2 · ${messages.previewLead} Price list\nhttps://acme-135.ddev.site/prices`,
    `ACME-2 · ${messages.runStart.working}`,
  ]);
});

test('forgetting a failed post makes the next pass choose it again, and only it', () => {
  const t = ticket({ runs: [run('r1', 'running')], comments: [summary('c1', '## Outcome\n\nPrices import now.')], links: [{ uri: 'https://acme-135.ddev.site/p', title: 'P' }] });
  const first = pass([t]);
  assert.equal(first.posts.length, 3);
  for (const p of first.posts.filter((p) => !p.link)) forget(first.next.records, p);
  assert.deepEqual(texts(pass([t], { previous: first.next.records })), ['Prices import now.', messages.runStart.working]);
  const ended = pass([ticket({ runs: [run('r1', 'done')] })], { previous: { 'ACME-1': { ...seen, runs: { r1: 'running' } } } });
  forget(ended.next.records, ended.posts[0]);
  assert.equal(ended.next.records['ACME-1'].runs.r1, 'running');
});

test('PREVIEW_ZONES is a comma list of zones, trimmed and lower-cased; unset or empty gives none', () => {
  assert.deepEqual(previewZones(' Preview.keytec.de, ,box.example.org ,'), ['preview.keytec.de', 'box.example.org']);
  assert.deepEqual(previewZones(''), []);
  assert.deepEqual(previewZones(undefined), []);
});

const ZONES = ['preview.keytec.de'];
const SITE = 'https://yf-43-web.preview.keytec.de/de/breathwork';
const reviewed = (manual, outcome = 'The breathwork page is built.') => `### 🎯 Outcome\n\n${outcome}\n\n### 🧪 Manual review\n\n${manual}\n\n### ➡️ Next action\n\nApprove it.`;

test('a new summary posts its Outcome, then each Manual review link on a preview zone host, once', () => {
  const comments = [summary('c1', reviewed(`- [Worktree site](${SITE})`))];
  const result = pass([ticket({ comments })], { zones: ZONES });
  assert.deepEqual(result.posts, [
    { identifier: 'ACME-1', channel: 'C0000000001', text: 'The breathwork page is built.', summary: 'c1' },
    { identifier: 'ACME-1', channel: 'C0000000001', text: `${messages.previewLead} Worktree site\n${SITE}`, preview: ['c1', SITE] },
  ]);
  assert.deepEqual(pass([ticket({ comments })], { previous: result.next.records, zones: ZONES }).posts, []);
});

test('only https links in Manual review on exactly one label under a zone are posted; any other summary URL never is', () => {
  const never = [
    '[Other](https://example.org/x)',
    '[Script](javascript:alert(1))',
    '[Look-alike](https://yf-43.preview.keytec.de.evil.tld/)',
    '[Glued](https://evilpreview.keytec.de/)',
    '[Bare zone](https://preview.keytec.de/)',
    '[Two labels](https://a.b.preview.keytec.de/)',
    '[Credentials](https://me:pw@yf-43.preview.keytec.de/)',
    '[Port](https://yf-43.preview.keytec.de:8443/)',
    '[Plain http](http://yf-43.preview.keytec.de/)',
    'Run `https://yf-43.preview.keytec.de/code` or',
    '```\nhttps://yf-43.preview.keytec.de/fenced\n```',
  ].join('\n');
  const body = `### Outcome\n\nThe page is built. See [the site](https://yf-43.preview.keytec.de/outcome).\n\n### Manual review\n\n${never}`;
  const result = pass([ticket({ comments: [summary('c1', body)] })], { zones: ZONES });
  assert.deepEqual(texts(result), ['The page is built. See the site.']);
});

test('bare, angle-bracket and repeated preview links are posted once each, with escaped text or the bare lead', () => {
  const manual = [
    '- [Site <new> & **fresh**](https://a-1.preview.keytec.de/x?a=1&b=2)',
    '- [Opus build](https://a-2.preview.keytec.de/)',
    '- Open <https://a-3.preview.keytec.de/y> or https://A-4.Preview.keytec.de/z).',
    '- Again: https://a-3.preview.keytec.de/y',
  ].join('\n');
  const result = pass([ticket({ comments: [summary('c1', `### Manual review\n\n${manual}`)] })], { zones: ZONES });
  assert.deepEqual(texts(result), [
    `${messages.previewLead} Site &lt;new&gt; &amp; fresh\nhttps://a-1.preview.keytec.de/x?a=1&amp;b=2`,
    `${messages.previewLead}\nhttps://a-2.preview.keytec.de/`,
    `${messages.previewLead}\nhttps://a-3.preview.keytec.de/y`,
    `${messages.previewLead}\nhttps://A-4.Preview.keytec.de/z`,
  ]);
});

test('a refused preview post is retried alone on the next pass; summaries from a first sighting or an older record post no links', () => {
  const other = 'https://yf-43-docs.preview.keytec.de/';
  const comments = [summary('c1', reviewed(`- [Worktree site](${SITE})\n- [Docs](${other})`))];
  const first = pass([ticket({ comments })], { zones: ZONES });
  forget(first.next.records, first.posts[2]);
  assert.deepEqual(first.next.records['ACME-1'].previews, { c1: [SITE] });
  assert.deepEqual(texts(pass([ticket({ comments })], { previous: first.next.records, zones: ZONES })), [`${messages.previewLead} Docs\n${other}`]);

  const sighted = updates({ previous: {}, posted: {}, tickets: [ticket({ comments })], now: NOW, interval: INTERVAL, messages, zones: ZONES });
  assert.deepEqual(sighted.next.records['ACME-1'].previews, { c1: [SITE, other] });
  assert.deepEqual(pass([ticket({ comments })], { previous: sighted.next.records, zones: ZONES }).posts, []);

  const older = { 'ACME-1': { ...seen, summaries: ['c1'] } };
  assert.deepEqual(pass([ticket({ comments })], { previous: older, zones: ZONES }).posts, []);
});

test('with zones, a ddev ticket link is dropped for good when the same pass posts a preview link, and alone carries the box-only note', () => {
  const ddev = { uri: 'https://yf-43.ddev.site/de/breathwork', title: 'Breathwork' };
  const comments = [summary('c1', reviewed(`- [Worktree site](${SITE})`))];
  const both = pass([ticket({ comments, links: [ddev] })], { zones: ZONES });
  assert.deepEqual(texts(both), ['The breathwork page is built.', `${messages.previewLead} Worktree site\n${SITE}`]);
  assert.deepEqual(both.next.records['ACME-1'].links, [ddev.uri]);
  assert.deepEqual(pass([ticket({ comments, links: [ddev] })], { previous: both.next.records, zones: ZONES }).posts, []);

  const alone = pass([ticket({ links: [ddev] })], { zones: ZONES });
  assert.deepEqual(alone.posts, [{ identifier: 'ACME-1', channel: 'C0000000001', text: `${messages.previewLead} Breathwork\n${ddev.uri}\n${messages.previewBoxOnly}`, link: ddev.uri }]);
});

test('without zones, summaries post no links and a ddev link carries no note, as before', () => {
  const ddev = { uri: 'https://yf-43.ddev.site/de/breathwork', title: 'Breathwork' };
  const comments = [summary('c1', reviewed(`- [Worktree site](${SITE})`))];
  for (const zones of [undefined, []]) {
    const result = pass([ticket({ comments, links: [ddev] })], { zones });
    assert.deepEqual(texts(result), ['The breathwork page is built.', `${messages.previewLead} Breathwork\n${ddev.uri}`]);
    assert.equal('previews' in result.next.records['ACME-1'], false);
  }
});
