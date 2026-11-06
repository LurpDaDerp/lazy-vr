/* embed.js: the view mapping, the send gate, layout scaling for quality,
 * and the one-player lifecycle against a fake YouTube IFrame API. */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

// ---- a minimal page ------------------------------------------------------

const listeners = {};
const docListeners = {};
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 720,
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
};
const scripts = [];
function el(tag) {
  return {
    tag, children: [], style: {}, parentNode: null,
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentNode = null; },
  };
}
globalThis.document = {
  createElement: (tag) => el(tag),
  head: { appendChild(tag) { scripts.push(tag); tag.parentNode = this; }, removeChild() {} },
  addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
};
globalThis.location = { origin: "https://lazyvr.test" };

const {
  EmbedPlayer, K_MAX, REFUSALS, iframeApi, movedEnough, refusal, resetIframeApiForTests,
  sphericalFromView, youtubeFov,
} = await import("../../site/js/embed.js");
const { TIERS, tierOf } = await import("../../site/js/quality.js");

const DEG = Math.PI / 180;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- fake YT -------------------------------------------------------------

const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const builds = [];

/* A YT.Player whose methods throw until ready (as a real one has none). */
function FakePlayer(mount, options) {
  const b = {
    mount, options, events: options.events, ready: false, destroyed: false,
    calls: [], iframe: { style: {}, attrs: {} }, state: PS.UNSTARTED,
    time: 0, dur: 0, loaded: 0, quality: "unknown", data: { title: "" },
  };
  builds.push(b);
  const method = (name, fn = () => {}) => {
    this[name] = (...args) => {
      if (!b.ready) throw new TypeError(`${name} is not a function`);
      b.calls.push([name, ...args]);
      return fn(...args);
    };
  };
  method("loadVideoById");
  method("stopVideo");
  method("playVideo");
  method("pauseVideo");
  method("seekTo", (t) => { b.time = t; });
  method("setSize", (w, h) => { b.iframe.attrs = { width: w, height: h }; });
  method("setSphericalProperties");
  method("setVolume");
  method("mute");
  method("unMute");
  method("unloadModule");
  method("getIframe", () => b.iframe);
  method("getPlayerState", () => b.state);
  method("getCurrentTime", () => b.time);
  method("getDuration", () => b.dur);
  method("getVideoLoadedFraction", () => b.loaded);
  method("getPlaybackQuality", () => b.quality);
  method("getVideoData", () => b.data);
  this.destroy = () => { b.destroyed = true; };
  b.player = this;
  b.becomeReady = () => { b.ready = true; b.events.onReady({ target: this }); };
  b.state$ = (s) => { b.state = s; b.events.onStateChange({ data: s }); };
}

function installYT() {
  window.YT = { PlayerState: PS, Player: FakePlayer, loaded: 1 };
}

function container(w = 1280, h = 720) {
  const c = el("div");
  c.clientWidth = w;
  c.clientHeight = h;
  return c;
}

beforeEach(() => {
  builds.length = 0;
  installYT();
  resetIframeApiForTests();
  delete globalThis.requestAnimationFrame;
});

/* A player whose first build has completed. */
async function readyPlayer(opts = {}) {
  const host = container(opts.w, opts.h);
  const player = new EmbedPlayer(host, opts.player);
  if (opts.tier) player.tier = opts.tier;
  const handlers = opts.handlers || {};
  const opening = player.open("first", handlers);
  await tick();
  const b = builds.at(-1);
  b.becomeReady();
  await opening;
  return { player, b, host, handlers };
}

// ---- mapping -------------------------------------------------------------

test("yaw: the player's yaw takes view.yaw directly, wrapped to [0, 360)", () => {
  for (const yawDeg of [0, 30, -30, 180, 359, -359, 720.5, -1000]) {
    const { yaw } = sphericalFromView({ yaw: yawDeg * DEG, pitch: 0, roll: 0 });
    near(yaw, ((yawDeg % 360) + 360) % 360, 1e-9);
    assert.ok(yaw >= 0 && yaw < 360);
  }
  // Positive view.yaw = turned to the user's left; YouTube's yaw increases
  // as the viewer turns left -- so 10° left is yaw 10, 10° right is 350.
  near(sphericalFromView({ yaw: 10 * DEG, pitch: 0, roll: 0 }).yaw, 10);
  near(sphericalFromView({ yaw: -10 * DEG, pitch: 0, roll: 0 }).yaw, 350);
});

