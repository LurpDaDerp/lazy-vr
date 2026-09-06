/* The HUD's pure helpers: what the marks say, and where the neck shows. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PITCH_LIMIT, YAW_LIMIT } from "../../site/js/body.js";
import {
  engineLabel, formatClock, neckEdge, qualityLabel, trackerHealth,
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
  assert.equal(engineLabel("stream"), "Raw stream");
  assert.equal(engineLabel("embed"), "youtube player");
  assert.equal(engineLabel("local"), "This device");
  assert.equal(engineLabel("nonsense"), "");
});

test("tracker: lost beats stale beats one-pass beats fine", () => {
  assert.equal(trackerHealth({ state: "steering", mirror: true, stale: false }), "ok");
  assert.equal(trackerHealth({ state: "holding", mirror: false, stale: false }), "onepass");
  assert.equal(trackerHealth({ state: "steering", mirror: false, stale: true }), "stale");
  assert.equal(trackerHealth({ state: "lost", mirror: true, stale: false }), "lost");
  assert.equal(trackerHealth({ state: "lost", mirror: false, stale: true }), "lost");
  assert.equal(trackerHealth({ state: "low confidence", mirror: true, stale: false }), "dim");
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
