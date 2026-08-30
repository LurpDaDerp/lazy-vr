"""Gaze angles -> where the view should point.  Pure: no camera, no clock.

Absolute (position) mapping.  Gaze offset from centre sets the view *angle*,
not a pan speed, so looking back to the centre brings the view back to where it
started -- the view is an extension of where you are looking rather than a
joystick you have to re-centre.

The two axes are wholly independent, and deliberately not equally geared: a
viewer sweeps their eyes much further horizontally than vertically, so the same
gain would leave the vertical axis feeling dead.  Pitch is geared harder and
given a smaller deadzone.

This module emits a *target*; the browser eases towards it at display rate.
Every decision lives here, where it can be tested without hardware.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum


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
    """Where the view should point, plus what the HUD needs to explain it."""

    yaw: float
    pitch: float
    state: str
    yaw_error: float
    pitch_error: float
    centre: tuple[float, float]
    confidence: float


class CalibrationState(Enum):
    COLLECTING = "collecting"
    DONE = "done"


@dataclass(frozen=True)
class ControlConfig:
    # Degrees of view per degree of gaze, beyond the deadzone.
    gain_yaw: float = 4.0
    gain_pitch: float = 7.0
    # Small: absolute mapping cannot accumulate drift, so the deadzone only has
    # to swallow jitter at rest, not protect against a runaway integral.
    deadzone_yaw: float = 2.0
    deadzone_pitch: float = 1.0
    max_yaw: float = 180.0
    max_pitch: float = 85.0
    expo: float = 1.0
    # Short: the browser's easing does the smoothing, and every millisecond
    # here is felt directly as lag between looking and moving.
    tau: float = 0.03
    min_confidence: float = 0.5
    calibration_samples: int = 45
    invert_yaw: bool = False
    invert_pitch: bool = False


def response_angle(
    error: float,
    deadzone: float,
    gain: float,
    limit: float,
    expo: float = 1.0,
) -> float:
    """View angle for one axis, in degrees.

    Zero inside the deadzone, then ``gain`` degrees of view per degree of gaze
    beyond it, saturating at ``limit``.  ``expo`` above 1 trades sensitivity
    near the centre for reach at the edges; 1 is a straight proportional map,
    which is what "looking around" actually feels like.
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


class GazeController:
    """Turns a stream of gaze samples into a view target."""

    def __init__(self, config: ControlConfig | None = None) -> None:
        self.config = config or ControlConfig()
        self._yaw = _Ema(self.config.tau)
        self._pitch = _Ema(self.config.tau)
        self.centre: tuple[float, float] = (0.0, 0.0)
        self.calibration = CalibrationState.COLLECTING
        self._samples: list[tuple[float, float]] = []
        self._target = (0.0, 0.0)
        # Bumped on every centring pass.  The page starts a pass and then has
        # to tell this pass's progress from the previous pass's, which is
        # still arriving on the stream; comparing generations settles it.
        self.generation = 0

    def recalibrate(self) -> int:
        """Re-run the centring pass.  The viewer looks at the screen centre."""
        self.calibration = CalibrationState.COLLECTING
        self._samples = []
        self.generation += 1
        # Bring the view home while the viewer is being asked to look at the
        # centre, so it eases back during the countdown instead of snapping
        # the moment calibration finishes.
        self._target = (0.0, 0.0)
        return self.generation

    @property
    def calibration_progress(self) -> float:
        if self.calibration is CalibrationState.DONE:
            return 1.0
        needed = max(1, self.config.calibration_samples)
        return min(1.0, len(self._samples) / needed)

    def update(self, sample: GazeSample) -> ControlOutput:
        config = self.config
        usable = (
            sample.tracked
            and math.isfinite(sample.yaw)
            and math.isfinite(sample.pitch)
        )
        if not usable:
            # Hold the last target rather than snapping home: a blink or a hand
            # across the face must not throw the view back to centre.
            self._yaw.reset()
            self._pitch.reset()
            return self._hold("lost", 0.0, 0.0, sample.confidence)

        yaw = self._yaw.update(sample.yaw, sample.timestamp)
        pitch = self._pitch.update(sample.pitch, sample.timestamp)

        if self.calibration is CalibrationState.COLLECTING:
            self._samples.append((yaw, pitch))
            if len(self._samples) >= max(1, config.calibration_samples):
                count = len(self._samples)
                self.centre = (
                    sum(item[0] for item in self._samples) / count,
                    sum(item[1] for item in self._samples) / count,
                )
                self.calibration = CalibrationState.DONE
                self._target = (0.0, 0.0)
            return self._hold("calibrating", 0.0, 0.0, sample.confidence)

        yaw_error = yaw - self.centre[0]
        pitch_error = pitch - self.centre[1]

        if sample.confidence < config.min_confidence:
            return self._hold(
                "low confidence", yaw_error, pitch_error, sample.confidence
            )

        yaw_target = response_angle(
            yaw_error, config.deadzone_yaw, config.gain_yaw, config.max_yaw, config.expo
        )
        pitch_target = response_angle(
            pitch_error,
            config.deadzone_pitch,
            config.gain_pitch,
            config.max_pitch,
            config.expo,
        )
        if config.invert_yaw:
            yaw_target = -yaw_target
        if config.invert_pitch:
            pitch_target = -pitch_target

        self._target = (yaw_target, pitch_target)
        centred = yaw_target == 0.0 and pitch_target == 0.0
        return ControlOutput(
            yaw=yaw_target,
            pitch=pitch_target,
            state="centred" if centred else "looking",
            yaw_error=yaw_error,
            pitch_error=pitch_error,
            centre=self.centre,
            confidence=sample.confidence,
        )

    def _hold(
        self, state: str, yaw_error: float, pitch_error: float, confidence: float
    ) -> ControlOutput:
        return ControlOutput(
            yaw=self._target[0],
            pitch=self._target[1],
            state=state,
            yaw_error=yaw_error,
            pitch_error=pitch_error,
            centre=self.centre,
            confidence=confidence,
        )
