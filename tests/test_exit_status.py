import os
import unittest
from unittest.mock import patch

import checkin


class ExitStatusTests(unittest.TestCase):
    def test_hermes_delivery_failure_marks_action_failed(self):
        with patch.dict(os.environ, {"HERMES_WEBHOOK_SECRET": "test-secret"}, clear=True), \
                patch("checkin.PushService.send", return_value=False):
            with self.assertRaises(SystemExit) as raised:
                checkin.main()
        self.assertEqual(raised.exception.code, 1)

    def test_unexpected_runner_error_notifies_before_exiting_with_failure(self):
        environment = {
            "GLADOS_COOKIES": "koa:sess=test-cookie",
            "HERMES_WEBHOOK_SECRET": "test-secret",
        }
        with patch.dict(os.environ, environment, clear=True), \
                patch("checkin.CheckinRunner.run", side_effect=RuntimeError("mock script error")), \
                patch("hermes_notify.send") as deliver:
            with self.assertRaises(SystemExit) as raised:
                checkin.main()

        self.assertEqual(raised.exception.code, 1)
        deliver.assert_called_once()

    def test_any_account_failure_marks_action_failed(self):
        environment = {
            "GLADOS_COOKIES": "koa:sess=test-cookie",
        }
        failed = checkin.CookieEntry.build(1, "koa:sess=test-cookie")
        failed.result = checkin.CheckinResult.failure("glados.cloud")
        with patch.dict(os.environ, environment, clear=True), \
                patch("checkin.CheckinRunner.run", return_value=checkin.Report(checkin.Accounts([failed]))), \
                patch("checkin.PushService.send", return_value=False):
            with self.assertRaises(SystemExit) as raised:
                checkin.main()
        self.assertEqual(raised.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
