// Questions and technical problems (README › Test it by hand, steps 5 and 6): a run asks through
// the ticket, anyone in the channel answers through the bot, and a technical problem waits for the
// developers. A run that only asked a question is never reported as a problem (HERMESBOT-6).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cancel, channel, chat, model, never, pollerRecord, runEnded, scripted, site, slack, waitFor, workingTicket } from '../lib/stack.mjs';

const messages = JSON.parse(readFileSync(new URL('../../../poller/messages.json', import.meta.url), 'utf8'));
const ENDED = ['done', 'cancelled', 'failed', 'expired'];

// These scenarios play the stub agent's scripts (tests/e2e/agent); --real gives the conductor Claude
// Code, which works the ticket its own way.
const stub = { skip: !scripted && "plays the stub agent's scripts; --real runs Claude Code in the conductor" };

const waitingOn = (identifier, label) =>
  waitFor(`${identifier} frozen with ${label}`, async () => {
    const t = await site.ticket(identifier);
    return t.frozen && t.labels.includes(label) && t;
  });

test('given a run that asked a question, when someone in the channel answers, then the answer is on the ticket and the work goes on', stub, async () => {
  const ch = channel('C0E2E0501');
  const ticket = await workingTicket(ch, 'Ask before building', 'question');
  const asked = await waitingOn(ticket.identifier, 'Question');
  const before = asked.comments.length;
  if (scripted) {
    await model.script([
      { user: 'e-mail address', reply: [{ tool: 'bakers_ticket_read', input: { ticket: ticket.identifier } }] },
      {
        tool_result: '"frozen":\\s*true',
        after: 'bakers_ticket_read',
        reply: [{ tool: 'bakers_comment_create', input: { ticket: ticket.identifier, type: 'comment', body: 'Answered in Slack by Second Member (Slack user U0E2E0002):\n\nOnly with the e-mail address.' } }],
      },
      { tool_result: '.', after: 'bakers_comment_create', reply: [{ tool: 'bakers_ticket_update', input: { ticket: ticket.identifier, labels_remove: ['Question'], frozen: false } }] },
      { tool_result: '.', after: 'bakers_ticket_update', reply: [{ text: 'Thanks, the work goes on.' }] },
    ]);
  }
  await chat('Only with the e-mail address, no username.', { channel: ch, ticket: ticket.identifier, sender: 'Second Member', user: 'U0E2E0002' });
  if (scripted) assert.deepEqual(await model.unmatched(), []);
  const answered = await site.ticket(ticket.identifier);
  assert.ok(answered.comments.length > before, 'the answer was not written to the ticket');
  assert.ok(!answered.labels.includes('Question'), 'the ticket still carries Question');
  assert.equal(answered.frozen, false, 'the ticket is still frozen');
  await cancel(ticket.identifier);
});

test('given a run that hit a technical problem, when someone replies in the channel, then nothing is written to the ticket', stub, async () => {
  const ch = channel('C0E2E0502');
  const ticket = await workingTicket(ch, 'Stuck on the test database', 'technical-problem');
  const stuck = await waitingOn(ticket.identifier, 'technical problem');
  if (scripted) {
    await model.script([
      { user: 'any news', reply: [{ tool: 'bakers_ticket_read', input: { ticket: ticket.identifier } }] },
      { tool_result: 'technical problem', after: 'bakers_ticket_read', reply: [{ text: 'The developers are on it; you need not do anything.' }] },
    ]);
  }
  await chat('Any news? Can I help?', { channel: ch, ticket: ticket.identifier });
  if (scripted) assert.deepEqual(await model.unmatched(), []);
  await never('a write to the stuck ticket', async () => {
    const t = await site.ticket(ticket.identifier);
    const changed = t.comments.length !== stuck.comments.length || !t.frozen || !t.labels.includes('technical problem');
    return changed && { comments: t.comments.length, frozen: t.frozen, labels: t.labels };
  }, { ms: 10_000 });
  await site.tool('bakers_ticket_update', { ticket: ticket.identifier, frozen: false, labels_remove: ['technical problem'] }, { as: 'owner' });
  await cancel(ticket.identifier);
});

test('given a run that ended with a freeze before its Question label, when the label follows, then no problem is posted', stub, async () => {
  const ch = channel('C0E2E0503');
  const ticket = await workingTicket(ch, 'Remember the member', 'question-freeze-first');
  const runs = await runEnded(ticket.identifier);
  const ended = runs.find((r) => ENDED.includes(r.state));
  // The poller saw the run end while the ticket had no label yet: the moment HERMESBOT-6 was about.
  await waitFor('the poller seeing the run end', () => ENDED.includes(pollerRecord(ticket.identifier)?.runs?.[ended.uuid]));
  await site.tool('bakers_ticket_update', { ticket: ticket.identifier, labels_add: ['Question'] }, { as: 'owner' });
  const paused = Object.values(messages).map((m) => m.runPaused);
  await never('a problem posted for a question', async () => (await slack.posts(ch.id)).find((text) => paused.some((p) => text.includes(p))), { ms: 15_000 });
  await site.tool('bakers_ticket_update', { ticket: ticket.identifier, frozen: false, labels_remove: ['Question'] }, { as: 'owner' });
  await cancel(ticket.identifier);
});
