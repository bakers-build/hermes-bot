// The nightly Composer audit (README › The nightly Composer audit): the cron job composer-audit
// audits the freshly pulled clone with its skill, opens one security chore for its advisories and
// comments on that ticket while it is open; a stale clone is not audited. The job runs as its
// schedule runs it, `hermes cron run composer-audit` in the bot's container: its own toolsets, its
// shell's deny list, Composer against the fixture's advisory repository, bakers.build's tools.
//
// Scripted, the model plays the skill's steps with the skill's own commands; every value it writes
// (package, installed version, advisory, ticket, channel) comes from the real tool results.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audit, cancel, model, scripted, seed, site, slack } from '../lib/stack.mjs';

const TITLE = 'Security updates: 1 Composer advisories';
const SKILL_COMMANDS = {
  marker: 'cat /opt/data/clone-pulled.json',
  language: 'cat /opt/data/bot-language.json',
  date: 'date -u +%Y-%m-%dT%H:%M:%SZ',
  find: "find . \\( -name composer.lock -o -name composer.json \\) -not -path '*/.git/*' -not -path '*/vendor/*' -not -path '*/node_modules/*'",
  audit: 'composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore --working-dir=.',
  installed: `grep -A1 '"name": "{{package}}",' ./composer.lock`,
};
const sh = (command) => ({ tool: 'terminal', input: { command } });

const TABLE = [
  '### ./composer.lock',
  '',
  '| package | installed | fixed in | severity | CVE/link |',
  '|---|---|---|---|---|',
  '| {{package}} | {{installed}} | {{fixed}} | {{severity}} | [{{cve}}]({{link}}) |',
  '',
  '`composer update {{package}} --with-dependencies`',
].join('\n');

// The skill's steps 1-3, up to the search for the open audit ticket: a fresh marker, one lock, one advisory.
const auditedUpToSearch = [
  { user: 'Composer security audit', reply: [sh(SKILL_COMMANDS.marker), sh(SKILL_COMMANDS.language), sh(SKILL_COMMANDS.date)] },
  { tool_result: '"ok":\\s*true', after: 'terminal', reply: [sh(SKILL_COMMANDS.find)] },
  { tool_result: '\\./composer\\.lock', after: 'terminal', reply: [sh(SKILL_COMMANDS.audit)] },
  {
    tool_result: '"advisoryId":\\s*"(?<advisory>[^"]+)",\\s*"packageName":\\s*"(?<package>[^"]+)",\\s*"affectedVersions":\\s*"[^"]*<(?<fixed>[^"]+)"[\\s\\S]*?"cve":\\s*"(?<cve>[^"]+)",\\s*"link":\\s*"(?<link>[^"]+)"[\\s\\S]*?"severity":\\s*"(?<severity>[^"]+)"',
    after: 'terminal',
    reply: [sh(SKILL_COMMANDS.installed)],
  },
  { tool_result: '"version":\\s*"(?<installed>[^"]+)"', after: 'terminal', reply: [{ tool: 'bakers_ticket_search', input: { query: 'Security updates:', project: seed.project_uuid } }] },
];

// The open audit tickets, as the skill finds them.
const searchResults = async () =>
  (await site.tool('bakers_ticket_search', { query: 'Security updates:', project: seed.project_uuid })).tickets
    .filter((t) => t.title.startsWith('Security updates:') && !['done', 'cancelled'].includes(t.state));

let opened;

