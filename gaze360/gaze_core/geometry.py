"""Landmark-cloud normalization and gaze conventions for the direct model.

The exported ``gaze_direct.onnx`` graph reads the raw MediaPipe cloud at any
head pose and returns a camera-frame gaze vector.  Nothing here rotates the
gaze afterwards; the only geometry the demo performs is building the model's
two inputs.

Coordinate convention: OpenCV camera axes, ``+x`` image right, ``+y`` image
down, ``+z`` away from the camera.  Gaze is stored as ``s = M p`` with
``M = diag(1, 1, -1)`` and ``p`` the physical OpenCV direction, so forward
gaze has ``+z``.  Angles: horizontal ``atan2(x, z)`` (positive = image
right), vertical ``atan2(-y, hypot(x, z))`` (positive = up).  The model's
auxiliary rotation ``R`` is column-vector source-to-camera; the face points
along physical ``-z``, so its forward direction in stored form is
``M R M @ (0, 0, 1)``.
"""

from __future__ import annotations

import numpy as np


NUM_LANDMARKS = 478
OUTER_EYE_CORNERS = (33, 263)
MIRROR_Z = np.diag([1.0, 1.0, -1.0])

# Landmark groups the overlay colours; the model itself consumes all 478.
RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
RIGHT_IRIS = [468, 469, 470, 471, 472]
LEFT_IRIS = [473, 474, 475, 476, 477]
RIGHT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
LEFT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
RIGID = [
    1, 4, 5, 6, 9, 10, 151, 152, 168, 197, 195, 2, 98, 327,
    234, 454, 132, 361, 58, 288, 93, 323, 127, 356, 162, 389,
    21, 251, 54, 284, 103, 332, 67, 297, 109, 338,
]
EYE_REGION_IDS = np.asarray(
    RIGHT_EYE + LEFT_EYE + RIGHT_IRIS + LEFT_IRIS
    + RIGHT_BROW + LEFT_BROW + RIGID,
    dtype=np.int64,
)
STABLE_LANDMARK_IDS = np.asarray(
    [
        4, 6, 10, 33, 54, 67, 117, 119, 121, 127, 129, 132, 133, 136,
        143, 147, 198, 205, 263, 284, 297, 346, 348, 350, 356, 358,
        361, 362, 365, 372, 376, 420, 425,
    ],
    dtype=np.int64,
)


def _aspect_corrected(landmarks: np.ndarray, width: int, height: int) -> np.ndarray:
    """MediaPipe normalized ``(x/W, y/H, z/W)`` -> all axes in width units."""
    points = np.asarray(landmarks, dtype=np.float64)
    if points.shape != (NUM_LANDMARKS, 3):
        raise ValueError(
            f"landmarks must have shape ({NUM_LANDMARKS}, 3), got {points.shape}"
        )
    points = points.copy()
    points[:, 1] *= float(height) / float(width)
    return points


def weak3d_cloud(landmarks: np.ndarray, width: int, height: int) -> np.ndarray:
    """Eye-centered, interocular-normalized weak-3D landmark cloud.

    Aspect-correct ``y``, centre on the midpoint of the outer eye corners
    (33, 263), and divide all three axes by their 2D separation.  This is the
    ``cloud`` input of ``gaze_direct.onnx``.
    """
    points = _aspect_corrected(landmarks, width, height)
    right, left = OUTER_EYE_CORNERS
    relative = points - 0.5 * (points[right] + points[left])
    scale = float(np.linalg.norm(relative[right, :2] - relative[left, :2]))
    if not np.isfinite(scale) or scale < 1e-8:
        raise ValueError("degenerate interocular distance")
    return relative / scale


def camera_context(
    landmarks: np.ndarray, width: int, height: int, focal_scale: float
) -> np.ndarray:
    """Per-frame camera scalars ``(ray_x, ray_y, iod / focal)``.

    The first two are the calibrated ray through the eye midpoint (eye
    centre in aspect-corrected frame units, relative to the principal point,
    divided by ``focal_scale = fx / width``); the third is the projected
    interocular distance in frame widths over the same focal ratio.  This is
    the ``context`` input of ``gaze_direct.onnx``.
    """
    focal = float(focal_scale)
    if not np.isfinite(focal) or focal <= 0.0:
        raise ValueError("focal_scale must be positive")
    points = _aspect_corrected(landmarks, width, height)
    right, left = OUTER_EYE_CORNERS
    center = 0.5 * (points[right] + points[left])
    iod = float(np.linalg.norm(points[right, :2] - points[left, :2]))
    if not np.isfinite(iod) or iod < 1e-8:
        raise ValueError("degenerate interocular distance")
    ratio = float(height) / float(width)
    return np.asarray(
        [
            (center[0] - 0.5) / focal,
            (center[1] - 0.5 * ratio) / focal,
            iod / focal,
        ],
        dtype=np.float64,
    )


STAT_NAMES = ("aperture", "iris_y_in_aperture", "upper_lid_v", "brow_v")
_STAT_EYES = (((33, 133), 468, 159, 145, 105, 1.0), ((263, 362), 473, 386, 374, 334, -1.0))


