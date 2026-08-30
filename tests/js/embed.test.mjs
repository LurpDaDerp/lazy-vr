/* The embed fallback's pure parts: the view mapping and the send gate. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EMBED_FOV, movedEnough, overscanFor, sphericalFromView } from "../../site/js/embed.js";

const DEG = Math.PI / 180;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("mapping: the player's yaw takes body yaw directly (settled on a live player)", () => {
  for (const yawDeg of [0, 30, -30, 180, 359, -359, 720.5]) {
    const view = { yaw: yawDeg * DEG, pitch: 0, roll: 0 };
    const expected = ((yawDeg % 360) + 360) % 360;
    near(sphericalFromView(view).yaw, expected, 1e-9);
  }
});

test("mapping: yaw always lands in [0, 360)", () => {
  for (const yawDeg of [-1000, -180, 0, 180, 1000]) {
    const { yaw } = sphericalFromView({ yaw: yawDeg * DEG, pitch: 0, roll: 0 });
    assert.ok(yaw >= 0 && yaw < 360, `${yaw}`);
  }
});

test("mapping: pitch is up-positive and clamped to the player's range", () => {
  near(sphericalFromView({ yaw: 0, pitch: 45 * DEG, roll: 0 }).pitch, 45);
  near(sphericalFromView({ yaw: 0, pitch: 120 * DEG, roll: 0 }).pitch, 90);
  near(sphericalFromView({ yaw: 0, pitch: -120 * DEG, roll: 0 }).pitch, -90);
});

test("mapping: roll is clamped and the fov rides along", () => {
  const props = sphericalFromView({ yaw: 0, pitch: 0, roll: 2 * DEG });
  assert.ok(Math.abs(props.roll) <= 180);
  assert.equal(props.fov, EMBED_FOV);
});

test("overscan: the iframe renders at the display's own pixel density", () => {
  near(overscanFor(1920, 1080, 1), 1);
  near(overscanFor(2560, 1440, 2), 2);
});

test("overscan: density is capped so the player's renderer keeps up", () => {
  near(overscanFor(1920, 1080, 3), 2);
  near(overscanFor(640, 360, 1), 1);
});

test("gate: the first send always goes", () => {
  assert.ok(movedEnough(null, { yaw: 0, pitch: 0, roll: 0 }));
});

test("gate: a still view sends nothing", () => {
  const a = { yaw: 120, pitch: 10, roll: 1 };
  assert.ok(!movedEnough(a, { ...a }));
  assert.ok(!movedEnough(a, { yaw: 120.01, pitch: 10, roll: 1 }));
});

test("gate: movement on any axis opens it", () => {
  const a = { yaw: 120, pitch: 10, roll: 1 };
  assert.ok(movedEnough(a, { ...a, yaw: 120.5 }));
  assert.ok(movedEnough(a, { ...a, pitch: 10.5 }));
  assert.ok(movedEnough(a, { ...a, roll: 1.5 }));
});

test("gate: the yaw seam at 0/360 is not movement", () => {
  assert.ok(!movedEnough({ yaw: 359.995, pitch: 0, roll: 0 }, { yaw: 0.005, pitch: 0, roll: 0 }));
  assert.ok(movedEnough({ yaw: 359, pitch: 0, roll: 0 }, { yaw: 1, pitch: 0, roll: 0 }));
});
