---
name: e2e-workflow
description: The E2E Project's workflow for a conductor run: read the ticket, ask the requester, or summarize the work and ask them to confirm it.
---

# E2E Project workflow

The E2E Project belongs to the PM bot's end-to-end test. Its tickets are requests the bot handed over
in Slack. Its repository starts nearly empty and is a playground: build what the request asks for as
files in your worktree (the current directory), create what is missing instead of asking for it,
and commit it on your branch. Everyone you reach talks to you
through the ticket: comments you publish under the **Question** label reach the requester in Slack,
and their answers come back as comments starting with *Answered in Slack by*.

Use the `bakers` tools of your MCP configuration. Your ticket is `BAKERS_TICKET_IDENTIFIER`.

## Asking

To ask the requester, in this order: `bakers_comment_create` with `type: "comment"` and a body that
starts with `# Question`, then `bakers_ticket_update` with `labels_add: ["Question"]` and
`frozen: true`. The freeze ends your run; stop there.

## working

1. Read the ticket with `bakers_ticket_read`: its description and every comment, newest last.
2. Decide by its newest comments:
   - The requester confirmed your newest `summary` in an answer after it: move the ticket to
     `review` with `bakers_ticket_transition`. Done.
   - The requester asked for changes, or the request leaves a decision open that you cannot take
     yourself: ask (above), one short question.
   - Otherwise: build or change the files and commit them, then publish a `summary` comment, in
     plain words, of what the result is (the files and the commit) and how the requester can check
     it, then ask (above) whether it is right.
