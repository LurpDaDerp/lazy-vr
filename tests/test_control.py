"""Unit tests for the pure gaze -> view-angle control law."""

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
    response_angle,
)


DEADZONE = 2.0
GAIN = 4.0
LIMIT = 180.0


def angle(error, **kwargs):
    params = dict(deadzone=DEADZONE, gain=GAIN, limit=LIMIT, expo=1.0)
    params.update(kwargs)
    return response_angle(error, **params)


class ResponseCurveTests(unittest.TestCase):
    def test_zero_inside_deadzone(self):
        for error in (0.0, 0.5, -1.9, DEADZONE - 1e-9):
            self.assertEqual(angle(error), 0.0, f"error={error}")

    def test_zero_exactly_at_deadzone_edge(self):
        self.assertEqual(angle(DEADZONE), 0.0)
        self.assertEqual(angle(-DEADZONE), 0.0)

    def test_proportional_beyond_the_deadzone(self):
        self.assertAlmostEqual(angle(DEADZONE + 10.0), GAIN * 10.0, places=12)
        self.assertAlmostEqual(angle(DEADZONE + 2.5), GAIN * 2.5, places=12)

    def test_sign_follows_error(self):
        self.assertGreater(angle(15.0), 0.0)
        self.assertLess(angle(-15.0), 0.0)

    def test_symmetric_under_negation(self):
        for error in (3.0, 12.0, 19.5, 40.0):
            self.assertAlmostEqual(angle(-error), -angle(error), places=12)

    def test_monotonic_in_magnitude(self):
        errors = [DEADZONE + 0.05 * i for i in range(1, 400)]
        values = [angle(e) for e in errors]
        for previous, current in zip(values, values[1:]):
            self.assertGreaterEqual(current, previous)

    def test_saturates_at_the_limit(self):
        self.assertAlmostEqual(angle(1000.0, limit=85.0), 85.0, places=12)
        self.assertAlmostEqual(angle(-1000.0, limit=85.0), -85.0, places=12)

    def test_continuous_at_the_deadzone_edge(self):
        self.assertAlmostEqual(angle(DEADZONE + 1e-9), 0.0, places=8)

    def test_higher_gain_gives_a_larger_angle(self):
        self.assertGreater(angle(10.0, gain=8.0), angle(10.0, gain=4.0))

    def test_expo_above_one_softens_the_centre(self):
        """With expo the same small error yields less, the same large error more.

        Measured either side of one degree past the deadzone, which is the
        curve's fixed point -- 1**n is 1, so the two curves cross there.
        """
        near, far = DEADZONE + 0.5, DEADZONE + 4.0
        self.assertLess(angle(near, expo=2.0), angle(near, expo=1.0))
        self.assertGreater(angle(far, expo=2.0), angle(far, expo=1.0))

    def test_non_finite_error_is_inert(self):
        self.assertEqual(angle(float("nan")), 0.0)
        self.assertEqual(angle(float("inf")), 0.0)


def tracked(yaw, pitch, t, confidence=1.0):
    return GazeSample(
        yaw=yaw, pitch=pitch, tracked=True, confidence=confidence, timestamp=t
    )


def lost(t):
    return GazeSample(yaw=0.0, pitch=0.0, tracked=False, confidence=0.0, timestamp=t)


def config(**kwargs):
    params = dict(
        gain_yaw=GAIN,
        gain_pitch=7.0,
        deadzone_yaw=DEADZONE,
        deadzone_pitch=1.0,
        max_yaw=180.0,
        max_pitch=85.0,
        expo=1.0,
        tau=0.0,
        min_confidence=0.5,
        calibration_samples=4,
    )
    params.update(kwargs)
    return ControlConfig(**params)


def calibrated(controller, yaw=0.0, pitch=0.0, start=0.0):
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
        self.assertEqual(output.yaw, 0.0)
        self.assertEqual(output.pitch, 0.0)

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
        controller = GazeController(config(calibration_samples=4))
        after = calibrated(controller, yaw=11.0)
        self.assertEqual(controller.update(tracked(11.0, 0.0, after)).yaw, 0.0)

    def test_untracked_samples_do_not_count(self):
        controller = GazeController(config(calibration_samples=4))
        for index in range(10):
            controller.update(lost(0.01 * index))
        self.assertEqual(controller.calibration, CalibrationState.COLLECTING)

    def test_recalibrate_restarts_collection(self):
        controller = GazeController(config())
        after = calibrated(controller)
        controller.recalibrate()
        self.assertEqual(controller.update(tracked(0.0, 0.0, after)).state, "calibrating")

    def test_recalibrating_adopts_a_new_centre(self):
        controller = GazeController(config(calibration_samples=4))
        after = calibrated(controller, yaw=0.0)
        controller.recalibrate()
        calibrated(controller, yaw=20.0, start=after)
        self.assertAlmostEqual(controller.centre[0], 20.0, places=9)


