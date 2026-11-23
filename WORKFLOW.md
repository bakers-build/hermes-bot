# Hermes Bot — WORKFLOW

Invoke `bakers:bb-workflow` and follow it for the ticket's current state.

## bb-phase-provision

Checks need Node 22 and python3 with PyYAML; the image checks and the end-to-end test need Docker.
The end-to-end test (`tests/e2e/run.sh`) starts its own stack: a bakers.build site, the bot's image,
a conductor, a scripted model and a Slack recorder, with no credentials. A bot in Slack needs a
Coder workspace, which no ticket run provisions.

## bb-phase-work

Apply all matching rows.

| When | Skill |
|---|---|
| Planning, writing, changing or reviewing tests (`*.test.mjs`, `plugins/bot-channels` tests, `tests/contract/**`, `tests/e2e/**`) | `keytec-qa:keytec-testing` |
| A feature, or any change to what a requester sees in Slack or on the ticket | Add or extend its scenarios in `tests/e2e/scenarios/` (by feature, *given/when/then* names, asserting site state and recorded Slack calls); the plan names them |
| The persona `SOUL.template.md`, the plugin's model-facing texts or other agent instructions | `mattpocock-skills:writing-for-agents` |

## bb-phase-validate

Apply all matching rows to the plan and final diff. Run each distinct command once per revision.

| When | Command |
|---|---|
| Any change | `node --test '**/*.test.mjs' && python3 -m unittest discover -s plugins/bot-channels && bash tests/contract/pm-bot.sh` |
| `Dockerfile`, `entrypoint.sh`, `build/**`, `compose.yaml`, `config.template.yaml`, `tests/contract/pm-bot-image.sh` | Build the image with the `docker build` line of `.github/workflows/checks.yml` (job `image`), then `bash tests/contract/pm-bot-image.sh <image>` |
| The bot's content (everything the image copies: `.dockerignore`), `compose.yaml` or `tests/e2e/**` | `bash tests/e2e/run.sh <image>` on the image the row above built, else `bash tests/e2e/run.sh` (it builds the working copy) |

## bb-phase-deliver

Changes reach `main` through a GitHub pull request. The `Checks` workflow (`tests` and `image`,
whose *End-to-end test* step runs `tests/e2e/run.sh` on the built image) is the merge gate: merge
only when both jobs are green. A push to `main` publishes the image to
`ghcr.io/bakers-build/hermes-bot`. Pull request titles are Conventional Commits subjects
(`feat: …`, `fix: …`, `ci: …`).

## bb-phase-transition

| State | Origin label |
|---|---|
| qualification | doing |
| plan | doing |
| working | doing |
| review | doing |
| done | review |
