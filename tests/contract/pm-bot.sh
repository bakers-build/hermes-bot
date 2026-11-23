#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lock-down and configurability contract for the Hermes PM bot.
#
#   bash tests/contract/pm-bot.sh
#
# Reads the committed configuration template statically (nothing is started)
# and asserts:
#   - every toolset that can change the system is disabled, and Slack enables
#     only the bot's own toolsets
#   - only the nightly cron job has a terminal and the channel tool: its shell starts in the
#     clone, cannot read the env or reach the web through curl or wget, and its dangerous
#     commands are denied; its answer goes out unwrapped and a missed night catches up
#   - memory writes and self-written skills wait for approval
#   - one shared session per channel, not per user, and flat replies (reply_in_thread: false)
#   - only the bot's own plugin, bot-channels, is enabled; it passes its unit tests
#   - bakers.build is reached only through its own MCP endpoint: the remote
#     server `bakers` at ${BAKERS_URL}/mcp, the API key as a static bearer that
#     Hermes fills from the env file, exactly nine bakers tools, no OAuth
#   - the config, poller, plugin, persona and fake site name only bakers tools the server
#     serves, as pm-bot-mcp-stub.mjs records them
#   - the clone reader is a pinned filesystem server with read tools only
#   - nothing in  is a relay, calls JSON:API or exchanges a token
#   - the bot's only own skill is composer-audit, whose SKILL.md alone is the nightly audit;
#     SOUL.template.md names that job and gives
#     bb-create-ticket its host context, judges with the six risk classes whether a code
#     review is advisable, proposes it without naming its cost, hands over with one of three
#     label sets (human-accept, or human-review only after the requester says yes, or
#     human-accept with review-declined), never with auto in any spelling, and carries status
#     and the answer path
#   - no bb_question tool is named anywhere in the bot
#   - every user in the allowed channels is served unless an allowlist is set
#   - poller, client and plugin call no LLM, except the plugin's language.py, which only takes
#     back a validated language code; the persona answers in the language the trusted line names
#   - Hermes posts no interim assistant message in Slack: the model's text beside its tool
#     calls stays out of the channel
#   - the Slack app neither reads nor opens direct messages, may manage public channels,
#     may react to messages and may read the requester's e-mail address
#   - the reviewer comes only from the trusted line's e-mail address; no assignee is passed
#   - persona, skill and scripts name no customer; only .env.example may
#   - the bot passes answers on without a "Correct?" confirmation round
#   - customer wording says what happens, not what a team does
#   - the env file is ignored and no committed file holds a token
#   - the bot has no install script (bin/, lib/running.sh)
#   - every image build line passes the bundle and the two pinned upstream skill contexts
#   - the template's compose service runs the image with exactly two mounts
#     (data read-write, clone read-only), no Docker socket, no .bakers.env, restart
#     unless-stopped, every capability dropped but the ones Hermes' bootstrap
#     needs, and no-new-privileges
#   - the end-to-end test's overlay (tests/e2e/compose.yaml) changes only pm-bot's command,
#     networks and depends_on, and its env file has every key of .env.example
#   - platform_toolsets.cli equals .slack, model.base_url comes from PM_BOT_MODEL_BASE_URL
#     (default Anthropic's), and mode agent runs the poller without the gateway
#   - CI's image job runs the end-to-end test on the image it built, before Publish
# Needs python3 with PyYAML.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

BOT=.
TEMPLATE="$BOT/config.template.yaml"
for f in "$TEMPLATE" "$BOT/SOUL.template.md" "$BOT/.env.example" \
         "$BOT/README.md" "$BOT/Dockerfile" "$BOT/entrypoint.sh" "$BOT/render.mjs" "$BOT/poller/poller.mjs" "$BOT/poller/diff.mjs" \
         "$BOT/poller/questions.mjs" "$BOT/poller/tickets.mjs" "$BOT/poller/channels.mjs" "$BOT/lib/bakers-client.mjs" \
         "$BOT/plugins/bot-channels/plugin.yaml" "$BOT/plugins/bot-channels/__init__.py" "$BOT/plugins/bot-channels/channels.py" \
         "$BOT/plugins/bot-channels/language.py" "$BOT/plugins/bot-channels/messages.json" \
         "$BOT/slack-app-manifest.yaml"; do
  [ -f "$f" ] || fail "$f is missing"
done
pass "pm-bot files present"

python3 - "$TEMPLATE" <<'PY' || fail "configuration template breaks the lock-down (see above)"
import sys, yaml

with open(sys.argv[1]) as fh:
    cfg = yaml.safe_load(fh)

errors = []
def need(cond, msg):
    if not cond:
        errors.append(msg)

disabled = set(cfg.get("agent", {}).get("disabled_toolsets") or [])
for ts in ["code_execution", "browser", "web", "delegation", "file", "cronjob"]:
    need(ts in disabled, f"agent.disabled_toolsets lacks {ts}")
