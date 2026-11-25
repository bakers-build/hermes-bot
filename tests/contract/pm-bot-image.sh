#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Smoke test of the PM bot's image (Dockerfile).
#
#   bash tests/contract/pm-bot-image.sh [IMAGE]
#
# Without IMAGE it builds  as pm-bot:check first. The data directory
# is a Docker volume seeded as the Coder script leaves it (owned by uid 1000,
# .env mode 600), so the test runs the same against a local daemon and CI's
# Docker-in-Docker. It asserts:
#   - check mode: Hermes is the version the bot is written for, node is
#     present, config.yaml is rendered with no placeholder left but the
#     ${env:BAKERS_API_KEY} Hermes fills, and without the key itself; Hermes
#     connects to bakers.build's /mcp (a stub of it, pm-bot-mcp-stub.mjs, in a
#     container of the same image) with the key as bearer and takes exactly the
#     nine included tools; with a wrong key the check fails
#   - php and composer 2 run as hermes; the audit skill's own commands work on a read-only clone,
#     offline: find skips vendor/, a lock without packages has no advisories, grep reads
#     the installed version, and an audit without Packagist fails with neither exit 0 nor 1
#   - the composer-audit cron job is registered once (schedule from AUDIT_TIME, delivery to the
#     main channel, the skill) and stays one over two starts; the skill is rendered with the
#     project; an invalid AUDIT_TIME stops the start by name, an unreadable job store gets no
#     second job, and AUDIT_ENABLED=false removes the job with one log line, whatever AUDIT_TIME,
#     or names a job store it cannot read instead of logging the audit off
#   - Hermes resolves the cron job's toolsets to terminal, skills, bakers and bot-channels-cron and
#     Slack's to the bot's five, without the terminal or the channel tool
#   - on the GitLab side (PM_BOT_CHAT=gitlab) the config holds no Slack, the plugin registers the
#     gitlab platform, the issue gets the bot's five toolsets, cron has no channel tool, and
#     GitLab's missing keys are named
#   - the bot-channels plugin is installed and loaded, and the Hermes internals it relies on
#     (SlackAdapter._handle_slack_message, the channel getters, the reaction lifecycle's
#     _track_reacting_message, _event_team_id, on_processing_complete and
#     ProcessingOutcome.CANCELLED, resolve_channel_prompt, register_platform_handler) exist,
#     and with it loaded a requester's lost turn is selected for settling and the drain still
#     settles one (SessionAuthority._claim_with_retry)
#   - the plugin's recovery test (test_recovery.py) passes on Hermes' real session store: a
#     conversation a hard restart left paused takes the next message, a healthy one is untouched
#   - the shipped skills (bb-create-ticket, both recipes and the upstream method
#     skills) are installed, the bundle version is printed, every relative link
#     in them resolves, the upstream ones match pm-bot-upstream.sha256 (their
#     pinned commits) and a leftover project-manager skill is removed
#   - SOUL.md in the data directory is rendered from the image's template (a hand
#     edit is replaced), with no placeholder or key left;
#     a learned skill and a session are kept
#   - a missing required key stops the start and is named, and so does more than
#     one allowed channel
#   - run mode, with the capabilities and options of the bot's compose
#     file: the poller and exactly one gateway run, as hermes, on the first
#     start and again on a start over the same data directory
# Needs Docker.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

HERMES_VERSION=v0.22.5
# The coder user of a Coder workspace image.
OWNER=1000
COMPOSE=compose.yaml

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  IMAGE=pm-bot:check
  # The skill contexts: bakers-build's bundle, superpowers v7.0.0 and mattpocock/skills v1.3.2.
  docker build -q -t "$IMAGE" \
    --build-context bundle=https://github.com/bakers-build/bakers-build.git#next:.claude/skills/bakers-build \
    --build-context superpowers=https://github.com/obra/superpowers.git#bb92a77741419a4ab5f06e711a283343f1ada0c3 \
    --build-context mattpocock=https://github.com/mattpocock/skills.git#d1478fcb140db0b93c0c8df17bcfd311844749d0 . >/dev/null || fail "docker build . failed"
