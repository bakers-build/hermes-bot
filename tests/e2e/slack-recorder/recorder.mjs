#!/usr/bin/env node
// The end-to-end test's Slack: the Web API methods the poller calls, answered plausibly, every
// call recorded. The poller and the nightly audit's channel tool reach it through SLACK_API_URL
// (http://slack-recorder/api), in JSON or as a form. No Socket Mode, no workspace: the test talks
// to the bot through Hermes' CLI. No dependencies.
//
//   POST /api/<method>   chat.postMessage, conversations.create|invite|rename|archive|history
//   GET  /_calls         every call: {method, token, body, at}
//   POST /_reset         forget the calls and the channels
//
//   node tests/e2e/slack-recorder/recorder.mjs   # listens on PORT (80)

import { createServer } from 'node:http';

export function createRecorder() {
  let calls = [];
  let channels = new Map(); // id → {name, archived, messages: [ts]}
  let clock = 0;
  let ids = 0;

  // Strictly increasing message timestamps, as Slack's are.
  const ts = () => {
    clock = Math.max(clock + 1, Date.now() * 1000);
    return `${Math.floor(clock / 1e6)}.${String(clock % 1e6).padStart(6, '0')}`;
  };
  const channel = (id) => {
    if (!channels.has(id)) channels.set(id, { name: id.toLowerCase(), archived: false, messages: [] });
    return channels.get(id);
  };
  const taken = (name) => [...channels.values()].some((c) => c.name === name);

  const methods = {
    'chat.postMessage': ({ channel: id, text }) => {
      const c = channel(id);
      if (c.archived) return { ok: false, error: 'is_archived' };
      const at = ts();
      c.messages.push(at);
      return { ok: true, channel: id, ts: at, message: { text, ts: at } };
    },
    'conversations.create': ({ name }) => {
      if (taken(name)) return { ok: false, error: 'name_taken' };
      ids += 1;
      const id = `C0REC${String(ids).padStart(5, '0')}`;
      channels.set(id, { name, archived: false, messages: [] });
      return { ok: true, channel: { id, name } };
    },
    'conversations.invite': ({ channel: id }) => ({ ok: true, channel: { id, name: channel(id).name } }),
    'conversations.rename': ({ channel: id, name }) => {
      if (taken(name) && channel(id).name !== name) return { ok: false, error: 'name_taken' };
      channel(id).name = name;
      return { ok: true, channel: { id, name } };
    },
    'conversations.archive': ({ channel: id }) => {
      const c = channel(id);
      if (c.archived) return { ok: false, error: 'already_archived' };
      c.archived = true;
      return { ok: true };
    },
    'conversations.history': ({ channel: id, limit = 100 }) => ({
      ok: true,
      messages: channel(id).messages.slice(-limit).reverse().map((at) => ({ type: 'message', ts: at })),
    }),
  };

  return createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url, 'http://slack').pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/_calls') return json(calls);
    if (req.method === 'POST' && path === '/_reset') {
      calls = [];
      channels = new Map();
      return json({ ok: true });
    }
    const method = path.match(/^\/api\/([\w.]+)$/)?.[1];
    if (!method) {
      res.writeHead(404);
      return res.end();
    }
    // JSON from the poller, a form from slack_sdk (the plugin's channel tool), as Slack takes both.
    let body = {};
    try {
      body = !raw ? {} : /x-www-form-urlencoded/.test(req.headers['content-type'] ?? '') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    } catch {
      body = { raw };
    }
    calls.push({ method, token: (req.headers.authorization ?? '').replace(/^Bearer /, ''), body, at: Date.now() });
    return json(methods[method] ? methods[method](body) : { ok: false, error: 'unknown_method' });
  });
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === (await import('node:fs')).realpathSync(process.argv[1]);
if (isMain) createRecorder().listen(Number(process.env.PORT ?? 80), '0.0.0.0');
