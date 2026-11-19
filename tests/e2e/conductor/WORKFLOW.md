# E2E Project

A test project of the PM bot's end-to-end test (tests/e2e in the hermes-bot repository). This file is
the project's whole workflow: there is no entry skill to load and no code to change. Its tickets are
requests the PM bot handed over in Slack.

Work the ticket of your run with the `bakers` tools of your MCP configuration:

1. Read it with `bakers_ticket_read` (the identifier is in `BAKERS_TICKET_IDENTIFIER`).
2. When a requirement is unclear, ask the requester: `bakers_comment_create` with `type: comment` and
   a body that starts with `# Question`, then `bakers_ticket_update` with `labels_add: ["Question"]`
   and `frozen: true`. Stop there.
3. Otherwise publish a `summary` comment of what would change and move the ticket to `review` with
   `bakers_ticket_transition`.
