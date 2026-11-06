import test from "node:test";
import assert from "node:assert/strict";

import { EYES, EyeTracker, eyeFeatures } from "../../site/js/eyes.js";
import {
  CANONICAL, HeadPoseEstimator, focalFor, headFromCanonical, multiply3, rotationFromEuler, rotationX, rotationY,
} from "../../site/js/pose.js";

const W = 1280, H = 720;
const F = focalFor(W, H);
const FRAME = 1 / 30;

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
const gaussian = (rand) => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// -- synthetic face with eyeballs ------------------------------------------------------------
// Eyeball centre 0.77 cm behind the corner plane, iris 0.97 cm from it (research §6).

const EYE_PTS = {  // canonical (X, Y, Z) of the 2D-only eye points, subject's right eye (X < 0)
  33: [-4.445859, 2.663991, 3.173422], 133: [-1.856432, 2.585245, 3.757904],
  159: [-3.177186, 2.964136, 3.876973], 145: [-3.177186, 2.294265, 3.775704],
  160: [-3.670075, 2.927714, 3.724325], 144: [-3.670075, 2.360153, 3.635230],
  158: [-2.724032, 2.961810, 3.871767], 153: [-2.724032, 2.315802, 3.777151],
};
const MIRROR = { 33: 263, 133: 362, 159: 386, 145: 374, 160: 387, 144: 373, 158: 385, 153: 380 };
const LOWER_OF = { 160: 144, 158: 153, 159: 145, 387: 373, 385: 380, 386: 374 };
const HEAD_PTS = {};
for (const [i, [X, Y, Z]] of Object.entries(EYE_PTS)) {
  HEAD_PTS[i] = headFromCanonical(X, Y, Z);
  HEAD_PTS[MIRROR[i]] = headFromCanonical(-X, Y, Z);
}
for (const p of CANONICAL) HEAD_PTS[p.index] = [p.x, p.y, p.z];
const EYEBALL = { 468: headFromCanonical(-3.151, 2.70, 2.7), 473: headFromCanonical(3.151, 2.70, 2.7) };
const IRIS_R = 0.97;

const apply = (R, p, t) => [
  R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
  R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
  R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
];

/* Pose whose pivot (0, 8, 9) sits at pivotCam, turned (yaw, pitch) away from facing S. */
function poseFacing(pivotCam, yaw, pitch, h = 12) {
  const n = [-pivotCam[0], h - pivotCam[1], -pivotCam[2]];
  const len = Math.hypot(...n);
  const Rref = multiply3(rotationY(Math.atan2(-n[0] / len, -n[2] / len)), rotationX(Math.asin(n[1] / len)));
  const R = multiply3(Rref, rotationFromEuler(yaw, pitch, 0));
  const rp = apply(R, [0, 8, 9], [0, 0, 0]);
  return { R, t: [pivotCam[0] - rp[0], pivotCam[1] - rp[1], pivotCam[2] - rp[2]] };
}

/* Landmarks for a head at (R, t) whose eyes fixate the camera-frame point `target`. */
function face(R, t, target, { noise = 0, rand = rng(1), closed = false, eyeball = EYEBALL } = {}) {
  const lm = new Float32Array(478 * 3).fill(0.5);
  const put = (i, P) => {
    lm[3 * i] = (F * P[0] / P[2] + W / 2 + noise * gaussian(rand)) / W;
    lm[3 * i + 1] = (F * P[1] / P[2] + H / 2 + noise * gaussian(rand)) / H;
    lm[3 * i + 2] = 0;
  };
  for (const [i, p] of Object.entries(HEAD_PTS)) {
    const src = closed && LOWER_OF[i] !== undefined ? HEAD_PTS[LOWER_OF[i]] : p;
    put(Number(i), apply(R, src, t));
  }
  for (const [i, e] of Object.entries(eyeball)) {
    const E = apply(R, e, t);
    const g = [target[0] - E[0], target[1] - E[1], target[2] - E[2]];
    const n = Math.hypot(...g);
    put(Number(i), [E[0] + IRIS_R * g[0] / n, E[1] + IRIS_R * g[1] / n, E[2] + IRIS_R * g[2] / n]);
  }
  return lm;
}

