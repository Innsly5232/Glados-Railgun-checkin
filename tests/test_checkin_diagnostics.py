import json
import io
import os
import unittest
from unittest.mock import patch

import requests

import checkin


class CheckinDiagnosticsTests(unittest.TestCase):
    def run_account(self, challenge, response=None, *, points_available=True,
                    domain='glados.cloud', challenge_status=200, exchange_plan='plan500',
                    mode='challenge'):
        calls = []

        def send(session, request, **kwargs):
            calls.append(request)
            reply = requests.Response()
            reply.status_code = 200
            reply.request = request
            if request.url.endswith('/status'):
                payload = {'code': 0, 'data': {'leftDays': 346}}
            elif request.url.endswith('/challenge'):
                reply.status_code = challenge_status
                payload = challenge
            elif request.url.endswith('/checkin'):
                payload = response or {'code': 0, 'points': 5}
            elif request.url.endswith('/points'):
                payload = {'code': 0, 'points': 226} if points_available else {}
            else:
                self.fail('Unexpected request: ' + request.url)
            reply._content = json.dumps(payload).encode()
            return reply

        account = json.dumps([{
            'name': 'test-account', 'origin': domain,
            'cookie': 'koa:sess=test-only',
        }])
        environment = {'GLADOS_COOKIES': account, 'GLADOS_EXCHANGE_PLAN': exchange_plan}
        if mode is not None:
            environment['GLADOS_CHECKIN_MODE'] = mode
        with patch.dict(os.environ, environment, clear=True), \
                patch.object(requests.Session, 'send', send), \
                patch('checkin.time.sleep'):
            report = checkin.CheckinRunner(checkin.Config()).run()
        return report, calls

    def test_required_human_verification_stops_before_checkin_and_exchange(self):
        report, calls = self.run_account({
            'code': 0, 'nonce': 'test-nonce',
            'turnstile': {'sitekey': 'public-test-sitekey'},
        })
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.FAILURE)
        self.assertFalse(any(r.method == 'POST' for r in calls))
        self.assertIn('人机验证', report.render())
        _, notification = checkin.PushService._notification(report)
        self.assertIn('人机验证', notification)

    def test_server_turnstile_rejection_is_actionable_in_notification(self):
        report, calls = self.run_account(
            {'code': 0, 'nonce': 'test-nonce'},
            {'code': 4, 'reason': 'turnstile', 'message': 'Verification required'},
        )
        _, notification = checkin.PushService._notification(report)
        self.assertIn('人机验证', notification)
        self.assertEqual(sum(r.url.endswith('/checkin') for r in calls), 1)

    def test_known_failure_remains_visible_when_points_query_fails(self):
        report, _ = self.run_account(
            {'code': 0, 'nonce': 'test-nonce', 'turnstile': True},
            points_available=False,
        )
        title, notification = checkin.PushService._notification(report)
        self.assertNotEqual(title, checkin.PushService.COOKIE_ALERT_TITLE)
        self.assertIn('人机验证', notification)

    def test_non_turnstile_challenge_sends_explicit_off_state(self):
        # No exchange on this failure: the test never exercises a real service.
        _, calls = self.run_account(
            {'code': 0, 'nonce': 'test-nonce'},
            {'code': -2},
        )
        request = next(r for r in calls if r.url.endswith('/checkin'))
        body = json.loads(request.body)
        self.assertEqual(body['tsState'], 'off')
        self.assertEqual(body['proof'], checkin.hashlib.sha256(
            b'test-nonce.glados-observe-v1').hexdigest())

    def test_device_mismatch_is_distinct_from_cookie_expiry(self):
        logs = []
        result = checkin.parse_checkin(
            {'code': 4, 'reason': 'device-mismatch', 'loginDevice': 'macOS'},
            'glados.cloud', lambda *args: logs.append(args),
        )
        self.assertIn('User-Agent', result.failure_reason)
        self.assertNotIn('Cookie', result.failure_reason)

    def test_railgun_legacy_checkin_still_works_without_challenge(self):
        report, calls = self.run_account(
            {}, {'code': 0, 'points': 1}, domain='railgun.info',
            challenge_status=404, exchange_plan='',
        )
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.SUCCESS)
        self.assertEqual(report.entries[0].result.points, 1)
        request = next(r for r in calls if r.url.endswith('/checkin'))
        self.assertEqual(request.body, 'token=railgun.info')
        self.assertEqual(request.headers['Content-Type'], 'application/x-www-form-urlencoded')

    def test_explicit_legacy_mode_uses_original_form_checkin(self):
        report, calls = self.run_account(
            {'code': 0, 'nonce': 'unused-nonce', 'turnstile': True},
            {'code': 0, 'points': 1}, mode='legacy', exchange_plan='',
        )
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.SUCCESS)
        self.assertEqual(report.entries[0].result.points, 1)
        self.assertEqual([r.url.rsplit('/', 1)[-1] for r in calls],
                         ['status', 'checkin', 'points'])
        request = next(r for r in calls if r.url.endswith('/checkin'))
        self.assertEqual(request.body, 'token=glados.cloud')
        self.assertEqual(request.headers['Content-Type'], 'application/x-www-form-urlencoded')

    def test_default_mode_observes_explicit_verification_requirement(self):
        report, calls = self.run_account(
            {'code': 0, 'nonce': 'test-nonce', 'turnstile': True}, mode=None,
        )
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.FAILURE)
        self.assertEqual([r.url.rsplit('/', 1)[-1] for r in calls],
                         ['status', 'challenge', 'points'])
        self.assertIn('本次未提交签到', report.entries[0].result.failure_reason)

    def test_legacy_server_rejection_stays_failed_and_is_not_replayed(self):
        report, calls = self.run_account(
            {}, {'code': 4, 'reason': 'turnstile'}, mode='legacy',
        )
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.FAILURE)
        self.assertEqual([r.url.rsplit('/', 1)[-1] for r in calls],
                         ['status', 'checkin', 'points'])
        self.assertIn('人机验证', checkin.PushService._notification(report)[1])

    def test_legacy_wrong_domain_message_is_not_reported_as_success(self):
        report, _ = self.run_account(
            {}, {'code': 0, 'message': 'please checkin via https://glados.cloud'},
            mode='legacy',
        )
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.FAILURE)
        self.assertIn('域名不匹配', report.entries[0].result.failure_reason)

    def test_legacy_device_recovery_keeps_original_protocol(self):
        calls = []

        def send(session, request, **kwargs):
            calls.append(request)
            reply = requests.Response()
            reply.status_code = 200
            reply.request = request
            payload = ({'code': 4, 'reason': 'device-mismatch', 'loginDevice': 'Windows'}
                       if len(calls) == 1 else {'code': 0, 'points': 1})
            reply._content = json.dumps(payload).encode()
            return reply

        with patch.object(requests.Session, 'send', send), \
                checkin.API('glados.cloud', 'koa:sess=test-only', checkin_mode='legacy') as api:
            result = api.checkin()
        self.assertIs(result.code, checkin.CheckinStatus.SUCCESS)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(r.body == 'token=glados.cloud' for r in calls))
        self.assertEqual(calls[0].headers['user-agent'], checkin.PLATFORM_UA['macOS'])
        self.assertEqual(calls[1].headers['user-agent'], checkin.PLATFORM_UA['Windows'])

    def test_invalid_mode_fails_before_any_network_request(self):
        with patch.object(requests.Session, 'send') as send:
            with self.assertRaises(ValueError):
                checkin.Config({'GLADOS_CHECKIN_MODE': 'invalid'})
            send.assert_not_called()

    def test_actions_annotations_expose_results_without_account_credentials(self):
        entry = checkin.CookieEntry.build(1, 'koa:sess=test-only-private', name='test-private-name')
        entry.result = checkin.CheckinResult(domain='glados.cloud',
                                           code=checkin.CheckinStatus.SUCCESS, points=1)
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}, clear=True), \
                patch('sys.stdout', new_callable=io.StringIO) as output:
            checkin.Report(checkin.Accounts([entry])).emit_actions_annotations()
        self.assertIn('::notice title=GLaDOS result 1::glados.cloud | 签到成功 | 本次积分=1', output.getvalue())
        self.assertNotIn('test-private-name', output.getvalue())
        self.assertNotIn('test-only-private', output.getvalue())

    def test_actions_annotation_escapes_workflow_command_injection(self):
        entry = checkin.CookieEntry.build(1, 'koa:sess=test-only')
        entry.result = checkin.CheckinResult(domain='test.invalid\n::error::test%message')
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'true'}, clear=True), \
                patch('sys.stdout', new_callable=io.StringIO) as output:
            checkin.Report(checkin.Accounts([entry])).emit_actions_annotations()
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertIn('%0A::error::test%25message', output.getvalue())

    def test_unknown_response_content_is_not_copied_into_summary(self):
        result = checkin.parse_checkin(
            {'code': 4, 'reason': 'test-only-sensitive-value',
             'message': 'test-only-private-message'},
            'glados.cloud', lambda *args: None,
        )
        self.assertIn('code=4', result.failure_reason)
        self.assertNotIn('test-only', result.failure_reason)


if __name__ == '__main__':
    unittest.main()