# Hermes applies agent.disabled_toolsets to cron runs as well, so the nightly job's terminal
# is kept out of every platform list but cron's instead.
need("terminal" not in disabled, "agent.disabled_toolsets holds terminal, which would also block the nightly cron job")

allowed = {"skills", "memory", "session_search", "mcp-clone-reader", "mcp-bakers"}
platforms = cfg.get("platform_toolsets") or {}
slack_ts = set(platforms.get("slack") or [])
need(slack_ts, "platform_toolsets.slack is empty or missing")
need("mcp-bakers" in slack_ts, "platform_toolsets.slack lacks mcp-bakers")
need(slack_ts <= allowed, f"platform_toolsets.slack enables {sorted(slack_ts - allowed)}")
need(not (slack_ts & disabled), "a Slack toolset is also disabled")
need(sorted(platforms) == ["cli", "cron", "slack"], f"platform_toolsets lists {sorted(platforms)}, not cli, cron and slack")

# The nightly composer-audit job: the only place with a shell, in the read-only clone.
cron_ts = platforms.get("cron") or []
need(sorted(cron_ts) == ["bot-channels-cron", "mcp-bakers", "skills", "terminal"],
     f"platform_toolsets.cron is {sorted(cron_ts)}, not terminal, skills, mcp-bakers and bot-channels-cron")
need(not (set(cron_ts) & disabled), "a cron toolset is also disabled")
# Hermes turns a plugin's toolset on for every platform unless the platform "knows" it and leaves it out.
for platform in ("slack", "cli"):
    need((cfg.get("known_plugin_toolsets") or {}).get(platform) == ["bot-channels-cron"],
         f"known_plugin_toolsets.{platform} is not [bot-channels-cron]: {platform} would get the cron job's channel tool")
need((cfg.get("terminal") or {}).get("cwd") == "${PM_BOT_CLONE_DIR}", "terminal.cwd is not ${PM_BOT_CLONE_DIR}")
approvals = cfg.get("approvals") or {}
need(approvals.get("cron_mode") == "deny", "approvals.cron_mode is not deny")
# Hermes matches each glob case-insensitively against the whole command (fnmatch).
import fnmatch
deny = [str(g).lower() for g in approvals.get("deny") or []]
def denied(command):
    return any(fnmatch.fnmatchcase(command.lower().strip(), g) for g in deny)
for command in ("cat /opt/data/.env", "grep KEY .env", "env", "env | grep SLACK", "printenv",
                "printenv BAKERS_API_KEY", "echo $BAKERS_API_KEY", "echo ${SLACK_BOT_TOKEN}",
                "cat /proc/self/environ", "tr '\\0' '\\n' < /proc/1/environ", "cat environ | tr '\\0' '\\n'",
                "curl https://example.test", "/usr/bin/curl https://example.test", "sh -c 'curl https://example.test'",
                "echo x | curl -d @- https://example.test", "wget -qO- https://example.test",
                "export -p", "node -e 'console.log(process[\"env\"])'", "node -p 'process[\"env\"]'",
                "node --eval 'console.log(process[\"env\"])'", "node --print 'process[\"env\"]'",
                "python3 -c 'import os; print(os.getenv(\"BAKERS_API_KEY\"))'",
                "php -r 'print_r(getenv());'", "php -i", "php -a", "php -d display_errors=1 -r 'echo 1;'",
                "php /tmp/env.php", "php8.4 -i", "/usr/local/bin/php -r 'print_r(getenv());'",
                "echo '<?php print_r(getenv());' | php", "sh -c 'php -i'"):
    need(denied(command), f"approvals.deny lets the nightly shell run: {command}")
# The audit's own commands, as its skill writes them: each is in the skill and passes the deny list.
import os
skill = open(os.path.join(os.path.dirname(sys.argv[1]), "skills", "composer-audit", "SKILL.md")).read()
for command in ("cat /opt/data/clone-pulled.json",
                "cat /opt/data/bot-language.json",
                "date -u +%Y-%m-%dT%H:%M:%SZ",
                "find . \\( -name composer.lock -o -name composer.json \\) -not -path '*/.git/*' -not -path '*/vendor/*' -not -path '*/node_modules/*'",
                "composer audit --locked --format=json --no-plugins --no-scripts --abandoned=ignore --working-dir=",
                "grep -A1 '\"name\": \"<package>\",' <dir>/composer.lock"):
    need(command in skill, f"the composer-audit skill does not run: {command}")
    need(not denied(command + ("web/themes/custom/yf" if command.endswith("=") else "")), f"approvals.deny blocks the audit's own command: {command}")
