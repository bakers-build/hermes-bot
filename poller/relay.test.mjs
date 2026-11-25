import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relaySender } from './chat-modes/slack.mjs';

const note = { comment: 'c1', kind: 'question', identifier: 'BB-1', channel: 'C1', thread_ts: '1.2', text: 'Which footer?' };

function fakes() {
  const posted = [];
  const sent = [];
  return {
    posted,
    sent,
    slack: { post: async (message) => posted.push(message) },
    hermes: async (message) => sent.push(message),
  };
}

test('given no SLACK_API_URL, when a note is relayed, then it goes through hermes send', async () => {
  const f = fakes();
  await relaySender({ slackApiUrl: '', slack: f.slack, hermes: f.hermes })(note);
  assert.deepEqual(f.sent, [note]);
  assert.deepEqual(f.posted, []);
});

test('given a SLACK_API_URL, when a note is relayed, then the poller posts it there itself, in its thread', async () => {
  const f = fakes();
  await relaySender({ slackApiUrl: 'http://slack-recorder/api', slack: f.slack, hermes: f.hermes })(note);
  assert.deepEqual(f.posted, [{ channel: 'C1', thread_ts: '1.2', text: 'Which footer?' }]);
  assert.deepEqual(f.sent, []);
});
