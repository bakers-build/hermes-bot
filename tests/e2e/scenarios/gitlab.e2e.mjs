// The GitLab side (README.md › The GitLab side): a second bot from the same image, in GitLab mode,
// serves the issues of the stand-in's project e2e/shop. An issue is the request and its notes are
// the conversation; the ticket follows the issue as it follows a channel on Slack.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { handoverScript } from '../lib/handover.mjs';
import { agent, BOB, cancel, compose, gitlab, model, moveTo, never, reopen, scripted, seed, site, waitFor } from '../lib/stack.mjs';

const messages = JSON.parse(readFileSync(new URL('../../../poller/messages.json', import.meta.url), 'utf8')).de;
// The scripted model answers the GitLab bot; --real gives it a model that finds its own words.
const only = { skip: !scripted && 'plays scripted model turns and the stub agent' };

const nextIid = async () => (await gitlab.state()).issues.length + 1;
const hasNote = (iid, text) => waitFor(`a note on issue ${iid} with "${text}"`, async () => (await gitlab.botNotes(iid)).find((n) => n.includes(text)));
const bot = 'pm-bot-gitlab';

/** An issue the bot took in, answered with one line; the ticket created on it without the model. */
async function ticketOnIssue(title) {
  const iid = await nextIid();
  await model.script([{ user: title, reply: [{ text: 'I am looking at it.' }] }]);
  await gitlab.issue(title);
  await hasNote(iid, 'I am looking at it.');
  const created = await site.tool('bakers_ticket_create', { title, workflow: seed.workflow, project: seed.project_uuid, description: `${title}.` });
  await site.tool('bakers_ticket_transition', { ticket: created.identifier, links: [{ uri: gitlab.issueUrl(iid), title: 'GitLab issue' }] });
  await waitFor(`the GitLab poller following ${created.identifier}`, () => gitlab.pollerState(created.identifier) !== undefined);
  return { iid, ticket: created };
}

before(async () => {
  await gitlab.users();
  // The bot registered its webhook on start.
  await waitFor('the GitLab bot\'s webhook', async () => (await gitlab.state()).hooks.length === 1, { timeout: 300_000 });
});

test('given GitLab mode, when an issue is opened and its author says yes, then the ticket exists on the issue and the issue names it', only, async () => {
  const iid = await nextIid();
  const title = 'Member login from GitLab';
  await model.script(handoverScript({ ch: { link: gitlab.issueUrl(iid) }, title, linkTitle: 'GitLab issue' }));
  await gitlab.issue('We need a login page for members', { description: `${title}.` });
  await hasNote(iid, '@alice Danke, ich habe deine Anfrage erhalten');
  await hasNote(iid, 'Who signs in, and with what?');
  await gitlab.note(iid, 'yes, hand it over as it is');
  await hasNote(iid, 'Handed over as');
  // Every turn was the requester's: the bot's own notes, which GitLab delivers too, started none.
  assert.deepEqual(await model.unmatched(), []);
  const [found] = (await site.tool('bakers_ticket_search', { query: title, project: seed.project_uuid })).tickets ?? [];
  const ticket = await site.ticket(found.identifier);
  assert.ok(ticket.links.some((l) => l.uri === gitlab.issueUrl(iid) && l.title === 'GitLab issue'), 'the ticket does not link its issue');
  assert.ok(ticket.labels.includes('human-accept') && ticket.labels.includes('ticket-question'), `labels are ${ticket.labels}`);
  assert.ok((ticket.reviewers ?? []).length === 1, 'the requester is not the reviewer');
  assert.equal(ticket.conductor, seed.conductor_uuid);
  await hasNote(iid, `${messages.ticketNote} [${ticket.identifier} · ${ticket.title}](${ticket.url})`);
  // Eyes came and went on the requester's messages.
  const awards = (await gitlab.calls()).filter((c) => c.path.includes('/award_emoji'));
  assert.ok(awards.some((c) => c.method === 'POST') && awards.some((c) => c.method === 'DELETE'), 'no eyes while the bot worked');
  const issue = (await gitlab.state()).issues.find((i) => i.iid === iid);
  assert.deepEqual([...issue.awards, ...issue.notes.flatMap((n) => n.awards)], [], 'eyes stayed after the bot answered');
  await cancel(ticket.identifier);
});

