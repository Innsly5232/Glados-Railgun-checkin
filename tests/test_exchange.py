import os
import unittest
from unittest.mock import patch

import checkin


class ExchangeTests(unittest.TestCase):
    def run_account(self, points, plan="plan500"):
        with patch.dict(os.environ, {"GLADOS_COOKIES": "test-only", "GLADOS_EXCHANGE_PLAN": plan}, clear=True):
            config = checkin.Config()
        with patch("checkin.API") as api_class:
            api = api_class.return_value.__enter__.return_value
            api.get_status.return_value = ("12 天", 0)
            api.checkin.return_value = {"status": "重复签到", "code": checkin.CheckinStatus.REPEAT}
            api.get_points.return_value = points
            api.exchange.return_value = "兑换成功: plan500"
            result = checkin.Checker(config)._checkin_on_domain("test-only", 1, "glados.cloud")
        return result, api

    def test_below_500_does_not_redeem(self):
        result, api = self.run_account(("499 积分", 499))
        api.exchange.assert_not_called()
        self.assertIn("499/500", result.exchange)

    def test_500_redeems_even_after_repeat_checkin(self):
        result, api = self.run_account(("500 积分", 500))
        api.exchange.assert_called_once_with("test-only", "plan500", 500)
        self.assertEqual(result.exchange, "兑换成功: plan500")

    def test_unknown_points_does_not_redeem(self):
        result, api = self.run_account(("None 积分", 0))
        api.exchange.assert_not_called()
        self.assertIn("未获取到积分", result.exchange)

    def test_none_disables_redemption(self):
        result, api = self.run_account(("1000 积分", 1000), plan="none")
        api.exchange.assert_not_called()
        self.assertIn("跳过自动兑换", result.exchange)


if __name__ == "__main__":
    unittest.main()
