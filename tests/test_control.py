"""Unit tests for the pure gaze -> pan-rate control law."""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.control import (
    CalibrationState,
    ControlConfig,
    GazeController,
    GazeSample,
    response_rate,
)


DEADZONE = 6.0
MAX_ANGLE = 26.0
MAX_SPEED = 120.0


def rate(error, **kwargs):
    params = dict(
        deadzone=DEADZONE, max_angle=MAX_ANGLE, max_speed=MAX_SPEED, expo=2.0
    )
    params.update(kwargs)
    return response_rate(error, **params)


class ResponseCurveTests(unittest.TestCase):
    def test_zero_inside_deadzone(self):
        for error in (0.0, 1.0, -3.5, DEADZONE - 1e-9):
            self.assertEqual(rate(error), 0.0, f"error={error}")

    def test_zero_exactly_at_deadzone_edge(self):
        self.assertEqual(rate(DEADZONE), 0.0)
        self.assertEqual(rate(-DEADZONE), 0.0)

    def test_sign_follows_error(self):
        self.assertGreater(rate(15.0), 0.0)
        self.assertLess(rate(-15.0), 0.0)

    def test_symmetric_under_negation(self):
        for error in (7.0, 12.0, 19.5, 40.0):
            self.assertAlmostEqual(rate(-error), -rate(error), places=12)

    def test_monotonic_in_magnitude(self):
        errors = [DEADZONE + 0.1 * i for i in range(1, 250)]
        rates = [rate(e) for e in errors]
        for previous, current in zip(rates, rates[1:]):
            self.assertGreaterEqual(current, previous)

    def test_saturates_at_max_speed(self):
        self.assertAlmostEqual(rate(MAX_ANGLE), MAX_SPEED, places=12)
        self.assertAlmostEqual(rate(MAX_ANGLE + 30.0), MAX_SPEED, places=12)
        self.assertAlmostEqual(rate(-MAX_ANGLE - 30.0), -MAX_SPEED, places=12)

    def test_quadratic_shape_at_midpoint(self):
        """Half-way through the live band delivers a quarter of full speed."""
        midpoint = DEADZONE + 0.5 * (MAX_ANGLE - DEADZONE)
        self.assertAlmostEqual(rate(midpoint), 0.25 * MAX_SPEED, places=12)

    def test_expo_one_is_linear(self):
        midpoint = DEADZONE + 0.5 * (MAX_ANGLE - DEADZONE)
        self.assertAlmostEqual(rate(midpoint, expo=1.0), 0.5 * MAX_SPEED, places=12)

    def test_continuous_at_deadzone_edge(self):
        self.assertAlmostEqual(rate(DEADZONE + 1e-6), 0.0, places=9)

    def test_degenerate_band_does_not_divide_by_zero(self):
        value = rate(10.0, deadzone=20.0, max_angle=20.0)
        self.assertTrue(math.isfinite(value))
        self.assertAlmostEqual(value, 0.0, places=12)

    def test_non_finite_error_is_inert(self):
        self.assertEqual(rate(float("nan")), 0.0)
        self.assertEqual(rate(float("inf")), 0.0)


def tracked(yaw, pitch, t, confidence=1.0):
    return GazeSample(
        yaw=yaw, pitch=pitch, tracked=True, confidence=confidence, timestamp=t
    )


def lost(t):
    return GazeSample(yaw=0.0, pitch=0.0, tracked=False, confidence=0.0, timestamp=t)


def config(**kwargs):
    params = dict(
        deadzone=DEADZONE,
        max_angle=MAX_ANGLE,
        max_speed=MAX_SPEED,
        expo=2.0,
        tau=0.0,
        min_confidence=0.5,
        calibration_samples=4,
    )
    params.update(kwargs)
    return ControlConfig(**params)


def calibrated(controller, yaw=0.0, pitch=0.0, start=0.0):
    """Drive the controller through calibration at the given centre."""
    for index in range(controller.config.calibration_samples):
        controller.update(tracked(yaw, pitch, start + 0.01 * index))
    return start + 0.01 * controller.config.calibration_samples


