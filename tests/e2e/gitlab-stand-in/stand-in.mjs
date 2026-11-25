#!/usr/bin/env node
// The end-to-end test's GitLab: the REST calls the GitLab chat mode makes, on one project (e2e/shop),
// answered from memory, every call recorded; and the webhook deliveries GitLab would send to the
// hooks the bot registered, signed with each hook's secret, for every new issue and every note,
// the bot's own included. No dependencies.
//
//   /api/v4/...           GET user, users/:id; the project's issues, notes, award emoji and hooks
//   GET  /_calls          every API call: {method, path, body, token}
//   GET  /_state          issues (with notes and award emoji) and hooks
//   POST /_users          {<id>: {username, name, public_email}}: the users GitLab knows
//   POST /_issue          {title, description, user, token?, project?}: an issue opened by user;
//                         token and project override the delivery's, to send what the bot must refuse
//   POST /_note           {iid, body, user}: a note by user on an issue
//
//   node tests/e2e/gitlab-stand-in/stand-in.mjs   # listens on PORT (80)

import { createServer } from 'node:http';

export const PROJECT = 'e2e/shop';
export const TOKEN = 'glpat-e2e';
export const BOT = { id: 99, username: 'pm-bot', name: 'PM bot' };

export function createStandIn({ url = 'http://gitlab', deliver = fetch } = {}) {
  const calls = [];
  const deliveries = [];
  const users = { [BOT.id]: BOT };
  const issues = new Map(); // iid → {iid, title, description, state, author, created_at, notes: [], awards: []}
  const hooks = [];
  let ids = 1000;
  const now = () => new Date().toISOString();
  const project = { id: 1, path_with_namespace: PROJECT, web_url: `${url}/${PROJECT}` };
  const issueUrl = (iid) => `${url}/${PROJECT}/-/issues/${iid}`;
  const author = (u) => ({ id: u.id, username: u.username, name: u.name });

  async function send(event, body, override = {}) {
    for (const hook of hooks) {
      if ((event === 'Issue Hook' && !hook.issues_events) || (event === 'Note Hook' && !hook.note_events)) continue;
      const payload = override.project ? { ...body, project: { ...project, path_with_namespace: override.project } } : body;
      try {
        const res = await deliver(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gitlab-event': event, 'x-gitlab-token': override.token ?? hook.token },
          body: JSON.stringify(payload),
        });
        deliveries.push({ event, hook: hook.id, status: res.status });
      } catch (error) {
        deliveries.push({ event, hook: hook.id, error: error.message });
      }
    }
  }

  function addNote(iid, body, user) {
    const issue = issues.get(Number(iid));
    const note = { id: ++ids, body, system: false, author: author(user), created_at: now(), awards: [] };
    issue.notes.push(note);
    const event = {
      object_kind: 'note', event_type: 'note', user: author(user), project,
      issue: { iid: issue.iid, title: issue.title, state: issue.state },
      object_attributes: { id: note.id, note: body, noteable_type: 'Issue', author_id: user.id, system: false, url: `${issueUrl(iid)}#note_${note.id}` },
    };
    return { note, sent: send('Note Hook', event) };
  }

  const json = (status, body) => ({ status, body });

  async function api(method, path, query, body, token) {
    calls.push({ method, path, query, body, token });
    if (token !== TOKEN) return json(401, { message: '401 Unauthorized' });
    if (method === 'GET' && path === '/user') return json(200, BOT);
    const user = path.match(/^\/users\/(\d+)$/);
    if (method === 'GET' && user) return users[user[1]] ? json(200, users[user[1]]) : json(404, { message: '404 User Not Found' });
    const base = `/projects/${encodeURIComponent(PROJECT)}`;
    if (!path.startsWith(`${base}/`)) return json(404, { message: '404 Project Not Found' });
    const rest = path.slice(base.length);
    if (rest === '/hooks') {
      if (method === 'GET') return json(200, hooks);
      if (method === 'POST') {
        const hook = { id: ++ids, ...body };
        hooks.push(hook);
        return json(201, hook);
      }
    }
    const hook = rest.match(/^\/hooks\/(\d+)$/);
    if (hook && method === 'PUT') {
      const found = hooks.find((h) => h.id === Number(hook[1]));
      if (!found) return json(404, { message: '404 Not found' });
      Object.assign(found, body);
      return json(200, found);
    }
    if (rest === '/issues' && method === 'GET') {
      const list = [...issues.values()].filter((i) => !query.get('state') || i.state === query.get('state'));
      return json(200, list.map(({ notes, awards, ...i }) => ({ ...i, web_url: issueUrl(i.iid) })));
    }
    const m = rest.match(/^\/issues\/(\d+)(\/notes(?:\/(\d+))?)?(\/award_emoji(?:\/(\d+))?)?$/);
    const issue = m && issues.get(Number(m[1]));
    if (!issue) return json(404, { message: '404 Issue Not Found' });
    const [, iid, notes, noteId, awards, awardId] = m;
    if (awards) {
      const target = noteId ? issue.notes.find((n) => n.id === Number(noteId)) : issue;
      if (!target) return json(404, { message: '404 Note Not Found' });
      if (method === 'POST') {
        const award = { id: ++ids, name: body.name, user: author(BOT) };
        target.awards.push(award);
        return json(201, award);
      }
      if (method === 'DELETE') {
        target.awards = target.awards.filter((a) => a.id !== Number(awardId));
        return json(204, null);
      }
    }
    if (notes && !noteId) {
      if (method === 'POST') {
        const { note, sent } = addNote(iid, body.body, BOT);
        await sent;
        return json(201, note);
      }
      if (method === 'GET') {
        const list = [...issue.notes];
        if (query.get('sort') === 'desc') list.reverse();
        return json(200, list.slice(0, Number(query.get('per_page') ?? 20)));
      }
    }
    if (!notes && !awards) {
      if (method === 'GET') return json(200, { ...issue, notes: undefined, awards: undefined });
      if (method === 'PUT') {
        if (body.state_event === 'close') issue.state = 'closed';
        if (body.state_event === 'reopen') issue.state = 'opened';
        return json(200, { ...issue, notes: undefined, awards: undefined });
      }
    }
    return json(405, { message: '405 Method Not Allowed' });
  }

  async function control(method, path, body) {
    if (method === 'GET' && path === '/_calls') return json(200, calls);
    if (method === 'GET' && path === '/_state') return json(200, { issues: [...issues.values()], hooks, deliveries });
    if (method === 'POST' && path === '/_users') {
      Object.assign(users, body);
      return json(200, users);
    }
    if (method === 'POST' && path === '/_issue') {
      const iid = issues.size + 1;
      const issue = { iid, title: body.title, description: body.description ?? '', state: 'opened', author: author(body.user), created_at: now(), notes: [], awards: [] };
      issues.set(iid, issue);
      await send('Issue Hook', {
        object_kind: 'issue', event_type: 'issue', user: author(body.user), project,
        object_attributes: { id: ++ids, iid, title: issue.title, description: issue.description, action: 'open', state: 'opened', author_id: body.user.id, url: issueUrl(iid), created_at: issue.created_at },
      }, body);
      return json(201, { iid, url: issueUrl(iid) });
    }
    if (method === 'POST' && path === '/_note') {
      if (!issues.has(Number(body.iid))) return json(404, { message: 'no such issue' });
      const { note, sent } = addNote(body.iid, body.body, body.user);
      await sent;
      return json(201, note);
    }
    return json(404, { message: 'not found' });
  }

  return {
    async handle({ method, url: target, headers, raw }) {
      const parsed = new URL(target, 'http://stand-in');
      const body = raw ? JSON.parse(raw) : undefined;
      if (parsed.pathname.startsWith('/api/v4/')) return api(method, parsed.pathname.slice('/api/v4'.length), parsed.searchParams, body, headers['private-token']);
      return control(method, parsed.pathname, body);
    },
  };
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const standIn = createStandIn();
  createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const out = await standIn.handle({ method: req.method, url: req.url, headers: req.headers, raw });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(out.body === null || out.body === undefined ? '' : JSON.stringify(out.body));
  }).listen(Number(process.env.PORT ?? 80));
}
