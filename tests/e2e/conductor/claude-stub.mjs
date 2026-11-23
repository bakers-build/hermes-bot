#!/usr/bin/env node
// The end-to-end test's stand-in for Claude Code, on the conductor's PATH as `claude`. The conductor
// launches it for a run as it launches Claude Code; it ignores the prompt and plays the script the
// test left for the run's ticket, /e2e/agent/<identifier>.json (tests/e2e/agent/*.json), once:
//   {"steps": [{"tool": "bakers_ticket_update", "args": {...}}, {"sleep": 2000}, ...]}
// Each tool is called on the run's own tool server (BAKERS_CONDUCTOR_URL), as the conductor's owner;
// `{{ticket}}` in an argument is the run's ticket. Without a script it waits for one, and the run
// stays running until its ticket moves on, is frozen or is cancelled. No dependencies.

import { existsSync, readFileSync, renameSync } from 'node:fs';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const identifier = env('BAKERS_TICKET_IDENTIFIER');
const log = (message) => console.log(`claude-stub ${identifier}: ${message}`);

async function tool(name, args) {
  let session = '';
  const rpc = async (message) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${env('BAKERS_CONDUCTOR_TOKEN')}` };
    if (session) headers['mcp-session-id'] = session;
    const res = await fetch(env('BAKERS_CONDUCTOR_URL'), { method: 'POST', headers, body: JSON.stringify(message) });
    session = res.headers.get('mcp-session-id') ?? session;
    const text = await res.text();
    if (message.id === undefined) return null;
    if (!res.ok) throw new Error(`${name}: ${res.status} ${text.slice(0, 300)}`);
    const json = res.headers.get('content-type')?.includes('text/event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') : text;
    const answer = JSON.parse(json);
    if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
    return answer.result;
  };
  await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-stub', version: '1' } } });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const result = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  if (result.isError) throw new Error(`${name}: ${result.content?.map((c) => c.text).join(' ')}`);
}

const fillIn = (value) => JSON.parse(JSON.stringify(value).replaceAll('{{ticket}}', identifier));

const file = `/e2e/agent/${identifier}.json`;
// Without a script the run works on until a scenario leaves one, or until the conductor stops it
// with its ticket.
if (!existsSync(file)) log('waits for a script');
while (!existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 2000));
// Played once: the run a later unfreeze starts finds no script.
renameSync(file, `${file}.played`);
const { steps = [] } = JSON.parse(readFileSync(`${file}.played`, 'utf8'));
for (const step of steps) {
  if (step.sleep) {
    log(`sleeps ${step.sleep} ms`);
    await new Promise((resolve) => setTimeout(resolve, step.sleep));
    continue;
  }
  log(`calls ${step.tool}`);
  await tool(step.tool, fillIn(step.args ?? {}));
}
log('done');