test('given a fresh clone with a vulnerable package, when the nightly audit runs, then it opens one security chore with the table', async () => {
  audit.pulled({ hoursAgo: 1 });
  if (scripted) {
    await model.script([
      ...auditedUpToSearch,
      {
        // No audit ticket outside done and cancelled.
        tool_result: '^(?![\\s\\S]*"title":\\s*"Security updates:[^"]*",\\s*"state":\\s*"(?!done"|cancelled")[a-z_]+")[\\s\\S]*tickets found',
        after: 'bakers_ticket_search',
        reply: [{
          tool: 'bakers_ticket_create',
          input: {
            project: seed.project_uuid, workflow: seed.workflow, type: 'chore', title: `${TITLE} ({{package}})`,
            description: `The nightly Composer audit found these advisories in the clone at e2e0000.\n\n${TABLE}`,
          },
        }],
      },
      { tool_result: '"identifier":\\s*"(?<ticket>[A-Z0-9]+-\\d+)"', after: 'bakers_ticket_create', reply: [{ tool: 'bakers_conductor_list', input: { project: seed.project_uuid } }] },
      { tool_result: seed.conductor_uuid, after: 'bakers_conductor_list', reply: [{ tool: 'bakers_ticket_update', input: { ticket: '{{ticket}}', labels_add: ['security'], conductor: seed.conductor_uuid } }] },
      { tool_result: '.', after: 'bakers_ticket_update', reply: [{ tool: 'open_request_channel', input: { title: `${TITLE} ({{package}})` } }] },
      {
        tool_result: '"channel":\\s*"(?<channel>\\w+)"[\\s\\S]*"link":\\s*"(?<link>[^"]+)"',
        after: 'open_request_channel',
        reply: [{ tool: 'bakers_ticket_transition', input: { ticket: '{{ticket}}', links: [{ uri: '{{link}}', title: 'Slack channel' }] } }],
      },
      { tool_result: '.', after: 'bakers_ticket_transition', reply: [{ text: `{{ticket}} · ${TITLE} ({{package}}): 1 advisory, in <#{{channel}}>.` }] },
    ]);
  }
  const answer = await audit.run();
  if (scripted) assert.deepEqual(await model.unmatched(), []);
  assert.ok((await audit.calls()).some((c) => c.packages.includes('acme/widget')), 'Composer did not ask the advisory repository about acme/widget');

  const found = await searchResults();
  assert.equal(found.length, 1, `not one audit ticket: ${JSON.stringify(found)}`);
  opened = await site.ticket(found[0].identifier);
  assert.equal(opened.type, 'chore');
  assert.deepEqual(opened.labels, ['security']);
  assert.equal(opened.title, `${TITLE} (acme/widget)`);
  assert.match(opened.description, /\| acme\/widget \| 1\.0\.0 \| 1\.2\.3 \| high \| \[CVE-2026-0001\]\(https:\/\/advisories\.e2e\.test\/PKSA-e2e0-0000-0001\) \|/);
  assert.match(opened.description, /composer update acme\/widget --with-dependencies/);
  assert.ok(!['done', 'cancelled'].includes(opened.state), `the audit ticket is ${opened.state}`);
  const channelLink = opened.links.find((l) => l.title === 'Slack channel');
  assert.ok(channelLink, 'the audit ticket has no Slack channel link');
  const created = await slack.of('conversations.create');
  assert.ok(created.some((c) => c.body.name?.startsWith('req-security-updates')), 'no request channel was opened');
  assert.match(answer, new RegExp(opened.identifier));
});

test('given an open audit ticket, when the next night finds the advisory again, then it comments on that ticket and opens no second one', async () => {
  assert.ok(opened, 'the first night opened no ticket');
  audit.pulled({ hoursAgo: 1 });
  const before = (await site.ticket(opened.identifier)).comments.length;
  if (scripted) {
    await model.script([
      ...auditedUpToSearch,
      {
        tool_result: `"identifier":\\s*"(?<ticket>${opened.identifier})"`,
        after: 'bakers_ticket_search',
        reply: [{ tool: 'bakers_comment_create', input: { ticket: '{{ticket}}', type: 'comment', body: `${new Date().toISOString().slice(0, 10)}: ${TITLE} ({{package}})\n\n${TABLE}` } }],
      },
      { tool_result: '.', after: 'bakers_comment_create', reply: [{ text: '1 advisory still open in {{ticket}}.' }] },
    ]);
  }
  await audit.run();
  if (scripted) assert.deepEqual(await model.unmatched(), []);
  assert.equal((await searchResults()).length, 1, 'a second audit ticket was opened');
  const after = await site.ticket(opened.identifier);
  const added = after.comments.slice(before);
  assert.equal(added.length, 1, `not one new comment: ${added.length}`);
  assert.match(added[0].body, /\| acme\/widget \| 1\.0\.0 \| 1\.2\.3 \| high \|/);
});

test('given a pull marker older than 24 hours, when the nightly audit runs, then it writes nothing and its answer says why', async () => {
  assert.ok(opened, 'the first night opened no ticket');
  const { at } = audit.pulled({ hoursAgo: 30 });
  const before = (await site.ticket(opened.identifier)).comments.length;
  const asked = (await audit.calls()).length;
  if (scripted) {
    await model.script([
      { user: 'Composer security audit', reply: [sh(SKILL_COMMANDS.marker), sh(SKILL_COMMANDS.language), sh(SKILL_COMMANDS.date)] },
      { tool_result: `"at":\\s*"(?<at>${at})"`, after: 'terminal', reply: [{ text: 'Composer audit skipped: no pull in the last 24 hours (last pull {{at}}).\n[SILENT]' }] },
    ]);
  }
  const answer = await audit.run();
  if (scripted) assert.deepEqual(await model.unmatched(), []);
  assert.match(answer, /Composer audit skipped: no pull in the last 24 hours/);
  assert.equal((await audit.calls()).length, asked, 'Composer was run on a stale clone');
  assert.equal((await searchResults()).length, 1, 'a ticket was opened on a stale clone');
  assert.equal((await site.ticket(opened.identifier)).comments.length, before, 'a comment was written on a stale clone');
  await cancel(opened.identifier);
});