class CalibrationTests(unittest.TestCase):
    def test_starts_in_calibration(self):
        controller = GazeController(config())
        self.assertEqual(controller.update(tracked(0.0, 0.0, 0.0)).state, "calibrating")

    def test_no_motion_while_calibrating(self):
        controller = GazeController(config())
        output = controller.update(tracked(30.0, 30.0, 0.0))
        self.assertEqual(output.yaw_rate, 0.0)
        self.assertEqual(output.pitch_rate, 0.0)

    def test_completes_after_enough_samples(self):
        controller = GazeController(config())
        after = calibrated(controller)
        self.assertEqual(controller.update(tracked(0.0, 0.0, after)).state, "centred")

    def test_centre_is_the_mean_of_calibration_samples(self):
        controller = GazeController(config(calibration_samples=4))
        for index, yaw in enumerate((8.0, 10.0, 12.0, 14.0)):
            controller.update(tracked(yaw, 0.0, 0.01 * index))
        self.assertAlmostEqual(controller.centre[0], 11.0, places=9)

    def test_biased_centre_cancels_the_bias(self):
        """A viewer whose neutral gaze reads +11 deg sits still after calibration."""
        controller = GazeController(config(calibration_samples=4))
        after = calibrated(controller, yaw=11.0)
        output = controller.update(tracked(11.0, 0.0, after))
        self.assertEqual(output.yaw_rate, 0.0)

    def test_untracked_samples_do_not_count_towards_calibration(self):
        controller = GazeController(config(calibration_samples=4))
        for index in range(10):
            controller.update(lost(0.01 * index))
        self.assertEqual(controller.calibration, CalibrationState.COLLECTING)

    def test_recalibrate_restarts_collection(self):
        controller = GazeController(config())
        after = calibrated(controller)
        controller.recalibrate()
        self.assertEqual(
            controller.update(tracked(0.0, 0.0, after)).state, "calibrating"
        )

    def test_recalibrating_adopts_a_new_centre(self):
        controller = GazeController(config(calibration_samples=4))
        after = calibrated(controller, yaw=0.0)
        controller.recalibrate()
        calibrated(controller, yaw=20.0, start=after)
        self.assertAlmostEqual(controller.centre[0], 20.0, places=9)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def test_centre_gaze_is_still(self):
        output = self.controller.update(tracked(0.0, 0.0, self.t))
        self.assertEqual(output.yaw_rate, 0.0)
        self.assertEqual(output.pitch_rate, 0.0)
        self.assertEqual(output.state, "centred")

    def test_looking_left_pans_positive(self):
        """Own-left gaze reads +yaw in the raw camera frame and pans that way."""
        output = self.controller.update(tracked(20.0, 0.0, self.t))
        self.assertGreater(output.yaw_rate, 0.0)
        self.assertEqual(output.state, "panning")

    def test_looking_right_pans_negative(self):
        self.assertLess(
            self.controller.update(tracked(-20.0, 0.0, self.t)).yaw_rate, 0.0
        )

    def test_looking_up_pitches_positive(self):
        self.assertGreater(
            self.controller.update(tracked(0.0, 20.0, self.t)).pitch_rate, 0.0
        )

    def test_invert_yaw_flips_the_sign(self):
        controller = GazeController(config(invert_yaw=True))
        after = calibrated(controller)
        self.assertLess(controller.update(tracked(20.0, 0.0, after)).yaw_rate, 0.0)

    def test_invert_pitch_flips_the_sign(self):
        controller = GazeController(config(invert_pitch=True))
        after = calibrated(controller)
        self.assertLess(controller.update(tracked(0.0, 20.0, after)).pitch_rate, 0.0)

    def test_inversion_does_not_disturb_calibration(self):
        controller = GazeController(config(invert_yaw=True))
        after = calibrated(controller, yaw=9.0)
        self.assertEqual(controller.update(tracked(9.0, 0.0, after)).yaw_rate, 0.0)

    def test_lost_tracking_freezes_the_view(self):
        self.controller.update(tracked(25.0, 25.0, self.t))
        output = self.controller.update(lost(self.t + 0.1))
        self.assertEqual(output.yaw_rate, 0.0)
        self.assertEqual(output.pitch_rate, 0.0)
        self.assertEqual(output.state, "lost")

    def test_low_confidence_freezes_the_view(self):
        output = self.controller.update(tracked(25.0, 0.0, self.t, confidence=0.2))
        self.assertEqual(output.yaw_rate, 0.0)
        self.assertEqual(output.state, "low confidence")

    def test_confidence_at_the_threshold_is_accepted(self):
        output = self.controller.update(tracked(25.0, 0.0, self.t, confidence=0.5))
        self.assertNotEqual(output.yaw_rate, 0.0)

    def test_recovery_after_loss_resumes_panning(self):
        self.controller.update(lost(self.t))
        output = self.controller.update(tracked(25.0, 0.0, self.t + 0.1))
        self.assertGreater(output.yaw_rate, 0.0)

    def test_reports_the_centred_error_for_the_hud(self):
        controller = GazeController(config(calibration_samples=4))
        after = calibrated(controller, yaw=10.0)
        output = controller.update(tracked(18.0, 0.0, after))
        self.assertAlmostEqual(output.yaw_error, 8.0, places=9)

    def test_rate_never_exceeds_max_speed(self):
        for yaw in (-180.0, -90.0, -30.0, 30.0, 90.0, 180.0):
            output = self.controller.update(tracked(yaw, yaw, self.t))
            self.assertLessEqual(abs(output.yaw_rate), MAX_SPEED + 1e-9)
            self.assertLessEqual(abs(output.pitch_rate), MAX_SPEED + 1e-9)

    def test_non_finite_gaze_is_treated_as_lost(self):
        output = self.controller.update(tracked(float("nan"), 0.0, self.t))
        self.assertEqual(output.yaw_rate, 0.0)
        self.assertEqual(output.state, "lost")


