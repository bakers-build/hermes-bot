"""The bot-channels plugin's GitLab side (README.md › The GitLab side): a Hermes platform adapter,
``gitlab``, for the issues of GITLAB_PROJECT.

- Intake: a new open issue not written by the bot is a request. The bot records it as a
  conversation (conversations.json, side ``gitlab``), acknowledges it in a note and hands its title
  and description on to Hermes, in one session per issue (chat ID = the issue's IID).
- Conversation: a note on a conversation issue, not the bot's own, not a system note, is handed on
  while the issue's ticket is open; the poller records a closed one as archived.
  Hermes' replies are notes on the issue. While Hermes works on a message, it carries eyes.
- Trusted line: each issue gets one before each turn, with its IID, link, ticket, requester and
  the requester's public e-mail address (none when GitLab shows none), and the bot's language.
- Webhook: GitLab posts Issue and Note events to GITLAB_WEBHOOK_PORT; only events of the project
  with the hook's secret count. Every start creates or updates the project hook whose URL is
  GITLAB_WEBHOOK_URL; the secret is generated once into gitlab-webhook.json (mode 600).
- Catch-up: on start, issues and notes that arrived while the bot was down are handled once,
  after the last ones handled; the first start handles none of the project's existing issues.

The bot calls only its own user, a user's public profile, the project's issues, their notes and
award emoji, and the project's hooks (tests/contract/pm-bot.sh checks the list).
"""

import asyncio
import hmac
import json
import logging
import os
import secrets
import urllib.parse
import urllib.request

from . import language
from .channels import CONVERSATIONS_FILE, DATA, DEFAULT_LANGUAGE, LANGUAGE_FILE, POLLER_FILE, issue_prompt, read_json, write_json

logger = logging.getLogger("pm_bot.bot_channels")

WEBHOOK_FILE = os.path.join(DATA, "gitlab-webhook.json")
WEBHOOK_PATH = "/webhooks/gitlab"
TIMEOUT = 20
TEXTS = {
    "de": {"acknowledge": "@{username} Danke, ich habe deine Anfrage erhalten und schaue sie mir an. Ich antworte gleich hier."},
    "en": {"acknowledge": "@{username} Thanks, I've got your request and I'm looking into it. I'll answer here shortly."},
}


def acknowledgement(code, username):
    return TEXTS.get(code, TEXTS[DEFAULT_LANGUAGE])["acknowledge"].format(username=username)


class Api:
    """The GitLab REST calls the plugin makes, with the bot's token."""

    def __init__(self, url, project, token):
        self.root = url.rstrip("/")
        self.project = project
        self.token = token
        self.base = f"{self.root}/api/v4/projects/{urllib.parse.quote(project, safe='')}"

    def issue_url(self, iid):
        return f"{self.root}/{self.project}/-/issues/{iid}"

    def call(self, method, url, body=None):
        headers = {"private-token": self.token}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode()
        request = urllib.request.Request(url, data, headers, method=method)
        with urllib.request.urlopen(request, timeout=TIMEOUT) as res:
            text = res.read().decode()
        return json.loads(text) if text else None

    def user(self):
        return self.call("GET", f"{self.root}/api/v4/user")

    def public_email(self, user_id):
        return (self.call("GET", f"{self.root}/api/v4/users/{int(user_id)}") or {}).get("public_email") or None

    def note(self, iid, body):
        return self.call("POST", f"{self.base}/issues/{int(iid)}/notes", {"body": body})

    def _awards(self, iid, note_id):
        return f"{self.base}/issues/{int(iid)}" + (f"/notes/{int(note_id)}" if note_id else "") + "/award_emoji"

    def award(self, iid, note_id, name):
        return self.call("POST", self._awards(iid, note_id), {"name": name})["id"]

    def unaward(self, iid, note_id, award_id):
        self.call("DELETE", f"{self._awards(iid, note_id)}/{int(award_id)}")

    def open_issues(self):
        # shortcut: the first 100 open issues, oldest first; more arrive between two starts only rarely.
        return self.call("GET", f"{self.base}/issues?state=opened&order_by=created_at&sort=asc&per_page=100") or []

    def notes(self, iid):
        # shortcut: the first 100 notes of an issue, oldest first.
        return self.call("GET", f"{self.base}/issues/{int(iid)}/notes?sort=asc&order_by=created_at&per_page=100") or []

    def hooks(self):
        return self.call("GET", f"{self.base}/hooks") or []

    def add_hook(self, settings):
        return self.call("POST", f"{self.base}/hooks", settings)

    def edit_hook(self, hook_id, settings):
        return self.call("PUT", f"{self.base}/hooks/{int(hook_id)}", settings)


