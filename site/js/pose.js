/* Head pose from MediaPipe face landmarks: a hand-written PnP (Levenberg-Marquardt
 * on SO(3)) against MediaPipe's canonical face model, then head orientation
 * relative to the head->screen ray. Pure module (no DOM, timers or globals).
 *
 * Frames (see research-headpose.md §0):
 * - camera: OpenCV style, +x image right, +y image down, +z out of the lens toward the user.
 * - head:   origin at the midpoint of the four eye corners, +x subject's left, +y down,
 *           +z into the head; a face looking straight into the camera has R = I.
 * R maps head -> camera (P_cam = R·P_head + t), stored row-major in a Float64Array(9).
 * Angles are degrees: yaw > 0 head turned to the user's right, pitch > 0 up,
 * roll > 0 tilted toward the user's right shoulder.
 */

import { TimedMedian, wrapDegrees } from "./filters.js";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/* Canonical model origin (eye-corner midpoint) in canonical_face_model.obj coordinates. */
const ORIGIN_Y = 2.624618;
const ORIGIN_Z = 3.465663;
/* |p263 - p33| in the canonical model, cm. */
export const OUTER_EYE_CM = 8.891718;

/* Canonical (X, Y, Z) cm from canonical_face_model.obj (line n+1 = landmark n) and weights.
 * Only rigid points: no chin, mouth, brows, lids or silhouette. */
const RIGID = [
  // midline, nose
  [1, 0, -1.126865, 7.475604, 1.0], [4, 0, -0.463170, 7.586580, 1.0],
  [195, 0, 1.059413, 6.774605, 1.0], [197, 0, 1.728369, 6.316750, 1.0],
  [6, 0, 2.473255, 5.788627, 1.0], [168, 0, 3.271027, 5.236015, 1.0],
  // midline, forehead
  [9, 0, 4.885979, 5.385258, 0.7], [151, 0, 6.545390, 5.027311, 0.7], [10, 0, 8.261778, 4.481535, 0.7],
  // eye corners (33/133 subject's right eye, 362/263 subject's left eye)
  [33, -4.445859, 2.663991, 3.173422, 1.0], [263, 4.445859, 2.663991, 3.173422, 1.0],
  [133, -1.856432, 2.585245, 3.757904, 1.0], [362, 1.856432, 2.585245, 3.757904, 1.0],
  // nose base and alar
  [98, -1.405627, -1.714196, 5.241087, 1.0], [327, 1.405627, -1.714196, 5.241087, 1.0],
  [129, -1.785794, -0.978284, 4.850470, 1.0], [358, 1.785794, -0.978284, 4.850470, 1.0],
  // forehead, lateral
  [109, -1.891399, 8.236377, 4.274997, 0.7], [338, 1.891399, 8.236377, 4.274997, 0.7],
  [67, -3.523964, 8.005976, 3.729163, 0.7], [297, 3.523964, 8.005976, 3.729163, 0.7],
  [54, -6.279331, 6.615427, 1.425850, 0.7], [284, 6.279331, 6.615427, 1.425850, 0.7],
  // cheekbone, lateral
  [116, -6.465170, 0.937119, 1.689873, 0.5], [345, 6.465170, 0.937119, 1.689873, 0.5],
  [123, -6.338145, -0.529279, 1.881175, 0.5], [352, 6.338145, -0.529279, 1.881175, 0.5],
  [143, -6.407571, 2.236021, 1.560843, 0.5], [372, 6.407571, 2.236021, 1.560843, 0.5],
];

/* Canonical obj coordinates -> head frame: P = (Xc, -(Yc - 2.624618), -(Zc - 3.465663)). */
export function headFromCanonical(X, Y, Z) {
  return [X, -(Y - ORIGIN_Y), -(Z - ORIGIN_Z)];
}

export const CANONICAL = Object.freeze(RIGID.map(([index, X, Y, Z, w]) => {
  const [x, y, z] = headFromCanonical(X, Y, Z);
  return Object.freeze({ index, x, y, z, w });
}));

/* Pinhole focal length (px) from the diagonal field of view; principal point is the centre. */
export function focalFor(width, height, dfovDeg = 78) {
  return 0.5 * Math.hypot(width, height) / Math.tan(0.5 * dfovDeg * RAD);
}

// -- 3x3 helpers (row-major Float64Array(9)) ------------------------------------------

export function identity3(out = new Float64Array(9)) {
  out.fill(0); out[0] = out[4] = out[8] = 1; return out;
}

