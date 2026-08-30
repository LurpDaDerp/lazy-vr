/* The gaze -> requested-turn-rate control law. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ASPECT, MAX_SCALE, MIN_SCALE, GazeController, responseAngle,
} from "../../site/js/control.js";

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b}`);

// -- the response curve ------------------------------------------------

test("response: zero inside and at the edge of the deadzone", () => {
  for (const e of [0, 0.5, -1.9, 2]) assert.equal(responseAngle(e, 2, 4, 180), 0);
});

test("response: proportional beyond it, saturating at the limit", () => {
  near(responseAngle(12, 2, 4, 180), 40, 1e-12);
  near(responseAngle(1000, 2, 4, 85), 85, 1e-12);
  near(responseAngle(-1000, 2, 4, 85), -85, 1e-12);
});

test("response: symmetric and monotonic", () => {
  for (const e of [3, 12, 40]) near(responseAngle(-e, 2, 4, 180), -responseAngle(e, 2, 4, 180), 1e-12);
  let last = -1;
  for (let e = 2.05; e < 22; e += 0.05) { const v = responseAngle(e, 2, 4, 180); assert.ok(v >= last); last = v; }
});

test("response: expo above one softens the centre and reaches further", () => {
  assert.ok(responseAngle(2.5, 2, 4, 180, 2) < responseAngle(2.5, 2, 4, 180, 1));
  assert.ok(responseAngle(6, 2, 4, 180, 2) > responseAngle(6, 2, 4, 180, 1));
});

test("response: a non-finite error is inert", () => {
  assert.equal(responseAngle(NaN, 2, 4, 180), 0);
  assert.equal(responseAngle(Infinity, 2, 4, 180), 0);
});

// -- helpers -----------------------------------------------------------

const STEP = 0.03;
const tracked = (yaw, pitch, t, confidence = 1) => ({ yaw, pitch, tracked: true, confidence, timestamp: t });
const lost = (t) => ({ yaw: 0, pitch: 0, tracked: false, confidence: 0, timestamp: t });

function config(over = {}) {
  return {
    deadzoneYaw: 6, deadzonePitch: 6 / DEFAULT_ASPECT,
    rateYaw: 9, ratePitch: 9 * DEFAULT_ASPECT,
    maxRateYaw: 120, maxRatePitch: 90,
    onset: 0.12, expo: 1, tau: 0, minConfidence: 0.5,
    calibrationHold: 0.3, calibrationTolerance: 2.5,
    ...over,
  };
}

function calibrated(controller, yaw = 0, pitch = 0, start = 0) {
  let t = start;
  const limit = start + controller.config.calibrationHold * 10 + 1;
  while (!controller.calibrated) {
    t += STEP;
    controller.update(tracked(yaw, pitch, t));
    if (t > limit) throw new Error("calibration never finished");
  }
  return t;
}

function holdGaze(controller, yaw, pitch, start, duration, confidence = 1) {
  let out = null, t = start;
  while (t < start + duration - 1e-12) { t += STEP; out = controller.update(tracked(yaw, pitch, t, confidence)); }
  return out;
}

// -- calibration: a fixation test, not a sample count --------------------

test("calibration: nothing moves while calibrating", () => {
  const c = new GazeController(config());
  const out = c.update(tracked(30, 30, 0));
  assert.equal(out.state, "calibrating");
  assert.equal(out.yawRate, 0);
  assert.equal(out.pitchRate, 0);
});

test("calibration: holding still long enough finishes it", () => {
  const c = new GazeController(config());
  calibrated(c);
  assert.ok(c.calibrated);
  assert.equal(c.calibrationProgress, 1);
});

test("calibration: a gaze that keeps moving never finishes", () => {
  const c = new GazeController(config());
  for (let i = 0; i < 200; i++) c.update(tracked(20 * (i % 2), 0, STEP * i));
  assert.ok(!c.calibrated);
  assert.equal(c.calibrationProgress, 0);
});

test("calibration: looking away restarts the hold and is counted", () => {
  const c = new GazeController(config());
  holdGaze(c, 0, 0, 0, 0.15);
  assert.ok(c.calibrationProgress > 0);
  const before = c.resets;
  c.update(tracked(40, 0, 0.2));
  assert.equal(c.calibrationProgress, 0);
  assert.equal(c.resets, before + 1);
});

test("calibration: a wander inside the tolerance is forgiven", () => {
  const c = new GazeController(config());
  let t = 0;
  for (let i = 0; i < 40; i++) { t += STEP; c.update(tracked(i % 2 ? 1 : -1, 0, t)); }
  assert.ok(c.calibrated);
});

test("calibration: a slow drift off the dot is caught", () => {
  const c = new GazeController(config({ calibrationHold: 5 }));
  let t = 0;
  for (let i = 0; i < 60; i++) { t += STEP; c.update(tracked(i * 0.5, 0, t)); }
  assert.ok(!c.calibrated);
  assert.ok(c.resets > 0);
});

test("calibration: the centre is the mean of the held samples, and cancels bias", () => {
  const c = new GazeController(config());
  const after = calibrated(c, 11, -4);
  near(c.centre[0], 11, 1e-9); near(c.centre[1], -4, 1e-9);
  assert.equal(c.update(tracked(11, -4, after + STEP)).yawError, 0);
});

test("calibration: untracked samples do not count", () => {
  const c = new GazeController(config());
  for (let i = 0; i < 100; i++) c.update(lost(STEP * i));
  assert.ok(!c.calibrated);
});

test("calibration: recalibrate restarts the pass and bumps the generation", () => {
  const c = new GazeController(config());
  const after = calibrated(c);
  const g = c.generation;
  assert.equal(c.recalibrate(), g + 1);
  assert.ok(!c.calibrated);
  assert.equal(c.update(tracked(0, 0, after + STEP)).state, "calibrating");
});

// -- the onset gate ----------------------------------------------------

test("gate: a brief glance moves nothing", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  const seen = holdGaze(c, 25, 0, t, 0.09);
  assert.equal(seen.yawRate, 0);
  assert.equal(seen.committed, false);
  assert.equal(seen.state, "committing");
});

test("gate: holding the look commits, and it does not re-trigger mid-turn", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  const seen = holdGaze(c, 25, 0, t, 0.3);
  assert.ok(seen.committed && seen.yawRate > 0 && seen.state === "steering");
  const flipped = c.update(tracked(-25, 0, t + 0.33));
  assert.ok(flipped.committed && flipped.yawRate < 0);
});

test("gate: coming back inside shuts it, and the next excursion waits again", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  holdGaze(c, 25, 0, t, 0.3);
  const back = c.update(tracked(0, 0, t + 0.33));
  assert.equal(back.committed, false);
  assert.equal(holdGaze(c, 25, 0, t + 0.36, 0.06).yawRate, 0);
});

test("gate: zero onset commits at once", () => {
  const c = new GazeController(config({ onset: 0 }));
  const t = calibrated(c);
  assert.ok(c.update(tracked(25, 0, t + STEP)).yawRate > 0);
});

// -- the rate map ------------------------------------------------------

test("map: inside the deadzone asks for nothing", () => {
  const c = new GazeController(config());
  const seen = holdGaze(c, 4, 1, calibrated(c), 0.4);
  assert.equal(seen.yawRate, 0); assert.equal(seen.state, "holding");
});

test("map: proportional beyond the deadzone, capped at the limit", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  near(holdGaze(c, 15, 0, t, 0.4).yawRate, 81, 1e-9);
  near(holdGaze(c, 200, 0, t, 0.4).yawRate, 120, 1e-9);
  near(holdGaze(c, 0, 200, t, 0.4).pitchRate, 90, 1e-9);
});

test("map: pitch is geared by the screen aspect", () => {
  const c = new GazeController(config());
  const seen = holdGaze(c, 0, 7, calibrated(c), 0.4);
  near(seen.pitchRate, (7 - 6 / DEFAULT_ASPECT) * 9 * DEFAULT_ASPECT, 1e-9);
});

test("map: both axes reach the same speed at the same share of their travel", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  near(holdGaze(c, 14, 0, t, 0.4).yawRate, holdGaze(c, 0, 14 / DEFAULT_ASPECT, t, 0.4).pitchRate, 1e-9);
});

test("map: inversion flips only its own axis", () => {
  const c = new GazeController(config({ invertYaw: true }));
  const seen = holdGaze(c, 20, 10, calibrated(c), 0.4);
  assert.ok(seen.yawRate < 0 && seen.pitchRate > 0);
});

// -- stops -------------------------------------------------------------

test("stop: a lost face or low confidence asks for a stop and shuts the gate", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  holdGaze(c, 25, 0, t, 0.4);
  const gone = c.update(lost(t + 0.5));
  assert.equal(gone.yawRate, 0); assert.equal(gone.state, "lost");
  assert.equal(holdGaze(c, 25, 0, t + 0.53, 0.06).yawRate, 0);
  holdGaze(c, 25, 0, t + 0.6, 0.4);
  const blurred = holdGaze(c, 25, 0, t + 1.0, 0.1, 0.1);
  assert.equal(blurred.yawRate, 0); assert.equal(blurred.state, "low confidence");
});

// -- smoothing ---------------------------------------------------------

test("smoothing: frame-rate independent, and a long gap snaps", () => {
  const make = (tau) => {
    const c = new GazeController(config({ tau, calibrationHold: 0.001, calibrationTolerance: 1e9 }));
    c.update(tracked(0, 0, -0.01)); c.update(tracked(0, 0, -0.008));
    return c;
  };
  const coarse = make(0.1); coarse.update(tracked(10, 0, 0.1));
  const fine = make(0.1); for (let s = 1; s <= 100; s++) fine.update(tracked(10, 0, 0.001 * s));
  near(coarse.update(tracked(10, 0, 0.2)).yawError, fine.update(tracked(10, 0, 0.2)).yawError, 0.02);
  near(make(0.05).update(tracked(20, 0, 30)).yawError, 20, 1e-6);
});

// -- the screen: shape --------------------------------------------------

function viewport(w, h, over = {}) {
  const c = new GazeController(config({ deadzonePitch: null, ratePitch: null, ...over }));
  c.setViewport(w, h);
  return c;
}

test("shape: a wider screen gears pitch harder, a portrait one the other way", () => {
  const wide = viewport(2100, 900);
  const normal = viewport(1600, 900);
  const portrait = viewport(900, 1600);
  assert.ok(wide.ratePitch > normal.ratePitch && wide.deadzonePitch < normal.deadzonePitch);
  assert.ok(portrait.ratePitch < portrait.config.rateYaw && portrait.deadzonePitch > portrait.config.deadzoneYaw);
});

test("shape: the same-speed-at-the-same-share property holds on any screen", () => {
  for (const aspect of [1, 4 / 3, 16 / 10, 16 / 9, 21 / 9, 32 / 9, 9 / 16]) {
    const c = viewport(aspect * 1000, 1000, { maxRateYaw: 1e6, maxRatePitch: 1e6 });
    const t = calibrated(c);
    near(holdGaze(c, 15, 0, t, 0.4).yawRate, holdGaze(c, 0, 15 / aspect, t, 0.4).pitchRate, 1e-9, `aspect ${aspect}`);
  }
});

test("shape: the limits the HUD draws follow the screen", () => {
  const c = viewport(1600, 900);
  const narrow = c.limits.deadzonePitch;
  c.setViewport(3200, 900);
  assert.ok(c.limits.deadzonePitch < narrow);
});

// -- the screen: size ----------------------------------------------------
// Calibration remembers the viewport it happened in; a resize rescales the
// map against it, so a windowed calibration stays correct in fullscreen.

function calibratedAt(w, h, over = {}) {
  const c = viewport(w, h, over);
  return { c, t: calibrated(c) };
}

test("scale: at the calibrated size the map is exactly the aspect law", () => {
  const { c, t } = calibratedAt(1600, 900);
  near(c.deadzoneYaw, c.config.deadzoneYaw, 1e-12);
  near(c.deadzonePitch, c.config.deadzoneYaw / (16 / 9), 1e-12);
  near(holdGaze(c, 15, 0, t, 0.4).yawRate, (15 - 6) * 9, 1e-9);
  near(c.calWidth, 1600, 1e-12);
  near(c.calHeight, 900, 1e-12);
});

test("scale: the same fraction of the view asks for the same turn after a resize", () => {
  // Calibrate windowed, then go 'fullscreen' at double the size.  An error
  // twice as large -- the same fraction of the doubled view -- must ask
  // for exactly what the original error asked for before.
  const { c, t } = calibratedAt(800, 450, { maxRateYaw: 1e6, maxRatePitch: 1e6 });
  const yawBefore = holdGaze(c, 15, 0, t, 0.4).yawRate;
  const pitchBefore = holdGaze(c, 0, 10, t + 0.5, 0.4).pitchRate;
  c.setViewport(1600, 900);
  near(holdGaze(c, 30, 0, t + 1.0, 0.4).yawRate, yawBefore, 1e-9);
  near(holdGaze(c, 0, 20, t + 1.5, 0.4).pitchRate, pitchBefore, 1e-9);
});

test("scale: a grown view grows the deadzone with it", () => {
  const { c, t } = calibratedAt(800, 450);
  assert.ok(holdGaze(c, 8, 0, t, 0.4).yawRate > 0);
  c.setViewport(1600, 900);  // the 6-degree deadzone is now 12
  const after = holdGaze(c, 8, 0, t + 0.5, 0.4);
  assert.equal(after.yawRate, 0);
  assert.equal(after.state, "holding");
});

test("scale: each axis rescales by its own growth", () => {
  const { c, t } = calibratedAt(1600, 900, { maxRateYaw: 1e6 });
  const before = holdGaze(c, 15, 0, t, 0.4).yawRate;
  c.setViewport(800, 900);  // width halves, height stays
  near(holdGaze(c, 7.5, 0, t + 0.5, 0.4).yawRate, before, 1e-9);
  near(c.deadzonePitch, c.config.deadzoneYaw / (16 / 9), 1e-12);
});

test("scale: recalibrating in the new viewport makes it the reference", () => {
  const { c, t } = calibratedAt(800, 450);
  c.setViewport(1600, 900);
  c.recalibrate();
  calibrated(c, 0, 0, t + 1);
  near(c.deadzoneYaw, c.config.deadzoneYaw, 1e-12);
  near(c.calWidth, 1600, 1e-12);
});

test("scale: an absurd resize is folded back into range", () => {
  const { c } = calibratedAt(1000, 1000);
  c.setViewport(100000, 1000);
  near(c.deadzoneYaw, c.config.deadzoneYaw * MAX_SCALE, 1e-12);
  c.setViewport(1, 1000);
  near(c.deadzoneYaw, c.config.deadzoneYaw * MIN_SCALE, 1e-12);
});

test("scale: nonsense viewport reports change nothing", () => {
  const { c } = calibratedAt(1600, 900);
  const deadzone = c.deadzoneYaw;
  for (const [w, h] of [[0, 900], [-5, 900], [NaN, 900], [1600, 0], [Infinity, 900], ["wide", 900]]) {
    c.setViewport(w, h);
    near(c.deadzoneYaw, deadzone, 1e-12);
  }
});

// -- two dots: what a screen pixel is worth ------------------------------
// The second fixation sits a known number of pixels from the first, so the
// difference between the two measures degrees-of-gaze per pixel, sign
// included -- and a moved window can then be re-aimed exactly.

function twoPoint(kx = 0.02, ky = -0.02) {
  const c = new GazeController(config());
  c.setViewport(1600, 900);
  c.setScreenCentre(800, 450);
  c.recalibrate({ dx: 400, dy: -225 });
  let t = 0;
  while (c.phase === "centre") { t += STEP; c.update(tracked(0, 0, t)); }
  while (!c.calibrated) { t += STEP; c.update(tracked(kx * 400, ky * -225, t)); }
  return { c, t };
}

test("two-point: the pass measures degrees per pixel, sign included", () => {
  const { c } = twoPoint();
  near(c.k[0], 0.02, 1e-9);
  near(c.k[1], -0.02, 1e-9);
  assert.equal(c.phase, "idle");
  assert.ok(c.calibrated);
});

test("two-point: a moved window moves the centre with it", () => {
  const { c, t } = twoPoint();
  // The window slides 200 px right and 100 px up; staring at the *new*
  // screen centre produces the gaze k predicts, and nothing turns.
  c.setScreenCentre(1000, 350);
  const out = holdGaze(c, 0.02 * 200, -0.02 * -100, t, 0.4);
  near(out.yawError, 0, 1e-9);
  near(out.pitchError, 0, 1e-9);
  assert.equal(out.yawRate, 0);
  assert.equal(out.state, "holding");
});

test("two-point: without a second dot no correction is applied", () => {
  const c = new GazeController(config());
  c.setViewport(1600, 900);
  c.setScreenCentre(800, 450);
  c.recalibrate();
  const t = calibrated(c);
  assert.equal(c.k, null);
  c.setScreenCentre(1200, 450);
  near(holdGaze(c, 0, 0, t, 0.2).yawError, 0, 1e-9);
});

test("two-point: an absurd measurement corrects nothing", () => {
  // A botched second fixation reads as an implausible degrees-per-pixel
  // and is discarded rather than believed.
  const { c, t } = twoPoint(0.0001, 0.0001);
  assert.equal(c.k[0], 0);
  assert.equal(c.k[1], 0);
  c.setScreenCentre(1300, 450);
  near(holdGaze(c, 0, 0, t, 0.2).yawError, 0, 1e-9);
});

test("two-point: looking away during the second dot restarts only that dot", () => {
  const c = new GazeController(config());
  c.setViewport(1600, 900);
  c.recalibrate({ dx: 400, dy: 0 });
  let t = 0;
  while (c.phase === "centre") { t += STEP; c.update(tracked(0, 0, t)); }
  const centre = [...c.centre];
  t += STEP; c.update(tracked(8, 0, t));
  const before = c.resets;
  t += STEP; c.update(tracked(40, 0, t));  // a glance far away
  assert.equal(c.resets, before + 1);
  assert.equal(c.phase, "offset");
  assert.deepEqual(c.centre, centre);
  assert.ok(!c.calibrated);
});

test("defaults: the onset gate opens on one sample at any plausible frame rate", () => {
  const onset = new GazeController().config.onset;
  assert.ok(onset > 0);
  for (const fps of [30, 30.5, 33, 60]) {
    const step = 1 / fps;
    const felt = Math.ceil(onset / step - 1e-9) * step;
    assert.ok(felt <= 0.035, `${fps} fps feels ${felt}`);
  }
});
