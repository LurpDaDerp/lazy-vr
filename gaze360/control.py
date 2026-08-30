"""Gaze angles -> pan rates.  Pure: no camera, no video, no clock of its own.

Rate (joystick) control.  Gaze past a deadzone sets the pan *speed*, so the
whole 360 degrees is reachable -- an absolute mapping cannot manage that from
the roughly +/-35 degrees of gaze a viewer has before the screen edge.

The module emits rates and never a view angle.  Position is integrated in the
browser at display refresh rate, which keeps network jitter out of the motion;
see the design note in ``docs/superpowers/specs``.  Everything that decides
anything lives here, where it can be tested without hardware.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
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
    """Pan rates in degrees per second, plus what the HUD needs to explain them."""

    yaw_rate: float
    pitch_rate: float
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
    deadzone: float = 6.0
    max_angle: float = 26.0
    max_speed: float = 120.0
    expo: float = 2.0
    tau: float = 0.08
    min_confidence: float = 0.5
    calibration_samples: int = 45
    invert_yaw: bool = False
    invert_pitch: bool = False


def response_rate(
    error: float,
    deadzone: float,
    max_angle: float,
    max_speed: float,
    expo: float = 2.0,
) -> float:
    """Pan speed for one axis, in degrees per second.

    Zero inside the deadzone, then ``u**expo`` of full speed across the band
    from ``deadzone`` to ``max_angle``, saturating beyond it.  The deadzone is
    sized against the model's error so that a still gaze drifts exactly zero,
    and the exponent buys fine control near the centre without giving up a
    fast pan at the extremes.
    """
    if not math.isfinite(error):
        return 0.0
    magnitude = abs(error)
    if magnitude <= deadzone:
        return 0.0
    band = max_angle - deadzone
    if band <= 0.0:
        # Degenerate configuration: no live band, so nothing to command.
        return 0.0
    unit = min((magnitude - deadzone) / band, 1.0)
    return math.copysign(max_speed * unit**expo, error)


class _Ema:
    """Exponential moving average with a time constant, not a fixed weight.

    Gaze arrives at whatever rate MediaPipe and the ONNX graph manage, and
    that rate varies.  Deriving the weight from the elapsed time keeps the
    smoothing identical at 20 Hz and at 40 Hz, and makes a long gap -- a face
    lost and refound -- snap to the new value instead of easing towards a
    stale one.
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
    """Turns a stream of gaze samples into pan rates.

    Holds three pieces of state: the smoothers, the calibrated centre, and
    where calibration has got to.  ``update`` is the whole interface.
    """

    def __init__(self, config: ControlConfig | None = None) -> None:
        self.config = config or ControlConfig()
        self._yaw = _Ema(self.config.tau)
        self._pitch = _Ema(self.config.tau)
        self.centre: tuple[float, float] = (0.0, 0.0)
        self.calibration = CalibrationState.COLLECTING
        self._samples: list[tuple[float, float]] = []

    def recalibrate(self) -> None:
        """Re-run the centring pass.  The viewer looks at the screen centre."""
        self.calibration = CalibrationState.COLLECTING
        self._samples = []

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
            # Freeze rather than coast: a glance away must not spin the world.
            self._yaw.reset()
            self._pitch.reset()
            return self._still("lost", 0.0, 0.0, sample.confidence)

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
            return self._still("calibrating", 0.0, 0.0, sample.confidence)

        yaw_error = yaw - self.centre[0]
        pitch_error = pitch - self.centre[1]

        if sample.confidence < config.min_confidence:
            return self._still(
                "low confidence", yaw_error, pitch_error, sample.confidence
            )

        yaw_rate = response_rate(
            yaw_error, config.deadzone, config.max_angle, config.max_speed, config.expo
        )
        pitch_rate = response_rate(
            pitch_error,
            config.deadzone,
            config.max_angle,
            config.max_speed,
            config.expo,
        )
        if config.invert_yaw:
            yaw_rate = -yaw_rate
        if config.invert_pitch:
            pitch_rate = -pitch_rate

        moving = yaw_rate != 0.0 or pitch_rate != 0.0
        return ControlOutput(
            yaw_rate=yaw_rate,
            pitch_rate=pitch_rate,
            state="panning" if moving else "centred",
            yaw_error=yaw_error,
            pitch_error=pitch_error,
            centre=self.centre,
            confidence=sample.confidence,
        )

    def _still(
        self, state: str, yaw_error: float, pitch_error: float, confidence: float
    ) -> ControlOutput:
        return ControlOutput(
            yaw_rate=0.0,
            pitch_rate=0.0,
            state=state,
            yaw_error=yaw_error,
            pitch_error=pitch_error,
            centre=self.centre,
            confidence=confidence,
        )
