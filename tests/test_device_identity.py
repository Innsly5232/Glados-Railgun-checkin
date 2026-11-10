import json
import os
import unittest
from unittest.mock import patch

import requests

import checkin


class DeviceIdentityTests(unittest.TestCase):
    def test_default_user_agent_is_macos(self):
        api = checkin.API("glados.cloud", "koa:sess=test")
        try:
            self.assertEqual(api.headers["user-agent"], checkin.PLATFORM_UA["macOS"])
            self.assertEqual(api._no_retry_session.headers["user-agent"], checkin.PLATFORM_UA["macOS"])
        finally:
            api.close()

    def test_custom_user_agent_is_used_for_status_challenge_checkin_and_points(self):
        calls = []
        user_agent = checkin.PLATFORM_UA["macOS"]

        def send(session, request, **kwargs):
            calls.append(request)
            response = requests.Response()
            response.status_code = 200
            response.request = request
            if request.url.endswith("/status"):
                payload = {"code": 0, "data": {"leftDays": "381"}}
            elif request.url.endswith("/checkin/challenge"):
                payload = {"code": 0, "nonce": "test-nonce"}
            elif request.url.endswith("/checkin"):
                payload = {"code": 0, "points": 20, "message": "ok"}
            else:
                payload = {"code": 0, "points": 17}
            response._content = json.dumps(payload).encode()
            response.headers["Content-Type"] = "application/json"
            return response

        cookies = json.dumps([{"name": "大号", "cookie": "koa:sess=test", "user-agent": user_agent}])
        with patch.dict(os.environ, {"GLADOS_COOKIES": cookies}, clear=True), \
                patch.object(requests.Session, "send", send), \
                patch("checkin.time.sleep"):
            config = checkin.Config()
            report = checkin.CheckinRunner(config).run()

        self.assertEqual(len(report.entries), 1)
        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.SUCCESS)
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(request.headers["user-agent"] == user_agent for request in calls))
        self.assertEqual([request.url.rsplit("/", 1)[-1] for request in calls], ["status", "challenge", "checkin", "points"])

    def test_auto_device_recovery_updates_follow_up_points_request(self):
        calls = []
        checkin_attempts = 0

        def send(session, request, **kwargs):
            nonlocal checkin_attempts
            calls.append(request)
            response = requests.Response()
            response.status_code = 200
            response.request = request
            if request.url.endswith("/status"):
                payload = {"code": 0, "data": {"leftDays": 381}}
            elif request.url.endswith("/checkin/challenge"):
                payload = {"code": 0, "nonce": "test-nonce"}
            elif request.url.endswith("/checkin"):
                checkin_attempts += 1
                payload = (
                    {"code": 4, "reason": "device-mismatch", "loginDevice": "macOS"}
                    if checkin_attempts == 1
                    else {"code": 0, "points": 20, "message": "ok"}
                )
            else:
                payload = {"code": 0, "points": 17}
            response._content = json.dumps(payload).encode()
            response.headers["Content-Type"] = "application/json"
            return response

        with patch.dict(os.environ, {"GLADOS_COOKIES": "koa:sess=test"}, clear=True), \
                patch.object(requests.Session, "send", send), \
                patch("checkin.time.sleep"):
            report = checkin.CheckinRunner(checkin.Config()).run()

        self.assertIs(report.entries[0].result.code, checkin.CheckinStatus.SUCCESS)
        points_request = next(request for request in calls if request.url.endswith("/points"))
        self.assertEqual(points_request.headers["user-agent"], checkin.PLATFORM_UA["macOS"])


if __name__ == "__main__":
    unittest.main()
