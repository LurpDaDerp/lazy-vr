"""Gaze angles -> what the viewer is asking the view to do.

A rate map: how far off centre you look sets how fast the view turns, and it
stays where you left it.  Your eyes are a stick, not a pointer.

This module decides *intent* only -- the speed the viewer is asking for, and
whether they have actually committed to a turn rather than glanced.  The body
that carries the intent out (its inertia, the neck and torso, the idle sway)
is simulated in the browser at display rate, because a bell-shaped velocity
profile needs finer time steps than a 30 Hz camera can give, and re-smoothing
a 30 Hz angle downstream would blunt the very profile that makes it feel like
a head rather than a filter.

Pure: no camera, no clock.  Every decision about what the gaze *means* lives
here, where it can be tested without hardware.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum


# The shape of the screen decides the gearing between the axes.  A screen `a`
# times wider than it is tall gives the eyes `a` times as much room to travel
# sideways as up and down, so for both axes to reach the same speed at the
# same *fraction* of the travel available to them, pitch takes the aspect as
# gain and gives it straight back on the deadzone:
#
#     (E - dz) * g   ==   (E/a - dz/a) * g*a
#
# Gear them equally instead and the vertical axis feels dead, because the eye
# runs out of screen long before the map runs out of gain.
#
# The page measures the viewport it is actually filling and reports it, so a
# 21:9 ultrawide and a rotated tablet each get their own gearing.  This is
# only what is assumed until the page says otherwise -- and what a headless
# test falls back on.
DEFAULT_ASPECT = 16.0 / 9.0

# Outside these something has gone wrong with the report rather than with the
# screen, and a bad aspect would gear one axis into uselessness.
MIN_ASPECT = 0.25
MAX_ASPECT = 6.0


@dataclass(frozen=True)
class GazeSample:
    """One gaze reading in the raw camera frame.

    ``yaw`` is positive towards the viewer's own left, ``pitch`` positive up,
    both in degrees.  ``confidence`` is the fraction of landmarks the detector
    placed inside the frame.
    """

    yaw: float
    pitch: float
    tracked: bool
    confidence: float
    timestamp: float


@dataclass(frozen=True)
class ControlOutput:
    """The speed the viewer is asking for, plus what the HUD needs."""

    yaw_rate: float
    pitch_rate: float
    state: str
    yaw_error: float
    pitch_error: float
    centre: tuple[float, float]
    confidence: float
    # False while the onset gate is still holding a fresh glance back.
    committed: bool = False


class CalibrationState(Enum):
    COLLECTING = "collecting"
    DONE = "done"


@dataclass(frozen=True)
class ControlConfig:
    # Eye eccentricity that commands no motion, in degrees of visual angle.
    # People do not recruit the head for gaze shifts below roughly 18 degrees,
    # so that is the physiological ceiling; a viewer sitting still at a screen
    # cannot turn their real head to help, so it is walked down from there.
    deadzone_yaw: float = 3.0
    # None means "work it out from the shape of the screen".  A number pins
    # it instead, for a viewer who wants the axes geared their own way.
    deadzone_pitch: float | None = None
    # Degrees per second of turn per degree of gaze past the deadzone.
    rate_yaw: float = 9.6
    rate_pitch: float | None = None
    max_rate_yaw: float = 128.0
    # Not scaled by the aspect: this one is a comfort cap rather than a
    # geometry decision.  Vertical motion is the more provocative axis and it
    # only has 180 degrees end to end before it hits the poles.
    max_rate_pitch: float = 96.0
    # What the screen is assumed to be until the page reports its viewport.
    aspect: float = DEFAULT_ASPECT
    # Eccentricity must stay outside the deadzone this long before the view
    # commits.  In a natural gaze shift the eye saccades and the head follows
    # 60-120 ms later; without the lag the world feels welded to the eyeball
    # instead of being something the body is turning towards.  It also buys
    # transient-glance rejection: flick to a corner and back, nothing moves.
    #
    # Below that range, and deliberately so: the viewer cannot turn their real
    # head to help, so the borrowed physiology only goes so far.
    #
    # Gaze arrives at about 30 Hz, so the wait can only end on a sample
    # boundary: the delay actually felt is the next whole sample above this,
    # and the only settings that exist are therefore one sample (~33 ms) and
    # two (~66 ms).  0.03 rather than 0.033 because the camera does not run at
    # exactly 30 Hz -- at the 30.5 FPS this was built against, 0.033 would
    # quietly cost two samples again.
    onset: float = 0.03
    expo: float = 1.0
    # Short: every millisecond here is felt directly as lag between looking
    # and moving.  It can afford to be shorter than it looks, because the
    # body's acceleration limit is itself a heavy low-pass on the rate -- the
    # turn cannot change faster than A_MAX however much the request jitters --
    # and the deadzone already absorbs the jitter that matters, the kind that
    # would otherwise creep the view while the viewer is holding still.
    tau: float = 0.02
    min_confidence: float = 0.5
    # Calibration is a fixation test, not a sample count.  The viewer has to
    # hold one spot continuously; wander further than the tolerance and the
    # streak starts again.
    calibration_hold: float = 1.4
    calibration_tolerance: float = 2.5
    invert_yaw: bool = False
    invert_pitch: bool = False


def response_angle(
    error: float,
    deadzone: float,
    gain: float,
    limit: float,
    expo: float = 1.0,
) -> float:
    """Shaped response for one axis.

    Zero inside the deadzone, then ``gain`` per degree of gaze beyond it,
    saturating at ``limit``.  ``expo`` above 1 trades sensitivity near the
    centre for reach at the edges; 1 is a straight proportional map, which is
    what "looking around" actually feels like.
    """
    if not math.isfinite(error):
        return 0.0
    magnitude = abs(error)
    if magnitude <= deadzone:
        return 0.0
    beyond = magnitude - deadzone
    if expo != 1.0:
        beyond = beyond**expo
    return math.copysign(min(gain * beyond, limit), error)


class _Ema:
    """Exponential moving average with a time constant, not a fixed weight.

    Gaze arrives at whatever rate the detector and the graph manage, and that
    rate varies.  Deriving the weight from elapsed time keeps the smoothing
    identical at 20 Hz and at 60 Hz, and makes a long gap -- a face lost and
    refound -- snap to the new value instead of easing towards a stale one.
    """

    def __init__(self, tau: float) -> None:
        self.tau = max(0.0, float(tau))
        self.value: float | None = None
        self._last: float | None = None

    def reset(self) -> None:
        self.value = None
        self._last = None

    def update(self, sample: float, timestamp: float) -> float:
        if self.value is None or self._last is None or self.tau <= 0.0:
            self.value = sample
            self._last = timestamp
            return sample
        dt = timestamp - self._last
        self._last = timestamp
        if dt <= 0.0:
            # A clock that went backwards tells us nothing; hold the estimate.
            return self.value
        alpha = 1.0 - math.exp(-dt / self.tau)
        self.value += alpha * (sample - self.value)
        return self.value


def clamp_aspect(aspect: float) -> float:
    """Fold a reported screen aspect into what could plausibly be a screen."""
    return min(MAX_ASPECT, max(MIN_ASPECT, aspect))


class GazeController:
    """Turns a stream of gaze samples into a requested turn rate."""

    def __init__(self, config: ControlConfig | None = None) -> None:
        self.config = config or ControlConfig()
        self._yaw = _Ema(self.config.tau)
        self._pitch = _Ema(self.config.tau)
        self.aspect = clamp_aspect(self.config.aspect)
        self.centre: tuple[float, float] = (0.0, 0.0)
        self.calibration = CalibrationState.COLLECTING
        # Bumped on every centring pass.  The page starts a pass and then has
        # to tell this pass's progress from the previous pass's, which is
        # still arriving on the stream; comparing generations settles it.
        self.generation = 0
        # Bumped every time the viewer looks away mid-pass, so the page can
        # say so rather than leaving a bar that silently went backwards.
        self.resets = 0
        self._reset_fixation()
        self._rate = (0.0, 0.0)
        self._committed = False
        self._outside_since: float | None = None

    # -- geometry --------------------------------------------------------

    @property
    def deadzone_pitch(self) -> float:
        """Narrower than yaw's on a wide screen: less room to look up."""
        if self.config.deadzone_pitch is not None:
            return self.config.deadzone_pitch
        return self.config.deadzone_yaw / self.aspect

    @property
    def rate_pitch(self) -> float:
        """Geared harder than yaw by exactly what the deadzone gave up."""
        if self.config.rate_pitch is not None:
            return self.config.rate_pitch
        return self.config.rate_yaw * self.aspect

    def set_aspect(self, aspect: object) -> float:
        """The page reporting the shape of the viewport it is filling.

        Anything unusable leaves the current shape alone: a bad number here
        would gear one axis into uselessness, and the page is at liberty to
        report nonsense while it is still laying itself out.
        """
        try:
            value = float(aspect)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return self.aspect
        if not math.isfinite(value) or value <= 0.0:
            return self.aspect
        self.aspect = clamp_aspect(value)
        return self.aspect

    @property
    def limits(self) -> dict:
        """What the HUD needs to draw the axes, at the current screen shape."""
        config = self.config
        return dict(
            deadzone_yaw=config.deadzone_yaw,
            deadzone_pitch=self.deadzone_pitch,
            # Where the axis saturates: the eccentricity at which the viewer
            # is already asking for the fastest turn on offer.
            span_yaw=config.deadzone_yaw
            + config.max_rate_yaw / max(config.rate_yaw, 1e-6),
            span_pitch=self.deadzone_pitch
            + config.max_rate_pitch / max(self.rate_pitch, 1e-6),
            max_rate_yaw=config.max_rate_yaw,
            max_rate_pitch=config.max_rate_pitch,
            aspect=self.aspect,
        )

    # -- calibration -----------------------------------------------------

    def _reset_fixation(self) -> None:
        self._streak: list[tuple[float, float]] = []
        self._streak_start: float | None = None
        self._progress = 0.0

    def recalibrate(self) -> int:
        """Re-run the centring pass.  The viewer stares at one spot."""
        self.calibration = CalibrationState.COLLECTING
        self.generation += 1
        self._reset_fixation()
        self._rate = (0.0, 0.0)
        self._committed = False
        self._outside_since = None
        return self.generation

    @property
    def calibration_progress(self) -> float:
        if self.calibration is CalibrationState.DONE:
            return 1.0
        return self._progress

    def _fixate(self, yaw: float, pitch: float, timestamp: float) -> None:
        """One sample of the hold-still test.

        The reading is compared against the mean of the streak so far rather
        than against its first sample, so a slow drift off the dot is caught
        as surely as a jump: the mean follows the drift, and the distance from
        it keeps growing until it trips.
        """
        config = self.config
        if self._streak:
            count = len(self._streak)
            mean_yaw = sum(item[0] for item in self._streak) / count
            mean_pitch = sum(item[1] for item in self._streak) / count
            wander = math.hypot(yaw - mean_yaw, pitch - mean_pitch)
            if wander > config.calibration_tolerance:
                # Looked away.  Nothing collected so far is trustworthy.
                self._reset_fixation()
                self.resets += 1
                return

        if self._streak_start is None:
            self._streak_start = timestamp
        self._streak.append((yaw, pitch))

        hold = max(1e-6, config.calibration_hold)
        held = max(0.0, timestamp - self._streak_start)
        self._progress = min(1.0, held / hold)
        if held >= hold:
            count = len(self._streak)
            self.centre = (
                sum(item[0] for item in self._streak) / count,
                sum(item[1] for item in self._streak) / count,
            )
            self.calibration = CalibrationState.DONE
            self._progress = 1.0

    # -- the map ---------------------------------------------------------

    def update(self, sample: GazeSample) -> ControlOutput:
        config = self.config
        usable = (
            sample.tracked
            and math.isfinite(sample.yaw)
            and math.isfinite(sample.pitch)
        )
        if not usable:
            # A blink or a hand across the face must not command a turn, but
            # it must not fling the view back either: ask for a stop.
            self._yaw.reset()
            self._pitch.reset()
            self._release()
            return self._still("lost", 0.0, 0.0, sample.confidence)

        yaw = self._yaw.update(sample.yaw, sample.timestamp)
        pitch = self._pitch.update(sample.pitch, sample.timestamp)

        if self.calibration is CalibrationState.COLLECTING:
            self._fixate(yaw, pitch, sample.timestamp)
            return self._still("calibrating", 0.0, 0.0, sample.confidence)

        yaw_error = yaw - self.centre[0]
        pitch_error = pitch - self.centre[1]

        if sample.confidence < config.min_confidence:
            self._release()
            return self._still(
                "low confidence", yaw_error, pitch_error, sample.confidence
            )

        # The onset gate: eccentricity has to stay out of the deadzone for a
        # moment before anything moves.  Once it has, the gate stays open
        # until the eyes come back inside, so it cannot re-trigger mid-turn.
        outside = (
            abs(yaw_error) > config.deadzone_yaw
            or abs(pitch_error) > self.deadzone_pitch
        )
        if not outside:
            self._release()
        else:
            if self._outside_since is None:
                self._outside_since = sample.timestamp
            if sample.timestamp - self._outside_since >= config.onset:
                self._committed = True

        if not self._committed:
            state = "committing" if outside else "holding"
            return self._still(state, yaw_error, pitch_error, sample.confidence)

        yaw_rate = response_angle(
            yaw_error,
            config.deadzone_yaw,
            config.rate_yaw,
            config.max_rate_yaw,
            config.expo,
        )
        pitch_rate = response_angle(
            pitch_error,
            self.deadzone_pitch,
            self.rate_pitch,
            config.max_rate_pitch,
            config.expo,
        )
        if config.invert_yaw:
            yaw_rate = -yaw_rate
        if config.invert_pitch:
            pitch_rate = -pitch_rate

        self._rate = (yaw_rate, pitch_rate)
        return ControlOutput(
            yaw_rate=yaw_rate,
            pitch_rate=pitch_rate,
            state="steering" if (yaw_rate or pitch_rate) else "holding",
            yaw_error=yaw_error,
            pitch_error=pitch_error,
            centre=self.centre,
            confidence=sample.confidence,
            committed=True,
        )

    def _release(self) -> None:
        """Shut the onset gate again."""
        self._committed = False
        self._outside_since = None

    def _still(
        self, state: str, yaw_error: float, pitch_error: float, confidence: float
    ) -> ControlOutput:
        """Ask for a stop.  The body decides how gently to come to one."""
        self._rate = (0.0, 0.0)
        return ControlOutput(
            yaw_rate=0.0,
            pitch_rate=0.0,
            state=state,
            yaw_error=yaw_error,
            pitch_error=pitch_error,
            centre=self.centre,
            confidence=confidence,
            committed=self._committed,
        )
