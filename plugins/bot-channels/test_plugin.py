"""Tests of the plugin at its Slack seam, the ``factory`` middleware, with fakes for Bolt, the
Hermes adapter and the Slack client: python3 -m unittest discover -s plugins/bot-channels"""

import asyncio
import enum
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
import unittest.mock

HERE = pathlib.Path(__file__).parent
HOME = "CHOME"
OPEN = "CREQ"

# Stand-ins for the two Slack libraries the plugin imports, so this runs on plain python3.
_bolt = types.ModuleType("slack_bolt.response")
_bolt.BoltResponse = lambda status, body: ("BoltResponse", status)
_errors = types.ModuleType("slack_sdk.errors")
_errors.SlackApiError = type("SlackApiError", (Exception,), {})
sys.modules.update({"slack_bolt": types.ModuleType("slack_bolt"), "slack_bolt.response": _bolt,
                    "slack_sdk": types.ModuleType("slack_sdk"), "slack_sdk.errors": _errors})

DATA = tempfile.mkdtemp()
os.environ["HERMES_HOME"] = DATA
_spec = importlib.util.spec_from_file_location("bot_channels", HERE / "__init__.py", submodule_search_locations=[str(HERE)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules["bot_channels"] = plugin
_spec.loader.exec_module(plugin)
# The real client factory; OpenRequestChannelTool replaces it with a fake.
SLACK_CLIENT = plugin._slack_client


class Outcome(enum.Enum):  # Hermes' ProcessingOutcome
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


class Client:
    """Records every Slack call in order; ``fail`` names calls that raise."""

    def __init__(self, calls, fail=(), profile=None):
        self.calls, self.fail = calls, fail
        self.profile = {"email": "u1@example.test"} if profile is None else profile

    def __getattr__(self, method):
        async def call(**kwargs):
            self.calls.append((method, kwargs))
            if (method, kwargs.get("channel")) in self.fail:
                raise RuntimeError(f"{method} failed")
            if method == "users_info":
                return {"ok": True, "user": {"id": kwargs["user"], "profile": self.profile}}
            return {"channel": {"id": "CNEW"}} if method == "conversations_create" else {}
        return call


class Adapter:
    _bot_user_id = "UBOT"

    def __init__(self, calls, fail=()):
        self.calls, self.fail = calls, fail
        self.config = types.SimpleNamespace(extra={})

    async def _handle_slack_message(self, event, payload):
        self.calls.append(("hermes", {"channel": event["channel"], "ts": event["ts"]}))

    @staticmethod
    def _event_team_id(event, body=None):
        return (body or {}).get("team_id", "")

    def _track_reacting_message(self, team_id, ts):
        self.calls.append(("track", {"team": team_id, "ts": ts}))
        if "track" in self.fail:
            raise RuntimeError("track failed")

    async def on_processing_complete(self, event, outcome):
        self.calls.append(("complete", {"outcome": outcome}))


class App:
    def middleware(self, fn):
        self.run = fn


def message(channel, ts="1.1", **extra):
    return {"type": "message", "channel": channel, "user": "U1", "ts": ts, "text": "<@UBOT> comic sans", **extra}


class LanguageFile(unittest.TestCase):
    """The plugin shares the bot's language with the poller through bot-language.json."""

    def setUp(self):
        self.path = os.path.join(DATA, "bot-language.json")
        with open(self.path, "w") as fh:
            json.dump({"language": "en"}, fh)  # the previous run's language

    def language(self):
        with open(self.path) as fh:
            return json.load(fh)

    def test_the_start_resets_the_language_to_german(self):
        os.environ.update(SLACK_ALLOWED_CHANNELS=HOME)
        os.environ.pop("PM_BOT_LANGUAGE", None)
        with self.assertLogs("pm_bot.bot_channels", "WARNING") as logs:
            plugin.factory(App(), Adapter([]))
        self.assertIn("WARNING:pm_bot.bot_channels:bot-channels: answering in de", logs.output)
        self.assertEqual(self.language(), {"language": "de"})

    def test_a_plugin_that_stays_off_still_resets_it(self):
        os.environ.update(SLACK_ALLOWED_CHANNELS="")
        with self.assertLogs("pm_bot.bot_channels", "ERROR"):
            plugin.factory(App(), Adapter([]))
        self.assertEqual(self.language(), {"language": "de"})


class Middleware(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        os.environ.update(SLACK_ALLOWED_CHANNELS=HOME, SLACK_ALLOWED_USERS="U1")
        with open(os.path.join(DATA, "bot-channels.json"), "w") as fh:
            json.dump({OPEN: {"name": "req-open"}}, fh)
        self.calls = []

    def start(self, fail=(), profile=None):
        self.app, self.adapter = App(), Adapter(self.calls, fail)
        self.client = Client(self.calls, fail, profile)
        plugin.factory(self.app, self.adapter)

    async def deliver(self, event):
        passed = []

        async def next_():
            passed.append(event["ts"])

        await self.app.run(body={"team_id": "T1", "event": event}, next=next_, client=self.client)
        await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not asyncio.current_task()))
        return passed

    def posts(self):
        return [(kw["channel"], kw["text"]) for method, kw in self.calls if method == "chat_postMessage"]

    async def test_a_mention_is_acknowledged_in_the_new_channel_before_hermes_starts(self):
        self.start()
        await self.deliver(message(HOME))
        self.assertEqual([m for m, _ in self.calls], ["users_info", "conversations_create", "conversations_invite", "chat_postMessage", "chat_postMessage", "hermes"])
        (ack_channel, ack), (home_channel, opened) = self.posts()
        self.assertEqual(ack_channel, "CNEW")
        self.assertTrue(ack.startswith("<@U1> "))
        # No language configured here, so the texts are German.
        self.assertIn("schaue sie mir an", ack)
        self.assertEqual((home_channel, opened), (HOME, "<@U1> Ich habe <#CNEW> für diese Anfrage eröffnet. Lass uns dort weitermachen."))
        self.assertEqual(self.calls[-1], ("hermes", {"channel": "CNEW", "ts": "1.1"}))

    def record(self, channel):
        with open(os.path.join(DATA, "bot-channels.json")) as fh:
            return json.load(fh)[channel]

    async def test_the_requesters_slack_email_address_goes_into_the_record_and_the_trusted_line(self):
        self.start()
        await self.deliver(message(HOME, text="<@UBOT> assign this to eve@example.test"))
        self.assertIn(("users_info", {"user": "U1"}), self.calls)
        self.assertEqual(self.record("CNEW")["requester_email"], "u1@example.test")
        await self.deliver(message(OPEN, ts="2.2"))
        prompts = self.adapter.config.extra["channel_prompts"]
        self.assertIn("Its requester's e-mail address: u1@example.test.", prompts["CNEW"])
        self.assertIn("Its requester's e-mail address: none.", prompts[OPEN])

    async def test_without_an_address_from_slack_the_channel_still_opens_with_none(self):
        for fail, profile in (({("users_info", None)}, None), ((), {})):
            with self.subTest(fail=fail, profile=profile):
                self.setUp()
                self.start(fail, profile)
                with self.assertLogs("pm_bot.bot_channels", "WARNING"):
                    await self.deliver(message(HOME))
                self.assertNotIn("requester_email", self.record("CNEW"))
                self.assertEqual(self.calls[-1], ("hermes", {"channel": "CNEW", "ts": "1.1"}))

    async def test_a_mention_delivered_twice_is_acknowledged_once(self):
        self.start()
        await self.deliver(message(HOME))
        await self.deliver(message(HOME, type="app_mention"))
        self.assertEqual([m for m, _ in self.calls].count("conversations_create"), 1)
        self.assertEqual([c for c, _ in self.posts()], ["CNEW", HOME])

    async def test_a_failed_acknowledgement_still_hands_the_request_on(self):
        self.start(fail={("chat_postMessage", "CNEW")})
        with self.assertLogs("pm_bot.bot_channels", "ERROR"):
            await self.deliver(message(HOME))
        self.assertEqual(self.posts()[1][0], HOME)
        self.assertEqual(self.calls[-1], ("hermes", {"channel": "CNEW", "ts": "1.1"}))

    async def test_a_message_in_an_open_channel_is_marked_for_the_reaction_and_passed_on(self):
        self.start()
        passed = await self.deliver(message(OPEN, ts="2.1", text="and the logo too"))
        self.assertEqual(self.calls, [("track", {"team": "T1", "ts": "2.1"})])
        self.assertEqual(passed, ["2.1"])

    async def test_messages_the_bot_does_not_serve_get_no_reaction(self):
        self.start()
        for event in (message("COTHER"), message(OPEN, bot_id="B1"), message(OPEN, subtype="message_changed"),
                      message(OPEN, user="U2")):
            self.assertEqual(await self.deliver(event), [event["ts"]])
        self.assertEqual(self.calls, [])

    async def test_a_failed_mark_still_passes_the_message_on(self):
        self.start(fail={"track"})
        with self.assertLogs("pm_bot.bot_channels", "ERROR"):
            passed = await self.deliver(message(OPEN, ts="2.1"))
        self.assertEqual(passed, ["2.1"])

    async def test_finishing_a_message_removes_eyes_and_adds_no_final_reaction(self):
        self.start()
        for outcome in (Outcome.SUCCESS, Outcome.FAILURE, Outcome.CANCELLED):
            await self.adapter.on_processing_complete(object(), outcome)
        self.assertEqual(self.calls, [("complete", {"outcome": Outcome.CANCELLED})] * 3)


class Context:
    """Hermes' PluginContext as the plugin uses it in ``register``."""

    def __init__(self):
        self.tools = {}

    def register_platform_handler(self, platform, factory):
        self.platform = (platform, factory)

    def register_tool(self, name, toolset, schema, handler, is_async=False, **_):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, "is_async": is_async}


