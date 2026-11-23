#!/usr/bin/env bash
# The PM bot container's start, as the hermes user after Hermes' own bootstrap
# (Dockerfile). On every start it:
#   1. checks the required env (from the data directory's .env) and names what is missing;
#   2. renders config.yaml and SOUL.md, with the skill's host context, from the env (render.mjs);
#   3. puts the shipped skills (bb-create-ticket, its recipes and their method
#      skills, with the bundle files they link to) and the bot-channels plugin into the data
#      directory, replacing them, and removes the retired project-manager skill; sessions,
#      memories, learned skills, the poller state and the bot's channel list stay;
#   4. runs the poller and the Hermes gateway (mode agent: the poller only). When either exits,
#      the container exits and its restart policy starts it again.
#
#   entrypoint.sh [run]   start the bot (the image's default)
#   entrypoint.sh check   steps 1-3, then print the versions, shipped skills and plugins, assert the
#                         Hermes internals the plugin relies on, test the connection to
#                         bakers.build's MCP endpoint and exit (CI's image check)
#   entrypoint.sh agent   steps 1-3 without Slack, then only the poller, in the foreground; no
#                         gateway of its own. The end-to-end test (tests/e2e) talks to the bot
#                         through `hermes chat` in the container, which brings up Hermes' gateway
#                         for the CLI (no Slack without Slack tokens), and records the poller's
#                         Slack calls.
set -euo pipefail

BOT=/opt/pm-bot
DATA="${HERMES_HOME:-/opt/data}"
mode="${1:-run}"
case "$mode" in
  run | check | agent) ;;
  *) echo "usage: entrypoint.sh [run|check|agent]" >&2; exit 2 ;;
esac

REQUIRED=(BAKERS_URL BAKERS_API_KEY PM_BOT_PROJECT PM_BOT_TICKET_WORKFLOW PM_BOT_MODEL PM_BOT_CLONE_DIR)
if [ "$mode" = agent ]; then
  # No Slack: the configuration and the poller still name these keys, so an empty one gets an
  # inert value. The poller's calls go to SLACK_API_URL.
  export SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-xoxb-agent}" SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-xapp-agent}" \
    SLACK_ALLOWED_CHANNELS="${SLACK_ALLOWED_CHANNELS:-C0000000000}" SLACK_ADMIN_USERS="${SLACK_ADMIN_USERS:-U0000000000}" \
    SLACK_WORKSPACE_URL="${SLACK_WORKSPACE_URL:-https://slack.invalid}"
else
  # The Slack keys first, as the missing ones are named in that order.
  REQUIRED=(SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_ALLOWED_CHANNELS SLACK_ADMIN_USERS SLACK_WORKSPACE_URL "${REQUIRED[@]}")
fi
missing=()
for key in "${REQUIRED[@]}"; do
  [ -n "${!key:-}" ] || missing+=("$key")
done
[ ${#missing[@]} -eq 0 ] || { echo "pm-bot: missing: ${missing[*]}" >&2; exit 1; }
# The bot has one channel, where a mention opens a request channel; the plugin admits the
# request channels beside it by ID.
case "$SLACK_ALLOWED_CHANNELS" in
  *[,\ ]*) echo "pm-bot: SLACK_ALLOWED_CHANNELS must name exactly one channel" >&2; exit 1 ;;
esac

# Every user in the allowed channels, unless an allowlist names some.
[ -n "${SLACK_ALLOWED_USERS:-}" ] || export GATEWAY_ALLOW_ALL_USERS=true
# The conductor is optional; the render refuses empty values, so SOUL.md reads "none".
export PM_BOT_CONDUCTOR_TEXT="${PM_BOT_CONDUCTOR:-none}"
# Anthropic's own endpoint unless the env names another (the end-to-end test's scripted model).
export PM_BOT_MODEL_BASE_URL="${PM_BOT_MODEL_BASE_URL:-https://api.anthropic.com}"

node "$BOT/render.mjs" "$BOT/config.template.yaml" "$DATA/config.yaml"
node "$BOT/render.mjs" "$BOT/SOUL.template.md" "$DATA/SOUL.md"
# The shipped skills replace their copies, entry by entry; learned skills stay. The bot's
# own project-manager skill gave way to them.
mkdir -p "$DATA/skills"
shipped=()
for src in "$BOT/skills"/* "$BOT/skills"/.claude-plugin; do
  entry="$DATA/skills/${src##*/}"
  rm -rf "$entry.new"
  cp -R "$src" "$entry.new"
  rm -rf "$entry"
  mv "$entry.new" "$entry"
  [ -f "$src/SKILL.md" ] && shipped+=("${src##*/}")
