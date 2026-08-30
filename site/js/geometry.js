/* Landmark-cloud normalisation and gaze conventions for the direct model.
 *
 * A port of the reference numpy geometry, held to it by a fixture the numpy
 * produced (tests/fixtures/geometry_parity.json).  The exported ONNX graph
 * reads the raw MediaPipe cloud at any head pose and returns a camera-frame
 * gaze vector; nothing here rotates the gaze afterwards.  The only geometry
 * the page performs is building the model's inputs.
 *
 * Coordinate convention: OpenCV camera axes, +x image right, +y image down,
 * +z away from the camera.  Gaze is stored as s = diag(1, 1, -1) p with p
 * the physical direction, so forward gaze has +z.  Angles: horizontal
 * atan2(x, z) (positive = image right, which is the viewer's own left),
 * vertical atan2(-y, hypot(x, z)) (positive = up).
 */

export const NUM_LANDMARKS = 478;
const RIGHT = 33, LEFT = 263;

/* MediaPipe normalises x by the frame width and y by its height, with z in
 * width units.  Put y in width units too, so the cloud is metric. */
function aspectCorrected(landmarks, width, height) {
  const ratio = height / width;
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    out[i * 3] = landmarks[i * 3];
    out[i * 3 + 1] = landmarks[i * 3 + 1] * ratio;
    out[i * 3 + 2] = landmarks[i * 3 + 2];
  }
  return out;
}

/* Eye-centred, interocular-normalised weak-3D cloud: the `cloud` input.
 * `landmarks` is a flat (478*3) array of MediaPipe-normalised x, y, z. */
export function weak3dCloud(landmarks, width, height) {
  const p = aspectCorrected(landmarks, width, height);
  const cx = 0.5 * (p[RIGHT * 3] + p[LEFT * 3]);
  const cy = 0.5 * (p[RIGHT * 3 + 1] + p[LEFT * 3 + 1]);
  const cz = 0.5 * (p[RIGHT * 3 + 2] + p[LEFT * 3 + 2]);
  const scale = Math.hypot(p[RIGHT * 3] - p[LEFT * 3], p[RIGHT * 3 + 1] - p[LEFT * 3 + 1]);
  if (!Number.isFinite(scale) || scale < 1e-8) throw new Error("degenerate interocular distance");
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    out[i * 3] = (p[i * 3] - cx) / scale;
    out[i * 3 + 1] = (p[i * 3 + 1] - cy) / scale;
    out[i * 3 + 2] = (p[i * 3 + 2] - cz) / scale;
  }
  return out;
}

/* Per-frame camera scalars (ray_x, ray_y, iod / focal): the first three of
 * the `context` input.  The ray is the calibrated line through the eye
 * midpoint, in frame widths relative to the principal point, over
 * focal = fx / width. */
export function cameraContext(landmarks, width, height, focalScale) {
  if (!Number.isFinite(focalScale) || focalScale <= 0) throw new Error("focal_scale must be positive");
  const p = aspectCorrected(landmarks, width, height);
  const cx = 0.5 * (p[RIGHT * 3] + p[LEFT * 3]);
  const cy = 0.5 * (p[RIGHT * 3 + 1] + p[LEFT * 3 + 1]);
  const iod = Math.hypot(p[RIGHT * 3] - p[LEFT * 3], p[RIGHT * 3 + 1] - p[LEFT * 3 + 1]);
  if (!Number.isFinite(iod) || iod < 1e-8) throw new Error("degenerate interocular distance");
  const ratio = height / width;
  return [(cx - 0.5) / focalScale, (cy - 0.5 * ratio) / focalScale, iod / focalScale];
}

const STAT_EYES = [
  [[33, 133], 468, 159, 145, 105, 1.0],
  [[263, 362], 473, 386, 374, 334, -1.0],
];

/* Per-frame eye statistics of a weak3d cloud, in eye widths: lid aperture,
 * the iris centre's vertical offset in the aperture, the upper lid's level
 * and the brow's level.  Mean of both eyes, with the left eye's signed axes
 * flipped so the values are mirror-invariant.  The running median of these
 * is the second part of the `context` input. */
export function rowStatistics(cloud) {
  const out = [0, 0, 0, 0];
  for (const [[a, b], iris, upper, lower, brow, sign] of STAT_EYES) {
    const ax = cloud[a * 3], ay = cloud[a * 3 + 1];
    const bx = cloud[b * 3], by = cloud[b * 3 + 1];
    const centreX = 0.5 * (ax + bx), centreY = 0.5 * (ay + by);
    let ux = bx - ax, uy = by - ay;
    const width = Math.hypot(ux, uy);
    if (!Number.isFinite(width) || width < 1e-8) throw new Error("degenerate eye width");
    ux /= width; uy /= width;
    const vx = -uy, vy = ux;
    const along = (i) =>
      ((cloud[i * 3] - centreX) * vx + (cloud[i * 3 + 1] - centreY) * vy) / width * sign;
    const up = along(upper), lo = along(lower), ir = along(iris), br = along(brow);
    out[0] += Math.abs(up - lo);
    out[1] += ir - 0.5 * (up + lo);
    out[2] += up;
    out[3] += br;
  }
  return out.map((v) => 0.5 * v);
}

