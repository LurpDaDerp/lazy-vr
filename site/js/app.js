/* LazyVR: 360 videos, steered by gaze, entirely in the browser.
 *
 * gaze.js opens the camera and gets each frame turned into gaze angles --
 * in a worker, where the work does not queue up in front of the render
 * loop; control.js turns those angles into the turn rate the viewer is
 * asking for; body.js carries that request out at display rate as a head
 * would; render.js draws the sphere.  Clips come from this site's own
 * server -- /api/home and /api/search list youtube's 360-filtered uploads,
 * /api/streams resolves one into proxied tracks, and avsync.js keeps the
 * separate audio on the video's clock -- or from the viewer's own disk,
 * which needs no server at all.  This file is the page: the shelves, the
 * search, the file picker, the calibration step, the HUD, the keys, and the
 * wiring between them.
 */

import { AVSync } from "./avsync.js";
import { Body, YAW_LIMIT } from "./body.js";
import { DEFAULTS, GazeController } from "./control.js";
import { EmbedPlayer } from "./embed.js";
import { GazeTracker } from "./gaze.js";
import { fetchHome, fetchSearch, fetchStreams, renderResults, renderShelves } from "./library.js";
import { screenTier, tierBelow } from "./quality.js";
import { Renderer } from "./render.js";

const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);

const el = {
  canvas: $("view"), embed: $("embed"), video: $("video"), sound: $("sound"), cam: $("cam"),
  state: $("state"), heading: $("heading"), gaze: $("gaze"), rate: $("rate"),
  turn: $("turn"), neck: $("neck"), perf: $("perf"),
  overlay: $("overlay"), overlaytext: $("overlaytext"), progress: $("progress"),
  progresswrap: $("progresswrap"), retry: $("retry"),
  marks: $("compassmarks"), north: $("compassnorth"), dot: $("fixation"), toast: $("toast"),
  home: $("home"), results: $("results"), resultline: $("resultline"), backhome: $("backhome"),
  searchForm: $("search"), query: $("query"),
  grid: $("grid"), notice: $("libnotice"), empty: $("libempty"), loading: $("libloading"),
  touchbar: $("touchbar"), local: $("local"), localfile: $("localfile"),
  settings: $("settings"), gear: $("gear"), setsclose: $("setsclose"), setsreset: $("setsreset"),
};

const body = new Body();
const controller = new GazeController();
const tracker = new GazeTracker({ models: "models", onStatus: showStatus, onReading: onReading });
const sync = new AVSync(el.video, el.sound);
const embedPlayer = new EmbedPlayer(el.embed);

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
    // The best tier that still fits the *display* -- its full physical
    // pixels, fullscreen-sized, not the window.  A 1440p monitor gets the
    // 1440p track, never an 8K decode it cannot show.
    max: screenTier(screen.width, screen.height, window.devicePixelRatio || 1),
  };
})();

/* ---------- settings ---------- */

const SETTINGS_KEY = "lazyvr.settings";
const SETTINGS_DEFAULTS = Object.freeze({
  sens: 1, deadzone: DEFAULTS.deadzoneYaw, fov: 75, blur: true,
  invx: false, invy: false, quality: "auto", free: false,
});

let settings = { ...SETTINGS_DEFAULTS };
try {
  settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
} catch { /* a private window, or cleared storage */ }

// Old or hand-edited storage must not be able to break the map.
{
  const bound = (value, lo, hi, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  settings.sens = bound(settings.sens, 0.4, 2.5, 1);
  settings.deadzone = bound(settings.deadzone, 1, 8, DEFAULTS.deadzoneYaw);
  settings.fov = bound(settings.fov, 60, 100, 75);
  settings.blur = settings.blur !== false;
  settings.invx = settings.invx === true;
  settings.invy = settings.invy === true;
  settings.free = settings.free === true;
  settings.quality = ["1080", "1440", "2160", "4320"].includes(String(settings.quality))
    ? Number(settings.quality) : "auto";
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ditto */ }
}

