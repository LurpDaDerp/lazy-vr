/* quality.js: 360-correct tier math, the decode cap, and the stall policy. */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_CEILING, K_MAX, LEVEL_HEIGHTS, MISSING_API_CAP, StallMonitor, TIERS,
  chooseTier, decodeCap, layoutScale, qualityCap, requiredWidth, targetTier, tierAtMost,
  tierBelow, tierOf,
} from "../../site/js/quality.js";

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const label = (tier) => tier && tier.label;

// ---- requiredWidth -------------------------------------------------------

test("requiredWidth: 360·W·dpr/hFov", () => {
  near(requiredWidth(1920, 1, 100), 6912);
  near(requiredWidth(1920, 2, 100), 13824);
  near(requiredWidth(1280, 1, 120), 3840);
});

test("requiredWidth: junk in, safe defaults out", () => {
  assert.equal(requiredWidth(0, 1, 100), 0);
  assert.equal(requiredWidth(-5, 1, 100), 0);
  assert.equal(requiredWidth(NaN, 1, 100), 0);
  near(requiredWidth(1000, NaN, 100), 3600);   // dpr → 1
  near(requiredWidth(1000, 0, 100), 3600);
  near(requiredWidth(1000, 1, NaN), 3600);     // fov → 100
  near(requiredWidth(1000, 1, 0), 3600);
});

// ---- ladder ----------------------------------------------------------------

test("ladder: ordered by width, labels map to width for 360", () => {
  for (let i = 1; i < TIERS.length; i += 1) assert.ok(TIERS[i].w > TIERS[i - 1].w);
  const byLabel = Object.fromEntries(TIERS.map((t) => [t.label, t.w]));
  assert.equal(byLabel.hd720, 1280);
  assert.equal(byLabel.hd1080, 1920);
  assert.equal(byLabel.hd1440, 2560);
  assert.equal(byLabel.hd2160, 3840);
  assert.equal(byLabel.highres, 7680);
  for (const t of TIERS) assert.equal(LEVEL_HEIGHTS[t.label], t.h);
  assert.ok(Object.isFrozen(TIERS) && Object.isFrozen(TIERS[0]));
});

test("tierOf: by label, height or object; unknown → null", () => {
  assert.equal(label(tierOf("hd1440")), "hd1440");
  assert.equal(label(tierOf(2160)), "hd2160");
  assert.equal(tierOf(TIERS[3]), TIERS[3]);
  assert.equal(tierOf("hd2880"), null);   // a real label, but not on our ladder
  assert.equal(tierOf("auto"), null);
  assert.equal(tierOf(999), null);
  assert.equal(tierOf(null), null);
});

test("targetTier: smallest tier covering the width, limited by the cap", () => {
  assert.equal(label(targetTier(6912, 2160)), "hd2160");   // 1080p window, auto cap
  assert.equal(label(targetTier(6912, 4320)), "highres");
  assert.equal(label(targetTier(3000, 4320)), "hd2160");
  assert.equal(label(targetTier(2560, 4320)), "hd1440");   // exact width fits
  assert.equal(label(targetTier(2561, 4320)), "hd2160");
  assert.equal(label(targetTier(500, 4320)), "medium");
  assert.equal(label(targetTier(0, 4320)), "tiny");
  assert.equal(label(targetTier(99999, 1080)), "hd1080");
  assert.equal(label(targetTier(99999, null)), "highres");  // uncapped
  assert.equal(label(targetTier(NaN, 2160)), "tiny");
  assert.equal(label(targetTier(6912, "hd1440")), "hd1440"); // cap as label
  assert.equal(label(targetTier(6912, tierOf("hd1080"))), "hd1080");
  assert.equal(label(targetTier(6912, 1700)), "hd1440");     // between rungs → below
  assert.equal(label(targetTier(6912, 10)), "tiny");         // below the ladder
});

test("tierAtMost / tierBelow", () => {
  assert.equal(label(tierAtMost(2160)), "hd2160");
  assert.equal(label(tierAtMost(Infinity)), "highres");
  assert.equal(label(tierBelow(tierOf("highres"))), "hd2160");
  assert.equal(label(tierBelow("hd2160")), "hd1440");
  assert.equal(label(tierBelow(1080)), "hd720");
  assert.equal(tierBelow("tiny"), null);
  assert.equal(tierBelow("nonsense"), null);
});

