"""Mirror-averaged landmark extraction (methodology log section 35).

The promoted pipeline extracts every frame twice - as captured and
horizontally flipped, each pass with its own MediaPipe detection - and feeds
the mean cloud to the normalizer.  The
flipped cloud is un-mirrored with ``x -> 1 - x`` plus the anatomical
478-point left/right permutation shipped in the export bundle.  The two
passes disagree by ~0.009-0.014 interocular units at the irises; averaging
cancels the extractor's per-side noise and its side-dependent pitch DC.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

PERMUTATION_NAME = "mediapipe_mirror_permutation_478.npy"


def load_mirror_permutation(models_dir: Path, expected_sha256: str | None = None) -> np.ndarray:
    """Load and validate the anatomical left/right landmark permutation."""

    path = Path(models_dir) / PERMUTATION_NAME
    if not path.is_file():
        raise FileNotFoundError(
            f"the export metadata declares mirror-averaged extraction but "
            f"{path} is missing; copy the complete model bundle"
        )
    if expected_sha256:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected_sha256:
            raise RuntimeError(
                "mirror permutation does not match export metadata; "
                "regenerate or copy the complete model bundle"
            )
    permutation = np.load(path)
    if permutation.shape != (478,) or not np.array_equal(
        permutation[permutation], np.arange(478)
    ):
        raise RuntimeError("mirror permutation must be a 478-point involution")
    return permutation.astype(np.int64)


class MirrorAveragedExtractor:
    """Second (flipped-frame) extraction pass and the landmark-cloud mean.

    The direct pass arrives from the live-stream detector; this class owns an
    IMAGE-mode detector for the flipped frame, runs the depth stage on both
    frames, and returns the averaged cloud.  When the flipped-frame detection
    fails the direct cloud is returned alone, so the pipeline degrades to
    single-pass extraction instead of dropping the frame.
    """

    def __init__(
        self,
        landmarker_path: Path,
        permutation: np.ndarray,
    ) -> None:
        self.permutation = permutation
        self.landmarker = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(landmarker_path)),
                running_mode=vision.RunningMode.IMAGE,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                output_face_blendshapes=False,
                output_facial_transformation_matrixes=False,
            )
        )

    def close(self) -> None:
        self.landmarker.close()

    def averaged_cloud(
        self, landmarks: np.ndarray, frame_bgr: np.ndarray
    ) -> np.ndarray:
        """Return the mean of the direct and un-mirrored flipped extractions.

        ``landmarks`` is the direct pass's normalized (478, 3) cloud with
        native MediaPipe weak z.
        """

        direct = landmarks.astype(np.float64).copy()
        flipped = np.ascontiguousarray(frame_bgr[:, ::-1])
        result = self.landmarker.detect(
            mp.Image(
                image_format=mp.ImageFormat.SRGB,
                data=np.ascontiguousarray(
                    cv2.cvtColor(flipped, cv2.COLOR_BGR2RGB)
                ),
            )
        )
        if not result.face_landmarks:
            return direct
        mirrored = np.asarray(
            [(p.x, p.y, p.z) for p in result.face_landmarks[0]],
            dtype=np.float64,
        )
        unmirrored = mirrored[self.permutation].copy()
        unmirrored[:, 0] = 1.0 - unmirrored[:, 0]
        return 0.5 * (direct + unmirrored)


def average_clouds(
    direct: np.ndarray, mirrored: np.ndarray, permutation: np.ndarray
) -> np.ndarray:
    """Pure averaging op (mirrored cloud in the flipped frame), for tests."""

    unmirrored = mirrored[permutation].copy()
    unmirrored[:, 0] = 1.0 - unmirrored[:, 0]
    return 0.5 * (np.asarray(direct, dtype=np.float64) + unmirrored)