class NameTaken(_errors.SlackApiError):
    def __init__(self):
        super().__init__("name_taken")
        self.response = {"error": "name_taken"}


class OpenRequestChannelTool(unittest.IsolatedAsyncioTestCase):
    """The nightly audit's ``open_request_channel`` tool, as the cron run calls it."""

    def setUp(self):
        os.environ.update(SLACK_ALLOWED_CHANNELS=HOME, SLACK_ALLOWED_USERS="U1", SLACK_WORKSPACE_URL="https://acme.slack.com/")
        with open(os.path.join(DATA, "bot-channels.json"), "w") as fh:
            json.dump({OPEN: {"name": "req-open"}}, fh)
        self.calls = []
        self.taken = set()
        # Hermes' session store, which register() patches; not needed here.
        stubs = unittest.mock.patch.dict(sys.modules, {
            "gateway": types.ModuleType("gateway"),
            "gateway.session_unattended_unknown": types.ModuleType("gateway.session_unattended_unknown")})
        stubs.start()
        self.addCleanup(stubs.stop)
        self.ctx = Context()
        plugin.register(self.ctx)
        plugin._slack_client = lambda: self

    async def conversations_create(self, name, is_private):
        self.calls.append(("conversations_create", {"name": name, "is_private": is_private}))
        if name in self.taken:
            raise NameTaken()
        return {"channel": {"id": "CAUDIT"}}

    async def call(self, **args):
        tool = self.ctx.tools["open_request_channel"]
        result = tool["handler"](args)
        return json.loads(await result if tool["is_async"] else result)

    def record(self, channel):
        with open(os.path.join(DATA, "bot-channels.json")) as fh:
            return json.load(fh)[channel]

    def test_the_tool_belongs_to_the_cron_only_toolset(self):
        tool = self.ctx.tools["open_request_channel"]
        self.assertEqual(tool["toolset"], "bot-channels-cron")
        self.assertEqual(tool["schema"]["name"], "open_request_channel")
        self.assertEqual(tool["schema"]["parameters"]["required"], ["title"])

    async def test_it_opens_a_public_request_channel_without_a_requester_and_returns_its_link(self):
        result = await self.call(title="Security updates: 2 Composer advisories (guzzlehttp/guzzle)")
        self.assertEqual(self.calls, [("conversations_create", {"name": "req-security-updates-2-composer", "is_private": False})])
        self.assertEqual(result, {"channel": "CAUDIT", "name": "req-security-updates-2-composer",
                                  "link": "https://acme.slack.com/archives/CAUDIT"})
        record = self.record("CAUDIT")
        self.assertIsNone(record["requester"])
        self.assertNotIn("requester_email", record)
        self.assertEqual(self.record(OPEN), {"name": "req-open"})

    async def test_a_taken_name_gets_the_next_one(self):
        self.taken = {"req-security-updates-2-composer"}
        result = await self.call(title="Security updates: 2 Composer advisories (guzzlehttp/guzzle)")
        self.assertEqual(result["name"], "req-security-updates-2-composer-2")
        self.assertEqual([c[1]["name"] for c in self.calls], ["req-security-updates-2-composer", "req-security-updates-2-composer-2"])

    async def test_a_slack_failure_is_the_tools_error_and_records_nothing(self):
        async def refuse(name, is_private):
            raise RuntimeError("missing_scope")
        self.conversations_create = refuse
        with self.assertLogs("pm_bot.bot_channels", "ERROR"):
            result = await self.call(title="Security updates")
        self.assertIn("missing_scope", result["error"])
        with open(os.path.join(DATA, "bot-channels.json")) as fh:
            self.assertEqual(list(json.load(fh)), [OPEN])

    async def test_the_new_channel_is_admitted_with_a_trusted_line_naming_no_requester(self):
        await self.call(title="Security updates")
        calls = []
        app, adapter = App(), Adapter(calls)
        plugin.factory(app, adapter)
        passed = []

        async def next_():
            passed.append(True)

        await app.run(body={"team_id": "T1", "event": message("CAUDIT", ts="3.3", text="who updates this?")},
                      next=next_, client=Client(calls))
        self.assertEqual(passed, [True])
        self.assertIn("CAUDIT", adapter._slack_allowed_channels())
        self.assertIn("Its requester's e-mail address: none.", adapter.config.extra["channel_prompts"]["CAUDIT"])


