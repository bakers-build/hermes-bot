// Restarts (README › Test it by hand, limits): a restarted bot posts nothing twice, and after a
// restart of the bakers.build site a new request still becomes a ticket without restarting the bot.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOver } from '../lib/handover.mjs';
import { cancel, channel, moveTo, never, pause, restart, slack, ticketFor, waitFor } from '../lib/stack.mjs';

test('given posted states, when the bot restarts, then nothing is posted twice', async () => {
  const ch = channel('C0E2E0301');
  const ticket = await ticketFor(ch, 'Survive a bot restart');
  await moveTo(ticket.identifier, 'plan', 'working', 'review');
  await waitFor('the review post', async () => (await slack.posts(ch.id)).length >= 1);
  // A few passes, so the poller has recorded what it posted.
  await pause(6_000);
  const before = await slack.posts(ch.id);
  await restart('pm-bot');
  await never('a post after the restart', async () => {
    const after = await slack.posts(ch.id);
    return after.length > before.length ? after.slice(before.length) : null;
  }, { ms: 25_000 });
  await cancel(ticket.identifier);
});

test('given a restarted site, when a new request comes, then it becomes a ticket without restarting the bot', async () => {
  await restart('php');
  await restart('nginx');
  const { ticket } = await handOver({ id: 'C0E2E0302', title: 'Ticket after a site restart' });
  assert.equal(ticket.title, 'Ticket after a site restart');
  await cancel(ticket.identifier);
});