test("pitch is up-positive and clamped; roll is clamped and tolerates absence", () => {
  near(sphericalFromView({ yaw: 0, pitch: 45 * DEG, roll: 0 }).pitch, 45);
  near(sphericalFromView({ yaw: 0, pitch: 120 * DEG, roll: 0 }).pitch, 90);
  near(sphericalFromView({ yaw: 0, pitch: -120 * DEG, roll: 0 }).pitch, -90);
  near(sphericalFromView({ yaw: 0, pitch: 0, roll: 400 * DEG }).roll, -180);
  near(sphericalFromView({ yaw: 0, pitch: 0 }).roll, 0);
});

test("fov: horizontal on landscape, converted to the longer edge on portrait, clamped", () => {
  near(youtubeFov(100, 1920, 1080), 100);
  near(youtubeFov(100, 0, 0), 100);
  const portrait = youtubeFov(60, 1080, 1920);
  near(portrait, 2 * Math.atan(Math.tan(30 * DEG) * 1920 / 1080) / DEG);
  near(youtubeFov(200, 1920, 1080), 120);
  near(youtubeFov(10, 1920, 1080), 30);
  near(youtubeFov(NaN, 1920, 1080), 100);
});

test("refusals: 153 explains the missing referrer; unknown codes are still worded", () => {
  assert.match(REFUSALS[153], /referrer/);
  assert.equal(refusal(150), REFUSALS[150]);
  assert.match(refusal(999), /999/);
});

// ---- the send gate ---------------------------------------------------------

test("gate: idle sway does not open it, a real turn does, the first always does", () => {
  const a = { yaw: 120, pitch: 10, roll: 1, fov: 100 };
  assert.ok(!movedEnough(a, { ...a, yaw: 120.06, pitch: 10.04, roll: 1.03 }));
  assert.ok(movedEnough(a, { ...a, yaw: 120.2 }));
  assert.ok(movedEnough(a, { ...a, pitch: 10.5 }));
  assert.ok(movedEnough(a, { ...a, roll: 1.5 }));
  assert.ok(movedEnough(null, a));
});

test("gate: a new fov opens it with the view still; the 0/360 seam is not movement", () => {
  const a = { yaw: 120, pitch: 10, roll: 1, fov: 75 };
  assert.ok(movedEnough(a, { ...a, fov: 90 }));
  assert.ok(!movedEnough({ yaw: 359.995, pitch: 0, roll: 0 }, { yaw: 0.005, pitch: 0, roll: 0 }));
  assert.ok(movedEnough({ yaw: 359, pitch: 0, roll: 0 }, { yaw: 1, pitch: 0, roll: 0 }));
});

// ---- iframe API loader -----------------------------------------------------

test("iframeApi: resolves immediately when YT is already loaded", async () => {
  const YT = await iframeApi(50);
  assert.equal(YT, window.YT);
});

test("iframeApi: times out when the ready callback never fires, and a retry can succeed", async () => {
  delete window.YT;
  scripts.length = 0;
  await assert.rejects(iframeApi(20), /never became ready/);
  assert.equal(scripts.length, 1, "one script tag");
  const retry = iframeApi(1000);
  assert.equal(scripts.length, 1, "the still-loading tag is not duplicated");
  installYT();
  window.onYouTubeIframeAPIReady();
  assert.equal(await retry, window.YT);
});

test("iframeApi: a script that fails to load rejects and is retried with a fresh tag", async () => {
  delete window.YT;
  scripts.length = 0;
  const first = iframeApi(1000);
  scripts[0].onerror();
  await assert.rejects(first, /would not load/);
  const second = iframeApi(1000);
  assert.equal(scripts.length, 2);
  installYT();
  window.onYouTubeIframeAPIReady();
  await second;
});

