// A stand-in for bakers.build's /mcp in the PM bot's image check (pm-bot-image.sh): MCP
// over streamable HTTP on port 8080, answering only `Authorization: Bearer <BAKERS_API_KEY>`
// and listing the sixteen bakers tools the server serves, of which the bot's config includes
// eight. No dependencies; the check passes this file to `node -e` in a container of the bot's
// own image.
//
// TOOLS is the recorded copy of the server's tool names: pm-bot.sh fails when the config, the
// poller, the plugin, the persona or the fake site names a tool missing here. When the server
// renames a tool, change it here first.
import { createServer } from 'node:http';

const KEY = process.env.STUB_KEY;
const TOOLS = [
  'bakers_comment_create',
  'bakers_comment_read',
  'bakers_conductor_list',
  'bakers_label_list',
  'bakers_metric_write',
  'bakers_project_read',
  'bakers_run_cancel',
  'bakers_run_list',
  'bakers_ticket_classify',
  'bakers_ticket_create',
  'bakers_ticket_list',
  'bakers_ticket_read',
  'bakers_ticket_search',
  'bakers_ticket_transition',
  'bakers_ticket_update',
  'bakers_user_read',
].map((name) => ({ name: `tool_api__${name}`, description: `${name} (stub)`, inputSchema: { type: 'object', properties: {} } }));

createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: 'unauthorized' });
  if (req.url !== '/mcp') return send(404, { message: 'not found' });
  if (req.method !== 'POST') return send(405, { message: 'method not allowed' });
  const message = JSON.parse(raw || '{}');
  if (message.id === undefined) return send(202);
  const reply = (result) => send(200, { jsonrpc: '2.0', id: message.id, result }, { 'mcp-session-id': 'stub-session' });
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bakers-stub', version: '1' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    default:
      return send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}).listen(8080, '0.0.0.0');
