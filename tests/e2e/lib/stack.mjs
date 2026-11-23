// The end-to-end test's driver: one handle on the stack run.sh started, for the scenarios.
//
//   chat        a turn to the bot through `hermes chat` in the pm-bot container, as the gateway
//               would hand it on: the channel's trusted line, then the sender's prefix
//   site        bakers.build's tools on /mcp, as the bot (its service account) or the owner
//   model       the scripted model's script and log
//   slack       the Slack calls the poller made, from the recorder
//   agent       the stub agent's script for a ticket's next run
//   channel     a request channel as the bot-channels plugin records it, for the poller
//   audit       the nightly composer-audit job: the clone and pull marker it reads, a run, its answer
//   restart     a service of the stack; recreate one, which rereads its env file
//   botLanguage PM_BOT_LANGUAGE in the bot's env file, the bot recreated and its language module started
//   languageFile the language the poller reads, bot-language.json
//
// run.sh exports E2E_COMPOSE (the compose arguments, project and files), E2E_OUT (the run's
// directory, with seed.json) and E2E_MODE (scripted or real).

import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

const OUT = process.env.E2E_OUT;
const COMPOSE = JSON.parse(process.env.E2E_COMPOSE ?? '[]');
export const MODE = process.env.E2E_MODE ?? 'scripted';
export const scripted = MODE === 'scripted';
export const WORKSPACE_URL = 'https://e2e.slack.com';

export const seed = OUT ? JSON.parse(readFileSync(join(OUT, 'seed.json'), 'utf8')) : {};

/** `docker compose <args>` on the stack; rejects with its output on a non-zero exit. */
export function compose(args, { input, timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['compose', ...COMPOSE, ...args], { maxBuffer: 64 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`docker compose ${args.join(' ')}: ${stderr || error.message}`), { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const ports = {};
async function port(service) {
  ports[service] ??= Number((await compose(['port', service, '80'])).stdout.trim().split(':').at(-1));
  return ports[service];
}

/** An HTTP request to a service's published port 80; the site answers only to Host nginx. */
async function http(service, method, path, { body, headers = {} } = {}) {
  const p = await port(service);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: p, method, path, headers: { host: service, ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

/** Polls `check` until it returns a truthy value, which it returns; fails naming `what`. */
export async function waitFor(what, check, { timeout = 180_000, interval = 2_000 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > until) throw new Error(`timed out after ${timeout / 1000} s waiting for ${what}${last ? `: ${last.message}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Holds for `ms` and fails when `check` turns truthy meanwhile: proof that something stays away. */
export async function never(what, check, { ms = 20_000, interval = 2_000 } = {}) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value) throw new Error(`${what}: ${JSON.stringify(value).slice(0, 500)}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export const site = {
  /** One bakers tool as the bot (default) or the conductor's owner. */
  async tool(name, args, { as = 'bot' } = {}) {
    const key = as === 'owner' ? seed.owner_api_key : seed.bot_api_key;
    let session = '';
    const rpc = async (message) => {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` };
      if (session) headers['mcp-session-id'] = session;
      const res = await http('nginx', 'POST', '/mcp', { body: message, headers });
      if (res.status >= 400) throw new Error(`${name}: /mcp answered ${res.status}: ${res.text.slice(0, 300)}`);
      session = res.headers['mcp-session-id'] ?? session;
      if (message.id === undefined) return null;
      const json = res.headers['content-type']?.includes('text/event-stream')
        ? res.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('')
        : res.text;
      const answer = JSON.parse(json);
      if (answer.error) throw new Error(`${name}: ${answer.error.message}`);
      return answer.result;
    };
    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pm-bot-e2e', version: '1' } } });
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const result = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `tool_api__${name}`, arguments: args } });
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(`${name}: ${text}`);
    return result.structuredContent ?? JSON.parse(text);
  },
  ticket: (ticket) => site.tool('bakers_ticket_read', { ticket, newest: 100 }),
  runs: async (ticket) => (await site.tool('bakers_run_list', { ticket }, { as: 'owner' })).runs ?? [],
};

