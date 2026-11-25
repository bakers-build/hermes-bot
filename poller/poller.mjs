#!/usr/bin/env node
// The PM bot's poller. Every interval it reads the project's tickets from
// bakers.build through its tools and, for each ticket with a conversation on the bot's side
// (PM_BOT_CHAT, poller/sides: a Slack channel or thread, or a GitLab issue; a sub-ticket without
// one shares its ancestor's): posts each state change there once and relays its open question or technical
// problem once. Between states it posts, once each, when a run starts, when a run ends without
// moving the ticket on, a new summary's outcome, the links in its Manual review on a host under
// PREVIEW_ZONES, a new preview link, and a heartbeat while a run works and the conversation has been quiet for PM_BOT_HEARTBEAT_INTERVAL. For the conversations the bot opened it owes the side's steps: on
// the ticket's arrival, closing after the final post, reopening with the ticket, and closing one
// that stayed silent for a week without a ticket. It posts in the bot's
// language, which the bot-channels plugin writes to bot-language.json. No LLM, no dependencies.
//
//   node poller/poller.mjs          # loop
//   node poller/poller.mjs --once   # one pass, then exit
//
// Configuration comes from the environment (.env, see .env.example).
// While bakers.build is unreachable a pass fails, is logged and keeps the state
// file as it was; the next pass catches up, so nothing is lost or posted twice.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBakersClient } from '../lib/bakers-client.mjs';
import { channelSteps, CLOSED } from './channels.mjs';
import { diff, reachedDone } from './diff.mjs';
import { heartbeatInterval, pollInterval } from './interval.mjs';
import { openNote, QUESTION_LABEL, relay, TECHNICAL_PROBLEM_LABEL } from './questions.mjs';
import { conversations } from './tickets.mjs';
import { withTicket } from './ticket-footer.mjs';
import { forget, previewZones, updates } from './updates.mjs';
import { createGitLab, createGitLabSide } from './sides/gitlab.mjs';
import { createSlack, createSlackSide, relaySender } from './sides/slack.mjs';

// shortcut: a ticket above 1000 comments loses the oldest, read through bakers_comment_read then.
const ALL_COMMENTS = 1000;

// The poller's steps per channelSteps kind, each a method of the side.
const STEP = { rename: 'onTicket', archive: 'close', reopen: 'reopen', abandon: 'expireSilent' };

/**
 * @param {{client: ReturnType<typeof createBakersClient>, side: ReturnType<typeof createSlackSide>,
 *   stateFile: string, conversationsFile: string, legacyFile?: string, languageFile: string, now?: () => number,
 *   project: string, messages: {de: any, en: any}, heartbeat?: number, previewZones?: string[], log?: {log: Function, error: Function}}} options
 *   heartbeat: the quiet time in ms after which a working ticket's conversation gets a heartbeat
 *   side: the conversation platform (poller/sides): the conversation of a ticket, its posts, the relay
 *     of questions and technical problems, and the steps owed to the conversations the bot opened
 *   conversationsFile: the conversations the bot's plugin opened (conversations.json), which only the plugin writes;
 *     legacyFile: bot-channels.json, read while the plugin has not moved it to conversationsFile yet
 *   languageFile: the bot's language as the plugin read it, {"language": "<ISO 639-1 code>"}; only the plugin writes it
 *   messages: the fixed texts per language
 *   previewZones: the DNS zones whose hosts' links in a summary's Manual review are posted; none posts none
 */
