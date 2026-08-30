"""Unit tests for the pure gaze -> requested-turn-rate control law."""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.control import (
    DEFAULT_ASPECT,
    MAX_ASPECT,
    MIN_ASPECT,
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
        deadzone_yaw=6.0,
        deadzone_pitch=6.0 / DEFAULT_ASPECT,
        rate_yaw=9.0,
        rate_pitch=9.0 * DEFAULT_ASPECT,
        max_rate_yaw=120.0,
        max_rate_pitch=90.0,
        onset=0.12,
        expo=1.0,
        tau=0.0,
        min_confidence=0.5,
        calibration_hold=0.3,
        calibration_tolerance=2.5,
    )
    params.update(kwargs)
    return ControlConfig(**params)


STEP = 0.03  # a 33 Hz camera, near enough


def calibrated(controller, yaw=0.0, pitch=0.0, start=0.0):
    """Hold one spot until the fixation test is satisfied."""
    limit = start + controller.config.calibration_hold * 10 + 1.0
    t = start
    while controller.calibration is not CalibrationState.DONE:
        t += STEP
        controller.update(tracked(yaw, pitch, t))
        if t > limit:
            raise AssertionError("calibration never finished")
    return t


def hold_gaze(controller, yaw, pitch, start, duration, confidence=1.0):
    """Look somewhere for a while; return the last output."""
    output = None
    t = start
    while t < start + duration - 1e-12:
        t += STEP
        output = controller.update(tracked(yaw, pitch, t, confidence))
    return output


class CalibrationTests(unittest.TestCase):
    """Calibration is a fixation test, not a sample count."""

    def test_starts_in_calibration(self):
        controller = GazeController(config())
        self.assertEqual(controller.update(tracked(0.0, 0.0, 0.0)).state,
                         "calibrating")

    def test_nothing_moves_while_calibrating(self):
        controller = GazeController(config())
        output = controller.update(tracked(30.0, 30.0, 0.0))
        self.assertEqual(output.yaw_rate, 0.0)
        self.assertEqual(output.pitch_rate, 0.0)

    def test_holding_still_long_enough_finishes_it(self):
        controller = GazeController(config())
        calibrated(controller)
        self.assertIs(controller.calibration, CalibrationState.DONE)

    def test_a_gaze_that_keeps_moving_never_finishes(self):
        """The whole point: it ends on stillness, not on elapsed time."""
        controller = GazeController(config())
        for index in range(200):
            controller.update(tracked(20.0 * (index % 2), 0.0, STEP * index))
        self.assertIs(controller.calibration, CalibrationState.COLLECTING)
        self.assertEqual(controller.calibration_progress, 0.0)

    def test_looking_away_restarts_the_hold(self):
        controller = GazeController(config())
        hold_gaze(controller, 0.0, 0.0, 0.0, 0.15)
        self.assertGreater(controller.calibration_progress, 0.0)
        controller.update(tracked(40.0, 0.0, 0.2))  # looked away
        self.assertEqual(controller.calibration_progress, 0.0)
        self.assertIs(controller.calibration, CalibrationState.COLLECTING)

    def test_looking_away_is_counted_so_the_page_can_say_so(self):
        controller = GazeController(config())
        controller.update(tracked(0.0, 0.0, 0.0))
        before = controller.resets
        controller.update(tracked(40.0, 0.0, 0.03))
        self.assertEqual(controller.resets, before + 1)

    def test_a_wander_inside_the_tolerance_is_forgiven(self):
        """Tracker noise must not make calibration impossible."""
        controller = GazeController(config(calibration_tolerance=2.5))
        t = 0.0
        for index in range(40):
            t += STEP
            controller.update(tracked(1.0 if index % 2 else -1.0, 0.0, t))
        self.assertIs(controller.calibration, CalibrationState.DONE)

    def test_progress_climbs_with_the_time_held(self):
        controller = GazeController(config(calibration_hold=1.0))
        seen = []
        for index in range(1, 5):
            controller.update(tracked(0.0, 0.0, 0.1 * index))
            seen.append(round(controller.calibration_progress, 6))
        self.assertEqual(seen, sorted(seen))
        self.assertGreater(seen[-1], seen[0])

    def test_a_slow_drift_off_the_dot_is_caught(self):
        """Compared against the streak's mean, so drift accumulates."""
        controller = GazeController(config(calibration_hold=5.0))
        t = 0.0
        for index in range(60):
            t += STEP
            controller.update(tracked(index * 0.5, 0.0, t))
        self.assertIs(controller.calibration, CalibrationState.COLLECTING)
        self.assertGreater(controller.resets, 0)

    def test_centre_is_the_mean_of_the_held_samples(self):
        controller = GazeController(config())
        calibrated(controller, yaw=11.0, pitch=-4.0)
        self.assertAlmostEqual(controller.centre[0], 11.0, places=6)
        self.assertAlmostEqual(controller.centre[1], -4.0, places=6)

    def test_a_biased_centre_cancels_the_bias(self):
        controller = GazeController(config())
        after = calibrated(controller, yaw=11.0)
        self.assertEqual(
            controller.update(tracked(11.0, 0.0, after + STEP)).yaw_error, 0.0
        )

    def test_untracked_samples_do_not_count(self):
        controller = GazeController(config())
        for index in range(100):
            controller.update(lost(STEP * index))
        self.assertIs(controller.calibration, CalibrationState.COLLECTING)

    def test_recalibrate_restarts_the_pass(self):
        controller = GazeController(config())
        after = calibrated(controller)
        controller.recalibrate()
        self.assertIs(controller.calibration, CalibrationState.COLLECTING)
        self.assertEqual(controller.calibration_progress, 0.0)
        self.assertEqual(
            controller.update(tracked(0.0, 0.0, after + STEP)).state, "calibrating"
        )

    def test_recalibrate_bumps_the_generation(self):
        """The page tells this pass from the previous one by its generation."""
        controller = GazeController(config())
        before = controller.generation
        self.assertEqual(controller.recalibrate(), before + 1)

    def test_progress_is_one_when_done(self):
        controller = GazeController(config())
        calibrated(controller)
        self.assertEqual(controller.calibration_progress, 1.0)