class SmoothingTests(unittest.TestCase):
    def make(self, tau):
        controller = GazeController(config(tau=tau, calibration_samples=1))
        controller.update(tracked(0.0, 0.0, 0.0))
        return controller

    def test_zero_tau_passes_through(self):
        controller = self.make(0.0)
        self.assertAlmostEqual(
            controller.update(tracked(20.0, 0.0, 0.1)).yaw_error, 20.0, places=9
        )

    def test_step_does_not_jump_immediately(self):
        controller = self.make(0.2)
        error = controller.update(tracked(20.0, 0.0, 0.02)).yaw_error
        self.assertGreater(error, 0.0)
        self.assertLess(error, 20.0)

    def test_step_converges_towards_the_input(self):
        controller = self.make(0.05)
        previous = 0.0
        for step in range(1, 40):
            error = controller.update(tracked(20.0, 0.0, 0.01 * step)).yaw_error
            self.assertGreaterEqual(error, previous - 1e-12)
            previous = error
        # 39 steps at tau=0.05 is 7.8 time constants: within 0.01 of the step.
        self.assertAlmostEqual(previous, 20.0, delta=0.02)

    def test_ema_matches_the_analytic_time_constant(self):
        """One time constant covers 1 - 1/e of a step."""
        tau = 0.1
        controller = self.make(tau)
        error = controller.update(tracked(10.0, 0.0, tau)).yaw_error
        self.assertAlmostEqual(error, 10.0 * (1.0 - math.exp(-1.0)), places=9)

    def test_frame_rate_independence(self):
        """The same elapsed time gives the same result at either sample rate."""
        coarse = self.make(0.1)
        coarse.update(tracked(10.0, 0.0, 0.1))
        fine = self.make(0.1)
        for step in range(1, 101):
            fine.update(tracked(10.0, 0.0, 0.001 * step))
        self.assertAlmostEqual(
            coarse.update(tracked(10.0, 0.0, 0.2)).yaw_error,
            fine.update(tracked(10.0, 0.0, 0.2)).yaw_error,
            places=2,
        )

    def test_long_gap_snaps_to_the_new_value(self):
        controller = self.make(0.05)
        self.assertAlmostEqual(
            controller.update(tracked(20.0, 0.0, 30.0)).yaw_error, 20.0, places=6
        )

    def test_non_monotonic_timestamps_do_not_explode(self):
        controller = self.make(0.1)
        controller.update(tracked(10.0, 0.0, 1.0))
        error = controller.update(tracked(10.0, 0.0, 0.5)).yaw_error
        self.assertTrue(math.isfinite(error))
        self.assertGreaterEqual(error, 0.0)


if __name__ == "__main__":
    unittest.main()