test('given a ticket on its issue, when it moves on, is done and is reopened, then one note each, the issue closes and reopens', only, async () => {
  const { iid, ticket } = await ticketOnIssue('Status notes on the issue');
  await hasNote(iid, messages.ticketNote);
  await moveTo(ticket.identifier, 'plan', 'working');
  await waitFor('working posted', () => gitlab.pollerState(ticket.identifier) === 'working');
  await hasNote(iid, messages.states.working);
  await moveTo(ticket.identifier, 'review', 'done');
  await waitFor('the issue closed', async () => (await gitlab.issueState(iid)) === 'closed');
  const notes = await gitlab.botNotes(iid);
  assert.match(notes.at(-1), /^Das ist fertig und bereit zum Ausprobieren\./, 'the issue was closed before its final note');
  for (const state of ['working', 'done']) assert.equal(notes.filter((n) => n.startsWith(messages.states[state])).length, 1, `${state} noted more than once`);

  await reopen(ticket.identifier);
  await waitFor('the issue reopened', async () => (await gitlab.issueState(iid)) === 'opened');
  await waitFor('working noted again', async () => (await gitlab.botNotes(iid)).filter((n) => n.startsWith(messages.states.working)).length === 2);
  assert.deepEqual((await site.ticket(ticket.identifier)).links.filter((l) => l.title === 'GitLab issue').length, 1, 'the reopened ticket got a second link');
  await cancel(ticket.identifier);
});

test('given a run that asked a question, when a participant answers in a note, then the answer is on the ticket naming them', only, async () => {
  const { iid, ticket } = await ticketOnIssue('Ask in the issue before building');
  agent.script(ticket.identifier, 'question');
  await moveTo(ticket.identifier, 'plan', 'working');
  await site.tool('bakers_ticket_update', { ticket: ticket.identifier, conductor: seed.conductor_uuid });
  await waitFor(`${ticket.identifier} frozen with Question`, async () => (await site.ticket(ticket.identifier)).frozen);
  await hasNote(iid, 'Should members also sign in with a username');
  const heading = `Answered in GitLab by ${BOB.name} (GitLab user ${BOB.username}):`;
  await model.script([
    { user: 'e-mail address', reply: [{ tool: 'bakers_ticket_read', input: { ticket: ticket.identifier } }] },
    { tool_result: '"frozen":\\s*true', after: 'bakers_ticket_read', reply: [{ tool: 'bakers_comment_create', input: { ticket: ticket.identifier, type: 'comment', body: `${heading}\n\nOnly with the e-mail address.` } }] },
    { tool_result: '.', after: 'bakers_comment_create', reply: [{ tool: 'bakers_ticket_update', input: { ticket: ticket.identifier, labels_remove: ['Question'], frozen: false } }] },
    { tool_result: '.', after: 'bakers_ticket_update', reply: [{ text: 'Thanks, the work goes on.' }] },
  ]);
  await gitlab.note(iid, 'Only with the e-mail address, no username.', BOB);
  await hasNote(iid, 'Thanks, the work goes on.');
  assert.deepEqual(await model.unmatched(), []);
  // The answering turn knew who answered: the sender's prefix names the GitLab user.
  const turn = (await model.log()).find((t) => t.kind === 'user' && t.text.includes('e-mail address'));
  assert.match(turn.text, /GitLab user @bob/);
  const answered = await site.ticket(ticket.identifier);
  assert.ok(answered.comments.some((c) => c.body.startsWith(heading)), 'the answer is not on the ticket');
  assert.equal(answered.frozen, false);
  await cancel(ticket.identifier);
});

test('given deliveries the bot must refuse, when they arrive, then nothing happens on the issue or the model', only, async () => {
  await model.script([]);
  const wrong = await nextIid();
  await gitlab.issue('A request with the wrong secret', { token: 'guess' });
  await gitlab.issue('A request from another project', { project: 'e2e/other' });
  const { deliveries } = await gitlab.state();
  assert.equal(deliveries.at(-2).status, 401, 'a delivery without the hook\'s secret was accepted');
  await never('a note or a turn for a refused delivery', async () => {
    const notes = [...(await gitlab.botNotes(wrong)), ...(await gitlab.botNotes(wrong + 1))];
    const turns = await model.log();
    return (notes.length || turns.length) && { notes, turns: turns.length };
  }, { ms: 10_000 });
});

test('given the bot restarts, when a note came while it was down, then it is answered once and the webhook is not doubled', only, async () => {
  const { iid, ticket } = await ticketOnIssue('Catch up after a restart');
  await compose(['stop', bot]);
  await gitlab.note(iid, 'Missed while you were away?');
  await model.script([{ user: 'Missed while you were away', reply: [{ text: 'Caught up.' }] }]);
  await compose(['start', bot]);
  await hasNote(iid, 'Caught up.');
  await never('a second answer', async () => (await gitlab.botNotes(iid)).filter((n) => n === 'Caught up.').length > 1, { ms: 10_000 });
  const { hooks } = await gitlab.state();
  assert.equal(hooks.length, 1, `${hooks.length} hooks after the restart`);
  assert.ok((await gitlab.calls()).some((c) => c.method === 'PUT' && c.path.endsWith(`/hooks/${hooks[0].id}`)), 'the hook was not updated on start');
  await cancel(ticket.identifier);
});
