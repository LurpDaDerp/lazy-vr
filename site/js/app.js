/* LazyVR: youtube's 360 videos, steered by gaze, entirely in the browser.
 *
 * gaze.js reads the camera and turns each frame into gaze angles; control.js
 * turns those into the turn rate the viewer is asking for; body.js carries
 * that request out at display rate as a head would; render.js draws the
 * sphere.  The clips come from this site's own server: /api/home and
 * /api/search list youtube's 360-filtered uploads, /api/streams resolves
 * one into proxied tracks, and avsync.js keeps the separate audio on the
 * video's clock.  This file is the page: the shelves, the search, the
 * calibration step, the HUD, the keys, and the wiring between them.
 */

import { AVSync } from "./avsync.js";
import { Body, YAW_LIMIT } from "./body.js";
import { GazeController } from "./control.js";
import { GazeTracker } from "./gaze.js";
import { fetchHome, fetchSearch, fetchStreams, renderResults, renderShelves } from "./library.js";
import { Renderer } from "./render.js";

const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);

const el = {
  canvas: $("view"), video: $("video"), sound: $("sound"), cam: $("cam"),
  state: $("state"), heading: $("heading"), gaze: $("gaze"), rate: $("rate"),
  turn: $("turn"), neck: $("neck"), perf: $("perf"),
  overlay: $("overlay"), overlaytext: $("overlaytext"), progress: $("progress"),
  progresswrap: $("progresswrap"), retry: $("retry"),
  marks: $("compassmarks"), north: $("compassnorth"), dot: $("fixation"), toast: $("toast"),
  home: $("home"), results: $("results"), resultline: $("resultline"), backhome: $("backhome"),
  searchForm: $("search"), query: $("query"),
  grid: $("grid"), notice: $("libnotice"), count: $("libcount"), empty: $("libempty"),
  touchbar: $("touchbar"),
};

const body = new Body();
const controller = new GazeController();
const tracker = new GazeTracker({ models: "models", onStatus: showStatus, onReading: onReading });
const sync = new AVSync(el.video, el.sound);

let renderer = null;
try {
  renderer = new Renderer(el.canvas, el.video);
} catch (error) {
  fail(error.message);
}

/* What this browser can decode, asked once; the server picks within it. */
const prefs = (() => {
  const probe = document.createElement("video");
  const codecs = [];
  if (probe.canPlayType('video/webm; codecs="vp09.00.50.08"')) codecs.push("vp9");
  if (probe.canPlayType('video/mp4; codecs="av01.0.16M.08"')) codecs.push("av01");
  if (probe.canPlayType('video/mp4; codecs="avc1.640033"')) codecs.push("avc1");
  return {
    codecs: codecs.join(",") || "avc1",
    max: matchMedia("(pointer: coarse)").matches ? 2160 : 4320,
  };
})();

/* What the body is currently being asked to do, refreshed on every gaze
 * reading.  Zeroed if the readings stop: a rate repeated forever would spin
 * the viewer round and round. */
let request = { yawRate: 0, pitchRate: 0, committed: false, ...limitsFor(controller) };
let lastReadingAt = 0;
let lastReading = null;

let browsing = true;
let started = false;
let calibrated = false;
let everCalibrated = false;
let playing = null;
let engine = "idle";  // idle | loading | ready | failed

/* Picking a clip is a little journey -- resolve, camera, calibration -- and
 * pressing Esc half-way through must strand every step still in flight. */
let session = 0;
let streamsReady = false;
let pendingPlay = false;
let retryAction = "library";
let qualityLine = null;

function limitsFor(control) {
  const limits = control.limits;
  return { maxRateYaw: limits.maxRateYaw, maxRatePitch: limits.maxRatePitch };
}

/* ---------- the loop ---------- */

let last = performance.now();
let reportedAspect = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (renderer) {
    renderer.resize();
    reportScreen();
    if (started && calibrated) body.step(request, dt);
    renderer.draw(body.view);
  }
  updateCompass();
  requestAnimationFrame(frame);
}

/* The gearing between the axes follows the shape of the screen the eyes are
 * crossing, which changes with a resize or fullscreen. */