export function multiply3(A, B, out = new Float64Array(9)) {
  const a0 = A[0], a1 = A[1], a2 = A[2], a3 = A[3], a4 = A[4], a5 = A[5], a6 = A[6], a7 = A[7], a8 = A[8];
  const b0 = B[0], b1 = B[1], b2 = B[2], b3 = B[3], b4 = B[4], b5 = B[5], b6 = B[6], b7 = B[7], b8 = B[8];
  out[0] = a0 * b0 + a1 * b3 + a2 * b6; out[1] = a0 * b1 + a1 * b4 + a2 * b7; out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6; out[4] = a3 * b1 + a4 * b4 + a5 * b7; out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6; out[7] = a6 * b1 + a7 * b4 + a8 * b7; out[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return out;
}

/* Aᵀ·B */
function multiplyT3(A, B, out) {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[3 * i + j] = A[i] * B[j] + A[3 + i] * B[3 + j] + A[6 + i] * B[6 + j];
  }
  return out;
}

export function rotationX(rad, out = new Float64Array(9)) {
  const c = Math.cos(rad), s = Math.sin(rad);
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = c; out[5] = -s; out[6] = 0; out[7] = s; out[8] = c;
  return out;
}

export function rotationY(rad, out = new Float64Array(9)) {
  const c = Math.cos(rad), s = Math.sin(rad);
  out[0] = c; out[1] = 0; out[2] = s; out[3] = 0; out[4] = 1; out[5] = 0; out[6] = -s; out[7] = 0; out[8] = c;
  return out;
}

export function rotationZ(rad, out = new Float64Array(9)) {
  const c = Math.cos(rad), s = Math.sin(rad);
  out[0] = c; out[1] = -s; out[2] = 0; out[3] = s; out[4] = c; out[5] = 0; out[6] = 0; out[7] = 0; out[8] = 1;
  return out;
}

/* R for given head angles (degrees): R = Ry(yaw)·Rx(-pitch)·Rz(-roll). Inverse of eulerFromR. */
export function rotationFromEuler(yaw, pitch, roll = 0, out = new Float64Array(9)) {
  const tmp = multiply3(rotationX(-pitch * RAD), rotationZ(-roll * RAD));
  return multiply3(rotationY(yaw * RAD), tmp, out);
}

/* Rodrigues: exp([w]x) */
function expSO3(wx, wy, wz, out) {
  const th2 = wx * wx + wy * wy + wz * wz, th = Math.sqrt(th2);
  let a, b;
  if (th < 1e-8) { a = 1; b = 0.5; } else { a = Math.sin(th) / th; b = (1 - Math.cos(th)) / th2; }
  // [w]x² = w·wᵀ - θ²·I
  out[0] = 1 + b * (wx * wx - th2); out[1] = -a * wz + b * wx * wy; out[2] = a * wy + b * wx * wz;
  out[3] = a * wz + b * wx * wy; out[4] = 1 + b * (wy * wy - th2); out[5] = -a * wx + b * wy * wz;
  out[6] = -a * wy + b * wx * wz; out[7] = a * wx + b * wy * wz; out[8] = 1 + b * (wz * wz - th2);
  return out;
}

/* Re-orthonormalise (Gram-Schmidt on rows) so warm-started rotations never drift. */
function orthonormalize(R) {
  let n = Math.hypot(R[0], R[1], R[2]);
  R[0] /= n; R[1] /= n; R[2] /= n;
  const d = R[0] * R[3] + R[1] * R[4] + R[2] * R[5];
  R[3] -= d * R[0]; R[4] -= d * R[1]; R[5] -= d * R[2];
  n = Math.hypot(R[3], R[4], R[5]);
  R[3] /= n; R[4] /= n; R[5] /= n;
  R[6] = R[1] * R[5] - R[2] * R[4];
  R[7] = R[2] * R[3] - R[0] * R[5];
  R[8] = R[0] * R[4] - R[1] * R[3];
  return R;
}

/* One Euro smoothing factor for cutoff (Hz) and dt (s). */
const smoothing = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

const allFinite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

/* yaw = atan2(R02, R22), pitch = asin(R12), roll = -atan2(R10, R11), degrees. */
export function eulerFromR(R, out = {}) {
  out.yaw = Math.atan2(R[2], R[8]) * DEG;
  out.pitch = Math.asin(Math.max(-1, Math.min(1, R[5]))) * DEG;
  out.roll = -Math.atan2(R[3], R[4]) * DEG;
  return out;
}

// -- solvePnP ----------------------------------------------------------------------------

/* The model is either an array of { x, y, z, w?, index? } (e.g. CANONICAL) or a flat
 * Float64Array(3N). Object arrays are converted once and cached. */
