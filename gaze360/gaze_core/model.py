"""ONNX Runtime wrapper for the single-stage direct gaze model."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .geometry import NUM_LANDMARKS, mirror_cloud, mirror_context, mirror_validity

CLOUD_INPUT = "cloud"
CONTEXT_INPUT = "context"
VALIDITY_INPUT = "validity"
GAZE_OUTPUT = "gaze"
ROTATION_OUTPUT = "rotation"
PARITY_TOLERANCE = 1e-4


def _session(model_path: Path, threads: int) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(threads))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )


def _sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def permutation_sha256(permutation: np.ndarray) -> str:
    """Digest of the permutation's int64 bytes, as the export metadata records it."""
    return hashlib.sha256(
        np.asarray(permutation).astype(np.int64).tobytes()
    ).hexdigest()


class DirectGazeModel:
    """Exported ``gaze_direct.onnx``: weak3d cloud + camera context -> camera gaze.

    ``predict`` runs mirror test-time augmentation in one batch-2 session
    call: the second row is the left/right-permuted cloud with ``x`` negated,
    the context ray's ``x`` negated and the validity permuted; its gaze is
    un-mirrored (``x`` negated) and averaged with the direct row.  The
    auxiliary head rotation comes from the direct row only.

    ``validity`` (478,) marks landmarks the caller knows are missing (out of
    frame); the far-eye visibility gate runs inside the graph.
    """

    def __init__(
        self, model_path: Path, permutation: np.ndarray, threads: int = 2
    ) -> None:
        perm = np.asarray(permutation, dtype=np.int64)
        if perm.shape != (NUM_LANDMARKS,):
            raise RuntimeError("mirror permutation must have 478 entries")
        self.permutation = perm
        self.session = _session(model_path, threads)
        inputs = {item.name: item for item in self.session.get_inputs()}
        outputs = {item.name: item for item in self.session.get_outputs()}
        for name in (CLOUD_INPUT, CONTEXT_INPUT, VALIDITY_INPUT):
            if name not in inputs:
                raise RuntimeError(f"model is missing input {name!r}")
        validity_shape = list(inputs[VALIDITY_INPUT].shape)
        if validity_shape[1:] != [NUM_LANDMARKS]:
            raise RuntimeError(f"unexpected validity input shape: {validity_shape}")
        for name in (GAZE_OUTPUT, ROTATION_OUTPUT):
            if name not in outputs:
                raise RuntimeError(f"model is missing output {name!r}")
        cloud_shape = list(inputs[CLOUD_INPUT].shape)
        if cloud_shape[1:] != [NUM_LANDMARKS, 3]:
            raise RuntimeError(f"unexpected cloud input shape: {cloud_shape}")
        context_shape = list(inputs[CONTEXT_INPUT].shape)
        if context_shape[1:] not in ([3], [7]):
            raise RuntimeError(f"unexpected context input shape: {context_shape}")
        # 3 = camera scalars only; 7 = camera scalars + the four subject statistics
        self.context_width = int(context_shape[1])
        self.output_names = [GAZE_OUTPUT, ROTATION_OUTPUT]
        warmup = np.zeros((NUM_LANDMARKS, 3), dtype=np.float32)
        warmup[33, 0], warmup[263, 0] = -0.5, 0.5
        self.predict(warmup, np.zeros(self.context_width, dtype=np.float32))

    def run_batch(
        self, cloud: np.ndarray, context: np.ndarray, validity: np.ndarray | None = None
    ) -> tuple[np.ndarray, np.ndarray]:
        """Raw session call without TTA: ``(B, 478, 3), (B, C)[, (B, 478)] -> (B, 3), (B, 3, 3)``."""
        cloud_values = np.ascontiguousarray(cloud, dtype=np.float32)
        context_values = np.ascontiguousarray(context, dtype=np.float32)
        if cloud_values.ndim != 3 or cloud_values.shape[1:] != (NUM_LANDMARKS, 3):
            raise ValueError(
                f"cloud batch must have shape (B, {NUM_LANDMARKS}, 3), "
                f"got {cloud_values.shape}"
            )
        if context_values.shape != (cloud_values.shape[0], self.context_width):
            raise ValueError(
                f"context batch must have shape ({cloud_values.shape[0]}, {self.context_width}), "
                f"got {context_values.shape}"
            )
        if validity is None:
            validity_values = np.ones((cloud_values.shape[0], NUM_LANDMARKS), dtype=np.float32)
        else:
            validity_values = np.ascontiguousarray(validity, dtype=np.float32)
            if validity_values.shape != (cloud_values.shape[0], NUM_LANDMARKS):
                raise ValueError(
                    f"validity batch must have shape ({cloud_values.shape[0]}, {NUM_LANDMARKS}), "
                    f"got {validity_values.shape}"
                )
        gaze, rotation = self.session.run(
            self.output_names,
            {CLOUD_INPUT: cloud_values, CONTEXT_INPUT: context_values, VALIDITY_INPUT: validity_values},
        )
        return gaze, rotation

    def predict(
        self, cloud: np.ndarray, context: np.ndarray, validity: np.ndarray | None = None
    ) -> tuple[np.ndarray, np.ndarray]:
        """Return ``(unit camera-frame gaze (3,), head rotation (3, 3))`` for one frame."""
        cloud_values = np.asarray(cloud, dtype=np.float64)
        context_values = np.asarray(context, dtype=np.float64)
        if cloud_values.shape != (NUM_LANDMARKS, 3):
            raise ValueError(
                f"cloud must have shape ({NUM_LANDMARKS}, 3), got {cloud_values.shape}"
            )
        if context_values.shape != (self.context_width,):
            raise ValueError(f"context must have shape ({self.context_width},), got {context_values.shape}")
        valid = np.ones(NUM_LANDMARKS, dtype=np.float32) if validity is None else np.asarray(validity, dtype=np.float32)
        if valid.shape != (NUM_LANDMARKS,):
            raise ValueError(f"validity must have shape ({NUM_LANDMARKS},), got {valid.shape}")
        batch_cloud = np.stack(
            [cloud_values, mirror_cloud(cloud_values, self.permutation)], axis=0
        )
        batch_context = np.stack(
            [context_values, mirror_context(context_values)], axis=0
        )
        batch_validity = np.stack([valid, mirror_validity(valid, self.permutation)], axis=0)
        gaze, rotation = self.run_batch(batch_cloud, batch_context, batch_validity)
        direct = gaze[0].astype(np.float64)
        mirrored = gaze[1].astype(np.float64) * np.asarray([-1.0, 1.0, 1.0])
        total = direct + mirrored
        unit = total / np.clip(np.linalg.norm(total), 1e-9, None)
        return unit.astype(np.float32), rotation[0].astype(np.float64)

    def benchmark(self, iterations: int) -> tuple[float, float]:
        """Mean throughput (FPS) and latency (ms) of ``predict`` with TTA."""
        cloud = np.zeros((NUM_LANDMARKS, 3), dtype=np.float32)
        cloud[33, 0], cloud[263, 0] = -0.5, 0.5
        context = np.zeros(self.context_width, dtype=np.float32)
        started = time.perf_counter()
        for _ in range(iterations):
            self.predict(cloud, context)
        elapsed = time.perf_counter() - started
        return iterations / elapsed, 1_000.0 * elapsed / iterations


