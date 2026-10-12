import json
import os
import unittest
from unittest.mock import patch

import requests

import checkin


class DeviceIdentityTests(unittest.TestCase):
    def test_each_run_uses_login_platform_from_first_request_for_both_accounts(self):
        for run in range(2):
            with self.subTest(run=run):
                calls = []

                def send(session, request, **kwargs):
                    calls.append(request)
                    response = requests.Response()
                    response.status_code = 200
                    response.request = request
                    if request.url.endswith('/status'):
                        payload = {'code': 0, 'data': {'leftDays': '381'}}
                    elif request.url.endswith('/points'):
                        payload = {'code': 0, 'points': 17}
                    elif request.headers['user-agent'] != checkin.PLATFORM_UA['macOS']:
                        payload = {'code': 4, 'reason': 'device-mismatch', 'loginDevice': 'macOS'}
                    else:
                        payload = {'code': 0, 'points': 1, 'message': 'ok'}
                    response._content = json.dumps(payload).encode()
                    return response

                with patch.dict(os.environ, {'GLADOS_COOKIES': 'test-cookie-1&test-cookie-2'}, clear=True), patch.object(requests.Session, 'send', send):
                    checker = checkin.Checker(checkin.Config())
                    checker.checkin_all()

                self.assertEqual(len(checker.results), 4)
                self.assertTrue(all(result.code == checkin.CheckinStatus.SUCCESS for result in checker.results))
                # Four account/domain pairs each make status, check-in and points requests;
                # a mismatched first check-in would add a retry and trigger an alert.
                self.assertEqual(len(calls), 12)
                self.assertEqual(sum(request.url.endswith('/checkin') for request in calls), 4)
                self.assertTrue(all(request.headers['user-agent'] == checkin.PLATFORM_UA['macOS'] for request in calls))
                self.assertEqual({request.headers['cookie'] for request in calls}, {'test-cookie-1', 'test-cookie-2'})


if __name__ == '__main__':
    unittest.main()
