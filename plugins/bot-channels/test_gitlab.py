"""Tests of the plugin's GitLab chat mode at its seam without Hermes, ``gitlab.ChatMode``, with a fake GitLab
API: python3 -m unittest discover -s plugins/bot-channels"""

import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile
import types
import unittest
import unittest.mock

HERE = pathlib.Path(__file__).parent
# The plugin as a package of its own name: test_plugin.py loads it as bot_channels, with its own data directory.
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp())
_spec = importlib.util.spec_from_file_location("bot_channels_gitlab", HERE / "__init__.py", submodule_search_locations=[str(HERE)])
sys.modules["bot_channels_gitlab"] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sys.modules["bot_channels_gitlab"])
from bot_channels_gitlab import gitlab  # noqa: E402

BOT = 99
PROJECT = "acme/shop"


class Api:
    """Records every call; ``hooks_list`` and ``issues``/``notes_of`` are what GitLab holds."""

    project = PROJECT

    def __init__(self, email="alice@example.test"):
        self.calls, self.email, self.hooks_list, self.issues, self.notes_of, self.fail = [], email, [], [], {}, set()

    def issue_url(self, iid):
        return f"https://gitlab.example/{PROJECT}/-/issues/{iid}"

    def __getattr__(self, method):
        def call(*args):
            self.calls.append((method, *args))
            if method in self.fail:
                raise RuntimeError(f"{method} failed")
            return {"user": {"id": BOT}, "public_email": self.email, "hooks": self.hooks_list, "open_issues": self.issues,
                    "notes": self.notes_of.get(args[0] if args else None, []), "award": 5, "note": {"id": 500}}.get(method)
        return call

    def user(self):
        return {"id": BOT}

    def public_email(self, user_id):
        self.calls.append(("public_email", user_id))
        return self.email

    def of(self, method):
        return [c[1:] for c in self.calls if c[0] == method]


def issue_event(iid=7, author=42, project=PROJECT, action="open"):
    return {"object_kind": "issue", "project": {"path_with_namespace": project}, "user": {"id": author, "name": "Alice", "username": "alice"},
            "object_attributes": {"iid": iid, "title": "Login page", "description": "Members sign in.", "action": action, "author_id": author, "state": "opened"}}


def note_event(iid=7, note=11, author=43, project=PROJECT, system=False):
    return {"object_kind": "note", "project": {"path_with_namespace": project}, "user": {"id": author, "name": "Bob", "username": "bob"},
            "issue": {"iid": iid}, "object_attributes": {"id": note, "note": "Only with the e-mail address.", "noteable_type": "Issue", "author_id": author, "system": system}}


class SideTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        for name, file in (("CONVERSATIONS_FILE", "conversations.json"), ("POLLER_FILE", "poller-state.json"), ("WEBHOOK_FILE", "gitlab-webhook.json")):
            patcher = unittest.mock.patch.object(gitlab, name, os.path.join(self.dir, file))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.api = Api()
        self.handed = []
        self.chat_mode = self.start()

    def start(self, code="en"):
        return gitlab.ChatMode(self.api, self.handed.append, {"code": code}, "https://bot.example/webhooks/gitlab")

    def conversations(self):
        return json.loads(pathlib.Path(self.dir, "conversations.json").read_text())

    def poller(self, channels):
        pathlib.Path(self.dir, "poller-state.json").write_text(json.dumps({"channels": channels}))


