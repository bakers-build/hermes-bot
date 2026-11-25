---
name: composer-audit
description: The nightly Composer security audit of the project's clone. Use only in the cron job composer-audit, never in Slack.
---

# Nightly Composer audit

You run unattended, once a night. Your final answer goes into the project's main channel as written, so it is one line, or a line followed by `[SILENT]` when the channel should hear nothing.

Your shell starts in the project's read-only clone. Run each command below as written, filling in only the `<dir>` and `<package>` it names. Every advisory detail reaches bakers.build through your tools, never through a shell command. Keep nothing between nights: the open audit ticket is the only memory.

## 1. Is the clone fresh?

Run `cat /opt/data/clone-pulled.json` (the box's pull marker `{ "at", "head", "ok", "error" }`), `cat /opt/data/bot-language.json` and `date -u +%Y-%m-%dT%H:%M:%SZ`.

The clone is fresh when the marker has `"ok": true` and its `at` is at most 24 hours before the date. Otherwise answer the reason as the first line and `[SILENT]` as the last, and stop:

- no marker file: `Composer audit skipped: no pull marker, so the clone may be stale.`
- `"ok": false`: `Composer audit skipped: the last pull failed:` and its `error` quoted.
- `at` older than 24 hours or not a time: `Composer audit skipped: no pull in the last 24 hours (last pull <at>).`

Write every answer line in the language whose ISO 639-1 code `bot-language.json` holds (`de` when it is missing).

Done when the clone is fresh, or you have answered why not.

## 2. Audit every lock file

Run `find . \( -name composer.lock -o -name composer.json \) -not -path '*/.git/*' -not -path '*/vendor/*' -not -path '*/node_modules/*'`. Audit each directory that holds both a `composer.lock` and a `composer.json`; the others are skipped.

In each such directory `<dir>` (as `find` printed it, for example `./web/themes/custom/yf`), run `composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore --working-dir=<dir>`. Exit code 0 means no advisories (for a lock without packages Composer prints `No packages - skipping audit.` instead of JSON). Exit code 1 means advisories were found, listed in the JSON, and counts as success too. Any other exit code, or exit code 1 without JSON, fails the night: answer one line, `Composer audit failed:` with the directory and Composer's error, create and comment nothing, and stop. The next night tries again.

`advisories` maps each affected package to its list of advisories. For every advisory, record:

| Field | Source |
|---|---|
| lock file | `<dir>/composer.lock` |
| package | `packageName` |
| installed | the `"version"` line that `grep -A1 '"name": "<package>",' <dir>/composer.lock` prints under the name, run once per affected package |
| fixed in | the `<` bound of the `affectedVersions` range the installed version falls in; `none yet` without one |
| severity | `severity`, or `unknown` |
| CVE/link | `cve` linked to `link`; the `advisoryId` when there is no CVE |

Done when every directory is audited and every advisory recorded, or the night has failed.

## 3. Find the open audit ticket

Call `mcp_bakers__tool_api__bakers_ticket_search` with `query: "Security updates:"` and `project: "${PM_BOT_PROJECT}"`. The open audit ticket is the newest result whose title starts with `Security updates:` and whose state is neither `done` nor `cancelled`.

When the search fails, answer one line, `Composer audit: cannot search for the audit ticket` with the error, write nothing, and stop: without the search a second ticket could follow.

Done when you know the open audit ticket, or that none is open.

## 4. Write the result

The **tables**: one per lock file with advisories, under a `### <lock file>` heading, with the columns package, installed, fixed in, severity, CVE/link, one row per advisory. Under each table, the line that updates its packages: `composer update <package> --with-dependencies` with every affected package of that lock file, run in its directory.

`<n>` is the number of distinct advisory IDs; `<packages>` lists the affected packages, comma-separated, sorted.

Take the one branch that fits:

| Open audit ticket | Advisories | Do | Answer |
|---|---|---|---|
| none | none | nothing | `Composer audit: no advisories in <lock count> lock files.`, then `[SILENT]` |
| none | some | *Create the audit ticket* below | the ticket as a Markdown link, `<identifier> · <title>`, the count and the channel as `<#<channel>>` |
| open | some | one `mcp_bakers__tool_api__bakers_comment_create` on it, `type: "comment"`, body: the date, `Security updates: <n> Composer advisories (<packages>)` and the tables | one line: `<n>` advisories still open, linking the ticket |
| open | none | one `mcp_bakers__tool_api__bakers_comment_create` on it, `type: "comment"`, body: the date and that none remain in any of the `<lock count>` lock files, so the ticket can be closed | one line: none remain, linking the ticket |

The comment repeats every night while the ticket is open, so it always shows the current state.

## Create the audit ticket

In this order:

1. `mcp_bakers__tool_api__bakers_ticket_create` with `project: "${PM_BOT_PROJECT}"`, `workflow: "${PM_BOT_TICKET_WORKFLOW}"`, `type: "chore"`, `title: "Security updates: <n> Composer advisories (<packages>)"` and `description`: one sentence that the nightly Composer audit found these advisories in the clone at the marker's `head`, then the tables. Pass nothing else.
2. `mcp_bakers__tool_api__bakers_conductor_list` with the project. When the project has exactly one active conductor, call `mcp_bakers__tool_api__bakers_ticket_update` with the ticket, `labels_add: ["security"]` and `conductor` = its UUID. Otherwise call it with `labels_add: ["security"]` alone, and your answer says no conductor was set and why (none active, or several).
3. `open_request_channel` with the title. Then `mcp_bakers__tool_api__bakers_ticket_transition` with the ticket and `links: [{"uri": <link>, "title": "Slack channel"}]`, without a state. Without an `open_request_channel` tool the bot talks in GitLab issues, and the ticket stays without a conversation: skip this step, and your answer names no channel.

When a step after the create fails, your answer names it, so a person can finish it by hand.

## Rules

- The ticket carries the label `security` and no other label you add. A person qualifies it.
- One run creates at most one ticket and one comment.
- An uncertain write (a timeout, a lost reply) is settled by reading: search again for the ticket, or read its comments with `mcp_bakers__tool_api__bakers_ticket_read`. Never send the write a second time.
