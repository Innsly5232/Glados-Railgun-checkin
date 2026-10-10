import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

import checkin


class NotificationSummaryTests(unittest.TestCase):
    def checker(self, results):
        checker = checkin.Checker(SimpleNamespace(verbose=False))
        checker.results = results
        return checker

    def valid_result(self, index=1, *, code=checkin.CheckinStatus.REPEAT, days="381 天", points="10 积分"):
        return checkin.CheckinResult(
            index, "glados.cloud", status="签到失败" if code == checkin.CheckinStatus.FAILURE else "重复签到",
            code=code, days=days, points_total=points,
            exchange="未配置兑换计划，跳过自动兑换",
        )

    def test_mixed_results_keep_original_format_and_complete_log(self):
        checker = self.checker([
            self.valid_result(),
            checkin.CheckinResult(1, "railgun.info", days="None 天", points_total="None 积分"),
            self.valid_result(2, days="374 天"),
            checkin.CheckinResult(2, "railgun.info", days="None 天", points_total="None 积分"),
        ])
        title, content, _ = checker.format_results(valid_only=True)
        self.assertEqual(title, "GLaDOS 签到, 成功0, 失败0, 重复2")
        self.assertEqual(content, (
            "#1 P:0 剩余:381 天 总积分:10 积分 | 重复签到 | 未配置兑换计划，跳过自动兑换\n"
            "#2 P:0 剩余:374 天 总积分:10 积分 | 重复签到 | 未配置兑换计划，跳过自动兑换"
        ))
        full_title, full_content, full_log = checker.format_results()
        self.assertEqual(full_title, "GLaDOS 签到, 成功0, 失败2, 重复2")
        self.assertEqual(len(full_content.splitlines()), 4)
        self.assertIn("#4 签到失败", full_log)
        self.assertEqual(len(checker.results), 4)

    def test_failure_with_valid_account_data_is_still_reported(self):
        checker = self.checker([self.valid_result(code=checkin.CheckinStatus.FAILURE)])
        title, content, _ = checker.format_results(valid_only=True)
        self.assertEqual(title, "GLaDOS 签到, 成功0, 失败1, 重复0")
        self.assertIn("总积分:10 积分 | 签到失败", content)

    def test_insufficient_points_are_shortened_only_in_notification(self):
        original = "兑换失败: Not enough points. Need 500, have 10.0000000000000000"
        result = self.valid_result()
        result.exchange = original
        checker = self.checker([result])
        checker.config.verbose = True
        title, content, _ = checker.format_results(valid_only=True)
        self.assertEqual(title, "GLaDOS 签到, 成功0, 失败0, 重复1")
        self.assertEqual(content, (
            "#1 P:0 剩余:381 天 总积分:10 积分 | 重复签到 | 积分不足（10/500），暂未兑换"
        ))
        _, full_content, full_log = checker.format_results()
        self.assertIn(original, full_content)
        self.assertIn(original, full_log)
        self.assertEqual(result.exchange, original)

    def test_insufficient_points_preserve_amounts_and_trim_decimal_zeros(self):
        for required, available, expected in (
            ("100", "0.0000000000000000", "0/100"),
            ("200", "10.5000000000000000", "10.5/200"),
            ("500.000", "100", "100/500"),
        ):
            with self.subTest(required=required, available=available):
                result = self.valid_result()
                result.exchange = f"兑换失败: Not enough points. Need {required}, have {available}."
                content = self.checker([result]).format_results(valid_only=True)[1]
                self.assertTrue(content.endswith(f"积分不足（{expected}），暂未兑换"))

    def test_other_exchange_messages_are_kept_unchanged(self):
        for message in (
            "兑换成功: plan500", "兑换失败: No permission", "兑换失败",
            "未配置兑换计划，跳过自动兑换",
            "兑换失败: Not enough points. Need 500, have unknown",
        ):
            with self.subTest(message=message):
                result = self.valid_result()
                result.exchange = message
                content = self.checker([result]).format_results(valid_only=True)[1]
                self.assertTrue(content.endswith(" | " + message))

    def test_zero_days_and_zero_points_are_valid(self):
        checker = self.checker([self.valid_result(days="0 天", points="0 积分")])
        title, content, _ = checker.format_results(valid_only=True)
        self.assertEqual(title, "GLaDOS 签到, 成功0, 失败0, 重复1")
        self.assertIn("剩余:0 天 总积分:0 积分", content)

    def test_both_account_fields_are_required(self):
        for days, points in (("381 天", "None 积分"), ("None 天", "10 积分")):
            with self.subTest(days=days, points=points):
                checker = self.checker([self.valid_result(days=days, points=points)])
                title, content, _ = checker.format_results(valid_only=True)
                self.assertEqual(title, checkin.Checker.COOKIE_ALERT_TITLE)
                self.assertIn("GLADOS_COOKIES", content)

    def test_all_invalid_or_empty_results_produce_nonempty_alert(self):
        for results in ([], [checkin.CheckinResult(1, "glados.cloud"), checkin.CheckinResult(1, "railgun.info")]):
            with self.subTest(count=len(results)):
                title, content, _ = self.checker(results).format_results(valid_only=True)
                self.assertIn("Cookie 可能已失效", title)
                self.assertIn("网络或服务异常", content)

    def run_main(self, all_invalid=False, exchange_plan=None):
        instances = []

        def make_api(domain, *args, **kwargs):
            api = MagicMock()
            api.__enter__.return_value = api
            valid = domain == "glados.cloud" and not all_invalid
            api.get_status.return_value = ("381 天", 0) if valid else ("None 天", -2)
            api.get_points.return_value = ("10 积分", 10) if valid else ("None 积分", 0)
            api.checkin.return_value = {
                "status": "重复签到" if valid else "签到失败",
                "code": checkin.CheckinStatus.REPEAT if valid else checkin.CheckinStatus.FAILURE,
            }
            api.exchange.return_value = "兑换失败: Not enough points. Need 500, have 10.0000000000000000"
            instances.append(api)
            return api

        response = Mock(status_code=200)
        response.json.return_value = {"code": 200}
        environment = {
            "GLADOS_COOKIES": "test-cookie-1&test-cookie-2",
            "PUSHPLUS_TOKEN": "test-token",
            "PUSHPLUS_CHANNEL": "cmcc",
        }
        if exchange_plan:
            environment["GLADOS_EXCHANGE_PLAN"] = exchange_plan
            environment["GLADOS_VERBOSE"] = "true"
        with patch.dict(os.environ, environment, clear=True), patch("checkin.API", side_effect=make_api) as api_class, patch("checkin.requests.post", return_value=response) as post, self.assertLogs(level="INFO") as logs:
            checkin.main()
        self.assertEqual(api_class.call_count, 4)
        for index, api in enumerate(instances):
            api.get_status.assert_called_once()
            api.checkin.assert_called_once()
            api.get_points.assert_called_once()
            if exchange_plan:
                api.exchange.assert_called_once_with(
                    f"test-cookie-{index // 2 + 1}", exchange_plan,
                    checkin.Config.EXCHANGE_PLANS[exchange_plan],
                )
            else:
                api.exchange.assert_not_called()
        post.assert_called_once()
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["channel"], "cmcc")
        self.assertEqual(payload["template"], "txt")
        json.dumps(payload)
        return payload, "\n".join(logs.output)

    def test_main_sends_filtered_summary_and_keeps_all_checks(self):
        payload, logs = self.run_main()
        self.assertEqual(payload["title"], "GLaDOS 签到, 成功0, 失败0, 重复2")
        self.assertEqual(len(payload["content"].splitlines()), 2)
        self.assertNotIn("None", payload["content"])
        self.assertIn("GLaDOS 签到, 成功0, 失败2, 重复2", logs)

    def test_main_all_invalid_still_sends_cmcc_alert(self):
        payload, logs = self.run_main(all_invalid=True)
        self.assertEqual(payload["title"], checkin.Checker.COOKIE_ALERT_TITLE)
        self.assertIn("GLADOS_COOKIES", payload["content"])
        self.assertIn("GLaDOS 签到, 成功0, 失败4, 重复0", logs)

    def test_main_shortens_sms_without_changing_plan500_exchange_or_logs(self):
        payload, logs = self.run_main(exchange_plan="plan500")
        self.assertEqual(payload["title"], "GLaDOS 签到, 成功0, 失败0, 重复2")
        self.assertEqual(payload["content"], (
            "#1 P:0 剩余:381 天 总积分:10 积分 | 重复签到 | 积分不足（10/500），暂未兑换\n"
            "#2 P:0 剩余:381 天 总积分:10 积分 | 重复签到 | 积分不足（10/500），暂未兑换"
        ))
        self.assertIn("Not enough points. Need 500, have 10.0000000000000000", logs)


if __name__ == "__main__":
    unittest.main()
