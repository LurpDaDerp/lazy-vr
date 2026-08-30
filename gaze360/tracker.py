"""Webcam -> MediaPipe landmarks -> gaze angles, on background threads.

Adapted from the gaze-direct demo's camera and worker threading, with the
OpenCV window and argparse handling removed: this process is headless and the
browser is the entire interface.

One deliberate departure from the demo.  The demo detects on the *mirrored*
preview so its arrow lines up with what the viewer sees.  Here the detector
runs on the raw frame, which fixes the sign unambiguously -- the camera's +x is
image right, the viewer's own left lands on image right, so looking left gives
``atan2(x, z) > 0``.  The preview is mirrored for display only.  The model is
mirror-equivariant and runs mirror TTA internally, so this costs no accuracy.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

from .control import GazeSample
from .gaze_core.extraction import MirrorAveragedExtractor, load_mirror_permutation
from .gaze_core.geometry import (
    SubjectStatistics,
    camera_context,
    eye_visibility,
    gaze_vector_to_angles,
    landmark_validity,
    weak3d_cloud,
)
from .gaze_core.model import (
    DirectGazeModel,
    load_export_metadata,
    parity_self_test,
    validate_direct_bundle,
)

MODEL_STEM = "gaze_direct"
PERMUTATION_NAME = "mediapipe_mirror_permutation_478.npy"


@dataclass(frozen=True)
class LandmarkPacket:
    timestamp_ms: int
    landmarks: np.ndarray | None
    width: int
    height: int
    frame_bgr: np.ndarray | None = None


@dataclass(frozen=True)
class GazeReading:
    sample: GazeSample
    eye_visibility: tuple[float, float]
    latency_ms: float


class RateMeter:
    def __init__(self, window: int = 60) -> None:
        self.times: deque[float] = deque(maxlen=window)

    def tick(self) -> None:
        self.times.append(time.perf_counter())

    @property
    def rate(self) -> float:
        if len(self.times) < 2:
            return 0.0
        return (len(self.times) - 1) / (self.times[-1] - self.times[0])


class LandmarkMailbox:
    def __init__(self, width: int, height: int) -> None:
        self.width, self.height = width, height
        self.lock = threading.Lock()
        self.packet: LandmarkPacket | None = None

    def callback(
        self, result: vision.FaceLandmarkerResult, image: mp.Image, timestamp_ms: int
    ) -> None:
        landmarks = None
        frame_bgr = None
        if result.face_landmarks:
            landmarks = np.asarray(
                [(p.x, p.y, p.z) for p in result.face_landmarks[0]], dtype=np.float32
            )
            # The flipped second extraction pass must run on the very frame
            # the detector saw.
            frame_bgr = cv2.cvtColor(image.numpy_view(), cv2.COLOR_RGB2BGR)
        with self.lock:
            self.packet = LandmarkPacket(
                timestamp_ms, landmarks, self.width, self.height, frame_bgr
            )

    def after(self, timestamp_ms: int) -> LandmarkPacket | None:
        with self.lock:
            if self.packet is None or self.packet.timestamp_ms <= timestamp_ms:
                return None
            return self.packet


class LatestFrameCamera:
    """DirectShow capture that never accumulates stale USB frames."""

    def __init__(
        self, index: int, width: int, height: int, fps: float, backend: str, mjpeg: bool
    ) -> None:
        backend_id = cv2.CAP_DSHOW if backend == "dshow" else cv2.CAP_MSMF
        self.capture = cv2.VideoCapture(index, backend_id)
        if not self.capture.isOpened() and backend == "dshow":
            self.capture.release()
            self.capture = cv2.VideoCapture(index, cv2.CAP_ANY)
        if not self.capture.isOpened():
            raise RuntimeError(
                f"cannot open camera {index}; check Windows Settings > Privacy & "
                "security > Camera and try --camera 1"
            )
        # Size and rate before the codec: requesting MJPG first silently leaves
        # DirectShow on uncompressed YUY2, whose USB bandwidth caps 720p near
        # 10 FPS.
        self.capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.capture.set(cv2.CAP_PROP_FPS, fps)
        if mjpeg:
            self.capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self.capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.frame: np.ndarray | None = None
        self.sequence = -1
        self.error: str | None = None
        self.thread = threading.Thread(target=self._loop, name="usb-camera", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _loop(self) -> None:
        failures = 0
        while not self.stop_event.is_set():
            ok, frame = self.capture.read()
            if not ok or frame is None:
                failures += 1
                if failures >= 30:
                    self.error = "camera stopped returning frames"
                    return
                time.sleep(0.005)
                continue
            failures = 0
            with self.lock:
                self.sequence += 1
                self.frame = frame

    def latest(self, after: int) -> tuple[int, np.ndarray | None]:
        if self.error:
            raise RuntimeError(self.error)
        with self.lock:
            if self.sequence <= after or self.frame is None:
                return after, None
            return self.sequence, self.frame

    @property
    def settings(self) -> tuple[int, int, float, str]:
        fourcc = int(self.capture.get(cv2.CAP_PROP_FOURCC))
        codec = "".join(chr((fourcc >> (8 * i)) & 0xFF) for i in range(4))
        return (
            int(self.capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            int(self.capture.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            float(self.capture.get(cv2.CAP_PROP_FPS)),
            codec,
        )

    def close(self) -> None:
        self.stop_event.set()
        if self.thread.is_alive():
            self.thread.join(timeout=1)
        self.capture.release()


class Pipeline:
    """MediaPipe landmarks -> weak3d cloud + camera context -> gaze angles."""

    def __init__(
        self,
        model: DirectGazeModel,
        focal_scale: float,
        mirror_extractor: MirrorAveragedExtractor | None,
        subject_stats: SubjectStatistics | None,
        eye_gate: tuple[float, float],
    ) -> None:
        if not np.isfinite(focal_scale) or focal_scale <= 0:
            raise ValueError("focal_scale must be positive")
        self.model = model
        self.focal_scale = float(focal_scale)
        self.eye_gate = (float(eye_gate[0]), float(eye_gate[1]))
        self.subject_stats = subject_stats
        if model.context_width == 7 and subject_stats is None:
            raise ValueError("this bundle needs the subject-statistics tracker")
        self.mirror_extractor = mirror_extractor

    def predict(self, packet: LandmarkPacket) -> GazeReading:
        if packet.landmarks is None:
            raise ValueError("no face detected")
        started = time.perf_counter()
        landmarks = packet.landmarks
        if self.mirror_extractor is not None:
            if packet.frame_bgr is None:
                raise ValueError("mirror-averaged extraction requires the frame")
            landmarks = self.mirror_extractor.averaged_cloud(
                landmarks, packet.frame_bgr
            ).astype(np.float32)
        cloud = weak3d_cloud(landmarks, packet.width, packet.height)
        context = camera_context(
            landmarks, packet.width, packet.height, self.focal_scale
        )
        if self.model.context_width == 7:
            context = np.concatenate([context, self.subject_stats.push(cloud)])
        validity = landmark_validity(landmarks)
        gaze, _rotation = self.model.predict(cloud, context, validity)
        angles = gaze_vector_to_angles(gaze)
        return GazeReading(
            sample=GazeSample(
                yaw=float(angles[0]),
                pitch=float(angles[1]),
                tracked=True,
                # The fraction of landmarks inside the frame is the honest
                # quality signal.  Eye visibility is not: the far-eye gate is
                # relative, so its maximum is 1 by construction, and it drops
                # exactly when the viewer turns -- when we most want to pan.
                confidence=float(validity.mean()),
                timestamp=time.perf_counter(),
            ),
            eye_visibility=eye_visibility(cloud, *self.eye_gate),
            latency_ms=1_000 * (time.perf_counter() - started),
        )


def build_landmarker(path: Path, mailbox: LandmarkMailbox) -> vision.FaceLandmarker:
    return vision.FaceLandmarker.create_from_options(
        vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(path)),
            running_mode=vision.RunningMode.LIVE_STREAM,
            num_faces=1,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
            result_callback=mailbox.callback,
        )
    )


def resize_for_detector(frame: np.ndarray, target_width: int) -> np.ndarray:
    if target_width <= 0 or frame.shape[1] <= target_width:
        return frame
    height = max(1, round(frame.shape[0] * target_width / frame.shape[1]))
    return cv2.resize(frame, (target_width, height), interpolation=cv2.INTER_AREA)


def load_bundle(models_dir: Path, threads: int) -> tuple[DirectGazeModel, dict, np.ndarray]:
    """Open the validated bundle, refusing a stale or cross-wired one."""
    models_dir = Path(models_dir)
    metadata = load_export_metadata(models_dir / f"{MODEL_STEM}.meta.json")
    permutation = load_mirror_permutation(models_dir)
    validate_direct_bundle(metadata, models_dir / f"{MODEL_STEM}.onnx", permutation)
    model = DirectGazeModel(models_dir / f"{MODEL_STEM}.onnx", permutation, threads)
    return model, metadata, permutation


def subject_statistics_tracker(
    model: DirectGazeModel, metadata: dict
) -> SubjectStatistics | None:
    if model.context_width != 7:
        return None
    stats = metadata.get("subject_stats") or {}
    default = stats.get("training_mean")
    if not isinstance(default, list) or len(default) != 4:
        raise RuntimeError("export metadata must carry subject_stats.training_mean")
    return SubjectStatistics(default)


def run_parity(model: DirectGazeModel, models_dir: Path) -> float:
    return parity_self_test(model, Path(models_dir) / f"{MODEL_STEM}.parity.npz")


class GazeTracker:
    """Owns the camera, the detector and the inference thread.

    ``on_reading`` is called from the inference thread for every frame,
    tracked or not, so the controller downstream sees losses as well as hits.
    """

    def __init__(
        self,
        models_dir: Path,
        camera_index: int,
        width: int,
        height: int,
        camera_fps: float,
        backend: str,
        mjpeg: bool,
        detector_width: int,
        focal_scale: float,
        threads: int,
        preview_width: int,
    ) -> None:
        self.model, self.metadata, self.permutation = load_bundle(models_dir, threads)
        gate = self.metadata.get("eye_gate") or {}
        self.pipeline = Pipeline(
            self.model,
            focal_scale,
            MirrorAveragedExtractor(
                Path(models_dir) / "face_landmarker.task", self.permutation
            ),
            subject_statistics_tracker(self.model, self.metadata),
            (float(gate.get("low", 0.0)), float(gate.get("high", 0.0))),
        )
        self.landmarker_path = Path(models_dir) / "face_landmarker.task"
        self.camera = LatestFrameCamera(
            camera_index, width, height, camera_fps, backend, mjpeg
        )
        self.detector_width = detector_width
        self.preview_width = preview_width
        self.gaze_rate = RateMeter()
        self.stop_event = threading.Event()
        self.on_reading = lambda reading: None
        self.on_preview = lambda jpeg: None
        self._thread = threading.Thread(
            target=self._loop, name="gaze-tracker", daemon=True
        )

    @property
    def settings(self) -> tuple[int, int, float, str]:
        return self.camera.settings

    def start(self) -> None:
        self.camera.start()
        self._thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self._thread.is_alive():
            self._thread.join(timeout=2)
        self.camera.close()
        self.pipeline.mirror_extractor.close()

    def _loop(self) -> None:
        last_sequence = -1
        submitted = -1
        last_result = -1
        last_preview = 0.0
        mailbox: LandmarkMailbox | None = None
        landmarker: vision.FaceLandmarker | None = None
        try:
            while not self.stop_event.is_set():
                last_sequence, frame = self.camera.latest(last_sequence)
                if frame is not None:
                    # The detector sees the RAW frame; the sign convention
                    # depends on it.
                    small = resize_for_detector(frame, self.detector_width)
                    if mailbox is None:
                        mailbox = LandmarkMailbox(small.shape[1], small.shape[0])
                        landmarker = build_landmarker(self.landmarker_path, mailbox)
                    timestamp = int(time.perf_counter() * 1000)
                    if timestamp > submitted:
                        submitted = timestamp
                        landmarker.detect_async(
                            mp.Image(
                                image_format=mp.ImageFormat.SRGB,
                                data=np.ascontiguousarray(
                                    cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
                                ),
                            ),
                            timestamp,
                        )
                    now = time.perf_counter()
                    if now - last_preview > 0.08:
                        last_preview = now
                        self._publish_preview(frame)

                packet = mailbox.after(last_result) if mailbox else None
                if packet is None:
                    time.sleep(0.002)
                    continue
                last_result = packet.timestamp_ms
                self.on_reading(self._read(packet))
                self.gaze_rate.tick()
        finally:
            if landmarker is not None:
                landmarker.close()

    def _read(self, packet: LandmarkPacket) -> GazeReading:
        if packet.landmarks is None:
            return self._lost()
        try:
            return self.pipeline.predict(packet)
        except ValueError:
            return self._lost()

    def _lost(self) -> GazeReading:
        return GazeReading(
            sample=GazeSample(0.0, 0.0, False, 0.0, time.perf_counter()),
            eye_visibility=(0.0, 0.0),
            latency_ms=0.0,
        )

    def _publish_preview(self, frame: np.ndarray) -> None:
        # Mirrored, because a viewer expects a mirror of themself -- display
        # only; the detector above saw the raw frame.
        preview = resize_for_detector(frame, self.preview_width)[:, ::-1]
        ok, buffer = cv2.imencode(
            ".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 70]
        )
        if ok:
            self.on_preview(buffer.tobytes())
