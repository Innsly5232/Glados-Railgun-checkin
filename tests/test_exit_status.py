import os
import unittest
from unittest.mock import Mock, patch

import checkin


class ExitStatusTests(unittest.TestCase):
    def test_hermes_delivery_failure_marks_action_failed(self):
        with patch.dict(os.environ, {"HERMES_WEBHOOK_SECRET": "test-secret"}, clear=True), patch(
                "checkin.PushService.send", return_value=False):
            with self.assertRaises(SystemExit) as raised:
                checkin.main()
        self.assertEqual(raised.exception.code, 1)

    def test_unexpected_checker_error_notifies_before_exiting_with_failure(self):
        for push_code in (200, 100):
            with self.subTest(push_code=push_code):
                response = Mock(status_code=200)
                response.json.return_value = {"code": push_code}
                environment = {
                    "GLADOS_COOKIES": "test-cookie",
                    "PUSHPLUS_TOKEN": "test-token",
                    "PUSHPLUS_CHANNEL": "cmcc",
                }
                with patch.dict(os.environ, environment, clear=True), patch(
                    "checkin.Checker.checkin_all", side_effect=RuntimeError("mock script error")
                ), patch("checkin.requests.post", return_value=response) as post, self.assertLogs(level="INFO"):
                    with self.assertRaises(SystemExit) as raised:
                        checkin.main()

                self.assertEqual(raised.exception.code, 1)
                post.assert_called_once()
                payload = post.call_args.kwargs["json"]
                self.assertEqual(payload["title"], "# 脚本执行出错")
                self.assertEqual(payload["content"], "mock script error")
                self.assertEqual(payload["channel"], "cmcc")
                self.assertEqual(payload["template"], "txt")

    def test_push_rejection_keeps_existing_normal_exit_behavior(self):
        response = Mock(status_code=200)
        response.json.return_value = {"code": 100}
        with patch.dict(os.environ, {"PUSHPLUS_TOKEN": "test-token"}, clear=True), patch(
            "checkin.requests.post", return_value=response
        ) as post, self.assertLogs(level="INFO"):
            self.assertIsNone(checkin.main())
        post.assert_called_once()
        self.assertEqual(post.call_args.kwargs["json"]["title"], checkin.Checker.COOKIE_ALERT_TITLE)


if __name__ == "__main__":
    unittest.main()
