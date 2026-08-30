"""Turn the model bundle's numpy artefacts into JSON the browser and the tests can read.

Run once, from a Python that has numpy.  Produces:

  site/models/mirror_permutation.json   the 478-point left/right permutation
  site/models/parity.json              the exporter's eight reference frames
  tests/fixtures/geometry_parity.json   what the numpy geometry makes of
                                        synthetic landmarks, for the JS port

The geometry here is a self-contained copy of the reference implementation
(the original lived in gaze360/gaze_core/geometry.py, in the history), so
the fixture can be regenerated without it.  Anything the browser computes
from landmarks is pinned by this file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
NUM_LANDMARKS = 478
RIGHT, LEFT = 33, 263
FOCAL_SCALE = 0.75
EYE_GATE = (0.45, 0.65)


# -- the reference geometry, verbatim in spirit -----------------------------

def aspect_corrected(landmarks, width, height):
    points = np.asarray(landmarks, dtype=np.float64).copy()
    points[:, 1] *= float(height) / float(width)
    return points


def weak3d_cloud(landmarks, width, height):
    points = aspect_corrected(landmarks, width, height)
    relative = points - 0.5 * (points[RIGHT] + points[LEFT])
    scale = float(np.linalg.norm(relative[RIGHT, :2] - relative[LEFT, :2]))
    return relative / scale


def camera_context(landmarks, width, height, focal):
    points = aspect_corrected(landmarks, width, height)
    center = 0.5 * (points[RIGHT] + points[LEFT])
    iod = float(np.linalg.norm(points[RIGHT, :2] - points[LEFT, :2]))
    ratio = float(height) / float(width)
    return np.asarray([(center[0] - 0.5) / focal, (center[1] - 0.5 * ratio) / focal, iod / focal])


STAT_EYES = (((33, 133), 468, 159, 145, 105, 1.0), ((263, 362), 473, 386, 374, 334, -1.0))


def row_statistics(cloud):
    c = np.asarray(cloud, dtype=np.float64)
    out = np.zeros(4)
    for (a, b), iris, upper, lower, brow, sign in STAT_EYES:
        centre = 0.5 * (c[a, :2] + c[b, :2])
        u = c[b, :2] - c[a, :2]
        width = float(np.linalg.norm(u))
        u = u / width
        v = np.asarray([-u[1], u[0]])
        along = lambda i: float(np.dot(c[i, :2] - centre, v)) / width * sign
        up, lo, ir, br = along(upper), along(lower), along(iris), along(brow)
        out += np.asarray([abs(up - lo), ir - 0.5 * (up + lo), up, br])
    return 0.5 * out


def landmark_validity(landmarks, margin=0.0):
    p = np.asarray(landmarks, dtype=np.float64)
    inside = ((p[:, 0] >= -margin) & (p[:, 0] <= 1 + margin)
              & (p[:, 1] >= -margin) & (p[:, 1] <= 1 + margin))
    return inside.astype(np.float64)


def eye_visibility(cloud, low, high):
    c = np.asarray(cloud, dtype=np.float64)
    wr = float(np.linalg.norm(c[33, :2] - c[133, :2]))
    wl = float(np.linalg.norm(c[263, :2] - c[362, :2]))
    if high <= low or wr < 1e-8 or wl < 1e-8:
        return [1.0, 1.0]
    span = high - low
    return [float(np.clip((wr / wl - low) / span, 0, 1)), float(np.clip((wl / wr - low) / span, 0, 1))]


def mirror_cloud(cloud, perm):
    m = np.asarray(cloud, dtype=np.float64)[perm].copy()
    m[:, 0] *= -1
    return m


def gaze_angles(vector):
    unit = np.asarray(vector, dtype=np.float64)
    unit = unit / np.linalg.norm(unit)
    return [float(np.rad2deg(np.arctan2(unit[0], unit[2]))),
            float(np.rad2deg(np.arctan2(-unit[1], np.hypot(unit[0], unit[2]))))]


def running_median(rows, window, min_frames, default):
    """SubjectStatistics.current() after each push, for the fixture."""
    seen = []
    out = []
    for row in rows:
        seen.append(row)
        seen = seen[-window:]
        if len(seen) < min_frames:
            out.append(list(default))
        else:
            out.append(np.median(np.asarray(seen), axis=0).tolist())
    return out


# -- synthetic raw landmarks, from the parity clouds ------------------------

def raw_landmarks_from_cloud(cloud, width, height, shift_x=0.0):
    """Undo the normalisation loosely: a plausible face in a 640x480 frame."""
    ratio = height / width
    raw = np.empty_like(cloud, dtype=np.float64)
    raw[:, 0] = 0.5 + shift_x + cloud[:, 0] * 0.08
    raw[:, 1] = (0.5 * ratio + cloud[:, 1] * 0.08) / ratio
    raw[:, 2] = cloud[:, 2] * 0.08
    return raw


def main() -> int:
    models = FIXTURES
    site_models = ROOT / "site" / "models"
    site_models.mkdir(parents=True, exist_ok=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)

    perm = np.load(models / "mediapipe_mirror_permutation_478.npy").astype(np.int64)
    assert perm.shape == (NUM_LANDMARKS,) and np.array_equal(perm[perm], np.arange(NUM_LANDMARKS))
    (site_models / "mirror_permutation.json").write_text(json.dumps(perm.tolist()), encoding="utf-8")

    with np.load(models / "gaze_direct.parity.npz") as case:
        parity = {
            "cloud": case["cloud"].astype(np.float64).tolist(),
            "context": case["context"].astype(np.float64).tolist(),
            "validity": case["validity"].astype(np.float64).tolist(),
            "gaze": case["gaze"].astype(np.float64).tolist(),
            "rotation": case["rotation"].astype(np.float64).tolist(),
            "tolerance": 1e-4,
        }
        clouds = case["cloud"].astype(np.float64)
        gazes = case["gaze"].astype(np.float64)
    (site_models / "parity.json").write_text(json.dumps(parity), encoding="utf-8")

    width, height = 640, 480
    cases = []
    for index, cloud in enumerate(clouds):
        # The last case pushes the face half out of frame, so some landmarks
        # are invalid and the validity path is exercised too.
        shift = 0.45 if index == len(clouds) - 1 else 0.0
        raw = raw_landmarks_from_cloud(cloud, width, height, shift)
        made = weak3d_cloud(raw, width, height)
        cases.append({
            "landmarks": raw.tolist(),
            "width": width,
            "height": height,
            "cloud": made.tolist(),
            "context": camera_context(raw, width, height, FOCAL_SCALE).tolist(),
            "stats": row_statistics(made).tolist(),
            "validity": landmark_validity(raw).tolist(),
            "eye_visibility": eye_visibility(made, *EYE_GATE),
            "mirrored_cloud": mirror_cloud(made, perm).tolist(),
            "angles": gaze_angles(gazes[index]),
            "gaze": gazes[index].tolist(),
        })
    rows = [row_statistics(weak3d_cloud(np.asarray(c["landmarks"]), width, height)) for c in cases]
    default = [0.314825177192688, -0.02144768089056015, -0.21198900043964386, -0.9026849865913391]
    geometry = {
        "focal_scale": FOCAL_SCALE,
        "eye_gate": list(EYE_GATE),
        "permutation": perm.tolist(),
        "cases": cases,
        "running_median": {
            "window": 5, "min_frames": 3, "default": default,
            "expected": running_median(rows, 5, 3, default),
        },
    }
    (FIXTURES / "geometry_parity.json").write_text(json.dumps(geometry), encoding="utf-8")

    # While the original module still exists, prove this copy agrees with it.
    try:
        sys.path.insert(0, str(ROOT))
        from gaze360.gaze_core import geometry as reference  # type: ignore
    except Exception:
        print("reference module not present; skipped the self-check")
    else:
        for case in cases:
            raw = np.asarray(case["landmarks"])
            assert np.allclose(reference.weak3d_cloud(raw, width, height), case["cloud"], atol=1e-12)
            assert np.allclose(reference.camera_context(raw, width, height, FOCAL_SCALE), case["context"], atol=1e-12)
            assert np.allclose(reference.row_statistics(np.asarray(case["cloud"])), case["stats"], atol=1e-12)
            assert np.array_equal(reference.landmark_validity(raw), np.asarray(case["validity"], dtype=np.float32))
            assert np.allclose(reference.eye_visibility(np.asarray(case["cloud"]), *EYE_GATE), case["eye_visibility"])
            assert np.allclose(reference.mirror_cloud(np.asarray(case["cloud"]), perm), case["mirrored_cloud"])
            assert np.allclose(reference.gaze_vector_to_angles(np.asarray(case["gaze"])), case["angles"], atol=1e-4)
        print("self-check against gaze360.gaze_core.geometry: identical")

    print(f"wrote {site_models / 'mirror_permutation.json'}")
    print(f"wrote {site_models / 'parity.json'}")
    print(f"wrote {FIXTURES / 'geometry_parity.json'} ({len(cases)} cases)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