const S = [0, 12, 0];          // screen centre (camera 12 cm above it)
const PIVOT = [0, 10, 65];

/* Runs the real pipeline (pose estimator -> features -> eye tracker) over a scripted session. */
function session(script, { noise = 0.4, seed = 3, eyeball = EYEBALL } = {}) {
  const rand = rng(seed);
  const est = new HeadPoseEstimator();
  const eyes = new EyeTracker();
  const feat = {};
  const out = [];
  for (let i = 0; ; i++) {
    const s = i * FRAME;
    const step = script(s);
    if (!step) break;
    const { R, t } = poseFacing(step.pivot || PIVOT, step.yaw || 0, step.pitch || 0);
    const lm = face(R, t, step.target || S, { noise, rand, closed: step.closed, eyeball });
    const pose = est.estimate(lm, W, H, s);
    eyeFeatures(lm, W, H, feat);
    const e = eyes.update(feat, pose.yaw, pose.pitch, s, pose.ok);
    out.push({ s, ...e, hx: feat.hx, vy: feat.vy, yaw: pose.yaw, pitch: pose.pitch, ok: pose.ok });
  }
  return out;
}

// -- eyeFeatures ------------------------------------------------------------------------------

test("eyeFeatures: signs -- iris toward the user's right => hx > 0, up => vy > 0", () => {
  const { R, t } = poseFacing(PIVOT, 0, 0);
  const f = eyeFeatures(face(R, t, S), W, H, {});
  assert.equal(f.ok, true);
  // the user's right is the camera's -x (image left); up is -y
  const right = eyeFeatures(face(R, t, [-20, 12, 0]), W, H, {});
  const left = eyeFeatures(face(R, t, [20, 12, 0]), W, H, {});
  const up = eyeFeatures(face(R, t, [0, -8, 0]), W, H, {});
  assert.ok(right.hx > f.hx + 0.05 && left.hx < f.hx - 0.05, `${right.hx} ${f.hx} ${left.hx}`);
  assert.ok(up.vy > f.vy + 0.05, `${up.vy} ${f.vy}`);
  assert.ok(right.hxR > f.hxR && right.hxL > f.hxL, "both eyes agree");
  assert.ok(Math.abs(right.vy - f.vy) < 0.02);
});

test("eyeFeatures: ~0.38·sin(e) eye widths per voluntary rotation", () => {
  const { R, t } = poseFacing([0, 12, 60], 0, 0);
  const eyeZ = apply(R, EYEBALL[468], t)[2];
  const base = eyeFeatures(face(R, t, [0, 12, 0]), W, H, {}).hx;
  // a target 10° to the user's right of the straight-ahead line
  const x = -Math.tan(10 * Math.PI / 180) * eyeZ;
  const d = eyeFeatures(face(R, t, [x, 12, 0]), W, H, {}).hx - base;
  assert.ok(Math.abs(d - 0.38 * Math.sin(10 * Math.PI / 180)) < 0.015, `${d}`);
});

test("eyeFeatures: invariant to image-plane roll and to scale", () => {
  const { R, t } = poseFacing(PIVOT, 8, -4);
  const lm = face(R, t, [-10, 0, 0]);
  const a = eyeFeatures(lm, W, H, {});
  const rolled = new Float32Array(lm);
  const c = Math.cos(0.4), s = Math.sin(0.4), cx = 600, cy = 380;
  for (let i = 0; i < 478; i++) {
    const u = lm[3 * i] * W - cx, v = lm[3 * i + 1] * H - cy;
    rolled[3 * i] = (cx + 0.8 * (c * u - s * v)) / W;
    rolled[3 * i + 1] = (cy + 0.8 * (s * u + c * v)) / H;
  }
  const b = eyeFeatures(rolled, W, H, {});
  for (const k of ["hx", "vy", "ear"]) assert.ok(Math.abs(a[k] - b[k]) < 1e-4, `${k} ${a[k]} ${b[k]}`);
  assert.ok(Math.abs(b.wR / a.wR - 0.8) < 1e-4);
});