function reportScreen() {
  const aspect = el.canvas.clientWidth / Math.max(1, el.canvas.clientHeight);
  if (!isFinite(aspect) || aspect <= 0 || Math.abs(aspect - reportedAspect) < 0.02) return;
  reportedAspect = aspect;
  controller.setAspect(aspect);
  request = { ...request, ...limitsFor(controller) };
}

/* ---------- gaze readings ---------- */

function onReading(reading) {
  lastReadingAt = performance.now();
  lastReading = reading;
  const out = controller.update(reading.sample);
  request = { yawRate: out.yawRate, pitchRate: out.pitchRate, committed: out.committed, ...limitsFor(controller) };
  renderHud(out, reading);
  if (!calibrated && started && awaitingGeneration !== null && controller.generation >= awaitingGeneration) {
    el.progress.style.width = `${Math.round(controller.calibrationProgress * 100)}%`;
    if (controller.resets !== seenResets) {
      seenResets = controller.resets;
      lookAgain();
    }
    if (controller.calibrationProgress >= 1) finishCalibration();
  }
}

setInterval(() => {
  if (lastReadingAt && performance.now() - lastReadingAt > 400) {
    el.state.textContent = "no signal";
    el.state.className = "val bad";
    request = { ...request, yawRate: 0, pitchRate: 0 };
  }
  if (tracker.error) {
    el.state.textContent = "tracker error";
    el.state.className = "val bad";
    console.error(tracker.error);
    tracker.error = null;
  }
}, 200);

const WARN = { "low confidence": 1, calibrating: 1, committing: 1 };

function renderHud(out, reading) {
  el.state.textContent = out.state;
  el.state.className = "val" + (out.state === "lost" ? " bad" : WARN[out.state] ? " warn" : "");
  const sign = (v) => (v >= 0 ? "+" : "");
  el.gaze.textContent = `${sign(out.yawError)}${out.yawError.toFixed(1)}, ${sign(out.pitchError)}${out.pitchError.toFixed(1)}`;
  el.rate.textContent = `${sign(out.yawRate)}${out.yawRate.toFixed(0)}, ${sign(out.pitchRate)}${out.pitchRate.toFixed(0)}°/s`;
  el.turn.textContent = `${sign(body.yawRate)}${body.yawRate.toFixed(0)}, ${sign(body.pitchRate)}${body.pitchRate.toFixed(0)}°/s`;
  el.neck.textContent = body.strain <= 0 ? "free"
    : body.strain >= 0.999 ? "at the limit" : `${Math.round(body.strain * 100)}% strained`;
  el.neck.className = "val" + (body.strain >= 0.999 ? " bad" : body.strain > 0.5 ? " warn" : "");
  el.perf.textContent = `${reading.rate.toFixed(0)} Hz  ${reading.latencyMs.toFixed(0)} ms${reading.mirror ? "" : "  1-pass"}`;
  drawStick(out);
}

function updateCompass() {
  const heading = ((-body.view.yaw / DEG) % 360 + 360) % 360;
  el.heading.textContent = `${heading.toFixed(0)}°`;
  el.marks.style.backgroundPositionX = `${-heading / 360 * 4 * el.marks.clientWidth}px`;
  // The strip shows a quarter turn across its width; mark where the clip
  // started, and hide the mark once it is off the strip.
  const bearing = -(body.view.yaw / DEG);
  const visible = Math.abs(bearing) <= 45;
  el.north.style.display = visible ? "" : "none";
  if (visible) el.north.style.left = `${50 + (bearing / 90) * 100}%`;
}

/* ---------- the deadzone widget ---------- */

const stick = $("stick").getContext("2d");