def load_export_metadata(path: Path) -> dict:
    """Read the exporter's record of how the checkpoint was built."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    metadata = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(metadata, dict):
        raise RuntimeError(f"{path.name} must contain a JSON object")
    return metadata


def validate_direct_bundle(
    metadata: dict,
    onnx_path: Path,
    permutation: np.ndarray | None = None,
) -> None:
    """Reject a stale or cross-wired ``gaze_direct`` bundle before the camera opens."""
    expected = str(metadata.get("onnx_sha256", ""))
    if not expected:
        raise RuntimeError("export metadata is missing onnx_sha256")
    if _sha256_of_file(onnx_path) != expected:
        raise RuntimeError(
            "gaze_direct.onnx does not match export metadata; regenerate or "
            "copy the complete model bundle"
        )
    if str(metadata.get("output_frame", "")) != "camera":
        raise RuntimeError(
            "export metadata must declare output_frame 'camera'; this demo "
            "applies no head-to-camera rotation after the model"
        )
    inputs = metadata.get("inputs", {})
    if not isinstance(inputs, dict) or not {CLOUD_INPUT, CONTEXT_INPUT, VALIDITY_INPUT} <= set(inputs):
        raise RuntimeError("export metadata must describe the cloud, context and validity inputs")
    gate = metadata.get("eye_gate")
    if not isinstance(gate, dict) or not {"low", "high"} <= set(gate):
        raise RuntimeError("export metadata must declare the far-eye visibility gate (eye_gate.low / high)")
    if not str(metadata.get("mirror_tta", "")):
        raise RuntimeError("export metadata does not declare the mirror TTA recipe")
    if permutation is not None:
        expected_perm = str(metadata.get("mirror_permutation_sha256", ""))
        if not expected_perm:
            raise RuntimeError("export metadata is missing mirror_permutation_sha256")
        if permutation_sha256(permutation) != expected_perm:
            raise RuntimeError(
                "mirror permutation does not match export metadata; regenerate "
                "or copy the complete model bundle"
            )


def parity_self_test(model: DirectGazeModel, parity_path: Path) -> float:
    """Prove the ONNX graph reproduces the PyTorch checkpoint; return max |dgaze|."""
    with np.load(parity_path) as case:
        cloud = case["cloud"].astype(np.float32)
        context = case["context"].astype(np.float32)
        validity = case["validity"].astype(np.float32) if "validity" in case.files else None
        expected_gaze = case["gaze"].astype(np.float64)
        expected_rotation = case["rotation"].astype(np.float64)
    gaze, rotation = model.run_batch(cloud, context, validity)
    gaze_diff = float(np.abs(gaze.astype(np.float64) - expected_gaze).max())
    rotation_diff = float(np.abs(rotation.astype(np.float64) - expected_rotation).max())
    for label, diff in (("gaze", gaze_diff), ("rotation", rotation_diff)):
        if not np.isfinite(diff) or diff > PARITY_TOLERANCE:
            raise RuntimeError(
                f"{Path(parity_path).name}: {label} parity diff {diff:.2e} "
                f"exceeds {PARITY_TOLERANCE:g}"
            )
    return gaze_diff
