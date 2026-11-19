// The scripted model through its own HTTP interface: the Messages API as the bot's Anthropic
// client calls it, and the driver a scenario loads its script through.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createModel } from './model.mjs';

let server;
let base;

before(async () => {
  server = createModel();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(async () => {
  await fetch(`${base}/_script`, { method: 'PUT', body: JSON.stringify({ rules: [] }) });
});

const TOOLS = [
  { name: 'mcp_bakers_tool_api__bakers_ticket_create', input_schema: { type: 'object' } },
  { name: 'mcp_bakers_tool_api__bakers_ticket_read', input_schema: { type: 'object' } },
];

const ask = (messages, extra = {}) =>
  fetch(`${base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-test', max_tokens: 100, tools: TOOLS, messages, ...extra }),
  });

const script = (rules) => fetch(`${base}/_script`, { method: 'PUT', body: JSON.stringify({ rules }) });

// The server-sent events of a streamed answer, as [event, data] pairs.
async function events(res) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.*)$/m)[1];
      return [event, JSON.parse(chunk.match(/^data: (.*)$/m)[1])];
    });
}

describe('scripted model', () => {
  it('given a rule on the user turn, when the turn matches, then it answers the rule text', async () => {
    await script([{ user: 'build a login', reply: [{ text: 'What should the login do?' }] }]);
    const res = await ask([{ role: 'user', content: '[Rafi] Please build a login page' }]);
    assert.equal(res.status, 200);
    const message = await res.json();
    assert.equal(message.role, 'assistant');
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.content, [{ type: 'text', text: 'What should the login do?' }]);
  });

  it('given a tool reply, when the turn matches, then it calls the tool the request offers under that suffix', async () => {
    await script([{ user: 'yes', reply: [{ tool: 'bakers_ticket_create', input: { title: 'Login' } }] }]);
    const message = await (await ask([{ role: 'user', content: [{ type: 'text', text: 'yes' }] }])).json();
    assert.equal(message.stop_reason, 'tool_use');
    const [call] = message.content;
    assert.equal(call.type, 'tool_use');
    assert.equal(call.name, 'mcp_bakers_tool_api__bakers_ticket_create');
    assert.deepEqual(call.input, { title: 'Login' });
    assert.match(call.id, /^toolu_/);
  });

  it('given a rule on a tool result, when it matches, then its named groups fill the next replies', async () => {
    await script([
      { tool_result: '"id":\\s*"(?<ticket>[0-9a-f-]+)"', after: 'bakers_ticket_create', reply: [{ tool: 'bakers_ticket_read', input: { ticket: '{{ticket}}' } }] },
      { tool_result: 'HERMESBOT', reply: [{ text: 'Ticket {{ticket}} is ready.' }] },
    ]);
    const call = { type: 'tool_use', id: 'toolu_1', name: 'mcp_bakers_tool_api__bakers_ticket_create', input: {} };
    const first = await (
      await ask([
        { role: 'user', content: 'yes' },
        { role: 'assistant', content: [call] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '{"id": "abc-123"}' }] }] },
      ])
    ).json();
    assert.deepEqual(first.content[0].input, { ticket: 'abc-123' });
    const second = await (await ask([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'HERMESBOT-1' }] }])).json();
    assert.equal(second.content[0].text, 'Ticket abc-123 is ready.');
  });

  it('given a used rule, when the same turn comes again, then it is not matched twice unless it repeats', async () => {
    await script([
      { user: 'hello', reply: [{ text: 'once' }] },
      { user: 'title', repeat: true, reply: [{ text: 'A title' }] },
    ]);
    assert.equal((await ask([{ role: 'user', content: 'hello' }])).status, 200);
    assert.equal((await ask([{ role: 'user', content: 'hello' }])).status, 400);
    assert.equal((await (await ask([{ role: 'user', content: 'title' }])).json()).content[0].text, 'A title');
    assert.equal((await (await ask([{ role: 'user', content: 'title' }])).json()).content[0].text, 'A title');
  });

  it('given no matching rule, when a turn comes, then it answers an error and the driver lists the turn', async () => {
    const res = await ask([{ role: 'user', content: 'something unplanned' }]);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).type, 'error');
    const log = await (await fetch(`${base}/_log`)).json();
    assert.deepEqual(
      log.map(({ kind, text, matched }) => ({ kind, text, matched })),
      [{ kind: 'user', text: 'something unplanned', matched: false }],
    );
  });

  it('given a system rule, when the system prompt matches, then it answers whatever the turn', async () => {
    await script([{ system: 'generate a short title', repeat: true, reply: [{ text: 'Login page' }] }]);
    const message = await (await ask([{ role: 'user', content: 'anything' }], { system: [{ type: 'text', text: 'Generate a short title for this conversation.' }] })).json();
    assert.equal(message.content[0].text, 'Login page');
  });

  it('given a streamed request, when it matches, then the answer comes as Messages API events', async () => {
    await script([{ user: 'go', reply: [{ text: 'Sure.' }, { tool: 'bakers_ticket_read', input: { ticket: 'X-1' } }] }]);
    const res = await ask([{ role: 'user', content: 'go' }], { stream: true });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const list = await events(res);
    assert.deepEqual(
      list.map(([event]) => event),
      ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
    );
    assert.equal(list[2][1].delta.text, 'Sure.');
    assert.equal(list[4][1].content_block.name, 'mcp_bakers_tool_api__bakers_ticket_read');
    assert.deepEqual(JSON.parse(list[5][1].delta.partial_json), { ticket: 'X-1' });
    assert.equal(list[7][1].delta.stop_reason, 'tool_use');
  });

  it('given a deferred tool, when the reply names it, then the model calls it through tool_call and matches its result by its own name', async () => {
    const deferred = [
      { name: 'tool_search', description: 'Deferred tool catalog:\nbakers tools (2):\n- mcp__bakers__tool_api__bakers_ticket_read: Reads a ticket\n- mcp__bakers__tool_api__bakers_ticket_create: Creates a ticket', input_schema: { type: 'object' } },
      { name: 'tool_call', input_schema: { type: 'object' } },
    ];
    await script([
      { user: 'status', reply: [{ tool: 'bakers_ticket_read', input: { ticket: 'E2E-1' } }] },
      { tool_result: 'working', after: 'bakers_ticket_read', reply: [{ text: 'It is in working.' }] },
    ]);
    const call = (await (await ask([{ role: 'user', content: 'status?' }], { tools: deferred })).json()).content[0];
    assert.equal(call.name, 'tool_call');
    assert.deepEqual(call.input, { calls: [{ name: 'mcp__bakers__tool_api__bakers_ticket_read', arguments: { ticket: 'E2E-1' } }] });
    const answer = await (
      await ask(
        [
          { role: 'user', content: 'status?' },
          { role: 'assistant', content: [call] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: '{"state": "working"}' }] },
        ],
        { tools: deferred },
      )
    ).json();
    assert.equal(answer.content[0].text, 'It is in working.');
  });

  it('given a tool result Hermes escaped and wrapped, when a rule matches it, then it matches the plain text', async () => {
    await script([{ tool_result: '"state":\\s*"(?<state>\\w+)"', reply: [{ text: 'In {{state}}.' }] }]);
    const wrapped = '<untrusted_tool_result source="x">\n{"result": "Ticket read.\\n{\\n    \\"state\\": \\"qualification\\"\\n}"}</untrusted_tool_result>';
    const answer = await (await ask([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: wrapped }] }])).json();
    assert.equal(answer.content[0].text, 'In qualification.');
  });

  it('given any request, when the client lists models or counts tokens, then it answers', async () => {
    assert.equal((await fetch(`${base}/anthropic/v1/models`)).status, 200);
    const count = await fetch(`${base}/anthropic/v1/messages/count_tokens`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
    assert.equal(typeof (await count.json()).input_tokens, 'number');
  });
});