test("preload: resolves true/false and never rejects", async () => {
  const player = new EmbedPlayer(container());
  assert.equal(await player.preload(), true);
  delete window.YT;
  resetIframeApiForTests();
  const p2 = new EmbedPlayer(container(), { apiTimeoutMs: 10 });
  assert.equal(await p2.preload(), false);
});

// ---- build -----------------------------------------------------------------

test("build: playerVars carry the documented set and nothing deprecated", async () => {
  const { b } = await readyPlayer();
  const vars = b.options.playerVars;
  assert.deepEqual(vars, {
    enablejsapi: 1, origin: "https://lazyvr.test", controls: 0, disablekb: 1, fs: 0,
    playsinline: 1, iv_load_policy: 3, rel: 0, autoplay: 1, cc_load_policy: 0,
  });
  assert.equal(b.options.videoId, "first");
});

test("build: the iframe sits in an overflow-hidden stage inside the container", async () => {
  const { b, host, player } = await readyPlayer();
  assert.equal(host.children.length, 1);
  const stage = host.children[0];
  assert.equal(stage.style.overflow, "hidden");
  assert.equal(b.mount.parentNode, stage);
  assert.equal(player.stage, stage);
});

test("build: a ready timeout destroys the half-built player and removes its mount", async () => {
  const host = container();
  const player = new EmbedPlayer(host, { readyTimeoutMs: 20 });
  await assert.rejects(player.open("abc"), /never became ready/);
  assert.equal(builds.length, 1);
  assert.ok(builds[0].destroyed, "half-built player was not destroyed");
  assert.equal(host.children.length, 0, "the mount was left behind");
  assert.equal(player.player, null);

  // The next open builds fresh instead of calling methods on a dead player.
  const again = player.open("def");
  await tick();
  assert.equal(builds.length, 2);
  builds[1].becomeReady();
  await again;
  assert.equal(player.player, builds[1].player);
});

test("build: a refusal before ready rejects with the worded reason and tears down", async () => {
  const host = container();
  const player = new EmbedPlayer(host);
  const opening = player.open("blocked");
  await tick();
  builds[0].events.onError({ data: 150 });
  await assert.rejects(opening, new RegExp(REFUSALS[150]));
  assert.ok(builds[0].destroyed);
  assert.equal(host.children.length, 0);
});

test("build: let go of before ready -> stopped once ready, kept for reuse", async () => {
  const player = new EmbedPlayer(container());
  const opening = player.open("abc");
  await tick();
  player.close();
  builds[0].becomeReady();
  await assert.rejects(opening, /let go of/);
  assert.deepEqual(builds[0].calls.filter((c) => c[0] === "stopVideo").length, 1);
  assert.equal(player.player, builds[0].player, "a ready player is reused next time");
});

test("build: let go of while the API script loads -> nothing is built", async () => {
  delete window.YT;
  const player = new EmbedPlayer(container());
  const opening = player.open("abc");
  await tick();
  player.close();
  installYT();
  window.onYouTubeIframeAPIReady();
  await assert.rejects(opening, /let go of/);
  assert.equal(builds.length, 0);
});

test("build: two picks racing the first build make one player; the second loads into it", async () => {
  const player = new EmbedPlayer(container());
  const first = player.open("abc");
  const second = player.open("def");
  await tick();
  assert.equal(builds.length, 1);
  builds[0].becomeReady();
  await first;
  await second;
  assert.equal(builds.length, 1);
  assert.deepEqual(builds[0].calls.filter((c) => c[0] === "loadVideoById"), [["loadVideoById", "def"]]);
});

test("build: a pick joining a build that is then closed does not load", async () => {
  const player = new EmbedPlayer(container());
  const first = player.open("abc");
  const second = player.open("def");
  await tick();
  player.close();
  builds[0].becomeReady();
  await assert.rejects(first, /let go of/);
  await assert.rejects(second, /let go of/);
  assert.equal(builds[0].calls.filter((c) => c[0] === "loadVideoById").length, 0);
});

