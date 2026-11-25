"""The bot-channels plugin's Slack side: the intake in the bot's channel, the request channels'
admission, reaction and trusted lines, and the nightly audit's channel tool (README.md › How it
works). The shared core is channels.py and language.py."""

import asyncio
import json
import logging
import os
import re
import threading
from datetime import datetime, timezone

from . import language
from .channels import CONVERSATIONS_FILE as BOT_FILE, DEFAULT_LANGUAGE, LANGUAGE_FILE, POLLER_FILE, channel_prompt, language_prompt, open_channels, read_json, request_channel_name, text, ticket_error, write_json

logger = logging.getLogger("pm_bot.bot_channels")


def _users(raw):
    return {u for u in re.split(r"[\s,]+", raw or "") if u}


# Guards the read-modify-write of conversations.json: the intake runs in the gateway's event loop,
# the cron tool in a run of its own.
_bot_file_lock = threading.Lock()


async def _open_channel(client, text, record):
    """Opens a public request channel named after ``text`` and records it in conversations.json
    with ``record`` (the requester and their address). Returns its ID and name."""
    from slack_sdk.errors import SlackApiError

    # Strict: written back below, so an unreadable file fails instead of being wiped.
    taken = {(r or {}).get("name") for r in read_json(BOT_FILE, strict=True).values()}
    for _ in range(20):
        name = request_channel_name(text, taken)
        try:
            created = await client.conversations_create(name=name, is_private=False)
            break
        except SlackApiError as exc:
            if exc.response.get("error") != "name_taken":
                raise
            taken.add(name)
    else:
        raise RuntimeError("no free request channel name")
    channel = created["channel"]["id"]
    with _bot_file_lock:
        bot = read_json(BOT_FILE, strict=True)
        bot[channel] = {"side": "slack", "name": name, **record, "created": datetime.now(timezone.utc).isoformat()}
        write_json(BOT_FILE, bot)
    return channel, name


class _SlackWebClient:
    """The Slack calls the cron tool makes, with the bot token. Hermes' Bolt client belongs to the
    gateway's event loop, which a cron run does not share. Its Slack is the poller's: Slack itself,
    or SLACK_API_URL when set (the end-to-end test's recorder)."""

    def __init__(self):
        from slack_sdk import WebClient

        options = {"token": os.environ.get("SLACK_BOT_TOKEN") or ""}
        if os.environ.get("SLACK_API_URL"):
            options["base_url"] = os.environ["SLACK_API_URL"].rstrip("/") + "/"
        self.web = WebClient(**options)

    async def conversations_create(self, **kwargs):
        return await asyncio.to_thread(self.web.conversations_create, **kwargs)


def _slack_client():
    return _SlackWebClient()


OPEN_REQUEST_CHANNEL = {
    "name": "open_request_channel",
    "description": (
        "Open a public Slack request channel for a ticket you just created, named after its title. "
        "Returns the channel ID and its conversation link; store the link on the ticket with the "
        "title *Slack channel*. The poller then renames, posts into and archives it as for any request."
    ),
    "parameters": {
        "type": "object",
        "properties": {"title": {"type": "string", "description": "The ticket's title."}},
        "required": ["title"],
        "additionalProperties": False,
    },
}


async def open_request_channel_tool(args, **_):
    """``open_request_channel``: ``{channel, name, link}``, or ``{error}``."""
    title = str((args or {}).get("title") or "").strip()
    if not title:
        return json.dumps({"error": "title is required"})
    try:
        channel, name = await _open_channel(_slack_client(), title, {"requester": None})
    except Exception as exc:
        logger.error("bot-channels: request channel for the nightly audit: %s", exc)
        return json.dumps({"error": f"could not open a request channel: {exc}"})
    workspace = (os.environ.get("SLACK_WORKSPACE_URL") or "").rstrip("/")
    return json.dumps({"channel": channel, "name": name, "link": f"{workspace}/archives/{channel}"})