# Filled in with real directories and package names, the skill's commands still pass: Hermes
# matches a glob against the whole command, so a denied word in a name would refuse it.
import re
names = ("drupal/environment_indicator", "sebastian/environment", "php-http/curl-client", "phpunit/phpunit")
dirs = (".", "./web/themes/custom/yf", "./libraries/phpmailer", "./php", "./docker/php", "./src/PHP")
for template in re.findall(r"`((?:find|composer audit|grep|cat|date) [^`]*)`", skill):
    for name in names:
        for d in dirs:
            command = template.replace("<package>", name).replace("<dir>", d)
            need(not denied(command), f"approvals.deny blocks the audit's own command for {name} in {d}: {command}")
cron_cfg = cfg.get("cron") or {}
need(cron_cfg.get("wrap_response") is False, "cron.wrap_response is not false: the run's answer would get Hermes' header")
# Hermes catches a missed daily run up within its grace window (half the period, at most two
# hours); with catch_up_missed true it would also run one found any later.
need(cron_cfg.get("catch_up_missed") is False, "cron.catch_up_missed is not false: a missed night would run at any lateness")
# The end-to-end test talks to the bot through Hermes' CLI (entrypoint.sh agent): the same
# toolsets as in Slack, so the test runs what Slack runs.
cli_ts = (cfg.get("platform_toolsets") or {}).get("cli")
need(cli_ts == (cfg.get("platform_toolsets") or {}).get("slack"), "platform_toolsets.cli is not exactly platform_toolsets.slack")
model = cfg.get("model") or {}
need(model.get("provider") == "anthropic", "model.provider is not anthropic")
need(model.get("base_url") == "${PM_BOT_MODEL_BASE_URL}", "model.base_url is not ${PM_BOT_MODEL_BASE_URL}")

need(cfg.get("memory", {}).get("write_approval") is True, "memory.write_approval is not true")
need(cfg.get("skills", {}).get("write_approval") is True, "skills.write_approval is not true")
need(cfg.get("group_sessions_per_user") is False, "group_sessions_per_user is not false")
slack = cfg.get("slack") or {}
need(slack.get("reply_in_thread") is False, "slack.reply_in_thread is not false: the bot answers flat in its channels")
need((cfg.get("plugins") or {}).get("enabled") == ["bot-channels"], "plugins.enabled is not exactly [bot-channels]")
for key in ("allow_admin_from", "group_allow_admin_from"):
    need(slack.get(key) == "${SLACK_ADMIN_USERS}", f"slack.{key} does not limit slash commands to SLACK_ADMIN_USERS")
# The model's text beside its tool calls is a working note, not an answer: it stays out of Slack.
slack_display = (((cfg.get("display") or {}).get("platforms") or {}).get("slack") or {})
need(slack_display.get("interim_assistant_messages") is False,
     "display.platforms.slack.interim_assistant_messages is not false: the agent's working notes reach the channel")

servers = cfg.get("mcp_servers") or {}
need(set(servers) == {"clone-reader", "bakers"}, f"mcp_servers are {sorted(servers)}, not clone-reader and bakers")
for name, server in servers.items():
    need("auth" not in server and "oauth" not in server, f"{name} signs in with OAuth")

reader = servers.get("clone-reader") or {}
need("url" not in reader, "clone-reader is a remote server")
args = [str(a) for a in reader.get("args") or []]
pkg = [a for a in args if a.startswith("@modelcontextprotocol/server-filesystem@")]
need(pkg and pkg[0].rsplit("@", 1)[1][:1].isdigit(), "clone-reader is not a pinned @modelcontextprotocol/server-filesystem")
need(any("${PM_BOT_CLONE_DIR}" in a for a in args), "clone-reader is not scoped to ${PM_BOT_CLONE_DIR}")
read_only = {"read_text_file", "list_directory", "directory_tree", "search_files", "get_file_info"}
rtools = set((reader.get("tools") or {}).get("include") or [])
need(rtools and rtools <= read_only, f"clone-reader includes {sorted(rtools - read_only)}")

# The bot's only way into bakers.build: the site's own MCP endpoint, the API key as a
# static bearer. Hermes fills ${env:…} from the env file; render.mjs leaves it alone,
# so the key never lands in config.yaml.
bakers = servers.get("bakers") or {}
need(bakers.get("url") == "${BAKERS_URL}/mcp", "bakers is not ${BAKERS_URL}/mcp")
need("command" not in bakers, "bakers is started as a local process")
need(bakers.get("headers") == {"Authorization": "Bearer ${env:BAKERS_API_KEY}"},
     "bakers does not send exactly Authorization: Bearer ${env:BAKERS_API_KEY}")
nine = ["tool_api__bakers_comment_create", "tool_api__bakers_conductor_list", "tool_api__bakers_ticket_classify",
        "tool_api__bakers_ticket_create", "tool_api__bakers_ticket_read", "tool_api__bakers_ticket_search",
        "tool_api__bakers_ticket_transition", "tool_api__bakers_ticket_update", "tool_api__bakers_user_read"]
need(sorted((bakers.get("tools") or {}).get("include") or []) == nine,
     "bakers does not include exactly the nine tools")

