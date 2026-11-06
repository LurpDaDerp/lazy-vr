import test from "node:test";
import assert from "node:assert/strict";

import { OneEuro, RollingMedian, TimedMedian, clamp, lerp, wrapDegrees } from "../../site/js/filters.js";

test("clamp, lerp", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(lerp(2, 4, 0.25), 2.5);
});

test("wrapDegrees maps into (-180, 180]", () => {
  assert.equal(wrapDegrees(0), 0);
  assert.equal(wrapDegrees(180), 180);
  assert.equal(wrapDegrees(-180), 180);
  assert.equal(wrapDegrees(190), -170);
  assert.equal(wrapDegrees(-190), 170);
  assert.equal(wrapDegrees(720 + 45), 45);
  assert.equal(wrapDegrees(-725), -5);
  assert.ok(Number.isNaN(wrapDegrees(NaN)));
});

test("OneEuro: first sample passes through, converges to a constant", () => {
  const f = new OneEuro({ minCutoff: 1, beta: 0, dCutoff: 1 });
  assert.equal(f.filter(10, 0), 10);
  let y = 0;
  for (let i = 1; i <= 300; i++) y = f.filter(20, i / 30);
  assert.ok(Math.abs(y - 20) < 1e-6, `got ${y}`);
});

test("OneEuro: matches the closed-form low-pass step for beta 0", () => {
  const f = new OneEuro({ minCutoff: 0.5, beta: 0, dCutoff: 1 });
  f.filter(0, 0);
  const dt = 1 / 30;
  const a = 1 / (1 + 1 / (2 * Math.PI * 0.5 * dt));
  assert.ok(Math.abs(f.filter(1, dt) - a) < 1e-12);
});

test("OneEuro: higher beta reduces lag on a ramp", () => {
  const slow = new OneEuro({ minCutoff: 0.4, beta: 0, dCutoff: 1 });
  const fast = new OneEuro({ minCutoff: 0.4, beta: 0.05, dCutoff: 1 });
  let s = 0, q = 0, x = 0;
  for (let i = 0; i < 60; i++) { x = 60 * (i / 30); s = slow.filter(x, i / 30); q = fast.filter(x, i / 30); }
  assert.ok(x - q < x - s);
  assert.ok(x - q < 3, `lag ${x - q}`);
});

test("OneEuro: NaN sample and dt <= 0 leave the state untouched", () => {
  const f = new OneEuro({ minCutoff: 1, beta: 0.1, dCutoff: 1 });
  f.filter(1, 1);
  const before = f.filter(2, 1.1);
  assert.equal(f.filter(NaN, 1.2), before);
  assert.equal(f.filter(100, 1.1), before, "duplicate time");
  assert.equal(f.filter(100, 1.0), before, "time going backwards");
  assert.equal(f.filter(100, NaN), before, "NaN time");
  assert.ok(Number.isFinite(f.filter(3, 1.2)));
});

test("OneEuro: NaN before any sample, reset clears", () => {
  const f = new OneEuro();
  assert.ok(Number.isNaN(f.filter(NaN, 0)));
  assert.equal(f.filter(4, NaN), 4, "unseeded sample with no time passes through");
  assert.ok(!f.initialized);
  f.filter(4, 0);
  assert.ok(f.initialized);
  f.reset();
  assert.ok(!f.initialized);
  assert.equal(f.filter(7, 5), 7);
});

test("RollingMedian: odd/even windows, NaN ignored, reset", () => {
  const m = new RollingMedian(5);
  assert.ok(Number.isNaN(m.median));
  assert.equal(m.push(3), 3);
  assert.equal(m.push(1), 2);
  assert.equal(m.push(100), 3);
  assert.equal(m.push(NaN), 3);
  m.push(2); m.push(4);           // window: 3 1 100 2 4 -> 3
  assert.equal(m.median, 3);
  assert.equal(m.push(-50), 2);   // window: 1 100 2 4 -50 -> 2
  assert.equal(m.push(5), 4);     // window: 100 2 4 -50 5 -> 4
  m.reset();
  assert.ok(Number.isNaN(m.median));
  assert.equal(m.push(9), 9);
});

test("RollingMedian rejects a single spike", () => {
  const m = new RollingMedian(5);
  for (let i = 0; i < 5; i++) m.push(1);
  assert.equal(m.push(1000), 1);
});

test("TimedMedian: window eviction and median", () => {
  const m = new TimedMedian(2);
  m.push(1, 0);
  m.push(5, 0.5);
  assert.equal(m.push(3, 1.0), 3);
  assert.equal(m.count, 3);
  // at t = 2.6 the samples at 0 and 0.5 are older than 2 s
  assert.equal(m.push(10, 2.6), 6.5);
  assert.equal(m.count, 2);
  assert.equal(m.prune(10), NaN, "everything expired");
  assert.equal(m.count, 0);
});

test("TimedMedian: NaN ignored, time going backwards restarts the window", () => {
  const m = new TimedMedian(3);
  m.push(1, 10); m.push(2, 10.1);
  assert.equal(m.push(NaN, 10.2), 1.5);
  assert.equal(m.push(7, 5), 7);
  assert.equal(m.count, 1);
});

test("TimedMedian stays correct over a long run (compaction)", () => {
  const m = new TimedMedian(1);
  let last = NaN;
  for (let i = 0; i < 5000; i++) last = m.push(i % 7, i / 100);
  // last 1 s = 101 samples (t in [48.99, 49.99]); values cycle 0..6
  assert.ok(m.count <= 101 && m.count >= 100);
  assert.ok(last >= 2 && last <= 4);
  assert.ok(m.times.length < 600, "FIFO is compacted");
});
