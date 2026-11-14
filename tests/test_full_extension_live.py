import unittest

from full_extension_live import safe_result, verify_upstream


class FullExtensionTests(unittest.TestCase):
    def test_upstream_runtime_bytes_match_pinned_source(self):
        self.assertTrue(verify_upstream())

    def test_private_page_data_does_not_enter_report(self):
        result = safe_result({'email': 'private@example.invalid', 'userId': 'PRIVATE',
                              'message': 'PRIVATE', 'nonce': 'PRIVATE', 'ok': False,
                              'stage': 'verification', 'verificationError': '300030',
                              'verificationRequired': True})
        self.assertNotIn('PRIVATE', repr(result))
        self.assertNotIn('private@', repr(result))
        self.assertTrue(result['verification_required'])
        self.assertEqual(result['verification_error'], '300030')

    def test_invalid_numeric_evidence_is_omitted(self):
        result = safe_result({'points': True, 'leftDays': float('nan'),
                              'checkinPoints': 'PRIVATE', 'verificationError': 'PRIVATE'})
        self.assertIsNone(result['balance'])
        self.assertIsNone(result['days'])
        self.assertIsNone(result['reward'])
        self.assertIsNone(result['verification_error'])

    def test_unknown_submission_remains_visible(self):
        result = safe_result({'ok': False, 'unknown': True, 'checkinAttempted': True})
        self.assertFalse(result['ok'])
        self.assertTrue(result['submitted'])
        self.assertTrue(result['unknown'])
