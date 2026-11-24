// A conductor's runs in the ticket's channel (README › Status updates): the start line, a summary's
// plain Outcome sentences, a run that fails or is cancelled, the heartbeat while a run works quietly,
// and nothing for what happened before the poller followed the ticket. bakers.build 0.11.0 ends a run
// done only when its ticket moves on, and expires only a claim whose agent never started: the waiting
// line and an expired run stay with the poller's unit tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agent, cancel, channel, followed, moveTo, never, pollerRecord, runEnded, scripted, seed, site, slack, says, waitFor, workingTicket,
} from '../lib/stack.mjs';

// These scenarios play the stub agent's scripts (tests/e2e/agent); --real gives the conductor Claude
// Code, which works the ticket its own way.
const stub = { skip: !scripted && "plays the stub agent's scripts; --real runs Claude Code in the conductor" };

const saying = async (ch, path) => (await slack.posts(ch.id)).filter((text) => says(text, path));
const once = async (ch, path, what) => {
  await waitFor(what, async () => (await saying(ch, path)).length > 0);
  await never(`a second ${what}`, async () => {
    const found = await saying(ch, path);
    return found.length > 1 && found;
  }, { ms: 6_000 });
};
const running = (identifier) => waitFor(`a running run of ${identifier}`, async () => (await site.runs(identifier)).find((r) => r.state === 'running'));

test('given a ticket handed to the conductor, when its run writes a summary, then the start line and the plain Outcome sentence are posted once each', stub, async () => {
  const ch = channel('C0E2E0601');
  const ticket = await workingTicket(ch, 'Remember the member for a month', 'done');
  await once(ch, 'runStart.working', 'start line');
  const plain = 'The login page now remembers a member for a month.';
  const outcome = async () => (await slack.posts(ch.id)).filter((text) => text.includes(plain));
  await waitFor('the Outcome sentence', async () => (await outcome()).length > 0);
  await never('a second Outcome post or the sentence with identifiers', async () => {
    const posts = await slack.posts(ch.id);
    const leaked = posts.filter((text) => text.includes('members.module') || text.includes('It is built on'));
    return ((await outcome()).length > 1 || leaked.length) && posts;
  }, { ms: 6_000 });
  await cancel(ticket.identifier);
});

test('given a run that fails on an open ticket, then the channel hears once that the work is paused', stub, async () => {
  const ch = channel('C0E2E0603');
  const ticket = await workingTicket(ch, 'Fail my run', 'fails');
  // The conductor starts the next run at once; it finds no script and works on.
  const runs = await runEnded(ticket.identifier);
  assert.ok(runs.some((r) => r.state === 'failed'), `no failed run: ${JSON.stringify(runs.map((r) => r.state))}`);
  await once(ch, 'runPaused', 'paused line');
  const t = await site.ticket(ticket.identifier);
  assert.equal(t.state, 'working');
  assert.deepEqual(t.labels, []);
  await cancel(ticket.identifier);
});

test('given a running run on an open ticket, when the run is cancelled, then the channel hears once that the work is paused', stub, async () => {
  const ch = channel('C0E2E0604');
  const ticket = await workingTicket(ch, 'Cancel my run');
  await running(ticket.identifier);
  await site.tool('bakers_run_cancel', { ticket: ticket.identifier, reason: 'The end-to-end test cancels the run.' }, { as: 'owner' });
  await once(ch, 'runPaused', 'paused line');
  const t = await site.ticket(ticket.identifier);
  assert.equal(t.state, 'working');
  assert.deepEqual(t.labels, []);
  await cancel(ticket.identifier);
});

test('given a run that works quietly, when the heartbeat interval passes, then the channel hears that the work goes on', stub, async () => {
  const ch = channel('C0E2E0605');
  const ticket = await workingTicket(ch, 'Keep me posted');
  await running(ticket.identifier);
  await waitFor('the start line', async () => (await saying(ch, 'runStart.working')).length > 0);
  // PM_BOT_HEARTBEAT_INTERVAL=10 and PM_BOT_POLL_INTERVAL=2 (pm-bot.env): the heartbeat follows the
  // channel's last post within the interval and five passes.
  const posts = async () => (await slack.calls()).filter((c) => c.method === 'chat.postMessage' && c.body.channel === ch.id);
  const beat = await waitFor('the still-working line', async () => (await posts()).find((c) => says(c.body.text, 'stillWorking')), { timeout: 60_000, interval: 1_000 });
  const before = (await posts()).filter((c) => c.at < beat.at).at(-1);
  const quiet = beat.at - before.at;
  assert.ok(quiet >= 10_000 && quiet <= 20_000, `the heartbeat came ${quiet} ms after the channel's last post`);
  await cancel(ticket.identifier);
});

test('given runs, a summary and a link from before the poller followed a ticket, when it follows it, then none of them is posted', stub, async () => {
  const ch = channel('C0E2E0606');
  const created = await site.tool('bakers_ticket_create', { title: 'Keep my history quiet', workflow: seed.workflow, project: seed.project_uuid, description: 'Keep my history quiet.' });
  const id = created.identifier;
  agent.script(id, 'done');
  await moveTo(id, 'plan', 'working');
  await site.tool('bakers_ticket_update', { ticket: id, conductor: seed.conductor_uuid });
  // The run writes a summary and moves the ticket to review, which ends it done.
  const runs = await runEnded(id);
  await site.tool('bakers_ticket_transition', { ticket: id, links: [{ uri: 'https://history.ddev.site', title: 'Preview site' }] });
  await site.tool('bakers_ticket_transition', { ticket: id, links: [{ uri: ch.link, title: 'Slack channel' }] });
  await followed(id);
  const record = await waitFor('the poller recording the history', () => pollerRecord(id));
  for (const r of runs) assert.ok(r.uuid in record.runs, `run ${r.uuid} was not recorded`);
  assert.equal(record.summaries.length, 1, 'the summary was not recorded');
  assert.ok(record.links.includes('https://history.ddev.site'), 'the link was not recorded');
  // A heartbeat may follow while the ticket waits in review; nothing of its history may.
  await never('a post of the history', async () =>
    (await slack.posts(ch.id)).find((text) =>
      /remembers a member|history\.ddev\.site|member-login\.preview/.test(text) || ['runStart.working', 'runWaiting', 'runPaused', 'previewLead'].some((path) => says(text, path))),
  { ms: 10_000 });
  await cancel(id);
});