function qualityCap() {
  return settings.quality === "auto" ? prefs.max : Number(settings.quality);
}

/* Push the current settings into every part that obeys them. */
function applySettings() {
  controller.configure({
    rateYaw: DEFAULTS.rateYaw * settings.sens,
    deadzoneYaw: settings.deadzone,
    invertYaw: settings.invx,
    invertPitch: settings.invy,
  });
  request = { ...request, ...limitsFor(controller) };
  applyFreeLook(settings.free);
  if (renderer) renderer.fov = settings.fov * DEG;
  embedPlayer.fov = settings.fov;
}

/* Switching the neck back on can leave the view somewhere a neck cannot
 * reach -- turned right round behind you.  Handing that posture to the body
 * would have it snap onto the ellipse, fifty degrees of view in a single
 * frame, so the neck waits: yaw stays free through a sweep home, and the
 * limit comes back at the start, where it costs nothing. */
let neckPending = false;

function applyFreeLook(free) {
  if (body.freeYaw && !free && started && Math.abs(body.yaw) > YAW_LIMIT) {
    neckPending = true;
    body.goHome();
    toast("Neck limits back on — turning to the start");
    return;
  }
  neckPending = false;
  body.freeYaw = free;
}

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
let engineMode = "stream";  // stream (raw, ad-free) | embed (the fallback) | local (this device)
let currentMax = 0;         // the quality cap in force for this video
let frameMs = 16;           // smoothed frame time: the renderer's own vote
let slowSince = 0;
let lastDropAt = 0;

function limitsFor(control) {
  const limits = control.limits;
  return { maxRateYaw: limits.maxRateYaw, maxRatePitch: limits.maxRatePitch };
}

/* ---------- the loop ---------- */

let last = performance.now();
let reportedW = 0;
let reportedH = 0;
let reportedCX = Infinity;
let reportedCY = Infinity;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  requestAnimationFrame(frame);
  // The library needs no sphere, no compass, no simulation: while browsing
  // the loop is a scheduling no-op and the device gets its cycles back.
  if (browsing) return;
  frameMs += 0.05 * (Math.min(dt * 1000, 100) - frameMs);
  considerDownshift(now);
  if (renderer) {
    renderer.resize();
    reportScreen();
    reportScreenPosition();
    if (started && calibrated) body.step(request, dt);
    if (neckPending && !body.homing) {
      neckPending = false;
      body.freeYaw = settings.free;
    }
    if (!settings.blur) body.view.blur = 0;
    if (engineMode === "embed") embedPlayer.steer(body.view);
    else renderer.draw(body.view);
  }
  updateCompass();
}

/* The gearing follows the viewport the eyes are crossing -- its shape and
 * its size, which change with a resize or fullscreen.  The controller
 * remembers the viewport the viewer calibrated in and rescales the map
 * against it, so a windowed calibration stays correct in fullscreen. */
function reportScreen() {
  const width = el.canvas.clientWidth;
  const height = el.canvas.clientHeight;
  if (width < 2 || height < 2) return;
  if (Math.abs(width - reportedW) < 2 && Math.abs(height - reportedH) < 2) return;
  reportedW = width;
  reportedH = height;
  controller.setViewport(width, height);
  request = { ...request, ...limitsFor(controller) };
  considerRecalibration();
}

/* A meaningfully different screen deserves a fresh calibration: the scale
 * law carries the map through the change, but the tuning is best measured
 * where it will be used.  Wait for the resize to settle, then -- if the
 * size really moved -- pause whatever is playing and run the dots again. */
const RECAL_SCALE = 0.12;
const RECAL_SETTLE_MS = 700;
let recalTimer = null;

function considerRecalibration() {
  clearTimeout(recalTimer);
  recalTimer = setTimeout(() => {
    if (!started || !calibrated || browsing) return;
    const { scaleX, scaleY } = controller.limits;
    if (Math.abs(scaleX - 1) < RECAL_SCALE && Math.abs(scaleY - 1) < RECAL_SCALE) return;
    runCalibration("The screen changed — look at the dot.");
  }, RECAL_SETTLE_MS);
}

