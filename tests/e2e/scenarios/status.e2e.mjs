// Status in plain words (README › Test it by hand, step 7): asked how it is going, the bot reads
// the channel's ticket from bakers.build before it answers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancel, channel, chat, model, scripted, ticketFor } from '../lib/stack.mjs';

test('given a ticket in its channel, when someone asks how it is going, then the bot reads the ticket', async () => {
  const ch = channel('C0E2E0401');
  const ticket = await ticketFor(ch, 'Tell me how it goes');
  if (scripted) {
    await model.script([
      { user: 'how is it going', reply: [{ tool: 'bakers_ticket_read', input: { ticket: ticket.identifier } }] },
      { tool_result: '"state":\\s*"(?<state>\\w+)"', after: 'bakers_ticket_read', reply: [{ text: 'It is in {{state}}.' }] },
    ]);
  }
  const reply = await chat('how is it going?', { channel: ch, ticket: ticket.identifier });
  assert.notEqual(reply.text.trim(), '');
  if (scripted) {
    assert.deepEqual(await model.unmatched(), []);
    const read = (await model.log()).find((t) => t.kind === 'tool_result' && t.tool.endsWith('bakers_ticket_read'));
    assert.ok(read, 'the bot did not read the ticket');
    assert.match(read.text, new RegExp(ticket.identifier), 'the read did not return the channel\'s ticket');
    assert.equal(reply.text, 'It is in qualification.');
  }
  await cancel(ticket.identifier);
});
