/* The gaze -> requested-turn-rate control law. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEADZONE_FLOOR, DEFAULT_ASPECT, MAX_SCALE, MIN_SCALE, GazeController, responseAngle,
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

/* The tests above disable the caps to isolate the gearing.  These use the
 * numbers the page actually ships, because the cap is where the law used to
 * come apart: pitch saturated at 7.3 degrees of eye travel where yaw ran to
 * 16.3, and then sat at a ceiling a quarter lower, so every glance past
 * two-thirds of the way up the screen asked for less than the same glance
 * sideways. */

function shipped(over = {}) {
  // The real defaults, with only the clock made convenient for a test.
  const c = new GazeController({ onset: 0.12, tau: 0, calibrationHold: 0.3, ...over });
  c.setViewport(1920, 1080);
  return c;
}

test("map: the numbers that decide how the thing feels", () => {
  // Pinned deliberately.  These four are the whole character of the map,
  // they are the ones a passing edit is most likely to nudge, and the
  // settings panel's x1.00 means exactly this row.
  const d = new GazeController().config;
  near(d.rateYaw, 10.6, 1e-12);
  near(d.deadzoneYaw, 1.8, 1e-12);
  near(d.maxRateYaw, 128, 1e-12);
  assert.equal(d.deadzonePitch, null);   // both derived from the screen
  assert.equal(d.ratePitch, null);
  assert.equal(d.maxRatePitch, null);
});

test("map: full speed is a glance, not a stare", () => {
  const c = shipped();
  // Saturation inside fourteen degrees of eye travel: a viewer asking for
  // the fastest sweep should not have to look off the edge of the screen.
  assert.ok(c.limits.spanYaw < 14, `saturates at ${c.limits.spanYaw}`);
});

test("map: the cap obeys the same law as the rest of the map", () => {
  const c = shipped();
  near(c.maxRatePitch, c.config.maxRateYaw, 1e-12);
  // And so the two axes run out of road at the same share of the *live*
  // part of the screen -- the travel past the deadzone, which is the only
  // part the gain acts on.  The deadzones themselves no longer follow the
  // aspect, because the vertical one is held off the noise floor instead.
  near((c.limits.spanPitch - c.deadzonePitch) * (16 / 9),
    c.limits.spanYaw - c.deadzoneYaw, 1e-9);
});

test("map: the same speed at the same share, all the way to the edge", () => {
  const c = shipped();
  const t = calibrated(c);
  // Past 0.6 of the travel is exactly where this used to fail.  Shares are
  // measured from each axis's own deadzone edge: that is where the gain
  // starts, and the two deadzones are no longer in the aspect's ratio.
  for (const share of [0.2, 0.5, 0.8, 1, 1.5, 4]) {
    const travel = share * 20;
    near(holdGaze(c, c.deadzoneYaw + travel, 0, t, 0.4).yawRate,
      holdGaze(c, 0, c.deadzonePitch + travel / (16 / 9), t, 0.4).pitchRate, 1e-9, `share ${share}`);
  }
});

test("map: at full deflection both axes ask for the full rate", () => {
  const c = shipped();
  const t = calibrated(c);
  near(holdGaze(c, 200, 0, t, 0.4).yawRate, c.config.maxRateYaw, 1e-9);
  near(holdGaze(c, 0, 200, t, 0.4).pitchRate, c.config.maxRateYaw, 1e-9);
});