const modelCache = new WeakMap();
function prepareModel(model) {
  let m = modelCache.get(model);
  if (m) return m;
  if (ArrayBuffer.isView(model)) {
    const n = Math.floor(model.length / 3);
    m = { n, pts: Float64Array.from(model.subarray(0, 3 * n)), w: new Float64Array(n).fill(1), iA: -1, iB: -1, iTop: -1, iNose: -1, vertical: 0 };
  } else {
    const n = model.length;
    const pts = new Float64Array(3 * n), w = new Float64Array(n);
    let iA = -1, iB = -1, iTop = -1, iNose = -1;
    for (let i = 0; i < n; i++) {
      const p = model[i];
      pts[3 * i] = p.x; pts[3 * i + 1] = p.y; pts[3 * i + 2] = p.z;
      w[i] = p.w ?? 1;
      if (p.index === 33) iA = i;
      if (p.index === 263) iB = i;
      if (p.index === 10) iTop = i;
      if (p.index === 1) iNose = i;
    }
    const vertical = iTop >= 0 && iNose >= 0 ? Math.abs(pts[3 * iTop + 1] - pts[3 * iNose + 1]) : 0;
    m = { n, pts, w, iA, iB, iTop, iNose, vertical };
  }
  modelCache.set(model, m);
  return m;
}

// Scratch for the solver (single-threaded, not re-entrant).
const H = new Float64Array(36), A = new Float64Array(36), g = new Float64Array(6), d = new Float64Array(6);
const dR = new Float64Array(9), Rn = new Float64Array(9), tn = new Float64Array(3);
const Rtry = new Float64Array(9);
const Ju = new Float64Array(6), Jv = new Float64Array(6);

/* In-place Cholesky solve of A·x = b (6x6). Returns false if A is not positive definite. */
function cholSolve6(M, b, x) {
  for (let j = 0; j < 6; j++) {
    let s = M[7 * j];
    for (let k = 0; k < j; k++) s -= M[6 * j + k] * M[6 * j + k];
    if (!(s > 0)) return false;
    const ljj = Math.sqrt(s);
    M[7 * j] = ljj;
    for (let i = j + 1; i < 6; i++) {
      let q = M[6 * i + j];
      for (let k = 0; k < j; k++) q -= M[6 * i + k] * M[6 * j + k];
      M[6 * i + j] = q / ljj;
    }
  }
  for (let i = 0; i < 6; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= M[6 * i + k] * x[k];
    x[i] = s / M[7 * i];
  }
  for (let i = 5; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < 6; k++) s -= M[6 * k + i] * x[k];
    x[i] = s / M[7 * i];
  }
  return true;
}

/* Robust (Huber) weighted cost; Infinity if any point is behind the camera. */
function robustCost(uv, m, w, intr, R, t, k) {
  const { pts, n } = m, f = intr.f, cx = intr.cx, cy = intr.cy;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const X = pts[3 * i], Y = pts[3 * i + 1], Z = pts[3 * i + 2];
    const pz = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (!(pz > 1e-6)) return Infinity;
    const iz = 1 / pz;
    const ru = f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) * iz + cx - uv[2 * i];
    const rv = f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) * iz + cy - uv[2 * i + 1];
    const e = Math.sqrt(ru * ru + rv * rv);
    c += w[i] * (e <= k ? e * e : 2 * k * e - k * k);
  }
  return Number.isFinite(c) ? c : Infinity;
}

/* Weighted (prior weights, no Huber) RMS reprojection error in px. */
function weightedRms(uv, m, w, intr, R, t) {
  const { pts, n } = m, f = intr.f, cx = intr.cx, cy = intr.cy;
  let s = 0, sw = 0;
  for (let i = 0; i < n; i++) {
    const X = pts[3 * i], Y = pts[3 * i + 1], Z = pts[3 * i + 2];
    const iz = 1 / (R[6] * X + R[7] * Y + R[8] * Z + t[2]);
    const ru = f * (R[0] * X + R[1] * Y + R[2] * Z + t[0]) * iz + cx - uv[2 * i];
    const rv = f * (R[3] * X + R[4] * Y + R[5] * Z + t[1]) * iz + cy - uv[2 * i + 1];
    s += w[i] * (ru * ru + rv * rv);
    sw += w[i];
  }
  return sw > 0 ? Math.sqrt(s / sw) : NaN;
}