test("eyeFeatures: EAR open ≈ 0.23, closed ≈ 0; width-weighted combination; single eye under 0.6x", () => {
  const { R, t } = poseFacing(PIVOT, 0, 0);
  const open = eyeFeatures(face(R, t, S), W, H, {});
  assert.ok(open.earR > 0.2 && open.earR < 0.26 && open.earL > 0.2 && open.earL < 0.26, `${open.earR}`);
  const shut = eyeFeatures(face(R, t, S, { closed: true }), W, H, {});
  assert.ok(shut.ear < 0.05);

  const lm = face(R, t, [-10, 12, 0]);
  const both = eyeFeatures(lm, W, H, {});
  const expect = (both.wR ** 2 * both.hxR + both.wL ** 2 * both.hxL) / (both.wR ** 2 + both.wL ** 2);
  assert.ok(Math.abs(both.hx - expect) < 1e-12);
  // squash the left eye to half width around its midpoint: only the right eye counts
  const sq = new Float32Array(lm);
  const { cR, cL, iris } = EYES.left;
  const mx = 0.5 * (lm[3 * cR] + lm[3 * cL]);
  for (const i of [cR, cL, iris, 385, 387, 373, 380]) sq[3 * i] = mx + 0.5 * (lm[3 * i] - mx);
  const one = eyeFeatures(sq, W, H, {});
  assert.ok(one.wL < 0.6 * one.wR);
  assert.equal(one.hx, one.hxR);
  assert.equal(one.ear, one.earR);
});

test("eyeFeatures: degenerate input is not ok", () => {
  assert.equal(eyeFeatures(new Float32Array(468 * 3), W, H, {}).ok, false, "no iris landmarks");
  assert.equal(eyeFeatures(null, W, H, {}).ok, false);
  assert.equal(eyeFeatures(new Float32Array(478 * 3).fill(0.5), W, H, {}).ok, false, "zero-width eyes");
  const { R, t } = poseFacing(PIVOT, 0, 0);
  const lm = face(R, t, S);
  lm[3 * 468] = NaN;
  const f = eyeFeatures(lm, W, H, {});
  assert.equal(f.ok, true, "the other eye still measures");
  assert.equal(f.hx, f.hxL);
  assert.equal(eyeFeatures(lm, 0, H, {}).ok, false);
});

// -- EyeTracker --------------------------------------------------------------------------------

test("EyeTracker: head turns with the eyes on the screen read ~0 (VOR coupling regressed out)", () => {
  const sway = (s) => ({ yaw: 18 * Math.sin(2 * Math.PI * s / 4), pitch: 9 * Math.sin(2 * Math.PI * s / 5.3) });
  const out = session((s) => (s < 16 ? sway(s) : null));
  const late = out.filter((r) => r.s > 6);
  assert.ok(late.every((r) => r.valid));
  const worstX = Math.max(...late.map((r) => Math.abs(r.x)));
  const worstY = Math.max(...late.map((r) => Math.abs(r.y)));
  const rms = Math.sqrt(late.reduce((a, r) => a + r.x * r.x + r.y * r.y, 0) / late.length);
  assert.ok(worstX < 3 && worstY < 3 && rms < 1.5, `x ${worstX} y ${worstY} rms ${rms}`);
  // without the fit the raw iris shift alone would read as a large eye movement
  const rawSpan = Math.max(...late.map((r) => r.hx)) - Math.min(...late.map((r) => r.hx));
  assert.ok(rawSpan * 151 > 15, `raw span ${rawSpan * 151}°`);
});

test("EyeTracker: the coupling fit adapts to shallower and deeper eyeballs than the prior", () => {
  const sway = (s) => ({ yaw: 20 * Math.sin(2 * Math.PI * s / 4), pitch: 10 * Math.sin(2 * Math.PI * s / 5.3) });
  for (const z of [2.4, 3.0]) {
    const eyeball = { 468: headFromCanonical(-3.151, 2.70, z), 473: headFromCanonical(3.151, 2.70, z) };
    const out = session((s) => (s < 30 ? sway(s) : null), { eyeball });
    const late = out.filter((r) => r.s > 20);
    const worst = Math.max(...late.map((r) => Math.max(Math.abs(r.x), Math.abs(r.y))));
    assert.ok(worst < 3, `eyeball z ${z}: worst ${worst}`);
  }
});

