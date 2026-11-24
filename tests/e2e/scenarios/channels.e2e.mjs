// The poller keeps the bot's request channels (README › Test it by hand, steps 7 and 8, and the
// ticket-link smoke test): it renames a channel after its ticket, posts each state change once, posts
// the done post with the newest Manual review, the ticket link and the origin, archives the channel
// after done or cancelled and opens a fresh one when the ticket is reopened. A sub-ticket without a
// conversation posts in its ancestor's channel. A Slack call refused once is retried.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancel, channel, followed, moveTo, never, origin, pollerState, reopen, says, seed, site, slack, ticketFor, waitFor } from '../lib/stack.mjs';

const archive = async (id) => (await slack.calls()).find((c) => c.method === 'conversations.archive' && c.body.channel === id);

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

test('given a ticket with an origin and two summaries, when it is done, then the done post holds the newest Manual review, the ticket link and the origin', async () => {
  const ch = channel('C0E2E0204');
  const ticket = await ticketFor(ch, 'Show me the finished page');
  const from = 'https://github.com/e2e/members/issues/7';
  await origin(ticket.identifier, from);
  await moveTo(ticket.identifier, 'plan', 'working', 'review');
  await waitFor('the review post', () => pollerState(ticket.identifier) === 'review');
  const summary = (review) => `### 🎯 Outcome\n\nThe page is finished.\n\n### 🧪 Manual review\n\n${review}`;
  await site.tool('bakers_comment_create', { ticket: ticket.identifier, type: 'summary', body: summary('Open the old member page.') });
  // The site stores a comment's time in seconds: the newer summary has a later one.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await site.tool('bakers_comment_create', { ticket: ticket.identifier, type: 'summary', body: summary('Open the member page and tick *Remember me*.') });
  await moveTo(ticket.identifier, 'done');
  const done = await waitFor('the done post', async () => (await slack.posts(ch.id)).find((text) => says(text, 'states.done')));
  const { url } = await site.ticket(ticket.identifier);
  assert.ok(says(done, 'testHint'), `no test hint: ${done}`);
  assert.ok(done.includes('Open the member page and tick *Remember me*.'), `not the newest Manual review: ${done}`);
  assert.ok(!done.includes('Open the old member page.'), `the older Manual review: ${done}`);
  assert.ok(done.includes(`<${url}|${ticket.identifier} · Show me the finished page>`), `no ticket link: ${done}`);
  assert.ok(says(done, 'originLead') && done.includes(`<${from}|${from}>`), `no origin line: ${done}`);
});

test('given a ticket channel, when the ticket is cancelled, then the final post comes before the archive', async () => {
  const ch = channel('C0E2E0205');
  const ticket = await ticketFor(ch, 'Cancel me before the work');
  await moveTo(ticket.identifier, 'plan');
  await waitFor('the plan post', () => pollerState(ticket.identifier) === 'plan');
  await cancel(ticket.identifier);
  await waitFor('the archive', () => archive(ch.id));
  const calls = (await slack.calls()).filter((c) => c.body.channel === ch.id);
  const final = calls.map((c, i) => [c, i]).filter(([c]) => c.method === 'chat.postMessage' && says(c.body.text, 'states.cancelled'));
  assert.equal(final.length, 1, `${final.length} cancelled posts`);
  assert.ok(final[0][1] < calls.findIndex((c) => c.method === 'conversations.archive'), 'the channel was archived before its final post');
});

test('given a sub-ticket without a conversation, when it moves, then it posts behind its identifier in its parent\'s channel and gets no channel', async () => {
  const ch = channel('C0E2E0206');
  const parent = await ticketFor(ch, 'Parent of a sub-ticket');
  const child = await site.tool('bakers_ticket_create', { title: 'Sub-ticket of the parent', workflow: seed.workflow, project: seed.project_uuid, parent: parent.identifier, description: 'A part of the parent.' });
  await followed(child.identifier);
  await moveTo(child.identifier, 'plan');
  const prefix = `${child.identifier} · `;
  await waitFor('the sub-ticket\'s plan post', async () => (await slack.posts(ch.id)).some((text) => text.startsWith(prefix) && says(text, 'states.plan')));
  await cancel(child.identifier);
  await waitFor('the sub-ticket\'s cancelled post', async () => (await slack.posts(ch.id)).some((text) => text.startsWith(prefix) && says(text, 'states.cancelled')));
  const own = child.identifier.toLowerCase();
  await never('a channel step for the sub-ticket', async () => {
    const calls = (await slack.calls()).filter((c) =>
      (c.method === 'conversations.create' && c.body.name?.startsWith(own)) ||
      (c.method === 'conversations.rename' && (c.body.channel === ch.id ? !c.body.name.startsWith(parent.identifier.toLowerCase()) : c.body.name?.startsWith(own))) ||
      (c.method === 'conversations.archive' && c.body.channel === ch.id));
    return calls.length && calls;
  }, { ms: 6_000 });
  await cancel(parent.identifier);
});

test('given a done post Slack refuses once, when the poller retries it, then the channel is archived only after the retried post', async () => {
  const ch = channel('C0E2E0207');
  const ticket = await ticketFor(ch, 'Retry my done post');
  await moveTo(ticket.identifier, 'plan', 'working', 'review');
  await waitFor('the review post', () => pollerState(ticket.identifier) === 'review');
  await slack.refuse('chat.postMessage', { channel: ch.id });
  await moveTo(ticket.identifier, 'done');
  await waitFor('the archive', () => archive(ch.id));
  const calls = (await slack.calls()).filter((c) => c.body.channel === ch.id);
  const tries = calls.map((c, i) => [c, i]).filter(([c]) => c.method === 'chat.postMessage' && says(c.body.text, 'states.done'));
  assert.equal(tries.length, 2, `${tries.length} done posts`);
  assert.equal(tries[0][0].refused, 'internal_error', 'the first done post was not the refused one');
  assert.equal(tries[1][0].refused, undefined);
  const archivedAt = calls.findIndex((c) => c.method === 'conversations.archive');
  assert.ok(archivedAt > tries[1][1], 'the channel was archived before the retried done post');
});

test('given a rename Slack refuses once, when the poller retries it, then the channel is renamed after the ticket', async () => {
  const ch = channel('C0E2E0208');
  await slack.refuse('conversations.rename', { channel: ch.id });
  const ticket = await ticketFor(ch, 'Retry my rename');
  const slug = `${ticket.identifier.toLowerCase()}-retry-my-rename`;
  await waitFor('the retried rename', async () => (await slack.of('conversations.rename')).find((c) => c.body.channel === ch.id && c.body.name === slug && !c.refused));
  const renames = (await slack.of('conversations.rename')).filter((c) => c.body.channel === ch.id);
  assert.equal(renames[0].refused, 'internal_error', 'the first rename was not refused');
  await cancel(ticket.identifier);
});
