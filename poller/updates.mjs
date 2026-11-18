// Pure core of the poller's status updates between two states: a run starting or ending, a
// new summary with the links of its Manual review on a preview zone host, a preview link, and a
// heartbeat while a run works in a quiet conversation. No I/O.

import { withTicket } from './ticket-footer.mjs';
import { named, section, target } from './diff.mjs';
import { escape, QUESTION_LABEL, TECHNICAL_PROBLEM_LABEL } from './questions.mjs';

const ENDED = ['done', 'failed', 'expired', 'cancelled'];

// Run starts closer together than this collapse into the first one's line.
const COLLAPSE = 5 * 60 * 1000;

// Words of the tool, not of the requester: code, where agents put state, type and comment-type
// names; ticket and AC identifiers; run IDs; recipe and agent names. Everyday words such as
// "review" or "done" stay, as they mean the same to the requester.
const INTERNAL = [
  /`|\b[A-Z][A-Z0-9]*-\d+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  /\b(?:qualification|matt|superpowers|deploy-and-release|opus|sonnet|haiku|fable|claude|codex)\b/i,
];

/**
 * The plain sentences among the first two of a summary's Outcome section, escaped for Slack;
 * empty when it has none.
 */
export function outcome(markdown) {
  const lines = (markdown ?? '').split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s.*outcome/i.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  const text = lines.slice(start + 1, end < 0 ? undefined : end).map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')).join(' ').trim();
  return text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .filter((s) => s && !INTERNAL.some((r) => r.test(s)))
    .map((s) => escape(s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|(?<!\w)[*_]|[*_](?!\w)/g, '').trim()));
}

// A link of kind `design` or `ddev`. The tools return links without their stored kind, so it is
// derived from the URI in the order bb_core's LinkKind::fromUri uses.
function preview(uri) {
  if (/\/-\/merge_requests\/|\/artifacts\/|playwright-report/.test(uri)) return false;
  if (uri.includes('designbook')) return true;
  return !/\/-\/(pipelines|jobs|tree|commits|branches)|\.slack\.com\/archives\//.test(uri) && uri.includes('.ddev.site');
}

/** The DNS zones of PREVIEW_ZONES (a comma list) under which a summary's links are previews. */
export const previewZones = (value) =>
  (value ?? '')
    .split(',')
    .map((z) => z.trim().toLowerCase())
    .filter(Boolean);

// A host one DNS label under a zone, written exactly so: no credentials, no port.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const onZone = (url, zones) => {
  const authority = /^https:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(url)?.[1].toLowerCase();
  if (!authority || !URL.canParse(url)) return false;
  return zones.some((zone) => authority.endsWith(`.${zone}`) && new RegExp(`^${LABEL}$`).test(authority.slice(0, -zone.length - 1)));
};

/**
 * The links of a summary's Manual review section on a host under one of `zones`, each URL once:
 * Markdown links with their text (dropped when it holds internal words), `<url>` and bare URLs
 * without. Code is skipped. Agent text is untrusted, so no other URL ever leaves this function.
 */
export function previewLinks(markdown, zones) {
  if (!zones.length) return [];
  const found = new Map();
  let inCode = false;
  for (const line of section(markdown ?? '', /manual review/i)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const text = line.replace(/`[^`]*`/g, ' ');
    for (const m of text.matchAll(/\[([^\]]*)\]\(\s*([^)\s]+)\s*\)|<(https:\/\/[^>\s]+)>|(https:\/\/[^\s<>()\[\]]+)/gi)) {
      const url = m[2] ?? m[3] ?? m[4].replace(/[.,;:!?)]+$/, '');
      if (found.has(url) || !onZone(url, zones)) continue;
      const label = (m[1] ?? '').replace(/\*\*|__|(?<!\w)[*_]|[*_](?!\w)/g, '').trim();
      found.set(url, INTERNAL.some((r) => r.test(label)) ? '' : escape(label));
    }
  }
  return [...found].map(([url, text]) => ({ url, text }));
}

const boxOnly = (uri) => URL.canParse(uri) && new URL(uri).hostname.endsWith('.ddev.site');

