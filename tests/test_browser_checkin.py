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

    def test_repeated_response_is_not_new_points(self):
        result = checkin.parse_checkin({'code': '0', 'repeated': True, 'points': 2},
                                       'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.REPEAT)
        self.assertEqual(result.points, 0)

    def test_verification_failure_cannot_be_reported_as_success(self):
        result = checkin.parse_checkin({'code': 4, 'reason': 'turnstile', 'checkedIn': True},
                                       'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.FAILURE)

    def test_missing_browser_is_actionable(self):
        result = checkin.parse_checkin({'client_error': 'browser-unavailable'},
                                       'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.FAILURE)
        self.assertIn('Chromium', result.failure_reason)
