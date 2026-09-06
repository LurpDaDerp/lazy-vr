/* The embed fallback's pure parts: the view mapping and the send gate. */

import assert from "node:assert/strict";
import { test } from "node:test";

// The constructor listens for resize; nothing here needs a real window.
globalThis.window = { addEventListener() {} };

import { EMBED_FOV, EmbedPlayer, movedEnough, overscanFor, sphericalFromView } from "../../site/js/embed.js";

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

test("overscan: the iframe is never built larger than the window", () => {
  // forceBest() pins the tier explicitly, so an oversized iframe buys no
  // quality at all -- it only asks the player to render four times the
  // pixels, which is exactly what made the camera judder.
  for (const dpr of [1, 2, 3]) near(overscanFor(1920, 1080, dpr), 1);
  near(overscanFor(640, 360, 1), 1);
});

test("gate: idle sway does not open it", () => {
  // The body never quite stops; a sway of a tenth of a degree per frame
  // must not become a postMessage per frame for the whole clip.
  const a = { yaw: 120, pitch: 10, roll: 1 };
  assert.ok(!movedEnough(a, { ...a, yaw: 120.06, pitch: 10.04, roll: 1.03 }));
});

test("gate: a real turn still opens it on the very next frame", () => {
  // 128 deg/s -- the fastest turn on offer -- is 2.1 degrees per 60 Hz frame.
  const a = { yaw: 120, pitch: 10, roll: 1 };
  assert.ok(movedEnough(a, { ...a, yaw: 122.1 }));
  // Even a slow 12 deg/s crawl clears it in one frame.
  assert.ok(movedEnough(a, { ...a, yaw: 120.2 }));
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

// -- one player, many videos -----------------------------------------------

/* A live player that has already been built: `open()` takes the reuse
 * branch, which is every pick after the first. */
function reused() {
  const calls = [];
  const player = new EmbedPlayer({ clientWidth: 1280, clientHeight: 720, appendChild() {} });
  player.player = {
    cueVideoById: (id) => calls.push(["cue", id]),
    loadVideoById: (id) => calls.push(["load", id]),
    stopVideo: () => calls.push(["stop"]),
    getIframe: () => null,
  };
  return { player, calls };
}

const pending = (promise) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  return () => done;
};

test("a second video is cued, not loaded: an autoplay would race the hold", async () => {
  // loadVideoById autoplays, and app.js pauses for calibration immediately
  // afterwards.  When the pause lost, the clip played -- audibly -- under
  // the calibration overlay, seconds in by the time the ring filled.
  const { player, calls } = reused();
  const opening = player.open("abc123");
  const settled = pending(opening);
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(calls, [["cue", "abc123"]]);
  assert.equal(settled(), false, "open() resolved before the player had the video");

  player.settleCue();
  await opening;
  assert.equal(settled(), true);
});

test("a session let go of mid-cue is told, not left waiting", async () => {
  const { player } = reused();
  const opening = player.open("abc123");
  await new Promise((r) => setTimeout(r, 0));
  player.close();
  await assert.rejects(opening, /let go of/);
});

test("a cue that is already settled cannot be settled twice", async () => {
  const { player } = reused();
  const opening = player.open("abc123");
  await new Promise((r) => setTimeout(r, 0));
  player.settleCue();
  await opening;
  player.settleCue(new Error("too late"));  // must not throw or reject anything
  assert.equal(player.pendingCue, null);
});
