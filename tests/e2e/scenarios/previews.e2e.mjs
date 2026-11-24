// Preview links (README › Status updates): with PREVIEW_ZONES=preview.e2e.test (pm-bot.env), a
// summary's Manual review links on a zone host are posted once each and no other URL of the summary
// leaves; a ddev site link is posted with the note that it opens only on the development box.

import { test } from 'node:test';
import { cancel, channel, moveTo, never, pollerState, says, site, slack, ticketFor, waitFor } from '../lib/stack.mjs';

const SUMMARY = `### 🎯 Outcome

The member page has a new layout.

### 🧪 Manual review

- Open [the member page](https://members.preview.e2e.test/page) and compare it with the design.
- The same page once more: https://members.preview.e2e.test/page
- Not on the zone: https://elsewhere.example.com/page
- In code: \`https://code.preview.e2e.test/page\`

### Notes

The old layout is still on https://notes.preview.e2e.test/old.
`;

const working = async (ch, title) => {
  const ticket = await ticketFor(ch, title);
  await moveTo(ticket.identifier, 'plan', 'working');
  await waitFor('the working post', () => pollerState(ticket.identifier) === 'working');
  return ticket;
};

test('given a summary with Manual review links, when it is written, then each zone-host link is posted once and no other URL of it', async () => {
  const ch = channel('C0E2E0701');
  const ticket = await working(ch, 'Show me the new member page');
  await site.tool('bakers_comment_create', { ticket: ticket.identifier, type: 'summary', body: SUMMARY });
  const url = 'https://members.preview.e2e.test/page';
  const previews = async () => (await slack.posts(ch.id)).filter((text) => says(text, 'previewLead'));
  await waitFor('the preview link', async () => (await previews()).some((text) => text.includes(url) && text.includes('the member page')));
  await never('a second preview or another URL of the summary', async () => {
    const posts = await slack.posts(ch.id);
    const leaked = posts.filter((text) => /elsewhere\.example\.com|code\.preview\.e2e\.test|notes\.preview\.e2e\.test/.test(text));
    const twice = posts.filter((text) => text.includes(url)).length > 1;
    return (leaked.length || twice) && posts;
  }, { ms: 8_000 });
  await cancel(ticket.identifier);
});

test('given a ticket, when a ddev site link is added, then it is posted with the note that it opens only on the box', async () => {
  const ch = channel('C0E2E0702');
  const ticket = await working(ch, 'Show me the box site');
  const uri = 'https://e2e-members.ddev.site';
  await site.tool('bakers_ticket_transition', { ticket: ticket.identifier, links: [{ uri, title: 'Preview site' }] });
  const posted = async () => (await slack.posts(ch.id)).filter((text) => text.includes(uri));
  await waitFor('the ddev link with its note', async () => (await posted()).some((text) => says(text, 'previewLead') && says(text, 'previewBoxOnly')));
  await never('a second post of the ddev link', async () => (await posted()).length > 1 && (await posted()), { ms: 6_000 });
  await cancel(ticket.identifier);
});
