import unittest
from unittest.mock import patch, MagicMock

import checkin
from extension_checkin import summarize


class ExtensionCheckinTests(unittest.TestCase):
    def test_private_page_data_is_not_in_diagnostics(self):
        raw = summarize({'ok': False, 'email': 'private@example.invalid',
                         'message': 'PRIVATE', 'verificationRequired': True,
                         'verificationError': '300030', 'checkinAttempted': False})
        self.assertEqual(raw['client_error'], 'human-verification-required')
        self.assertEqual(raw['extension_diagnostic']['verification_error'], '300030')
        self.assertNotIn('PRIVATE', repr(raw))
        self.assertNotIn('private@', repr(raw))

    def test_unconfirmed_code_zero_cannot_be_success(self):
        raw = summarize({'ok': False, 'code': 0, 'reason': 'turnstile'})
        self.assertNotEqual(raw.get('code'), 0)

    def test_repeat_has_no_new_reward(self):
        raw = summarize({'ok': True, 'code': 0, 'already': True, 'checkinPoints': 15})
        result = checkin.parse_checkin(raw, 'glados.cloud', lambda *args: None)
        self.assertIs(result.code, checkin.CheckinStatus.REPEAT)
        self.assertEqual(result.points, 0)

    def test_unknown_post_is_failure_and_is_not_replayed(self):
        with checkin.API('glados.cloud', 'gld:sess=test', checkin_mode='extension') as api, \
                patch('extension_checkin.checkin', return_value=summarize({
                    'ok': False, 'checkinAttempted': True, 'unknown': True,
                })) as browser:
            result = api.checkin()
        self.assertIs(result.code, checkin.CheckinStatus.FAILURE)
        browser.assert_called_once()

    def test_railgun_remains_on_existing_api(self):
        response = MagicMock()
        response.json.return_value = {'code': 1}
        with checkin.API('railgun.info', 'koa:sess=test', checkin_mode='extension') as api, \
                patch.object(api, 'request', return_value=response) as request, \
                patch('extension_checkin.checkin') as browser:
            result = api.checkin()
        browser.assert_not_called()
        self.assertIs(result.code, checkin.CheckinStatus.REPEAT)
        self.assertEqual(request.call_args.kwargs['data'], {'token': 'railgun.info'})
