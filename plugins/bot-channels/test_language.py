"""Tests of the language core: python3 -m unittest discover -s plugins/bot-channels"""

import json
import os
import tempfile
import unittest
from unittest import mock

import language


def _no_network(*args, **kwargs):
    raise AssertionError("the language start called the network")


class Start(unittest.TestCase):
    """start() takes the language from PM_BOT_LANGUAGE in the container's env, with no I/O but the
    file it shares with the poller."""

    def start(self, env, path=None):
        path = path or os.path.join(tempfile.mkdtemp(), "bot-language.json")
        holder = {"code": "de"}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch("urllib.request.urlopen", _no_network), \
                self.assertLogs("pm_bot.bot_channels", "WARNING") as logs:
            language.start(holder, path)
        return holder["code"], path, logs.output

    def assert_written(self, path, code):
        with open(path) as fh:
            self.assertEqual(json.load(fh), {"language": code})

    def test_a_box_with_only_a_subscription_token_answers_in_the_configured_language(self):
        code, path, logs = self.start({"CLAUDE_CODE_OAUTH_TOKEN": "t", "PM_BOT_LANGUAGE": "en"})
        self.assertEqual(code, "en")
        self.assert_written(path, "en")
        self.assertEqual(logs, ["WARNING:pm_bot.bot_channels:bot-channels: answering in en"])


    def test_a_box_with_an_api_key_answers_in_the_configured_language(self):
        code, path, logs = self.start({"ANTHROPIC_API_KEY": "k", "PM_BOT_LANGUAGE": "en"})
        self.assertEqual(code, "en")
        self.assert_written(path, "en")
        self.assertEqual(logs, ["WARNING:pm_bot.bot_channels:bot-channels: answering in en"])

    def test_unset_or_de_is_german_and_logged(self):
        for env in ({}, {"PM_BOT_LANGUAGE": ""}, {"PM_BOT_LANGUAGE": "de"}, {"PM_BOT_LANGUAGE": " DE\n"}):
            code, path, logs = self.start(env)
            self.assertEqual(code, "de", env)
            self.assert_written(path, "de")
            self.assertEqual(logs, ["WARNING:pm_bot.bot_channels:bot-channels: answering in de"], env)

    def test_a_value_that_is_no_code_is_german_and_names_the_setting(self):
        for value in ("English", "e", "en-US"):
            code, path, logs = self.start({"PM_BOT_LANGUAGE": value})
            self.assertEqual(code, "de", value)
            self.assert_written(path, "de")
            self.assertEqual(logs, [
                f'ERROR:pm_bot.bot_channels:bot-channels: language: PM_BOT_LANGUAGE "{value}" is not an ISO 639-1 code; answering in German',
                "WARNING:pm_bot.bot_channels:bot-channels: answering in de",
            ], value)

    def test_the_profile_on_the_site_plays_no_part(self):
        # bakers_user_read returns profiles: [{workspace, position, background}]; the start never reads it.
        site = mock.Mock(return_value={"profiles": [{"workspace": "w", "position": "PM", "background": "Answer in English."}]})
        env = {"BAKERS_URL": "https://bakers.example", "BAKERS_API_KEY": "k", "PM_BOT_MODEL": "m", "CLAUDE_CODE_OAUTH_TOKEN": "t"}
        with mock.patch.object(language, "read_tool", site):
            code, _, _ = self.start(env)
        self.assertEqual(code, "de")
        site.assert_not_called()

    def test_a_failed_write_is_logged_and_keeps_the_code(self):
        holder = {"code": "de"}
        with mock.patch.dict(os.environ, {"PM_BOT_LANGUAGE": "en"}, clear=True), \
                self.assertLogs("pm_bot.bot_channels", "ERROR"):
            language.start(holder, "/nonexistent/dir/bot-language.json")
        self.assertEqual(holder["code"], "en")

if __name__ == "__main__":
    unittest.main()