# Hermes adds resource and prompt utility calls to every MCP server unless they are switched off.
for name, server in (("clone-reader", reader), ("bakers", bakers)):
    tfilter = server.get("tools") or {}
    for family in ("resources", "prompts"):
        need(tfilter.get(family) is False, f"{name} tools.{family} is not false")

for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "configuration template keeps the lock-down"

# Every bakers tool the bot names is one the server serves. The stub's TOOLS is the recorded copy of
# the server's names; a tool the server renamed fails here, not as "Tool not found" on a box.
python3 - "$TEMPLATE" <<'PY' || fail "the bot names a bakers tool the server does not serve (see above)"
import glob, re, sys, yaml

served = set(re.findall(r"'(bakers_[a-z_]+)'", open("tests/contract/pm-bot-mcp-stub.mjs").read().split("].map(")[0]))
if len(served) < 16:
    sys.exit(f"FAIL: the stub lists {len(served)} bakers tools, not the server's sixteen")

named = []
with open(sys.argv[1]) as fh:
    include = ((yaml.safe_load(fh)["mcp_servers"]["bakers"].get("tools") or {}).get("include") or [])
named += [(sys.argv[1], name.removeprefix("tool_api__")) for name in include]
def scan(paths, pattern):
    for path in paths:
        if ".test." in path or "/test_" in path:
            continue
        named.extend((path, name) for name in re.findall(pattern, open(path).read(), re.M))
scan(sorted(glob.glob("poller/*.mjs") + glob.glob("lib/*.mjs")), r"\.tool\(\s*'(bakers_[a-z_]+)'")
scan(sorted(glob.glob("plugins/bot-channels/*.py")), r"[\"'](bakers_[a-z_]+)[\"']")
scan(["SOUL.template.md"], r"`(bakers_[a-z_]+)`")
scan(["test/site.mjs"], r"^\s*(bakers_[a-z_]+): guard\(")

errors = [f"{path} names {name}" for path, name in named if name not in served]
for source in ("poller/", "test/site.mjs"):
    if not any(path.startswith(source) for path, _ in named):
        errors.append(f"no bakers tool found in {source}; the scan no longer matches it")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "config, poller, plugin, persona and fake site name only tools the server serves"

# No relay, no JSON:API and no token exchange: bakers tools are the only way in. The end-to-end
# test's seed is the site's, not the bot's.
if [ -e "$BOT/relay" ] || git grep --untracked -nIE 'pm-relay|/jsonapi|/oauth/token|client_credentials|BAKERS_CLIENT_(ID|SECRET)|create_ticket|answer_question' -- "$BOT" ":!tests/contract" ":!tests/e2e"; then
  fail " still has the relay, a JSON:API call, a token exchange or a relay tool"
fi
pass "no relay, JSON:API call or token exchange"

# The bot's only own skill is the nightly audit's; the image ships bb-create-ticket and its
# method skills beside it.
[ "$(ls -A "$BOT/skills" 2>/dev/null)" = composer-audit ] || fail "$BOT/skills holds more or less than composer-audit"
pass "the bot's only own skill is composer-audit"

# The nightly audit's whole procedure is its skill: no script, no state file.
AUDIT="$BOT/skills/composer-audit/SKILL.md"
[ "$(ls -A "$BOT/skills/composer-audit" 2>/dev/null)" = SKILL.md ] || fail "the composer-audit skill holds more than SKILL.md"
for word in 'name: composer-audit' '"ok": true' '24 hours' composer.lock composer.json \
  'Exit code 1' 'Security updates: <n> Composer advisories (<packages>)' '`type: "chore"`' '`labels_add: ["security"]`' \
  'composer update <package> --with-dependencies' mcp_bakers__tool_api__bakers_ticket_search \
  mcp_bakers__tool_api__bakers_ticket_create bakers_ticket_update bakers_ticket_transition bakers_comment_create \
  bakers_conductor_list '${PM_BOT_PROJECT}' '${PM_BOT_TICKET_WORKFLOW}' open_request_channel 'Slack channel' '[SILENT]' \
  '`done`' '`cancelled`' 'fixed in' severity CVE 'none remain'; do
  grep -qF -- "$word" "$AUDIT" || fail "$AUDIT does not name $word"
done
for word in audit.mjs audit-state.json; do
  if grep -nF "$word" "$AUDIT"; then fail "$AUDIT still names $word"; fi
done
# The conductor is the project's only active one, never a guess among several.
grep -qF 'exactly one active conductor' "$AUDIT" || fail "$AUDIT does not limit the conductor to the project's only active one"
# A failed search knows nothing about the open ticket, so the run writes nothing.
grep -qF 'When the search fails' "$AUDIT" || fail "$AUDIT does not stop on a failed search for the audit ticket"
# The entrypoint renders the skill; any other placeholder would stop the start.
[ "$(grep -o '\${[A-Za-z_]*}' "$AUDIT" | LC_ALL=C sort -u | paste -sd, -)" = '${PM_BOT_PROJECT},${PM_BOT_TICKET_WORKFLOW}' ] \
  || fail "$AUDIT has placeholders other than \${PM_BOT_PROJECT} and \${PM_BOT_TICKET_WORKFLOW}"
