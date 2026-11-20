#!/usr/bin/env node
// `run.sh chat` (`ddev e2e chat`): one request channel in one window, as Slack shows it. The bot's
// posts into the channel (questions, status, rename, archive), recorded by the slack-recorder, appear
// as they come; each line typed goes to Hermes as a message in that channel, with the trusted line
// the bot-channels plugin puts before each turn and the sender's prefix, and its reply is shown.
// The turns share one Hermes session. No dependencies.
//
//   E2E_COMPOSE='["-p", …]' node channel-chat.mjs <recorder url> <poller-state.json> <channel> <ticket|none yet> <email> <language>

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import readline from 'node:readline';

const WORKSPACE_URL = 'https://e2e.slack.com';
const REQUESTER = '[Requester | Slack user <@U0E2EREQ>]';

const indent = (text) => text.replace(/\n/g, '\n     ');

/** The channel's recorded posts and changes, oldest first, one display line each. */
export function channelLines(calls, channel) {
  const lines = [];
  for (const { method, body } of calls) {
    if (body?.channel !== channel) continue;
    if (method === 'chat.postMessage') lines.push(`bot: ${indent(body.text ?? '')}`);
    else if (method === 'conversations.rename') lines.push(`· channel renamed to #${body.name}`);
    else if (method === 'conversations.invite') lines.push(`· ${body.users} invited`);
    else if (method === 'conversations.archive') lines.push('· channel archived');
  }
  return lines;
}

/** One message as the gateway hands it on: the channel's trusted line, then the sender's prefix and the text. */
export function turn(text, { channel, ticket, email, language }) {
  const trusted = `This is the request channel ${channel}. Its conversation link is ${WORKSPACE_URL}/archives/${channel}. Its ticket: ${ticket || 'none yet'}. Its requester's e-mail address: ${email}. Answer in the language with ISO 639-1 code ${language}.`;
  const line = /^\[[^\]]+\| Slack user <@\w+>\]/.test(text) ? text : `${REQUESTER} ${text}`;
  return `${trusted}\n${line}`;
}

/** The reply and session of `hermes chat -Q --format stream-json`. */
export function hermesResult(stdout) {
  const result = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find((event) => event.type === 'result');
  if (!result) throw new Error(`hermes chat gave no result: ${stdout.slice(-500)}`);
  if (result.exit_code !== 0) throw new Error(`hermes chat exited ${result.exit_code}: ${result.text ?? ''}`);
  return { text: result.text ?? '', session: result.session_id };
}

function hermes(compose, query, session) {
  const args = [...compose, 'exec', '-T', '-u', 'hermes', '-w', '/opt/data', 'pm-bot', 'hermes', 'chat', '-Q', '--format', 'stream-json', '--query-file', '-'];
  if (session) args.push('--resume', session);
  const once = () =>
    new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(hermesResult(out));
        } catch (error) {
          reject(new Error(`${error.message}${err ? `\n${err.trim().slice(-500)}` : ''}`));
        }
      });
      child.stdin.end(query);
    });
  // Hermes starts its gateway on demand; on a loaded machine that start can miss its deadline once.
  return once().catch((error) => (/Gateway starting: deadline/.test(error.message) ? once() : Promise.reject(error)));
}

async function main() {
  const [recorder, stateFile, channel, given, email, language] = process.argv.slice(2);
  const compose = JSON.parse(process.env.E2E_COMPOSE ?? '[]');
  // The ticket named on the command line, else the channel's as the plugin reads it, from the
  // poller's state once the poller follows one.
  const ticket = () => {
    if (given && given !== 'none yet') return given;
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8')).channels?.[channel]?.ticket ?? given;
    } catch {
      return given;
    }
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
  let busy = false;
  let closed = false;
  const prompt = (keep) => !closed && rl.prompt(keep);
  const show = (text) => {
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    console.log(text);
    if (!busy) prompt(true);
  };

  let seen = 0;
  const follow = async () => {
    try {
      const calls = await (await fetch(`${recorder}/_calls`)).json();
      const fresh = calls.slice(seen);
      seen = calls.length;
      for (const line of channelLines(fresh, channel)) show(line);
    } catch (error) {
      show(`· the Slack recorder is not reachable: ${error.message}`);
    }
  };

  console.log(`Channel ${channel}${ticket() && ticket() !== 'none yet' ? ` (${ticket()})` : ''}. Write as the requester; start a line with`);
  console.log('[Name | Slack user <@U…>] to write as someone else. Ctrl-D ends.\n');
  // Lines are sent one after another, after the channel so far; the window closes once the last
  // reply is shown.
  let session;
  const send = async (text) => {
    busy = true;
    console.log('· Hermes is working …');
    try {
      const reply = await hermes(compose, turn(text, { channel, ticket: ticket(), email, language }), session);
      session = reply.session ?? session;
      show(`Hermes: ${indent(reply.text)}`);
    } catch (error) {
      show(`· ${error.message}`);
    }
    busy = false;
    prompt();
  };
  busy = true;
  let pending = follow().then(() => {
    busy = false;
  });
  const timer = setInterval(follow, 2000);
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return prompt();
    pending = pending.then(() => send(text));
  });
  rl.on('close', async () => {
    closed = true;
    await pending;
    await follow();
    clearInterval(timer);
    console.log('');
    process.exit(0);
  });
  await pending;
  prompt();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) await main();
