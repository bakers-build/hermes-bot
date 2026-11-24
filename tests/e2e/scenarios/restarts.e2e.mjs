// Restarts (README › Test it by hand, limits): a restarted bot posts nothing twice, after a restart of
// the bakers.build site a new request still becomes a ticket without restarting the bot, and what
// changed while the site was down is posted once it is back, each event exactly once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOver } from '../lib/handover.mjs';
import { cancel, channel, compose, drush, moveTo, never, pollerState, restart, says, slack, start, stop, ticketFor, waitFor } from '../lib/stack.mjs';

test('given posted states, when the bot restarts, then nothing is posted twice', async () => {
  const ch = channel('C0E2E0301');
  const ticket = await ticketFor(ch, 'Survive a bot restart');
  await moveTo(ticket.identifier, 'plan', 'working', 'review');
  await waitFor('the review post', () => pollerState(ticket.identifier) === 'review');
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

test('given open tickets, when the site is down while one changes, then the passes fail and afterwards each change is posted exactly once', async () => {
  const ch = channel('C0E2E0303');
  const ticket = await ticketFor(ch, 'Change me during an outage');
  await moveTo(ticket.identifier, 'plan', 'working');
  await waitFor('the working post', () => pollerState(ticket.identifier) === 'working');
  const before = (await slack.posts(ch.id)).length;
  const since = new Date().toISOString();
  await stop('nginx');
  try {
    await waitFor('a failed pass', async () => /pass failed/.test((await compose(['logs', '--no-color', '--since', since, 'pm-bot'])).stdout));
    // Through the database, as the tools are behind nginx: the move to review and a ddev site link.
    const saved = await drush(ticket.identifier, `
      $ticket->set('state', 'review');
      $ticket->get('links')->appendItem(['uri' => 'https://e2e-outage.ddev.site', 'title' => 'Preview site']);
      $ticket->save();
      echo $ticket->get('state')->value;
    `);
    assert.equal(saved, 'review');
    await never('a post while the site is down', async () => (await slack.posts(ch.id)).length > before && (await slack.posts(ch.id)).slice(before), { ms: 6_000 });
  } finally {
    await start('nginx');
  }
  const after = async () => (await slack.posts(ch.id)).slice(before);
  await waitFor('the review post and the link', async () => {
    const posts = await after();
    return posts.some((text) => says(text, 'states.review')) && posts.some((text) => text.includes('https://e2e-outage.ddev.site'));
  });
  await never('a change posted twice', async () => {
    const posts = await after();
    const twice = posts.filter((text) => says(text, 'states.review')).length > 1 || posts.filter((text) => text.includes('https://e2e-outage.ddev.site')).length > 1;
    return twice && posts;
  }, { ms: 10_000 });
  await cancel(ticket.identifier);
});