if grep -niwF auto "$AUDIT"; then
  fail "$AUDIT names the label auto"
fi
pass "the composer-audit skill carries the marker gate, the audit, the ticket search, the ticket rules and the silent answer"

# The persona knows the nightly job is its fourth task, and the only one with a shell.
grep -qF '`composer-audit`' "$BOT/SOUL.template.md" || fail "SOUL.template.md does not name the nightly composer-audit job"
pass "the persona names the nightly composer-audit job"

# SOUL.md is the skill's host: its host context, the routing, status and the answer path.
SOUL="$BOT/SOUL.template.md"
[ ! -e "$BOT/SOUL.md" ] || fail "$BOT/SOUL.md is back; the entrypoint renders SOUL.template.md"
for word in bb-create-ticket 'Slack user' /archives/ labels_remove frozen 'Answered in Slack by' Question \
  'technical problem' mcp_bakers__tool_api__ bakers_ticket_search bakers_ticket_read 'your user' bakers_user_read 'not in a checkout' '${PM_BOT_PROJECT}' \
  '${PM_BOT_TICKET_WORKFLOW}' '${PM_BOT_CONDUCTOR_TEXT}' '${SLACK_WORKSPACE_URL}/archives/<channel ID>' 'trusted line' 'Slack channel'; do
  grep -qF -- "$word" "$SOUL" || fail "$SOUL does not name $word"
done
pass "SOUL.template.md gives bb-create-ticket its host context and carries status and answers"

# The hand-over: the bot judges whether a code review is advisable, proposes it without naming
# its cost (the requester already knows a review is charged), and sets human-review only after
# the requester's yes. It never hands over with auto.
for word in 'labels_add: ["human-accept", "ticket-question"]' 'labels_add: ["human-review", "ticket-question"]' \
  'labels_add: ["human-accept", "ticket-question", "review-declined"]' 'only after the requester says yes' \
  dependency 'data model' 'public interface' authentication permissions 'build, CI or deployment configuration'; do
  grep -qF -- "$word" "$SOUL" || fail "$SOUL does not name $word"
done
# The set and its condition are one adjacent phrase, and the persona names human-review once, in
# any spelling (backticks, quotes, prose, any case): the sets share a table row, so a line-based
# check would let a second, unconfirmed set through.
grep -qF 'labels_add: ["human-review", "ticket-question"]` only after the requester says yes to the review;' "$SOUL" \
  || fail "$SOUL sets human-review outside the requester's yes to the review"
[ "$(grep -oiw 'human-review' "$SOUL" | wc -l | tr -d ' ')" = 1 ] \
  || fail "$SOUL names human-review in more than the requester's yes"
# auto is not a hand-over label in any spelling or case: neither persona nor README names the word.
if grep -niwF auto "$SOUL" "$BOT/README.md"; then
  fail "persona or README names the label auto"
fi
if grep -noE '\[[^]]*"human-review"[^]]*\]' "$SOUL" "$BOT/README.md" | grep -vF '["human-review", "ticket-question"]'; then
  fail "persona or README sets human-review in another label set"
fi
if git grep -nIiw charged -- "$SOUL"; then
  fail "$SOUL tells the requester the review is charged; the proposal names what and why only"
fi
pass "the hand-over proposes a review without its cost and sets human-review only after the requester's yes, never auto"

python3 - "$BOT/slack-app-manifest.yaml" <<'PY' || fail "Slack app manifest breaks the channel contract (see above)"
import sys, yaml

with open(sys.argv[1]) as fh:
    manifest = yaml.safe_load(fh)

errors = []
scopes = set(((manifest.get("oauth_config") or {}).get("scopes") or {}).get("bot") or [])
events = set(((manifest.get("settings") or {}).get("event_subscriptions") or {}).get("bot_events") or [])
home = (manifest.get("features") or {}).get("app_home") or {}
for scope in sorted(scopes & {"im:write", "im:history", "im:read", "mpim:history", "mpim:read", "mpim:write"}): errors.append(f"bot scopes include {scope}")
for event in sorted(events & {"message.im", "message.mpim"}): errors.append(f"bot events include {event}")
if home.get("messages_tab_enabled") is not False: errors.append("app_home.messages_tab_enabled is not false")
if "channels:manage" not in scopes: errors.append("bot scopes lack channels:manage (create, invite, rename, archive)")
if "reactions:write" not in scopes: errors.append("bot scopes lack reactions:write (the eyes marker on a message in work)")
if "users:read.email" not in scopes: errors.append("bot scopes lack users:read.email (the requester's address for the reviewer)")
if not (manifest.get("settings") or {}).get("socket_mode_enabled"): errors.append("socket mode is off")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "Slack app talks in channels only, over Socket Mode, manages public channels, reacts and reads e-mail addresses"

