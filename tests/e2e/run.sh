#!/usr/bin/env bash
# The PM bot's end-to-end test: a bakers.build site, the bot's image, a conductor, a scripted model
# and a Slack recorder in Docker (tests/e2e/compose.yaml on top of compose.yaml). It needs Docker
# and this clone; no Slack, bakers.build or model credentials.
#
#   tests/e2e/run.sh [IMAGE] [--real] [--keep] [--only <scenario>]
#       start the stack, seed the site, run every scenario (or one), tear down. Without IMAGE the
#       working copy is built. Exits non-zero naming each failed scenario; the stack's logs, the
#       model's turns, the Slack calls and the poller's state are then in tests/e2e/out/.
#       --real   a real model for the bot and Claude Code for the conductor, from
#                ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; a failure may then be the model's
#       --keep   leave the stack running afterwards (tests/e2e/run.sh down removes it)
#
#   tests/e2e/run.sh up [IMAGE] [--real]   start and seed the stack for testing by hand, run no
#                                          scenario; print the site's URL and login links. Needs a
#                                          model key: talking to the bot by hand needs a real model.
#   tests/e2e/run.sh chat                  talk to the bot as the requester (hermes chat)
#   tests/e2e/run.sh slack                 follow the Slack calls the poller makes
#   tests/e2e/run.sh agent <ticket> <script>   the stub agent's next run on <ticket> plays
#                                          tests/e2e/agent/<script>.json (question, technical-problem, …)
#   tests/e2e/run.sh login                 print a login link per seeded account
#   tests/e2e/run.sh down                  remove the stack and its volumes
#
# In the ddev project (.ddev/), `ddev e2e up` (later also `ddev start`) runs the same stack: it and
# ddev's hooks call `ddev-check` and `ddev-seed` here, and `ddev e2e <subcommand>` runs chat, slack,
# agent and login with E2E_DDEV=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="$ROOT/tests/e2e"
OUT="$E2E/out"
PROJECT=pm-bot-e2e
COMPOSE=(-p "$PROJECT" -f "$ROOT/compose.yaml" -f "$E2E/compose.yaml")
STATE="$OUT/stack.env"
# The site's one host name: nginx here, the ddev project's under ddev.
SITE_HOST=nginx
if [ "${E2E_DDEV:-}" = 1 ]; then
  # ddev's own merge of .ddev/docker-compose.e2e.yaml, every variable filled.
  COMPOSE=(-p ddev-hermes-bot -f "$ROOT/.ddev/.ddev-docker-compose-full.yaml")
  SITE_HOST=hermes-bot.ddev.site
fi

say() { echo "e2e: $*" >&2; }
die() { echo "e2e: $*" >&2; exit 1; }

dc() { docker compose "${COMPOSE[@]}" "$@"; }

# The variables both compose files read; stack.env keeps them for the subcommands after `up`.
export_stack() {
  export PM_BOT_IMAGE="$1" PM_BOT_DATA="$OUT/data" PM_BOT_CLONE="$OUT/clone" PM_BOT_UID="$(id -u)" PM_BOT_GID="$(id -g)" \
    E2E_AGENT="$OUT/agent" E2E_CONDUCTOR="$OUT/conductor" E2E_CONDUCTOR_AGENT="$2" BAKERS_VERSION="${BAKERS_VERSION:-0.11.0}"
}
load_stack() {
  [ -f "$STATE" ] || die "no stack; start one with tests/e2e/run.sh up (or ddev start)"
  # shellcheck disable=SC1090
  source "$STATE"
  [ "${E2E_DDEV:-}" = 1 ] || export_stack "$IMAGE" "$AGENT"
}

# The working copy's image, built as CI builds it.
build_image() {
  local tag=pm-bot:e2e
  say "building $tag from the working copy"
  docker build -t "$tag" \
    --build-context bundle=https://github.com/bakers-build/bakers-build.git#next:.claude/skills/bakers-build \
    --build-context superpowers=https://github.com/obra/superpowers.git#bb92a77741419a4ab5f06e711a283343f1ada0c3 \
    --build-context mattpocock=https://github.com/mattpocock/skills.git#d1478fcb140db0b93c0c8df17bcfd311844749d0 "$ROOT" >&2
  echo "$tag"
}

