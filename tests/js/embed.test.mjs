/* The embed engine's testable parts: the view mapping, the send gate, and
 * the one player that carries every video the page ever plays. */

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

test("gate: a new field of view opens it with the view standing still", () => {
  // Nothing nudges the field of view on its own, so judging it by the same
  // tenth-of-a-degree threshold as the angles left a fresh one sitting
  // unsent until the body happened to drift -- and a viewer working the
  // slider is holding still to see what it does.
  const a = { yaw: 120, pitch: 10, roll: 1, fov: 75 };
  assert.ok(!movedEnough(a, { ...a }));
  assert.ok(movedEnough(a, { ...a, fov: 90 }));
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

test("a cue the player cannot take yet leaves no pending cue behind", async () => {
  // A player built by an open that timed out is a YT.Player with none of its
  // methods.  The throw used to escape the promise executor with pendingCue
  // still standing -- and that stale record swallows the next onError and
  // fires its own timer into somebody else's cue a quarter of a minute on.
  const { player } = reused();
  player.player.cueVideoById = () => { throw new TypeError("cueVideoById is not a function"); };
  await assert.rejects(player.open("abc123"), /cueVideoById/);
  assert.equal(player.pendingCue, null);
});

test("steer: a new field of view reaches the player without waiting for a turn", () => {
  const sent = [];
  const player = new EmbedPlayer({ clientWidth: 1280, clientHeight: 720, appendChild() {} });
  player.player = { setSphericalProperties: (props) => sent.push(props), getIframe: () => null };
  const view = { yaw: 0, pitch: 0, roll: 0 };
  player.steer(view);
  player.steer(view);
  assert.equal(sent.length, 1, "a still view sends nothing");
  player.fov = 100;
  player.steer(view);
  assert.equal(sent.length, 2, "the slider was left waiting on the body");
  assert.equal(sent[1].fov, 100);
});

// -- the very first pick, which builds the player ---------------------------

/* A stand-in for youtube's iframe API, so the build branch of open() can be
 * driven from here.  A real YT.Player has none of its methods until it
 * reports ready, which is exactly what the next two tests turn on. */
const builds = [];

globalThis.document = { createElement: () => ({}), head: { appendChild() {} } };
globalThis.location = { origin: "https://lazyvr.test" };  // playerVars carries it
window.YT = {
  PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: function (mount, options) {
    const build = { events: options.events, videoId: options.videoId, ready: false, stopped: 0, cued: [] };
    this.getIframe = () => null;
    this.stopVideo = () => {
      if (!build.ready) throw new Error("the player has no methods until it is ready");
      build.stopped += 1;
    };
    this.cueVideoById = (id) => {
      if (!build.ready) throw new Error("the player has no methods until it is ready");
      build.cued.push(id);
    };
    builds.push(build);
  },
};

function firstPick() {
  builds.length = 0;
  return new EmbedPlayer({ clientWidth: 1280, clientHeight: 720, appendChild() {} });
}

test("a build let go of before it finishes is stopped, not left autoplaying", async () => {
  // Escape while youtube's script and player were still coming up: close()
  // ran when there was nothing yet to stop, and playerVars carries autoplay,
  // so the player arrived talking -- in a library where the chrome is gone,
  // the overlay is down and nothing was left to pause it.
  const player = firstPick();
  const opening = player.open("abc123");
  await new Promise((r) => setTimeout(r, 0));
  const build = builds[0];
  assert.ok(build, "the player was never built");

  player.close();
  build.ready = true;
  build.events.onReady();

  await assert.rejects(opening, /let go of/);
  assert.equal(build.stopped, 1);
});

test("a build nobody let go of is left to play", async () => {
  const player = firstPick();
  const opening = player.open("abc123");
  await new Promise((r) => setTimeout(r, 0));
  const build = builds[0];
  build.ready = true;
  build.events.onReady();
  await opening;
  assert.equal(build.stopped, 0);
});

test("two picks racing youtube's script build one player, not two", async () => {
  // this.player is only assigned once the build finishes, so a second pick
  // that started inside the iframe_api download used to sail past the reuse
  // check and construct a second YT.Player -- a second mount in #embed, and
  // the first player's iframe, message listeners and workers orphaned for
  // the life of the page.
  const player = firstPick();
  const first = player.open("abc123");
  const second = player.open("def456");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(builds.length, 1, `built ${builds.length} players`);
  const build = builds[0];
  build.ready = true;
  build.events.onReady();
  await first;

  // The second pick joined the build and then cued into the one player.
  await new Promise((r) => setTimeout(r, 0));
  player.settleCue();
  await second;
  assert.equal(builds.length, 1);
  assert.deepEqual(build.cued, ["def456"]);
});