export function createPoller({ client, side, stateFile, conversationsFile, legacyFile, languageFile, now = Date.now, project, messages: texts, heartbeat = heartbeatInterval(), previewZones: zones = [], log = console }) {
  const stamp = () => new Date().toISOString();
  // The texts of the current pass: the plugin's language, German without texts for it.
  let messages = texts.de;

  // Every ticket of the project, page by page, through the bakers list tool.
  async function tickets() {
    const out = [];
    let offset = 0;
    while (offset !== null && offset !== undefined) {
      const page = await client.tool('bakers_ticket_list', { project, limit: 50, offset });
      for (const t of page.tickets) {
        out.push({
          id: t.id,
          identifier: t.identifier,
          title: t.title,
          url: t.url,
          origin: t.origin,
          state: t.state,
          conversation: side.conversationOf(t.links),
          links: t.links ?? [],
          labels: t.labels ?? [],
          frozen: Boolean(t.frozen),
          frozen_at: t.frozen_at ?? null,
          parent: t.parent ?? null,
          closed: Boolean(t.closed),
        });
      }
      offset = page.next_offset;
    }
    conversations(out);
    return out;
  }

  // A ticket's comments, newest first, optionally of one type, from bakers_ticket_read.
  async function comments(ticketId, type) {
    const ticket = await client.tool('bakers_ticket_read', { ticket: ticketId, newest: ALL_COMMENTS });
    return (ticket.comments ?? [])
      .filter((c) => !type || c.type === type)
      .map((c) => ({ id: c.id, type: c.type, created: c.created, body: c.body ?? '' }))
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
  }

  // The state file: {tickets: identifier → posted state, relayed: comment UUIDs,
  // channels: channel ID → {ticket, requester, name, generation, renamed, final, archived,
  // seen, closing, successor, reopened, previous}, updates: identifier → {runs: run UUID → state,
  // summaries, links, lastStart}, posted: conversation → last post in ms}. The plugin reads
  // `channels` for the open channels.
  async function readJson(file, empty) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return empty;
      throw error;
    }
  }

  // German while the plugin has written no language; an unreadable file is logged.
  async function language() {
    try {
      const { language: code } = await readJson(languageFile, {});
      if (code !== undefined && typeof code !== 'string') throw new Error('language is not a string');
      return Object.hasOwn(texts, code ?? '') ? texts[code] : texts.de;
    } catch (error) {
      log.error(`${stamp()} ${languageFile}: ${error.message}; posting in German`);
      return texts.de;
    }
  }

  async function readState() {
    const state = await readJson(stateFile, {});
    return { tickets: state.tickets ?? null, relayed: state.relayed ?? [], channels: state.channels ?? {}, updates: state.updates ?? {}, posted: state.posted ?? {} };
  }

  async function writeState(state) {
    await writeFile(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${stateFile}.tmp`, stateFile);
  }

  // Every post restarts its conversation's heartbeat interval.
  const stampPost = (state, { channel, thread_ts }) => {
    state.posted[thread_ts ? `${channel}:${thread_ts}` : channel] = now();
  };

  const archived = (state, t) => Boolean(t.conversation && !t.conversation.thread_ts && state.channels[t.conversation.channel]?.archived);

  async function postStates(state, all) {
    // An archived channel takes no post; a reopen posts the ticket's new state in its fresh channel.
    const current = all.filter((t) => !archived(state, t));
    const summaries = {};
    for (const identifier of reachedDone(state.tickets, current)) {
      const [summary] = await comments(current.find((t) => t.identifier === identifier).id, 'summary');
      summaries[identifier] = summary?.body ?? '';
    }
    const { posts, next } = diff(state.tickets, current, summaries, messages);
    for (const t of all) if (archived(state, t) && state.tickets?.[t.identifier] !== undefined) next[t.identifier] = state.tickets[t.identifier];
    for (const p of posts) {
      try {
        await side.post(p);
        stampPost(state, p);
        // The ticket's own channel may be archived only after this post.
        const record = !p.thread_ts && state.channels[p.channel];
        if (record?.ticket === p.identifier && CLOSED.includes(next[p.identifier])) record.final = true;
        log.log(`${stamp()} posted ${p.identifier}: ${next[p.identifier]}`);
      } catch (error) {
        // Keep the old state of this ticket only, so the next pass retries just this post.
        next[p.identifier] = state.tickets[p.identifier];
        log.error(`${stamp()} ${p.identifier}: ${error.message}`);
      }
    }
    state.tickets = next;
  }

  // Questions and technical problems share one relay and one record of relayed comments.
  async function relayNotes(state, current) {
    const open = [];
    let complete = true;
    const noted = (t) => t.labels.includes(QUESTION_LABEL) || t.labels.includes(TECHNICAL_PROBLEM_LABEL);
    for (const ticket of current.filter((t) => t.conversation && !archived(state, t) && t.frozen && noted(t))) {
      try {
        const note = openNote(ticket, await comments(ticket.id));
        if (note) open.push({ ticket, note });
      } catch (error) {
        complete = false;
        log.error(`${stamp()} note of ${ticket.identifier}: ${error.message}`);
      }
    }
    const leads = { question: messages.questionLead, technical_problem: messages.technicalProblemLead };
    const selected = relay(state.relayed, open, complete, leads);
    state.relayed = selected.relayed;
    for (const post of selected.posts) {
      try {
        const ticket = current.find((t) => t.identifier === post.identifier);
        await side.relay(post.kind === 'technical_problem' ? { ...post, text: withTicket(post.text, ticket, messages) } : post);
        state.relayed.push(post.comment);
        stampPost(state, post);
        log.log(`${stamp()} relayed ${post.kind} ${post.comment} of ${post.identifier}`);
      } catch (error) {
        // Not recorded, so the next pass retries it.
        log.error(`${stamp()} ${post.kind} ${post.comment} of ${post.identifier}: ${error.message}`);
      }
    }
  }

  // Status lines between states, for the open tickets that can still take a post. A ticket that
  // cannot be read keeps its record and is caught up on the next pass; a closed one's is dropped.
  async function postUpdates(state, current) {
    const read = [];
    const kept = {};
    for (const t of current.filter((t) => t.conversation && !archived(state, t) && !CLOSED.includes(t.state))) {
      try {
        const { runs } = await client.tool('bakers_run_list', { ticket: t.id });
        // Read after the runs, so a run's end is judged by the labels and freeze it ended with.
        const ticket = await client.tool('bakers_ticket_read', { ticket: t.id, newest: ALL_COMMENTS });
        read.push({ ...t, labels: ticket.labels ?? t.labels, frozen: ticket.frozen ?? t.frozen, runs: runs ?? [], comments: ticket.comments ?? [] });
      } catch (error) {
        if (state.updates[t.identifier]) kept[t.identifier] = state.updates[t.identifier];
        log.error(`${stamp()} updates of ${t.identifier}: ${error.message}`);
      }
    }
    const { posts, next } = updates({ previous: state.updates, posted: state.posted, tickets: read, now: now(), interval: heartbeat, messages, zones });
    state.updates = { ...kept, ...next.records };
    state.posted = next.posted;
    const refused = new Set();
    for (const p of posts) {
      // After a refused post, the ticket's later posts wait too, so the next pass retries them in order.
      if (refused.has(p.identifier)) {
        forget(state.updates, p);
        continue;
      }
      try {
        await side.post(p);
        stampPost(state, p);
        log.log(`${stamp()} posted an update of ${p.identifier}`);
      } catch (error) {
        // Not recorded, so the next pass retries it.
        refused.add(p.identifier);
        forget(state.updates, p);
        log.error(`${stamp()} update of ${p.identifier}: ${error.message}`);
      }
    }
  }

  async function channelWork(state, current, kinds) {
    const bot = await readJson(conversationsFile, null) ?? (legacyFile ? await readJson(legacyFile, {}) : {});
    for (const step of channelSteps(state, current, bot, now()).filter((s) => kinds.includes(s.kind))) {
      try {
        await side[STEP[step.kind]]({ state, messages, client, now, writeState }, step, bot);
        await writeState(state);
        log.log(`${stamp()} ${step.kind} ${step.channel}${step.ticket ? ` of ${step.ticket.identifier}` : ''}`);
      } catch (error) {
        // Tried again on the next pass, from the step not yet recorded.
        log.error(`${stamp()} ${step.kind} ${step.channel}: ${error.message}`);
      }
    }
  }

  async function pass() {
    messages = await language();
    try {
      const state = await readState();
      const current = await tickets();
      await channelWork(state, current, ['reopen', 'rename']);
      await postStates(state, current);
      // After the posts: a channel is archived only once its final state is posted.
      await channelWork(state, current, ['archive', 'abandon']);
      // Notes are relayed on the first pass too: they wait for an answer or for keytec.
      await relayNotes(state, current);
      // Last, so a heartbeat sees every other post of the pass.
      await postUpdates(state, current);
      await writeState(state);
    } catch (error) {
      // bakers.build unreachable: the state file stays as it was, the next pass catches up.
      log.error(`${stamp()} pass failed: ${error.message}`);
    }
  }

  return { pass };
}

const isMain = process.argv[1] && (await import('node:fs')).realpathSync(process.argv[1]) === (await import('node:fs')).realpathSync(new URL(import.meta.url).pathname);

if (isMain) {
  const env = (name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  // One side per bot (PM_BOT_CHAT, default slack).
  const chat = process.env.PM_BOT_CHAT || 'slack';
  let side;
  if (chat === 'slack') {
    const slack = createSlack({ url: process.env.SLACK_API_URL || undefined, token: env('SLACK_BOT_TOKEN') });
    side = createSlackSide({ slack, send: relaySender({ slackApiUrl: process.env.SLACK_API_URL, slack }), workspaceUrl: env('SLACK_WORKSPACE_URL') });
  } else if (chat === 'gitlab') {
    side = createGitLabSide({ gitlab: createGitLab({ url: env('GITLAB_URL'), project: env('GITLAB_PROJECT'), token: env('GITLAB_TOKEN') }) });
  } else {
    throw new Error(`PM_BOT_CHAT must be slack or gitlab, not ${chat}`);
  }
  const poller = createPoller({
    client: createBakersClient({ url: env('BAKERS_URL'), apiKey: env('BAKERS_API_KEY') }),
    side,
    stateFile: join(env('HERMES_HOME'), 'poller-state.json'),
    conversationsFile: join(env('HERMES_HOME'), 'conversations.json'),
    legacyFile: join(env('HERMES_HOME'), 'bot-channels.json'),
    languageFile: join(env('HERMES_HOME'), 'bot-language.json'),
    project: env('PM_BOT_PROJECT'),
    messages: JSON.parse(await readFile(new URL('./messages.json', import.meta.url), 'utf8')),
    heartbeat: heartbeatInterval(process.env.PM_BOT_HEARTBEAT_INTERVAL),
    previewZones: previewZones(process.env.PREVIEW_ZONES),
  });
  if (process.argv.includes('--once')) {
    await poller.pass();
  } else {
    const interval = pollInterval(process.env.PM_BOT_POLL_INTERVAL);
    for (;;) {
      await poller.pass();
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