/* The renderer's own vote on quality.  A sustained sag in frame time means
 * the machine cannot decode and draw what it was given -- an 8K stream on
 * a software decoder, usually -- so the cap steps down one tier at a time,
 * at most once every ten seconds, never below 1080. */
const SLOW_MS = 28;
const SLOW_FOR_MS = 3000;
const DROP_COOLDOWN_MS = 10000;

function considerDownshift(now) {
  if (browsing || !started || !calibrated || frameMs < SLOW_MS) {
    slowSince = 0;
    return;
  }
  if (!slowSince) {
    slowSince = now;
    return;
  }
  if (now - slowSince < SLOW_FOR_MS || now - lastDropAt < DROP_COOLDOWN_MS) return;
  lastDropAt = now;
  slowSince = 0;
  // First relief valve: the mirrored second gaze pass costs a whole extra
  // landmarker run on the main thread every frame.  Cheaper to lose than
  // pixels, and the tracker would shed it itself eventually anyway.
  if (tracker.mirror) {
    tracker.mirror = false;
    toast("Dropping the second gaze pass to stay smooth");
    return;
  }
  // A file on this device has one quality: the one it was encoded at.
  if (engineMode === "local") return;
  const lower = tierBelow(currentMax);
  if (!lower || lower < 1080) return;
  currentMax = lower;
  toast(`Struggling to keep up — capping at ${lower}p`);
  applyQualityCap(lower);
}

async function applyQualityCap(maxHeight) {
  if (engineMode === "embed") {
    embedPlayer.capHeight(maxHeight);
    return;
  }
  if (engineMode === "local" || !playing) return;
  const my = session;
  const at = el.video.currentTime;
  const wasPaused = el.video.paused;
  try {
    const streams = await fetchStreams(playing.id, { codecs: prefs.codecs, max: maxHeight });
    if (session !== my) return;
    sync.set(streams.video.src, streams.audio && streams.audio.src);
    el.video.addEventListener("loadedmetadata", () => {
      if (session !== my) return;
      el.video.currentTime = at;
      if (!wasPaused) el.video.play().catch(() => {});
    }, { once: true });
  } catch { /* the swap failed; keep what is playing */ }
}

/* Where the viewport's centre physically sits on the monitor, in CSS px,
 * approximating the browser chrome as side borders plus a top bar.  A
 * window dragged, snapped or fullscreened moves "straight ahead" with it,
 * and the controller re-aims by what the two-dot pass measured. */
function reportScreenPosition() {
  const side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - side);
  const x = window.screenX + side + window.innerWidth / 2;
  const y = window.screenY + top + window.innerHeight / 2;
  if (Math.abs(x - reportedCX) < 1 && Math.abs(y - reportedCY) < 1) return;
  reportedCX = x;
  reportedCY = y;
  controller.setScreenCentre(x, y);
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
    if (controller.phase === "offset" && !secondDot) {
      // The centre is banked; the second dot measures what a screen pixel
      // is worth, so a moved or fullscreened window can be re-aimed.
      secondDot = true;
      awayShown = false;
      moveDot(calibrationOffset);
      setOverlay(calibrationHeadline, "now the second dot");
    }
    if (controller.resets !== seenResets) {
      seenResets = controller.resets;
      lookAgain();
    } else if (awayShown && controller.calibrationProgress > 0) {
      // Back on the dot: the warning has done its job.
      awayShown = false;
      setOverlay(calibrationHeadline, secondDot ? "now the second dot" : "hold still…");
    }
    if (controller.calibrated) finishCalibration();
  }
}

