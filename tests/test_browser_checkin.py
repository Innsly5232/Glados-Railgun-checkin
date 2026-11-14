import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import checkin


class BrowserCheckinTests(unittest.TestCase):
    def test_browser_uses_site_post_and_isolates_account_cookies(self):
        page = MagicMock()
        browser = MagicMock()
        context = browser.new_context.return_value
        context.new_page.return_value = page
        playwright = MagicMock()
        playwright.chromium.launch.return_value = browser
        runtime = MagicMock()
        runtime.__enter__.return_value = playwright
        handlers = {}
        page.on.side_effect = lambda event, callback: handlers.update({event: callback})
        reply = MagicMock(url='https://glados.cloud/api/user/checkin')
        reply.request.method = 'POST'
        reply.json.return_value = {'code': 0, 'points': 2, 'repeated': False}
        page.get_by_role.return_value.click.side_effect = lambda **kwargs: handlers['response'](reply)
        module = types.ModuleType('playwright.sync_api')
        module.sync_playwright = lambda: runtime
        with patch.dict(sys.modules, {'playwright.sync_api': module}), \
                checkin.API('glados.cloud', 'gld:sess=test==; gld:sess.sig=signature',
                            checkin_mode='browser') as api:
            result = api.checkin()
        self.assertIs(result.code, checkin.CheckinStatus.SUCCESS)
        self.assertEqual(result.points, 2)
        browser.close.assert_called_once()
        self.assertEqual(context.add_cookies.call_args.args[0], [
            {'name': 'gld:sess', 'value': 'test==', 'url': 'https://glados.cloud', 'secure': True},
            {'name': 'gld:sess.sig', 'value': 'signature', 'url': 'https://glados.cloud', 'secure': True},
        ])
        playwright.chromium.launch.assert_called_once_with(headless=True)

    def test_railgun_keeps_working_api_without_browser(self):
        response = MagicMock()
        response.json.return_value = {'code': 1}
        with checkin.API('railgun.info', 'koa:sess=test', checkin_mode='browser') as api, \
                patch.object(api, 'request', return_value=response) as request, \
                patch.object(api, '_browser_checkin') as browser:
            result = api.checkin()
        self.assertIs(result.code, checkin.CheckinStatus.REPEAT)
        browser.assert_not_called()
        self.assertEqual(request.call_args.kwargs['data'], {'token': 'railgun.info'})

    def test_repeated_response_is_not_new_points(self):
        result = checkin.parse_checkin({'code': '0', 'repeated': True, 'points': 2},
                                       'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.REPEAT)
        self.assertEqual(result.points, 0)

    def test_verification_failure_cannot_be_reported_as_success(self):
        result = checkin.parse_checkin({'code': 4, 'reason': 'turnstile', 'checkedIn': True},
                                       'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.FAILURE)

    def test_diagnostic_never_copies_secrets_or_unknown_fields(self):
        diagnostic = checkin.browser_submission_diagnostic({
            'tsState': 'timeout', 'turnstile': 'PRIVATE_TOKEN',
            'nonce': 'PRIVATE_NONCE', 'proof': 'PRIVATE_PROOF',
        })
        self.assertEqual(diagnostic, {'state': 'timeout', 'token_present': True})
        self.assertNotIn('PRIVATE', repr(diagnostic))
        self.assertEqual(checkin.browser_submission_diagnostic({'tsState': 'PRIVATE'}),
                         {'state': 'unknown', 'token_present': False})

    def test_timeout_and_server_rejection_are_distinct(self):
        for state, expected in [('timeout', '等待超时'), ('error', '发生错误'),
                                ('ok', '已生成验证结果')]:
            result = checkin.parse_checkin({
                'code': 4, 'reason': 'turnstile',
                'browser_diagnostic': {'state': state, 'token_present': True},
            }, 'glados.cloud', lambda *args: None)
            self.assertIn(expected, result.failure_reason)
            self.assertIs(result.code, checkin.CheckinStatus.FAILURE)

    def test_browser_failure_stage_is_safe_and_specific(self):
        result = checkin.parse_checkin({
            'client_error': 'browser-unavailable', 'browser_stage': 'button',
        }, 'glados.cloud', lambda *args: None)
        self.assertIn('查找签到按钮', result.failure_reason)

    def test_missing_browser_is_actionable(self):
        result = checkin.parse_checkin({'client_error': 'browser-unavailable'},
                                       'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.FAILURE)
        self.assertIn('Chromium', result.failure_reason)
