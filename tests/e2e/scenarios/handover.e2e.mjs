// Specify and hand over (README › Test it by hand, step 2): after the requester's yes, the bot's
// ticket carries the spec, plan and test, its type and recipe, the conductor with its owner as
// assignee, the requester as reviewer, the hand-over labels and the Slack channel, in working.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handOver } from '../lib/handover.mjs';
import { cancel, seed, site, waitFor } from '../lib/stack.mjs';

test('given a request in its channel, when the requester says yes, then the ticket is handed over in working', async () => {
  const { ch, ticket } = await handOver({ id: 'C0E2E0101', title: 'Member login page' });
  const types = new Set(ticket.comments.map((c) => c.type));
  for (const type of ['spec', 'plan', 'test']) assert.ok(types.has(type), `no ${type} comment`);
  assert.equal(ticket.type, 'feature');
  assert.equal(ticket.recipe, 'matt');
  assert.equal(ticket.conductor, seed.conductor_uuid);
  // The server makes the conductor's owner the assignee.
  assert.equal(ticket.assignee?.uuid, seed.owner_user_uuid);
  assert.deepEqual(ticket.reviewers.map((r) => r.uuid ?? r), [seed.requester_user_uuid]);
  assert.deepEqual([...ticket.labels].sort(), ['human-accept', 'ticket-question']);
  assert.ok(ticket.links.some((l) => l.uri === ch.link && l.title === 'Slack channel'), 'no Slack channel link');
  // The conductor may already have taken the work on; it never goes back before working.
  await waitFor('the ticket in working', async () => ['working', 'review'].includes((await site.ticket(ticket.identifier)).state));
  await cancel(ticket.identifier);
});
