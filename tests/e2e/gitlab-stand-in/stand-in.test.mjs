// The GitLab stand-in answers as GitLab would for what the bot asks, and delivers its webhooks signed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOT, createStandIn, PROJECT, TOKEN } from './stand-in.mjs';

const ALICE = { id: 42, username: 'alice', name: 'Alice' };
const issues = `/api/v4/projects/${encodeURIComponent(PROJECT)}/issues`;

function standIn() {
  const sent = [];
  const s = createStandIn({ deliver: async (url, init) => (sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }), { status: 200 }) });
  const call = (method, url, body, token = TOKEN) => s.handle({ method, url, headers: { 'private-token': token }, raw: body ? JSON.stringify(body) : '' });
  return { s, sent, call };
}

test('every API call needs the token', async () => {
  const { call } = standIn();
  assert.equal((await call('GET', '/api/v4/user', undefined, 'wrong')).status, 401);
  assert.deepEqual((await call('GET', '/api/v4/user')).body, BOT);
});

test('a new issue and every note, the bot\'s own too, are delivered to the registered hook with its secret', async () => {
  const { sent, call } = standIn();
  await call('POST', `/api/v4/projects/${encodeURIComponent(PROJECT)}/hooks`, { url: 'http://bot/webhooks/gitlab', token: 's3cret', issues_events: true, note_events: true });
  const { body: issue } = await call('POST', '/_issue', { title: 'Login page', user: ALICE });
  await call('POST', `${issues}/${issue.iid}/notes`, { body: 'Thanks' });
  assert.deepEqual(sent.map((d) => [d.headers['x-gitlab-event'], d.headers['x-gitlab-token'], d.body.user.username]), [['Issue Hook', 's3cret', 'alice'], ['Note Hook', 's3cret', 'pm-bot']]);
  assert.equal(sent[0].body.project.path_with_namespace, PROJECT);
});

test('closing and reopening an issue changes its state; award emoji come and go', async () => {
  const { call } = standIn();
  const { body: issue } = await call('POST', '/_issue', { title: 'Login page', user: ALICE });
  await call('PUT', `${issues}/${issue.iid}`, { state_event: 'close' });
  assert.equal((await call('GET', `${issues}/${issue.iid}`)).body.state, 'closed');
  await call('PUT', `${issues}/${issue.iid}`, { state_event: 'reopen' });
  assert.equal((await call('GET', `${issues}/${issue.iid}`)).body.state, 'opened');
  const { body: award } = await call('POST', `${issues}/${issue.iid}/award_emoji`, { name: 'eyes' });
  assert.equal((await call('DELETE', `${issues}/${issue.iid}/award_emoji/${award.id}`)).status, 204);
});