# A request on the site from the host: it answers only to its one host name.
site_up() {
  local port
  port="$(dc port nginx 80 2>/dev/null | sed 's/.*://')" || return 1
  [ -n "$port" ] && curl -fsS -o /dev/null -H "Host: $SITE_HOST" "http://127.0.0.1:$port/user/login"
}

# seed <scripted|real>: wait for the site, seed it, and write the bot's env file and the
# conductor's seed. Each step returns on failure: callers run it in `||` lists, without errexit.
seed() {
  local mode="$1" tries=0
  until site_up; do
    tries=$((tries + 1))
    [ "$tries" -lt 150 ] || { say "the site did not answer within 5 minutes"; return 1; }
    sleep 2
  done
  say "seeding the site"
  dc exec -T php /var/www/html/vendor/bin/drush php:script /e2e/seed.php >"$OUT/seed.json" || return
  local key token base
  key="${ANTHROPIC_API_KEY:-}" token="${CLAUDE_CODE_OAUTH_TOKEN:-}" base=http://model/anthropic
  if [ "$mode" = scripted ]; then key=e2e-scripted token= ; else base=https://api.anthropic.com; fi
  node - "$E2E/pm-bot.env" "$OUT/seed.json" "$OUT/data/.env" "$base" "$key" "$token" "http://$SITE_HOST" <<'NODE'
const fs = require('node:fs');
const [template, seedFile, target, base, key, token, site] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const values = {
  PM_BOT_MODEL_BASE_URL: base, ANTHROPIC_API_KEY: key, CLAUDE_CODE_OAUTH_TOKEN: token, BAKERS_URL: site,
  BAKERS_API_KEY: seed.bot_api_key, PM_BOT_PROJECT: seed.project_uuid, PM_BOT_CONDUCTOR: seed.conductor_uuid,
};
const text = fs.readFileSync(template, 'utf8').replace(/^(\w+)=@(\w+)@$/gm, (_, key, name) => {
  if (!(name in values)) throw new Error(`pm-bot.env fills ${key} from ${name}, which run.sh does not know`);
  return `${key}=${values[name]}`;
});
fs.writeFileSync(target, text, { mode: 0o600 });
NODE
  [ $? = 0 ] || return 1
  cp "$OUT/seed.json" "$OUT/conductor/seed.json" || return
}

# A one-time login link per seeded account, on the site's address as the browser reaches it.
logins() {
  local uri="$1" who name
  for who in owner requester; do
    name="$(node -p "require('$OUT/seed.json').${who}_user_name")"
    echo "Login as $who ($name): $(dc exec -T php /var/www/html/vendor/bin/drush user:login --name="$name" --uri="$uri")"
  done
}

# The site's address in the browser.
site_url() {
  if [ "${E2E_DDEV:-}" = 1 ]; then
    echo "https://$SITE_HOST:33443"
  else
    echo "http://nginx:$(dc port nginx 80 | sed 's/.*://')"
  fi
}

# start <image> <scripted|real> <stub|claude>: the bot's model and the conductor's agent. Each step
# returns on failure: the caller's `|| status=$?` switches errexit off in here.
start() {
  local image="$1" mode="$2" agent="$3"
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$OUT"
  mkdir -p "$OUT/data" "$OUT/clone" "$OUT/agent" "$OUT/conductor"
  # The clone the bot's clone-reader sees: any project's code; this repository's README will do.
  cp "$ROOT/README.md" "$OUT/clone/"
  export_stack "$image" "$agent"
  printf 'IMAGE=%q\nAGENT=%q\nMODE=%q\n' "$image" "$agent" "$mode" >"$STATE"

  say "starting the site (bakers.build $BAKERS_VERSION), the model and the Slack recorder"
  dc up -d nginx model slack-recorder >&2 || return
  seed "$mode" || return

  say "starting the bot (mode agent) and the conductor"
  dc up -d --build pm-bot conductor >&2
}

# Everything a failed run leaves for its reader.
collect() {
  mkdir -p "$OUT/logs"
  dc logs --no-color --timestamps >"$OUT/logs/compose.log" 2>&1 || true
  local service port
  for service in model slack-recorder; do
    port="$(dc port "$service" 80 2>/dev/null | sed 's/.*://')" || continue
    case "$service" in
      model) curl -fsS "http://127.0.0.1:$port/_log" >"$OUT/logs/model-turns.json" || true ;;
      slack-recorder) curl -fsS "http://127.0.0.1:$port/_calls" >"$OUT/logs/slack-calls.json" || true ;;
    esac
  done
  cp "$OUT/data/poller-state.json" "$OUT/logs/" 2>/dev/null || true
  say "logs in $OUT/logs"
}

