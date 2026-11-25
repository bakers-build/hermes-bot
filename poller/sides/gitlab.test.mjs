// The poller on its GitLab side (README.md › The GitLab side): a ticket's conversation is the GitLab
// issue it links, and every post is a note on that issue.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setup } from '../../test/poller-setup.mjs';
import { conversation } from './gitlab.mjs';

const messages = JSON.parse(readFileSync(new URL('../messages.json', import.meta.url), 'utf8')).de;
const WEEK = 7 * 24 * 3600 * 1000;

// The issue link as the bot stores it on the ticket; the stub serves project acme/shop.
const issue = (gitlab, iid = 7) => ({ uri: `${gitlab.url}/acme/shop/-/issues/${iid}`, title: 'GitLab issue' });
// The issue as the plugin records it when the bot answers it (conversations.json).
const opened = (iid = 7, created = '2026-11-05T11:00:00Z') => ({ [iid]: { requester: 42, requester_username: 'alice', created } });

test('the newest GitLab issue link to an issue of the project is the conversation; other projects, other titles and other links are not', () => {
  const url = 'https://gitlab.example';
  const project = 'acme/shop';
  const links = [
    { uri: 'https://gitlab.example/acme/shop/-/issues/3', title: 'GitLab issue' },
    { uri: 'https://gitlab.example/acme/shop/-/merge_requests/9', title: 'MR' },
    { uri: 'https://gitlab.example/acme/shop/-/issues/5#note_1', title: 'GitLab issue' },
    { uri: 'https://gitlab.example/acme/other/-/issues/8', title: 'GitLab issue' },
    { uri: 'https://gitlab.example/acme/shop/-/issues/9', title: 'Related bug' },
  ];
  assert.deepEqual(conversation(links, { url, project }), { channel: '5', url: 'https://gitlab.example/acme/shop/-/issues/5#note_1' });
  assert.equal(conversation([{ uri: 'https://acme.slack.com/archives/C0000000001', title: 'Slack channel' }], { url, project }), null);
  assert.equal(conversation(links.slice(3), { url, project }), null);
});

test('given a ticket on an issue, when it moves on, then one note each appears there, also after a restart', async (t) => {
  const { s, gitlab, poller, restart } = await setup(t, { side: 'gitlab' });
  const ticket = s.addTicket({ title: 'Comic Sans', state: 'plan', links: [issue(gitlab)] });
  await poller.pass();
  ticket.state = 'working';
  await poller.pass();
  await restart().pass();
  assert.deepEqual(gitlab.posts(), [{ iid: '7', body: messages.states.working }]);
});

test('a ticket the bot opened its issue for gets a note naming its identifier and link, once', async (t) => {
  const { s, gitlab, poller, botChannels, restart, state } = await setup(t, { side: 'gitlab' });
  botChannels(opened());
  s.addTicket({ title: 'Comic Sans', state: 'qualification', links: [issue(gitlab)], url: 'https://bakers.example/ticket/acme-1' });
  await poller.pass();
  await restart().pass();
  assert.deepEqual(gitlab.posts(), [{ iid: '7', body: `${messages.ticketNote} [ACME-1 · Comic Sans](https://bakers.example/ticket/acme-1)` }]);
  assert.deepEqual(state().channels['7'], { ticket: 'ACME-1', requester: 42, renamed: true });
});

test('done is noted with the ticket link, then the issue closed; a failed close retries only the close', async (t) => {
  const { s, gitlab, poller, botChannels, state } = await setup(t, { side: 'gitlab' });
  botChannels(opened());
  const ticket = s.addTicket({ title: 'Comic Sans', state: 'review', links: [issue(gitlab)], url: 'https://bakers.example/ticket/acme-1' });
  await poller.pass();
  ticket.state = 'done';
  gitlab.fail('PUT', '/issues/7');
  await poller.pass();
  gitlab.heal();
  await poller.pass();
  await poller.pass();
  const order = gitlab.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.body.state_event ?? 'note'}`);
  assert.deepEqual(order, ['POST note', 'POST note', 'PUT close', 'PUT close']);
  const done = gitlab.posts()[1].body;
  assert.match(done, /^Das ist fertig und bereit zum Ausprobieren\./);
  assert.match(done, /\[ACME-1 · Comic Sans\]\(https:\/\/bakers\.example\/ticket\/acme-1\)$/);
  assert.equal(gitlab.issues['7'].state, 'closed');
  assert.equal(state().channels['7'].archived, true);
});

test('a reopened ticket reopens its issue and notes its state there, once', async (t) => {
  const { s, gitlab, poller, botChannels, restart, state } = await setup(t, { side: 'gitlab' });
  botChannels(opened());
  const ticket = s.addTicket({ title: 'Comic Sans', state: 'review', links: [issue(gitlab)] });
  await poller.pass();
  ticket.state = 'done';
  await poller.pass();
  await poller.pass();
  assert.equal(gitlab.issues['7'].state, 'closed');
  ticket.state = 'working';
  await poller.pass();
  await restart().pass();
  assert.equal(gitlab.issues['7'].state, 'opened');
  assert.deepEqual(gitlab.posts().slice(2).map((p) => p.body), [messages.states.working]);
  assert.equal(state().channels['7'].archived, false);
  assert.deepEqual(s.stub.calls('bakers_ticket_transition'), [], 'the issue stays the ticket\'s one link');
  ticket.state = 'review';
  await poller.pass();
  assert.deepEqual(gitlab.posts().slice(3).map((p) => p.body), [messages.states.review]);
});

test('an issue without a ticket, silent for a week, gets a last note and is closed; a note in time keeps it', async (t) => {
  const { gitlab, poller, botChannels, clock, state } = await setup(t, { side: 'gitlab' });
  botChannels({ ...opened(7, '2026-10-01T12:00:00Z'), ...opened(8, '2026-10-01T12:00:00Z') });
  for (const iid of ['7', '8']) gitlab.issues[iid] = { state: 'opened', created_at: '2026-10-01T12:00:00Z' };
  gitlab.notes['8'] = [{ id: 1, body: 'Any news?', created_at: new Date(clock.now - WEEK / 2).toISOString() }];
  await poller.pass();
  await poller.pass();
  assert.deepEqual(gitlab.posts(), [{ iid: '7', body: messages.abandonedIssue }]);
  assert.equal(gitlab.issues['7'].state, 'closed');
  assert.equal(gitlab.issues['8'].state, 'opened');
  assert.equal(state().channels['7'].archived, true);
});

test('a question of a ticket on an issue is a note there, with Slack markup turned into Markdown', async (t) => {
  const { s, gitlab, poller } = await setup(t, { side: 'gitlab' });
  const ticket = s.addTicket({ title: 'Comic Sans', state: 'working', labels: ['technical problem'], frozen: true, frozen_at: '2026-11-05T11:00:00Z', links: [issue(gitlab)], url: 'https://bakers.example/ticket/acme-1' });
  s.addComment(ticket, { body: 'The test database <db> is down.', created: '2026-11-05T10:00:00Z' });
  await poller.pass();
  await poller.pass();
  const [note] = gitlab.posts();
  assert.equal(gitlab.posts().length, 1);
  assert.match(note.body, /The test database &lt;db&gt; is down\./);
  assert.match(note.body, /\[ACME-1 · Comic Sans\]\(https:\/\/bakers\.example\/ticket\/acme-1\)$/);
});