fi

volume="pm-bot-check-$$"
name="pm-bot-check-$$"
net="pm-bot-check-$$"
stub="pm-bot-stub-$$"
trap 'docker rm -f "$name" "$stub" >/dev/null 2>&1; docker volume rm -f "$volume" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1' EXIT
docker volume create "$volume" >/dev/null
docker network create "$net" >/dev/null

# bakers.build's /mcp, stubbed: it answers only the fixture's API key.
key="$(sed -n 's/^BAKERS_API_KEY=//p' test/fixture.env)"
[ -n "$key" ] || fail "test/fixture.env has no BAKERS_API_KEY"
docker run -d --name "$stub" --network "$net" -e STUB_KEY="$key" --entrypoint node "$IMAGE" \
  --input-type=module -e "$(cat tests/contract/pm-bot-mcp-stub.mjs)" >/dev/null || fail "the /mcp stub does not start"
BAKERS_URL="http://$stub:8080"

# In the data volume, as root of a throwaway container.
in_data() { docker run --rm -i -v "$volume:/d" --entrypoint sh "$IMAGE" -c "$1"; }

# What the Coder script and a running bot leave behind, and what must survive the next start.
# The env file points at the stub, as the Coder script writes it for a real site.
sed "s|^BAKERS_URL=.*|BAKERS_URL=$BAKERS_URL|" test/fixture.env | in_data "umask 077; cat >/d/.env; mkdir -p /d/skills/learned /d/sessions
  echo kept >/d/skills/learned/SKILL.md; echo kept >/d/sessions/one.json; echo 'hand edit' >/d/SOUL.md
  mkdir -p /d/skills/project-manager; echo old >/d/skills/project-manager/SKILL.md
  chown -R $OWNER:$OWNER /d"