/* Running median of rowStatistics over the last `window` frames -- the
 * deployment analogue of the per-subject median the model was trained with.
 * Until `minFrames` have been seen it returns `fallback`, the training
 * population mean, which the graph reads as a zero offset. */
export class SubjectStatistics {
  constructor(fallback, window = 1800, minFrames = 30) {
    this.fallback = fallback.slice();
    this.window = window;
    this.minFrames = minFrames;
    this.rows = [];
  }

  push(cloud) {
    this.rows.push(rowStatistics(cloud));
    if (this.rows.length > this.window) this.rows.shift();
    return this.current();
  }

  current() {
    if (this.rows.length < this.minFrames) return this.fallback.slice();
    const out = [];
    for (let column = 0; column < 4; column++) {
      const values = this.rows.map((row) => row[column]).sort((a, b) => a - b);
      const mid = values.length >> 1;
      out.push(values.length % 2 ? values[mid] : 0.5 * (values[mid - 1] + values[mid]));
    }
    return out;
  }

  reset() {
    this.rows = [];
  }
}

/* 1 for a landmark inside the frame, 0 for one the detector placed outside
 * it: the `validity` input.  The network was trained with partially
 * out-of-frame eyes marked missing, and reads the gaze from the eye that is
 * in frame. */
export function landmarkValidity(landmarks, margin = 0) {
  const out = new Float32Array(NUM_LANDMARKS);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const x = landmarks[i * 3], y = landmarks[i * 3 + 1];
    out[i] = x >= -margin && x <= 1 + margin && y >= -margin && y <= 1 + margin ? 1 : 0;
  }
  return out;
}

/* (right, left) visibility of each eye under the far-eye gate the graph
 * applies internally.  Display only; the graph computes the same itself. */
export function eyeVisibility(cloud, low, high) {
  const wr = Math.hypot(cloud[33 * 3] - cloud[133 * 3], cloud[33 * 3 + 1] - cloud[133 * 3 + 1]);
  const wl = Math.hypot(cloud[263 * 3] - cloud[362 * 3], cloud[263 * 3 + 1] - cloud[362 * 3 + 1]);
  if (high <= low || wr < 1e-8 || wl < 1e-8) return [1, 1];
  const span = high - low;
  const clip = (v) => Math.min(1, Math.max(0, v));
  return [clip((wr / wl - low) / span), clip((wl / wr - low) / span)];
}

/* Horizontal mirror of a weak3d cloud: left/right permuted, x negated. */
export function mirrorCloud(cloud, permutation) {
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const j = permutation[i];
    out[i * 3] = -cloud[j * 3];
    out[i * 3 + 1] = cloud[j * 3 + 1];
    out[i * 3 + 2] = cloud[j * 3 + 2];
  }
  return out;
}

/* Camera context of the mirrored frame: only the ray's x changes sign. */
export function mirrorContext(context) {
  const out = context.slice();
  out[0] = -out[0];
  return out;
}

/* Validity of the mirrored cloud: the permutation only. */
export function mirrorValidity(validity, permutation) {
  const out = new Float32Array(NUM_LANDMARKS);
  for (let i = 0; i < NUM_LANDMARKS; i++) out[i] = validity[permutation[i]];
  return out;
}

/* Un-mirror a cloud the detector found in a horizontally flipped frame, in
 * MediaPipe-normalised coordinates: permute, then x -> 1 - x.  Averaged with
 * the direct detection this cancels the extractor's per-side noise. */
export function averageClouds(direct, mirrored, permutation) {
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    const j = permutation[i];
    out[i * 3] = 0.5 * (direct[i * 3] + (1 - mirrored[j * 3]));
    out[i * 3 + 1] = 0.5 * (direct[i * 3 + 1] + mirrored[j * 3 + 1]);
    out[i * 3 + 2] = 0.5 * (direct[i * 3 + 2] + mirrored[j * 3 + 2]);
  }
  return out;
}

/* Average the direct and mirrored gazes of the TTA batch, un-mirroring the
 * second (x negated), and normalise. */
export function combineGaze(direct, mirrored) {
  const x = direct[0] - mirrored[0];
  const y = direct[1] + mirrored[1];
  const z = direct[2] + mirrored[2];
  const norm = Math.max(1e-9, Math.hypot(x, y, z));
  return [x / norm, y / norm, z / norm];
}

const RAD = 180 / Math.PI;

/* (horizontal, vertical) in degrees.  Horizontal positive is image right --
 * the viewer's own left. */
export function gazeAngles(vector) {
  const norm = Math.max(1e-9, Math.hypot(vector[0], vector[1], vector[2]));
  const x = vector[0] / norm, y = vector[1] / norm, z = vector[2] / norm;
  return [Math.atan2(x, z) * RAD, Math.atan2(-y, Math.hypot(x, z)) * RAD];
}

/* Flatten MediaPipe's array of {x, y, z} into the layout everything above
 * takes. */
export function flattenLandmarks(points) {
  if (points.length !== NUM_LANDMARKS) throw new Error(`expected ${NUM_LANDMARKS} landmarks, got ${points.length}`);
  const out = new Float64Array(NUM_LANDMARKS * 3);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    out[i * 3] = points[i].x;
    out[i * 3 + 1] = points[i].y;
    out[i * 3 + 2] = points[i].z;
  }
  return out;
}