grep -qF "the requester's e-mail address exactly as the channel's trusted line gives it" "$SOUL" && grep -qF 'reviewer_emails' "$SOUL" \
  && grep -qF 'Never pass `assignee_email`' "$SOUL" \
  || fail "$SOUL does not take the reviewer's address from the trusted line alone, or may pass assignee_email"
pass "the reviewer's address comes from the trusted line only, and no assignee is passed"

# The one skip is test_recovery.py, which needs Hermes; pm-bot-image.sh runs it in the image.
python3 -m unittest discover -s "$BOT/plugins/bot-channels" -q 2>&1 | tail -1 | grep -qxE 'OK( \(skipped=1\))?' || fail "the bot-channels plugin fails its unit tests"
pass "bot-channels plugin passes its unit tests"

# Questions are ticket comments under the Question label; the old question entity is gone.
if git grep --untracked -nIE 'bb_question|bakers_question_|client_id: *hermes|bring_in_expert|chat_thread' -- "$BOT" ":!tests/contract"; then
  fail "pm-bot names a question tool, the hermes OAuth client, the expert hand-in or the chat_thread field"
fi
pass "no question entity, OAuth client, expert hand-in or chat_thread field"

# The model endpoint defaults to Anthropic's own; only the end-to-end test points it elsewhere.
grep -qF 'export PM_BOT_MODEL_BASE_URL="${PM_BOT_MODEL_BASE_URL:-https://api.anthropic.com}"' "$BOT/entrypoint.sh" \
  || fail "entrypoint.sh does not default PM_BOT_MODEL_BASE_URL to https://api.anthropic.com"
grep -qE '^PM_BOT_MODEL_BASE_URL=' "$BOT/.env.example" || fail ".env.example does not document PM_BOT_MODEL_BASE_URL"
pass "the model endpoint is Anthropic's unless PM_BOT_MODEL_BASE_URL says otherwise"

# Mode agent runs the poller without the gateway: the end-to-end test talks to the bot through
# hermes chat. Mode run is unchanged: poller and gateway.
python3 - "$BOT/entrypoint.sh" <<'PY' || fail "entrypoint.sh's modes are wrong (see above)"
import re, sys
text = open(sys.argv[1]).read()
errors = []
usage = re.search(r'usage: entrypoint\.sh \[([a-z|]+)\]', text)
if not usage or set(usage.group(1).split("|")) != {"run", "check", "agent"}:
    errors.append("the usage line does not name exactly run, check and agent")
gateway = [m.start() for m in re.finditer(r'^hermes gateway run', text, re.M)]
if len(gateway) != 1:
    errors.append(f"hermes gateway run appears {len(gateway)} times, not once")
blocks = list(re.finditer(r'^if \[ "\$mode" = agent \]; then\n(.*?)^fi$', text, re.M | re.S))
start = [b for b in blocks if 'exec node "$BOT/poller/poller.mjs"' in b.group(1)]
if not start:
    errors.append("mode agent does not exec the poller in the foreground")
if any("gateway" in b.group(1) for b in blocks):
    errors.append("mode agent starts the gateway")
if start and gateway and start[0].start() > gateway[0]:
    errors.append("mode agent's start comes after the gateway start")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "mode agent runs the poller without the gateway; mode run keeps both"

# Every user in the allowed channels by default; SLACK_ALLOWED_USERS restricts.
grep -qF '[ -n "${SLACK_ALLOWED_USERS:-}" ] || export GATEWAY_ALLOW_ALL_USERS=true' "$BOT/entrypoint.sh" \
  || fail "entrypoint.sh does not serve every user when SLACK_ALLOWED_USERS is empty"
pass "every user in the allowed channels unless SLACK_ALLOWED_USERS is set"

# The poller starts before the plugin resets bot-language.json; a code the last run left would
# make its first pass speak that language while the plugin speaks German.
awk '/rm -f "\$DATA\/bot-language.json"/ { cleared = 1 } /poller\.mjs" &/ { started = 1; exit !cleared } END { if (!started) exit 1 }' "$BOT/entrypoint.sh" \
  || fail "entrypoint.sh does not remove bot-language.json before it starts the poller"
pass "the poller starts without the last run's language"

# The poller and the plugin relay; they never call a model, the language read included: a
# subscription token is refused on a request that is not Claude Code's own. Tests make no request.
if git grep --untracked -nIiE 'anthropic|openai|api\.claude|/v1/messages|completions' -- "$BOT/poller" "$BOT/lib" "$BOT/plugins" ":!$BOT/plugins/**/test_*.py"; then
  fail "poller, client or plugin call an LLM"
fi
pass "poller, client and plugin make no LLM call"