scenarios() {
  local only="$1" mode="$2" files=()
  if [ -n "$only" ]; then
    files=("$E2E/scenarios/$only.e2e.mjs")
    [ -f "${files[0]}" ] || die "no scenario $only (tests/e2e/scenarios/$only.e2e.mjs)"
  else
    files=("$E2E"/scenarios/*.e2e.mjs)
  fi
  local status=0
  E2E_OUT="$OUT" E2E_MODE="$mode" E2E_COMPOSE="$(printf '%s\n' "${COMPOSE[@]}" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8").trim().split("\n")))')" \
    node --test --test-concurrency=1 --test-reporter=spec "${files[@]}" || status=$?
  # No Slack: nothing in the bot's container reached slack.com (Hermes logs each Slack API error).
  if grep -rlF 'slack.com/api' "$OUT/data/logs" >&2; then
    say "the bot called slack.com (see the logs above)"
    status=1
  fi
  return "$status"
}

model_mode() {
  if [ "$1" = 1 ]; then
    [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || die "--real needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
    echo real
  else
    echo scripted
  fi
}

case "${1:-}" in
  up)
    shift
    image="" real=0
    for arg in "$@"; do
      case "$arg" in
        --real) real=1 ;;
        -*) die "unknown option $arg" ;;
        *) image="$arg" ;;
      esac
    done
    # Talking to the bot by hand needs a real model; the scripted one answers only scenarios.
    [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || die "up needs a model key: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
    [ -n "$image" ] || image="$(build_image)"
    # The bot talks to the real model; --real also gives the conductor Claude Code.
    agent=stub
    [ "$real" = 1 ] && agent=claude
    start "$image" real "$agent"
    # The site answers only to the host name nginx.
    echo "Site: $(site_url) (add '127.0.0.1 nginx' to /etc/hosts once)"
    logins "$(site_url)"
    echo "Next: tests/e2e/run.sh chat | slack | agent <ticket> <script> | login | down"
    ;;
  login)
    load_stack
    echo "Site: $(site_url)"
    logins "$(site_url)"
    ;;
  ddev-up)
    # `ddev e2e up`: what ddev needs before it can read the stack, then `ddev start`. ddev reads the
    # compose files, the bot's env file among them, before its first hook runs.
    "$0" ddev-check
    exec ddev start
    ;;
  ddev-check)
    # `ddev e2e up` and ddev's pre-start hook: the model key, the bot's image, the run directory.
    if [ -f "$ROOT/.ddev/.env.e2e" ]; then set -a; . "$ROOT/.ddev/.env.e2e"; set +a; fi
    [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] \
      || die "the ddev stack needs a model key: put ANTHROPIC_API_KEY=… or CLAUDE_CODE_OAUTH_TOKEN=… into .ddev/.env.e2e"
    image="$(sed -n 's/^PM_BOT_IMAGE=//p' "$ROOT/.ddev/e2e.env")"
    docker image inspect "$image" >/dev/null 2>&1 || [ "$(build_image)" = "$image" ] || die "could not build $image"
    mkdir -p "$OUT/data" "$OUT/clone" "$OUT/agent" "$OUT/conductor"
    [ -f "$OUT/clone/README.md" ] || cp "$ROOT/README.md" "$OUT/clone/"
    # Compose needs the bot's env file to exist; ddev-seed writes it.
    [ -f "$OUT/data/.env" ] || : >"$OUT/data/.env"
    ;;
  ddev-seed)
    # ddev's post-start hook: seed the site, then start the bot and the conductor on it.
    [ "${E2E_DDEV:-}" = 1 ] || die "ddev-seed runs in ddev's post-start hook"
    set -a; . "$ROOT/.ddev/.env.e2e"; set +a
    agent="$(sed -n 's/^E2E_CONDUCTOR_AGENT=//p' "$ROOT/.ddev/e2e.env")"
    printf 'IMAGE=%q\nAGENT=%q\nMODE=real\n' "$(sed -n 's/^PM_BOT_IMAGE=//p' "$ROOT/.ddev/e2e.env")" "$agent" >"$STATE"
    seed real || die "seeding the site failed"
    # Claude Code's key, should the conductor run it (E2E_CONDUCTOR_AGENT=claude in .ddev/e2e.env).
    (umask 077 && grep -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' "$ROOT/.ddev/.env.e2e" >"$OUT/conductor/model.env")
    # ddev's merged file holds the bot's env file as it was at ddev's start; merge again with the
    # keys just written.
    (umask 077 && ddev debug compose-config >"$OUT/ddev-compose.yaml") || die "ddev debug compose-config failed"
    docker compose -p ddev-hermes-bot -f "$OUT/ddev-compose.yaml" --profile seeded up -d --build --force-recreate pm-bot conductor >&2
    echo "Site: $(site_url)"
    logins "$(site_url)"
    echo "Next: ddev e2e chat | slack | agent <ticket> <script> | login"
    ;;
  chat)
    load_stack
    [ "$MODE" = real ] || die "chat needs a stack started with a model key (tests/e2e/run.sh up)"
    # A fresh request channel per chat, recorded as the bot-channels plugin records the channels it
    # opens, so the poller renames, archives and reopens it.
    email="$(node -p "require('$OUT/seed.json').requester_email")"
    channel="$(node -e '
      const fs = require("node:fs");
      const [file, email] = process.argv.slice(1);
      let bot = {};
      try { bot = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const n = Object.keys(bot).filter((id) => id.startsWith("C0HAND")).length + 1;
      const channel = `C0HAND${String(n).padStart(5, "0")}`;
      bot[channel] = { name: `req-hand-test-${n}`, requester: "U0E2EREQ", created: new Date().toISOString(), requester_email: email };
      fs.writeFileSync(file, JSON.stringify(bot, null, 2));
      console.log(channel);
    ' "$OUT/data/bot-channels.json" "$email")"
    cat <<TEXT
Hermes adds no Slack context here: start with the channel's trusted line and the requester's
prefix, as the gateway and the bot-channels plugin would, for example:

This is the request channel $channel. Its conversation link is https://e2e.slack.com/archives/$channel. Its ticket: none yet. Its requester's e-mail address: $email. Answer in the language with ISO 639-1 code en.
[Requester | Slack user <@U0E2EREQ>] We need a login page for members.

TEXT
    exec docker compose "${COMPOSE[@]}" exec -u hermes -w /opt/data pm-bot hermes chat
    ;;
  slack)
    load_stack
    port="$(dc port slack-recorder 80 | sed 's/.*://')"
    exec node -e '
      const url = `http://127.0.0.1:${process.argv[1]}/_calls`;
      let seen = 0;
      setInterval(async () => {
        const calls = await (await fetch(url)).json();
        for (const c of calls.slice(seen)) {
          const what = [c.body.channel, c.body.name, c.body.users].filter(Boolean).join(" ");
          console.log(`${new Date(c.at).toISOString()} ${c.method} ${what}${c.body.text ? "\n  " + c.body.text.replace(/\n/g, "\n  ") : ""}`);
        }
        seen = calls.length;
      }, 2000);
    ' "$port"
    ;;
  agent)
    load_stack
    [ $# -eq 3 ] || die "usage: tests/e2e/run.sh agent <ticket identifier> <script>"
    [ -f "$E2E/agent/$3.json" ] || die "no agent script $3 (tests/e2e/agent/$3.json)"
    cp "$E2E/agent/$3.json" "$OUT/agent/$2.json"
    echo "The stub agent's next run on $2 plays $3."
    ;;
  down)
    # Compose reads the files' variables even to remove the stack.
    export_stack none stub
    dc down -v --remove-orphans
    rm -rf "$OUT"
    ;;
  *)
    image="" real=0 keep=0 only=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --real) real=1 ;;
        --keep) keep=1 ;;
        --only) shift; only="${1:?--only needs a scenario}" ;;
        -*) die "unknown option $1" ;;
        *) image="$1" ;;
      esac
      shift
    done
    mode="$(model_mode "$real")"
    [ -n "$image" ] || image="$(build_image)"
    status=0
    trap '[ "$keep" = 1 ] || dc down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
    agent=stub
    [ "$mode" = real ] && agent=claude
    start "$image" "$mode" "$agent" || status=$?
    [ "$status" = 0 ] && { scenarios "$only" "$mode" || status=$?; }
    if [ "$status" != 0 ]; then
      collect
      say "FAILED (exit $status); see the failed scenarios above"
    else
      say "every scenario passed"
    fi
    exit "$status"
    ;;
esac
