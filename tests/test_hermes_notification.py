import os
import unittest
from unittest.mock import patch

import checkin


class HermesNotificationTests(unittest.TestCase):
    def setUp(self):
        config = type("ConfigStub", (), {"hermes_secret": ""})()
        self.service = checkin.PushService(config)
        self.report = checkin.Report.failed("test content")

    def test_hermes_is_used_when_configured(self):
        with patch.dict(os.environ, {"HERMES_WEBHOOK_SECRET": "test-secret"}), \
                patch("hermes_notify.send") as deliver:
            self.assertTrue(self.service.send(self.report))
        deliver.assert_called_once_with(
            "# 脚本执行出错",
            "test content",
            route="github-glados",
        )

    def test_missing_hermes_secret_skips_notification(self):
        with patch.dict(os.environ, {}, clear=True), patch("hermes_notify.send") as deliver:
            self.assertFalse(self.service.send(self.report))
        deliver.assert_not_called()


if __name__ == "__main__":
    unittest.main()
