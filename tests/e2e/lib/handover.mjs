// The hand-over of a request through the bot, shared by the scenarios that need one.

import assert from 'node:assert/strict';
import { channel, chat, model, scripted, seed, site } from './stack.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// What bb-create-ticket and the persona make the model do, as tool calls: the scripted model's
// part. The real model finds its own way to the same ticket.
export function handoverScript({ ch, title }) {
  const comment = (type, body, after) => ({ tool_result: '.', after, reply: [{ tool: 'bakers_comment_create', input: { ticket: '{{ticket}}', type, body } }] });
  return [
    { user: 'login page', reply: [{ text: 'Who signs in, and with what? Shall I hand it over as described?' }] },
    { user: '\\byes\\b', reply: [{ tool: 'bakers_user_read', input: { user: seed.requester_email } }] },
    {
      tool_result: `"uuid":\\s*"(?<requester>${UUID})"`,
      after: 'bakers_user_read',
      reply: [{ tool: 'bakers_ticket_create', input: { title, description: 'Members sign in with their e-mail address.', workflow: seed.workflow, project: seed.project_uuid, type: 'feature', recipe: 'matt', reviewers: ['{{requester}}'] } }],
    },
    { tool_result: `"identifier":\\s*"(?<ticket>E2E-\\d+)"`, after: 'bakers_ticket_create', reply: [{ tool: 'bakers_ticket_transition', input: { ticket: '{{ticket}}', links: [{ uri: ch.link, title: 'Slack channel' }] } }] },
    comment('qualification', '# Qualification\n\nMembers sign in with their e-mail address.', 'bakers_ticket_transition'),
    comment('spec', '# Spec\n\nA login page.', 'bakers_comment_create'),
    comment('plan', '# Plan\n\n1. The form.', 'bakers_comment_create'),
    comment('test', '# Test plan\n\nSign in once.', 'bakers_comment_create'),
    { tool_result: '.', after: 'bakers_comment_create', reply: [{ tool: 'bakers_ticket_transition', input: { ticket: '{{ticket}}', state: 'plan' } }] },
    { tool_result: '.', after: 'bakers_ticket_transition', reply: [{ tool: 'bakers_ticket_transition', input: { ticket: '{{ticket}}', state: 'working' } }] },
    { tool_result: '"working"', after: 'bakers_ticket_transition', reply: [{ tool: 'bakers_ticket_update', input: { ticket: '{{ticket}}', conductor: seed.conductor_uuid } }] },
    { tool_result: '.', after: 'bakers_ticket_update', reply: [{ tool: 'bakers_ticket_update', input: { ticket: '{{ticket}}', labels_add: ['human-accept', 'ticket-question'] } }] },
    { tool_result: 'human-accept', after: 'bakers_ticket_update', reply: [{ text: 'Handed over as {{ticket}}; work has started.' }] },
  ];
}

/** The requester asks for a login page and says yes; returns the ticket the bot created. */
export async function handOver({ id, title }) {
  const ch = channel(id);
  if (scripted) await model.script(handoverScript({ ch, title }));
  const first = await chat(`We need a login page for members: ${title}.`, { channel: ch });
  await chat('yes, hand it over as it is', { session: first.session });
  if (scripted) assert.deepEqual(await model.unmatched(), [], 'the bot made a call the script did not plan');
  const [found] = (await site.tool('bakers_ticket_search', { query: title, project: seed.project_uuid })).tickets ?? [];
  assert.ok(found, `no ticket titled ${title}`);
  return { ch, ticket: await site.ticket(found.identifier) };
}
