// The bot's language in the poller's fixed texts (README › Test it by hand, step 10): the operator
// sets PM_BOT_LANGUAGE in the env file and recreates the bot from the same image; the plugin's
// language module reads it and writes bot-language.json, and the poller's state lines, run start
// and question lead-in follow it, German for anything without texts.
//
// The stack runs no gateway of the bot's (mode agent), so nothing starts the plugin: each scenario
// starts its language module in the container itself (botLanguage). The plugin's Slack side (the
// trusted line, the acknowledgement) needs the gateway in the stack.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { agent, botLanguage, cancel, channel, languageFile, moveTo, pollerState, seed, site, slack, ticketFor, waitFor } from '../lib/stack.mjs';

const messages = JSON.parse(readFileSync(new URL('../../../poller/messages.json', import.meta.url), 'utf8'));

// The stack as run.sh starts it: `de` in the env file and no language file.
after(() => botLanguage('de', { start: false }));

/**
 * A ticket from a request channel through plan into working, where its run asks a question: the
 * channel's posts until the question's lead-in, and the texts `language` gives them.
 */
async function walk(id, title) {
  const ch = channel(id);
  const ticket = await ticketFor(ch, title);
  await moveTo(ticket.identifier, 'plan');
  await waitFor(`the poller posting plan for ${ticket.identifier}`, () => pollerState(ticket.identifier) === 'plan');
  await moveTo(ticket.identifier, 'working');
  await waitFor(`the poller posting working for ${ticket.identifier}`, () => pollerState(ticket.identifier) === 'working');
  agent.script(ticket.identifier, 'question');
  await site.tool('bakers_ticket_update', { ticket: ticket.identifier, conductor: seed.conductor_uuid });
  const question = 'Should members also sign in with a username';
  // A pass relays the question before it posts the run's start: both, in whichever language.
  const starts = Object.values(messages).map((m) => m.runStart.working);
  const posts = await waitFor(`the run start and the question of ${ticket.identifier} in the channel`, async () => {
    const all = await slack.posts(ch.id);
    return all.some((text) => text.includes(question)) && all.some((text) => starts.includes(text)) && all;
  });
  await cancel(ticket.identifier);
  return { ticket, posts };
}

/** The poller's fixed texts of `walk` in `language`, as posted: state lines, run start, question lead-in. */
function assertFixedTexts({ ticket, posts }, language) {
  const m = messages[language];
  for (const text of [m.states.plan, m.states.working, m.runStart.working]) {
    assert.ok(posts.includes(text), `no post ${JSON.stringify(text)} (${language}) among ${JSON.stringify(posts)}`);
  }
  const lead = m.questionLead.replace('{identifier}', ticket.identifier).replace('{title}', ticket.title);
  assert.ok(posts.some((text) => text.startsWith(`${lead}\n\n`)), `no question under ${JSON.stringify(lead)} (${language}) among ${JSON.stringify(posts)}`);
}

test('given PM_BOT_LANGUAGE en, when the bot is recreated and a ticket moves on and asks, then the poller posts in English', async () => {
  const log = await botLanguage('en');
  assert.match(log, /^bot-channels: answering in en$/m);
  assert.deepEqual(languageFile(), { language: 'en' });
  assertFixedTexts(await walk('C0E2E1003', 'Language en'), 'en');
});

test('given PM_BOT_LANGUAGE unset, when the bot is recreated and a ticket moves on and asks, then the poller posts in German', async () => {
  const log = await botLanguage(undefined);
  assert.match(log, /^bot-channels: answering in de$/m);
  assert.deepEqual(languageFile(), { language: 'de' });
  assertFixedTexts(await walk('C0E2E1001', 'Language unset'), 'de');
});

test('given PM_BOT_LANGUAGE de, when the bot is recreated and a ticket moves on and asks, then the poller posts in German', async () => {
  const log = await botLanguage('de');
  assert.match(log, /^bot-channels: answering in de$/m);
  assert.deepEqual(languageFile(), { language: 'de' });
  assertFixedTexts(await walk('C0E2E1002', 'Language de'), 'de');
});

test('given PM_BOT_LANGUAGE fr, a code without texts, when a ticket moves on and asks, then the poller posts in German', async () => {
  const log = await botLanguage('fr');
  assert.match(log, /^bot-channels: answering in fr$/m);
  assert.deepEqual(languageFile(), { language: 'fr' });
  assertFixedTexts(await walk('C0E2E1004', 'Language fr'), 'de');
});

test('given PM_BOT_LANGUAGE English, not a code, when a ticket moves on and asks, then the error is logged and the poller posts in German', async () => {
  const log = await botLanguage('English');
  assert.match(log, /^bot-channels: language: PM_BOT_LANGUAGE "English" is not an ISO 639-1 code; answering in German$/m);
  assert.match(log, /^bot-channels: answering in de$/m);
  assert.deepEqual(languageFile(), { language: 'de' });
  assertFixedTexts(await walk('C0E2E1005', 'Language English'), 'de');
});

test('given an English language file from the previous start, when the bot is recreated with de and the plugin has not started, then the first post is German', async () => {
  await botLanguage('en');
  assert.deepEqual(languageFile(), { language: 'en' });
  await botLanguage('de', { start: false });
  const ch = channel('C0E2E1006');
  const ticket = await ticketFor(ch, 'Language after a stale file');
  await moveTo(ticket.identifier, 'plan');
  const [first] = await waitFor(`the first post for ${ticket.identifier}`, async () => {
    const posts = await slack.posts(ch.id);
    return posts.length > 0 && posts;
  });
  assert.equal(first, messages.de.states.plan);
  await cancel(ticket.identifier);
});
