# Hermes Bot — WORKFLOW

Invoke `bakers:bb-workflow` and follow it for the ticket's current state.

## bb-phase-provision

No runtime: the bot's code is tested without starting it. Checks need Node 22 and python3 with
PyYAML; the image checks need Docker. A running bot needs Slack and a Coder workspace
([README](README.md)), which no ticket run provisions.

## bb-phase-work

Apply all matching rows.

| When | Skill |
|---|---|
| Planning, writing, changing or reviewing tests (`*.test.mjs`, `plugins/bot-channels` tests, `tests/contract/**`) | `keytec-qa:keytec-testing` |
| The persona `SOUL.template.md`, the plugin's model-facing texts or other agent instructions | `mattpocock-skills:writing-for-agents` |

## bb-phase-validate

Apply all matching rows to the plan and final diff. Run each distinct command once per revision.

| When | Command |
|---|---|
| Any change | `node --test '**/*.test.mjs' && python3 -m unittest discover -s plugins/bot-channels && bash tests/contract/pm-bot.sh` |
| `Dockerfile`, `entrypoint.sh`, `build/**`, `compose.yaml`, `config.template.yaml`, `tests/contract/pm-bot-image.sh` | Build the image with the `docker build` line of `.github/workflows/checks.yml` (job `image`), then `bash tests/contract/pm-bot-image.sh <image>` |

## bb-phase-deliver

Changes reach `main` through a GitHub pull request. The `Checks` workflow (`tests` and `image`)
is the merge gate: merge only when both jobs are green. A push to `main` publishes the image to
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