/* One LM run from (R0, t0). R, t are written in place. Returns { cost, iterations }. */
function levenbergMarquardt(uv, m, w, intr, R, t, k, maxIterations) {
  const { pts, n } = m, f = intr.f, cx = intr.cx, cy = intr.cy;
  let lambda = 1e-3;
  let cost = robustCost(uv, m, w, intr, R, t, k);
  let iterations = 0;
  if (!Number.isFinite(cost)) return { cost, iterations };
  while (iterations < maxIterations) {
    H.fill(0); g.fill(0);
    for (let i = 0; i < n; i++) {
      const X = pts[3 * i], Y = pts[3 * i + 1], Z = pts[3 * i + 2];
      const qx = R[0] * X + R[1] * Y + R[2] * Z;
      const qy = R[3] * X + R[4] * Y + R[5] * Z;
      const qz = R[6] * X + R[7] * Y + R[8] * Z;
      const px = qx + t[0], py = qy + t[1], pz = qz + t[2];
      const iz = 1 / pz;
      const ru = f * px * iz + cx - uv[2 * i];
      const rv = f * py * iz + cy - uv[2 * i + 1];
      const e = Math.sqrt(ru * ru + rv * rv);
      const wi = w[i] * (e <= k ? 1 : k / e);  // IRLS Huber weight
      // du/dP = [f·iz, 0, -f·px·iz²], dv/dP = [0, f·iz, -f·py·iz²]
      const a0 = f * iz, a2 = -f * px * iz * iz, b2 = -f * py * iz * iz;
      // dP/dδω = -[Q]x = [[0, qz, -qy], [-qz, 0, qx], [qy, -qx, 0]]; dP/dδt = I
      const u0 = a2 * qy, u1 = a0 * qz - a2 * qx, u2 = -a0 * qy;  // du/dδω
      const v0 = -a0 * qz + b2 * qy, v1 = -b2 * qx, v2 = a0 * qx; // dv/dδω
      Ju[0] = u0; Ju[1] = u1; Ju[2] = u2; Ju[3] = a0; Ju[4] = 0; Ju[5] = a2;
      Jv[0] = v0; Jv[1] = v1; Jv[2] = v2; Jv[3] = 0; Jv[4] = a0; Jv[5] = b2;
      for (let r = 0; r < 6; r++) {
        const jur = wi * Ju[r], jvr = wi * Jv[r];
        g[r] += jur * ru + jvr * rv;
        for (let c = r; c < 6; c++) H[6 * r + c] += jur * Ju[c] + jvr * Jv[c];
      }
    }
    for (let r = 1; r < 6; r++) for (let c = 0; c < r; c++) H[6 * r + c] = H[6 * c + r];

    let accepted = false, converged = false;
    for (let tries = 0; tries < 6; tries++) {
      A.set(H);
      for (let r = 0; r < 6; r++) A[7 * r] += lambda * (H[7 * r] + 1e-9);
      for (let r = 0; r < 6; r++) g[r] = -g[r];
      const solved = cholSolve6(A, g, d);
      for (let r = 0; r < 6; r++) g[r] = -g[r];
      if (!solved) { lambda *= 10; continue; }
      multiply3(expSO3(d[0], d[1], d[2], dR), R, Rn);  // left perturbation
      tn[0] = t[0] + d[3]; tn[1] = t[1] + d[4]; tn[2] = t[2] + d[5];
      const next = robustCost(uv, m, w, intr, Rn, tn, k);
      if (next <= cost) {
        R.set(Rn); t[0] = tn[0]; t[1] = tn[1]; t[2] = tn[2];
        lambda = Math.max(lambda / 10, 1e-7);
        const stepRot = Math.hypot(d[0], d[1], d[2]), stepT = Math.hypot(d[3], d[4], d[5]);
        converged = (stepRot < 1e-6 && stepT < 1e-4) || cost - next < 1e-10 * cost;
        cost = next;
        accepted = true;
        break;
      }
      lambda *= 10;
    }
    if (!accepted) break;
    iterations += 1;
    if (converged) break;
  }
  orthonormalize(R);
  return { cost: robustCost(uv, m, w, intr, R, t, k), iterations };
}

/* Image-space scale for normalising the RMS: the outer eye-corner distance when the
 * model has 33/263, else the RMS spread of the points. */
function imageScale(uv, m) {
  if (m.iA >= 0 && m.iB >= 0) {
    return Math.hypot(uv[2 * m.iB] - uv[2 * m.iA], uv[2 * m.iB + 1] - uv[2 * m.iA + 1]);
  }
  let mu = 0, mv = 0;
  for (let i = 0; i < m.n; i++) { mu += uv[2 * i]; mv += uv[2 * i + 1]; }
  mu /= m.n; mv /= m.n;
  let s = 0;
  for (let i = 0; i < m.n; i++) s += (uv[2 * i] - mu) ** 2 + (uv[2 * i + 1] - mv) ** 2;
  return Math.sqrt(s / m.n);
}

/* Cold translation: depth from the outer eye-corner distance, x/y from their midpoint
 * (falls back to point spread when the model has no 33/263). Yaw foreshortens the eye
 * baseline and overestimates the depth (6x at 80°), so the forehead-to-nose-tip baseline,
 * which yaw leaves alone, caps it. */