function drawStick(out) {
  const limits = controller.limits;
  const size = 150, c = size / 2, pad = 10;
  const sx = (c - pad) / Math.max(limits.spanYaw, 1);
  const sy = (c - pad) / Math.max(limits.spanPitch, 1);
  stick.clearRect(0, 0, size, size);
  stick.strokeStyle = "rgba(255,255,255,.16)";
  stick.lineWidth = 1;
  stick.strokeRect(c - limits.spanYaw * sx, c - limits.spanPitch * sy, 2 * limits.spanYaw * sx, 2 * limits.spanPitch * sy);
  stick.strokeStyle = "rgba(255,255,255,.30)";
  stick.setLineDash([3, 3]);
  stick.strokeRect(c - limits.deadzoneYaw * sx, c - limits.deadzonePitch * sy,
    2 * limits.deadzoneYaw * sx, 2 * limits.deadzonePitch * sy);
  stick.setLineDash([]);
  stick.strokeStyle = "rgba(255,255,255,.10)";
  stick.beginPath();
  stick.moveTo(c, 6); stick.lineTo(c, size - 6);
  stick.moveTo(6, c); stick.lineTo(size - 6, c);
  stick.stroke();
  const clamp = (v, l) => Math.max(-l, Math.min(l, v));
  // Mirrored in x to agree with the mirrored camera preview above it.
  const x = c - clamp(out.yawError, limits.spanYaw) * sx;
  const y = c - clamp(out.pitchError, limits.spanPitch) * sy;
  const live = out.yawRate !== 0 || out.pitchRate !== 0;
  if (live) {
    stick.strokeStyle = "rgba(110,231,183,.55)";
    stick.lineWidth = 2;
    stick.beginPath(); stick.moveTo(c, c); stick.lineTo(x, y); stick.stroke();
  }
  stick.fillStyle = live ? "#6ee7b7" : "rgba(255,255,255,.55)";
  stick.beginPath(); stick.arc(x, y, 5, 0, 2 * Math.PI); stick.fill();
}

/* ---------- the gaze engine ---------- */

function showStatus(text) {
  if (libraryLine && (engine === "loading" || engine === "ready")) {
    el.count.textContent = `${libraryLine}  ·  ${text.toLowerCase()}`;
  }
  if (!browsing && !calibrated) el.overlaytext.textContent = text;
}

let libraryLine = "";
let loading = null;

/* Loading the models takes a few seconds and needs no permission, so it
 * starts as soon as the shelves are up, and is usually done before a card
 * is picked. */
function ensureEngine() {
  if (!loading) {
    engine = "loading";
    loading = tracker.load().then(() => { engine = "ready"; if (libraryLine) el.count.textContent = libraryLine; })
      .catch((error) => { engine = "failed"; loading = null; throw error; });
  }
  return loading;
}

let cameraOpen = false;

async function ensureCamera() {
  if (cameraOpen) return;
  await tracker.open(el.cam);
  cameraOpen = true;
  tracker.start();
}

/* ---------- the library ---------- */

async function loadHome() {
  let data;
  try {
    data = await fetchHome();
  } catch (error) {
    el.count.textContent = "Cannot reach the server";
    el.empty.hidden = false;
    return;
  }
  const total = renderShelves(el.home, data.categories, selectClip);
  el.empty.hidden = total > 0;
  libraryLine = total ? `youtube 360 · ${total} videos on the shelves` : "";
  el.count.textContent = total ? libraryLine : "youtube gave nothing back";
  const dead = data.categories.filter((c) => c.error);
  if (dead.length && total) {
    notify(`Some shelves came back empty (${dead.map((c) => c.title).join(", ")}): ${dead[0].error}`);
  }
  if (total) ensureEngine().catch((error) => notify(`The gaze engine could not load: ${error.message}`));
}

let searching = false;

el.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = el.query.value.trim();
  if (!query || searching) return;
  searching = true;
  el.query.blur();
  el.results.hidden = false;
  el.home.hidden = true;
  el.grid.textContent = "";
  el.resultline.textContent = `Searching youtube's 360 videos for “${query}”…`;
  try {
    const data = await fetchSearch(query);
    const count = renderResults(el.grid, data.clips, selectClip);
    el.resultline.textContent = count
      ? `${count} result${count === 1 ? "" : "s"} for “${query}”`
      : `Nothing in 360 for “${query}” — try broader words`;
    if (count) ensureEngine().catch(() => {});
  } catch (error) {
    el.resultline.textContent = `Search failed: ${error.message}`;
  }
  searching = false;
});

el.backhome.addEventListener("click", () => {
  el.results.hidden = true;
  el.home.hidden = false;
  el.query.value = "";
});

function notify(message) {
  el.notice.textContent = message;
  el.notice.hidden = false;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("on"), 2400);
}

/* ---------- picking a clip ---------- */

