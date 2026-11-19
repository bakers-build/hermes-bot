"""The bot's language: the ISO 639-1 code the operator sets in ``PM_BOT_LANGUAGE`` in the
container's env, German when it is unset or not a code. Read once at the plugin's start, with no
model call and no site read. The code is shared with the poller through
``$HERMES_HOME/bot-language.json`` (write). ``read_tool`` is the plugin's read-only MCP transport.
"""

import json
import logging
import os
import re
import urllib.request

logger = logging.getLogger("pm_bot.bot_channels")

DEFAULT = "de"  # channels.DEFAULT_LANGUAGE
SETTING = "PM_BOT_LANGUAGE"
TIMEOUT = 20
_CODE = re.compile(r"[a-z]{2}")


def configured(env):
    """``(code, error)`` from ``env[SETTING]``: German without an error when it is unset or empty,
    the code when it is two letters (trimmed, lower-cased), else German and the error."""
    raw = env.get(SETTING) or ""
    value = raw.strip().lower()
    if not value:
        return DEFAULT, None
    if _CODE.fullmatch(value):
        return value, None
    return DEFAULT, f'{SETTING} "{raw}" is not an ISO 639-1 code'


def _post(url, headers, payload):
    request = urllib.request.Request(url, json.dumps(payload).encode(), {"content-type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as res:
        return res.headers, res.read().decode()


def read_tool(bakers_url, api_key, name, arguments):
    """One read-only tool call over the existing MCP transport."""
    endpoint = f"{bakers_url.rstrip('/')}/mcp"
    headers = {"accept": "application/json, text/event-stream", "authorization": f"Bearer {api_key}"}

    def rpc(message):
        res_headers, body = _post(endpoint, headers, message)
        if res_headers.get("mcp-session-id"):
            headers["mcp-session-id"] = res_headers["mcp-session-id"]
        if "id" not in message:
            return None
        if "text/event-stream" in (res_headers.get("content-type") or ""):
            body = "".join(line[5:] for line in body.split("\n") if line.startswith("data:"))
        answer = json.loads(body)
        if answer.get("error"):
            raise RuntimeError(f"{name}: {message['method']}: {answer['error'].get('message')}")
        return answer["result"]

    rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pm-bot", "version": "2"}}})
    rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
    result = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": f"tool_api__{name}", "arguments": arguments}})
    text = next((c.get("text") for c in result.get("content") or [] if c.get("type") == "text"), "")
    if result.get("isError"):
        raise RuntimeError(f"{name}: {text}")
    return result.get("structuredContent") or json.loads(text or "{}")


def write(path, code):
    """``{"language": code}`` to ``path`` for the poller, atomically; a failure is logged only."""
    try:
        with open(f"{path}.tmp", "w", encoding="utf-8") as fh:
            json.dump({"language": code}, fh)
        os.replace(f"{path}.tmp", path)
    except OSError as exc:
        logger.error("bot-channels: language: writing %s: %s", path, exc)


def start(holder, path):
    """Set ``holder["code"]`` from the container's env and write it to ``path`` for the poller."""
    holder["code"], error = configured(os.environ)
    write(path, holder["code"])
    if error:
        logger.error("bot-channels: language: %s; answering in German", error)
    # warning, not info: Hermes' log level may filter info, and the README's hand test reads this line.
    logger.warning("bot-channels: answering in %s", holder["code"])
