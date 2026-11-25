"""The PM bot's conversations, as a Hermes plugin (README.md › How it works), in one chat mode per bot
(PM_BOT_CHAT): Slack (slack.py, below) or GitLab issues (gitlab.py, its own docstring). Both modes
share the core (channels.py: state files, trusted lines, texts; language.py) and the recovery.

On Slack:
- Intake: a mention of the bot at the top of its channel (SLACK_ALLOWED_CHANNELS, one ID) opens
  a public request channel, invites the sender, acknowledges the request there, links it in a
  flat reply and hands the message on to Hermes there. The bot's channel itself holds no
  conversation.
- Reaction: a served user's message in an open channel joins Hermes' eyes lifecycle (Hermes
  runs it only for mentions); the final ✅/❌ is dropped.
- Admission: Hermes answers only in the bot's channel and in its open channels, the request
  channels this plugin opened plus the poller's reopen channels, minus the archived ones; in an
  open channel without a mention.
- Channel prompt: each open channel gets a trusted line with its ID, conversation link,
  ticket and requester's e-mail address, which the model cannot see otherwise, and the bot's
  language; the main channel gets the language alone. The address comes from Slack's users.info
  (scope users:read.email) when the request channel opens; without it the line says none.
- Language: PM_BOT_LANGUAGE in the container's env, read once at start (language.py), German
  when unset or not an ISO 639-1 code; it also picks the plugin's own texts (messages.json).
- Recovery: a requester's turn that a hard restart left unknown settles as interrupted on the
  channel's next message instead of pausing the conversation; it is not run again.
- Nightly audit: the tool ``open_request_channel`` (toolset ``bot-channels-cron``, which only the
  cron job has) opens a request channel for the ticket the composer-audit job created, with the
  intake's code and no requester, and returns its link for the ticket.

This plugin writes $HERMES_HOME/conversations.json (moving the Slack channels of bot-channels.json
there once), bot-language.json (the bot's language for the poller's texts) and, on GitLab,
gitlab-webhook.json; the poller writes poller-state.json. Each reads the other's files and writes
only its own.
"""

import logging
import os

from .channels import DATA, migrate
from .slack import OPEN_REQUEST_CHANNEL, factory, open_request_channel_tool

logger = logging.getLogger("pm_bot.bot_channels")


def register(ctx):
    try:
        migrate(DATA)
    except Exception as exc:
        logger.error("bot-channels: bot-channels.json not moved to conversations.json: %s", exc)
    # One chat mode per bot (PM_BOT_CHAT, default slack).
    if (os.environ.get("PM_BOT_CHAT") or "slack") == "gitlab":
        from . import gitlab
        gitlab.register(ctx)
    else:
        ctx.register_platform_handler("slack", factory)
        ctx.register_tool(name="open_request_channel", toolset="bot-channels-cron", schema=OPEN_REQUEST_CHANNEL,
                          handler=open_request_channel_tool, is_async=True, emoji="#")
    # A requester cannot run /hermes discard here, so a turn lost in a hard restart settles like
    # Hermes' automation turns: interrupted, not replayed. entrypoint.sh check asserts the seam.
    import gateway.session_unattended_unknown as unattended
    unattended._unattended_unknown = lambda rows: [row for row in rows if row["status"] == "unknown"]
