// The Slack recorder through the poller's own Slack client (createSlack), and its driver.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createSlack } from '../../../poller/sides/slack.mjs';
import { createRecorder } from './recorder.mjs';

let server;
let base;
let slack;

before(async () => {
  server = createRecorder();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  slack = createSlack({ url: `${base}/api`, token: 'xoxb-e2e' });
});
after(() => server.close());
beforeEach(() => fetch(`${base}/_reset`, { method: 'POST' }));

const calls = async () => (await fetch(`${base}/_calls`)).json();

describe('Slack recorder', () => {
  it('given a post, when the poller posts, then the call is recorded with its channel and text and gets a ts', async () => {
    const ts = await slack.post({ channel: 'C0E2E0001', text: 'Working on it' });
    assert.match(ts, /^\d+\.\d{6}$/);
    const [call] = await calls();
    assert.equal(call.method, 'chat.postMessage');
    assert.deepEqual({ channel: call.body.channel, text: call.body.text }, { channel: 'C0E2E0001', text: 'Working on it' });
    assert.equal(call.token, 'xoxb-e2e');
  });

  it('given a form-encoded call, as slack_sdk sends one, when a channel is created, then its fields are recorded and a taken name is refused', async () => {
    const create = (name) =>
      fetch(`${base}/api/conversations.create`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer xoxb-e2e' },
        body: new URLSearchParams({ name, is_private: '0' }),
      }).then((res) => res.json());
    assert.equal((await create('req-security-updates')).ok, true);
    assert.equal((await create('req-security-updates')).error, 'name_taken');
    const [call] = await calls();
    assert.deepEqual(call.body, { name: 'req-security-updates', is_private: '0' });
  });

  it('given a created channel, when it is renamed, invited to and archived, then each call succeeds and is recorded', async () => {
    const id = await slack.create('e2e-1-login');
    assert.match(id, /^C[A-Z0-9]+$/);
    await slack.invite(id, 'U0E2E0002');
    await slack.rename(id, 'e2e-1-login-page');
    await slack.archive(id);
    await slack.archive(id); // already_archived counts as done
    assert.deepEqual(
      (await calls()).map((c) => c.method),
      ['conversations.create', 'conversations.invite', 'conversations.rename', 'conversations.archive', 'conversations.archive'],
    );
  });

  it('given a taken name, when a channel is created with it, then Slack answers name_taken', async () => {
    await slack.create('e2e-1-login');
    await assert.rejects(slack.create('e2e-1-login'), (error) => error.code === 'name_taken');
  });

  it('given posts in a channel, when the poller reads its history, then it gets the newest message', async () => {
    assert.equal(await slack.lastMessage('C0E2E0001'), null);
    const ts = await slack.post({ channel: 'C0E2E0001', text: 'one' });
    assert.equal(await slack.lastMessage('C0E2E0001'), Number(ts) * 1000);
  });

  it('given an unknown method, when it is called, then it answers unknown_method and records it', async () => {
    const res = await fetch(`${base}/api/users.list`, { method: 'POST', body: '{}' });
    assert.deepEqual(await res.json(), { ok: false, error: 'unknown_method' });
    assert.equal((await calls())[0].method, 'users.list');
  });
});