function coldTranslation(uv, m, intr, t) {
  const f = intr.f;
  if (m.iA >= 0 && m.iB >= 0) {
    const ua = uv[2 * m.iA], va = uv[2 * m.iA + 1], ub = uv[2 * m.iB], vb = uv[2 * m.iB + 1];
    let z = f * OUTER_EYE_CM / Math.hypot(ub - ua, vb - va);
    if (m.iTop >= 0 && m.iNose >= 0) {
      const lv = Math.hypot(uv[2 * m.iTop] - uv[2 * m.iNose], uv[2 * m.iTop + 1] - uv[2 * m.iNose + 1]);
      const zv = f * m.vertical / lv;
      if (zv > 0 && zv < z) z = zv;
    }
    t[0] = (0.5 * (ua + ub) - intr.cx) * z / f;
    t[1] = (0.5 * (va + vb) - intr.cy) * z / f;
    t[2] = z;
    return t;
  }
  let mx = 0, my = 0, mz = 0, mu = 0, mv = 0;
  for (let i = 0; i < m.n; i++) {
    mx += m.pts[3 * i]; my += m.pts[3 * i + 1]; mz += m.pts[3 * i + 2]; mu += uv[2 * i]; mv += uv[2 * i + 1];
  }
  mx /= m.n; my /= m.n; mz /= m.n; mu /= m.n; mv /= m.n;
  let sm = 0;
  for (let i = 0; i < m.n; i++) sm += (m.pts[3 * i] - mx) ** 2 + (m.pts[3 * i + 1] - my) ** 2;
  const z = f * Math.sqrt(sm / m.n) / imageScale(uv, m);
  t[0] = (mu - intr.cx) * z / f - mx;
  t[1] = (mv - intr.cy) * z / f - my;
  t[2] = z - mz;
  return t;
}

function allInFront(m, R, t) {
  const { pts, n } = m;
  for (let i = 0; i < n; i++) {
    if (!(R[6] * pts[3 * i] + R[7] * pts[3 * i + 1] + R[8] * pts[3 * i + 2] + t[2] > 0)) return false;
  }
  return true;
}

/* Solve for (R, t) such that the model projects onto uv.
 *   uv:    Float64Array(2N) pixel observations, same order as the model
 *   model: CANONICAL-like array or Float64Array(3N)
 *   intr:  { f, cx, cy }
 *   init:  { R, t } to warm-start, or null for a cold start (R = I, t from eye corners;
 *          if that fails the RMS check, also tries Ry(±40°) and keeps the lowest cost)
 *   opts:  { weights?, huberK?, maxIterations?, scale?, rmsGate = 0.06, retryYawDeg = 40 }
 * Returns { R, t, cost, rms (px, weighted), iterations, ok }. */
export function solvePnP(uv, model, intr, init = null, opts = {}) {
  const m = prepareModel(model);
  const w = opts.weights || m.w;
  const scale = opts.scale > 0 ? opts.scale : imageScale(uv, m);
  const k = opts.huberK > 0 ? opts.huberK : Math.max(1.5, 0.015 * (Number.isFinite(scale) ? scale : 0));
  const cold = !init;
  const maxIterations = opts.maxIterations ?? (cold ? 30 : 10);
  const rmsGate = opts.rmsGate ?? 0.06;

  const run = (R0, t0) => {
    const R = Float64Array.from(R0), t = [t0[0], t0[1], t0[2]];
    const { cost, iterations } = levenbergMarquardt(uv, m, w, intr, R, t, k, maxIterations);
    const ok = Number.isFinite(cost) && allFinite(R) && allFinite(t) && allInFront(m, R, t);
    const rms = ok ? weightedRms(uv, m, w, intr, R, t) : NaN;
    return { R, t, cost: ok ? cost : Infinity, rms, iterations, ok };
  };

  if (!cold) return run(init.R, init.t);

  const t0 = coldTranslation(uv, m, intr, [0, 0, 0]);
  if (!allFinite(t0) || !(t0[2] > 0)) {
    return { R: identity3(), t: t0, cost: Infinity, rms: NaN, iterations: 0, ok: false };
  }
  let best = run(identity3(Rtry), t0);
  if (best.ok && best.rms / scale <= rmsGate) return best;
  const yaw = (opts.retryYawDeg ?? 40) * RAD;
  for (const sign of [1, -1]) {
    const r = run(rotationY(sign * yaw, Rtry), t0);
    if (r.ok && (!best.ok || r.cost < best.cost)) best = r;
  }
  return best;
}

// -- screen-relative orientation --------------------------------------------------------

/* Approximate cervical pivot in the head frame: 8 cm down, 9 cm into the head. */
export const DEFAULT_PIVOT = Object.freeze([0, 8, 9]);