class OnsetGateTests(unittest.TestCase):
    """The eye saccades and the head follows a moment later."""

    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def test_a_brief_glance_moves_nothing(self):
        """Flick your eyes to a corner and back; the world stays put."""
        seen = hold_gaze(self.controller, 25.0, 0.0, self.t, 0.09)
        self.assertEqual(seen.yaw_rate, 0.0)
        self.assertFalse(seen.committed)

    def test_the_state_says_it_is_waiting(self):
        self.assertEqual(
            hold_gaze(self.controller, 25.0, 0.0, self.t, 0.06).state, "committing"
        )

    def test_holding_the_look_commits_and_the_view_turns(self):
        seen = hold_gaze(self.controller, 25.0, 0.0, self.t, 0.3)
        self.assertTrue(seen.committed)
        self.assertGreater(seen.yaw_rate, 0.0)
        self.assertEqual(seen.state, "steering")

    def test_the_gate_does_not_retrigger_mid_turn(self):
        """Once committed it stays committed until the eyes come back in."""
        hold_gaze(self.controller, 25.0, 0.0, self.t, 0.3)
        after = self.controller.update(tracked(-25.0, 0.0, self.t + 0.33))
        self.assertTrue(after.committed)
        self.assertLess(after.yaw_rate, 0.0)

    def test_coming_back_inside_shuts_the_gate_again(self):
        hold_gaze(self.controller, 25.0, 0.0, self.t, 0.3)
        back = self.controller.update(tracked(0.0, 0.0, self.t + 0.33))
        self.assertFalse(back.committed)
        self.assertEqual(back.yaw_rate, 0.0)
        # And the next excursion has to wait all over again.
        again = hold_gaze(self.controller, 25.0, 0.0, self.t + 0.36, 0.06)
        self.assertEqual(again.yaw_rate, 0.0)

    def test_a_zero_onset_commits_at_once(self):
        controller = GazeController(config(onset=0.0))
        start = calibrated(controller)
        self.assertGreater(
            controller.update(tracked(25.0, 0.0, start + STEP)).yaw_rate, 0.0
        )


