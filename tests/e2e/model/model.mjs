#!/usr/bin/env node
// The end-to-end test's model: Anthropic's Messages API, answered from a script instead of a
// model, so a run needs no key and its turns are predictable. The bot reaches it through
// model.base_url (http://model/anthropic); the test loads each scenario's script through the
// driver. No dependencies.
//
// A script is a list of rules, tried in order against each request's last turn:
//   {user: <regex>}                 a user turn whose text matches
//   {tool_result: <regex>, after?}  a tool result whose text matches, of a tool whose name ends with `after`
//   {system: <regex>}               any turn of a request whose system prompt matches (Hermes' side calls)
// and a `reply`: a list of {text} and {tool, input} blocks. A tool is named by the suffix of a tool
// the request offers (bakers_ticket_create, open_request_channel), directly or deferred behind Hermes' tool_call. Named groups of the matching regex are kept and fill
// `{{name}}` in later replies. A rule answers once unless it has `repeat: true`. A turn no rule
// matches is answered with an error and logged unmatched, which fails the scenario.
//
//   PUT /_script {rules}   replace the script, forget the kept values and the log
//   GET /_log              every turn: {kind, text, tool, system, tools, matched, rule}
//   GET /_last             the last request's body as sent, for diagnosis
//
//   node tests/e2e/model/model.mjs   # listens on PORT (80)

import { createServer } from 'node:http';

const textOf = (content) => {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? textOf(block.content) : ''))
    .filter(Boolean)
    .join('\n');
};

// Hermes hands an MCP result on as a JSON string inside JSON: rules match its plain text.
const unescape = (text) => text.replace(/\\+n/g, '\n').replace(/\\+(["\\/])/g, '$1');

// The turn a request asks the model to answer: the last message, a user text or tool results.
function turnOf(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1) ?? { content: '' };
  const system = textOf(body.system);
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  if (!results.length) return { kind: 'user', text: textOf(last.content), system };
  const ids = new Set(results.map((r) => r.tool_use_id));
  const calls = messages.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use' && ids.has(b.id));
  // A deferred tool's result is tool_call's: it is matched by the tools it called.
  const names = calls.flatMap((c) => (c.name === 'tool_call' ? (c.input?.calls ?? []).map((inner) => inner.name) : [c.name]));
  return { kind: 'tool_result', text: unescape(textOf(results)), tool: names.join(','), system };
}

const fillIn = (value, vars) => {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (all, name) => vars[name] ?? all);
  if (Array.isArray(value)) return value.map((v) => fillIn(v, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillIn(v, vars)]));
  return value;
};

export function createModel() {
  let rules = [];
  let used = new Set();
  let vars = {};
  let log = [];
  let last = null;
  let ids = 0;

  function match(turn) {
    for (const [index, rule] of rules.entries()) {
      if (used.has(index)) continue;
      let pattern;
      if (rule.system !== undefined) pattern = { re: rule.system, text: turn.system };
      else if (rule.user !== undefined && turn.kind === 'user') pattern = { re: rule.user, text: turn.text };
      else if (rule.tool_result !== undefined && turn.kind === 'tool_result' && (!rule.after || turn.tool.split(',').some((t) => t.endsWith(rule.after)))) pattern = { re: rule.tool_result, text: turn.text };
      if (!pattern) continue;
      const found = new RegExp(pattern.re, 'i').exec(pattern.text);
      if (!found) continue;
      if (!rule.repeat) used.add(index);
      Object.assign(vars, found.groups ?? {});
      return { index, rule };
    }
    return null;
  }

  // The reply's blocks as Messages API content, tools resolved against the request's tools. Hermes
  // offers MCP and plugin tools deferred: each stands in tool_search's catalog as a `- <name>: …`
  // line, and tool_call invokes them.
  function content(reply, tools) {
    const offered = tools.map((t) => t.name);
    const catalog = [...(tools.find((t) => t.name === 'tool_search')?.description ?? '').matchAll(/^- ([\w.-]+):/gm)].map((m) => m[1]);
    return reply.map((block) => {
      if (block.text !== undefined) return { type: 'text', text: fillIn(block.text, vars) };
      ids += 1;
      const id = `toolu_e2e${String(ids).padStart(6, '0')}`;
      const input = fillIn(block.input ?? {}, vars);
      const name = offered.find((t) => t === block.tool || t.endsWith(block.tool));
      if (name) return { type: 'tool_use', id, name, input };
      const deferred = offered.includes('tool_call') && catalog.find((t) => t.endsWith(block.tool));
      if (deferred) return { type: 'tool_use', id, name: 'tool_call', input: { calls: [{ name: deferred, arguments: input }] } };
      throw new Error(`the request offers no tool ${block.tool} (it offers ${[...offered, ...catalog].join(', ') || 'none'})`);
    });
  }

  function stream(res, message) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', { message: { ...message, content: [], stop_reason: null } });
    message.content.forEach((block, index) => {
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      }
      send('content_block_stop', { index });
    });
    send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
    send('message_stop', {});
    res.end();
  }

  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://model').pathname.replace(/^\/anthropic/, '');
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const error = (status, message) => json(status, { type: 'error', error: { type: 'invalid_request_error', message } });
    try {
      if (req.method === 'PUT' && path === '/_script') {
        rules = JSON.parse(raw || '{}').rules ?? [];
        used = new Set();
        vars = {};
        log = [];
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/_log') return json(200, log);
      if (req.method === 'GET' && path === '/_last') return json(200, last);
      if (req.method === 'GET' && path === '/v1/models') return json(200, { data: [{ type: 'model', id: 'claude-e2e', display_name: 'Scripted model' }], has_more: false });
      if (req.method === 'GET' && path.startsWith('/v1/models/')) return json(200, { type: 'model', id: path.split('/').at(-1), display_name: 'Scripted model' });
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') return json(200, { input_tokens: 100 });
      if (req.method === 'POST' && path === '/v1/messages') {
        const body = JSON.parse(raw || '{}');
        const turn = turnOf(body);
        const found = match(turn);
        log.push({ kind: turn.kind, text: turn.text, tool: turn.tool, system: turn.system.slice(0, 200), tools: (body.tools ?? []).map((t) => t.name), matched: Boolean(found), rule: found?.index ?? null });
        last = body;
        if (!found) return error(400, `scripted model: no rule for this ${turn.kind} turn: ${turn.text.slice(0, 300)}`);
        const blocks = content(found.rule.reply ?? [], body.tools ?? []);
        const message = {
          id: `msg_e2e${String(log.length).padStart(6, '0')}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: blocks,
          stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        };
        return body.stream ? stream(res, message) : json(200, message);
      }
      return error(404, `scripted model: no route ${req.method} ${path}`);
    } catch (e) {
      return error(500, `scripted model: ${e.message}`);
    }
  });
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === (await import('node:fs')).realpathSync(process.argv[1]);
if (isMain) createModel().listen(Number(process.env.PORT ?? 80), '0.0.0.0');