test("EyeTracker: a voluntary look has the right sign and roughly the right size, and springs back", () => {
  const warm = (s) => ({ yaw: 15 * Math.sin(2 * Math.PI * s / 4), pitch: 6 * Math.sin(2 * Math.PI * s / 5) });
  const eyeZ = 62;  // roughly the eyes' distance from the screen plane
  const deg = (cm) => Math.atan(cm / eyeZ) * 180 / Math.PI;
  const plan = (s) => {
    if (s < 8) return warm(s);
    if (s < 10) return { yaw: 5, target: [-15, 12, 0] };          // look to the user's right
    if (s < 11) return { yaw: 5 };                                 // back to the screen centre
    if (s < 13) return { yaw: -4, pitch: 3, target: [14, 12, 0] }; // look left
    if (s < 14) return { yaw: -4, pitch: 3 };
    if (s < 16) return { pitch: -2, target: [0, -2, 0] };          // look up
    if (s < 17) return {};
    return null;
  };
  const out = session(plan);
  const at = (s) => out.find((r) => r.s >= s);
  const right = at(9.8), centre1 = at(10.9), left = at(12.8), centre2 = at(13.9), up = at(15.8), centre3 = at(16.9);
  const expectX = deg(15);
  assert.ok(right.valid && right.x > 0.6 * expectX && right.x < 1.4 * expectX, `right ${right.x} vs ${expectX}`);
  assert.ok(Math.abs(right.y) < 3, `right y ${right.y}`);
  assert.ok(Math.abs(centre1.x) < 2.5, `centre ${centre1.x}`);
  assert.ok(left.x < -0.6 * deg(14) && left.x > -1.4 * deg(14), `left ${left.x}`);
  assert.ok(Math.abs(centre2.x) < 2.5, `centre ${centre2.x}`);
  assert.ok(up.y > 0.6 * deg(14) && up.y < 1.4 * deg(14), `up ${up.y}`);
  assert.ok(Math.abs(up.x) < 3, `up x ${up.x}`);
  assert.ok(Math.abs(centre3.y) < 2.5, `centre ${centre3.y}`);
  // a 2 s look is held, not absorbed by the coupling fit
  const early = at(8.6), late = at(9.95);
  assert.ok(late.x > 0.8 * early.x, `held ${early.x} -> ${late.x}`);
});

test("EyeTracker: blinks hold the last value, flag blink, and release 120 ms after reopening", () => {
  const plan = (s) => {
    if (s < 6) return { yaw: 10 * Math.sin(2 * Math.PI * s / 3) };
    if (s < 6.5) return { target: [-15, 12, 0] };
    if (s < 6.6) return { target: [-15, 12, 0], closed: true };   // 3 frames
    if (s < 7) return { target: [-15, 12, 0] };
    return null;
  };
  const out = session(plan, { noise: 0.3 });
  const before = out.filter((r) => r.s < 6.5).at(-1);
  assert.ok(before.valid && before.x > 5);
  const shut = out.filter((r) => r.s >= 6.5 && r.s < 6.6);
  assert.ok(shut.length >= 3);
  for (const r of shut) {
    assert.deepEqual([r.valid, r.blink], [false, true]);
    assert.equal(r.x, before.x);
    assert.equal(r.y, before.y);
  }
  const lastShut = shut.at(-1).s;
  const hold = out.filter((r) => r.s > lastShut && r.s < lastShut + 0.12 - 1e-9);
  assert.ok(hold.length >= 3);
  for (const r of hold) assert.deepEqual([r.valid, r.blink, r.x], [false, true, before.x]);
  const after = out.filter((r) => r.s >= lastShut + 0.12 + 1e-9);
  assert.ok(after[0].valid && !after[0].blink);
  assert.ok(Math.abs(after.at(-1).x - before.x) < 3, "the look resumes");
});