// ---- caps ------------------------------------------------------------------

test("qualityCap: auto = min(decode, 4K); explicit ≤4K honoured; 8K bounded by decode", () => {
  assert.equal(qualityCap("auto", 4320), AUTO_CEILING);
  assert.equal(qualityCap("auto", 1440), 1440);
  assert.equal(qualityCap(undefined, 2160), 2160);
  assert.equal(qualityCap(1080, 4320), 1080);
  assert.equal(qualityCap("1440", 4320), 1440);
  assert.equal(qualityCap(2160, 1440), 2160);   // the user asked; override
  assert.equal(qualityCap(4320, 4320), 4320);
  assert.equal(qualityCap(4320, 2160), 2160);
  assert.equal(qualityCap(4320, 1440), 1440);
  assert.equal(qualityCap("garbage", 4320), AUTO_CEILING);
  assert.equal(qualityCap("auto", NaN), MISSING_API_CAP);
});

test("chooseTier: the whole decision in one call", () => {
  // 1920 px window at DPR 1, 100° → needs 6912 → auto caps at 4K.
  assert.equal(label(chooseTier({ cssWidth: 1920, dpr: 1, hFov: 100, setting: "auto", decodeCap: 4320 })), "hd2160");
  assert.equal(label(chooseTier({ cssWidth: 1920, dpr: 1, hFov: 100, setting: 4320, decodeCap: 4320 })), "highres");
  // A stall step-down ceiling wins over everything.
  assert.equal(label(chooseTier({ cssWidth: 1920, setting: 4320, decodeCap: 4320, ceiling: "hd1440" })), "hd1440");
  // A small window needs little.
  assert.equal(label(chooseTier({ cssWidth: 320, hFov: 120, decodeCap: 4320 })), "hd720"); // needs 960
  assert.equal(label(chooseTier({ cssWidth: 0 })), "tiny");
  assert.equal(label(chooseTier()), "tiny");
});

test("layoutScale: tier width over CSS width, clamped to [1, K_MAX]", () => {
  assert.equal(layoutScale(1920, 3840), 2);
  assert.equal(layoutScale(1280, 3840), 3);
  assert.equal(layoutScale(800, 7680), K_MAX);
  assert.equal(layoutScale(2560, 1920), 1);
  assert.equal(layoutScale(0, 3840), 1);
  assert.equal(layoutScale(NaN, 3840), 1);
  assert.equal(layoutScale(1920, NaN), 1);
  assert.equal(layoutScale(1000, 3000, 0.5), 1);
});

// ---- decodeCap -------------------------------------------------------------

/* A MediaCapabilities stand-in answering per codec + width. */
function fakeMc(answer) {
  const asked = [];
  return {
    asked,
    decodingInfo(config) {
      asked.push(config);
      return answer(config.video);
    },
  };
}
const yes = { supported: true, smooth: true, powerEfficient: true };
const sw = { supported: true, smooth: true, powerEfficient: false };

test("decodeCap: missing API → 2160", async () => {
  assert.equal(await decodeCap(undefined), MISSING_API_CAP);
  assert.equal(await decodeCap(null), MISSING_API_CAP);
  assert.equal(await decodeCap({}), MISSING_API_CAP);
});

test("decodeCap: 8K needs supported+smooth+powerEfficient for one codec", async () => {
  const mc = fakeMc((v) => Promise.resolve(v.width === 7680 && v.contentType.includes("av01") ? yes : sw));
  assert.equal(await decodeCap(mc), 4320);
  for (const config of mc.asked) assert.equal(config.type, "media-source");
});

test("decodeCap: 4K when 8K is software-only; 1440 when 4K is too", async () => {
  assert.equal(await decodeCap(fakeMc((v) => Promise.resolve(v.width === 3840 ? yes : sw))), 2160);
  assert.equal(await decodeCap(fakeMc(() => Promise.resolve(sw))), 1440);
  assert.equal(await decodeCap(fakeMc(() => Promise.resolve({ supported: false }))), 1440);
});

