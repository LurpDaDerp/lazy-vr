/* Steering: readings -> view (spec section 5). Each test drives a Steering with a
 * simulated camera (30 Hz readings, 40 ms capture latency) and display (60 Hz). */

import test from "node:test";
import assert from "node:assert/strict";

import { STEER_DEFAULTS, Steering, trackingLabel } from "../../site/js/steer.js";

const DEG = Math.PI / 180;
const T0 = 1_762_300_000;   // absolute seconds (performance.timeOrigin-scale)

/* A steering instance plus a clock. `run(seconds, input)` ticks at 60 Hz and
 * pushes a reading at 30 Hz; `input(t)` (t = capture time in seconds since this
 * run() began; slightly negative for frames captured before it) returns
 * { yaw, pitch, tracked?, eye? } or null for "no reading this frame". */
function sim(options) {
  const s = new Steering(options);
  const me = {
    s, now: T0, cam: T0, hz: 60, fps: 30, latency: 0.04,
    get yaw() { return s.view.yaw / DEG; },
    get pitch() { return s.view.pitch / DEG; },
    run(seconds, input = still(0, 0), each) {
      const steps = Math.round(seconds * me.hz), start = me.now;
      for (let i = 0; i < steps; i++) {
        me.now += 1 / me.hz;
        while (me.cam <= me.now - me.latency) {
          const r = input(me.cam - start);
          if (r) {
            s.push({
              t: me.cam * 1000,
              tracked: r.tracked !== false,
              reason: r.tracked === false ? "no-face" : "ok",
              head: { yaw: r.yaw, pitch: r.pitch, roll: 0 },
              dist: 60, rms: 0.02,
              eye: r.eye ?? { x: 0, y: 0, valid: false, blink: false },
              latencyMs: 10, rate: 30,
            });
          }
          me.cam += 1 / me.fps;
        }
        s.tick(me.now);
        if (each) each(me, i);
      }
      return me;
    },
  };
  return me;
}

const still = (yaw, pitch, extra = {}) => () => ({ yaw, pitch, ...extra });
const lost = () => ({ yaw: 0, pitch: 0, tracked: false });
const none = () => null;
const eyes = (x, y, valid = true, blink = false) => ({ x, y, valid, blink });

/* Deterministic small jitter, like a real pose estimate at rest. */
function jitter(seed = 1) {
  let s = seed >>> 0;
  return (amp) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return ((s / 2 ** 32) * 2 - 1) * amp;
  };
}

