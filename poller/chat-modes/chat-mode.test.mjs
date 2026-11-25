// The ChatMode contract (poller/poller.mjs): every chat mode's factory returns exactly its members,
// so a missing or extra member fails here, not at run time.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitLab, createGitLabChatMode } from './gitlab.mjs';
import { createSlack, createSlackChatMode } from './slack.mjs';

const MEMBERS = ['close', 'conversationOf', 'expireSilent', 'name', 'onTicket', 'post', 'relay', 'reopen'];

test('the Slack and the GitLab chat mode each have exactly the ChatMode members', () => {
  const slack = createSlackChatMode({ slack: createSlack({ token: 'xoxb-test' }), send: async () => {}, workspaceUrl: 'https://acme.slack.com' });
  const gitlab = createGitLabChatMode({ gitlab: createGitLab({ url: 'https://gitlab.example', project: 'acme/shop', token: 'glpat-test' }) });
  for (const mode of [slack, gitlab]) assert.deepEqual(Object.keys(mode).sort(), MEMBERS, mode.name);
  assert.deepEqual([slack.name, gitlab.name], ['slack', 'gitlab']);
});