test("decodeCap: an API that only throws is treated as missing; partial throws do not poison", async () => {
  assert.equal(await decodeCap(fakeMc(() => Promise.reject(new TypeError("bad config")))), MISSING_API_CAP);
  assert.equal(await decodeCap(fakeMc(() => { throw new TypeError("sync"); })), MISSING_API_CAP);
  const mixed = fakeMc((v) => (v.contentType.includes("vp09") ? Promise.reject(new Error("x")) : Promise.resolve(v.width === 3840 ? yes : sw)));
  assert.equal(await decodeCap(mixed), 2160);
});

test("decodeCap: cached per MediaCapabilities object", async () => {
  const mc = fakeMc(() => Promise.resolve(yes));
  const a = decodeCap(mc);
  const b = decodeCap(mc);
  assert.equal(a, b);
  assert.equal(await a, 4320);
  const count = mc.asked.length;
  await decodeCap(mc);
  assert.equal(mc.asked.length, count);
});

test("decodeCap: a query that never answers times out instead of hanging", async () => {
  const mc = fakeMc(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await decodeCap(mc), MISSING_API_CAP);
  assert.ok(Date.now() - started < 5000);
});

// ---- StallMonitor ----------------------------------------------------------

/* Plays from t=0, then stalls at the given times (each followed by PLAYING). */
function stallsAt(monitor, times) {
  const decisions = [];
  for (const t of times) {
    decisions.push(monitor.buffering(t));
    monitor.playing(t + 0.5);
  }
  return decisions;
}

test("stall: three stalls inside a minute step down once", () => {
  const m = new StallMonitor();
  m.buffering(0);            // the initial load
  m.playing(1);
  assert.deepEqual(stallsAt(m, [10, 20, 30]), [false, false, true]);
  assert.equal(m.steps, 1);
});

test("stall: stalls spread over more than a minute do not", () => {
  const m = new StallMonitor();
  m.playing(0);
  assert.deepEqual(stallsAt(m, [10, 50, 75, 140]), [false, false, false, false]);
});

test("stall: buffering before playback starts and in the first 3 s is ignored", () => {
  const m = new StallMonitor();
  assert.equal(m.buffering(0), false);
  m.playing(1);
  assert.deepEqual(stallsAt(m, [1.5, 2.5, 3.5]), [false, false, false]);
  assert.deepEqual(stallsAt(m, [5, 6, 7]), [false, false, true]);
});

test("stall: buffering caused by a seek is not a stall; the excuse expires", () => {
  const m = new StallMonitor();
  m.playing(0);
  for (const t of [10, 20, 30]) {
    m.seeked(t);
    assert.equal(m.buffering(t + 0.2), false);
    m.playing(t + 1);
  }
  assert.equal(m.steps, 0);
  // A seek inside the buffer with no state change: the excuse lapses.
  m.seeked(40);
  assert.deepEqual(stallsAt(m, [50, 51, 52]), [false, false, true]);
});

test("stall: a repeated BUFFERING without PLAYING between counts once", () => {
  const m = new StallMonitor();
  m.playing(0);
  assert.equal(m.buffering(10), false);
  assert.equal(m.buffering(11), false);
  assert.equal(m.buffering(12), false);
  assert.equal(m.stalls.length, 1);
  m.paused(13);
  assert.equal(m.buffering(14), false);
  assert.equal(m.stalls.length, 2);
});

test("stall: after a step, the tier switch's own rebuffer is forgiven, then counting restarts", () => {
  const m = new StallMonitor();
  m.playing(0);
  stallsAt(m, [10, 11, 12]);
  assert.equal(m.steps, 1);
  assert.deepEqual(stallsAt(m, [13, 15, 20]), [false, false, false]); // within 10 s grace
  assert.deepEqual(stallsAt(m, [25, 26, 27]), [false, false, true]);
  assert.equal(m.steps, 2);
});

test("stall: NaN and out-of-order times are ignored; reset starts over", () => {
  const m = new StallMonitor();
  m.playing(0);
  stallsAt(m, [10, 11]);
  assert.equal(m.buffering(NaN), false);
  assert.equal(m.buffering(5), false);      // goes backwards
  assert.equal(m.stalls.length, 2);
  m.reset();
  assert.equal(m.buffering(100), false);    // before playback again
  assert.equal(m.steps, 0);
});