// ---- reuse / open flow ---------------------------------------------------

test("open (reuse): loadVideoById, which autoplays -- no cue/pause dance", async () => {
  const { player, b } = await readyPlayer();
  b.calls.length = 0;
  await player.open("next", {});
  assert.deepEqual(b.calls.filter((c) => c[0] === "loadVideoById"), [["loadVideoById", "next"]]);
  assert.equal(b.calls.filter((c) => c[0] === "cueVideoById" || c[0] === "pauseVideo").length, 0);
});

test("handlers: state changes, errors, autoplay block and quality reach the session", async () => {
  const seen = [];
  const handlers = {
    onPlaying: () => seen.push("playing"),
    onBuffering: () => seen.push("buffering"),
    onPaused: () => seen.push("paused"),
    onEnded: () => seen.push("ended"),
    onError: (message, code) => seen.push(["error", message, code]),
    onAutoplayBlocked: () => seen.push("blocked"),
    onQuality: (label) => seen.push(["quality", label]),
  };
  const { b } = await readyPlayer({ handlers });
  b.state$(PS.BUFFERING);
  b.state$(PS.PLAYING);
  b.state$(PS.PAUSED);
  b.state$(PS.ENDED);
  b.events.onError({ data: 153 });
  b.events.onAutoplayBlocked();
  b.events.onPlaybackQualityChange({ data: "hd2160" });
  assert.deepEqual(seen, [
    "buffering", "playing", "paused", "ended",
    ["error", REFUSALS[153], 153], "blocked", ["quality", "hd2160"],
  ]);
});

test("handlers: close() detaches them, and a throwing handler does not break the player", async () => {
  let count = 0;
  const { player, b } = await readyPlayer({ handlers: { onPlaying: () => { count += 1; throw new Error("app bug"); } } });
  const errors = [];
  globalThis.reportError = (e) => errors.push(e);
  try {
    b.state$(PS.PLAYING);
  } finally {
    delete globalThis.reportError;
  }
  assert.equal(count, 1);
  assert.equal(errors.length, 1, "the handler's error is reported, not thrown into YouTube");
  player.close();
  b.state$(PS.PLAYING);
  assert.equal(count, 1);
});

test("first PLAYING after a load re-sends the view, sound and captions; later ones do not", async () => {
  const { player, b } = await readyPlayer();
  player.setSound(0.4, true);
  const view = { yaw: 0.1, pitch: 0, roll: 0 };
  player.steer(view);
  b.calls.length = 0;
  b.state$(PS.PLAYING);
  assert.ok(b.calls.some((c) => c[0] === "setVolume" && c[1] === 40));
  assert.ok(b.calls.some((c) => c[0] === "mute"));
  assert.ok(b.calls.some((c) => c[0] === "unloadModule"));
  player.steer(view);
  assert.equal(b.calls.filter((c) => c[0] === "setSphericalProperties").length, 1, "view re-asserted");

  b.calls.length = 0;
  b.state$(PS.BUFFERING);
  b.state$(PS.PLAYING);
  player.steer(view);
  assert.equal(b.calls.length, 0, "a rebuffer re-sends nothing");

  // A new video re-arms the assertion.
  await player.open("next", {});
  b.calls.length = 0;
  b.state$(PS.PLAYING);
  player.steer(view);
  assert.equal(b.calls.filter((c) => c[0] === "setSphericalProperties").length, 1);
});

// ---- steering --------------------------------------------------------------

test("steer: sends only when moved, carries fov, disables the orientation sensor", async () => {
  const { player, b } = await readyPlayer();
  b.calls.length = 0;
  const view = { yaw: 0, pitch: 0, roll: 0 };
  player.steer(view);
  player.steer(view);
  player.steer({ yaw: 0.0001, pitch: 0, roll: 0 });
  const sent = b.calls.filter((c) => c[0] === "setSphericalProperties");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], { yaw: 0, pitch: 0, roll: 0, fov: 100, enableOrientationSensor: false });
  player.fov = 90;
  player.steer(view);
  assert.equal(b.calls.filter((c) => c[0] === "setSphericalProperties").length, 2);
});