export const model = {
  /** Replaces the scripted model's rules; Hermes' session-title call is always answered. */
  async script(rules) {
    const title = { system: 'name chat sessions', repeat: true, reply: [{ text: 'E2E request' }] };
    const res = await http('model', 'PUT', '/_script', { body: { rules: [title, ...rules] } });
    if (res.status !== 200) throw new Error(`model script: ${res.status} ${res.text}`);
  },
  log: async () => JSON.parse((await http('model', 'GET', '/_log')).text),
  /** The turns no rule answered: each one is a scenario failure. */
  unmatched: async () => (await model.log()).filter((t) => !t.matched),
};

export const slack = {
  calls: async () => JSON.parse((await http('slack-recorder', 'GET', '/_calls')).text),
  /** The poller's posts into a channel, oldest first. */
  posts: async (channel) => (await slack.calls()).filter((c) => c.method === 'chat.postMessage' && c.body.channel === channel).map((c) => c.body.text),
  of: async (method) => (await slack.calls()).filter((c) => c.method === method),
};

export const agent = {
  /**
   * The stub agent's next run on a ticket plays tests/e2e/agent/<name>.json: bakers tool calls it
   * makes as the conductor's owner, then it exits. `{{ticket}}` in an argument is the ticket.
   */
  script(identifier, name) {
    const dir = join(OUT, 'agent');
    mkdirSync(dir, { recursive: true });
    copyFileSync(new URL(`../agent/${name}.json`, import.meta.url), join(dir, `${identifier}.json.tmp`));
    renameSync(join(dir, `${identifier}.json.tmp`), join(dir, `${identifier}.json`));
  },
};

/**
 * A request channel as the bot-channels plugin records it when it opens one (bot-channels.json in
 * the bot's data directory): the poller renames, archives and reopens only those.
 */