async function selectClip(clip) {
  if (!browsing || !renderer) return;
  const my = ++session;
  browsing = false;
  started = true;
  playing = clip;
  streamsReady = false;
  pendingPlay = false;
  retryAction = "library";
  el.retry.textContent = "Try again";
  el.notice.hidden = true;
  document.body.classList.remove("browsing");

  // Wake both media elements inside the click, so the browser will let a
  // later, programmatic play() through once calibration is done.
  el.video.load();
  el.sound.load();

  el.overlay.classList.remove("gone");
  el.retry.hidden = true;
  el.overlaytext.textContent = "Starting the gaze tracker…";

  // Resolving the stream takes yt-dlp a few seconds; run it underneath the
  // camera prompt and the calibration countdown rather than before them.
  fetchStreams(clip.id, prefs)
    .then((streams) => {
      if (session !== my) return;
      sync.set(streams.video.src, streams.audio && streams.audio.src);
      const fps = streams.video.fps > 40 ? Math.round(streams.video.fps) : "";
      qualityLine = `${streams.video.height}p${fps} ${streams.video.codec}`;
      streamsReady = true;
      if (pendingPlay) {
        pendingPlay = false;
        el.overlay.classList.add("gone");
        tryPlay();
      }
    })
    .catch((error) => {
      if (session !== my) return;
      returnToLibrary();
      notify(`“${clip.title}” would not stream: ${error.message}`);
    });

  // The camera prompt also wants the click's activation.  Ask for it now,
  // while the models finish loading in parallel.
  const camera = ensureCamera();
  try {
    await ensureEngine();
    await camera;
  } catch (error) {
    if (session === my) fail(error.message, true);
    return;
  }
  if (session !== my) return;

  if (everCalibrated) {
    calibrated = true;
    body.rest();
    toast("Using the calibration from earlier — press C to redo it");
    maybePlay();
  } else {
    runCalibration("Look at the dot.");
  }
  watchForBackgroundedTab();
}

/* Playback starts when the slower of the two journeys finishes: the stream
 * resolving, or the viewer calibrating. */
function maybePlay() {
  if (streamsReady) {
    el.overlay.classList.add("gone");
    tryPlay();
  } else {
    pendingPlay = true;
    el.overlay.classList.remove("gone");
    el.overlaytext.textContent = "Fetching the stream from youtube…";
  }
}

function tryPlay() {
  el.video.play().then(() => {
    if (qualityLine) { toast(qualityLine); qualityLine = null; }
  }).catch(() => {
    // The click that started all this has gone stale for this browser;
    // one fresh click fixes it.
    retryAction = "play";
    fail("The browser wants a click before it will play sound.", true);
    el.retry.textContent = "Play";
  });
}

function fail(message, retryable = false) {
  el.overlay.classList.remove("gone");
  el.overlay.classList.remove("calibrating");
  el.dot.classList.remove("on");
  el.progresswrap.classList.remove("on");
  el.overlaytext.textContent = message;
  el.retry.hidden = !retryable;
}

el.retry.addEventListener("click", () => {
  if (retryAction === "play") {
    retryAction = "library";
    el.retry.textContent = "Try again";
    el.overlay.classList.add("gone");
    tryPlay();
  } else {
    returnToLibrary();
  }
});