/* A sim already zeroed at (0, 0) and settled. */
function acquired(options) {
  const m = sim(options);
  m.run(1.5, still(0, 0));
  assert.equal(m.s.state, "tracking");
  return m;
}

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected}±${tol}, got ${actual}`);

// -- defaults & helpers ------------------------------------------------------

test("defaults are frozen and match the spec numbers", () => {
  assert.ok(Object.isFrozen(STEER_DEFAULTS));
  assert.ok(Object.isFrozen(STEER_DEFAULTS.oneEuro));
  assert.equal(STEER_DEFAULTS.yawGain, 3);
  assert.equal(STEER_DEFAULTS.yawZone, 20);
  assert.equal(STEER_DEFAULTS.freezeYaw, 45);
  assert.equal(STEER_DEFAULTS.followOmega, 22);
  assert.deepEqual([...STEER_DEFAULTS.eyeYawSpan], [4, 20]);
});

test("trackingLabel names every state", () => {
  for (const st of ["acquiring", "tracking", "turning", "away", "lost", "off"]) {
    assert.ok(trackingLabel(st).length > 0, st);
  }
  assert.equal(trackingLabel("tracking"), trackingLabel("turning"));
  assert.equal(trackingLabel("nonsense"), "");
});

test("a fresh instance is acquiring with the view at the front", () => {
  const s = new Steering();
  assert.equal(s.state, "acquiring");
  assert.deepEqual({ ...s.view }, { yaw: 0, pitch: 0, roll: 0, blur: 0 });
  assert.equal(s.diagnostics().neutral, null);
});

// -- auto-zero ---------------------------------------------------------------

test("auto-zero: neutral is the median of ~20 steady frames, and the view holds meanwhile", () => {
  const j = jitter(7);
  const m = sim();
  const input = () => ({ yaw: 7 + j(0.2), pitch: -3 + j(0.2) });
  m.run(0.5, input, (mm) => {
    assert.equal(mm.s.state, "acquiring");
    assert.equal(mm.s.view.yaw, 0);
    assert.equal(mm.s.view.pitch, 0);
  });
  m.run(0.5, input);
  assert.equal(m.s.state, "tracking");
  const n = m.s.diagnostics().neutral;
  near(n.yaw, 7, 0.2, "neutral yaw");
  near(n.pitch, -3, 0.2, "neutral pitch");
  m.run(1, input);
  near(m.yaw, 0, 1.5, "view yaw at the neutral");
  near(m.pitch, 0, 1.5, "view pitch at the neutral");
});

test("auto-zero does not happen while the head is moving", () => {
  const m = sim();
  m.run(4, (t) => ({ yaw: 20 * Math.sin(2 * Math.PI * 0.5 * t), pitch: 8 * Math.cos(2 * Math.PI * 0.4 * t) }));
  assert.equal(m.s.state, "acquiring");
  assert.equal(m.s.diagnostics().neutral, null);
  assert.equal(m.yaw, 0);
  // ...and it zeroes once the head settles.
  m.run(1.5, still(12, 4));
  assert.equal(m.s.state, "tracking");
  near(m.s.diagnostics().neutral.yaw, 12, 0.3);
});

test("neutral eases toward a small standing offset, but not a deliberate look", () => {
  const m = acquired();
  m.run(60, still(2, 0));
  assert.ok(Math.abs(m.s.diagnostics().cmd.yaw) < 0.6, `cmd ${m.s.diagnostics().cmd.yaw}`);
  const m2 = acquired();
  m2.run(30, still(8, 0));
  near(m2.s.diagnostics().cmd.yaw, 8, 0.05, "outside the band the neutral stays put");
});

test("neutralAdaptTau 0 pins the neutral", () => {
  const m = acquired({ neutralAdaptTau: 0 });
  m.run(20, still(2, 0));
  near(m.s.diagnostics().cmd.yaw, 2, 0.01);
});

// -- signs -------------------------------------------------------------------

test("yaw sign: head right => view.yaw decreases; head up => view.pitch increases", () => {
  const m = acquired();
  m.run(3, still(5, 0));
  assert.ok(m.s.view.yaw < 0, `view.yaw ${m.s.view.yaw}`);
  m.run(3, still(0, 5));
  assert.ok(m.s.view.pitch > 0, `view.pitch ${m.s.view.pitch}`);
  near(m.yaw, 0, 0.5);
});

// -- position zone -------------------------------------------------------------

test("position zone: gain x3 (x sensitivity), springs back to 0 when the head returns", () => {
  const m = acquired();
  m.run(3, still(10, 5));
  near(m.yaw, -30, 0.5, "yaw");
  near(m.pitch, 15, 0.5, "pitch");
  assert.equal(m.s.state, "tracking");
  m.run(3, still(0, 0));
  near(m.yaw, 0, 0.5, "yaw back");
  near(m.pitch, 0, 0.5, "pitch back");

  m.s.configure({ sensitivity: 2 });
  m.run(3, still(5, -5));
  near(m.yaw, -30, 0.5, "sensitivity yaw");
  near(m.pitch, -30, 0.5, "sensitivity pitch");
});

test("pitch is position-only: clamped at its zone, no rate, view pitch within the limit", () => {
  const m = acquired();
  m.run(3, still(0, 32));
  near(m.pitch, 75, 0.5);
  assert.equal(m.s.offset.pitch, 0);
  m.s.configure({ sensitivity: 2 });
  m.run(2, still(0, 32));
  near(m.pitch, 85, 1e-9, "viewPitchLimit");
});

test("continuity at the zone edge: a slow sweep through 20 deg never jumps the view", () => {
  const m = acquired();
  let prev = m.yaw, maxStep = 0;
  m.run(3, (t) => ({ yaw: Math.min(30, 10 * t), pitch: 0 }), (mm) => {
    maxStep = Math.max(maxStep, Math.abs(mm.yaw - prev));
    prev = mm.yaw;
  });
  // 10 deg/s of head is 30 deg/s of view: 0.5 deg per frame, plus slack for the
  // rate's smooth onset.
  assert.ok(maxStep < 1, `max step ${maxStep}`);
  assert.equal(m.s.diagnostics().pos.yaw, 60, "position term saturates at gain x zone");
});

// -- rate zone -----------------------------------------------------------------

test("rate dwell: a quick pass through the rate zone barely turns the view", () => {
  const m = acquired();
  // 0 -> 40 -> 0 in 0.2 s.
  m.run(0.4, (t) => {
    const u = t;
    return { yaw: u > 0 && u < 0.2 ? 40 * (1 - Math.abs(u - 0.1) / 0.1) : 0, pitch: 0 };
  });
  m.run(2, still(0, 0));
  assert.ok(Math.abs(m.s.offset.yaw) < 2, `offset ${m.s.offset.yaw}`);
  near(m.yaw, m.s.offset.yaw, 0.5);
});

test("looking away fast (to 60 deg) passes the rate zone without turning more than a few degrees", () => {
  const m = acquired();
  m.run(0.1, still(0, 0));
  m.run(1, (t) => ({ yaw: Math.min(60, Math.max(0, t) * 600), pitch: 0 }));
  assert.equal(m.s.state, "away");
  assert.ok(Math.abs(m.s.offset.yaw) < 3, `offset ${m.s.offset.yaw}`);
  // Coming back fast through the zone again: still no turn.
  m.run(2, still(0, 0));
  assert.ok(Math.abs(m.s.offset.yaw) < 3, `offset after return ${m.s.offset.yaw}`);
  assert.equal(m.s.state, "tracking");

  // A natural glance (150 deg/s out to 60 and back): without the dwell this
  // turns the view ~18 deg; with it, not at all.
  const g = acquired();
  g.run(1, (t) => ({ yaw: Math.min(60, Math.max(0, t) * 150), pitch: 0 }));
  g.run(1.5, (t) => ({ yaw: Math.max(0, 60 - Math.max(0, t) * 150), pitch: 0 }));
  assert.ok(Math.abs(g.s.offset.yaw) < 1, `glance offset ${g.s.offset.yaw}`);
  near(g.yaw, 0, 0.5);
});

test("held past the zone the view keeps turning: full 360 and beyond, smoothly", () => {
  const m = acquired();
  m.run(1, still(40, 0));
  assert.equal(m.s.state, "turning");
  const start = m.yaw;
  let prev = m.yaw, maxStep = 0, rising = 0;
  m.run(5, still(40, 0), (mm) => {
    const step = mm.yaw - prev;
    if (step > 1e-9) rising++;
    maxStep = Math.max(maxStep, Math.abs(step));
    prev = mm.yaw;
  });
  // 90 deg/s at full rate (|h| = 40 >= rateFull).
  near(start - m.yaw, 450, 10, "five seconds of turning");
  assert.ok(m.s.view.yaw < -2 * Math.PI, "past a full turn");
  assert.equal(rising, 0, "monotonic");
  assert.ok(maxStep < 90 / 60 + 0.1, `max step ${maxStep}`);
  near(m.s.diagnostics().rate, -90, 1e-9);
});

test("turn speed scales the rate; the rate ramps in smoothly above the zone edge", () => {
  const m = acquired({ turnSpeed: 0.5 });
  m.run(1, still(40, 0));
  near(m.s.diagnostics().rate, -45, 1e-9);
  const m2 = acquired();
  m2.run(1.5, still(27.5, 0));   // halfway between yawZone and rateFull
  near(m2.s.diagnostics().rate, -45, 0.5);
});

test("turning left turns the view left (yaw increases); returning stops the rate and keeps the offset", () => {
  const m = acquired();
  m.run(2, still(-40, 0));
  assert.ok(m.s.offset.yaw > 50);
  const off = m.s.offset.yaw;
  m.run(2, still(0, 0));
  assert.ok(m.s.offset.yaw - off < 15, "rate stops once the head is back inside");
  assert.equal(m.s.state, "tracking");
  near(m.yaw, m.s.offset.yaw, 0.5, "view rests on the offset");
});

// -- freeze: away --------------------------------------------------------------

test("freeze beyond 45 deg yaw with hysteresis (exit below 40)", () => {
  const m = acquired();
  m.run(3, still(10, 0));
  m.run(1, still(50, 0));
  assert.equal(m.s.state, "away");
  const held = m.yaw, off = m.s.offset.yaw;
  m.run(1, still(55, 0));
  near(m.yaw, held, 1e-3, "view held");
  assert.equal(m.s.offset.yaw, off, "offset held, rate stopped");
  m.run(2, still(42, 0));
  assert.equal(m.s.state, "away", "still away between exit and enter");
  near(m.yaw, held, 1e-3);
  m.run(0.5, still(38, 0));
  assert.notEqual(m.s.state, "away");
});

test("freeze beyond 35 deg pitch with hysteresis (exit below 30)", () => {
  const m = acquired();
  m.run(2, still(0, 37));
  assert.equal(m.s.state, "away");
  m.run(1, still(0, 32));
  assert.equal(m.s.state, "away");
  m.run(1, still(0, 28));
  assert.equal(m.s.state, "tracking");
  near(m.pitch, 75, 0.5);
  m.run(2, still(0, -38));
  assert.equal(m.s.state, "away");
});

test("leaving 'away' glides back and restarts the rate dwell", () => {
  const m = acquired();
  m.run(2, still(60, 0));
  assert.equal(m.s.state, "away");
  const off = m.s.offset.yaw;
  // Back to 38 (rate zone, full rate): no instant spin from an old dwell timer.
  let firstTurning = null;
  m.run(1, still(38, 0), (mm) => { if (firstTurning === null && mm.s.state === "turning") firstTurning = mm.now; });
  assert.ok(firstTurning !== null);
  const dwellStart = m.now - 1;
  assert.ok(firstTurning - dwellStart >= 0.15, `rate began ${firstTurning - dwellStart}s after return`);
  assert.ok(m.s.offset.yaw < off);
});

// -- freeze: lost / stale ------------------------------------------------------

test("a single dropped frame does not freeze", () => {
  const m = acquired();
  m.run(2, still(10, 0));
  let k = 0;
  m.run(1, (t) => (k++ === 10 ? { yaw: 0, pitch: 0, tracked: false } : { yaw: 10, pitch: 0 }), (mm) => {
    assert.equal(mm.s.state, "tracking");
  });
  near(m.yaw, -30, 0.5);
});

test("an untracked reading never moves anything", () => {
  const m = acquired();
  m.run(3, still(10, 0));
  const before = m.yaw;
  m.run(0.3, () => ({ yaw: -40, pitch: 30, tracked: false }));
  near(m.yaw, before, 1e-3);
  assert.equal(m.s.state, "tracking", "not stale yet");
});

test("lost after staleAfter of untracked readings, or of no readings; the view holds", () => {
  for (const gone of [lost, none]) {
    const m = acquired();
    m.run(3, still(10, 0));
    const held = m.yaw;
    m.run(0.4, gone);
    assert.equal(m.s.state, "tracking", `${gone.name}: not yet`);
    m.run(0.3, gone);
    assert.equal(m.s.state, "lost", gone.name);
    m.run(2, gone);
    near(m.yaw, held, 1e-3, `${gone.name}: held`);
    assert.equal(m.s.diagnostics().neutral.yaw, 0, "the neutral survives a loss");
  }
});

test("a face lost mid-turn stops the rate at once and holds the offset", () => {
  const m = acquired();
  m.run(1.5, still(40, 0));
  assert.equal(m.s.state, "turning");
  m.run(0.05, lost);
  const off = m.s.offset.yaw;
  m.run(1.5, lost);
  near(m.s.offset.yaw, off, 1e-9);
  assert.equal(m.s.state, "lost");
});

test("resume after loss glides (resumeOmega) instead of snapping", () => {
  const m = acquired();
  m.run(3, still(10, 0));
  m.run(1, lost);
  assert.equal(m.s.state, "lost");
  near(m.yaw, -30, 0.5);
  // Face back at the neutral: target 0. Compare with an unfrozen follower.
  m.run(0.1, still(0, 0));
  assert.equal(m.s.state, "tracking");
  const covered = (m.yaw + 30) / 30;
  assert.ok(covered > 0.05 && covered < 0.4, `covered ${covered} in 0.1 s`);
  m.run(1.5, still(0, 0));
  near(m.yaw, 0, 0.5);
});

test("stale detection compares reading capture time with tick time on one clock", () => {
  const m = acquired();
  m.latency = 0.3;   // slow but alive: never stale
  m.run(2, still(5, 0), (mm) => assert.notEqual(mm.s.state, "lost"));
  m.latency = 0.7;   // every reading older than staleAfter
  m.run(1, still(5, 0));
  assert.equal(m.s.state, "lost");
});

// -- eye offset ----------------------------------------------------------------

function eyeSim(options) {
  const m = acquired(options);
  return { m, look: (x, y, secs = 1.5, valid = true, blink = false) => m.run(secs, still(0, 0, { eye: eyes(x, y, valid, blink) })) };
}

test("eye offset: linear span map, sign kept, bounded to +-10 / +-6", () => {
  const { m, look } = eyeSim();
  look(8, 0);
  near(m.s.eyeView.yaw, 2.5, 0.01, "8 deg -> (8-4)/16*10");
  near(m.yaw, -2.5, 0.05, "eyes right turn the view right");
  look(40, 40);
  near(m.s.eyeView.yaw, 10, 0.01);
  near(m.s.eyeView.pitch, 6, 0.01);
  near(m.pitch, 6, 0.05);
  look(-40, -40);
  near(m.s.eyeView.yaw, -10, 0.01);
  near(m.s.eyeView.pitch, -6, 0.01);
  look(1e6, -1e6);
  assert.ok(Math.abs(m.s.eyeView.yaw) <= 10 && Math.abs(m.s.eyeView.pitch) <= 6);
});

test("eye deadzone has hysteresis: enter above 5, exit below 3", () => {
  const { m, look } = eyeSim();
  look(4.8, 4.8);
  near(m.s.eyeView.yaw, 0, 1e-6, "4.8 from rest: not entered");
  look(6, 6);
  near(m.s.eyeView.yaw, 1.25, 0.01, "entered");
  look(4.8, 4.8);
  near(m.s.eyeView.yaw, 0.5, 0.01, "4.8 once entered: still active");
  near(m.s.eyeView.pitch, (0.8 / 10) * 6, 0.01);
  look(2.5, 2.5);
  look(4.8, 4.8);
  near(m.s.eyeView.yaw, 0, 1e-6, "left below 3, so 4.8 is inside again");
});

test("eye offset springs back with eyeReturnTau when the eyes re-centre", () => {
  const { m, look } = eyeSim();
  look(20, 0);
  near(m.s.eyeView.yaw, 10, 0.01);
  look(0, 0, 0.15);
  // One tau, minus up to one camera frame + latency before the reading lands.
  assert.ok(m.s.eyeView.yaw < 6 && m.s.eyeView.yaw > 2, `after 0.15 s: ${m.s.eyeView.yaw}`);
  look(0, 0, 1);
  near(m.s.eyeView.yaw, 0, 0.01);
  near(m.yaw, 0, 0.05, "view back on the head heading");
});

test("eye offset is 0 when invalid, with eyeAssist off, or with the head past the yaw zone", () => {
  const { m, look } = eyeSim();
  look(20, 14);
  look(20, 14, 1, false);
  near(m.s.eyeView.yaw, 0, 0.05, "invalid");
  const off = eyeSim({ eyeAssist: false });
  off.look(20, 14);
  near(off.m.s.eyeView.yaw, 0, 1e-9, "eyeAssist off");
  const far = eyeSim();
  far.look(20, 0);
  far.m.run(1.5, still(30, 0, { eye: eyes(20, 0) }));
  near(far.m.s.eyeView.yaw, 0, 0.01, "rate zone");
});

test("a blink holds the eye offset; a long closure releases it", () => {
  const { m, look } = eyeSim();
  look(20, 0);
  look(0, 0, 0.3, false, true);
  near(m.s.eyeView.yaw, 10, 0.01, "held through a 0.3 s blink");
  look(20, 0, 0.5);
  look(0, 0, 1.5, false, true);
  near(m.s.eyeView.yaw, 0, 0.05, "released after eyeBlinkHold");
});

test("the eye term springs back while frozen", () => {
  const { m, look } = eyeSim();
  look(20, 0);
  m.run(1.5, lost);
  assert.equal(m.s.state, "lost");
  near(m.s.eyeView.yaw, 0, 0.05);
});

// -- invert ----------------------------------------------------------------------

test("invertYaw / invertPitch flip the head, eye and rate contributions per axis", () => {
  const m = acquired({ invertYaw: true });
  m.run(3, still(10, 5));
  near(m.yaw, 30, 0.5);
  near(m.pitch, 15, 0.5);
  m.run(2, still(40, 0));
  assert.ok(m.s.offset.yaw > 40, "rate also flipped");

  const p = acquired({ invertPitch: true });
  p.run(3, still(10, 5, { eye: eyes(0, 14) }));
  near(p.yaw, -30, 0.5);
  near(p.pitch, -15 - 6, 0.5);
});

test("flipping invert live glides instead of snapping", () => {
  const m = acquired();
  m.run(3, still(10, 0));
  m.s.configure({ invertYaw: true });
  m.run(1 / 60, still(10, 0));
  assert.ok(m.yaw < -25, `one frame later ${m.yaw}`);
  m.run(2, still(10, 0));
  near(m.yaw, 30, 0.5);
});

// -- recenter --------------------------------------------------------------------

test("recenter with a steady head: neutral := current pose, offsets cleared, view sweeps home", () => {
  const m = acquired();
  m.run(1.5, still(-40, 0));        // build a rate offset
  m.s.drag(0, 20);
  m.run(3, still(10, 0));
  assert.ok(m.s.offset.yaw !== 0);
  m.s.recenter();
  assert.equal(m.s.offset.yaw, 0);
  assert.equal(m.s.offset.pitch, 0);
  near(m.s.diagnostics().neutral.yaw, 10, 0.05);
  const start = m.yaw;
  m.run(0.1, still(10, 0));
  assert.ok(Math.abs(m.yaw - start) < Math.abs(start) * 0.4 + 0.5, "glides, not snaps");
  m.run(2, still(10, 0));
  const k = Math.round(m.s.view.yaw / (2 * Math.PI));
  near(m.s.view.yaw - k * 2 * Math.PI, 0, 0.01, "front (modulo whole turns)");
  near(m.pitch, 0, 0.1);
  assert.equal(m.s.state, "tracking");
});

test("recenter after several laps takes the short way round", () => {
  const m = acquired();
  m.run(6, still(40, 0));            // > 400 deg of turning
  m.run(1.5, still(0, 0));
  const start = m.yaw;
  assert.ok(start < -360);
  m.s.recenter();
  let maxStep = 0, prev = m.yaw;
  m.run(2, still(0, 0), (mm) => { maxStep = Math.max(maxStep, Math.abs(mm.yaw - prev)); prev = mm.yaw; });
  assert.ok(Math.abs(m.yaw - start) <= 180, `travelled ${m.yaw - start}`);
  near(m.yaw - 360 * Math.round(m.yaw / 360), 0, 0.5);
  assert.ok(maxStep < 10, "continuous output, no 360 jump");
});

test("recenter while moving, untracked, or looking far off re-acquires", () => {
  const cases = {
    moving: (m) => m.run(0.3, (t) => ({ yaw: 60 * t, pitch: 0 })),
    untracked: (m) => m.run(0.1, lost),
    keyboard: (m) => m.run(3, still(0, -30)),
  };
  for (const [name, setup] of Object.entries(cases)) {
    const m = acquired();
    setup(m);
    m.s.recenter();
    assert.equal(m.s.state, "acquiring", name);
    assert.equal(m.s.diagnostics().neutral, null, name);
    m.run(2, still(3, 2));
    assert.equal(m.s.state, "tracking", `${name}: re-acquired`);
    near(m.yaw, 0, 0.5, name);
  }
});

// -- tracking off / on ---------------------------------------------------------

test("tracking off: state off, head and eye terms glide out over ~0.6 s, drag still works", () => {
  const m = acquired();
  m.run(3, still(10, 0, { eye: eyes(20, 0) }));
  m.s.drag(20, 0);
  m.run(1, still(10, 0, { eye: eyes(20, 0) }));
  near(m.yaw, 20 - 30 - 10, 0.6);   // offset - head term - eye term
  m.s.setEnabled(false);
  assert.equal(m.s.state, "off");
  m.run(1 / 60, still(10, 0));
  assert.ok(m.yaw < 0, "no snap");
  m.run(0.6, (t) => ({ yaw: 30 * Math.sin(t * 5), pitch: 0 }));
  assert.ok(Math.abs(m.yaw - 20) < 3, `after 0.6 s: ${m.yaw}`);
  m.run(1, (t) => ({ yaw: 30 * Math.sin(t * 5), pitch: 10 }));
  near(m.yaw, 20, 0.05, "offset only; head ignored");
  near(m.pitch, 0, 0.05);
  m.s.drag(-15, 5);
  m.run(1, still(10, 0));
  near(m.yaw, 5, 0.05);
  near(m.pitch, 5, 0.05);
  assert.equal(m.s.state, "off");
});

test("tracking back on re-acquires the neutral", () => {
  const m = acquired();
  m.run(1, still(10, 0));
  m.s.setEnabled(false);
  m.run(1, still(10, 0));
  m.s.setEnabled(true);
  assert.equal(m.s.state, "acquiring");
  assert.equal(m.s.diagnostics().neutral, null);
  m.run(1.5, still(10, 0));
  assert.equal(m.s.state, "tracking");
  near(m.s.diagnostics().neutral.yaw, 10, 0.1);
  near(m.yaw, 0, 0.5);
  m.s.setEnabled(true);   // no-op when already on
  assert.equal(m.s.state, "tracking");
});

test("configure({enabled}) goes through setEnabled; the constructor honours it", () => {
  const s = new Steering({ enabled: false });
  assert.equal(s.state, "off");
  s.configure({ enabled: true });
  assert.equal(s.state, "acquiring");
});

// -- drag ------------------------------------------------------------------------

test("drag adds view-space degrees to the offset in every state", () => {
  const m = sim();
  m.s.drag(15, 10);
  m.run(1, none);
  assert.equal(m.s.state, "acquiring");
  near(m.yaw, 15, 0.01);
  near(m.pitch, 10, 0.01);

  const a = acquired();
  a.run(1, still(60, 0));
  assert.equal(a.s.state, "away");
  const held = a.yaw;
  a.s.drag(10, 0);
  a.run(1, still(60, 0));
  near(a.yaw, held + 10, 0.01, "away");

  const l = acquired();
  l.run(1, lost);
  l.s.drag(-10, 0);
  l.run(1, lost);
  near(l.yaw, -10, 0.01, "lost");
});

test("drag pitch never pushes the composed pitch past the limit, nor hides offset beyond it", () => {
  const m = sim();
  m.s.drag(0, 200);
  m.run(1, none);
  near(m.pitch, 85, 1e-6);
  m.s.drag(0, -10);
  m.run(1, none);
  near(m.pitch, 75, 1e-6, "comes straight back down");

  const h = acquired();
  h.run(3, still(0, 28));          // head term 75
  h.s.drag(0, 50);
  near(h.s.offset.pitch, 10, 0.01);
  h.run(3, still(0, 0));
  near(h.pitch, 10, 0.5);
});

// -- follower & robustness -----------------------------------------------------

test("follower is stable and does not overshoot at dt = 0.1 s and beyond", () => {
  const m = acquired();
  m.hz = 10;
  let min = 0;
  m.run(5, still(10, 0), (mm) => { min = Math.min(min, mm.yaw); });
  near(m.yaw, -30, 0.5);
  assert.ok(min > -31, `overshoot to ${min}`);
  // A 10 s stall (tab hidden) is clamped to one 0.1 s step.
  m.now += 10;
  m.s.tick(m.now);
  assert.ok(Number.isFinite(m.s.view.yaw));
});

test("tick ignores NaN, infinite and backwards time; the first tick only seeds the clock", () => {
  const s = new Steering();
  s.drag(30, 0);
  assert.equal(s.tick(T0), s.view);
  assert.equal(s.view.yaw, 0, "first tick: no step");
  s.tick(NaN); s.tick(Infinity); s.tick(-Infinity); s.tick(T0 - 1); s.tick(T0);
  assert.equal(s.view.yaw, 0);
  s.tick(T0 + 0.05);
  assert.ok(s.view.yaw > 0);
});

test("NaN robustness: junk readings, settings and drags never poison the view", () => {
  const m = acquired();
  const t = () => m.cam * 1000;
  const junk = [
    null, undefined, 42, "x", {}, { t: NaN }, { t: Infinity },
    { t: t() + 1, tracked: true },
    { t: t() + 2, tracked: true, head: { yaw: NaN, pitch: 0 } },
    { t: t() + 3, tracked: true, head: { yaw: 0, pitch: Infinity } },
    { t: t() + 4, tracked: true, head: { yaw: 0, pitch: 0 }, eye: { x: NaN, y: 1, valid: true } },
    { t: t() + 5, tracked: true, head: { yaw: 0, pitch: 0 }, eye: null },
    { t: t() + 6, tracked: "yes", head: { yaw: 40, pitch: 0 } },
  ];
  for (const r of junk) m.s.push(r);
  m.s.configure({ yawGain: NaN, sensitivity: Infinity, maxRate: -5, eyeYawSpan: [5, 1],
    oneEuro: { minCutoff: NaN }, invertYaw: "yes", neutralFrames: NaN });
  m.s.configure(null);
  m.s.drag(NaN, Infinity);
  m.s.drag(undefined, undefined);
  m.cam += 0.01;
  m.run(2, still(5, 0));
  for (const v of Object.values(m.s.view)) assert.ok(Number.isFinite(v));
  near(m.yaw, -15, 0.5);
  assert.equal(m.s.options.yawGain, 3);
  assert.equal(m.s.options.sensitivity, 1);
  assert.equal(m.s.options.maxRate, 90);
  assert.deepEqual(m.s.options.eyeYawSpan, [4, 20]);
  assert.equal(m.s.options.invertYaw, false);
});

test("readings out of time order (or duplicated) are ignored", () => {
  const m = acquired();
  m.run(3, still(10, 0));
  const t = m.cam * 1000;
  m.s.push({ t, tracked: true, head: { yaw: 10, pitch: 0 }, eye: eyes(0, 0, false) });
  for (const late of [t - 500, t]) {
    m.s.push({ t: late, tracked: true, head: { yaw: -40, pitch: 30 }, eye: eyes(0, 0, false) });
  }
  m.cam = t / 1000 + 1 / 30;
  m.run(0.5, still(10, 0));
  near(m.yaw, -30, 0.5);
  near(m.s.diagnostics().head.yaw, 10, 0.05);
});

test("reset forgets the neutral, offsets and view", () => {
  const m = acquired();
  m.run(2, still(40, 0));
  m.s.drag(5, 5);
  m.s.reset();
  assert.equal(m.s.state, "acquiring");
  assert.equal(m.s.view.yaw, 0);
  assert.equal(m.s.view.pitch, 0);
  assert.equal(m.s.offset.yaw, 0);
  assert.equal(m.s.diagnostics().neutral, null);
  // Readings of the new session are accepted even though the clock carried on.
  m.run(1.5, still(3, 3));
  assert.equal(m.s.state, "tracking");
});

test("diagnostics reuse one object and report the spec fields", () => {
  const m = acquired();
  m.run(1.5, still(30, 4, { eye: eyes(10, 0) }));
  const d = m.s.diagnostics();
  assert.equal(m.s.diagnostics(), d);
  assert.equal(d.state, "turning");
  near(d.head.yaw, 30, 0.1);
  near(d.cmd.yaw, 30, 0.1);
  near(d.cmd.pitch, 4, 0.1);
  near(d.eye.x, 10, 1e-9, "the input is reported...");
  near(d.eyeView.yaw, 0, 0.01, "...but ignored past the yaw zone");
  assert.ok(d.rate < 0);
  assert.ok(d.offset.yaw < 0);
  assert.deepEqual(Object.keys(d.neutral).sort(), ["pitch", "yaw"]);
  for (const k of ["head", "cmd", "eye", "eyeView", "offset", "rate", "state", "neutral"]) assert.ok(k in d, k);
});