test("steer: NaN views and a missing player are ignored", async () => {
  const unbuilt = new EmbedPlayer(container());
  unbuilt.steer({ yaw: 0, pitch: 0, roll: 0 }); // no throw
  const { player, b } = await readyPlayer();
  b.calls.length = 0;
  player.steer({ yaw: NaN, pitch: 0, roll: 0 });
  player.steer({ yaw: 0, pitch: Infinity, roll: 0 });
  player.steer(null);
  assert.equal(b.calls.length, 0);
  player.steer({ yaw: 0, pitch: 0, roll: NaN });
  assert.equal(b.calls.at(-1)[1].roll, 0);
});

test("steer: at most one send per animation frame; the latest view is flushed next frame", async () => {
  const frames = [];
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const { player, b } = await readyPlayer();
  b.calls.length = 0;
  player.steer({ yaw: 0, pitch: 0, roll: 0 });
  player.steer({ yaw: 1 * DEG, pitch: 0, roll: 0 });
  player.steer({ yaw: 2 * DEG, pitch: 0, roll: 0 });
  let sent = b.calls.filter((c) => c[0] === "setSphericalProperties");
  assert.equal(sent.length, 1);
  frames.shift()();
  sent = b.calls.filter((c) => c[0] === "setSphericalProperties");
  assert.equal(sent.length, 2);
  near(sent[1][1].yaw, 2, 1e-9);
  // A view that went back to what was sent cancels the queued one.
  player.steer({ yaw: 3 * DEG, pitch: 0, roll: 0 });
  player.steer({ yaw: 2 * DEG, pitch: 0, roll: 0 });
  frames.shift()();
  assert.equal(b.calls.filter((c) => c[0] === "setSphericalProperties").length, 2);
});

// ---- layout scaling ------------------------------------------------------

test("layout: the iframe is laid out at k·W×k·H and scaled by 1/k from the corner", async () => {
  const { player, b } = await readyPlayer({ w: 1920, h: 1080 });
  // No tier yet: window-sized, no transform.
  assert.deepEqual(b.iframe.attrs, { width: 1920, height: 1080 });
  assert.equal(b.iframe.style.transform, "none");
  player.setTier(tierOf("hd2160"));
  assert.equal(player.k, 2);
  assert.deepEqual(b.iframe.attrs, { width: 3840, height: 2160 });
  assert.equal(b.iframe.style.transform, "scale(0.5)");
  assert.equal(b.iframe.style.transformOrigin, "0 0");
  assert.equal(b.iframe.style.position, "absolute");
});

test("layout: k is clamped to [1, K_MAX]", async () => {
  const small = await readyPlayer({ w: 800, h: 450, tier: tierOf("highres") });
  assert.equal(small.player.k, K_MAX);
  assert.deepEqual(small.b.iframe.attrs, { width: 2400, height: 1350 });
  const big = await readyPlayer({ w: 3000, h: 1500, tier: tierOf("hd1080") });
  assert.equal(big.player.k, 1);
});

test("layout: the build itself is sized for the tier", async () => {
  const { b } = await readyPlayer({ w: 1280, h: 720, tier: tierOf("hd2160") });
  assert.equal(b.options.width, 3840);
  assert.equal(b.options.height, 2160);
});

test("layout: refit is debounced on resize/fullscreen and skipped when unchanged", async () => {
  const { player, b, host } = await readyPlayer({ w: 1280, h: 720, tier: tierOf("hd2160") });
  b.calls.length = 0;
  player.fit();
  assert.equal(b.calls.filter((c) => c[0] === "setSize").length, 0, "unchanged size refit");
  host.clientWidth = 1920;
  host.clientHeight = 1080;
  for (const fn of listeners.resize) fn();
  for (const fn of docListeners.fullscreenchange) fn();
  assert.equal(b.calls.filter((c) => c[0] === "setSize").length, 0, "not debounced");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(b.calls.filter((c) => c[0] === "setSize"), [["setSize", 3840, 2160]]);
});