test("map: a host that wants a slower pitch may still say so", () => {
  const c = shipped({ maxRatePitch: 40 });
  near(c.maxRatePitch, 40, 1e-12);
  near(holdGaze(c, 0, 200, calibrated(c), 0.4).pitchRate, 40, 1e-9);
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
  // The neutral is pinned: this is about the smoother alone, and a neutral
  // that eases towards the eyes while they are inside the deadzone would
  // add its own term to the error -- a small one, but one that depends on
  // how many samples the ramp spent in there, which is the very thing the
  // two arms of this test differ in.
  const make = (tau) => {
    const c = new GazeController(config({ tau, neutralTau: 0, calibrationHold: 0.001, calibrationTolerance: 1e9 }));
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

test("configure: live tuning takes hold on the very next sample", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  near(holdGaze(c, 15, 0, t, 0.4).yawRate, (15 - 6) * 9, 1e-9);
  c.configure({ rateYaw: 18, deadzoneYaw: 3, invertYaw: true, maxRateYaw: 1e6 });
  near(holdGaze(c, 15, 0, t + 0.5, 0.4).yawRate, -(15 - 3) * 18, 1e-9);
});

// -- the neutral: the view is an integrator, so it must not creep ---------
//
// Nothing pulls the view back to where it started, so whatever mean rate
// survives the deadzone is turned into angle and kept.  The reported bug was
// that holding your gaze on the middle of the screen tilted the view further
// and further up: the vertical deadzone had been geared down by the screen
// aspect until it no longer covered the gaze estimate's noise, and a standing
// error in the neutral that yaw shrugged off came out as a standing climb.

/* A deterministic uniform jitter, so these numbers are the same every run. */
function jitter(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 * 2 - 1;
  };
}

/* Calibrate on a still gaze, then hold that gaze -- plus a standing offset
 * of the kind a viewer settling into their chair puts on the reading -- for
 * a minute, integrating what the map asks for.  Returns degrees travelled. */
function creep({ offsetYaw = 0, offsetPitch = 0, amplitude = 1, seconds = 60, seed = 7, over = {} } = {}) {
  const c = new GazeController({ onset: 0.03, ...over });
  c.setViewport(1920, 1080);
  const noise = jitter(seed);
  const step = 1 / 30;
  let t = 0;
  const reading = (y, p) => ({ yaw: y, pitch: p, tracked: true, confidence: 1, timestamp: t });
  while (!c.calibrated) { t += step; c.update(reading(amplitude * noise(), amplitude * noise())); }
  let yaw = 0, pitch = 0;
  for (const end = t + seconds; t < end;) {
    t += step;
    const out = c.update(reading(offsetYaw + amplitude * noise(), offsetPitch + amplitude * noise()));
    yaw += out.yawRate * step;
    pitch += out.pitchRate * step;
  }
  return { yaw, pitch };
}

test("neutral: a standing offset does not walk the view away", () => {
  // Before the deadzone floor and the settling neutral this asked the view
  // for 14.3 degrees of climb in one minute, from an offset the horizontal
  // axis -- same map, same noise, same offset -- ignored entirely.
  assert.ok(Math.abs(creep({ offsetPitch: 0.5 }).pitch) < 0.5, "pitch");
  assert.ok(Math.abs(creep({ offsetYaw: 0.5 }).yaw) < 0.5, "yaw");
});

test("neutral: neither axis creeps, across the offsets and noise a viewer brings", () => {
  // The grid this replaces read, in degrees of climb per minute:
  //
  //             offset  0     0.25    0.5    0.75    1.0
  //   noise 0.6         0.00   0.00   0.07   13.00  77.77
  //   noise 1.0         0.00   1.13  14.33   51.87 133.12
  //   noise 1.6         4.74  28.40  63.11  122.94 217.47
  //
  // -- 217 degrees a minute is the view pinned at the top of the neck
  // inside thirty seconds, from a viewer holding perfectly still.  What is
  // left in the last column is a standing error two thirds the width of the
  // deadzone under noise that crosses it constantly, which is the point
  // past which nothing can tell a drifting neutral from a request.
  for (const offset of [0, 0.25, 0.5, 0.75, 1.0]) {
    for (const amplitude of [0.6, 1.0, 1.6]) {
      const p = creep({ offsetPitch: offset, amplitude }).pitch;
      const y = creep({ offsetYaw: offset, amplitude }).yaw;
      assert.ok(Math.abs(p) < 10, `pitch crept ${p.toFixed(2)} at offset ${offset}, noise ${amplitude}`);
      assert.ok(Math.abs(y) < 10, `yaw crept ${y.toFixed(2)} at offset ${offset}, noise ${amplitude}`);
    }
  }
});

test("neutral: the derived pitch deadzone is never geared below the noise floor", () => {
  for (const [w, h] of [[1920, 1080], [3440, 1440], [2560, 1080], [1600, 1000], [1000, 1000]]) {
    const c = new GazeController();
    c.setViewport(w, h);
    c.finish();
    assert.ok(c.deadzonePitch >= DEADZONE_FLOOR - 1e-12, `${w}x${h}: ${c.deadzonePitch}`);
  }
  // ...nor after the view shrinks under it, which scales the map down too.
  const c = new GazeController();
  c.setViewport(1920, 1080);
  c.finish();
  c.setViewport(480, 270);
  assert.ok(c.deadzonePitch >= DEADZONE_FLOOR - 1e-12, `shrunk: ${c.deadzonePitch}`);
});

test("neutral: a host that names a pitch deadzone gets the one it named", () => {
  const c = new GazeController(config({ deadzonePitch: 0.4 }));
  c.setViewport(1920, 1080);
  near(c.deadzonePitch, 0.4, 1e-12);
});

test("neutral: it follows the eyes only while they ask for nothing", () => {
  const c = new GazeController(config({ neutralTau: 1 }));
  const t = calibrated(c);
  // Inside the deadzone: the neutral eases across, so a viewer whose
  // straight ahead has moved gets it back.
  holdGaze(c, 3, 0, t, 4);
  near(c.centre[0], 3, 0.2);
  // A committed turn is never eaten, however long it is held.  Nine seconds
  // at 25 degrees is far past this test's one-second time constant.
  const before = c.centre[1];
  const seen = holdGaze(c, 0, 25, t + 5, 9);
  assert.ok(seen.pitchRate > 0 && seen.state === "steering");
  near(c.centre[1], before, 1e-12);
});

test("neutral: a gap in the readings is not settled across", () => {
  const c = new GazeController(config({ neutralTau: 1 }));
  const t = calibrated(c);
  c.update(tracked(0, 0, t + STEP));
  // The face is gone for a minute and comes back with the eyes somewhere
  // else.  Settling over that one interval would put alpha ~ 1 on a single
  // sample and hand the neutral straight to wherever they landed.
  c.update(lost(t + 30));
  c.update(tracked(4, 3, t + 60));
  near(c.centre[0], 0, 1e-12);
  near(c.centre[1], 0, 1e-12);
});

test("neutral: pinned by neutralTau 0, for a host that wants the measured centre", () => {
  const c = new GazeController(config({ neutralTau: 0 }));
  const t = calibrated(c);
  holdGaze(c, 3, 1, t, 5);
  near(c.centre[0], 0, 1e-12);
  near(c.centre[1], 0, 1e-12);
});

// -- calibration: what may become the centre -----------------------------

test("calibration: a gap mid-hold restarts it rather than being spliced over", () => {
  const c = new GazeController(config({ calibrationHold: 1.0 }));
  let t = 0;
  for (let i = 0; i < 3; i++) { t += STEP; c.update(tracked(0, 0, t)); }
  const before = c.resets;
  // The face is lost for most of the hold.  The progress bar measures
  // elapsed time, so without the continuity check the next sample would see
  // a full second gone by and finish the pass on those first three frames.
  c.update(lost(t + 0.9));
  const seen = c.update(tracked(0, 0, t + 1.0));
  assert.ok(!c.calibrated, "finished on a spliced hold");
  assert.equal(seen.state, "calibrating");
  assert.equal(c.resets, before + 1);
  assert.equal(c.calibrationProgress, 0);
});

test("calibration: a reading too poor to steer on cannot become the centre", () => {
  const c = new GazeController(config());
  let t = 0;
  // A run of badly-seen frames, all reading 20 degrees off the dot.  They
  // used to go straight into the streak and carry their offset into the one
  // number every later error is measured against.
  for (let i = 0; i < 20; i++) { t += STEP; c.update(tracked(20, 20, t, 0.1)); }
  assert.ok(!c.calibrated);
  assert.equal(c.streak.length, 0);
  calibrated(c, 0, 0, t);
  near(c.centre[0], 0, 1e-9);
  near(c.centre[1], 0, 1e-9);
});

// -- numbers that must never reach the view ------------------------------

test("response: a non-finite deadzone, gain or limit is inert too", () => {
  // Any of these would come out as a NaN angle, and the view adds each
  // angle to the last -- so one is not a bad frame, it is the rest of the
  // session.
  assert.equal(responseAngle(12, NaN, 4, 180), 0);
  assert.equal(responseAngle(12, 2, NaN, 180), 0);
  assert.equal(responseAngle(12, 2, 4, NaN), 0);
  assert.equal(responseAngle(12, 2, Infinity, 180), 0);
});

test("stop: a reading with no usable clock is treated as a lost face", () => {
  const c = new GazeController(config());
  const t = calibrated(c);
  holdGaze(c, 25, 0, t, 0.4);
  const broken = c.update(tracked(25, 0, NaN));
  assert.equal(broken.state, "lost");
  assert.equal(broken.yawRate, 0);
  // And the controller comes back, rather than smoothing NaN for ever.
  const seen = holdGaze(c, 25, 0, t + 1, 0.4);
  assert.ok(Number.isFinite(seen.yawRate) && seen.yawRate > 0);
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
