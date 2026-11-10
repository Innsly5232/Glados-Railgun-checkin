import unittest

import checkin


def entry(index=1, *, code=checkin.CheckinStatus.REPEAT, days=381, points_total=10, exchange=""):
    item = checkin.CookieEntry.build(index, f"koa:sess=test-{index}", name=f"账号{index}")
    item.result = checkin.CheckinResult(
        domain="glados.cloud",
        points=0,
        days=days,
        points_total=points_total,
        exchange=exchange,
        code=code,
    )
    return item


class NotificationSummaryTests(unittest.TestCase):
    def test_invalid_account_data_is_filtered_from_notification(self):
        report = checkin.Report(checkin.Accounts([
            entry(1),
            entry(2, days=None, points_total=None, code=checkin.CheckinStatus.FAILURE),
            entry(3, days=374),
        ]))
        title, content = checkin.PushService._notification(report)
        self.assertEqual(title, "GLaDOS 签到, 成功0, 失败0, 重复2")
        self.assertEqual(len(content.splitlines()), 2)
        self.assertNotIn("None", content)

    def test_failure_with_valid_account_data_is_still_reported(self):
        report = checkin.Report(checkin.Accounts([
            entry(code=checkin.CheckinStatus.FAILURE),
        ]))
        title, content = checkin.PushService._notification(report)
        self.assertEqual(title, "GLaDOS 签到, 成功0, 失败1, 重复0")
        self.assertIn("签到失败", content)

    def test_insufficient_points_are_shortened_only_in_notification(self):
        original = "兑换失败: Not enough points. Need 500, have 10.0000000000000000"
        report = checkin.Report(checkin.Accounts([entry(exchange=original)]))
        _, content = checkin.PushService._notification(report)
        self.assertIn("积分不足（10/500），暂未兑换", content)
        self.assertNotIn(original, content)

    def test_all_invalid_results_produce_cookie_alert(self):
        report = checkin.Report(checkin.Accounts([
            entry(days=None, points_total=None, code=checkin.CheckinStatus.FAILURE),
        ]))
        title, content = checkin.PushService._notification(report)
        self.assertEqual(title, checkin.PushService.COOKIE_ALERT_TITLE)
        self.assertIn("GLADOS_COOKIES", content)


if __name__ == "__main__":
    unittest.main()