class RateMapTests(unittest.TestCase):
    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)

    def committed(self, yaw, pitch=0.0, confidence=1.0):
        return hold_gaze(self.controller, yaw, pitch, self.t, 0.4, confidence)

    def test_inside_the_deadzone_asks_for_nothing(self):
        seen = self.committed(4.0, 1.0)
        self.assertEqual(seen.yaw_rate, 0.0)
        self.assertEqual(seen.pitch_rate, 0.0)
        self.assertEqual(seen.state, "holding")

    def test_rate_is_proportional_beyond_the_deadzone(self):
        # 15 degrees of gaze, 6 of deadzone, 9 deg/s per degree -- and short
        # of the 120 deg/s ceiling, which 20 degrees would already have hit.
        self.assertAlmostEqual(self.committed(15.0).yaw_rate, 9.0 * 9.0, places=6)

    def test_sign_follows_the_gaze(self):
        self.assertLess(self.committed(-20.0).yaw_rate, 0.0)

    def test_rate_saturates_at_the_limit(self):
        self.assertAlmostEqual(self.committed(200.0).yaw_rate, 120.0, places=6)
        self.assertAlmostEqual(self.committed(0.0, 200.0).pitch_rate, 90.0, places=6)

    def test_pitch_is_geared_by_the_screen_aspect(self):
        """A 16:9 screen gives the eyes less room up and down."""
        seen = self.committed(0.0, 7.0)
        beyond = 7.0 - 6.0 / DEFAULT_ASPECT
        self.assertAlmostEqual(seen.pitch_rate, beyond * 9.0 * DEFAULT_ASPECT,
                               places=6)

    def test_both_axes_reach_the_same_speed_at_the_same_share_of_their_travel(self):
        """The property the aspect gearing exists to produce.

        Measured below both ceilings, where the gearing alone decides: an
        eccentricity and the same fraction of it vertically must ask for the
        same speed.
        """
        sideways = self.committed(14.0).yaw_rate
        upward = self.committed(0.0, 14.0 / DEFAULT_ASPECT).pitch_rate
        self.assertAlmostEqual(sideways, upward, places=6)

    def test_the_pitch_ceiling_is_deliberately_lower(self):
        """Geometry sets the gearing; comfort sets the cap.

        Vertical motion is the more provocative axis and has only 180 degrees
        end to end, so it saturates sooner than the gearing alone would.
        """
        self.assertLess(self.controller.config.max_rate_pitch,
                        self.controller.config.max_rate_yaw)
        self.assertAlmostEqual(self.committed(0.0, 200.0).pitch_rate, 90.0,
                               places=6)

    def test_both_axes_move_at_once(self):
        seen = self.committed(20.0, 10.0)
        self.assertGreater(seen.yaw_rate, 0.0)
        self.assertGreater(seen.pitch_rate, 0.0)

    def test_errors_are_reported_for_the_hud(self):
        seen = self.committed(20.0, 10.0)
        self.assertAlmostEqual(seen.yaw_error, 20.0, places=6)
        self.assertAlmostEqual(seen.pitch_error, 10.0, places=6)


class StopTests(unittest.TestCase):
    """Anything that is not a clear reading has to ask for a stop.

    Holding the last rate would keep the viewer turning through a blink.
    """

    def setUp(self):
        self.controller = GazeController(config())
        self.t = calibrated(self.controller)
        hold_gaze(self.controller, 25.0, 0.0, self.t, 0.4)

    def test_a_lost_face_asks_for_a_stop(self):
        seen = self.controller.update(lost(self.t + 0.5))
        self.assertEqual(seen.yaw_rate, 0.0)
        self.assertEqual(seen.pitch_rate, 0.0)
        self.assertEqual(seen.state, "lost")

    def test_low_confidence_asks_for_a_stop(self):
        seen = hold_gaze(self.controller, 25.0, 0.0, self.t + 0.5, 0.1,
                         confidence=0.1)
        self.assertEqual(seen.yaw_rate, 0.0)
        self.assertEqual(seen.state, "low confidence")

    def test_a_lost_face_shuts_the_onset_gate(self):
        """Coming back has to earn the turn again."""
        self.controller.update(lost(self.t + 0.5))
        back = hold_gaze(self.controller, 25.0, 0.0, self.t + 0.53, 0.06)
        self.assertEqual(back.yaw_rate, 0.0)