const key = ({ channel, thread_ts }) => (thread_ts ? `${channel}:${thread_ts}` : channel);

const recordOf = (t, zones) => ({
  runs: Object.fromEntries(t.runs.map((r) => [r.uuid, r.state])),
  summaries: t.comments.filter((c) => c.type === 'summary').map((c) => c.id),
  links: t.links.map((l) => l.uri),
  lastStart: null,
  pending: {},
  // Summaries from before the poller followed the ticket count as posted.
  ...(zones.length && { previews: Object.fromEntries(t.comments.filter((c) => c.type === 'summary').map((c) => [c.id, previewLinks(c.body, zones).map((l) => l.url)])) }),
});

/**
 * @param {{previous: Record<string, {runs: Record<string, string>, summaries: string[], links: string[], lastStart: number | null, pending?: Record<string, string>}>,
 *   posted: Record<string, number>, tickets: Array<{identifier: string, state: string, labels: string[], frozen?: boolean,
 *   conversation: {channel: string, thread_ts?: string}, inherited?: boolean, links: Array<{uri: string, title: string}>,
 *   runs: Array<{uuid: string, state: string, state_at_start: string, started_at: number | null}>,
 *   comments: Array<{id: string, type: string, created: string, body: string}>}>,
 *   now: number, interval: number, messages: any, zones?: string[]}} input
 *   previous: identifier → what was seen of the ticket, with `previews`: summary ID → its posted preview URLs,
 *     and `pending`: run UUID → its state before it ended without done, for the paused line the next pass decides;
 *   posted: conversation → the poller's last post there, in ms;
 *   tickets: the followed open tickets that were read in this pass;
 *   zones: the PREVIEW_ZONES; none posts no summary link and adds no note to a ddev link
 * @returns {{posts: Array<{identifier: string, channel: string, thread_ts?: string, text: string}>,
 *   next: {records: Record<string, any>, posted: Record<string, number>}}}
 */
