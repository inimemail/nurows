import importlib.util
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "probe-agent" / "nurossh_probe.py"
SPEC = importlib.util.spec_from_file_location("nurossh_probe", MODULE_PATH)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class ProbeCheckWindowTests(unittest.TestCase):
    def setUp(self):
        self.target = {
            "id": "target-1",
            "address": "example.com",
            "checkType": "ping",
            "timeout": 5,
            "allowPrivate": False,
        }

    def test_stops_after_the_first_success_across_three_by_three_checks(self):
        results = iter([(False, "failed")] * 4 + [(True, "")])
        with mock.patch.object(PROBE, "validate_target_address", return_value={"203.0.113.10"}), \
                mock.patch.object(PROBE, "check_attempt", side_effect=lambda *_args: next(results)), \
                mock.patch.object(PROBE.time, "sleep", return_value=None):
            result = PROBE.check_target(self.target)

        self.assertTrue(result["ok"])
        self.assertEqual(result["attempts"], 5)
        self.assertEqual(result["successfulRound"], 2)
        self.assertEqual(result["successfulAttempt"], 2)

    def test_reports_failure_only_after_all_nine_attempts_fail(self):
        with mock.patch.object(PROBE, "validate_target_address", return_value={"203.0.113.10"}), \
                mock.patch.object(PROBE, "check_attempt", return_value=(False, "failed")), \
                mock.patch.object(PROBE.time, "sleep", return_value=None):
            result = PROBE.check_target(self.target)

        self.assertFalse(result["ok"])
        self.assertEqual(result["roundsCompleted"], 3)
        self.assertEqual(result["attempts"], 9)
        self.assertEqual(result["successfulRound"], 0)

    def test_uses_target_specific_round_and_attempt_counts(self):
        target = {**self.target, "checkRounds": 2, "attemptsPerRound": 2}
        with mock.patch.object(PROBE, "validate_target_address", return_value={"203.0.113.10"}), \
                mock.patch.object(PROBE, "check_attempt", return_value=(False, "failed")), \
                mock.patch.object(PROBE.time, "sleep", return_value=None):
            result = PROBE.check_target(target)

        self.assertFalse(result["ok"])
        self.assertEqual(result["rounds"], 2)
        self.assertEqual(result["attemptsPerRound"], 2)
        self.assertEqual(result["attempts"], 4)

    def test_retries_temporary_dns_resolution_failures(self):
        resolutions = [OSError("dns failed"), {"203.0.113.10"}]
        with mock.patch.object(PROBE, "validate_target_address", side_effect=resolutions) as resolver, \
                mock.patch.object(PROBE, "check_attempt", return_value=(True, "")), \
                mock.patch.object(PROBE.time, "sleep", return_value=None):
            result = PROBE.check_target(self.target)

        self.assertTrue(result["ok"])
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(resolver.call_count, 2)

    def test_resolves_again_for_every_round_and_reports_the_successful_address(self):
        resolutions = [{"203.0.113.10"}, {"198.51.100.40"}]
        attempts = iter([(False, "failed", ""), (True, "", "198.51.100.40")])
        target = {**self.target, "checkRounds": 2, "attemptsPerRound": 1, "checkNowAt": "marker-1"}
        with mock.patch.object(PROBE, "validate_target_address", side_effect=resolutions) as resolver, \
                mock.patch.object(PROBE, "check_attempt", side_effect=lambda *_args: next(attempts)), \
                mock.patch.object(PROBE.time, "sleep", return_value=None):
            result = PROBE.check_target(target)

        self.assertTrue(result["ok"])
        self.assertEqual(resolver.call_count, 2)
        self.assertEqual(result["successfulAddress"], "198.51.100.40")
        self.assertEqual(result["resolvedAddresses"], ["198.51.100.40", "203.0.113.10"])
        self.assertEqual(result["checkMarker"], "marker-1")


if __name__ == "__main__":
    unittest.main()
