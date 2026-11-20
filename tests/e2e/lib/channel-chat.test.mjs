import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelLines, hermesResult, turn } from './channel-chat.mjs';

const calls = [
  { method: 'chat.postMessage', body: { channel: 'C1', text: 'Wir arbeiten jetzt daran.' }, at: 1 },
  { method: 'chat.postMessage', body: { channel: 'C2', text: 'another channel' }, at: 2 },
  { method: 'conversations.rename', body: { channel: 'C1', name: 'e2e-5-rafi' }, at: 3 },
  { method: 'chat.postMessage', body: { channel: 'C1', text: 'E2E-5 hat eine Frage:\n\n# Question\n\nPasst das?' }, at: 4 },
  { method: 'conversations.invite', body: { channel: 'C1', users: 'U0E2EREQ' }, at: 5 },
  { method: 'conversations.archive', body: { channel: 'C1' }, at: 6 },
];

test('given the recorded Slack calls, when a channel is shown, then only its posts and changes appear, in order', () => {
  assert.deepEqual(channelLines(calls, 'C1'), [
    'bot: Wir arbeiten jetzt daran.',
    '· channel renamed to #e2e-5-rafi',
    'bot: E2E-5 hat eine Frage:\n     \n     # Question\n     \n     Passt das?',
    '· U0E2EREQ invited',
    '· channel archived',
  ]);
});

test('given a line, when it is sent, then the channel\'s trusted line and the requester\'s prefix come first', () => {
  const query = turn('Ja, passt.', { channel: 'C1', ticket: 'E2E-5', email: 'r@example.test', language: 'de' });
  assert.equal(query, [
    'This is the request channel C1. Its conversation link is https://e2e.slack.com/archives/C1. Its ticket: E2E-5. Its requester\'s e-mail address: r@example.test. Answer in the language with ISO 639-1 code de.',
    '[Requester | Slack user <@U0E2EREQ>] Ja, passt.',
  ].join('\n'));
});

test('given a line with its own sender prefix, when it is sent, then that prefix is kept', () => {
  const query = turn('[Second Member | Slack user <@U0E2E0002>] Nur mit E-Mail.', { channel: 'C1', email: 'r@example.test', language: 'de' });
  assert.match(query, /Its ticket: none yet\./);
  assert.match(query, /\n\[Second Member \| Slack user <@U0E2E0002>\] Nur mit E-Mail\.$/);
});

test('given hermes chat\'s stream-json output, when it is read, then the reply and the session to resume come out', () => {
  const stdout = 'Gateway ready\n{"type":"text","text":"Ja"}\n{"type":"result","exit_code":0,"text":"Danke, ist notiert.","session_id":"s-42"}\n';
  assert.deepEqual(hermesResult(stdout), { text: 'Danke, ist notiert.', session: 's-42' });
});

test('given a failed turn, when it is read, then it says why', () => {
  assert.throws(() => hermesResult('{"type":"result","exit_code":1,"text":"no model"}'), /exited 1: no model/);
  assert.throws(() => hermesResult('Traceback …'), /no result/);
});