class InversionTests(unittest.TestCase):
    def rate(self, **kwargs):
        controller = GazeController(config(**kwargs))
        start = calibrated(controller)
        return hold_gaze(controller, 20.0, 10.0, start, 0.4)

    def test_yaw_inversion_flips_only_yaw(self):
        seen = self.rate(invert_yaw=True)
        self.assertLess(seen.yaw_rate, 0.0)
        self.assertGreater(seen.pitch_rate, 0.0)

    def test_pitch_inversion_flips_only_pitch(self):
        seen = self.rate(invert_pitch=True)
        self.assertGreater(seen.yaw_rate, 0.0)
        self.assertLess(seen.pitch_rate, 0.0)


class SmoothingTests(unittest.TestCase):
    def make(self, tau):
        controller = GazeController(
            config(tau=tau, calibration_hold=0.001, calibration_tolerance=1e9)
        )
        # Calibrated before the clock this test cares about, so the first
        # reading it takes is not compared against a later timestamp.
        controller.update(tracked(0.0, 0.0, -0.01))
        controller.update(tracked(0.0, 0.0, -0.008))
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
        """Lag here is felt directly; the browser's body does the smoothing."""
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


class AspectTests(unittest.TestCase):
    """The gearing between the axes follows the shape of the screen."""

    def control(self, aspect=None, **kwargs):
        # Derived from the screen unless the caller pins one deliberately.
        settings = dict(deadzone_pitch=None, rate_pitch=None)
        settings.update(kwargs)
        control = GazeController(config(**settings))
        if aspect is not None:
            control.set_aspect(aspect)
        return control

    def test_it_assumes_16_by_9_until_the_page_says_otherwise(self):
        self.assertAlmostEqual(self.control().aspect, DEFAULT_ASPECT, places=9)

    def test_a_wider_screen_gears_pitch_harder(self):
        """21:9 leaves even less room to look up, so pitch works harder."""
        wide = self.control(21 / 9)
        normal = self.control(16 / 9)
        self.assertGreater(wide.rate_pitch, normal.rate_pitch)
        self.assertLess(wide.deadzone_pitch, normal.deadzone_pitch)

    def test_a_square_screen_gears_the_axes_alike(self):
        square = self.control(1.0)
        self.assertAlmostEqual(square.rate_pitch, square.config.rate_yaw, places=9)
        self.assertAlmostEqual(square.deadzone_pitch, square.config.deadzone_yaw,
                               places=9)

    def test_a_screen_taller_than_it_is_wide_gears_the_other_way(self):
        """A rotated tablet has more room up and down than sideways."""
        portrait = self.control(9 / 16)
        self.assertLess(portrait.rate_pitch, portrait.config.rate_yaw)
        self.assertGreater(portrait.deadzone_pitch, portrait.config.deadzone_yaw)

    def test_both_axes_reach_the_same_speed_at_their_own_edge_whatever_the_shape(self):
        """The property the whole scheme exists to produce, generalised.

        An eccentricity sideways and the same share of the screen vertically
        must ask for the same speed, on any screen.
        """
        for aspect in (1.0, 4 / 3, 16 / 10, 16 / 9, 21 / 9, 32 / 9, 9 / 16):
            with self.subTest(aspect=aspect):
                control = self.control(aspect, max_rate_yaw=1e6,
                                       max_rate_pitch=1e6)
                start = calibrated(control)
                edge = 15.0
                sideways = hold_gaze(control, edge, 0.0, start, 0.4).yaw_rate
                upward = hold_gaze(control, 0.0, edge / aspect, start, 0.4).pitch_rate
                self.assertAlmostEqual(sideways, upward, places=6)

    def test_an_explicit_setting_pins_the_axis_against_the_screen(self):
        control = self.control(21 / 9, rate_pitch=42.0, deadzone_pitch=7.0)
        self.assertEqual(control.rate_pitch, 42.0)
        self.assertEqual(control.deadzone_pitch, 7.0)

    def test_nonsense_reports_leave_the_shape_alone(self):
        """A page laying itself out is at liberty to report rubbish."""
        control = self.control(16 / 9)
        before = control.aspect
        for bad in (0.0, -2.0, float("nan"), float("inf"), None, "wide", ""):
            with self.subTest(bad=bad):
                control.set_aspect(bad)
                self.assertAlmostEqual(control.aspect, before, places=9)

    def test_absurd_shapes_are_folded_back_to_something_possible(self):
        self.assertLessEqual(self.control(500.0).aspect, MAX_ASPECT)
        self.assertGreaterEqual(self.control(0.001).aspect, MIN_ASPECT)

    def test_a_numeric_string_is_accepted(self):
        """JSON from the page may not have bothered with the type."""
        self.assertAlmostEqual(self.control("1.5").aspect, 1.5, places=9)

    def test_set_aspect_returns_what_it_settled_on(self):
        self.assertAlmostEqual(self.control().set_aspect(2.0), 2.0, places=9)

    def test_the_limits_the_hud_draws_follow_the_screen(self):
        control = self.control(16 / 9)
        narrow = control.limits["deadzone_pitch"]
        control.set_aspect(32 / 9)
        self.assertLess(control.limits["deadzone_pitch"], narrow)
        self.assertAlmostEqual(control.limits["aspect"], 32 / 9, places=9)


