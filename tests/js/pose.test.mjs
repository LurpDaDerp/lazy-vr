import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL, HeadPoseEstimator, OUTER_EYE_CM, eulerFromR, focalFor, headFromCanonical, multiply3,
  pivotPoint, rotationFromEuler, rotationX, rotationY, rotationZ, screenRelative, solvePnP,
} from "../../site/js/pose.js";

const RAD = Math.PI / 180;
const W = 1280, H = 720;
const F = focalFor(W, H);
const INTR = { f: F, cx: W / 2, cy: H / 2 };

// -- synthetic camera ------------------------------------------------------------------

function rng(seed) {  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

const apply = (R, p, t) => [
  R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
  R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
  R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
];
const project = (P, intr = INTR) => [intr.f * P[0] / P[2] + intr.cx, intr.f * P[1] / P[2] + intr.cy];

function observe(R, t, { noise = 0, rand = rng(1), intr = INTR } = {}) {
  const uv = new Float64Array(2 * CANONICAL.length);
  CANONICAL.forEach((p, i) => {
    const [u, v] = project(apply(R, [p.x, p.y, p.z], t), intr);
    uv[2 * i] = u + noise * gaussian(rand);
    uv[2 * i + 1] = v + noise * gaussian(rand);
  });
  return uv;
}

/* Full landmark array (normalised) for the estimator; unused points sit mid-frame. */
function landmarks(R, t, { noise = 0, rand = rng(1), w = W, h = H } = {}) {
  const intr = { f: focalFor(w, h), cx: w / 2, cy: h / 2 };
  const lm = new Float32Array(478 * 3).fill(0.5);
  for (const p of CANONICAL) {
    const [u, v] = project(apply(R, [p.x, p.y, p.z], t), intr);
    lm[3 * p.index] = (u + noise * gaussian(rand)) / w;
    lm[3 * p.index + 1] = (v + noise * gaussian(rand)) / h;
    lm[3 * p.index + 2] = 0;
  }
  return lm;
}

const angleErr = (e, y, p, r) => Math.max(Math.abs(e.yaw - y), Math.abs(e.pitch - p), Math.abs(e.roll - r));

/* Pose whose head pivot sits at `pivotCam` and that is rotated by (yaw, pitch) away from
 * facing the screen centre S = (0, h, 0). Returns { R, t } for the eye-midpoint origin. */
function poseFacing(pivotCam, yaw, pitch, h = 12, pivot = [0, 8, 9]) {
  const n = [-pivotCam[0], h - pivotCam[1], -pivotCam[2]];
  const len = Math.hypot(...n);
  const a = Math.atan2(-n[0] / len, -n[2] / len), b = Math.asin(n[1] / len);
  const Rref = multiply3(rotationY(a), rotationX(b));
  const R = multiply3(Rref, rotationFromEuler(yaw, pitch, 0));
  const rp = apply(R, pivot, [0, 0, 0]);
  return { R, t: [pivotCam[0] - rp[0], pivotCam[1] - rp[1], pivotCam[2] - rp[2]] };
}

// -- model --------------------------------------------------------------------------------

test("CANONICAL: 29 rigid points in the head frame, matching canonical_face_model.obj", () => {
  assert.equal(CANONICAL.length, 29);
  assert.equal(new Set(CANONICAL.map((p) => p.index)).size, 29);
  const byIndex = Object.fromEntries(CANONICAL.map((p) => [p.index, p]));
  // obj v-line n+1 = landmark n; head frame P = (Xc, -(Yc - 2.624618), -(Zc - 3.465663))
  const check = (i, X, Y, Z, w) => {
    const [x, y, z] = headFromCanonical(X, Y, Z);
    const p = byIndex[i];
    assert.ok(Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9 && Math.abs(p.z - z) < 1e-9, `index ${i}`);
    assert.equal(p.w, w);
  };
  check(1, 0, -1.126865, 7.475604, 1.0);
  check(10, 0, 8.261778, 4.481535, 0.7);
  check(33, -4.445859, 2.663991, 3.173422, 1.0);
  check(263, 4.445859, 2.663991, 3.173422, 1.0);
  check(358, 1.785794, -0.978284, 4.850470, 1.0);
  check(54, -6.279331, 6.615427, 1.425850, 0.7);
  check(372, 6.407571, 2.236021, 1.560843, 0.5);
  // origin is the eye-corner midpoint
  const mid = [33, 133, 362, 263].map((i) => byIndex[i]);
  for (const axis of ["x", "y", "z"]) {
    assert.ok(Math.abs(mid.reduce((s, p) => s + p[axis], 0) / 4) < 1e-6, axis);
  }
  // nose tip points toward the camera (-z), forehead up (-y), subject's left eye at +x
  assert.ok(byIndex[1].z < -3 && byIndex[10].y < -5 && byIndex[263].x > 0);
  assert.ok(Math.abs(Math.hypot(byIndex[263].x - byIndex[33].x) - OUTER_EYE_CM) < 1e-9);
  // mirror pairs are symmetric
  for (const [a, b] of [[33, 263], [133, 362], [98, 327], [129, 358], [109, 338], [67, 297], [54, 284], [116, 345], [123, 352], [143, 372]]) {
    assert.equal(byIndex[a].x, -byIndex[b].x);
    assert.equal(byIndex[a].y, byIndex[b].y);
    assert.equal(byIndex[a].z, byIndex[b].z);
  }
});

test("focalFor: 0.5·hypot/tan(dfov/2)", () => {
  assert.ok(Math.abs(focalFor(1280, 720) - 906.79) < 0.01);
  assert.ok(Math.abs(focalFor(640, 360) - 453.39) < 0.01);
  assert.ok(Math.abs(focalFor(640, 480, 90) - 400) < 1e-9);
});

test("eulerFromR inverts rotationFromEuler (R = Ry(yaw)·Rx(-pitch)·Rz(-roll))", () => {
  for (const [y, p, r] of [[0, 0, 0], [30, 0, 0], [0, -20, 0], [0, 0, 15], [-55, 25, -10], [70, -30, 8]]) {
    const e = eulerFromR(rotationFromEuler(y, p, r));
    assert.ok(angleErr(e, y, p, r) < 1e-9, `${y},${p},${r}`);
  }
});

// -- signs, from the physical picture -------------------------------------------------------

test("signs: head turned to the user's right => yaw > 0; up => pitch > 0; right-shoulder tilt => roll > 0", () => {
  const t = [5, -3, 60];
  const nose = CANONICAL.find((p) => p.index === 1);
  const top = CANONICAL.find((p) => p.index === 10);
  const img = (R, p) => project(apply(R, [p.x, p.y, p.z], t));
  const I = rotationFromEuler(0, 0, 0);

  // The camera faces the user, unmirrored: the user's right is the image LEFT.
  // Turning right about the vertical axis swings the nose toward the user's right.
  const right = rotationY(20 * RAD);
  assert.ok(img(right, nose)[0] < img(I, nose)[0] - 10, "nose moves to the image left");
  const sRight = solvePnP(observe(right, t), CANONICAL, INTR, null);
  assert.ok(eulerFromR(sRight.R).yaw > 19.99);

  // Looking up lifts the nose in the image (v decreases).
  const up = rotationX(-15 * RAD);
  assert.ok(img(up, nose)[1] < img(I, nose)[1] - 10, "nose moves up");
  const sUp = solvePnP(observe(up, t), CANONICAL, INTR, null);
  assert.ok(eulerFromR(sUp.R).pitch > 14.99);

  // Tilting toward the right shoulder moves the top of the head toward the user's right (image left).
  const tilt = rotationZ(-10 * RAD);
  assert.ok(img(tilt, top)[0] < img(I, top)[0] - 10, "forehead moves to the image left");
  const sTilt = solvePnP(observe(tilt, t), CANONICAL, INTR, null);
  assert.ok(eulerFromR(sTilt.R).roll > 9.99);
});

// -- solver ---------------------------------------------------------------------------------

test("solvePnP cold start recovers exact poses across yaw -60..70, pitch ±30", () => {
  let worstIt = 0;
  for (let yaw = -60; yaw <= 70; yaw += 10) {
    for (const pitch of [-30, -15, 0, 15, 30]) {
      for (const [roll, t] of [[0, [5, -3, 60]], [8, [-20, 10, 45]], [-6, [15, 5, 95]]]) {
        const R = rotationFromEuler(yaw, pitch, roll);
        const s = solvePnP(observe(R, t), CANONICAL, INTR, null);
        assert.ok(s.ok, `ok ${yaw},${pitch}`);
        const e = eulerFromR(s.R);
        assert.ok(angleErr(e, yaw, pitch, roll) < 1e-4, `${yaw},${pitch},${roll}: ${JSON.stringify(e)}`);
        assert.ok(Math.hypot(s.t[0] - t[0], s.t[1] - t[1], s.t[2] - t[2]) < 1e-3);
        assert.ok(s.rms < 1e-4);
        worstIt = Math.max(worstIt, s.iterations);
      }
    }
  }
  assert.ok(worstIt <= 30);
});

test("solvePnP with 0.5 px noise stays within tight tolerance", () => {
  const rand = rng(7);
  let sum = 0, n = 0, worst = 0;
  for (let yaw = -60; yaw <= 70; yaw += 10) {
    for (const pitch of [-30, -15, 0, 15, 30]) {
      for (let k = 0; k < 4; k++) {
        const R = rotationFromEuler(yaw, pitch, 3);
        const s = solvePnP(observe(R, [4, -2, 60], { noise: 0.5, rand }), CANONICAL, INTR, null);
        const e = eulerFromR(s.R);
        const err = Math.max(Math.abs(e.yaw - yaw), Math.abs(e.pitch - pitch));
        sum += err; n += 1; worst = Math.max(worst, err);
      }
    }
  }
  assert.ok(sum / n < 0.5, `mean ${sum / n}`);
  assert.ok(worst < 2, `worst ${worst}`);
});

test("solvePnP warm start converges in a few iterations; result rotation is orthonormal", () => {
  const t = [3, 2, 65];
  const R1 = rotationFromEuler(12, -7, 2);
  const s1 = solvePnP(observe(R1, t), CANONICAL, INTR, null);
  const R2 = rotationFromEuler(15, -5, 2);
  const obs2 = observe(R2, [3.5, 2, 64]);
  const warm = solvePnP(obs2, CANONICAL, INTR, { R: s1.R, t: s1.t });
  const cold = solvePnP(obs2, CANONICAL, INTR, null);
  assert.ok(warm.ok && warm.iterations <= 10);
  assert.ok(warm.iterations <= cold.iterations);
  assert.ok(angleErr(eulerFromR(warm.R), 15, -5, 2) < 1e-4);
  // the init is not mutated
  assert.ok(angleErr(eulerFromR(s1.R), 12, -7, 2) < 1e-4);
  const R = warm.R;
  const RRt = multiply3(R, Float64Array.from([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]));
  for (let i = 0; i < 9; i++) assert.ok(Math.abs(RRt[i] - (i % 4 === 0 ? 1 : 0)) < 1e-12);
});

test("solvePnP: Ry(±40°) retries keep the lowest-cost answer", () => {
  // rmsGate -1 forces both retries; the right answer must still win.
  for (const yaw of [-55, 0, 65]) {
    const R = rotationFromEuler(yaw, 10, 0);
    const s = solvePnP(observe(R, [0, 0, 70]), CANONICAL, INTR, null, { rmsGate: -1 });
    assert.ok(s.ok && angleErr(eulerFromR(s.R), yaw, 10, 0) < 1e-4, `yaw ${yaw}`);
  }
});

test("solvePnP: degenerate input fails cleanly", () => {
  const uv = new Float64Array(58).fill(100);   // every point at one pixel
  const s = solvePnP(uv, CANONICAL, INTR, null);
  assert.equal(s.ok, false);
  const nan = new Float64Array(58).fill(NaN);
  assert.equal(solvePnP(nan, CANONICAL, INTR, null).ok, false);
  const R = rotationFromEuler(0, 0, 0);
  assert.equal(solvePnP(nan, CANONICAL, INTR, { R, t: [0, 0, 60] }).ok, false);
});

test("solvePnP accepts a flat Float64Array model", () => {
  const flat = Float64Array.from(CANONICAL.flatMap((p) => [p.x, p.y, p.z]));
  const R = rotationFromEuler(25, -10, 4);
  const s = solvePnP(observe(R, [2, 1, 55]), flat, INTR, null);
  assert.ok(s.ok && angleErr(eulerFromR(s.R), 25, -10, 4) < 1e-4);
});

test("Huber IRLS limits the damage of a single wild landmark", () => {
  const R = rotationFromEuler(10, 5, 0), t = [0, 0, 60];
  const uv = observe(R, t, { noise: 0.3, rand: rng(3) });
  const k = CANONICAL.findIndex((p) => p.index === 10);
  uv[2 * k] += 40; uv[2 * k + 1] -= 30;
  const robust = eulerFromR(solvePnP(uv, CANONICAL, INTR, null).R);
  const plain = eulerFromR(solvePnP(uv, CANONICAL, INTR, null, { huberK: 1e9 }).R);
  const err = (e) => Math.hypot(e.yaw - 10, e.pitch - 5);
  assert.ok(err(robust) < err(plain), `${err(robust)} vs ${err(plain)}`);
});

// -- screen-relative ---------------------------------------------------------------------------

test("screenRelative: facing the screen centre reads 0 wherever the head is", () => {
  for (const pivotCam of [[0, 10, 65], [25, 10, 65], [-25, 10, 65], [0, -5, 60], [0, 25, 60], [18, 20, 45], [-20, -4, 90]]) {
    for (const [yaw, pitch] of [[0, 0], [20, 0], [-30, 0], [0, 15], [0, -20], [25, 10]]) {
      const { R, t } = poseFacing(pivotCam, yaw, pitch);
      const s = solvePnP(observe(R, t), CANONICAL, INTR, null);
      const rel = screenRelative(s.R, s.t);
      assert.ok(Math.abs(rel.yaw - yaw) < 1e-4 && Math.abs(rel.pitch - pitch) < 1e-4,
        `${pivotCam} (${yaw},${pitch}) -> (${rel.yaw},${rel.pitch})`);
      const pv = pivotPoint(s.R, s.t);
      assert.ok(Math.hypot(pv[0] - pivotCam[0], pv[1] - pivotCam[1], pv[2] - pivotCam[2]) < 1e-3);
      assert.deepEqual(rel.pivot.map((v) => v.toFixed(6)), pv.map((v) => v.toFixed(6)));
    }
  }
});

test("screenRelative removes the bearing of an off-centre head (raw camera yaw does not)", () => {
  const { R, t } = poseFacing([20, 10, 60], 0, 0);
  const raw = eulerFromR(R);
  assert.ok(Math.abs(raw.yaw) > 15, `raw ${raw.yaw}`);
  assert.ok(Math.abs(screenRelative(R, t).yaw) < 1e-9);
});

test("screenRelative honours screenOffsetCm and an explicit pivotCam", () => {
  const { R, t } = poseFacing([0, 10, 60], 0, 0, -10);  // camera below the screen
  assert.ok(Math.abs(screenRelative(R, t, { screenOffsetCm: -10 }).pitch) < 1e-9);
  assert.ok(screenRelative(R, t, { screenOffsetCm: 12 }).pitch > 15);
  const pv = pivotPoint(R, t);
  const viaPivot = screenRelative(R, [999, 999, 999], { screenOffsetCm: -10, pivotCam: pv });
  assert.ok(Math.abs(viaPivot.yaw) < 1e-9 && Math.abs(viaPivot.pitch) < 1e-9);
});

// -- HeadPoseEstimator -----------------------------------------------------------------------

const FRAME = 1 / 30;

test("estimator: cold start, then warm frames; signs on the output", () => {
  const est = new HeadPoseEstimator();
  const a = est.estimate(landmarks(...Object.values(poseFacing([0, 10, 65], 0, 0))), W, H, 0);
  assert.equal(a.ok, true);
  assert.equal(a.reason, "ok");
  assert.ok(Math.abs(a.yaw) < 1e-3 && Math.abs(a.pitch) < 1e-3);
  assert.ok(Math.abs(a.dist - 65.8) < 0.5, `dist ${a.dist}`);
  assert.equal(est.cold, false);
  const right = est.estimate(landmarks(...Object.values(poseFacing([0, 10, 65], 10, 0))), W, H, FRAME);
  assert.ok(right.ok && Math.abs(right.yaw - 10) < 1e-3, `${right.yaw}`);
  const up = est.estimate(landmarks(...Object.values(poseFacing([0, 10, 65], 10, 12))), W, H, 2 * FRAME);
  assert.ok(up.ok && Math.abs(up.pitch - 12) < 1e-3, `${up.pitch}`);
  assert.ok(up.rms < 1e-3);
});

test("estimator: sliding sideways and up/down while facing the screen centre reads ~0", () => {
  const est = new HeadPoseEstimator();
  const rand = rng(11);
  let worst = 0;
  for (let i = 0; i < 300; i++) {  // 10 s: 25 cm lateral and 12 cm vertical sway, slow
    const s = i * FRAME;
    const pivotCam = [25 * Math.sin(2 * Math.PI * s / 5), 10 + 12 * Math.sin(2 * Math.PI * s / 7), 65 + 10 * Math.sin(2 * Math.PI * s / 9)];
    const { R, t } = poseFacing(pivotCam, 0, 0);
    const r = est.estimate(landmarks(R, t, { noise: 0.3, rand }), W, H, s);
    assert.ok(r.ok, `${i} ${r.reason}`);
    if (i > 30) worst = Math.max(worst, Math.abs(r.yaw), Math.abs(r.pitch));
  }
  assert.ok(worst < 1.5, `worst ${worst}`);
});

test("estimator: lateral position does not leak into a real head turn", () => {
  for (const x of [-20, 0, 20]) {
    const est = new HeadPoseEstimator();
    const { R, t } = poseFacing([x, 10, 60], 20, -8);
    const r = est.estimate(landmarks(R, t), W, H, 0);
    assert.ok(r.ok && Math.abs(r.yaw - 20) < 1e-3 && Math.abs(r.pitch + 8) < 1e-3, `${x}: ${r.yaw},${r.pitch}`);
  }
});

test("estimator: no-face and out-of-frame hold the last good angles and force a cold restart", () => {
  const est = new HeadPoseEstimator();
  const good = est.estimate(landmarks(...Object.values(poseFacing([0, 10, 65], 15, 5))), W, H, 0);
  assert.ok(good.ok);
  const none = est.estimate(null, W, H, FRAME);
  assert.deepEqual([none.ok, none.reason, none.inFrame], [false, "no-face", false]);
  assert.ok(Math.abs(none.yaw - 15) < 1e-3 && Math.abs(none.pitch - 5) < 1e-3);
  assert.equal(est.cold, true);

  const lm = landmarks(...Object.values(poseFacing([0, 10, 65], 15, 5)));
  lm[3 * 263] = 0.99;
  const out = est.estimate(lm, W, H, 2 * FRAME);
  assert.deepEqual([out.ok, out.reason, out.inFrame], [false, "out-of-frame", false]);
  lm[3 * 263] = 0.5; lm[3 * 1 + 1] = 0.01;
  assert.equal(est.estimate(lm, W, H, 3 * FRAME).reason, "out-of-frame");
  lm[3 * 1 + 1] = NaN;
  assert.equal(est.estimate(lm, W, H, 4 * FRAME).reason, "no-face");
  assert.equal(est.estimate(lm, 0, H, 5 * FRAME).reason, "no-face");

  // re-acquired far away from the last pose: cold start finds it (no jump test after a loss)
  const back = est.estimate(landmarks(...Object.values(poseFacing([0, 10, 65], -40, 0))), W, H, 6 * FRAME);
  assert.ok(back.ok && Math.abs(back.yaw + 40) < 1e-3, `${back.reason} ${back.yaw}`);
});

test("estimator: never-seen face reports zeros", () => {
  const r = new HeadPoseEstimator().estimate(null, W, H, 0);
  assert.deepEqual([r.ok, r.yaw, r.pitch, r.roll, r.dist], [false, 0, 0, 0, 0]);
});

test("estimator: a one-frame jump is held; a confirmed one is accepted", () => {
  const est = new HeadPoseEstimator();
  const at = (yaw) => landmarks(...Object.values(poseFacing([0, 10, 65], yaw, 0)));
  let s = 0;
  for (let i = 0; i < 5; i++) assert.ok(est.estimate(at(0), W, H, (s += FRAME)).ok);
  const spike = est.estimate(at(40), W, H, (s += FRAME));
  assert.deepEqual([spike.ok, spike.reason], [false, "jump"]);
  assert.ok(Math.abs(spike.yaw) < 1e-3, "previous value held");
  const back = est.estimate(at(1), W, H, (s += FRAME));
  assert.ok(back.ok && Math.abs(back.yaw - 1) < 1e-3, "spike rejected, normal frame accepted");

  assert.equal(est.estimate(at(35), W, H, (s += FRAME)).reason, "jump");
  const confirm = est.estimate(at(38), W, H, (s += FRAME));
  assert.ok(confirm.ok && Math.abs(confirm.yaw - 38) < 1e-3, "within 8° of the suspect => accepted");

  // a suspect that is not confirmed is replaced by the next suspect
  assert.equal(est.estimate(at(-5), W, H, (s += FRAME)).reason, "jump");
  assert.equal(est.estimate(at(10), W, H, (s += FRAME)).reason, "jump");
  assert.ok(est.estimate(at(12), W, H, (s += FRAME)).ok);

  // after a long gap there is nothing to compare against
  assert.ok(est.estimate(at(-30), W, H, (s += 1)).ok);
});

test("estimator: bad fit (absolute and relative RMS gates)", () => {
  const est = new HeadPoseEstimator();
  const rand = rng(5);
  const { R, t } = poseFacing([0, 10, 65], 5, 0);
  let s = 0;
  for (let i = 0; i < 40; i++) assert.ok(est.estimate(landmarks(R, t, { noise: 0.3, rand }), W, H, (s += FRAME)).ok);

  // garbage landmarks: e_n far above 0.06
  const lm = landmarks(R, t, { noise: 0.3, rand });
  for (const p of CANONICAL) {
    lm[3 * p.index] += (rand() - 0.5) * 0.06;
    lm[3 * p.index + 1] += (rand() - 0.5) * 0.06;
  }
  for (const i of [33, 133, 362, 263, 1]) { lm[3 * i] = landmarks(R, t)[3 * i]; }
  const bad = est.estimate(lm, W, H, (s += FRAME));
  assert.deepEqual([bad.ok, bad.reason], [false, "bad-fit"]);
  assert.ok(bad.rms > 0.06, `rms ${bad.rms}`);
  assert.ok(Math.abs(bad.yaw - 5) < 0.5, "last good angles held");

  // moderate distortion: under 0.06 but far above 3x the running median
  const mid = landmarks(R, t, { noise: 0.3, rand });
  for (const p of CANONICAL) mid[3 * p.index + 1] += (p.index % 2 ? 1 : -1) * 4 / H;
  const rel = est.estimate(mid, W, H, (s += FRAME));
  assert.ok(rel.rms < 0.06 && rel.rms > 0.015, `rms ${rel.rms}`);
  assert.equal(rel.reason, "bad-fit");
  // and clean frames recover
  assert.ok(est.estimate(landmarks(R, t, { noise: 0.3, rand }), W, H, (s += FRAME)).ok);
});

test("estimator: range gate", () => {
  const est = new HeadPoseEstimator();
  const { R, t } = poseFacing([0, 10, 250], 0, 0);
  const r = est.estimate(landmarks(R, t), W, H, 0);
  assert.deepEqual([r.ok, r.reason, r.inFrame], [false, "range", true]);
  const near = poseFacing([0, 10, 65], 0, 0);
  assert.ok(est.estimate(landmarks(near.R, near.t), W, H, FRAME).ok);
});

test("estimator: far-side weighting follows the camera-frame yaw with hysteresis", () => {
  const est = new HeadPoseEstimator();
  const at = (yaw) => landmarks(rotationFromEuler(yaw, 0, 0), [0, 0, 60]);
  let s = 0;
  est.estimate(at(0), W, H, (s += 1));
  assert.equal(est.side, 0);
  est.estimate(at(30), W, H, (s += 1));
  assert.equal(est.side, 1);
  est.estimate(at(24), W, H, (s += 1));
  assert.equal(est.side, 1, "hysteresis keeps it until 22°");
  est.estimate(at(20), W, H, (s += 1));
  assert.equal(est.side, 0);
  const r = est.estimate(at(-50), W, H, (s += 1));
  assert.equal(est.side, 2);
  assert.ok(r.ok && Math.abs(eulerFromR(est.R).yaw + 50) < 1e-3);
});

test("estimator: pivot smoothing (~0.3 s at rest), reset forgets everything", () => {
  const est = new HeadPoseEstimator();
  const { R, t } = poseFacing([0, 10, 65], 0, 0);
  est.estimate(landmarks(R, t), W, H, 0);
  const before = est.pivot.slice();
  // a small pivot step (solver-noise sized) is only partly followed after one 33 ms frame
  const moved = poseFacing([0.3, 10, 65], 0, 0);
  est.estimate(landmarks(moved.R, moved.t), W, H, FRAME);
  const frac = (est.pivot[0] - before[0]) / 0.3;
  assert.ok(frac > 0.05 && frac < 0.2, `frac ${frac}`);
  est.reset();
  assert.equal(est.good, null);
  assert.equal(est.cold, true);
  assert.equal(est.pivotInit, false);
  const r = est.estimate(landmarks(R, t), W, H, 10);
  assert.ok(r.ok);
});

test("estimator: configure(screenOffsetCm) changes the reference ray", () => {
  const est = new HeadPoseEstimator({ screenOffsetCm: -10 });
  const { R, t } = poseFacing([0, 10, 60], 0, 0, -10);
  assert.ok(Math.abs(est.estimate(landmarks(R, t), W, H, 0).pitch) < 1e-3);
  est.configure({ screenOffsetCm: 12 });
  assert.ok(est.estimate(landmarks(R, t), W, H, FRAME).pitch > 15);
});

test("estimator: works on a downscaled frame (640x360) with the same angles", () => {
  const est = new HeadPoseEstimator();
  const { R, t } = poseFacing([10, 10, 70], -18, 9);
  const r = est.estimate(landmarks(R, t, { w: 640, h: 360 }), 640, 360, 0);
  assert.ok(r.ok && Math.abs(r.yaw + 18) < 1e-2 && Math.abs(r.pitch - 9) < 1e-2, `${r.yaw},${r.pitch}`);
});