test("setTier: same tier is a no-op, null returns to window size", async () => {
  const { player, b } = await readyPlayer({ w: 1920, h: 1080, tier: tierOf("hd2160") });
  b.calls.length = 0;
  player.setTier(tierOf("hd2160"));
  assert.equal(b.calls.length, 0);
  player.setTier(TIERS.find((t) => t.label === "hd1440"));
  assert.ok(Math.abs(player.k - 2560 / 1920) < 1e-12);
  player.setTier(null);
  assert.equal(player.k, 1);
});

// ---- transport -------------------------------------------------------------

test("transport: play/pause/paused/seekTo/seek/time/duration/buffered", async () => {
  const { player, b } = await readyPlayer();
  b.calls.length = 0;
  player.play();
  player.pause();
  assert.deepEqual(b.calls.map((c) => c[0]), ["playVideo", "pauseVideo"]);
  b.state = PS.PLAYING;
  assert.equal(player.paused, false);
  b.state = PS.BUFFERING;
  assert.equal(player.paused, false);
  assert.equal(player.buffering, true);
  b.state = PS.PAUSED;
  assert.equal(player.paused, true);

  assert.equal(player.duration(), 0, "unknown duration is 0");
  b.dur = 100;
  b.time = 10;
  player.seek(5);
  assert.deepEqual(b.calls.at(-1), ["seekTo", 15, true]);
  player.seekTo(-3);
  assert.deepEqual(b.calls.at(-1), ["seekTo", 0, true]);
  player.seekTo(500);
  assert.deepEqual(b.calls.at(-1), ["seekTo", 99.75, true]);
  const count = b.calls.length;
  player.seekTo(NaN);
  player.seek(NaN);
  assert.equal(b.calls.length, count);

  b.time = 42;
  assert.equal(player.currentTime(), 42);
  b.loaded = 1.7;
  assert.equal(player.bufferedFraction(), 1);
  b.loaded = undefined;
  assert.equal(player.bufferedFraction(), 0);
  assert.deepEqual(player.status(), { currentTime: 42, duration: 100, paused: true, buffering: false });
});

test("transport: an unbuilt player answers safely", () => {
  const player = new EmbedPlayer(container());
  player.play();
  player.pause();
  player.seekTo(10);
  assert.equal(player.paused, true);
  assert.equal(player.currentTime(), 0);
  assert.equal(player.duration(), 0);
  assert.equal(player.bufferedFraction(), 0);
  assert.equal(player.title(), null);
  assert.equal(player.quality(), null);
  player.close();
});

test("quality(): from getPlaybackQuality, else the last change event", async () => {
  const { player, b } = await readyPlayer();
  assert.equal(player.quality(), null);
  b.events.onPlaybackQualityChange({ data: "hd1440" });
  assert.deepEqual(player.quality(), { label: "hd1440", height: 1440 });
  b.quality = "hd2160";
  assert.deepEqual(player.quality(), { label: "hd2160", height: 2160 });
});

test("setSound: clamps and remembers volume for a player not built yet", async () => {
  const host = container();
  const player = new EmbedPlayer(host);
  player.setSound(3, false);
  assert.equal(player.volume, 1);
  player.setSound(NaN, true);
  assert.equal(player.volume, 1);
  assert.equal(player.muted, true);
});

test("title(): the player's title once known", async () => {
  const { player, b } = await readyPlayer();
  assert.equal(player.title(), null);
  b.data = { title: "Lions 360" };
  assert.equal(player.title(), "Lions 360");
});

test("build: a YT.Player constructor that throws rejects open and leaves no mount", async () => {
  window.YT.Player = function () { throw new Error("widget broke"); };
  const host = container();
  const player = new EmbedPlayer(host, { readyTimeoutMs: 50 });
  await assert.rejects(player.open("abc"), /widget broke/);
  assert.equal(host.children.length, 0);
  assert.equal(player.player, null);
  assert.equal(player.building, null);
});