def factory(app, adapter):
    """``register_platform_handler("slack", …)``: ``app`` is Hermes' Bolt ``AsyncApp``."""
    from slack_bolt.response import BoltResponse

    # First, so the poller never posts a previous run's language, also when the plugin stays off.
    language.write(LANGUAGE_FILE, DEFAULT_LANGUAGE)
    home = (os.environ.get("SLACK_ALLOWED_CHANNELS") or "").strip()
    workspace = os.environ.get("SLACK_WORKSPACE_URL") or ""
    allowed_users = _users(os.environ.get("SLACK_ALLOWED_USERS"))
    if not home:
        logger.error("bot-channels: SLACK_ALLOWED_CHANNELS is empty; the plugin stays off")
        return

    lang = {"code": DEFAULT_LANGUAGE}
    language.start(lang, LANGUAGE_FILE)

    def current():
        poller = read_json(POLLER_FILE)
        return poller, open_channels(read_json(BOT_FILE), poller)

    # Instance overrides of the adapter's channel getters (shadowing the class's env/YAML
    # readers): read on every message, so a new channel is admitted at once and an archived
    # one drops out. entrypoint.sh check asserts both getters exist.
    adapter._slack_allowed_channels = lambda: {home} | current()[1]
    adapter._slack_free_response_channels = lambda: current()[1]

    # Hermes swaps eyes for ✅/❌ when it finishes; in a flat channel only eyes comes and goes.
    # CANCELLED removes eyes and adds nothing. entrypoint.sh check asserts the hook and outcome.
    complete = adapter.on_processing_complete

    async def on_processing_complete(event, outcome):
        await complete(event, type(outcome).CANCELLED)

    adapter.on_processing_complete = on_processing_complete

    def refresh_prompts():
        poller, channels = current()
        records = poller.get("channels") or {}
        bot = read_json(BOT_FILE)
        prompts = adapter.config.extra.setdefault("channel_prompts", {})
        prompts[home] = language_prompt(lang["code"])
        for channel in channels:
            prompts[channel] = channel_prompt(
                channel, workspace, (records.get(channel) or {}).get("ticket"), lang["code"],
                (bot.get(channel) or {}).get("requester_email"),
            )

    def is_request(event):
        """A new mention of the bot at the top of its channel, from a served user."""
        if event.get("type") not in ("message", "app_mention") or event.get("channel") != home:
            return False
        if event.get("subtype") or event.get("bot_id") or not event.get("user"):
            return False
        if event.get("thread_ts") and event.get("thread_ts") != event.get("ts"):
            return False  # a reply in a thread from before channels: Hermes answers it there
        if allowed_users and event["user"] not in allowed_users:
            return False
        bot_user = getattr(adapter, "_bot_user_id", None)
        return event["type"] == "app_mention" or bool(bot_user and f"<@{bot_user}" in (event.get("text") or ""))

    def is_open_channel_message(event):
        """A served user's own message in one of the bot's open channels."""
        if event.get("type") != "message" or event.get("subtype") or event.get("bot_id") or not event.get("user"):
            return False
        if allowed_users and event["user"] not in allowed_users:
            return False
        return event.get("channel") in current()[1]

    lock = asyncio.Lock()
    seen = set()  # a mention arrives as message and as app_mention, with one ts
    tasks = set()

    async def requester_email(client, user):
        """The requester's Slack e-mail address, None without one: never from message text."""
        try:
            info = await client.users_info(user=user)
        except Exception as exc:
            logger.warning("bot-channels: no e-mail address for %s: %s", user, exc)
            return None
        email = ((info.get("user") or {}).get("profile") or {}).get("email")
        if not email:
            logger.warning("bot-channels: Slack returns no e-mail address for %s", user)
        return email or None

    async def open_request_channel(client, event):
        email = await requester_email(client, event["user"])
        record = {"requester": event["user"], **({"requester_email": email} if email else {})}
        async with lock:
            channel, _ = await _open_channel(client, event.get("text") or "", record)
        return channel

    async def error_reply(key, user, channel):
        record = (read_json(POLLER_FILE).get("channels") or {}).get(channel) or {}
        ticket = None
        if record.get("ticket"):
            try:
                ticket = await asyncio.to_thread(language.read_tool, os.environ.get("BAKERS_URL", ""), os.environ.get("BAKERS_API_KEY", ""), "bakers_ticket_read", {"ticket": record["ticket"]})
            except Exception as exc:
                logger.error("bot-channels: ticket link for %s: %s", channel, exc)
        return ticket_error(lang["code"], key, user, ticket)

    async def intake(client, event, body):
        user = event["user"]
        channel = event.get("channel")
        try:
            channel = await open_request_channel(client, event)
            await client.conversations_invite(channel=channel, users=user)
            try:
                await client.chat_postMessage(channel=channel, text=text(lang["code"], "acknowledge", user=user))
            except Exception as exc:
                logger.error("bot-channels: acknowledging %s in %s: %s", event.get("ts"), channel, exc)
            await client.chat_postMessage(channel=home, text=text(lang["code"], "opened", user=user, channel=channel))
        except Exception as exc:
            logger.error("bot-channels: request channel for %s: %s", event.get("ts"), exc)
            try:
                await client.chat_postMessage(channel=home, text=await error_reply("open_failed", user, channel))
            except Exception as post_exc:
                logger.error("bot-channels: telling %s: %s", user, post_exc)
            return
        # The message itself, as if it had been written in the new channel.
        copy = dict(event, channel=channel)
        try:
            await adapter._handle_slack_message(copy, dict(body, event=copy))
        except Exception as exc:
            logger.error("bot-channels: handing on %s: %s", event.get("ts"), exc)
            try:
                await client.chat_postMessage(channel=channel, text=await error_reply("repeat", user, channel))
            except Exception as post_exc:
                logger.error("bot-channels: asking %s to repeat in %s: %s", user, channel, post_exc)

    async def middleware(body, next, client):
        event = (body or {}).get("event") or {}
        try:
            refresh_prompts()
        except Exception as exc:
            logger.error("bot-channels: channel prompts: %s", exc)
        if not is_request(event):
            if is_open_channel_message(event):
                try:
                    # Hermes' own eyes lifecycle, which it otherwise runs only for mentions.
                    adapter._track_reacting_message(adapter._event_team_id(event, body), event["ts"])
                except Exception as exc:
                    logger.error("bot-channels: marking %s for the reaction: %s", event.get("ts"), exc)
            await next()
            return None
        ts = event.get("ts")
        if ts not in seen:
            seen.add(ts)
            task = asyncio.create_task(intake(client, event, body))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        # Acked, and kept from Hermes: the conversation happens in the request channel.
        return BoltResponse(status=200, body="")

    app.middleware(middleware)
    logger.info("bot-channels: serving %s and the bot's open channels", home)