class Intake(SideTest):
    def test_a_new_issue_is_acknowledged_recorded_and_handed_on_in_its_own_session(self):
        self.assertEqual(self.chat_mode.handle(issue_event()), "request")
        self.assertEqual(self.api.of("note"), [(7, "@alice Thanks, I've got your request and I'm looking into it. I'll answer here shortly.")])
        record = self.conversations()["7"]
        self.assertEqual({k: record[k] for k in ("chat_mode", "requester", "requester_username", "requester_email")},
                         {"chat_mode": "gitlab", "requester": 42, "requester_username": "alice", "requester_email": "alice@example.test"})
        [message] = self.handed
        self.assertEqual((message["iid"], message["text"], message["user_name"]), ("7", "Login page\n\nMembers sign in.", "Alice | GitLab user @alice"))

    def test_the_acknowledgement_is_in_the_bots_language_german_by_default(self):
        self.start("fr").handle(issue_event())
        self.assertTrue(self.api.of("note")[0][1].startswith("@alice Danke, ich habe deine Anfrage erhalten"))

    def test_the_trusted_line_names_issue_link_ticket_requester_address_and_language(self):
        self.chat_mode.handle(issue_event())
        self.assertEqual(self.chat_mode.prompt("7"), "This is the GitLab issue 7. Its conversation link is https://gitlab.example/acme/shop/-/issues/7. "
                         "Its ticket: none yet. Its requester: GitLab user @alice. Its requester's e-mail address: alice@example.test. "
                         "Answer in the language with ISO 639-1 code `en`.")
        self.poller({"7": {"ticket": "ACME-3"}})
        self.assertIn("Its ticket: ACME-3.", self.chat_mode.prompt("7"))

    def test_without_a_public_address_the_line_says_none(self):
        self.api.email = None
        with self.assertLogs("pm_bot.bot_channels", "WARNING"):
            self.chat_mode.handle(issue_event())
        self.assertNotIn("requester_email", self.conversations()["7"])
        self.assertIn("e-mail address: none.", self.chat_mode.prompt("7"))

    def test_a_failed_acknowledgement_still_hands_the_request_on(self):
        self.api.fail.add("note")
        with self.assertLogs("pm_bot.bot_channels", "ERROR"):
            self.chat_mode.handle(issue_event())
        self.assertEqual(len(self.handed), 1)

    def test_the_same_issue_delivered_twice_is_handled_once(self):
        self.chat_mode.handle(issue_event())
        self.assertEqual(self.chat_mode.handle(issue_event()), "already handled")
        self.assertEqual(len(self.handed), 1)


class Conversation(SideTest):
    def setUp(self):
        super().setUp()
        self.chat_mode.handle(issue_event())
        self.handed.clear()

    def test_a_participants_note_is_handed_on_once(self):
        self.assertEqual(self.chat_mode.handle(note_event()), "message")
        self.assertEqual(self.chat_mode.handle(note_event()), "already handled")
        [message] = self.handed
        self.assertEqual((message["iid"], message["text"], message["user_name"], message["note_id"]), ("7", "Only with the e-mail address.", "Bob | GitLab user @bob", 11))

    def test_what_the_bot_does_not_react_to(self):
        self.poller({"8": {"ticket": "ACME-4"}})
        cases = {
            "own note": note_event(author=BOT),
            "system note": note_event(system=True),
            "not a conversation": note_event(iid=8),
            "other project": note_event(project="acme/other"),
        }
        for expected, event in cases.items():
            self.assertEqual(self.chat_mode.handle(event), expected)
        self.assertEqual(self.chat_mode.handle(issue_event(iid=9, author=BOT)), "own issue")
        self.assertEqual(self.chat_mode.handle(issue_event(iid=10, action="update")), "not a new issue")
        self.assertEqual(self.handed, [])

    def test_a_note_on_the_issue_of_a_closed_ticket_is_not_handed_on(self):
        self.poller({"7": {"ticket": "ACME-3", "archived": True}})
        self.assertEqual(self.chat_mode.handle(note_event()), "not a conversation")
        self.assertEqual(self.handed, [])


