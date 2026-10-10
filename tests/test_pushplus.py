import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import requests

import checkin


class PushPlusTests(unittest.TestCase):
    def setUp(self):
        self.token = "test-pushplus-token"
        self.service = checkin.PushService(SimpleNamespace(push_token=self.token, push_channel="", push_option=""))

    @patch("checkin.requests.post")
    def test_missing_token_skips_request(self, post):
        service = checkin.PushService(SimpleNamespace(push_token="", push_channel="", push_option=""))
        self.assertFalse(service.send("title", "content"))
        post.assert_not_called()

    @patch("checkin.requests.post")
    def test_accepted_request_has_expected_payload(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"code": 200, "data": "message-id"}
        self.assertTrue(self.service.send("签到：失败1", "railgun.info 签到失败"))
        post.assert_called_once_with(
            "https://www.pushplus.plus/send",
            json={
                "token": self.token,
                "title": "签到：失败1",
                "content": "railgun.info 签到失败",
                "template": "txt",
            },
            timeout=(10, 30),
            allow_redirects=False,
        )

    @patch("checkin.requests.post")
    def test_http_errors_and_redirects_are_failures(self, post):
        for status in (301, 401, 429, 500):
            with self.subTest(status=status):
                post.return_value = Mock(status_code=status)
                self.assertFalse(self.service.send("title", "content"))
                post.return_value.json.assert_not_called()

    @patch("checkin.requests.post")
    def test_api_rejection_is_failure_without_logging_token(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"code": 100, "msg": self.token}
        with self.assertLogs(level="ERROR") as logs:
            self.assertFalse(self.service.send("title", "content"))
        self.assertNotIn(self.token, "\n".join(logs.output))

    @patch("checkin.requests.post")
    def test_invalid_response_is_failure(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.side_effect = ValueError("not JSON")
        self.assertFalse(self.service.send("title", "content"))
        post.return_value.json.side_effect = None
        for payload in ([], None, {}, {"code": 500}):
            with self.subTest(payload=payload):
                post.return_value.json.return_value = payload
                self.assertFalse(self.service.send("title", "content"))

    @patch("checkin.requests.post")
    def test_network_error_is_failure_without_logging_token(self, post):
        for error in (requests.Timeout(self.token), requests.ConnectionError(self.token)):
            with self.subTest(error=type(error).__name__):
                post.side_effect = error
                with self.assertLogs(level="ERROR") as logs:
                    self.assertFalse(self.service.send("title", "content"))
                self.assertNotIn(self.token, "\n".join(logs.output))

    def test_config_reads_pushplus_token(self):
        with patch.dict(os.environ, {"PUSHPLUS_TOKEN": self.token}, clear=True):
            self.assertEqual(checkin.Config().push_token, self.token)

    @patch("checkin.requests.post")
    def test_selected_channel_and_option_are_sent(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"code": 200}
        for channel, option in (("cmcc", ""), ("app", ""), ("webhook", "my-robot"), ("mail", "")):
            with self.subTest(channel=channel):
                config = SimpleNamespace(push_token=self.token, push_channel=channel, push_option=option)
                self.assertTrue(checkin.PushService(config).send("title", "content"))
                payload = post.call_args.kwargs["json"]
                self.assertEqual(payload["channel"], channel)
                if option:
                    self.assertEqual(payload["option"], option)
                else:
                    self.assertNotIn("option", payload)

    def test_config_reads_channel_and_option(self):
        with patch.dict(os.environ, {"PUSHPLUS_CHANNEL": " app ", "PUSHPLUS_OPTION": " "}, clear=True):
            config = checkin.Config()
        self.assertEqual(config.push_channel, "app")
        self.assertEqual(config.push_option, "")

    @patch("checkin.requests.post")
    def test_message_id_is_logged_without_token(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"code": 200, "data": "3cbc5eab19fe512e80677540fbde332a"}
        with self.assertLogs(level="INFO") as logs:
            self.assertTrue(self.service.send("title", "content"))
        self.assertIn("3cbc5eab19fe512e80677540fbde332a", "\n".join(logs.output))
        self.assertNotIn(self.token, "\n".join(logs.output))

    @patch("checkin.requests.post")
    def test_missing_cookies_still_sends_notification(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"code": 200}
        with patch.dict(os.environ, {"PUSHPLUS_TOKEN": self.token}, clear=True):
            checkin.main()
        post.assert_called_once()
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["token"], self.token)
        self.assertIn("未找到 cookies", payload["title"])

    @patch("checkin.requests.post")
    def test_config_error_still_sends_notification(self, post):
        post.return_value = Mock(status_code=200)
        post.return_value.json.return_value = {"code": 200}
        with patch.dict(os.environ, {"PUSHPLUS_TOKEN": self.token, "GLADOS_COOKIES": " & "}, clear=True):
            checkin.main()
        post.assert_called_once()
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["token"], self.token)
        self.assertIn("脚本执行出错", payload["title"])


if __name__ == "__main__":
    unittest.main()