test("EyeTracker: relative blink threshold uses the open-eye median", () => {
  const eyes = new EyeTracker();
  const feat = { ok: true, hx: 0, vy: 0, ear: 0.3 };
  let s = 0;
  for (let i = 0; i < 40; i++) eyes.update(feat, 0, 0, (s += FRAME), true);
  // 0.18 is above the absolute 0.15 but below 0.65 x 0.3
  const r = eyes.update({ ...feat, ear: 0.18 }, 0, 0, (s += FRAME), true);
  assert.deepEqual([r.valid, r.blink], [false, true]);
  const squint = eyes.update({ ...feat, ear: 0.22 }, 0, 0, (s += 0.2), true);
  assert.deepEqual([squint.valid, squint.blink], [true, false]);
});

test("EyeTracker: invalid until ~15 frames, when the head is not ok, and on bad input", () => {
  const eyes = new EyeTracker();
  const feat = { ok: true, hx: 0.01, vy: -0.02, ear: 0.28 };
  let s = 0;
  for (let i = 0; i < 14; i++) assert.equal(eyes.update(feat, 0, 0, (s += FRAME), true).valid, false);
  assert.equal(eyes.update(feat, 0, 0, (s += FRAME), true).valid, true, "15th frame");
  assert.equal(eyes.update(feat, 0, 0, (s += FRAME), false).valid, false, "head not ok");
  assert.equal(eyes.update({ ...feat, ok: false }, 0, 0, (s += FRAME), true).valid, false);
  assert.equal(eyes.update({ ...feat, hx: NaN }, 0, 0, (s += FRAME), true).valid, false);
  assert.equal(eyes.update(feat, NaN, 0, (s += FRAME), true).valid, false);
  assert.equal(eyes.update(feat, 0, 0, NaN, true).valid, false);
  assert.equal(eyes.update(null, 0, 0, (s += FRAME), true).valid, false);
  const ok = eyes.update(feat, 0, 0, (s += FRAME), true);
  assert.equal(ok.valid, true);
  assert.ok(Number.isFinite(ok.x) && Number.isFinite(ok.y));
  assert.equal(eyes.update(feat, 0, 0, s - 1, true).valid, false, "out-of-order time");
  // frames with the head far out of the fit range do not seed the fit
  const fresh = new EyeTracker();
  for (let i = 0; i < 30; i++) assert.equal(fresh.update(feat, 40, 0, i * FRAME, true).valid, false);
  // reset
  eyes.reset();
  assert.equal(eyes.update(feat, 0, 0, (s += FRAME), true).valid, false);
});

test("EyeTracker: the fit's b stays clamped and a converges to the rest offset", () => {
  const eyes = new EyeTracker();
  let s = 0;
  // a person whose irises rest at hx 0.05, with an (implausible) slope of -0.9
  for (let i = 0; i < 600; i++) {
    const yaw = 20 * Math.sin(2 * Math.PI * (s += FRAME) / 3);
    eyes.update({ ok: true, hx: 0.05 - 0.9 * Math.sin(yaw * Math.PI / 180), vy: 0, ear: 0.28 }, yaw, 0, s, true);
  }
  assert.ok(eyes.fitH.b >= -0.45 - 1e-12 && eyes.fitH.b <= -0.15 + 1e-12, `b ${eyes.fitH.b}`);
  const still = new EyeTracker();
  s = 0;
  for (let i = 0; i < 300; i++) still.update({ ok: true, hx: 0.05, vy: -0.03, ear: 0.28 }, 0, 0, (s += FRAME), true);
  assert.ok(Math.abs(still.fitH.a - 0.05) < 1e-3 && Math.abs(still.fitV.a + 0.03) < 1e-3);
  const r = still.update({ ok: true, hx: 0.05, vy: -0.03, ear: 0.28 }, 0, 0, (s += FRAME), true);
  assert.ok(Math.abs(r.x) < 0.2 && Math.abs(r.y) < 0.2);
});