/* Pivot in camera coordinates: t + R·p. */
export function pivotPoint(R, t, pivot = DEFAULT_PIVOT, out = [0, 0, 0]) {
  const px = pivot[0], py = pivot[1], pz = pivot[2];
  out[0] = t[0] + R[0] * px + R[1] * py + R[2] * pz;
  out[1] = t[1] + R[3] * px + R[4] * py + R[5] * pz;
  out[2] = t[2] + R[6] * px + R[7] * py + R[8] * pz;
  return out;
}

const Rref = new Float64Array(9), Rrel = new Float64Array(9), Ra = new Float64Array(9), Rb = new Float64Array(9);

/* Head orientation relative to the ray from the head pivot to the screen centre
 * S = (0, +screenOffsetCm, 0) (camera above the screen => S below it, +y down).
 * Pass `pivotCam` (camera coords) to use a pre-smoothed pivot instead of t + R·pivot.
 * Returns { yaw, pitch, roll, pivot: [x, y, z] } where pivot is the one used. */
export function screenRelative(R, t, { pivot = DEFAULT_PIVOT, screenOffsetCm = 12, pivotCam = null } = {}) {
  const pv = pivotCam ? [pivotCam[0], pivotCam[1], pivotCam[2]] : pivotPoint(R, t, pivot);
  let nx = -pv[0], ny = screenOffsetCm - pv[1], nz = -pv[2];
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-9) { nx /= len; ny /= len; nz /= len; } else { nx = 0; ny = 0; nz = -1; }
  // R_ref = Ry(a)·Rx(b): the orientation of a head whose forward (-R[:,2]) is n.
  const a = Math.atan2(-nx, -nz), b = Math.asin(Math.max(-1, Math.min(1, ny)));
  multiply3(rotationY(a, Ra), rotationX(b, Rb), Rref);
  multiplyT3(Rref, R, Rrel);
  const e = eulerFromR(Rrel);
  return { yaw: e.yaw, pitch: e.pitch, roll: e.roll, pivot: pv };
}

// -- HeadPoseEstimator ------------------------------------------------------------------

export const POSE_DEFAULTS = Object.freeze({
  dfov: 78,                 // assumed diagonal FOV of the webcam, degrees
  pivot: DEFAULT_PIVOT,     // head-frame pivot, cm
  screenOffsetCm: 12,       // screen centre below the camera (+) / above it (-)
  pivotTau: 0.3,            // s, smoothing time constant of the camera-frame pivot at rest...
  pivotBeta: 0.1,           // ...shortened with pivot speed (One Euro, per cm/s) so a sway does not lag
  rmsGate: 0.06,            // absolute e_n limit
  rmsRelative: 3,           // e_n limit relative to the running median...
  rmsWindow: 2,             // ...over this many seconds
  rmsFloor: 0.015,          // relative limit never below this (synthetic-clean data has e_n ≈ 0)
  rmsMinSamples: 5,         // relative test only once the median has this many samples
  jumpDeg: 25,              // one-frame change that is held as a suspected outlier
  jumpConfirmDeg: 8,        // next frame within this of the suspect => accept it
  jumpStaleSec: 0.25,       // last good frame older than this => no jump test
  farSideEnter: 25,         // |camera yaw| beyond which the far-side points are down-weighted
  farSideExit: 22,
  farSideX: 5,              // |x| (cm) of the lateral points that count as far side
  farSideWeight: 0.2,
  edge: 0.02,               // normalised in-frame margin for eye corners and nose tip
  minDistCm: 20,
  maxDistCm: 200,
  coldJumpCm: 15,           // warm solution moving t by more than this => cold re-solve
  warmIterations: 10,
  coldIterations: 30,
});

const GATE_POINTS = [33, 133, 362, 263, 1];
const N_POINTS = CANONICAL.length;
const K33 = CANONICAL.findIndex((p) => p.index === 33);
const K263 = CANONICAL.findIndex((p) => p.index === 263);

export class HeadPoseEstimator {
  constructor(opts = {}) {
    this.opts = { ...POSE_DEFAULTS };
    this.configure(opts);
    this.uv = new Float64Array(2 * N_POINTS);
    this.wBase = Float64Array.from(CANONICAL, (p) => p.w);
    this.wFar = [this.wBase, new Float64Array(N_POINTS), new Float64Array(N_POINTS)];  // 0 none, 1 yaw>0, 2 yaw<0
    this.intr = { f: 1, cx: 0, cy: 0 };
    this.solveOpts = { weights: null, scale: 1, maxIterations: 10, rmsGate: this.opts.rmsGate };
    this.buildFarWeights();
    this.reset();
  }