def _settings(env):
    return {
        "url": (env.get("GITLAB_URL") or "").strip(),
        "project": (env.get("GITLAB_PROJECT") or "").strip().strip("/"),
        "token": (env.get("GITLAB_TOKEN") or "").strip(),
        "webhook_url": (env.get("GITLAB_WEBHOOK_URL") or "").strip(),
        "port": int(env.get("GITLAB_WEBHOOK_PORT") or 8080),
    }


class Side:
    """The GitLab side without Hermes: ``hand_on(message)`` gives a message to Hermes as
    ``{iid, text, message_id, user_id, user_name, kind, note_id}``. Its API calls block; the
    adapter runs them in a thread."""

    def __init__(self, api, hand_on, lang, webhook_url):
        self.api = api
        self.hand_on = hand_on
        self.lang = lang
        self.webhook_url = webhook_url
        self._bot_id = None
        self.secret = self._secret()

    # -- state -------------------------------------------------------------

    def _webhook_state(self):
        return read_json(WEBHOOK_FILE, strict=True)

    def _save_webhook_state(self, state):
        write_json(WEBHOOK_FILE, state)
        os.chmod(WEBHOOK_FILE, 0o600)

    def _secret(self):
        state = self._webhook_state()
        if not state.get("secret"):
            state["secret"] = secrets.token_hex(24)
            self._save_webhook_state(state)
        return state["secret"]

    def bot_id(self):
        if self._bot_id is None:
            self._bot_id = self.api.user()["id"]
        return self._bot_id

    def conversation(self, iid):
        """The issue's record when the bot answers it: its conversation, while its ticket is open."""
        record = read_json(CONVERSATIONS_FILE).get(str(iid))
        if not record or record.get("side") != "gitlab":
            return None
        if ((read_json(POLLER_FILE).get("channels") or {}).get(str(iid)) or {}).get("archived"):
            return None
        return record

    def _update(self, iid, **fields):
        conversations = read_json(CONVERSATIONS_FILE, strict=True)
        conversations[str(iid)] = {**(conversations.get(str(iid)) or {}), **fields}
        write_json(CONVERSATIONS_FILE, conversations)

    def prompt(self, iid):
        record = read_json(CONVERSATIONS_FILE).get(str(iid)) or {}
        ticket = ((read_json(POLLER_FILE).get("channels") or {}).get(str(iid)) or {}).get("ticket")
        return issue_prompt(iid, self.api.issue_url(iid), ticket, record.get("requester_username"), record.get("requester_email"), self.lang["code"])

    # -- webhook -----------------------------------------------------------

    def verify(self, headers):
        """The hook's secret in X-Gitlab-Token, compared in constant time."""
        return hmac.compare_digest((headers.get("X-Gitlab-Token") or "").encode(), self.secret.encode())

    def _ours(self, body):
        project = ((body.get("project") or {}).get("path_with_namespace") or "").lower()
        return project == self.api.project.lower()

    def handle(self, body):
        """One webhook delivery, verified. Returns what it did, for the log and the tests."""
        if not self._ours(body):
            return "other project"
        kind = body.get("object_kind")
        attributes = body.get("object_attributes") or {}
        user = body.get("user") or {}
        if kind == "issue":
            if attributes.get("action") != "open":
                return "not a new issue"
            return self.issue(attributes, user)
        if kind == "note":
            if attributes.get("noteable_type") != "Issue":
                return "not an issue note"
            return self.note((body.get("issue") or {}).get("iid"), attributes, user)
        return "not an issue event"

    def issue(self, issue, user):
        iid = issue.get("iid")
        if not iid or issue.get("state") not in (None, "opened"):
            return "closed issue"
        if issue.get("author_id", user.get("id")) == self.bot_id():
            return "own issue"
        if str(iid) in read_json(CONVERSATIONS_FILE):
            return "already handled"
        author = issue.get("author_id", user.get("id"))
        username = user.get("username") if user.get("id") in (None, author) else None
        name = user.get("name") or username
        try:
            email = self.api.public_email(author)
        except Exception as exc:
            logger.warning("gitlab: no e-mail address for user %s: %s", author, exc)
            email = None
        if not email:
            logger.warning("gitlab: GitLab shows no public e-mail address for user %s", author)
        self._update(iid, side="gitlab", requester=author, requester_username=username, requester_name=name,
                     created=issue.get("created_at") or "", **({"requester_email": email} if email else {}))
        self._mark_issue(iid)
        try:
            self.api.note(iid, acknowledgement(self.lang["code"], username))
        except Exception as exc:
            logger.error("gitlab: acknowledging issue %s: %s", iid, exc)
        text = "\n\n".join(part for part in (issue.get("title"), issue.get("description")) if part)
        self.hand_on({"iid": str(iid), "text": text, "message_id": f"issue-{iid}", "user_id": str(author),
                      "user_name": f"{name} | GitLab user @{username}", "kind": "issue", "note_id": None})
        return "request"

    def note(self, iid, note, user):
        if not iid or note.get("system"):
            return "system note"
        author = note.get("author_id", user.get("id"))
        if author == self.bot_id():
            return "own note"
        record = self.conversation(iid)
        if not record:
            return "not a conversation"
        if note.get("id") and note["id"] <= (record.get("last_note") or 0):
            return "already handled"
        self._update(iid, last_note=note.get("id"))
        name = user.get("name") or user.get("username")
        self.hand_on({"iid": str(iid), "text": note.get("note") or note.get("body") or "", "message_id": f"note-{note.get('id')}",
                      "user_id": str(author), "user_name": f"{name} | GitLab user @{user.get('username')}", "kind": "note", "note_id": note.get("id")})
        return "message"

    def _mark_issue(self, iid):
        state = self._webhook_state()
        if int(iid) > (state.get("last_issue") or 0):
            state["last_issue"] = int(iid)
            self._save_webhook_state(state)

    # -- start ------------------------------------------------------------

    def register_hook(self):
        """The project hook for GITLAB_WEBHOOK_URL, created or updated (which re-enables it); others stay."""
        settings = {"url": self.webhook_url, "token": self.secret, "issues_events": True, "note_events": True,
                    "push_events": False, "enable_ssl_verification": True}
        try:
            hook = next((h for h in self.api.hooks() if h.get("url") == self.webhook_url), None)
            if hook:
                self.api.edit_hook(hook["id"], settings)
                logger.warning("gitlab: webhook %s updated", self.webhook_url)
            else:
                self.api.add_hook(settings)
                logger.warning("gitlab: webhook %s created", self.webhook_url)
        except Exception as exc:
            logger.error("gitlab: webhook %s not registered: %s", self.webhook_url, exc)

    def catch_up(self):
        """The issues and notes that came while the bot was down, once; the first start only marks."""
        try:
            issues = self.api.open_issues()
            state = self._webhook_state()
            if "last_issue" not in state:
                state["last_issue"] = max([int(i["iid"]) for i in issues] + [0])
                self._save_webhook_state(state)
                return
            for issue in issues:
                if int(issue["iid"]) > state["last_issue"]:
                    self.issue(issue, issue.get("author") or {})
            for iid, record in read_json(CONVERSATIONS_FILE).items():
                if record.get("side") != "gitlab" or not self.conversation(iid):
                    continue
                for note in self.api.notes(iid):
                    if note.get("id", 0) > (self.conversation(iid).get("last_note") or 0):
                        self.note(iid, note, note.get("author") or {})
        except Exception as exc:
            logger.error("gitlab: catching up: %s", exc)