# The bot's language is an operator setting, named in the env file's example.
grep -qE '^PM_BOT_LANGUAGE=' "$BOT/.env.example" || fail ".env.example does not name PM_BOT_LANGUAGE"
grep -qF 'PM_BOT_LANGUAGE' "$BOT/plugins/bot-channels/language.py" || fail "language.py does not read PM_BOT_LANGUAGE"
pass "the bot's language is the PM_BOT_LANGUAGE setting"

grep -qF "the language your channel's trusted line names; German when it names none" "$SOUL" \
  || fail "$SOUL does not answer in the trusted line's language, German by default"
pass "the persona answers in the trusted line's language, German by default"

# Customer specifics live in the env file only; .env.example may show them as examples.
if git grep --untracked -nIiE 'pnf|park ?(and|&|n) ?fly' -- "$BOT" ":!tests/contract" ":!$BOT/.env.example"; then
  fail "a customer literal appears in  outside .env.example"
fi
pass "no customer literal outside .env.example"

# The bot passes a clear answer on at once; a confirmation round must not come back.
if git grep -nIiE 'correct\?|confirm' -- "$BOT/SOUL.template.md" "$BOT/README.md"; then
  fail "persona, skill or runbook asks the thread to confirm an answer before passing it on"
fi
pass "the bot passes answers on without a confirmation round"

# AI agents work the tickets through bakers.build; customer wording describes events, not a team.
if git grep -nIiwE 'team' -- "$BOT/SOUL.template.md" "$BOT/poller/messages.json"; then
  fail "customer wording credits a team"
fi
pass "customer wording says what happens, not what a team does"

# The nightly audit is configurable and documented, its shell included.
for word in AUDIT_ENABLED AUDIT_TIME TZ; do
  grep -qE "^$word=" "$BOT/.env.example" || fail "$BOT/.env.example does not show $word"
  grep -qF "\`$word\`" "$BOT/README.md" || fail "README.md does not document $word"
done
for word in composer-audit clone-pulled.json 'approvals.deny' 'AUDIT_ENABLED=false'; do
  grep -qF -- "$word" "$BOT/README.md" || fail "README.md does not explain $word"
done
for word in audit.mjs audit-state.json; do
  if grep -nF "$word" "$BOT/README.md"; then fail "README.md still names $word"; fi
done
pass "AUDIT_ENABLED, AUDIT_TIME and TZ are shown and documented, with the nightly shell"

git check-ignore -q "$BOT/.env" || fail "$BOT/.env is not ignored"
pass "$BOT/.env is ignored"

if git grep --untracked -nIE 'xox[abp]-[0-9]{6,}-|xapp-[0-9]-[0-9A-Z]{6,}|sk-ant-[a-z]+[0-9]{2}-[0-9A-Za-z_-]{20,}' -- "$BOT"; then
  fail "a committed file under $BOT holds a token"
fi
pass "no token committed under $BOT"

# The bot runs from its image; nothing installs it.
if [ -e "$BOT/bin" ] || [ -e "$BOT/lib/running.sh" ] || [ -n "$(git ls-files "$BOT/bin" "$BOT/lib/running.sh")" ]; then
  fail "$BOT/bin/ or $BOT/lib/running.sh is back"
fi
pass "no install script for the bot"