  configure(partial = {}) {
    for (const key of Object.keys(partial)) {
      if (key in POSE_DEFAULTS && partial[key] !== undefined) this.opts[key] = partial[key];
    }
    if (this.wFar) this.buildFarWeights();
    if (this.rmsMedian) this.rmsMedian.windowSec = this.opts.rmsWindow;
  }

  buildFarWeights() {
    const { farSideX, farSideWeight } = this.opts;
    for (let i = 0; i < N_POINTS; i++) {
      const p = CANONICAL[i];
      // yaw > 0 (user's right) turns the subject's right side (x < 0) away from the camera.
      this.wFar[1][i] = p.x < -farSideX ? Math.min(p.w, farSideWeight) : p.w;
      this.wFar[2][i] = p.x > farSideX ? Math.min(p.w, farSideWeight) : p.w;
    }
  }

  reset() {
    this.R = null;            // warm-start state: last solver-ok pose (camera frame)
    this.t = null;
    this.cold = true;
    this.side = 0;            // far-side weighting in use (0 none, 1, 2)
    this.rmsFails = 0;
    this.rmsMedian = new TimedMedian(this.opts.rmsWindow);
    this.pivot = [0, 0, 0];   // smoothed camera-frame pivot
    this.pivotV = [0, 0, 0];  // its smoothed velocity, cm/s
    this.pivotT = NaN;
    this.pivotInit = false;
    this.reacquired = true;
    this.good = null;         // last accepted { yaw, pitch, roll, dist, rms }
    this.goodT = NaN;
    this.suspect = null;      // jump candidate { yaw, pitch }
    this.lastRms = 0;
  }

  /* Face lost: next sighting is a re-acquisition (cold start, fresh pivot, no jump test). */
  lose() {
    this.cold = true;
    this.pivotInit = false;
    this.reacquired = true;
    this.suspect = null;
    this.rmsFails = 0;
    this.side = 0;
  }

  fail(reason, inFrame) {
    const g = this.good;
    return {
      ok: false, reason,
      yaw: g ? g.yaw : 0, pitch: g ? g.pitch : 0, roll: g ? g.roll : 0,
      dist: g ? g.dist : 0, rms: this.lastRms, inFrame,
    };
  }

  sideFor(yawCam) {
    const { farSideEnter, farSideExit } = this.opts;
    const limit = this.side === 0 ? farSideEnter : farSideExit;
    if (yawCam > limit) return 1;
    if (yawCam < -limit) return 2;
    return 0;
  }

  solve(init, weights, maxIterations) {
    this.solveOpts.weights = weights;
    this.solveOpts.maxIterations = maxIterations;
    return solvePnP(this.uv, CANONICAL, this.intr, init, this.solveOpts);
  }

