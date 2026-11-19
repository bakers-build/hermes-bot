---
name: composer-audit
description: The nightly Composer security audit of the project's clone. Use only in the cron job composer-audit, never in Slack.
---

# Nightly Composer audit

You run unattended, once a night. Nobody reads along: your final answer goes into the project's main channel, so it is either one line or `[SILENT]`.

The script `/opt/data/skills/composer-audit/audit.mjs` does the fixed work: it reads the box's pull marker `/opt/data/clone-pulled.json` (an audit runs only on a marker with `"ok": true` newer than the last audit), finds every `composer.lock` with a `composer.json` beside it outside `.git/`, `vendor/` and `node_modules/`, runs `composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore` in each lock's directory, and compares the `advisories` with the last audit in `/opt/data/audit-state.json` (per advisory ID and lock file: package, installed, affected range, fixed in, severity, CVE, link, first seen). You decide; the script writes the state only when you commit.

Run exactly the two commands below in the terminal, as written. Every advisory detail reaches bakers.build through your tools, never through a shell command.

## 1. Audit

Run `node /opt/data/skills/composer-audit/audit.mjs run` and read its JSON.

- `status: "skip"` → answer `reason` as the first line and `[SILENT]` as the last. Stop.
- `status: "error"` → answer one line: `Composer audit failed:` and `reason`. Write nothing anywhere. Stop.
- `status: "audited"` → go on. You now hold `ticket`, `count`, `new`, `gone`, `title`, `description`, `comment` and `language`.

Write your answer line in the language with ISO 639-1 code `language`.

## 2. Is the audit ticket open?

When `ticket` is set, read it with `mcp_bakers__tool_api__bakers_ticket_read` (`newest: 0`). It is open unless its state is `done` or `cancelled`. With no `ticket`, none is open. When it is closed, every current advisory counts as new.

When the read fails, answer one line: `Composer audit: cannot read the audit ticket` with `ticket` and the error. Commit nothing and stop; the next night reads it again.

Done when you know: open audit ticket, or none.

## 3. Act on the one branch that fits

| Branch | Do | Commit | Answer |
|---|---|---|---|
| no open ticket, `count` is 0 | nothing | `commit` (with a closed `ticket`: `commit --no-ticket`) | `Composer audit: no advisories in <n> lock files.`, then `[SILENT]` |
| open ticket, `new` and `gone` empty | nothing | `commit` | `Composer audit: unchanged since the last night.`, then `[SILENT]` |
| open ticket, `new` or `gone` not empty | one `mcp_bakers__tool_api__bakers_comment_create` on that ticket, `type: "comment"`, `body` = `comment` exactly | `commit`, after the comment is stored | one line: what changed, linking the ticket |
| no open ticket, `count` above 0 | *Create the audit ticket* below | inside it | one line: the ticket link and the count |

Commit means `node /opt/data/skills/composer-audit/audit.mjs commit`, with the flag the branch names. A write that fails stays uncommitted, so the next night tries again; say in your answer what failed.

## Create the audit ticket

In this order:

1. `mcp_bakers__tool_api__bakers_ticket_create` with `project: "${PM_BOT_PROJECT}"`, `workflow: "${PM_BOT_TICKET_WORKFLOW}"`, `type: "chore"`, `title` = `title` (the form `Security updates: <n> Composer advisories (<packages>)`) and `description` = `description` exactly: a table per lock file (package, installed, fixed in, severity, CVE/link) and its `composer update <package> --with-dependencies` line. Pass nothing else.
2. Right after it, before any other write: `node /opt/data/skills/composer-audit/audit.mjs commit --ticket <identifier>` with the identifier it returned. This keeps a second ticket from ever being created.
3. `mcp_bakers__tool_api__bakers_conductor_list` with the project. When the project has exactly one active conductor, call `mcp_bakers__tool_api__bakers_ticket_update` with the ticket, `labels_add: ["security"]` and `conductor` = its UUID. Otherwise call it with `labels_add: ["security"]` alone, and your answer says no conductor was set and why (none active, or several).
4. `open_request_channel` with `title`. Then `mcp_bakers__tool_api__bakers_ticket_transition` with the ticket and `links: [{"uri": <link>, "title": "Slack channel"}]`, without a state.

Answer in one line: a Markdown link to the ticket, with `<identifier> · <title>` as its text and the `url` the create returned as its target, then the advisory count and the channel as `<#<channel>>`.

## Rules

- The ticket carries the label `security` and no other label you add. A person qualifies it.
- One run creates at most one ticket and one comment.
- An uncertain write (a timeout, a lost reply) is settled by reading the ticket, never by a second call.
