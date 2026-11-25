// The poller wired to the site and the Slack stub (with a recording `hermes send`), or with
// `chatMode: 'gitlab'` to the GitLab stub.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBakersClient } from '../lib/bakers-client.mjs';
import { createPoller } from '../poller/poller.mjs';
import { createGitLab, createGitLabChatMode } from '../poller/chat-modes/gitlab.mjs';
import { createSlack, createSlackChatMode } from '../poller/chat-modes/slack.mjs';
import { PROJECT, site } from './site.mjs';
import { gitlabStub, slackStub } from './stubs.mjs';

const messages = JSON.parse(readFileSync(new URL('../poller/messages.json', import.meta.url), 'utf8'));

export async function setup(t, { slackAnswers, previewZones, chatMode = 'slack', ...siteOptions } = {}) {
  const s = await site(siteOptions);
  const slack = await slackStub(slackAnswers);
  const gitlab = await gitlabStub();
  t.after(s.close);
  t.after(slack.close);
  t.after(gitlab.close);
  const sent = [];
  let sendFails = false;
  const home = mkdtempSync(join(tmpdir(), 'pm-poller-'));
  const stateFile = join(home, 'poller-state.json');
  const conversationsFile = join(home, 'conversations.json');
  const legacyFile = join(home, 'bot-channels.json');
  const languageFile = join(home, 'bot-language.json');
  const errors = [];
  // The clock the poller reads; tests move it.
  const clock = { now: Date.parse('2026-11-05T12:00:00Z') };
  // A fresh poller on the same state file, as after a restart.
  const start = () => createPoller({
    client: createBakersClient({ url: s.stub.url, apiKey: 'bb-test-key' }),
    chatMode: chatMode === 'gitlab' ? createGitLabChatMode({ gitlab: createGitLab({ url: gitlab.url, project: gitlab.project, token: 'glpat-test' }) }) : createSlackChatMode({
      slack: createSlack({ url: slack.url, token: 'xoxb-test' }),
      send: async (message) => {
        if (sendFails) throw new Error('hermes send exited 1');
        sent.push(message);
      },
      workspaceUrl: 'https://acme.slack.com',
    }),
    stateFile,
    conversationsFile,
    legacyFile,
    languageFile,
    now: () => clock.now,
    project: PROJECT,
    messages,
    previewZones,
    log: { log: () => {}, error: (line) => errors.push(line) },
  });
  const poller = start();
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  // The request channels the bot's plugin opened, as it writes conversations.json.
  const botChannels = (channels) => writeFileSync(conversationsFile, JSON.stringify(Object.fromEntries(Object.entries(channels).map(([id, c]) => [id, { chat_mode: chatMode, ...c }]))));
  // The request channels as the plugin wrote them before conversations.json (bot-channels.json).
  const legacyChannels = (channels) => writeFileSync(legacyFile, JSON.stringify(channels));
  // The bot's language as the plugin writes bot-language.json; `{ raw }` writes the text as it is.
  const language = (code) => writeFileSync(languageFile, code.raw ?? JSON.stringify({ language: code }));
  return { s, slack, gitlab, sent, poller, state, clock, botChannels, legacyChannels, language, errors, restart: start, failSend: (value) => (sendFails = value) };
}