  /* lm: Float32Array(478·3) normalised landmarks (or null when no face); tSec: seconds. */
  estimate(lm, width, height, tSec) {
    const o = this.opts;
    if (!lm || !(width > 0) || !(height > 0)) { this.lose(); return this.fail("no-face", false); }

    for (const i of GATE_POINTS) {
      const x = lm[3 * i], y = lm[3 * i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { this.lose(); return this.fail("no-face", false); }
      if (x < o.edge || x > 1 - o.edge || y < o.edge || y > 1 - o.edge) {
        this.lose();
        return this.fail("out-of-frame", false);
      }
    }
    const uv = this.uv;
    for (let k = 0; k < N_POINTS; k++) {
      const i = CANONICAL[k].index;
      uv[2 * k] = lm[3 * i] * width;
      uv[2 * k + 1] = lm[3 * i + 1] * height;
      if (!Number.isFinite(uv[2 * k]) || !Number.isFinite(uv[2 * k + 1])) {
        this.lose();
        return this.fail("no-face", false);
      }
    }
    const dEye = Math.hypot(uv[2 * K263] - uv[2 * K33], uv[2 * K263 + 1] - uv[2 * K33 + 1]);
    if (!(dEye >= 2)) return this.fail("range", true);

    const f = focalFor(width, height, o.dfov);
    this.intr.f = f; this.intr.cx = 0.5 * width; this.intr.cy = 0.5 * height;
    this.solveOpts.scale = dEye;
    this.solveOpts.rmsGate = o.rmsGate;

    // Solve: warm from the last pose, cold on re-acquisition / failure / implausible jump.
    let weights = this.wFar[this.side];
    let sol, usedCold = false;
    const coldSolve = () => { usedCold = true; return this.solve(null, weights, o.coldIterations); };
    const better = (a, b) => (b.ok && (!a.ok || b.cost < a.cost) ? b : a);
    if (this.cold || !this.R) {
      sol = coldSolve();
    } else {
      sol = this.solve({ R: this.R, t: this.t }, weights, o.warmIterations);
      if (!sol.ok || Math.hypot(sol.t[0] - this.t[0], sol.t[1] - this.t[1], sol.t[2] - this.t[2]) > o.coldJumpCm) {
        sol = better(sol, coldSolve());
      }
    }
    if (!sol.ok) { this.cold = true; this.lastRms = 0; return this.fail("bad-fit", true); }

    // Far-side weighting follows the solved camera-frame yaw; refine once if it changed.
    const side = this.sideFor(eulerFromR(sol.R).yaw);
    if (side !== this.side) {
      this.side = side;
      weights = this.wFar[side];
      const refined = this.solve({ R: sol.R, t: sol.t }, weights, o.warmIterations);
      if (refined.ok) sol = refined;
    }

    let en = sol.rms / dEye;
    const tooBad = (e) => {
      const med = this.rmsMedian.prune(tSec);
      if (!(e <= o.rmsGate)) return true;
      return this.rmsMedian.count >= o.rmsMinSamples && e > Math.max(o.rmsRelative * med, o.rmsFloor);
    };
    let bad = tooBad(en);
    if (bad && !usedCold && this.rmsFails >= 1) {
      // Second failure in a row: the warm start may be stuck in a wrong basin.
      const c = coldSolve();
      if (c.ok && c.rms / dEye < en) { sol = c; en = c.rms / dEye; bad = tooBad(en); }
    }
    this.R = sol.R; this.t = sol.t; this.cold = false;
    this.lastRms = en;
    if (en <= o.rmsGate) this.rmsMedian.push(en, tSec);
    if (bad) { this.rmsFails += 1; return this.fail("bad-fit", true); }
    this.rmsFails = 0;

    if (sol.t[2] < o.minDistCm || sol.t[2] > o.maxDistCm) return this.fail("range", true);

    // Pivot smoothing (provisional until the frame is accepted). The pivot is the
    // rotation centre, so head turns barely move it; only translation and solver noise do.
    const raw = pivotPoint(sol.R, sol.t, o.pivot);
    let px = raw[0], py = raw[1], pz = raw[2], vx = 0, vy = 0, vz = 0;
    if (this.pivotInit) {
      const dt = tSec - this.pivotT;
      const p = this.pivot, v = this.pivotV;
      if (dt > 0) {
        const ad = smoothing(1, dt);
        vx = v[0] + ad * ((px - p[0]) / dt - v[0]);
        vy = v[1] + ad * ((py - p[1]) / dt - v[1]);
        vz = v[2] + ad * ((pz - p[2]) / dt - v[2]);
        const a = smoothing(1 / (2 * Math.PI * o.pivotTau) + o.pivotBeta * Math.hypot(vx, vy, vz), dt);
        px = p[0] + a * (px - p[0]); py = p[1] + a * (py - p[1]); pz = p[2] + a * (pz - p[2]);
      } else if (Number.isFinite(dt)) {  // duplicate / out-of-order time: keep the pivot
        px = p[0]; py = p[1]; pz = p[2]; vx = v[0]; vy = v[1]; vz = v[2];
      }
    }
    const rel = screenRelative(sol.R, sol.t, { screenOffsetCm: o.screenOffsetCm, pivotCam: [px, py, pz] });

    // Jump gate on the screen-relative angles.
    const g = this.good;
    if (g && !this.reacquired && tSec - this.goodT <= o.jumpStaleSec) {
      const dy = Math.abs(wrapDegrees(rel.yaw - g.yaw)), dp = Math.abs(rel.pitch - g.pitch);
      if (dy > o.jumpDeg || dp > o.jumpDeg) {
        const s = this.suspect;
        const confirmed = s && Math.abs(wrapDegrees(rel.yaw - s.yaw)) <= o.jumpConfirmDeg
          && Math.abs(rel.pitch - s.pitch) <= o.jumpConfirmDeg;
        if (!confirmed) {
          this.suspect = { yaw: rel.yaw, pitch: rel.pitch };
          return this.fail("jump", true);
        }
      }
    }
    this.suspect = null;

    // Accept.
    this.pivot[0] = px; this.pivot[1] = py; this.pivot[2] = pz;
    this.pivotV[0] = vx; this.pivotV[1] = vy; this.pivotV[2] = vz;
    if (Number.isFinite(tSec) && !(tSec < this.pivotT)) this.pivotT = tSec;
    this.pivotInit = true;
    this.reacquired = false;
    const dist = Math.hypot(raw[0], raw[1], raw[2]);
    this.good = { yaw: rel.yaw, pitch: rel.pitch, roll: rel.roll, dist, rms: en };
    this.goodT = tSec;
    return { ok: true, reason: "ok", yaw: rel.yaw, pitch: rel.pitch, roll: rel.roll, dist, rms: en, inFrame: true };
  }
}