class AbsoluteMappingTests(unittest.TestCase):
    """The behaviour the viewer actually described: look away, look back."""

    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def test_centre_gaze_points_at_the_origin(self):
        output = self.controller.update(tracked(0.0, 0.0, self.t))
        self.assertEqual(output.yaw, 0.0)
        self.assertEqual(output.pitch, 0.0)
        self.assertEqual(output.state, "centred")

    def test_looking_back_to_centre_returns_the_view(self):
        """The defining property of absolute mapping."""
        self.controller.update(tracked(20.0, 12.0, self.t))
        moved = self.controller.update(tracked(20.0, 12.0, self.t + 0.1))
        self.assertNotEqual(moved.yaw, 0.0)
        self.assertNotEqual(moved.pitch, 0.0)
        home = self.controller.update(tracked(0.0, 0.0, self.t + 0.2))
        self.assertEqual(home.yaw, 0.0)
        self.assertEqual(home.pitch, 0.0)

    def test_holding_a_gaze_holds_the_view_still(self):
        """Unlike rate control, a steady gaze must not keep moving."""
        seen = {
            self.controller.update(tracked(15.0, 0.0, self.t + 0.05 * step)).yaw
            for step in range(1, 12)
        }
        self.assertEqual(len(seen), 1, f"view drifted while gaze was held: {seen}")

    def test_view_angle_is_gain_times_error(self):
        output = self.controller.update(tracked(DEADZONE + 10.0, 0.0, self.t))
        self.assertAlmostEqual(output.yaw, GAIN * 10.0, places=9)

    def test_looking_left_turns_left(self):
        self.assertGreater(self.controller.update(tracked(20.0, 0.0, self.t)).yaw, 0.0)

    def test_looking_right_turns_right(self):
        self.assertLess(self.controller.update(tracked(-20.0, 0.0, self.t)).yaw, 0.0)

    def test_looking_up_pitches_up(self):
        self.assertGreater(self.controller.update(tracked(0.0, 20.0, self.t)).pitch, 0.0)

    def test_looking_down_pitches_down(self):
        self.assertLess(self.controller.update(tracked(0.0, -20.0, self.t)).pitch, 0.0)


class BothAxesTests(unittest.TestCase):
    """The axes are independent and must move together."""

    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def test_diagonal_gaze_moves_both_axes(self):
        output = self.controller.update(tracked(14.0, 9.0, self.t))
        self.assertGreater(output.yaw, 0.0)
        self.assertGreater(output.pitch, 0.0)

    def test_all_four_diagonals(self):
        for yaw_sign in (1, -1):
            for pitch_sign in (1, -1):
                output = self.controller.update(
                    tracked(yaw_sign * 14.0, pitch_sign * 9.0, self.t)
                )
                self.assertEqual(math.copysign(1, output.yaw), yaw_sign)
                self.assertEqual(math.copysign(1, output.pitch), pitch_sign)

    def test_pitch_moves_while_yaw_sits_in_its_deadzone(self):
        output = self.controller.update(tracked(0.0, 9.0, self.t))
        self.assertEqual(output.yaw, 0.0)
        self.assertNotEqual(output.pitch, 0.0)

    def test_yaw_moves_while_pitch_sits_in_its_deadzone(self):
        output = self.controller.update(tracked(14.0, 0.0, self.t))
        self.assertNotEqual(output.yaw, 0.0)
        self.assertEqual(output.pitch, 0.0)

    def test_one_axis_does_not_scale_the_other(self):
        alone = self.controller.update(tracked(14.0, 0.0, self.t)).yaw
        together = self.controller.update(tracked(14.0, 20.0, self.t)).yaw
        self.assertAlmostEqual(alone, together, places=12)