export function updates({ previous, posted, tickets, now, interval, messages, zones = [] }) {
  const records = {};
  const nextPosted = { ...posted };
  const posts = [];
  for (const t of tickets) {
    nextPosted[key(t.conversation)] ??= now;
    const before = previous[t.identifier];
    if (!before) {
      records[t.identifier] = recordOf(t, zones);
      continue;
    }
    // A record from before the pending paused lines has none.
    const record = (records[t.identifier] = { ...before, runs: { ...before.runs }, summaries: [...before.summaries], links: [...before.links], pending: { ...before.pending } });
    // A record from before PREVIEW_ZONES keys no summary, so its old summaries post no links.
    if (zones.length || before.previews) record.previews = Object.fromEntries(Object.entries(before.previews ?? {}).map(([id, urls]) => [id, [...urls]]));
    // Each post names what it marked as seen, so a failed post can be forgotten and retried.
    const post = (text, undo) => posts.push({ identifier: t.identifier, ...target(t.conversation), text: named(t, text), ...undo });
    const runs = [...t.runs].reverse();
    const open = t.labels.includes(QUESTION_LABEL) || t.labels.includes(TECHNICAL_PROBLEM_LABEL);
    // A frozen ticket waits for an answer or for keytec: a run that ended there without done is no problem.
    const paused = (r) => r.state_at_start === t.state && !open && !t.frozen;
    // A run that ended without done a pass ago, on a ticket still open, unfrozen and in its state: now it is a problem.
    for (const [uuid, was] of Object.entries(record.pending)) {
      delete record.pending[uuid];
      const r = t.runs.find((r) => r.uuid === uuid);
      if (r && paused(r)) post(withTicket(messages.runPaused, t, messages), { pending: [uuid, was] });
    }
    const end = (r, was) => {
      record.runs[r.uuid] = r.state;
      // A run that moved the ticket on is told by its state line; an open question or technical problem by its relayed note.
      if (r.state_at_start !== t.state || open) return;
      if (r.state === 'done') post(messages.runWaiting, { run: [r.uuid, was] });
      // Its label or freeze may reach the ticket a moment after the run ends, so the next pass decides.
      else if (paused(r)) record.pending[r.uuid] = was;
    };
    // Only a run seen before ending; one first seen closed gets both its lines below.
    for (const r of runs.filter((r) => r.uuid in before.runs && ENDED.includes(r.state) && !ENDED.includes(before.runs[r.uuid]))) end(r, before.runs[r.uuid]);
    for (const c of t.comments.filter((c) => c.type === 'summary')) {
      if (!before.summaries.includes(c.id)) {
        record.summaries.push(c.id);
        const sentences = outcome(c.body);
        if (sentences.length) post(sentences.join(' '), { summary: c.id });
        if (zones.length) record.previews[c.id] ??= [];
      }
      // A keyed summary's preview links not posted yet, right after its Outcome sentences.
      if (!zones.length || !record.previews[c.id]) continue;
      for (const l of previewLinks(c.body, zones).filter((l) => !record.previews[c.id].includes(l.url))) {
        record.previews[c.id].push(l.url);
        post(`${messages.previewLead} ${l.text}`.trim() + `\n${escape(l.url)}`, { preview: [c.id, l.url] });
      }
    }
    for (const l of t.links.filter((l) => !before.links.includes(l.uri))) {
      record.links.push(l.uri);
      const title = INTERNAL.some((r) => r.test(l.title ?? '')) ? '' : escape(l.title ?? '');
      if (!preview(l.uri)) continue;
      // A ddev site opens only on the box: left out beside a preview link of this pass, else marked so.
      const box = zones.length && boxOnly(l.uri);
      if (box && posts.some((p) => p.identifier === t.identifier && p.preview)) continue;
      post(`${messages.previewLead} ${title}`.trim() + `\n${escape(l.uri)}` + (box ? `\n${messages.previewBoxOnly}` : ''), { link: l.uri });
    }
    for (const r of runs) {
      if (r.uuid in record.runs) continue;
      record.runs[r.uuid] = r.state;
      const text = messages.runStart[r.state_at_start];
      if (text && (record.lastStart === null || now - record.lastStart >= COLLAPSE)) {
        post(text, { run: [r.uuid, undefined], lastStart: record.lastStart });
        record.lastStart = now;
      }
      // Started and ended between two passes, as during an outage: its end line follows.
      if (ENDED.includes(r.state)) end(r, 'running');
    }
  }
  // One heartbeat per quiet conversation, after every other post of the pass.
  const busy = new Set(posts.map(key));
  for (const t of tickets) {
    const at = key(t.conversation);
    const running = t.runs.find((r) => r.state === 'running');
    if (!running || !['working', 'review'].includes(t.state) || busy.has(at) || now - nextPosted[at] < interval) continue;
    busy.add(at);
    const since = (running.started_at ?? 0) * 1000;
    const newest = t.comments.filter((c) => c.type === 'summary' && Date.parse(c.created) >= since).sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
    const [sentence] = newest ? outcome(newest.body) : [];
    posts.push({ identifier: t.identifier, ...target(t.conversation), text: named(t, sentence ? `${messages.stillWorking} ${sentence}` : messages.stillWorking), heartbeat: true });
  }
  return { posts, next: { records, posted: nextPosted } };
}

/** Undoes what a post marked as seen in `records`, after Slack refused it, so the next pass retries it. */
export function forget(records, post) {
  const record = records[post.identifier];
  if (post.run) {
    if (post.run[1] === undefined) {
      delete record.runs[post.run[0]];
      // Its end is seen again with it.
      delete record.pending[post.run[0]];
    }
    // A run whose refused start line was forgotten already is retried whole.
    else if (post.run[0] in record.runs) record.runs[post.run[0]] = post.run[1];
  }
  if (post.pending) record.pending[post.pending[0]] = post.pending[1];
  if ('lastStart' in post) record.lastStart = post.lastStart;
  if (post.summary) record.summaries = record.summaries.filter((id) => id !== post.summary);
  if (post.link) record.links = record.links.filter((uri) => uri !== post.link);
  if (post.preview) record.previews[post.preview[0]] = record.previews[post.preview[0]].filter((url) => url !== post.preview[1]);
}