class Webhook(SideTest):
    def test_only_the_hooks_secret_counts(self):
        self.assertTrue(self.chat_mode.verify({"X-Gitlab-Token": self.chat_mode.secret}))
        self.assertFalse(self.chat_mode.verify({"X-Gitlab-Token": "guess"}))
        self.assertFalse(self.chat_mode.verify({}))

    def test_the_secret_is_made_once_and_readable_only_by_the_bot(self):
        self.assertEqual(self.start().secret, self.chat_mode.secret)
        self.assertEqual(stat.S_IMODE(os.stat(gitlab.WEBHOOK_FILE).st_mode), 0o600)

    def test_the_hook_is_created_once_then_updated_and_other_hooks_stay(self):
        self.api.hooks_list = [{"id": 1, "url": "https://ci.example/hook"}]
        with self.assertLogs("pm_bot.bot_channels", "WARNING"):
            self.chat_mode.register_hook()
        [(settings,)] = self.api.of("add_hook")
        self.assertEqual(settings, {"url": "https://bot.example/webhooks/gitlab", "token": self.chat_mode.secret, "issues_events": True,
                                    "note_events": True, "push_events": False, "enable_ssl_verification": True})
        self.api.hooks_list.append({"id": 2, "url": "https://bot.example/webhooks/gitlab"})
        with self.assertLogs("pm_bot.bot_channels", "WARNING"):
            self.chat_mode.register_hook()
        self.assertEqual(len(self.api.of("add_hook")), 1)
        self.assertEqual([c[0] for c in self.api.of("edit_hook")], [2])
        self.assertEqual(self.api.of("test_hook"), [], "an executable hook gets no test delivery")

    def test_a_disabled_hook_is_updated_and_reenabled_by_a_test_delivery(self):
        self.api.hooks_list = [{"id": 2, "url": "https://bot.example/webhooks/gitlab", "alert_status": "disabled"}]
        with self.assertLogs("pm_bot.bot_channels", "WARNING"):
            self.chat_mode.register_hook()
        self.assertEqual([c[0] for c in self.api.of("edit_hook")], [2])
        self.assertEqual(self.api.of("test_hook"), [(2,)])

    def test_a_failed_reenabling_is_logged(self):
        self.api.hooks_list = [{"id": 2, "url": "https://bot.example/webhooks/gitlab", "alert_status": "temporarily_disabled"}]
        self.api.fail.add("test_hook")
        with self.assertLogs("pm_bot.bot_channels", "WARNING") as logs:
            self.chat_mode.register_hook()
        self.assertTrue(any("gitlab: webhook https://bot.example/webhooks/gitlab still disabled" in line for line in logs.output), logs.output)

    def test_a_failed_registration_is_logged_and_the_bot_keeps_running(self):
        self.api.fail.add("hooks")
        with self.assertLogs("pm_bot.bot_channels", "ERROR") as logs:
            self.chat_mode.register_hook()
        self.assertIn("gitlab: webhook https://bot.example/webhooks/gitlab not registered", logs.output[0])


class CatchUp(SideTest):
    def test_the_first_start_handles_none_of_the_existing_issues(self):
        self.api.issues = [{"iid": 3, "title": "Old", "author": {"id": 42, "username": "alice"}, "state": "opened"}]
        self.chat_mode.catch_up()
        self.assertEqual(self.handed, [])
        self.api.issues.append({"iid": 4, "title": "New", "author": {"id": 42, "username": "alice"}, "state": "opened"})
        self.start().catch_up()
        self.assertEqual([m["text"] for m in self.handed], ["New"])

    def test_what_came_while_the_bot_was_down_is_handled_once_after_a_restart(self):
        self.chat_mode.catch_up()
        self.chat_mode.handle(issue_event())
        self.handed.clear()
        self.api.issues = [{"iid": 7, "title": "Login page", "author": {"id": 42, "username": "alice"}, "state": "opened"},
                           {"iid": 8, "title": "Logout", "author": {"id": 44, "username": "carol"}, "author_id": 44, "state": "opened"}]
        self.api.notes_of = {"7": [{"id": 11, "body": "Only with the e-mail address.", "author": {"id": 43, "username": "bob"}},
                                   {"id": 12, "body": "Done.", "author": {"id": BOT}, "system": False}]}
        restarted = self.start()
        restarted.catch_up()
        restarted.catch_up()
        self.assertEqual([(m["iid"], m["kind"], m["text"]) for m in self.handed], [("8", "issue", "Logout"), ("7", "note", "Only with the e-mail address.")])


class Register(unittest.TestCase):
    """PM_BOT_CHAT picks the bot's chat mode when Hermes loads the plugin."""

    def registered(self, chat):
        calls = []
        ctx = types.SimpleNamespace(register_platform=lambda **kw: calls.append(("platform", kw["name"])),
                                    register_platform_handler=lambda name, factory: calls.append(("handler", name)),
                                    register_tool=lambda **kw: calls.append(("tool", kw["name"])))
        modules = {"gateway": types.ModuleType("gateway"), "gateway.session_unattended_unknown": types.ModuleType("gateway.session_unattended_unknown")}
        with unittest.mock.patch.dict(sys.modules, modules), unittest.mock.patch.dict(os.environ, {"PM_BOT_CHAT": chat}):
            sys.modules["bot_channels_gitlab"].register(ctx)
        return calls

    def test_gitlab_registers_the_platform_and_neither_slacks_handler_nor_the_channel_tool(self):
        self.assertEqual(self.registered("gitlab"), [("platform", "gitlab")])

    def test_slack_stays_as_it_was(self):
        self.assertEqual(self.registered(""), [("handler", "slack"), ("tool", "open_request_channel")])


if __name__ == "__main__":
    unittest.main()