class SensitivityTests(unittest.TestCase):
    """Pitch is geared harder than yaw on purpose."""

    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def test_pitch_is_more_sensitive_than_yaw(self):
        output = self.controller.update(tracked(10.0, 10.0, self.t))
        self.assertGreater(abs(output.pitch), abs(output.yaw))

    def test_pitch_deadzone_is_smaller_than_yaw(self):
        output = self.controller.update(tracked(1.5, 1.5, self.t))
        self.assertEqual(output.yaw, 0.0, "1.5 deg is inside the yaw deadzone")
        self.assertNotEqual(output.pitch, 0.0, "1.5 deg must clear the pitch deadzone")

    def test_a_small_upward_glance_reaches_a_useful_angle(self):
        """8 degrees of eye movement should be worth a real look upward."""
        self.assertGreater(self.controller.update(tracked(0.0, 8.0, self.t)).pitch, 40.0)

    def test_pitch_saturates_at_its_own_limit(self):
        output = self.controller.update(tracked(0.0, 90.0, self.t))
        self.assertAlmostEqual(output.pitch, 85.0, places=9)

    def test_yaw_saturates_at_its_own_limit(self):
        output = self.controller.update(tracked(400.0, 0.0, self.t))
        self.assertAlmostEqual(output.yaw, 180.0, places=9)


class HoldTests(unittest.TestCase):
    """Losing the face must hold, never snap home and never run away."""

    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def test_lost_tracking_holds_the_last_target(self):
        held = self.controller.update(tracked(20.0, 10.0, self.t))
        output = self.controller.update(lost(self.t + 0.1))
        self.assertEqual(output.state, "lost")
        self.assertAlmostEqual(output.yaw, held.yaw, places=12)
        self.assertAlmostEqual(output.pitch, held.pitch, places=12)

    def test_low_confidence_holds_the_last_target(self):
        held = self.controller.update(tracked(20.0, 10.0, self.t))
        output = self.controller.update(
            tracked(-30.0, -30.0, self.t + 0.1, confidence=0.2)
        )
        self.assertEqual(output.state, "low confidence")
        self.assertAlmostEqual(output.yaw, held.yaw, places=12)

    def test_confidence_at_the_threshold_is_accepted(self):
        output = self.controller.update(tracked(25.0, 0.0, self.t, confidence=0.5))
        self.assertNotEqual(output.yaw, 0.0)

    def test_recovery_resumes_tracking(self):
        self.controller.update(lost(self.t))
        output = self.controller.update(tracked(25.0, 0.0, self.t + 0.1))
        self.assertGreater(output.yaw, 0.0)
        self.assertEqual(output.state, "looking")

    def test_non_finite_gaze_is_treated_as_lost(self):
        output = self.controller.update(tracked(float("nan"), 0.0, self.t))
        self.assertEqual(output.state, "lost")

    def test_nothing_is_held_before_the_first_reading(self):
        controller = GazeController(config())
        output = controller.update(lost(0.0))
        self.assertEqual(output.yaw, 0.0)
        self.assertEqual(output.pitch, 0.0)


class InversionTests(unittest.TestCase):
    def test_invert_yaw_flips_the_sign(self):
        controller = GazeController(config(invert_yaw=True))
        after = calibrated(controller)
        self.assertLess(controller.update(tracked(20.0, 0.0, after)).yaw, 0.0)

    def test_invert_pitch_flips_the_sign(self):
        controller = GazeController(config(invert_pitch=True))
        after = calibrated(controller)
        self.assertLess(controller.update(tracked(0.0, 20.0, after)).pitch, 0.0)

    def test_inversion_does_not_disturb_calibration(self):
        controller = GazeController(config(invert_yaw=True))
        after = calibrated(controller, yaw=9.0)
        self.assertEqual(controller.update(tracked(9.0, 0.0, after)).yaw, 0.0)


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

    def test_ema_matches_the_analytic_time_constant(self):
        tau = 0.1
        controller = self.make(tau)
        error = controller.update(tracked(10.0, 0.0, tau)).yaw_error
        self.assertAlmostEqual(error, 10.0 * (1.0 - math.exp(-1.0)), places=9)

    def test_frame_rate_independence(self):
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

    def test_default_tau_is_short_enough_to_feel_immediate(self):
        """Lag here is felt directly; the browser does the smoothing."""
        self.assertLessEqual(ControlConfig().tau, 0.04)

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


class DefaultsTests(unittest.TestCase):
    def test_pitch_is_geared_harder_than_yaw(self):
        defaults = ControlConfig()
        self.assertGreater(defaults.gain_pitch, defaults.gain_yaw)

    def test_pitch_deadzone_is_smaller_than_yaw(self):
        defaults = ControlConfig()
        self.assertLess(defaults.deadzone_pitch, defaults.deadzone_yaw)

    def test_mapping_is_proportional_by_default(self):
        self.assertEqual(ControlConfig().expo, 1.0)


if __name__ == "__main__":
    unittest.main()
