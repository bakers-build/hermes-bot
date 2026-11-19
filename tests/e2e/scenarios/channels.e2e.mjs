// The poller keeps the bot's request channels (README › Test it by hand, steps 7 and 8): it renames a
// channel after its ticket, posts each state change once, archives the channel after done and opens
// a fresh one when the ticket is reopened.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancel, channel, moveTo, never, pollerState, reopen, site, slack, ticketFor, waitFor } from '../lib/stack.mjs';

test('given a request channel, when its ticket exists, then the channel is renamed after the ticket', async () => {
  const ch = channel('C0E2E0201');
  const ticket = await ticketFor(ch, 'Rename me after the ticket');
  const slug = `${ticket.identifier.toLowerCase()}-rename-me-after-the-ticket`;
  await waitFor('the rename', async () => (await slack.of('conversations.rename')).find((c) => c.body.channel === ch.id && c.body.name === slug));
  await cancel(ticket.identifier);
});

test('given a ticket in its channel, when it moves to review, then one post appears there', async () => {
  const ch = channel('C0E2E0202');
  const ticket = await ticketFor(ch, 'Post my review state');
  await moveTo(ticket.identifier, 'plan', 'working');
  // The poller has posted working, the state before the move under test.
  await waitFor('the working post', () => pollerState(ticket.identifier) === 'working');
  const before = (await slack.posts(ch.id)).length;
  await moveTo(ticket.identifier, 'review');
  await waitFor('the review post', async () => (await slack.posts(ch.id)).length > before);
  await never('a second review post', async () => ((await slack.posts(ch.id)).length > before + 1 ? await slack.posts(ch.id) : null));
  await cancel(ticket.identifier);
});

test('given a ticket channel, when the ticket is done and reopened, then the channel is archived and a -2 channel links it', async () => {
  const ch = channel('C0E2E0203', { requester: 'U0E2EREQ' });
  const ticket = await ticketFor(ch, 'Close and reopen me');
  await moveTo(ticket.identifier, 'plan', 'working', 'review');
  await waitFor('the review post', () => pollerState(ticket.identifier) === 'review');
  await moveTo(ticket.identifier, 'done');
  await waitFor('the archive', async () => (await slack.of('conversations.archive')).find((c) => c.body.channel === ch.id));
  const archivedAt = (await slack.calls()).findIndex((c) => c.method === 'conversations.archive' && c.body.channel === ch.id);
  const lastPost = (await slack.calls()).findLastIndex((c) => c.method === 'chat.postMessage' && c.body.channel === ch.id);
  assert.ok(lastPost < archivedAt, 'the channel was archived before its final post');

  await reopen(ticket.identifier);
  const name = `${ticket.identifier.toLowerCase()}-close-and-reopen-me-2`;
  await waitFor('the -2 channel', async () => (await slack.of('conversations.create')).find((c) => c.body.name === name));
  const fresh = await waitFor('the -2 channel link', async () => {
    const links = (await site.ticket(ticket.identifier)).links.filter((l) => l.title === 'Slack channel');
    return links.length === 2 && links.find((l) => l.uri !== ch.link);
  });
  const id = fresh.uri.split('/').at(-1);
  assert.ok((await slack.of('conversations.invite')).some((c) => c.body.channel === id && c.body.users === 'U0E2EREQ'), 'the requester was not invited');
  await waitFor('the post in the -2 channel', async () => (await slack.posts(id)).find((text) => text.includes(`<#${ch.id}>`)));
  await cancel(ticket.identifier);
});