# The compose file's hardening, as docker run options.
caps=(--cap-drop ALL)
while read -r cap; do caps+=(--cap-add "$cap"); done < <(sed -n 's/^ *- \([A-Z_]*\) *# cap$/\1/p' "$COMPOSE")
[ ${#caps[@]} -gt 2 ] || fail "no capability list in $COMPOSE"
start() {
  docker run --env-file test/fixture.env -e BAKERS_URL="$BAKERS_URL" --network "$net" -e HERMES_UID=$OWNER -e HERMES_GID=$OWNER \
    -v "$volume:/opt/data" "${caps[@]}" --security-opt no-new-privileges:true "$@"
}

out="$(start --rm "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed"; }
grep -q "Hermes Agent $HERMES_VERSION " <<<"$out" || { echo "$out" >&2; fail "Hermes is not $HERMES_VERSION"; }
pass "Hermes $HERMES_VERSION"
grep -qE '^node v[0-9]+\.' <<<"$out" || { echo "$out" >&2; fail "node is missing"; }
pass "node present"

config="$(in_data 'cat /d/config.yaml')" || fail "config.yaml was not rendered"
! grep -v -F '${env:BAKERS_API_KEY}' <<<"$config" | grep -n '\${' || fail "config.yaml keeps a placeholder"
grep -q 'Bearer ${env:BAKERS_API_KEY}' <<<"$config" || fail "config.yaml does not leave the API key to Hermes"
! grep -qF "$key" <<<"$config" || fail "config.yaml holds the API key"
grep -q 'allowed_channels: C0000000001$' <<<"$config" || fail "config.yaml lacks the one allowed channel"
grep -qF "url: $BAKERS_URL/mcp" <<<"$config" || fail "config.yaml does not reach bakers.build's /mcp"
pass "config.yaml rendered, no placeholder left but the key Hermes fills, no key in it"

grep -q 'Connected' <<<"$out" || { echo "$out" >&2; fail "Hermes does not connect to /mcp with the API key"; }
grep -qx 'bakers tools: tool_api__bakers_comment_create,tool_api__bakers_conductor_list,tool_api__bakers_ticket_classify,tool_api__bakers_ticket_create,tool_api__bakers_ticket_read,tool_api__bakers_ticket_search,tool_api__bakers_ticket_transition,tool_api__bakers_ticket_update,tool_api__bakers_user_read' <<<"$out" \
  || { echo "$out" >&2; fail "Hermes does not register exactly the nine included tools of the sixteen offered"; }
pass "Hermes connects to /mcp with the API key as bearer and takes exactly the nine tools"

in_data "sed -i 's/^BAKERS_API_KEY=.*/BAKERS_API_KEY=wrong-key/' /d/.env"
out="$(start --rm -e BAKERS_API_KEY=wrong-key "$IMAGE" check 2>&1)" && { echo "$out" >&2; fail "check passed with a wrong API key"; }
grep -qE 'Connection failed.*(401|[Uu]nauthori)' <<<"$out" || { echo "$out" >&2; fail "a wrong API key does not fail on authentication"; }
in_data "sed -i 's/^BAKERS_API_KEY=.*/BAKERS_API_KEY=$key/' /d/.env"
pass "a wrong API key fails the check"

grep -qx 'skills: bb-create-ticket,bb-recipe-matt,bb-recipe-superpowers,brainstorming,composer-audit,grilling,writing-plans' <<<"$out" \
  || { echo "$out" >&2; fail "the installed skills are not exactly the shipped seven"; }
grep -qE '^bakers skills [0-9]+\.[0-9]+\.[0-9]+$' <<<"$out" || { echo "$out" >&2; fail "the bundle version is not printed"; }
in_data '[ ! -e /d/skills/project-manager ]' || fail "the old project-manager skill was not removed"
pass "the shipped skills are installed, the bundle version printed and project-manager removed"

grep -qx 'plugins: bot-channels' <<<"$out" || { echo "$out" >&2; fail "Hermes does not load exactly the bot-channels plugin"; }
# The toolsets as Hermes resolves them from the rendered config, plugin toolsets included: only
# the nightly cron job has the terminal and the channel tool.
grep -qx 'toolsets cron: bakers,bot-channels-cron,skills,terminal' <<<"$out" \
  || { echo "$out" >&2; fail "the cron job's toolsets are not exactly terminal, skills, bakers and bot-channels-cron"; }
grep -qx 'toolsets slack: bakers,clone-reader,memory,session_search,skills' <<<"$out" \
  || { echo "$out" >&2; fail "Slack's toolsets are not exactly the bot's five"; }
grep -qx 'plugin seams: ok' <<<"$out" || { echo "$out" >&2; fail "a Hermes internal the bot-channels plugin relies on is gone"; }
in_data '[ -f /d/plugins/bot-channels/__init__.py ]' || fail "the bot-channels plugin is not in the data directory"
pass "the bot-channels plugin is installed and loaded, and its Hermes seams exist"

# The nightly audit's tools: php and composer 2, as hermes.
docker run --rm -u hermes --entrypoint sh "$IMAGE" -c 'php -v && composer --version' >/dev/null 2>&1 \
  || fail "php or composer does not run as hermes"
docker run --rm -u hermes --entrypoint composer "$IMAGE" --version 2>/dev/null | grep -qE '^Composer version 2\.' \
  || fail "composer is not version 2"
pass "php and composer 2 run as hermes"

# The skill's own commands, as hermes, offline, on a read-only clone: find lists the locks outside
# vendor/, a lock without packages audits to no advisories (exit 0), grep reads an installed
# version from the lock, and an audit that cannot reach Packagist fails with an exit
# code other than 0 and 1. SKILL.md holds these commands (tests/contract/pm-bot.sh pins them).
audit_out="$(docker run --rm -i --network none -u hermes --entrypoint sh "$IMAGE" -c '
  mkdir -p /tmp/clone/empty /tmp/clone/one /tmp/clone/vendor/x && cd /tmp/clone
  echo "{}" >empty/composer.json; echo "{\"packages\":[],\"packages-dev\":[]}" >empty/composer.lock
  echo "{}" >one/composer.json
  printf "%s\n" "{" "    \"packages\": [" "        {" "            \"name\": \"psr/log\"," "            \"version\": \"3.0.2\"," \
    "            \"type\": \"library\"" "        }" "    ]," "    \"packages-dev\": []" "}" >one/composer.lock
  cp one/composer.json one/composer.lock vendor/x/
  chmod -R a-w /tmp/clone
  find . \( -name composer.lock -o -name composer.json \) -not -path "*/.git/*" -not -path "*/vendor/*" -not -path "*/node_modules/*" | sort
  composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore --working-dir=./empty; echo "empty rc=$?"
  grep -A1 "\"name\": \"psr/log\"," ./one/composer.lock; echo "show rc=$?"
  composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore --working-dir=./one; echo "one rc=$?"
  chmod -R u+w /tmp/clone; mkdir bad; echo "{}" >bad/composer.json
  echo "{\"packages\":[{\"name\":\"psr/log\",\"version\":\"3.0.2\",\"source\":{}}],\"packages-dev\":[]}" >bad/composer.lock
  composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore --working-dir=./bad >bad.out 2>&1; echo "bad rc=$?"
  grep -c "\"advisories\"" bad.out' 2>&1)" || true
[ "$(grep -c '^\./.*composer\.\(json\|lock\)$' <<<"$audit_out")" = 4 ] && ! grep -q '^\./vendor/' <<<"$audit_out" \
  || { echo "$audit_out" >&2; fail "the skill's find does not list exactly the locks outside vendor/"; }
grep -qx 'empty rc=0' <<<"$audit_out" && grep -qxF 'No packages - skipping audit.' <<<"$audit_out" \
  || { echo "$audit_out" >&2; fail "composer audit does not audit a lock without packages to no advisories"; }
grep -qx 'show rc=0' <<<"$audit_out" && grep -qF '"version": "3.0.2",' <<<"$audit_out" \
  || { echo "$audit_out" >&2; fail "the skill's grep does not read the installed version from the lock"; }
grep -qE '^one rc=[0-9]+$' <<<"$audit_out" && ! grep -qxE 'one rc=(0|1)' <<<"$audit_out" \
  || { echo "$audit_out" >&2; fail "an audit without Packagist does not fail with an exit code other than 0 and 1"; }
# A broken lock also exits 1, without the advisories JSON: SKILL.md fails the night on that.
grep -qx 'bad rc=1' <<<"$audit_out" && [ "$(tail -1 <<<"$audit_out")" = 0 ] \
  || { echo "$audit_out" >&2; fail "a broken lock does not exit 1 without the advisories JSON"; }
pass "the skill's find, composer audit and grep work as hermes on a read-only clone; a broken lock exits 1 without JSON"

# The rendered skill: the project and workflow filled in, no placeholder left.
skill="$(in_data 'cat /d/skills/composer-audit/SKILL.md')" || fail "the composer-audit skill is not installed"
! grep -n '\${' <<<"$skill" || fail "the composer-audit skill keeps a placeholder"
grep -qF "project: \"$(sed -n 's/^PM_BOT_PROJECT=//p' test/fixture.env)\"" <<<"$skill" || fail "the composer-audit skill lacks the project"
pass "the composer-audit skill is rendered with the project and workflow"

# Hermes scans a cron job's prompt with its loaded skills before each run and blocks the run on
# a match; the job's prompt and skill must pass.
scan="$(docker run --rm -i -v "$volume:/d:ro" --entrypoint sh "$IMAGE" -c 'cd /opt/hermes && .venv/bin/python -c "
import json
from tools.cronjob_prompt_scan import _scan_cron_prompt, _scan_cron_skill_assembled
job = [j for j in json.load(open(\"/d/cron/jobs.json\"))[\"jobs\"] if j[\"name\"] == \"composer-audit\"][0]
skill = open(\"/d/skills/composer-audit/SKILL.md\").read()
print(\"scan:\", repr(_scan_cron_prompt(job[\"prompt\"])), repr(_scan_cron_skill_assembled(job[\"prompt\"] + chr(10) + skill)[1]))
"' 2>&1)" || { echo "$scan" >&2; fail "Hermes' cron prompt scan did not run"; }
grep -qxF "scan: '' ''" <<<"$scan" || { echo "$scan" >&2; fail "Hermes' cron prompt scan blocks the composer-audit job"; }
pass "the composer-audit job's prompt and skill pass Hermes' cron prompt scan"

# The cron job, as the check start registered it.
jobs() { in_data 'cat /d/cron/jobs.json' | node -e '
  const jobs = JSON.parse(require("fs").readFileSync(0, "utf8")).jobs.filter((j) => j.name === "composer-audit");
  console.log(jobs.map((j) => [j.schedule.expr, j.deliver, j.skills.join("+"), j.enabled].join(" ")).join("\n"));'; }
[ "$(jobs)" = "30 3 * * * slack:C0000000001 composer-audit true" ] || { jobs >&2; fail "the composer-audit job is not registered once at 03:30 for the main channel"; }
grep -qF 'pm-bot: composer-audit at 30 3 * * *' <<<"$out" || { echo "$out" >&2; fail "the start does not log the audit job"; }
pass "the composer-audit job is registered at AUDIT_TIME, delivered to the main channel, with its skill"

out="$(start --rm -e AUDIT_TIME=25:00 "$IMAGE" check 2>&1)" && fail "check passed with AUDIT_TIME=25:00"
grep -q 'AUDIT_TIME must be HH:MM' <<<"$out" || { echo "$out" >&2; fail "an invalid AUDIT_TIME is not refused by name"; }
pass "an invalid AUDIT_TIME stops the start"

# A night missed while the container was down is still due at the next start: a start keeps the
# job's due time, and only a changed AUDIT_TIME moves it.
next_run() { in_data 'cat /d/cron/jobs.json' | node -e '
  const jobs = JSON.parse(require("fs").readFileSync(0, "utf8")).jobs.filter((j) => j.name === "composer-audit");
  console.log(jobs.map((j) => `${j.schedule.expr} ${j.next_run_at}`).join("\n"));'; }
overdue=2026-01-01T03:30:00+00:00
in_data "node -e '
  const fs = require(\"fs\");
  const store = JSON.parse(fs.readFileSync(\"/d/cron/jobs.json\", \"utf8\"));
  for (const job of store.jobs) if (job.name === \"composer-audit\") job.next_run_at = \"$overdue\";
  fs.writeFileSync(\"/d/cron/jobs.json\", JSON.stringify(store, null, 2));'" || fail "cannot make the composer-audit job overdue"
out="$(start --rm "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed over an overdue job"; }
[ "$(next_run)" = "30 3 * * * $overdue" ] || { next_run >&2; fail "a start moved the overdue composer-audit job, so a missed night is not caught up"; }
pass "a start keeps an overdue composer-audit job due"
out="$(start --rm -e AUDIT_TIME=04:15 "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed with AUDIT_TIME=04:15"; }
moved="$(next_run)"
[ "${moved%% 20*}" = "15 4 * * *" ] && [ "${moved#15 4 \* \* \* }" != "$overdue" ] \
  || { echo "$moved" >&2; fail "a changed AUDIT_TIME does not reschedule the composer-audit job"; }
out="$(start --rm "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed back at the default AUDIT_TIME"; }
[ "$(jobs)" = "30 3 * * * slack:C0000000001 composer-audit true" ] || { jobs >&2; fail "the default AUDIT_TIME does not come back"; }
pass "a changed AUDIT_TIME reschedules the composer-audit job"

# The tests are not in the image (.dockerignore); piped in rather than mounted, for CI's Docker-in-Docker.
tar -C plugins -cf - bot-channels | docker run -i --rm -e PM_BOT_REQUIRE_HERMES=1 --entrypoint sh "$IMAGE" -c \
  'mkdir -p /tmp/t && tar -C /tmp/t -xf - && cd /opt/hermes && .venv/bin/python -m unittest discover -s /tmp/t/bot-channels -p test_recovery.py' \
  || fail "a conversation a hard restart left paused is not recovered (test_recovery.py)"
pass "a conversation a hard restart left paused takes the next message; a healthy one is untouched"

# Every relative Markdown link of the installed shipped skills resolves to a file inside the
# linking skill's own folder, the only files Hermes' skill_view serves; web links and anchors
# aside. Hermes' own bundled skills in the same directory are not ours to check.
in_data 'cd /d/skills && node --input-type=module -e "
import { readFileSync, statSync, readdirSync } from \"node:fs\";
import { dirname, join } from \"node:path\";
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
let bad = 0;
const shipped = readdirSync(\"/opt/pm-bot/skills\").flatMap((name) => walk(name));
for (const f of shipped.filter((f) => f.endsWith(\".md\"))) {
  for (const [, l] of readFileSync(f, \"utf8\").matchAll(/\\]\\(\\s*<?([^)\\s>]+)>?/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(l) || l.startsWith(\"#\")) continue;
    const t = join(dirname(f), decodeURI(l.split(\"#\")[0]));
    const own = f.split(\"/\")[0] + \"/\";
    try { if (!t.startsWith(own) || !statSync(t).isFile()) throw 0; } catch { console.error(f + \" -> \" + l); bad++; }
  }
}
process.exit(bad ? 1 : 0);
"' || fail "a shipped skill links a missing file or one outside its folder"
pass "every link in the shipped skills resolves inside its skill folder"

in_data 'cd /d/skills && sha256sum -c --quiet' <tests/contract/pm-bot-upstream.sha256 \
  || fail "an upstream skill differs from its pinned commit"
pass "the upstream skills are byte-equal to their pinned commits"

soul="$(in_data 'cat /d/SOUL.md')" || fail "SOUL.md was not rendered"
! grep -qF 'hand edit' <<<"$soul" || fail "SOUL.md keeps a hand edit"
! grep -n '\${' <<<"$soul" || fail "SOUL.md keeps a placeholder"
! grep -qF "$key" <<<"$soul" || fail "SOUL.md holds the API key"
grep -qF "$(sed -n 's/^PM_BOT_PROJECT=//p' test/fixture.env)" <<<"$soul" || fail "SOUL.md lacks the project"
pass "SOUL.md is rendered from the image's template: no hand edit, placeholder or key, the project in it"

[ "$(in_data 'cat /d/skills/learned/SKILL.md /d/sessions/one.json')" = "kept
kept" ] || fail "a learned skill or a session was lost"
pass "learned skills and sessions kept"

# The GitLab side: the overlay replaces Slack, the plugin registers the gitlab platform, the issue
# gets Slack's toolsets and cron loses the channel tool; GitLab's keys are required and named.
gitlab=(-e PM_BOT_CHAT=gitlab -e GITLAB_URL=https://gitlab.example.com -e GITLAB_PROJECT=group/project -e GITLAB_TOKEN=glpat-fixture
  -e GITLAB_WEBHOOK_URL=https://pm-bot.example.com/webhooks/gitlab -e SLACK_BOT_TOKEN= -e SLACK_APP_TOKEN=)
out="$(start --rm "${gitlab[@]}" "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed on the GitLab side"; }
grep -qx 'platforms: gitlab' <<<"$out" || { echo "$out" >&2; fail "the plugin registers no gitlab platform"; }
grep -qx 'toolsets gitlab: bakers,clone-reader,memory,session_search,skills' <<<"$out" || { echo "$out" >&2; fail "the issue's toolsets are not exactly the bot's five"; }
grep -qx 'toolsets cron: bakers,skills,terminal' <<<"$out" || { echo "$out" >&2; fail "cron keeps the channel tool on the GitLab side"; }
grep -qx 'plugin seams: ok' <<<"$out" || { echo "$out" >&2; fail "a Hermes internal the GitLab side relies on is gone"; }
config="$(in_data 'cat /d/config.yaml')"
! grep -qE '^slack:|allowed_channels' <<<"$config" || fail "config.yaml keeps Slack's block on the GitLab side"
grep -qE '^    enabled: true' <<<"$config" || fail "config.yaml does not enable the gitlab platform"
out="$(start --rm -e PM_BOT_CHAT=gitlab "$IMAGE" check 2>&1)" && fail "check passed on the GitLab side without GitLab's keys"
grep -q 'missing: GITLAB_URL GITLAB_PROJECT GITLAB_TOKEN GITLAB_WEBHOOK_URL' <<<"$out" || { echo "$out" >&2; fail "GitLab's missing keys are not named"; }
pass "the GitLab side: gitlab platform, Slack's toolsets, no channel tool for cron, its keys required"

out="$(start --rm -e PM_BOT_PROJECT= -e SLACK_ADMIN_USERS= "$IMAGE" check 2>&1)" && fail "check passed without PM_BOT_PROJECT"
grep -q 'missing: SLACK_ADMIN_USERS PM_BOT_PROJECT' <<<"$out" || { echo "$out" >&2; fail "the missing keys are not named"; }
pass "a missing key stops the start and is named"

out="$(start --rm -e SLACK_ALLOWED_CHANNELS=C0000000001,C0000000002 "$IMAGE" check 2>&1)" && fail "check passed with two channels"
grep -q 'SLACK_ALLOWED_CHANNELS must name exactly one channel' <<<"$out" || { echo "$out" >&2; fail "two channels are not refused by name"; }
pass "more than one channel stops the start: the bot has one main channel"

# Starts the bot in a new container on the data volume, as a workspace start does, and
# checks that the poller and exactly one gateway run in it, as hermes.
run_bot() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  start -d --name "$name" "$IMAGE" >/dev/null || fail "the image does not start ($1)"
  procs=""
  for _ in $(seq 1 30); do
    sleep 2
    [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || break
    procs="$(docker exec "$name" ps -eo user=,args= 2>/dev/null)" || continue
    grep -q 'poller.mjs' <<<"$procs" && grep -qE 'gateway run$' <<<"$procs" && break
  done
  grep -qE '^hermes .*node /opt/pm-bot/poller/poller.mjs' <<<"$procs" \
    || { docker logs "$name" 2>&1 | tail -30 >&2; fail "the poller does not run as hermes ($1)"; }
  grep -qE '^hermes .*gateway run$' <<<"$procs" || { docker logs "$name" 2>&1 | tail -30 >&2; fail "the gateway does not run as hermes ($1)"; }
  sleep 10
  procs="$(docker exec "$name" ps -eo user=,args=)"
  grep -qE '^hermes .*node /opt/pm-bot/poller/poller.mjs' <<<"$procs" \
    || { docker logs "$name" 2>&1 | tail -30 >&2; fail "the poller stopped ($1)"; }
  # Hermes' own supervised gateway runs as python -c with sys.argv[0]='hermes', the entrypoint's
  # as hermes_cli.main ... gateway run; together they must be one.
  gateways="$(grep -cE "hermes_cli.main.*gateway|sys.argv\[0\]='hermes'" <<<"$procs" || true)"
  [ "$gateways" = 1 ] || { echo "$procs" >&2; fail "$gateways gateways run, not one ($1)"; }
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] || fail "the container stopped ($1)"
  pass "one container runs the poller and exactly one gateway, as hermes ($1)"
}
run_bot "first start"
# A workspace stop kills the container without a clean exit, so the gateway's state file
# still says "running", the state a gateway connected to Slack writes. The test's gateway never
# reaches Slack, so the state is set to that after the kill. The next start must still run the
# gateway beside the poller, not hand it to Hermes' own supervisor and lose the poller.
docker kill -s KILL "$name" >/dev/null
in_data 'test -f /d/gateway_state.json && sed -i -E "s/\"gateway_state\": *\"[a-z_]+\"/\"gateway_state\": \"running\"/" /d/gateway_state.json && grep -q "\"gateway_state\": \"running\"" /d/gateway_state.json' \
  || fail "the killed gateway left no state file to restart from"
run_bot "start after the container was killed"
docker rm -f "$name" >/dev/null 2>&1 || true
[ "$(jobs)" = "30 3 * * * slack:C0000000001 composer-audit true" ] || { jobs >&2; fail "starts left more or less than one composer-audit job"; }
pass "three starts keep exactly one composer-audit job"

# A job store that exists but cannot be read is left alone: the start registers no second job.
in_data 'cp /d/cron/jobs.json /d/cron/jobs.ok && echo "{ not json" >/d/cron/jobs.json' || fail "cannot corrupt the job store"
out="$(start --rm "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed with an unreadable job store"; }
grep -qF 'pm-bot: cannot read the cron job store' <<<"$out" && grep -qF 'composer-audit is not registered' <<<"$out" \
  || { echo "$out" >&2; fail "an unreadable job store is not named with the skipped registration"; }
[ "$(in_data 'cat /d/cron/jobs.json')" = '{ not json' ] || fail "the start changed an unreadable job store"
in_data 'mv /d/cron/jobs.ok /d/cron/jobs.json' || fail "cannot restore the job store"
pass "an unreadable job store gets no second composer-audit job"

# With the audit off, a job store it cannot read is named, and the start does not claim the audit is off.
in_data 'cp /d/cron/jobs.json /d/cron/jobs.ok && echo "{ not json" >/d/cron/jobs.json' || fail "cannot corrupt the job store"
out="$(start --rm -e AUDIT_ENABLED=false "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed with AUDIT_ENABLED=false and an unreadable job store"; }
grep -qF 'pm-bot: cannot read the cron job store' <<<"$out" && grep -qF 'composer-audit may still run' <<<"$out" \
  && ! grep -qF 'the nightly composer audit is off' <<<"$out" \
  || { echo "$out" >&2; fail "AUDIT_ENABLED=false with an unreadable job store claims the audit is off"; }
in_data 'mv /d/cron/jobs.ok /d/cron/jobs.json' || fail "cannot restore the job store"
pass "AUDIT_ENABLED=false names an unreadable job store instead of claiming the audit is off"

# With the audit off, its time is not read: an invalid AUDIT_TIME does not stop the start.
out="$(start --rm -e AUDIT_ENABLED=false -e AUDIT_TIME=25:00 "$IMAGE" check 2>&1)" || { echo "$out" >&2; fail "check mode failed with AUDIT_ENABLED=false and AUDIT_TIME=25:00"; }
[ "$(grep -c 'pm-bot: the nightly composer audit is off' <<<"$out")" = 1 ] || { echo "$out" >&2; fail "AUDIT_ENABLED=false does not log one line"; }
[ -z "$(jobs)" ] || { jobs >&2; fail "AUDIT_ENABLED=false keeps the composer-audit job"; }
pass "AUDIT_ENABLED=false removes the job with one log line and ignores AUDIT_TIME"

echo "OK: pm-bot image check holds"
