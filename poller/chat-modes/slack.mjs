// The poller's Slack chat mode (README.md › Chat modes): a ticket's conversation is a Slack channel or
// thread; the bot renames a request channel after its ticket, archives it after the final post,
// opens a fresh `-2` channel when the ticket is reopened and closes a request channel that stayed
// silent for a week without a ticket.

import { spawn } from 'node:child_process';
import { ticketChannelName, WEEK } from '../channels.mjs';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => values[key]);

const PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p([0-9]{10})([0-9]{6})(?:[?#].*)?$/;
const CHANNEL = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/?(?:[?#].*)?$/;

// A link counts when bakers.build stored it as kind `chat`, or, stored without a kind, by its shape.
const chat = (link) => [undefined, 'chat'].includes(link.options?.bakers?.kind);

/**
 * The ticket's Slack conversation: its NEWEST channel link (`/archives/C…`), flat; without
 * one, the thread of its first `chat` link, as tickets from before channels have.
 *
 * @param {Array<{uri: string, options?: any}>} links the ticket's `links` field
 * @returns {{channel: string, thread_ts?: string, url: string} | null}
 */
export function conversation(links) {
  const chats = (links ?? []).filter(chat);
  const channel = chats.map((l) => [l, String(l.uri).match(CHANNEL)]).filter(([, m]) => m).pop();
  if (channel) return { channel: channel[1][1], url: channel[0].uri };
  for (const link of chats) {
    const match = String(link.uri).match(PERMALINK);
    if (!match) {
      if (link.options?.bakers?.kind === 'chat') return null; // the first chat link is not a Slack permalink
      continue;
    }
    // A permalink to a reply names its thread in thread_ts.
    const reply = new URL(link.uri).searchParams.get('thread_ts');
    return { channel: match[1], thread_ts: reply ?? `${match[2]}.${match[3]}`, url: link.uri };
  }
  return null;
}

/** The Slack Web API calls the poller makes. */
export function createSlack({ url = 'https://slack.com/api', token }) {
  async function call(method, body) {
    const res = await fetch(`${url}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const answer = await res.json();
    if (!answer.ok) throw Object.assign(new Error(`${method} failed: ${answer.error}`), { code: answer.error });
    return answer;
  }
  // A call whose listed errors mean it is already done.
  const settled = (codes) => (error) => {
    if (!codes.includes(error.code)) throw error;
  };
  return {
    // A message, in a thread when thread_ts is given; returns its ts.
    post: async ({ channel, thread_ts, text }) => (await call('chat.postMessage', { channel, thread_ts, text })).ts,
    // A public channel; returns its ID.
    create: async (name) => (await call('conversations.create', { name, is_private: false })).channel.id,
    invite: (channel, user) => call('conversations.invite', { channel, users: user }).catch(settled(['already_in_channel'])),
    rename: (channel, name) => call('conversations.rename', { channel, name }),
    archive: (channel) => call('conversations.archive', { channel }).catch(settled(['already_archived'])),
    // The newest message's ts in epoch milliseconds, or null.
    lastMessage: async (channel) => {
      const [latest] = (await call('conversations.history', { channel, limit: 1 })).messages ?? [];
      return latest ? Number(latest.ts) * 1000 : null;
    },
  };
}

// A relayed note goes through Hermes, which also adds it to the conversation's
// session: the agent knows the question or technical problem when someone there answers.
export function hermesSend({ channel, thread_ts, text }) {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', ['send', '--to', thread_ts ? `slack:${channel}:${thread_ts}` : `slack:${channel}`, '--quiet', '--file', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`hermes send exited ${code}: ${stderr.trim()}`))));
    child.stdin.end(text);
  });
}

// The relay's way out, by where the poller's Slack is: Slack itself (no SLACK_API_URL) through
// hermes send, which mirrors into the channel's gateway session; another Slack API, which hermes send
// cannot reach, through the poller's own Slack client. That one has no gateway session to mirror into.
export function relaySender({ slackApiUrl, slack, hermes = hermesSend }) {
  if (!slackApiUrl) return hermes;
  return async ({ channel, thread_ts, text }) => {
    await slack.post({ channel, thread_ts, text });
  };
}

/**
 * The Slack chat mode.
 *
 * @param {{slack: ReturnType<typeof createSlack>, send: Function, workspaceUrl: string}} options
 *   send: the relay of questions and technical problems (relaySender)
 * @returns {import('../poller.mjs').ChatMode}
 */
export function createSlackChatMode({ slack, send, workspaceUrl }) {
  // The first free name from generation n on: Slack answers name_taken for a name in use.
  async function freeName(ticket, n, use) {
    for (let tries = 0; ; tries += 1, n += 1) {
      const name = ticketChannelName(ticket.identifier, ticket.title, n);
      try {
        return { name, generation: n, id: await use(name) };
      } catch (error) {
        if (error.code !== 'name_taken' || tries >= 20) throw error;
      }
    }
  }

  return {
    name: 'slack',
    conversationOf: conversation,
    post: (message) => slack.post(message),
    relay: send,
    // A request channel its ticket now links: renamed after the ticket.
    async onTicket({ state }, { channel, ticket }, bot) {
      const record = (state.channels[channel] ??= { ticket: ticket.identifier, requester: bot[channel]?.requester ?? null });
      const { name, generation } = await freeName(ticket, 1, (n) => slack.rename(channel, n));
      Object.assign(record, { name, generation, renamed: true });
    },
    async close({ state }, { channel }) {
      await slack.archive(channel);
      state.channels[channel].archived = true;
    },
    async reopen({ state, messages, client, writeState }, { channel, ticket }) {
      const old = state.channels[channel];
      const next = (old.successor ??= {});
      if (!next.channel) {
        const created = await freeName(ticket, (old.generation ?? 1) + 1, (n) => slack.create(n));
        Object.assign(next, { channel: created.id, name: created.name, generation: created.generation });
        // Recorded at once: should the link be stored but its reply lost, the plugin still admits it and it is still archived.
        state.channels[created.id] = { ticket: ticket.identifier, requester: old.requester, name: created.name, generation: created.generation, renamed: true, previous: channel };
        await writeState(state);
      }
      if (!next.invited) {
        if (old.requester) await slack.invite(next.channel, old.requester);
        next.invited = true;
        await writeState(state);
      }
      if (!next.posted) {
        const text = `${messages.states[ticket.state] ?? ''}\n\n${fill(messages.reopened, { previous: `<#${channel}>` })}`.trim();
        await slack.post({ channel: next.channel, text });
        next.posted = true;
        state.tickets = { ...state.tickets, [ticket.identifier]: ticket.state };
        await writeState(state);
      }
      const uri = `${workspaceUrl.replace(/\/$/, '')}/archives/${next.channel}`;
      await client.tool('bakers_ticket_transition', { ticket: ticket.id, links: [{ uri, title: 'Slack channel' }] });
      delete old.successor;
      old.reopened = next.channel;
      ticket.conversation = { channel: next.channel, url: uri };
    },
    async expireSilent({ state, messages, now, writeState }, { channel }) {
      const record = (state.channels[channel] ??= {});
      if (!record.closing) {
        const last = await slack.lastMessage(channel);
        if (last && now() - last < WEEK) {
          record.seen = last;
          return;
        }
        await slack.post({ channel, text: messages.abandoned });
        record.closing = true;
        await writeState(state);
      }
      await slack.archive(channel);
      record.archived = true;
    },
  };
}
