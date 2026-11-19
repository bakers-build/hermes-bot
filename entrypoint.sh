#!/usr/bin/env bash
# The PM bot container's start, as the hermes user after Hermes' own bootstrap
# (Dockerfile). On every start it:
#   1. checks the required env (from the data directory's .env) and names what is missing;
#   2. renders config.yaml and SOUL.md, with the skill's host context, from the env (render.mjs);
#   3. puts the shipped skills (bb-create-ticket, its recipes and their method
#      skills, with the bundle files they link to, and the bot's own composer-audit, rendered
#      like the persona) and the bot-channels plugin into the data directory, replacing them,
#      and removes the retired project-manager skill; sessions, memories, learned skills, the
#      poller state and the bot's channel list stay;
#   4. registers the nightly composer-audit cron job by name (README.md › The nightly Composer
#      audit), or removes it with AUDIT_ENABLED=false;
#   5. runs the poller and the Hermes gateway. When either exits, the container exits and
#      its restart policy starts it again.
#
#   entrypoint.sh [run]   start the bot (the image's default)
#   entrypoint.sh check   steps 1-4, then print the versions, shipped skills and plugins, assert the
#                         Hermes internals the plugin relies on, test the connection to
#                         bakers.build's MCP endpoint and exit (CI's image check)
set -euo pipefail

BOT=/opt/pm-bot
DATA="${HERMES_HOME:-/opt/data}"
mode="${1:-run}"

REQUIRED=(SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_ALLOWED_CHANNELS SLACK_ADMIN_USERS
  SLACK_WORKSPACE_URL BAKERS_URL BAKERS_API_KEY PM_BOT_PROJECT
  PM_BOT_TICKET_WORKFLOW PM_BOT_MODEL PM_BOT_CLONE_DIR)
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
# The bot's own skill names the project and workflow.
node "$BOT/render.mjs" "$BOT/skills/composer-audit/SKILL.md" "$DATA/skills/composer-audit/SKILL.md"
# The bot's plugin, replaced on every start.
mkdir -p "$DATA/plugins"
rm -rf "$DATA/plugins/bot-channels.new"
cp -R "$BOT/plugins/bot-channels" "$DATA/plugins/bot-channels.new"
rm -rf "$DATA/plugins/bot-channels"
mv "$DATA/plugins/bot-channels.new" "$DATA/plugins/bot-channels"

# The nightly composer-audit job, kept to one by its name. Hermes' cron CLI writes the job store
# directly; the gateway's scheduler runs it. The first line lists the jobs' IDs, the second the
# first job's schedule. A missing store has no jobs; an unreadable one is named, and the start
# leaves it and the job alone, so it never adds a second job beside one it cannot see.
audit_store_ok=true
audit_store="$(node -e '
  const fs = require("fs");
  if (!fs.existsSync(process.argv[1])) process.exit(0);
  try {
    const jobs = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).jobs.filter((job) => job.name === "composer-audit");
    console.log(jobs.map((job) => job.id).join(" "));
    console.log(jobs[0]?.schedule?.expr ?? "");
  } catch (error) {
    console.error(`pm-bot: cannot read the cron job store: ${error.message}`);
    process.exit(2);
  }' "$DATA/cron/jobs.json")" || audit_store_ok=false
read -r -a audit_jobs <<<"$(sed -n 1p <<<"$audit_store")"
audit_scheduled="$(sed -n 2p <<<"$audit_store")"
case "${AUDIT_ENABLED:-true}" in
  false|0|no|off)
    # Off is logged only when no job is left; a store it cannot read or a job it cannot remove is named.
    audit_off="$audit_store_ok"
    for job in "${audit_jobs[@]}"; do
      hermes cron remove "$job" >/dev/null || { echo "pm-bot: cannot remove cron job $job" >&2; audit_off=false; }
    done
    if [ "$audit_off" = true ]; then
      echo "pm-bot: the nightly composer audit is off (AUDIT_ENABLED=${AUDIT_ENABLED})"
    else
      echo "pm-bot: AUDIT_ENABLED=${AUDIT_ENABLED}, but composer-audit may still run: fix or remove $DATA/cron/jobs.json and restart" >&2
    fi ;;
  *)
    # The nightly audit's time, HH:MM in the container's time zone (TZ); read only when it runs.
    AUDIT_TIME="${AUDIT_TIME:-03:30}"
    [[ "$AUDIT_TIME" =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]] \
      || { echo "pm-bot: AUDIT_TIME must be HH:MM between 00:00 and 23:59, not $AUDIT_TIME" >&2; exit 1; }
    audit_schedule="$((10#${BASH_REMATCH[2]})) $((10#${BASH_REMATCH[1]})) * * *"
    if [ "$audit_store_ok" = false ]; then
      echo "pm-bot: composer-audit is not registered: fix or remove $DATA/cron/jobs.json and restart" >&2
    else
      audit_prompt="Run the nightly Composer security audit of the project's clone with your skill composer-audit, exactly as it says."
      audit_args=(--name composer-audit --deliver "slack:$SLACK_ALLOWED_CHANNELS" --skill composer-audit)
      for job in "${audit_jobs[@]:1}"; do hermes cron remove "$job" >/dev/null || true; done
      if [ ${#audit_jobs[@]} -gt 0 ]; then
        # A schedule passed to Hermes recomputes the due time from now, so a night missed while the
        # container was down would never catch up: it is passed only when AUDIT_TIME changed.
        audit_reschedule=()
        [ "$audit_scheduled" = "$audit_schedule" ] || audit_reschedule=(--schedule "$audit_schedule")
        hermes cron edit "${audit_jobs[0]}" "${audit_args[@]}" "${audit_reschedule[@]}" --prompt "$audit_prompt" >/dev/null
      else
        hermes cron create "${audit_args[@]}" "$audit_schedule" "$audit_prompt" >/dev/null
      fi && echo "pm-bot: composer-audit at $audit_schedule (${TZ:-UTC})" \
        || echo "pm-bot: cannot register the composer-audit cron job; the nightly audit does not run" >&2
    fi ;;
esac

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
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools
for platform in ("cron", "slack"):
    print(f"toolsets {platform}: " + ",".join(sorted(_get_platform_tools(load_config(), platform))))
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
[ "$mode" = run ] || { echo "usage: entrypoint.sh [run|check]" >&2; exit 2; }

pids=()
stop() { kill -TERM "${pids[@]}" 2>/dev/null || true; }
trap stop TERM INT
# German until the plugin writes this run's language; the poller starts before the plugin.
rm -f "$DATA/bot-language.json"
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