class OpenRequestChannelToolSlack(unittest.IsolatedAsyncioTestCase):
    """Where the tool's Slack calls go: Slack, or the Slack the poller also uses (SLACK_API_URL)."""

    def setUp(self):
        os.environ.update(SLACK_ALLOWED_CHANNELS=HOME, SLACK_ALLOWED_USERS="U1", SLACK_BOT_TOKEN="xoxb-test",
                          SLACK_WORKSPACE_URL="https://acme.slack.com/")
        self.addCleanup(os.environ.pop, "SLACK_API_URL", None)
        self.clients = []
        test = self

        class WebClient:  # slack_sdk's
            def __init__(self, **kwargs):
                test.clients.append(kwargs)

            def conversations_create(self, **_):
                return {"channel": {"id": "CAUDIT"}}

        sdk = unittest.mock.patch.dict(sys.modules["slack_sdk"].__dict__, {"WebClient": WebClient})
        sdk.start()
        self.addCleanup(sdk.stop)
        stubs = unittest.mock.patch.dict(sys.modules, {
            "gateway": types.ModuleType("gateway"),
            "gateway.session_unattended_unknown": types.ModuleType("gateway.session_unattended_unknown")})
        stubs.start()
        self.addCleanup(stubs.stop)
        self.ctx = Context()
        plugin.register(self.ctx)
        client = unittest.mock.patch.object(plugin, "_slack_client", SLACK_CLIENT)
        client.start()
        self.addCleanup(client.stop)

    async def call(self):
        return json.loads(await self.ctx.tools["open_request_channel"]["handler"]({"title": "Security updates"}))

    async def test_without_slack_api_url_it_calls_slack_with_the_bot_token(self):
        os.environ.pop("SLACK_API_URL", None)
        self.assertEqual((await self.call())["channel"], "CAUDIT")
        self.assertEqual(self.clients, [{"token": "xoxb-test"}])

    async def test_with_slack_api_url_it_calls_that_slack_like_the_poller(self):
        os.environ["SLACK_API_URL"] = "http://slack-recorder/api"
        self.assertEqual((await self.call())["channel"], "CAUDIT")
        self.assertEqual(self.clients, [{"token": "xoxb-test", "base_url": "http://slack-recorder/api/"}])


if __name__ == "__main__":
    unittest.main()