def check_requirements():
    settings = _settings(os.environ)
    return all(settings[key] for key in ("url", "project", "token", "webhook_url"))


def adapter_class():
    """The Hermes adapter, built on first use: Hermes' modules exist only in the gateway."""
    from aiohttp import web
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult, resolve_channel_prompt
    from gateway.platforms.event import MessageEvent, MessageType

    class GitLabAdapter(BasePlatformAdapter):
        MAX_MESSAGE_LENGTH = 100_000

        def __init__(self, config):
            super().__init__(config, Platform("gitlab"))
            self.settings = _settings(os.environ)
            self.api = Api(self.settings["url"], self.settings["project"], self.settings["token"])
            self.lang = {"code": DEFAULT_LANGUAGE}
            self.side = None
            self._runner = None
            self._eyes = {}

        async def connect(self, *, is_reconnect=False):
            language.start(self.lang, LANGUAGE_FILE)
            loop = asyncio.get_running_loop()
            self.side = Side(self.api, lambda message: loop.call_soon_threadsafe(self._hand_on, message), self.lang, self.settings["webhook_url"])
            app = web.Application(client_max_size=1_048_576)
            app.router.add_post(WEBHOOK_PATH, self._webhook)
            self._runner = web.AppRunner(app)
            await self._runner.setup()
            await web.TCPSite(self._runner, "0.0.0.0", self.settings["port"]).start()
            self._running = True
            logger.warning("gitlab: serving issues of %s on port %s", self.settings["project"], self.settings["port"])
            await asyncio.to_thread(self.side.register_hook)
            await asyncio.to_thread(self.side.catch_up)
            return True

        async def disconnect(self):
            if self._runner:
                await self._runner.cleanup()
                self._runner = None
            self._running = False

        async def _webhook(self, request):
            if not self.side.verify(request.headers):
                logger.warning("gitlab: a webhook delivery without the hook's secret was refused")
                return web.Response(status=401)
            try:
                body = await request.json()
            except Exception:
                return web.Response(status=400)
            task = asyncio.create_task(self._handle(body))
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)
            return web.Response(text="ok")

        async def _handle(self, body):
            try:
                logger.info("gitlab: webhook: %s", await asyncio.to_thread(self.side.handle, body))
            except Exception as exc:
                logger.error("gitlab: webhook: %s", exc)

        def _hand_on(self, message):
            iid = message["iid"]
            prompts = self.config.extra.setdefault("channel_prompts", {})
            prompts[iid] = self.side.prompt(iid)
            source = self.build_source(chat_id=iid, chat_name=f"#{iid}", chat_type="group", user_id=message["user_id"],
                                       user_name=message["user_name"], message_id=message["message_id"])
            event = MessageEvent(text=message["text"], message_type=MessageType.TEXT, source=source, raw_message=message,
                                 message_id=message["message_id"], channel_prompt=resolve_channel_prompt(self.config.extra, iid))
            task = asyncio.create_task(self.handle_message(event))
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            try:
                note = await asyncio.to_thread(self.api.note, chat_id, content)
                return SendResult(success=True, message_id=str(note.get("id", "")))
            except Exception as exc:
                logger.error("gitlab: note on issue %s: %s", chat_id, exc)
                return SendResult(success=False, error=str(exc))

        async def get_chat_info(self, chat_id):
            return {"name": f"#{chat_id}", "type": "group", "chat_id": chat_id}

        async def on_processing_start(self, event):
            message = event.raw_message or {}
            try:
                self._eyes[event.message_id] = await asyncio.to_thread(self.api.award, message["iid"], message.get("note_id"), "eyes")
            except Exception as exc:
                logger.warning("gitlab: eyes on %s: %s", event.message_id, exc)

        async def on_processing_complete(self, event, outcome):
            message = event.raw_message or {}
            award = self._eyes.pop(event.message_id, None)
            if award is None:
                return
            try:
                await asyncio.to_thread(self.api.unaward, message["iid"], message.get("note_id"), award)
            except Exception as exc:
                logger.warning("gitlab: removing eyes from %s: %s", event.message_id, exc)

    return GitLabAdapter


def register(ctx):
    ctx.register_platform(
        name="gitlab", label="GitLab issues", adapter_factory=lambda config: adapter_class()(config),
        check_fn=check_requirements, required_env=["GITLAB_URL", "GITLAB_PROJECT", "GITLAB_TOKEN", "GITLAB_WEBHOOK_URL"],
        platform_hint="You are talking in a GitLab issue: your replies are notes on it, in GitLab Markdown.",
    )