export function channel(id, { requester = 'U0E2EREQ', email = seed.requester_email } = {}) {
  const file = join(OUT, 'data', 'bot-channels.json');
  let bot = {};
  try {
    bot = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  bot[id] = { name: `req-${id.toLowerCase()}`, requester, created: new Date().toISOString(), requester_email: email };
  writeFileSync(`${file}.tmp`, JSON.stringify(bot, null, 2));
  renameSync(`${file}.tmp`, file);
  return { id, link: `${WORKSPACE_URL}/archives/${id}` };
}

export const audit = {
  /**
   * The clone as the box leaves it after a pull: the fixture project (tests/e2e/clone, its one
   * advisory served by tests/e2e/advisories) and the pull marker, `at` hours ago.
   */
  pulled({ hoursAgo = 1, ok = true, head = 'e2e0000' } = {}) {
    cpSync(new URL('../clone/', import.meta.url), join(OUT, 'clone'), { recursive: true });
    const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(join(OUT, 'data', 'clone-pulled.json.tmp'), JSON.stringify({ at, head, ok }));
    renameSync(join(OUT, 'data', 'clone-pulled.json.tmp'), join(OUT, 'data', 'clone-pulled.json'));
    return { at, head };
  },
  /** The job once entrypoint.sh has registered it, on the bot's start. */
  job() {
    return waitFor('the composer-audit job registered', () => {
      const jobs = JSON.parse(readFileSync(join(OUT, 'data', 'cron', 'jobs.json'), 'utf8')).jobs.filter((job) => job.name === 'composer-audit');
      if (jobs.length > 1) throw new Error(`${jobs.length} composer-audit jobs, not one`);
      return jobs[0];
    });
  },
  /** Runs the job now, as its schedule would, and returns the run's saved output (its answer, delivered locally). */
  async run() {
    const { id } = await audit.job();
    const dir = join(OUT, 'data', 'cron', 'output', id);
    const outputs = () => { try { return readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; } };
    const before = new Set(outputs());
    const hermes = (...args) => compose(['exec', '-T', '-u', 'hermes', '-w', '/opt/data', 'pm-bot', 'hermes', ...args]);
    // Hermes' own Slack sender calls slack.com, which the stack has no token for: its preflight would
    // block the run. The answer stays in the job's output instead of the main channel.
    await hermes('cron', 'edit', id, '--deliver', 'local');
    await hermes('cron', 'run', 'composer-audit');
    const added = outputs().filter((f) => !before.has(f));
    if (added.length !== 1) throw new Error(`the run saved ${added.length} outputs in ${dir}`);
    return readFileSync(join(dir, added[0]), 'utf8');
  },
  /** The packages Composer asked the advisory stub about, per call. */
  calls: async () => JSON.parse((await http('advisories', 'GET', '/_calls')).text),
};

/**
 * One turn to the bot, as the gateway hands it on in a request channel: the channel's trusted
 * line (the plugin's), then the sender's prefix and the message. Returns the reply and the session
 * to resume.
 */
export async function chat(text, { session, channel: ch, ticket = 'none yet', sender = 'Requester', user = 'U0E2EREQ', email = seed.requester_email } = {}) {
  const trusted = ch
    ? `This is the request channel ${ch.id}. Its conversation link is ${ch.link}. Its ticket: ${ticket}. Its requester's e-mail address: ${email}. Answer in the language with ISO 639-1 code en.\n\n`
    : '';
  const query = `${session ? '' : trusted}[${sender} | Slack user <@${user}>] ${text}`;
  const args = ['exec', '-T', '-u', 'hermes', '-w', '/opt/data', 'pm-bot', 'hermes', 'chat', '-Q', '--format', 'stream-json', '--query-file', '-'];
  if (session) args.push('--resume', session);
  // `hermes chat` starts Hermes' gateway when none runs; on a loaded machine (a restarted bot,
  // emulated images) that start can miss its deadline once. The turn has not run then.
  const run = () => compose(args, { input: query });
  const { stdout } = await run().catch((error) => (/Gateway starting: deadline/.test(error.message) ? run() : Promise.reject(error)));
  const events = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const result = events.find((e) => e.type === 'result');
  if (!result) throw new Error(`hermes chat gave no result: ${stdout.slice(-1000)}`);
  if (result.exit_code !== 0) throw new Error(`hermes chat exited ${result.exit_code}: ${result.text ?? ''}`);
  return { text: result.text ?? '', session: result.session_id, events };
}

/** Restarts a service and waits until compose reports it running. */
export async function restart(service) {
  await compose(['restart', service]);
  // A restarted container gets a new published port.
  delete ports[service];
  await waitFor(`${service} running`, async () => (await compose(['ps', '--status', 'running', '--services'])).stdout.split('\n').includes(service));
}

/**
 * Recreates a service from its image, as `up` after a change to its env file does (a restart keeps
 * the env it was created with), and waits until compose reports it running.
 */
export async function recreate(service) {
  await compose(['up', '-d', '--no-deps', '--force-recreate', service]);
  delete ports[service];
  await waitFor(`${service} running`, async () => (await compose(['ps', '--status', 'running', '--services'])).stdout.split('\n').includes(service));
}

/** The language the poller reads, as the plugin wrote it: bot-language.json, or null without one. */
export function languageFile() {
  try {
    return JSON.parse(readFileSync(join(OUT, 'data', 'bot-language.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// The plugin's language module (plugins/bot-channels/language.py), as the entrypoint installed it,
// started as the plugin starts it: from the container's env, writing the poller's file.
const START_LANGUAGE = `
import importlib.util
spec = importlib.util.spec_from_file_location("bot_language", "/opt/data/plugins/bot-channels/language.py")
language = importlib.util.module_from_spec(spec)
spec.loader.exec_module(language)
language.start({}, "/opt/data/bot-language.json")
`;

/**
 * Sets PM_BOT_LANGUAGE in the bot's env file (undefined: unset), recreates the bot from the same
 * image and waits for its poller, then (unless `start` is false) starts the plugin's language
 * module in it, as the gateway would on its start. Returns the module's log lines.
 */
export async function botLanguage(value, { start = true } = {}) {
  const env = join(OUT, 'data', '.env');
  const lines = readFileSync(env, 'utf8').split('\n').filter((line) => !line.startsWith('PM_BOT_LANGUAGE='));
  if (value !== undefined) lines.splice(lines.findIndex((line) => line.startsWith('PM_BOT_MODEL=')) + 1, 0, `PM_BOT_LANGUAGE=${value}`);
  writeFileSync(env, lines.join('\n'), { mode: 0o600 });
  const state = join(OUT, 'data', 'poller-state.json');
  await recreate('pm-bot');
  // The entrypoint removes the previous start's language file just before it runs the poller, which
  // writes its state on every pass: after a pass of the new container's, a file written stays.
  const since = Date.now();
  await waitFor('the recreated poller\'s first pass', () => statSync(state).mtimeMs > since);
  if (!start) return '';
  const { stderr } = await compose(['exec', '-T', '-u', 'hermes', '-w', '/opt/data', 'pm-bot', '/opt/hermes/.venv/bin/python', '-c', START_LANGUAGE]);
  return stderr;
}

/** A ticket as the bot would create it from a request channel, without the model, once the poller follows it. */
export async function ticketFor(ch, title) {
  const created = await site.tool('bakers_ticket_create', { title, workflow: seed.workflow, project: seed.project_uuid, description: `${title}.` });
  await site.tool('bakers_ticket_transition', { ticket: created.identifier, links: [{ uri: ch.link, title: 'Slack channel' }] });
  await followed(created.identifier);
  return created;
}

/**
 * Waits until the poller follows a ticket: its first pass over a ticket records the state and posts
 * nothing, so a move under test comes after it.
 */
export function followed(identifier) {
  return waitFor(`the poller following ${identifier}`, () => pollerState(identifier) !== undefined);
}

/** The state the poller last posted (or recorded) for a ticket. */
export function pollerState(identifier) {
  return JSON.parse(readFileSync(join(OUT, 'data', 'poller-state.json'), 'utf8')).tickets?.[identifier];
}

/** The poller's record of a ticket: what it saw of its runs, summaries and links. */
export function pollerRecord(identifier) {
  const state = JSON.parse(readFileSync(join(OUT, 'data', 'poller-state.json'), 'utf8'));
  return state.updates?.[identifier] ?? null;
}

/**
 * A ticket handed over to the conductor as the bot hands it over, without the model: created,
 * linked to its channel, in working with the conductor set. The stub agent's next run plays `script`.
 */
export async function workingTicket(ch, title, script) {
  const ticket = await ticketFor(ch, title);
  if (script) agent.script(ticket.identifier, script);
  await moveTo(ticket.identifier, 'plan', 'working');
  await site.tool('bakers_ticket_update', { ticket: ticket.identifier, conductor: seed.conductor_uuid });
  return ticket;
}

/** Its runs once one of them has ended, as the owner sees them. */
export function runEnded(identifier) {
  return waitFor(`a run of ${identifier} to end`, async () => {
    const runs = await site.runs(identifier);
    return runs.some((r) => ['done', 'cancelled', 'failed', 'expired'].includes(r.state)) && runs;
  });
}

/** Cancels a scenario's ticket, which ends its open run: a run left running holds a conductor slot. */
export const cancel = (identifier) => site.tool('bakers_ticket_transition', { ticket: identifier, state: 'cancelled' }, { as: 'owner' });

/**
 * Reopens a done ticket into working as the site's administrator, as a person does in the site's
 * UI: the tools change no closed ticket.
 */
export async function reopen(identifier) {
  const php = `
    $storage = \\Drupal::entityTypeManager()->getStorage('bb_ticket');
    $ticket = current($storage->loadByProperties(['identifier' => '${identifier}']));
    \\Drupal::service('account_switcher')->switchTo(\\Drupal::entityTypeManager()->getStorage('user')->load(1));
    $ticket->set('state', 'working');
    if ($ticket->hasField('closed')) { $ticket->set('closed', FALSE); }
    $ticket->save();
    echo $ticket->get('state')->value;
  `;
  const { stdout } = await compose(['exec', '-T', 'php', '/var/www/html/vendor/bin/drush', 'php:eval', php]);
  if (stdout.trim() !== 'working') throw new Error(`reopening ${identifier}: ${stdout}`);
}

/** Moves a ticket through the workflow's states, one transition each. */
export async function moveTo(ticket, ...states) {
  for (const state of states) await site.tool('bakers_ticket_transition', { ticket, state });
}