function returnToLibrary() {
  session += 1;
  browsing = true;
  started = false;
  calibrated = false;
  playing = null;
  awaitingGeneration = null;
  pendingPlay = false;
  retryAction = "library";
  sync.clear();
  body.rest();
  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.remove("on");
  el.retry.hidden = true;
  el.retry.textContent = "Try again";
  document.body.classList.add("browsing");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

el.video.addEventListener("ended", returnToLibrary);
el.video.addEventListener("error", () => {
  if (browsing || !el.video.getAttribute("src")) return;
  const title = playing ? playing.title : "That video";
  returnToLibrary();
  notify(`“${title}” stopped streaming. The signed stream may have expired — pick it again.`);
});

/* ---------- calibration ---------- */

let awaitingGeneration = null;
let seenResets = 0;
let calibrationHeadline = "Look at the dot.";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lookAgain() {
  setOverlay(calibrationHeadline, "You looked away", "away");
  el.dot.classList.add("nudge");
  setTimeout(() => el.dot.classList.remove("nudge"), 600);
}

function setOverlay(headline, sub, subClass = "") {
  el.overlaytext.textContent = "";
  el.overlaytext.append(headline, document.createElement("br"));
  const span = document.createElement("span");
  span.className = `count ${subClass}`.trim();
  span.textContent = sub;
  el.overlaytext.appendChild(span);
}

async function runCalibration(headline) {
  calibrated = false;
  awaitingGeneration = null;
  calibrationHeadline = headline;
  seenResets = controller.resets;
  body.rest();
  el.overlay.classList.remove("gone");
  el.overlay.classList.add("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.add("on");
  // Count down before the hold starts, so it begins while the viewer is
  // already fixed on the dot rather than still moving onto it.
  for (let count = 3; count > 0; count--) {
    setOverlay(headline, String(count));
    await wait(1000);
  }
  setOverlay(headline, "hold still…");
  el.progress.style.width = "0%";
  el.progresswrap.classList.add("on");
  awaitingGeneration = controller.recalibrate();
}

function finishCalibration() {
  calibrated = true;
  everCalibrated = true;
  awaitingGeneration = null;
  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.remove("on");
  if (!browsing) maybePlay();
}

/* ---------- keys and touch ---------- */

function recentre() {
  if (browsing || !calibrated) return;
  toast(body.goHome() ? "Turning back to the start" : "Already facing the start");
}

function recalibrate() {
  if (!started) return;
  runCalibration("Recalibrating — look at the dot.");
}

document.addEventListener("keydown", (event) => {
  if (browsing) return;
  const key = event.key.toLowerCase();
  if (event.key === "Escape") returnToLibrary();
  else if (key === "r") recentre();
  else if (key === "c") recalibrate();
  else if (key === " ") { event.preventDefault(); el.video.paused ? el.video.play().catch(() => {}) : el.video.pause(); }
  else if (key === "f") {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
  } else if (key === "h") document.body.classList.toggle("hidden-hud");
  else if (event.key === "ArrowRight") el.video.currentTime = Math.min(el.video.duration || 0, el.video.currentTime + 5);
  else if (event.key === "ArrowLeft") el.video.currentTime = Math.max(0, el.video.currentTime - 5);
});

el.touchbar.addEventListener("click", (event) => {
  const action = event.target.dataset && event.target.dataset.action;
  if (action === "library") returnToLibrary();
  else if (action === "recentre") recentre();
  else if (action === "recalibrate") recalibrate();
});

/* Chrome will not fetch media for a tab that is not in the foreground: the
 * request is simply never issued, so the sphere stays black with no error
 * anywhere.  Say so, and retry the moment the tab is looked at. */
let watchingTab = false;
function watchForBackgroundedTab() {
  if (watchingTab) return;
  watchingTab = true;
  const hint = document.createElement("div");
  hint.id = "bghint";
  hint.textContent = "Bring this tab to the front — the browser will not load video in a background tab.";
  document.body.appendChild(hint);
  setInterval(() => {
    const stuck = el.video.readyState === 0 && started;
    hint.style.display = stuck && document.visibilityState === "hidden" ? "" : "none";
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && el.video.readyState === 0 && started) {
      el.video.load();
      el.video.play().catch(() => {});
      if (renderer) renderer.watchFrames();
    }
  });
}

/* ---------- self-test ---------- */

/* ?selftest proves the gaze graph in this browser reproduces the exporter's
 * reference frames, without a camera. */
async function selfTest() {
  el.overlay.classList.remove("gone");
  el.overlaytext.textContent = "Loading the gaze engine for the self-test…";
  try {
    await ensureEngine();
    const worst = await tracker.selfTest();
    el.overlaytext.textContent = `Self-test passed: max |Δgaze| ${worst.toExponential(2)} against the exporter's reference.`;
  } catch (error) {
    el.overlaytext.textContent = `Self-test failed: ${error.message}`;
  }
  el.retry.hidden = false;
  el.retry.textContent = "Back to the library";
}

/* ---------- start ---------- */

if (renderer) requestAnimationFrame(frame);
loadHome().then(() => {
  const params = new URLSearchParams(location.search);
  if (params.has("selftest")) selfTest();
  // ?video=<id> jumps straight to one upload; playback will ask for the
  // one click the browser insists on before it plays sound.
  else if (params.get("video")) selectClip({ id: params.get("video"), title: "Direct link" });
});

// For a console or a test harness.
window.lazyvr = { body, controller, tracker, sync, get request() { return request; }, get reading() { return lastReading; }, YAW_LIMIT };