setInterval(() => {
  if (started && lastReadingAt && performance.now() - lastReadingAt > 400) {
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

let hudHidden = false;

function renderHud(out, reading) {
  if (hudHidden) return;  // thirty DOM writes a second nobody can see
  el.state.textContent = out.state;
  el.state.className = "val" + (out.state === "lost" ? " bad" : WARN[out.state] ? " warn" : "");
  const sign = (v) => (v >= 0 ? "+" : "");
  el.gaze.textContent = `${sign(out.yawError)}${out.yawError.toFixed(1)}, ${sign(out.pitchError)}${out.pitchError.toFixed(1)}`;
  el.rate.textContent = `${sign(out.yawRate)}${out.yawRate.toFixed(0)}, ${sign(out.pitchRate)}${out.pitchRate.toFixed(0)}°/s`;
  el.turn.textContent = `${sign(body.yawRate)}${body.yawRate.toFixed(0)}, ${sign(body.pitchRate)}${body.pitchRate.toFixed(0)}°/s`;
  el.neck.textContent = body.strain >= 0.999 ? "at the limit"
    : body.strain > 0 ? `${Math.round(body.strain * 100)}% strained`
    : body.freeYaw ? "free · 360°" : "free";
  el.neck.className = "val" + (body.strain >= 0.999 ? " bad" : body.strain > 0.5 ? " warn" : "");
  el.perf.textContent = `${reading.rate.toFixed(0)} Hz  ${reading.latencyMs.toFixed(0)} ms${reading.mirror ? "" : "  1-pass"}`;
  drawStick(out);
}

let compassShown = "";

function updateCompass() {
  if (hudHidden) return;
  const heading = ((-body.view.yaw / DEG) % 360 + 360) % 360;
  // Touching the DOM sixty times a second for an unchanged number is
  // layout work for nothing; a tenth of a degree is finer than the eye.
  const key = heading.toFixed(1);
  if (key === compassShown) return;
  compassShown = key;
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
  // Screen-handed, not camera-handed: a glance to the viewer's left puts
  // the dot on the left of the widget, which is also which way the view
  // is about to turn.
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
  if (!browsing && !calibrated) el.overlaytext.textContent = text;
}

let loading = null;

/* Loading the models takes a few seconds and needs no permission, so it
 * starts as soon as the shelves are up, and is usually done before a card
 * is picked. */
function ensureEngine() {
  if (!loading) {
    engine = "loading";
    loading = tracker.load().then(() => { engine = "ready"; })
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
    el.loading.hidden = true;
    el.empty.hidden = false;
    return;
  }
  el.loading.hidden = true;
  const total = renderShelves(el.home, data.categories, selectClip);
  el.empty.hidden = total > 0;
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

/* ---------- a video off this device ---------- */

/* No server, no upload, no copy: an object URL points the <video> element
 * straight at the file the viewer picked, and the same renderer, the same
 * calibration and the same body carry on as if it had come from youtube.
 * The one thing that follows the file rather than the network is quality --
 * there is only the one encode, so the downshift has nothing to offer. */

let localUrl = null;

const PLAYABLE = /\.(mp4|m4v|webm|mkv|mov|ogv)$/i;

function playLocalFile(file) {
  if (!file || !browsing) return;
  if (!(file.type || "").startsWith("video/") && !PLAYABLE.test(file.name)) {
    notify(`“${file.name}” does not look like a video file.`);
    return;
  }
  releaseLocal();
  localUrl = URL.createObjectURL(file);
  selectClip({ id: null, title: file.name, local: true, src: localUrl });
}

/* The object URL pins the whole file in memory until it is let go. */
function releaseLocal() {
  if (!localUrl) return;
  URL.revokeObjectURL(localUrl);
  localUrl = null;
}

el.local.addEventListener("click", () => el.localfile.click());
el.localfile.addEventListener("change", () => {
  const file = el.localfile.files && el.localfile.files[0];
  // Cleared so that picking the same file twice in a row still fires.
  el.localfile.value = "";
  playLocalFile(file);
});

/* Drop anywhere.  dragenter/dragleave fire for every element crossed, so
 * the highlight is counted in rather than toggled -- otherwise moving over
 * a card mid-drag puts it out. */
let dragDepth = 0;

const draggingFile = (event) =>
  Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes("Files");

function showDrop(on) {
  if (!on) dragDepth = 0;
  document.body.classList.toggle("dropping", on);
}

document.addEventListener("dragenter", (event) => {
  if (!browsing || !draggingFile(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDrop(true);
});

document.addEventListener("dragover", (event) => {
  if (!browsing || !draggingFile(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("dragleave", () => {
  if (dragDepth && --dragDepth === 0) showDrop(false);
});

// A drag that ends outside the window does not always leave on the way out.
document.addEventListener("dragend", () => showDrop(false));

document.addEventListener("drop", (event) => {
  if (!browsing || !draggingFile(event)) return;
  event.preventDefault();
  showDrop(false);
  playLocalFile(event.dataTransfer.files && event.dataTransfer.files[0]);
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
  engineMode = clip.local ? "local" : "stream";
  document.body.classList.remove("embedded");
  currentMax = qualityCap();
  frameMs = 16;
  slowSince = 0;
  el.retry.textContent = "Try again";
  el.notice.hidden = true;
  document.body.classList.remove("browsing");

  // Fullscreen for the whole session: only this click can grant it, and
  // calibration is best done at the size the video will play at.
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }

  // Wake both media elements inside the click, so the browser will let a
  // later, programmatic play() through once calibration is done.
  el.video.load();
  el.sound.load();

  el.overlay.classList.remove("gone");
  el.retry.hidden = true;
  el.overlaytext.textContent = "Starting the gaze tracker…";

  if (clip.local) {
    // Nothing to resolve and nobody to ask: the file is already here, and
    // its sound is muxed into it, so the shadow audio element stands down.
    sync.set(clip.src, null);
    qualityLine = "playing from this device";
    streamsReady = true;
  } else {
    // Resolving the stream takes yt-dlp a few seconds; run it underneath the
    // camera prompt and the calibration countdown rather than before them.
    fetchStreams(clip.id, { codecs: prefs.codecs, max: currentMax })
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
        // The raw, ad-free stream was refused -- a bot-challenged host, a
        // region lock, an expired URL.  youtube will always play its own
        // videos, though: fall back to its player, steered by the same body.
        // Say what youtube actually objected to: "refused" on its own has
        // sent more than one afternoon looking in the wrong place.
        console.warn("LazyVR: the raw stream was refused", error);
        toast(`Raw stream refused (${error.message}) — using the youtube player`);
        embedFallback(clip, my, error);
      });
  }

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

/* The fallback engine: youtube's own iframe player, gaze-steered through
 * its spherical API.  It joins the same handshake the stream path uses, so
 * calibration and the play gate need not know which engine won. */
async function embedFallback(clip, my, why) {
  try {
    engineMode = "embed";
    document.body.classList.add("embedded");
    await embedPlayer.open(clip.id, {
      onEnded: () => { if (session === my) returnToLibrary(); },
      onError: (error) => {
        if (session !== my) return;
        returnToLibrary();
        notify(`“${clip.title}”: ${error.message}`);
      },
    });
    if (session !== my) { embedPlayer.close(); return; }
    embedPlayer.capHeight(currentMax);
    embedPlayer.pause();  // hold for calibration, like the stream path
    qualityLine = "youtube player fallback — ads possible";
    streamsReady = true;
    if (pendingPlay) {
      pendingPlay = false;
      el.overlay.classList.add("gone");
      tryPlay();
    }
  } catch (error) {
    if (session !== my) return;
    returnToLibrary();
    notify(`“${clip.title}” would not stream (${why.message}), and the fallback failed too: ${error.message}`);
  }
}

/* One remote for two engines: the raw <video> pair, or the embed. */
function mediaPlay() {
  return engineMode === "embed" ? embedPlayer.ensurePlaying() : el.video.play();
}

function mediaPause() {
  if (engineMode === "embed") embedPlayer.pause();
  else el.video.pause();
}

function mediaPaused() {
  return engineMode === "embed" ? embedPlayer.paused : el.video.paused;
}

function mediaSeek(delta) {
  if (engineMode === "embed") embedPlayer.seek(delta);
  else el.video.currentTime = Math.max(0, Math.min(el.video.duration || 1e9, el.video.currentTime + delta));
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
  mediaPlay().then(() => {
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
  moveDot(null);
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
  calibrationRun += 1;
  pausedBySettings = false;
  neckPending = false;
  body.freeYaw = settings.free;
  browsing = true;
  started = false;
  calibrated = false;
  playing = null;
  awaitingGeneration = null;
  pendingPlay = false;
  retryAction = "library";
  sync.clear();
  releaseLocal();
  embedPlayer.close();
  engineMode = "stream";
  document.body.classList.remove("embedded");
  body.rest();
  // The camera belongs to a playing session, not to browsing the shelves:
  // release it, light and all, until the next video is picked.
  tracker.stop();
  cameraOpen = false;
  el.cam.srcObject = null;
  lastReadingAt = 0;
  moveDot(null);
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
  const local = engineMode === "local";
  returnToLibrary();
  notify(local
    ? `“${title}” would not play. This browser may not decode that file — H.264 or VP9 in MP4 or WebM is the safe pair.`
    : `“${title}” stopped streaming. The signed stream may have expired — pick it again.`);
});

/* ---------- the settings panel ---------- */

const setInputs = {
  sens: $("set-sens"), dz: $("set-dz"), fov: $("set-fov"), qual: $("set-qual"),
  blur: $("set-blur"), invx: $("set-invx"), invy: $("set-invy"), free: $("set-free"),
};

function renderSettings() {
  setInputs.sens.value = settings.sens;
  setInputs.dz.value = settings.deadzone;
  setInputs.fov.value = settings.fov;
  setInputs.qual.value = String(settings.quality);
  setInputs.blur.checked = settings.blur;
  setInputs.invx.checked = settings.invx;
  setInputs.invy.checked = settings.invy;
  setInputs.free.checked = settings.free;
  $("sensval").textContent = `×${Number(settings.sens).toFixed(2)}`;
  $("dzval").textContent = `${Number(settings.deadzone).toFixed(1)}°`;
  $("fovval").textContent = `${settings.fov}°`;
}

function settingsChanged() {
  const capBefore = qualityCap();
  settings.sens = Number(setInputs.sens.value);
  settings.deadzone = Number(setInputs.dz.value);
  settings.fov = Number(setInputs.fov.value);
  settings.blur = setInputs.blur.checked;
  settings.invx = setInputs.invx.checked;
  settings.invy = setInputs.invy.checked;
  settings.free = setInputs.free.checked;
  settings.quality = setInputs.qual.value === "auto" ? "auto" : Number(setInputs.qual.value);
  renderSettings();
  applySettings();
  saveSettings();
  const cap = qualityCap();
  if (cap !== capBefore) {
    currentMax = cap;
    if (started) applyQualityCap(cap);  // swap in place, mid-video
  }
}

for (const input of Object.values(setInputs)) input.addEventListener("input", settingsChanged);

let pausedBySettings = false;

function toggleSettings(force) {
  const show = force === undefined ? el.settings.hidden : force;
  el.settings.hidden = !show;
  // Opening the panel pauses whatever plays; closing it resumes only what
  // the panel itself paused, never a pause the viewer chose.
  if (show) {
    pausedBySettings = started && calibrated && !mediaPaused();
    if (pausedBySettings) mediaPause();
  } else if (pausedBySettings) {
    pausedBySettings = false;
    if (started) mediaPlay().catch(() => {});
  }
}

el.gear.addEventListener("click", () => toggleSettings());
el.setsclose.addEventListener("click", () => toggleSettings(false));
el.setsreset.addEventListener("click", () => {
  settings = { ...SETTINGS_DEFAULTS };
  renderSettings();
  applySettings();
  saveSettings();
});

/* ---------- calibration ---------- */

let awaitingGeneration = null;
let seenResets = 0;
let calibrationHeadline = "Look at the dot.";
let calibrationOffset = null;
let secondDot = false;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* The second dot sits up and to the right of the first, so one extra hold
 * measures both axes. */
const DOT_OFFSET = { x: 0.30, y: -0.25 };

function dotOffset() {
  return {
    dx: Math.round(el.canvas.clientWidth * DOT_OFFSET.x),
    dy: Math.round(el.canvas.clientHeight * DOT_OFFSET.y),
  };
}

function moveDot(offset) {
  el.dot.style.left = offset ? `calc(50% + ${offset.dx}px)` : "50%";
  el.dot.style.top = offset ? `calc(50% + ${offset.dy}px)` : "50%";
}

let awayShown = false;

function lookAgain() {
  awayShown = true;
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

let calibrationRun = 0;

async function runCalibration(headline) {
  // A pass superseded mid-countdown -- Esc, another video, a second resize
  // -- must not wake up later and fight the pass that replaced it.
  const run = ++calibrationRun;
  mediaPause();
  // Calibration belongs in fullscreen: the size the video plays at.  A key
  // press or a tap carries the permission; a programmatic rerun without a
  // gesture is refused quietly and calibrates where it is.
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
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
    if (run !== calibrationRun || browsing) return;
  }
  setOverlay(headline, "hold still…");
  el.progress.style.width = "0%";
  el.progresswrap.classList.add("on");
  calibrationOffset = dotOffset();
  secondDot = false;
  awayShown = false;
  moveDot(null);
  awaitingGeneration = controller.recalibrate(calibrationOffset);
}

function finishCalibration() {
  calibrated = true;
  everCalibrated = true;
  awaitingGeneration = null;
  moveDot(null);
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
  if (event.key === "Escape") {
    if (!el.settings.hidden) toggleSettings(false);
    else returnToLibrary();
  }
  else if (key === "s") toggleSettings();
  else if (key === "r") recentre();
  else if (key === "c") recalibrate();
  else if (key === " ") { event.preventDefault(); mediaPaused() ? mediaPlay().catch(() => {}) : mediaPause(); }
  else if (key === "f") {
    document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
  } else if (key === "h") {
    hudHidden = document.body.classList.toggle("hidden-hud");
    if (!hudHidden) compassShown = "";  // repaint on the next frame
  }
  else if (event.key === "ArrowRight") mediaSeek(5);
  else if (event.key === "ArrowLeft") mediaSeek(-5);
});

el.touchbar.addEventListener("click", (event) => {
  const action = event.target.dataset && event.target.dataset.action;
  if (action === "library") returnToLibrary();
  else if (action === "recentre") recentre();
  else if (action === "recalibrate") recalibrate();
  else if (action === "settings") toggleSettings();
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
    const stuck = engineMode === "stream" && el.video.readyState === 0 && started;
    hint.style.display = stuck && document.visibilityState === "hidden" ? "" : "none";
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // A background tab needs no camera: light off, cycles saved.
      if (cameraOpen) {
        tracker.stop();
        cameraOpen = false;
        el.cam.srcObject = null;
      }
      return;
    }
    if (started) ensureCamera().catch(() => {});
    if (engineMode === "stream" && el.video.readyState === 0 && started) {
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

renderSettings();
applySettings();
if (renderer) requestAnimationFrame(frame);
loadHome().then(() => {
  const params = new URLSearchParams(location.search);
  if (params.has("selftest")) selfTest();
  // ?video=<id> jumps straight to one upload; playback will ask for the
  // one click the browser insists on before it plays sound.
  else if (params.get("video")) selectClip({ id: params.get("video"), title: "Direct link" });
});

// For a console or a test harness.
window.lazyvr = { body, controller, tracker, sync, embed: embedPlayer, get request() { return request; }, get reading() { return lastReading; }, get settings() { return settings; }, get engineMode() { return engineMode; }, YAW_LIMIT };