done
rm -rf "$DATA/skills/project-manager"
# The bot's plugin, replaced on every start.
mkdir -p "$DATA/plugins"
rm -rf "$DATA/plugins/bot-channels.new"
cp -R "$BOT/plugins/bot-channels" "$DATA/plugins/bot-channels.new"
rm -rf "$DATA/plugins/bot-channels"
mv "$DATA/plugins/bot-channels.new" "$DATA/plugins/bot-channels"

if [ "$mode" = check ]; then
  version="$(hermes --version)"
  echo "${version%%$'\n'*}"
  echo "node $(node --version)"
  echo "bakers skills $(node -p 'require(process.argv[1]).version' "$BOT/skills/.claude-plugin/plugin.json")"
  echo "skills: $(printf '%s\n' "${shipped[@]}" | LC_ALL=C sort | paste -sd, -)"
  # The plugins Hermes loads, and the Hermes internals bot-channels relies on: a Hermes
  # upgrade that moves one fails here instead of silently in Slack.
  (cd /opt/hermes && .venv/bin/python - <<'PY'
import inspect
from gateway.platforms.base import resolve_channel_prompt
from hermes_cli.plugins import PluginContext, get_plugin_manager
from plugins.platforms.slack.adapter import SlackAdapter

manager = get_plugin_manager()
manager.discover_and_load()
ours = sorted(p.manifest.name for p in manager._plugins.values() if p.enabled and p.manifest.source == "user")
print("plugins: " + ",".join(ours))
assert any(name == "bot-channels" for _, name in manager.get_platform_handler_factories("slack")), "bot-channels registered no Slack handler"
assert inspect.iscoroutinefunction(SlackAdapter._handle_slack_message), "SlackAdapter._handle_slack_message is gone"
for helper in ("_track_reacting_message", "_event_team_id"):
    assert callable(getattr(SlackAdapter, helper, None)), f"SlackAdapter.{helper} is gone"
assert inspect.iscoroutinefunction(SlackAdapter.on_processing_complete), "SlackAdapter.on_processing_complete is gone"
from gateway.platforms.event import ProcessingOutcome
assert "CANCELLED" in ProcessingOutcome.__members__, "ProcessingOutcome.CANCELLED is gone"
for getter in ("_slack_allowed_channels", "_slack_free_response_channels"):
    assert callable(getattr(SlackAdapter, getter, None)), f"SlackAdapter.{getter} is gone"
assert "channel_prompts" in inspect.getsource(resolve_channel_prompt), "resolve_channel_prompt no longer reads channel_prompts"
assert callable(getattr(PluginContext, "register_platform_handler", None)), "PluginContext.register_platform_handler is gone"
import gateway.session_unattended_unknown as unattended
from gateway.session_authority import SessionAuthority
lost = {"status": "unknown", "principal_id": "slack:U1", "payload": {}}
assert unattended._unattended_unknown([lost]) == [lost], "a requester's lost turn is not settled: bot-channels did not take over _unattended_unknown"
assert "settle_unattended_unknown" in inspect.getsource(SessionAuthority._claim_with_retry), "SessionAuthority._claim_with_retry no longer settles a lost turn"
print("plugin seams: ok")
PY
  )
  # bakers.build's MCP endpoint exactly as the rendered config reaches it, with the key
  # Hermes fills from the env file: connected ...
  hermes mcp test bakers
  # ... and the tools Hermes registers from it, through its own include filter.
  (cd /opt/hermes && .venv/bin/python - <<'PY'
from hermes_cli.mcp_config import _get_mcp_servers, _probe_single_server
from tools.mcp_tool_registration import _make_tool_filter

config = _get_mcp_servers()["bakers"]
keep = _make_tool_filter("bakers", config)
names = sorted(name for name, _ in _probe_single_server("bakers", config) if keep(name))
print("bakers tools: " + ",".join(names))
PY
  )
  exit 0
fi

# German until the plugin writes this run's language; the poller starts before the plugin.
rm -f "$DATA/bot-language.json"
if [ "$mode" = agent ]; then
  exec node "$BOT/poller/poller.mjs"
fi

pids=()
stop() { kill -TERM "${pids[@]}" 2>/dev/null || true; }
trap stop TERM INT
node "$BOT/poller/poller.mjs" &
pids+=($!)
hermes gateway run &
pids+=($!)
status=0
wait -n "${pids[@]}" || status=$?
echo "pm-bot: a process exited ($status); stopping the container" >&2
stop
wait || true
exit "$status"