# The image's skills come from three named build contexts: bakers-build's bundle and two
# upstreams pinned by commit. Every build of the image passes them, the same way.
CONTEXTS=(--build-context bundle=https://github.com/bakers-build/bakers-build.git#next:.claude/skills/bakers-build
  --build-context superpowers=https://github.com/obra/superpowers.git#bb92a77741419a4ab5f06e711a283343f1ada0c3
  --build-context mattpocock=https://github.com/mattpocock/skills.git#d1478fcb140db0b93c0c8df17bcfd311844749d0)
for f in .github/workflows/checks.yml tests/contract/pm-bot-image.sh "$BOT/README.md"; do
  # Join continued lines, then take each docker build whose context is $BOT.
  lines="$(sed -e ':a' -e '/\\$/N; s/\\\n//; ta' "$f" | grep -E "docker build .* $BOT( |\$)" || true)"
  [ -n "$lines" ] || fail "$f has no docker build of $BOT"
  while IFS= read -r line; do
    for ((i = 1; i < ${#CONTEXTS[@]}; i += 2)); do
      grep -qF -- "${CONTEXTS[i]}" <<<"$line" || fail "an image build line lacks a pinned skill context: $f: ${CONTEXTS[i]}"
    done
  done <<<"$lines"
done
pass "every image build line passes the bundle and the pinned upstream skill contexts"

COMPOSE=compose.yaml
[ -f "$COMPOSE" ] || fail "$COMPOSE is missing"
python3 - "$COMPOSE" <<'PY' || fail "$COMPOSE breaks the container's lock-down (see above)"
import sys, yaml

with open(sys.argv[1]) as fh:
    text = fh.read()
compose = yaml.safe_load(text)

errors = []
def need(cond, msg):
    if not cond:
        errors.append(msg)

services = compose.get("services") or {}
need(list(services) == ["pm-bot"], f"services are {sorted(services)}, not one pm-bot")
svc = services.get("pm-bot") or {}
need(svc.get("image") == "${PM_BOT_IMAGE}", "the image is not ${PM_BOT_IMAGE}")
need(svc.get("restart") == "unless-stopped", "restart is not unless-stopped")
need(svc.get("env_file") in ("${PM_BOT_DATA}/.env", ["${PM_BOT_DATA}/.env"]), "env_file is not ${PM_BOT_DATA}/.env")
vols = [str(v) for v in svc.get("volumes") or []]
need(vols == ["${PM_BOT_DATA}:/opt/data", "${PM_BOT_CLONE}:/opt/clone:ro"],
     f"volumes are {vols}, not the data directory and the read-only clone")
need("docker.sock" not in text, "the Docker socket appears in the compose file")
need(".bakers.env" not in text, "the conductor's .bakers.env appears in the compose file")
for key in ("privileged", "pid", "ipc", "network_mode", "devices", "volumes_from", "user", "cgroup_parent"):
    need(key not in svc, f"{key} is set")
need(svc.get("cap_drop") == ["ALL"], "cap_drop is not [ALL]")
need(sorted(svc.get("cap_add") or []) == ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"],
     f"cap_add is {svc.get('cap_add')}, not CHOWN, DAC_OVERRIDE, SETGID, SETUID")
need("no-new-privileges:true" in (svc.get("security_opt") or []), "no-new-privileges is not set")
env = svc.get("environment") or {}
need(env.get("HERMES_UID") == "${PM_BOT_UID}" and env.get("HERMES_GID") == "${PM_BOT_GID}",
     "HERMES_UID and HERMES_GID are not the workspace user's")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "compose: two mounts (clone read-only), no Docker socket, no .bakers.env, unless-stopped, capabilities dropped"

# The end-to-end test runs production's container: its overlay changes nothing on pm-bot but the
# mode, the network and the start order, and its env file has every key the production one has.
E2E=tests/e2e/compose.yaml
E2E_ENV=tests/e2e/pm-bot.env
[ -f "$E2E" ] && [ -f "$E2E_ENV" ] || fail "$E2E or $E2E_ENV is missing"
python3 - "$E2E" "$E2E_ENV" "$BOT/.env.example" <<'PY' || fail "the end-to-end test does not run production's pm-bot (see above)"
import re, sys, yaml

overlay, env_file, example = sys.argv[1:]
errors = []
svc = ((yaml.safe_load(open(overlay)) or {}).get("services") or {}).get("pm-bot")
if svc is None:
    errors.append(f"{overlay} has no pm-bot service")
else:
    extra = sorted(set(svc) - {"command", "networks", "depends_on"})
    if extra:
        errors.append(f"{overlay} sets {extra} on pm-bot; only command, networks and depends_on may differ")
    if svc.get("command") != ["agent"]:
        errors.append(f"{overlay} runs pm-bot with {svc.get('command')}, not [agent]")
keys = lambda path: {m.group(1) for m in re.finditer(r"^([A-Z][A-Z0-9_]*)=", open(path).read(), re.M)}
missing = sorted(keys(example) - keys(env_file))
if missing:
    errors.append(f"{env_file} lacks {missing} of .env.example")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "the end-to-end test runs production's pm-bot: only mode, network and start order differ, every env key set"

# CI runs the end-to-end test on the image it built and is about to publish, before Publish.
python3 - .github/workflows/checks.yml <<'PY' || fail "CI does not run the end-to-end test on its image before publishing (see above)"
import sys, yaml

steps = (yaml.safe_load(open(sys.argv[1]))["jobs"]["image"].get("steps") or [])
names = [s.get("name") for s in steps]
runs = [str(s.get("run", "")) for s in steps]
errors = []
e2e = [i for i, r in enumerate(runs) if 'bash tests/e2e/run.sh "$IMAGE:$GITHUB_SHA"' in r]
if len(e2e) != 1:
    errors.append("the image job has no single step running bash tests/e2e/run.sh \"$IMAGE:$GITHUB_SHA\"")
elif "Publish" not in names or e2e[0] > names.index("Publish"):
    errors.append("the end-to-end test does not run before Publish")
elif steps[e2e[0]].get("if"):
    errors.append("the end-to-end test step is conditional")
for e in errors:
    print("FAIL:", e, file=sys.stderr)
sys.exit(1 if errors else 0)
PY
pass "CI runs the end-to-end test on the image it built, before Publish"

echo "OK: pm-bot lock-down and configurability contract holds"

python3 - <<'PYTEST'
from pathlib import Path
soul = Path('SOUL.template.md').read_text()
assert '[<identifier> · <title>](<url>)' in soul
assert 'Origin ticket' in soul and 'Ursprungsticket' in soul
assert 'pins:write' not in Path('slack-app-manifest.yaml').read_text()
PYTEST
pass "creation reply links identifier and title and shows stored origin; pinning excluded"
