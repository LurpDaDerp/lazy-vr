/* The body: acceleration-limited turns, a neck with an end, and the small
 * things that make it read as a head. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  A_MAX, Body, DEG, MAX_ROLL, NECK_COMFORT, PITCH_LIMIT, YAW_LIMIT, neckRadius, neckStrain,
  wrapDegrees,
} from "../../site/js/body.js";

const DT = 1 / 60;
const ask = (yawRate, pitchRate, committed = true) =>
  ({ yawRate, pitchRate, committed, maxRateYaw: 128, maxRatePitch: 96 });

function run(body, yawRate, pitchRate, seconds, each) {
  for (let i = 0; i < seconds * 60; i++) { body.step(ask(yawRate, pitchRate), DT); if (each) each(i); }
  return body;
}
const radius = (body) => Math.hypot(body.yaw / YAW_LIMIT, body.pitch / PITCH_LIMIT);

// -- the turn ----------------------------------------------------------

test("a turn starts gently: a linear ramp while the clamp bites, then a settle", () => {
  const body = new Body();
  const rates = [0];
  run(body, 80, 0, 0.2, () => rates.push(body.yawRate));
  const steps = rates.slice(1).map((r, i) => r - rates[i]);
  // Clamped at first: exactly A_MAX per second.
  assert.ok(Math.abs(steps[0] - A_MAX * DT) < 1e-9 && Math.abs(steps[1] - A_MAX * DT) < 1e-9);
  // Then the spring takes over and the steps shrink monotonically.
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] + 1e-9, `step ${i}`);
});

test("acceleration never exceeds the clamp, and the turn never overshoots", () => {
  const body = new Body();
  let peakAccel = 0, peakRate = 0;
  // Short enough to stay inside the neck's comfort radius.
  run(body, 80, 0, 0.8, () => { peakAccel = Math.max(peakAccel, Math.abs(body.yawAccel)); peakRate = Math.max(peakRate, body.yawRate); });
  assert.ok(peakAccel <= A_MAX + 1e-9);
  assert.ok(peakRate <= 80 + 1e-6);
  assert.ok(body.yawRate > 79);
});

test("it stops faster than it starts", () => {
  const body = new Body();
  const up = [];
  run(body, 80, 0, 0.8, () => up.push(body.yawRate));
  const down = [];
  run(body, 0, 0, 0.8, () => down.push(body.yawRate));
  const rise = up.findIndex((r) => r >= 72), fall = down.findIndex((r) => r <= 8);
  assert.ok(fall < rise, `rise ${rise} fall ${fall}`);
});

test("the roll leans into the turn and relaxes once up to speed", () => {
  const body = new Body();
  const rolls = [];
  run(body, 128, 0, 1.5, () => rolls.push(body.roll));
  const peak = Math.max(...rolls.map(Math.abs));
  assert.ok(peak > 0.5 && peak <= MAX_ROLL + 1e-6);
  assert.ok(Math.abs(rolls.at(-1)) < Math.abs(rolls[10]));
});

test("blur follows speed and is zero at rest", () => {
  const body = new Body();
  body.step(ask(0, 0), DT);
  assert.equal(body.view.blur, 0);
  run(body, 128, 0, 1);
  assert.ok(body.view.blur > 0);
});

test("a frame with no usable time or rate in it leaves the posture alone", () => {
  const body = run(new Body(), 90, 45, 0.5);
  const was = { yaw: body.yaw, pitch: body.pitch, yawRate: body.yawRate, pitchRate: body.pitchRate };
  // The body integrates, so one NaN would be every frame after it too.
  for (const bad of [NaN, Infinity, 0, -DT]) body.step(ask(90, 45), bad);
  assert.deepEqual({ yaw: body.yaw, pitch: body.pitch, yawRate: body.yawRate, pitchRate: body.pitchRate }, was);
  body.step({ yawRate: NaN, pitchRate: undefined, committed: true, maxRateYaw: 128, maxRatePitch: 128 }, DT);
  for (const v of [body.yaw, body.pitch, body.view.yaw, body.view.pitch, body.view.roll, body.view.blur]) {
    assert.ok(Number.isFinite(v), `${v}`);
  }
});

test("wrapDegrees names every bearing once, in [-180, 180)", () => {
  for (const angle of [0, 1, 179, 180, 181, 359, 360, 540, -180, -181, -540, 1e6]) {
    const wrapped = wrapDegrees(angle);
    assert.ok(wrapped >= -180 && wrapped < 180, `${angle} -> ${wrapped}`);
    // The same bearing, not a different one: a whole number of turns apart.
    assert.ok(Math.abs((angle - wrapped) % 360) < 1e-9, `${angle} -> ${wrapped}`);
  }
  assert.equal(wrapDegrees(180), -180);
});

// -- the sway ----------------------------------------------------------

test("it never sits perfectly still, but the sway fades during a turn", () => {
  const body = new Body();
  const idle = [];
  run(body, 0, 0, 40, () => idle.push(body.view.yaw / DEG - body.yaw));
  const range = Math.max(...idle) - Math.min(...idle);
  assert.ok(range > 0.2 && range < 0.6, `sway range ${range}`);
  assert.ok(new Set(idle.map((v) => v.toFixed(4))).size > 100);
  const moving = new Body();
  let worst = 0;
  run(moving, 128, 0, 10, (i) => { if (i > 120 && radius(moving) < 0.4) worst = Math.max(worst, Math.abs(moving.view.yaw / DEG - moving.yaw)); });
  assert.ok(worst < 1e-9, `sway while turning ${worst}`);
});

// -- the neck ----------------------------------------------------------

test("neck: exact hard limits on each axis", () => {
  assert.ok(Math.abs(run(new Body(), 999, 0, 20).yaw - YAW_LIMIT) < 1e-9);
  assert.ok(Math.abs(run(new Body(), -999, 0, 20).yaw + YAW_LIMIT) < 1e-9);
  assert.ok(Math.abs(run(new Body(), 0, 999, 20).pitch - PITCH_LIMIT) < 1e-9);
  assert.ok(Math.abs(run(new Body(), 0, -999, 20).pitch + PITCH_LIMIT) < 1e-9);
});

test("neck: pushed diagonally, neither limit is reached; the ellipse is", () => {
  const body = run(new Body(), 999, 999, 20);
  assert.ok(body.yaw < YAW_LIMIT - 10 && body.pitch < PITCH_LIMIT - 10);
  assert.ok(Math.abs(radius(body) - 1) < 1e-9);
});

test("neck: the ellipse is never exceeded, from any direction", () => {
  for (const [y, p] of [[999, 0], [0, 999], [999, 999], [-999, 300], [300, -999], [50, 999]]) {
    const body = new Body();
    let worst = 0;
    run(body, y, p, 8, () => { worst = Math.max(worst, radius(body)); });
    assert.ok(worst <= 1 + 1e-9, `radius ${worst} for ${y},${p}`);
  }
});

test("neck: free inside the comfort radius, strain climbs steeply after", () => {
  assert.equal(neckStrain(0), 0);
  assert.equal(neckStrain(NECK_COMFORT), 0);
  assert.ok(neckStrain(0.6) < 0.05, "barely there at first");
  assert.ok(neckStrain(0.9) > 0.5);
  assert.equal(neckStrain(1), 1);
  let last = 0;
  for (let r = 0; r <= 1; r += 0.01) { const s = neckStrain(r); assert.ok(s >= last); last = s; }
});

test("neck: the sweep slows progressively as the limit nears", () => {
  const body = new Body();
  const bands = {};
  run(body, 120, 0, 20, () => { const b = Math.min(9, Math.floor(radius(body) * 10)); if (!(b in bands)) bands[b] = body.yawRate; });
  assert.ok(bands[6] > bands[8] && bands[8] > bands[9], JSON.stringify(bands));
  assert.ok(body.yawRate < 1);
  assert.ok(body.strain > 0.999);
});

test("neck: coming back from the limit is free", () => {
  const body = run(new Body(), 999, 0, 20);
  run(body, -120, 0, 1);
  assert.ok(body.yawRate < -110);
});

test("neck: at full yaw a push upward crawls along the limit instead of sweeping", () => {
  const body = run(new Body(), 999, 0, 20);
  run(body, 0, 999, 3);
  assert.ok(Math.hypot(body.yawRate, body.pitchRate) < 30, "crawls");
  assert.ok(body.pitch < 60, "gets nowhere near the top in three seconds");
  assert.ok(Math.abs(radius(body) - 1) < 1e-9, "stays on the boundary");
});

test("neck: the tremor appears only under strain", () => {
  const still = new Body();
  run(still, 0, 0, 5);
  const calm = new Body();
  const pinned = run(new Body(), 999, 0, 20);
  assert.equal(calm.strain, 0);
  assert.ok(pinned.strain > 0.99);
});

test("neckRadius: the outward direction is a unit vector, zero at rest", () => {
  const rest = neckRadius(0, 0);
  assert.equal(rest.r, 0); assert.equal(rest.ux, 0);
  const off = neckRadius(60, 45);
  assert.ok(Math.abs(Math.hypot(off.ux, off.uy) - 1) < 1e-12);
});

// -- recentring --------------------------------------------------------

test("home: sweeps back and arrives, from the limit too", () => {
  const body = run(new Body(), 999, 300, 20);
  assert.ok(body.goHome());
  let frames = 0;
  while (body.homing && frames < 1200) { body.step(ask(0, 0, false), DT); frames++; }
  assert.ok(!body.homing);
  assert.ok(frames / 60 < 4, `took ${frames / 60}s`);
  assert.ok(Math.abs(body.yaw) < 0.01 && Math.abs(body.pitch) < 0.01);
});

test("home: gaze is locked out until the view is home, then obeyed again", () => {
  const body = run(new Body(), 128, 0, 4);
  body.goHome();
  // A committed hard steer mid-sweep changes nothing: R means R.
  for (let i = 0; i < 30; i++) body.step(ask(100, 0, true), DT);
  assert.ok(body.homing);
  let frames = 0;
  while (body.homing && frames < 1200) { body.step(ask(100, 0, true), DT); frames++; }
  assert.ok(!body.homing);
  assert.ok(Math.abs(body.yaw) < 1, `arrived at ${body.yaw}`);
  run(body, 100, 0, 1);
  assert.ok(body.yawRate > 50);
});

test("home: already there is reported rather than started", () => {
  const body = new Body();
  assert.equal(body.goHome(), false);
  assert.ok(!body.homing);
});

test("rest clears everything", () => {
  const body = run(new Body(), 999, 999, 5);
  body.goHome();
  body.rest();
  assert.equal(body.yaw, 0); assert.equal(body.strain, 0); assert.ok(!body.homing);
});

// -- free look ---------------------------------------------------------

test("the pitch limit is 100 degrees", () => {
  assert.equal(PITCH_LIMIT, 100);
  assert.ok(Math.abs(run(new Body(), 0, 999, 20).pitch - 100) < 1e-9);
});

test("free look is off by default: the neck still ends where it did", () => {
  assert.equal(new Body().freeYaw, false);
  assert.ok(Math.abs(run(new Body(), 999, 0, 20).yaw - YAW_LIMIT) < 1e-9);
});

test("free look: yaw runs right past the neck's limit and keeps going", () => {
  const body = new Body();
  body.freeYaw = true;
  let travelled = 0;
  run(body, 128, 0, 10, () => { travelled += Math.abs(body.yawRate) * DT; });
  assert.ok(travelled > 360, `only turned ${travelled.toFixed(0)} degrees`);
  // No strain: the sweep never slows down.
  assert.ok(body.yawRate > 127, `rate sagged to ${body.yawRate}`);
  assert.equal(body.strain, 0);
});

test("free look: yaw stays wrapped into (-180, 180]", () => {
  for (const rate of [128, -128]) {
    const body = new Body();
    body.freeYaw = true;
    let worst = 0;
    run(body, rate, 0, 20, () => { worst = Math.max(worst, Math.abs(body.yaw)); });
    assert.ok(worst <= 180 + 1e-9, `yaw reached ${worst}`);
  }
});

test("free look: pitch still stops dead at its limit", () => {
  for (const rate of [999, -999]) {
    const body = new Body();
    body.freeYaw = true;
    let worst = 0;
    run(body, 0, rate, 20, () => { worst = Math.max(worst, Math.abs(body.pitch)); });
    assert.ok(Math.abs(Math.abs(body.pitch) - PITCH_LIMIT) < 1e-9, `stopped at ${body.pitch}`);
    assert.ok(worst <= PITCH_LIMIT + 1e-9);
    assert.ok(body.strain > 0.999);
  }
});

test("free look: pinned at the top of the pitch slab, yaw is still free", () => {
  const body = new Body();
  body.freeYaw = true;
  run(body, 0, 999, 20);
  assert.ok(body.strain > 0.999, "the pitch slab is taxing");
  run(body, 128, 0, 2);
  assert.ok(body.yawRate > 127, `yaw was taxed too: ${body.yawRate}`);
});

test("free look: recentring takes the short way round", () => {
  const body = new Body();
  body.freeYaw = true;
  // Turn until the view is just past half a circle the long way.
  let spun = 0;
  while (body.yaw > -170 && spun++ < 2400) body.step(ask(-128, 0), DT);
  assert.ok(body.yaw <= -170 && body.yaw >= -180, `stopped at ${body.yaw}`);
  assert.ok(body.goHome());
  let frames = 0;
  while (body.homing && frames < 2400) { body.step(ask(0, 0, false), DT); frames++; }
  assert.ok(!body.homing, "never arrived");
  assert.ok(Math.abs(body.yaw) < 0.01 && Math.abs(body.pitch) < 0.01);
  // Straight back the way it came: never through the far side.
  assert.ok(frames / 60 < 5, `took ${frames / 60}s`);
});

test("free look: rest keeps the setting, and it survives a pass", () => {
  const body = new Body();
  body.freeYaw = true;
  run(body, 999, 0, 5);
  body.rest();
  assert.equal(body.freeYaw, true);
  assert.equal(body.yaw, 0);
});

test("neckRadius: free look drops the yaw term entirely", () => {
  const pinned = neckRadius(119, 50, true);
  assert.equal(pinned.ux, 0);
  assert.ok(Math.abs(pinned.r - 50 / PITCH_LIMIT) < 1e-12);
  assert.ok(Math.abs(pinned.uy - 1) < 1e-12);
  // At dead level there is no outward direction at all.
  assert.equal(neckRadius(170, 0, true).r, 0);
});