def row_statistics(cloud: np.ndarray) -> np.ndarray:
    """Per-frame eye statistics of a weak3d cloud, ``(4,)`` in eye widths: the lid
    aperture over the corner width, the iris centre's vertical offset from the
    lid-aperture centre, the upper lid's level and the brow's level along each eye's
    vertical (mean of both eyes; the left eye's signed axes flipped so the values are
    mirror-invariant).  The driver's running MEDIAN of these forms the statistics part
    of the ``context`` input of a subject-statistics bundle (section 18 of the research
    log): the graph reads the identity part of the vertical cue from it instead of
    guessing it from one frame."""
    c = np.asarray(cloud, dtype=np.float64)
    if c.shape != (NUM_LANDMARKS, 3):
        raise ValueError(f"cloud must have shape ({NUM_LANDMARKS}, 3), got {c.shape}")
    out = np.zeros(4)
    for (a, b), iris, upper, lower, brow, sign in _STAT_EYES:
        centre = 0.5 * (c[a, :2] + c[b, :2])
        u = c[b, :2] - c[a, :2]
        width = float(np.linalg.norm(u))
        if not np.isfinite(width) or width < 1e-8:
            raise ValueError("degenerate eye width")
        u = u / width
        v = np.asarray([-u[1], u[0]])
        along_v = lambda i: float(np.dot(c[i, :2] - centre, v)) / width * sign
        up, lo, ir, br = along_v(upper), along_v(lower), along_v(iris), along_v(brow)
        out += np.asarray([abs(up - lo), ir - 0.5 * (up + lo), up, br])
    return 0.5 * out


class SubjectStatistics:
    """Running median of ``row_statistics`` over the last ``window`` frames — the
    deployment analogue of the per-subject median the model was trained with.  Until
    ``min_frames`` frames have been seen it returns ``default`` (the training-population
    mean recorded in the export metadata, i.e. a zero offset)."""

    def __init__(self, default, window: int = 1800, min_frames: int = 30) -> None:
        self.default = np.asarray(default, dtype=np.float64).reshape(4)
        self.window = int(window)
        self.min_frames = int(min_frames)
        self._buffer = np.zeros((self.window, 4))
        self._count = 0
        self._next = 0

    def push(self, cloud: np.ndarray) -> np.ndarray:
        self._buffer[self._next] = row_statistics(cloud)
        self._next = (self._next + 1) % self.window
        self._count = min(self._count + 1, self.window)
        return self.current()

    def current(self) -> np.ndarray:
        if self._count < self.min_frames:
            return self.default.copy()
        return np.median(self._buffer[: self._count], axis=0)

    def reset(self) -> None:
        self._count = 0
        self._next = 0


def landmark_validity(landmarks: np.ndarray, margin: float = 0.0) -> np.ndarray:
    """``(478,)`` float32 validity of MediaPipe-normalized landmarks: 1 inside the frame, 0 for a
    landmark the detector placed outside it (``x`` or ``y`` beyond ``[0, 1]`` by more than
    ``margin``).  This is the ``validity`` input of ``gaze_direct.onnx``: the network was trained
    with partially out-of-frame eyes whose out-of-frame landmarks are marked missing, and reads
    the gaze from the eye that is in frame."""
    points = np.asarray(landmarks, dtype=np.float64)
    if points.shape != (NUM_LANDMARKS, 3):
        raise ValueError(f"landmarks must have shape ({NUM_LANDMARKS}, 3), got {points.shape}")
    inside = (
        (points[:, 0] >= -margin) & (points[:, 0] <= 1.0 + margin)
        & (points[:, 1] >= -margin) & (points[:, 1] <= 1.0 + margin)
    )
    return inside.astype(np.float32)


def eye_visibility(cloud: np.ndarray, low: float, high: float) -> tuple[float, float]:
    """``(right, left)`` visibility of each eye under the far-eye gate the graph applies
    internally: ``clip((its corner width / the other eye's - low) / (high - low), 0, 1)``.
    Display only - the graph computes the same quantity itself."""
    c = np.asarray(cloud, dtype=np.float64)
    wr = float(np.linalg.norm(c[33, :2] - c[133, :2]))
    wl = float(np.linalg.norm(c[263, :2] - c[362, :2]))
    if high <= low or wr < 1e-8 or wl < 1e-8:
        return 1.0, 1.0
    span = high - low
    return float(np.clip((wr / wl - low) / span, 0.0, 1.0)), float(np.clip((wl / wr - low) / span, 0.0, 1.0))


def mirror_validity(validity: np.ndarray, permutation: np.ndarray) -> np.ndarray:
    """Validity of the mirrored cloud: the left/right permutation only."""
    return np.asarray(validity, dtype=np.float32)[np.asarray(permutation, dtype=np.int64)]


def mirror_cloud(cloud: np.ndarray, permutation: np.ndarray) -> np.ndarray:
    """Horizontal mirror of a weak3d cloud: left/right permuted, ``x -> -x``."""
    values = np.asarray(cloud, dtype=np.float64)
    perm = np.asarray(permutation, dtype=np.int64)
    if perm.shape != (NUM_LANDMARKS,):
        raise ValueError("mirror permutation must have 478 entries")
    mirrored = values[..., perm, :].copy()
    mirrored[..., 0] *= -1.0
    return mirrored


def mirror_context(context: np.ndarray) -> np.ndarray:
    """Camera context of the mirrored frame: only the ray's x changes sign."""
    mirrored = np.asarray(context, dtype=np.float64).copy()
    mirrored[..., 0] *= -1.0
    return mirrored


def head_direction(rotation: np.ndarray) -> np.ndarray:
    """Face-forward unit vector (stored convention) of a head rotated by ``R``."""
    matrix = np.asarray(rotation, dtype=np.float64)
    forward = (MIRROR_Z @ matrix @ MIRROR_Z) @ np.asarray([0.0, 0.0, 1.0])
    return forward / np.clip(np.linalg.norm(forward), 1e-9, None)


def gaze_vector_to_angles(vector: np.ndarray) -> np.ndarray:
    unit = vector / np.clip(np.linalg.norm(vector), 1e-9, None)
    horizontal = np.rad2deg(np.arctan2(unit[0], unit[2]))
    vertical = np.rad2deg(np.arctan2(-unit[1], np.hypot(unit[0], unit[2])))
    return np.asarray([horizontal, vertical], dtype=np.float32)
