// The poller's GitLab side (README.md › The GitLab side): a ticket's conversation is the issue of
// GITLAB_PROJECT it links, and every post is a note on it. On the ticket's arrival the issue gets a
// note naming it; after the final post the issue is closed, and reopened with the ticket; an issue
// the bot answered that stayed silent for a week without a ticket gets a last note and is closed.
// The poller calls only the issues and notes of the one project.

import { WEEK } from '../channels.mjs';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The ticket's issue: its NEWEST link titled *GitLab issue* (the persona's title) to an issue of
 * the project; other links to the project's issues are cross-references, as non-`chat` links in Slack.
 *
 * @param {Array<{uri: string, title?: string}>} links the ticket's `links` field
 * @param {{url: string, project: string}} gitlab GITLAB_URL and GITLAB_PROJECT (the project's path)
 * @returns {{channel: string, url: string} | null} channel: the issue's IID
 */
export function conversation(links, { url, project }) {
  const pattern = new RegExp(`^${escapeRegExp(`${url.replace(/\/$/, '')}/${project}`)}/-/issues/(\\d+)(?:[?#].*)?$`);
  const found = (links ?? []).filter((l) => l.title === 'GitLab issue').map((l) => [l, String(l.uri).match(pattern)]).filter(([, m]) => m).pop();
  return found ? { channel: found[1][1], url: found[0].uri } : null;
}

// The poller's texts are written in Slack's markup; a note is Markdown. `<url|title>` becomes a
// Markdown link, `<url>` stays an autolink, and Slack's escapes render as the characters in GitLab.
export const markdown = (text) => text.replace(/<(https?:\/\/[^|>\s]+)\|([^>]*)>/g, (_, url, title) => `[${title.replace(/[[\]]/g, '\\$&')}](${url})`);

/** The GitLab REST calls the poller makes, on the issues of one project. */
export function createGitLab({ url, project, token }) {
  const root = url.replace(/\/$/, '');
  const issues = `${root}/api/v4/projects/${encodeURIComponent(project)}/issues`;
  async function call(method, path, body) {
    const res = await fetch(`${issues}/${path}`, {
      method,
      headers: { 'private-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} issues/${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  return {
    url: root,
    project,
    note: (iid, body) => call('POST', `${iid}/notes`, { body }),
    // close or reopen
    setState: (iid, event) => call('PUT', `${iid}`, { state_event: event }),
    // The newest note's time in epoch milliseconds, else the issue's creation.
    lastActivity: async (iid) => {
      const [latest] = await call('GET', `${iid}/notes?sort=desc&order_by=created_at&per_page=1`);
      return Date.parse(latest?.created_at ?? (await call('GET', `${iid}`)).created_at);
    },
  };
}

/**
 * The GitLab side of the poller's side contract (poller/sides/slack.mjs has the Slack one).
 *
 * @param {{gitlab: ReturnType<typeof createGitLab>}} options
 */
export function createGitLabSide({ gitlab }) {
  const post = ({ channel, text }) => gitlab.note(channel, markdown(text));
  return {
    name: 'gitlab',
    conversationOf: (links) => conversation(links, gitlab),
    post,
    // Questions and technical problems are notes like any post; the agent reads the ticket when someone answers.
    relay: post,
    // An issue the bot answered, now linked by its ticket: a note naming the ticket.
    async onTicket({ state, messages }, { channel, ticket }, bot) {
      const record = (state.channels[channel] ??= { ticket: ticket.identifier, requester: bot[channel]?.requester ?? null });
      const link = ticket.url ? ` [${ticket.identifier} · ${ticket.title}](${ticket.url})` : ` ${ticket.identifier}`;
      await gitlab.note(channel, `${messages.ticketNote}${link}`);
      record.renamed = true;
    },
    async close({ state }, { channel }) {
      await gitlab.setState(channel, 'close');
      state.channels[channel].archived = true;
    },
    // The same issue again: reopened, with the ticket's state as its next note.
    async reopen({ state, messages, writeState }, { channel, ticket }) {
      const record = state.channels[channel];
      await gitlab.setState(channel, 'reopen');
      if (record.reopenedAt !== ticket.state) {
        const text = messages.states[ticket.state];
        if (text) await post({ channel, text });
        record.reopenedAt = ticket.state;
        state.tickets = { ...state.tickets, [ticket.identifier]: ticket.state };
        await writeState(state);
      }
      Object.assign(record, { archived: false, final: false });
      delete record.reopenedAt;
    },
    async expireSilent({ state, messages, now, writeState }, { channel }) {
      const record = (state.channels[channel] ??= {});
      if (!record.closing) {
        const last = await gitlab.lastActivity(channel);
        if (last && now() - last < WEEK) {
          record.seen = last;
          return;
        }
        await gitlab.note(channel, messages.abandonedIssue);
        record.closing = true;
        await writeState(state);
      }
      await gitlab.setState(channel, 'close');
      record.archived = true;
    },
  };
}
