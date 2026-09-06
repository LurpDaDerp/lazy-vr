/* The HUD's pure helpers: what the marks say, and where the neck shows. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PITCH_LIMIT, YAW_LIMIT } from "../../site/js/body.js";
import {
  HUD_IDLE_MS, engineLabel, formatClock, hudAwake, neckEdge, qualityLabel, trackerHealth,
} from "../../site/js/hud.js";

test("clock: minutes and seconds, hours only when there are some", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(599.6), "10:00");
  assert.equal(formatClock(3661), "1:01:01");
  assert.equal(formatClock(NaN), null);
  assert.equal(formatClock(Infinity), null);
  assert.equal(formatClock(-3), "0:00");
});

test("quality: the tier, with the frame rate only when it is high", () => {
  assert.equal(qualityLabel(2160, 30), "2160p");
  assert.equal(qualityLabel(2160, 60), "2160p60");
  assert.equal(qualityLabel(1080, 59.94), "1080p60");
  assert.equal(qualityLabel(0, 30), null);
  assert.equal(qualityLabel(undefined), null);
});

test("engine: named for the viewer", () => {
  assert.equal(engineLabel("embed"), "youtube player");
  assert.equal(engineLabel("local"), "This device");
  assert.equal(engineLabel("nonsense"), "");
  // The raw-stream engine is gone; nothing may still name it.
  assert.equal(engineLabel("stream"), "");
});

test("tracker: lost beats stale beats one-pass beats fine", () => {
  assert.equal(trackerHealth({ state: "steering", mirror: true, stale: false }), "ok");
  assert.equal(trackerHealth({ state: "holding", mirror: false, stale: false }), "onepass");
  assert.equal(trackerHealth({ state: "steering", mirror: false, stale: true }), "stale");
  assert.equal(trackerHealth({ state: "lost", mirror: true, stale: false }), "lost");
  assert.equal(trackerHealth({ state: "lost", mirror: false, stale: true }), "lost");
  assert.equal(trackerHealth({ state: "low confidence", mirror: true, stale: false }), "dim");
});

/* Watching a clip, pointer long since still: the one state the chrome is
 * allowed to fade in.  Each test below turns exactly one thing on. */
const watching = {
  browsing: false, started: true, calibrated: true,
  settingsOpen: false, paused: false, focused: true,
  sincePointerMs: HUD_IDLE_MS + 1,
};

test("chrome: it fades once the pointer has been still long enough", () => {
  assert.equal(hudAwake(watching), false);
  assert.equal(hudAwake({ ...watching, sincePointerMs: HUD_IDLE_MS - 1 }), true);
  assert.equal(hudAwake({ ...watching, sincePointerMs: 0 }), true);
});

test("chrome: it fades under youtube's player exactly as over the sphere", () => {
  // The engine is not an input any more: the wake catcher reports the
  // pointer over the iframe, so there is nothing left to except.  These
  // two fail the day someone puts an engine exemption back.
  assert.equal(hudAwake({ ...watching, engineMode: "embed" }), false);
  assert.equal(hudAwake({ ...watching, engineMode: "local" }), false);
});

test("chrome: focus in our own iframe still fades; focus lost to another app does not", () => {
  // app.js reads `focused` from document.hasFocus() *or* an active iframe
  // inside #embed, so clicking into youtube's player is not a lost window.
  assert.equal(hudAwake({ ...watching, focused: true }), false);
  assert.equal(hudAwake({ ...watching, focused: false }), true);
});

test("chrome: the library, the calibration, the panel and a pause keep it up", () => {
  assert.equal(hudAwake({ ...watching, browsing: true }), true);
  assert.equal(hudAwake({ ...watching, started: false }), true);
  assert.equal(hudAwake({ ...watching, calibrated: false }), true);
  assert.equal(hudAwake({ ...watching, settingsOpen: true }), true);
  assert.equal(hudAwake({ ...watching, paused: true }), true);
});

test("chrome: an exemption outranks the idle timer, never the other way", () => {
  const forever = { ...watching, sincePointerMs: 1e9 };
  assert.equal(hudAwake({ ...forever, paused: true }), true);
  assert.equal(hudAwake({ ...forever, settingsOpen: true }), true);
  assert.equal(hudAwake(forever), false);
});

test("neck: no strain, no edge", () => {
  assert.equal(neckEdge({ yaw: 100, pitch: 0, strain: 0, freeYaw: false }), null);
});

test("neck: the edge is the side being pushed, at the strain's strength", () => {
  // Body yaw is positive to the viewer's left, pitch positive up.
  assert.deepEqual(neckEdge({ yaw: 110, pitch: 5, strain: 0.6, freeYaw: false }), { side: "left", strength: 0.6 });
  assert.deepEqual(neckEdge({ yaw: -110, pitch: 5, strain: 0.6, freeYaw: false }), { side: "right", strength: 0.6 });
  assert.deepEqual(neckEdge({ yaw: 10, pitch: 95, strain: 0.9, freeYaw: false }), { side: "top", strength: 0.9 });
  assert.deepEqual(neckEdge({ yaw: 10, pitch: -95, strain: 0.9, freeYaw: false }), { side: "bottom", strength: 0.9 });
});

test("neck: the dominant axis is judged against each limit, not in raw degrees", () => {
  // 90 of 120 yaw (0.75) versus 80 of 100 pitch (0.8): pitch wins.
  const edge = neckEdge({ yaw: 90, pitch: 80, strain: 0.5, freeYaw: false });
  assert.equal(edge.side, "top");
  assert.equal(YAW_LIMIT, 120);
  assert.equal(PITCH_LIMIT, 100);
});

test("neck: with yaw free only the vertical limit can show", () => {
  assert.deepEqual(neckEdge({ yaw: 170, pitch: 90, strain: 0.7, freeYaw: true }), { side: "top", strength: 0.7 });
  assert.deepEqual(neckEdge({ yaw: 170, pitch: -90, strain: 0.7, freeYaw: true }), { side: "bottom", strength: 0.7 });
});

test("neck: strength is clamped to the unit range", () => {
  assert.equal(neckEdge({ yaw: 119, pitch: 0, strain: 1.4, freeYaw: false }).strength, 1);
});