class DefaultsTests(unittest.TestCase):
    """The screen-shape reasoning, pinned so it cannot drift."""

    def test_pitch_is_geared_by_the_aspect_ratio(self):
        control = GazeController(ControlConfig())
        self.assertAlmostEqual(control.rate_pitch / control.config.rate_yaw,
                               DEFAULT_ASPECT, places=9)

    def test_the_pitch_deadzone_gives_the_gain_back(self):
        control = GazeController(ControlConfig())
        self.assertAlmostEqual(
            control.config.deadzone_yaw / control.deadzone_pitch,
            DEFAULT_ASPECT, places=9)

    def test_pitch_moves_faster_than_yaw_on_a_screen_wider_than_it_is_tall(self):
        control = GazeController(ControlConfig())
        self.assertGreater(control.rate_pitch, control.config.rate_yaw)

    def test_the_deadzone_is_below_the_physiological_ceiling(self):
        """People do not recruit the head below roughly 18 degrees."""
        self.assertLess(ControlConfig().deadzone_yaw, 18.0)

    def test_the_onset_gate_still_gates_something(self):
        """A real head follows the eye by 60-120 ms; this is under that.

        Tuned for responsiveness rather than fidelity, on the grounds that a
        viewer sitting at a screen cannot turn their real head to help.  It
        still has to be a gate, though: at zero it would pass single-sample
        noise straight through to the view.
        """
        self.assertGreater(ControlConfig().onset, 0.0)
        self.assertLess(ControlConfig().onset, 0.06)

    def test_the_felt_delay_holds_across_plausible_frame_rates(self):
        """The gate can only open on a gaze sample, so it moves in jumps.

        What matters is the wall-clock delay, not the number of samples: a
        faster camera simply fits more of them into the same window.  What
        must not happen is the delay quietly doubling -- a camera at 30.5 FPS,
        which is what this one returns whatever mode is asked of it, has a
        32.8 ms step, so an onset of 0.033 would need two samples and cost
        twice what it reads as.
        """
        onset = ControlConfig().onset
        for fps in (30.0, 30.5, 33.0, 60.0):
            with self.subTest(fps=fps):
                step = 1.0 / fps
                felt = math.ceil(onset / step - 1e-9) * step
                self.assertLessEqual(felt, 0.035)

    def test_mapping_is_proportional_by_default(self):
        self.assertEqual(ControlConfig().expo, 1.0)


if __name__ == "__main__":
    unittest.main()
