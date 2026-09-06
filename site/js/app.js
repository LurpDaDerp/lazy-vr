/* LazyVR: 360 videos, steered by gaze, entirely in the browser.
 *
 * gaze.js opens the camera and gets each frame turned into gaze angles --
 * in a worker, where the work does not queue up in front of the render
 * loop; control.js turns those angles into the turn rate the viewer is
 * asking for; body.js carries that request out at display rate as a head
 * would; render.js draws the sphere.  Clips come from this site's own
 * server -- /api/home and /api/search list youtube's 360-filtered uploads,
 * which youtube's own iframe player then plays, steered through its
 * spherical API -- or from the viewer's own disk, which needs no server at
 * all and goes onto the sphere.  This file is the page: the shelves, the
 * search, the file picker, the calibration step, the HUD, the keys, and the
 * wiring between them.
 */

import { Body, YAW_LIMIT } from "./body.js";
import { DEFAULTS, GazeController } from "./control.js";
import { EmbedPlayer } from "./embed.js";
import { GazeTracker } from "./gaze.js";
import { fetchHome, fetchSearch, renderResults, renderShelves } from "./library.js";
import { screenTier, tierBelow } from "./quality.js";
import { Renderer } from "./render.js";
import { createHud, hudAwake, neckEdge, qualityLabel, trackerHealth } from "./hud.js";
import {
  SETTINGS_DEFAULTS, bindSettingsPanel, fillCameraOptions, readSettings, readSettingsPanel,
  renderSettingsPanel, writeSettings,
} from "./settings.js";

const DEG = Math.PI / 180;
const $ = (id) => document.getElementById(id);

const el = {
  canvas: $("view"), embed: $("embed"), video: $("video"), cam: $("cam"),
  overlay: $("overlay"), overlaytext: $("overlaytext"), retry: $("retry"), dot: $("fixation"),
  toast: $("toast"),
  home: $("home"), results: $("results"), resultline: $("resultline"), backhome: $("backhome"),
  searchForm: $("search"), query: $("query"),
  grid: $("grid"), notice: $("libnotice"), empty: $("libempty"), emptyfile: $("emptyfile"),
  loading: $("libloading"),
  touchbar: $("touchbar"), local: $("local"), localfile: $("localfile"),
  settings: $("settings"), gear: $("gear"), setsclose: $("setsclose"), setsreset: $("setsreset"),
  cameraSelect: $("set-camera"), playbtn: $("playbtn"), mutebtn: $("mutebtn"), hudgear: $("hudgear"),
};

const body = new Body();
const controller = new GazeController();
const tracker = new GazeTracker({ models: "models", onStatus: showStatus, onReading: onReading });
const embedPlayer = new EmbedPlayer(el.embed);
const hud = createHud();

/* The sphere, if this browser has one.  It draws the local-file engine and
 * nothing else now -- a youtube clip is an iframe -- so a machine with no
 * WebGL2 (a blocklisted GPU, software rendering off) loses "Play a file…"
 * and keeps the rest.  It used to lose the whole page: the frame loop was
 * never started, and selectClip refused every pick, including the ones that
 * need no sphere at all. */
let renderer = null;
let rendererError = null;
try {
  renderer = new Renderer(el.canvas, el.video);
} catch (error) {
  rendererError = error;
  console.warn("LazyVR: no WebGL2 sphere —", error.message);
}

/* The best tier that still fits the *display* -- its full physical pixels,
 * fullscreen-sized, not the window.  A 1440p monitor pins youtube's player
 * to its 1440p level, never an 8K decode it cannot show. */
const screenMax = screenTier(screen.width, screen.height, window.devicePixelRatio || 1);

/* ---------- settings ---------- */

/* What the viewer can adjust lives in settings.js: the defaults, the
 * deadzone migration, and the bounds that keep hand-edited storage from
 * breaking the map.  This file owns what the settings do. */
const storage = (() => {
  try { return window.localStorage; } catch { return null; }  // a sandboxed frame
})();
let settings = readSettings(storage);

function saveSettings() {
  writeSettings(settings, storage);
}

function qualityCap() {
  return settings.quality === "auto" ? screenMax : Number(settings.quality);
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
  applySound();
  document.body.classList.toggle("no-hints", !settings.hints);
  document.body.classList.toggle("diagnostics", settings.diagnostics);
  // A different camera mid-session: let the tracker go and reopen it on
  // the new one.  Calibration is kept -- the centre is a property of the
  // eyes, not of the lens -- and C is there if the new angle wants it.
  if (started && cameraOpen && settings.camera !== cameraInUse) {
    releaseCamera();
    ensureCamera().catch((error) => toast(error.message));
  }
}

/* Volume and mute reach both engines: the <video> a file off this device
 * plays through, and youtube's player. */
function applySound() {
  el.video.volume = settings.volume;
  el.video.muted = settings.muted;
  embedPlayer.setSound(settings.volume, settings.muted);
}

function setVolume(volume) {
  settings.volume = Math.max(0, Math.min(1, Math.round(volume * 20) / 20));
  if (settings.volume > 0) settings.muted = false;
  applySound();
  saveSettings();
  if (!el.settings.hidden) renderSettingsPanel(el.settings, settings);
  toast(settings.volume === 0 ? "Volume off" : `Volume ${Math.round(settings.volume * 100)}%`);
}

function toggleMute() {
  settings.muted = !settings.muted;
  applySound();
  saveSettings();
  if (!el.settings.hidden) renderSettingsPanel(el.settings, settings);
  toast(settings.muted ? "Muted — M to unmute" : "Sound on");
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

/* Picking a clip is a little journey -- the player, the camera, the
 * calibration -- and pressing Esc half-way through must strand every step
 * still in flight. */
let session = 0;
let playerReady = false;
let pendingPlay = false;
let retryAction = "library";
let qualityLine = null;
let engineMode = "embed";   // embed (youtube's player) | local (this device)
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

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  requestAnimationFrame(frame);
  // The library needs no sphere, no compass, no simulation: while browsing
  // the loop is a scheduling no-op and the device gets its cycles back.
  if (browsing) return;
  frameMs += 0.05 * (Math.min(dt * 1000, 100) - frameMs);
  considerDownshift(now);
  if (renderer) renderer.resize();
  reportScreen();
  if (started && calibrated) body.step(request, dt);
  if (neckPending && !body.homing) {
    neckPending = false;
    body.freeYaw = settings.free;
  }
  if (!settings.blur) body.view.blur = 0;
  if (engineMode === "embed") embedPlayer.steer(body.view);
  else if (renderer) renderer.draw(body.view);
  if (!hudHidden) hud.paintCompass(currentHeading());
}

/* The gearing follows the viewport the eyes are crossing -- its shape and
 * its size, which change with a resize or fullscreen.  The controller
 * remembers the viewport the viewer calibrated in and rescales the map
 * against it, so a windowed calibration stays correct in fullscreen. */
function reportScreen() {
  // What the eyes cross is the window, and the canvas is only the same
  // thing while it is the one drawing: under the embed it is display:none
  // and measures 0x0, which used to bail out of this function entirely --
  // so every youtube session kept the controller's 16:9 default, took the
  // wrong pitch gearing and deadzone for the display, and never noticed a
  // resize either, because considerRecalibration is only reached from here.
  const width = el.canvas.clientWidth || window.innerWidth;
  const height = el.canvas.clientHeight || window.innerHeight;
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
 * the machine cannot decode and draw what it was given -- an 8K level on a
 * software decoder, usually -- so the cap steps down one tier at a time, at
 * most once every ten seconds, never below 1080. */
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

/* The ceiling, handed to whichever engine can honour it.  A file off this
 * device has only the one encode, so only youtube's player has anything to
 * do here. */
function applyQualityCap(maxHeight) {
  if (engineMode === "embed") embedPlayer.capHeight(maxHeight);
}

/* ---------- gaze readings ---------- */

function onReading(reading) {
  lastReadingAt = performance.now();
  lastReading = reading;
  const out = controller.update(reading.sample);
  request = { yawRate: out.yawRate, pitchRate: out.pitchRate, committed: out.committed, ...limitsFor(controller) };
  lastOut = out;
  readingsStale = false;
  if (!hudHidden && settings.diagnostics) {
    hud.paintDiagnostics({ out, reading, body, limits: controller.limits, heading: currentHeading() });
  }
  if (!calibrated && started && awaitingGeneration !== null && controller.generation >= awaitingGeneration) {
    ringHold(controller.calibrationProgress);
    if (controller.resets !== seenResets) {
      seenResets = controller.resets;
      lookAgain();
    } else if (awayShown && controller.calibrationProgress > 0) {
      // Back on the dot: the warning has done its job.
      awayShown = false;
      setOverlayLine(HOLD_LINE);
    }
    if (controller.calibrated) finishCalibration();
  }
}

setInterval(() => {
  if (started && lastReadingAt && performance.now() - lastReadingAt > 400) {
    readingsStale = true;
    if (settings.diagnostics) hud.setDiagnosticsState("no signal", "bad");
    request = { ...request, yawRate: 0, pitchRate: 0 };
  }
  if (tracker.error) {
    if (settings.diagnostics) hud.setDiagnosticsState("tracker error", "bad");
    console.error(tracker.error);
    tracker.error = null;
  }
  updateHud();
  // One read of the media for both painters.
  const media = browsing ? null : mediaStatus();
  paintAwake(media);
  paintPeripheral(media);
}, 200);

let hudHidden = false;

/* The chrome keeps youtube's habit: it goes three seconds into a playing
 * video and comes back on the first twitch of the pointer.  Whether it is
 * up is *derived* -- from the tick below and from the pointer -- rather
 * than toggled, so pausing, calibrating, the settings panel and the library
 * all get their say without a timer each.  hud.js owns the decision itself;
 * this file only reads the state it is made of. */
let lastPointerAt = 0;

/* Whether the pointer is still ours to see.  A window that has lost the
 * focus to another application cannot see it, and chrome that went down
 * then would have nothing left able to bring it back.  Focus sitting in
 * youtube's iframe is not that case: the iframe is part of this window, the
 * wake catcher over it still reports the pointer, and the chrome may fade
 * there exactly as it does over the sphere. */
function pointerIsOurs() {
  if (document.hasFocus()) return true;
  const active = document.activeElement;
  return Boolean(active && active.tagName === "IFRAME" && el.embed.contains(active));
}

function chromeAwake(now) {
  return hudAwake({
    browsing,
    started,
    calibrated,
    settingsOpen: !el.settings.hidden,
    paused: mediaPaused(),
    focused: pointerIsOurs(),
    sincePointerMs: now - lastPointerAt,
  });
}

function updateHud() {
  const hide = !chromeAwake(performance.now());
  if (hide === hudHidden) return;
  hudHidden = hide;
  document.body.classList.toggle("hidden-hud", hide);
  if (!hide && !browsing) {
    // Everything the chrome shows may have moved on while it was down.
    hud.paintCompass(currentHeading());
    paintAwake();
  }
}

/* Any sign of life keeps it up.  The pointer is the one that has to feel
 * instant, so it does not wait for the tick. */
function wakeHud() {
  lastPointerAt = performance.now();
  if (hudHidden) updateHud();
}

/* These four listen on the document, so #wake -- the transparent sheet
 * that covers youtube's iframe while the chrome is down -- feeds them by
 * bubbling, and the pointer that would otherwise vanish into another
 * document is seen after all. */
document.addEventListener("pointermove", wakeHud);
document.addEventListener("pointerdown", wakeHud);
document.addEventListener("wheel", wakeHud, { passive: true });
// Coming back to the window is a sign of life like any other, and the three
// seconds are owed from then rather than from whenever the pointer last
// moved before the viewer looked away.
window.addEventListener("focus", wakeHud);

/* A click inside youtube's iframe carries the keyboard off into another
 * document, and every shortcut here goes quiet -- while nothing is
 * listening over there either, since the player is built with its own keys
 * turned off.  Take it back the moment it goes: the click has already
 * landed, and what an ad's skip button wants is the pointer, not the
 * focus. */
window.addEventListener("blur", () => {
  const active = document.activeElement;
  if (active && active.tagName === "IFRAME" && el.embed.contains(active)) active.blur();
});

/* ---------- painting the HUD ---------- */

let lastOut = null;         // the control law's last word
let readingsStale = false;  // no reading for 400 ms: the tracker has gone quiet
let qualityText = null;     // "2160p", once a local file's metadata is in

function currentHeading() {
  return ((-body.view.yaw / DEG) % 360 + 360) % 360;
}

function trackerNow() {
  return trackerHealth({
    state: lastOut ? lastOut.state : "lost",
    mirror: tracker.mirror,
    stale: readingsStale,
  });
}

function qualityNow() {
  if (engineMode === "embed") return qualityLabel(embedPlayer.currentHeight());
  return qualityText;
}

/* The awake layer: repainted a few times a second while the chrome is up.
 * hud.js skips the DOM when nothing changed. */
function paintAwake(media = null) {
  if (hudHidden || browsing) return;
  media = media || mediaStatus();
  hud.paintStatus({ quality: qualityNow(), engine: engineMode, tracker: trackerNow() });
  hud.paintTransport({
    currentTime: media.currentTime, duration: media.duration, paused: media.paused,
    volume: settings.volume, muted: settings.muted,
  });
}

/* The peripheral layer: painted whether or not the chrome is up, because
 * these are the marks a viewer needs while looking around. */
function paintPeripheral(media = null) {
  if (browsing || !started || !calibrated) {
    hud.paintPeripheral({ tracker: "ok", edge: null, buffering: false, paused: false });
    return;
  }
  media = media || mediaStatus();
  const overlayUp = !el.overlay.classList.contains("gone");
  hud.paintPeripheral({
    tracker: trackerNow(),
    edge: neckEdge({ yaw: body.yaw, pitch: body.pitch, strain: body.strain, freeYaw: body.freeYaw }),
    buffering: media.buffering,
    paused: media.paused && !overlayUp,
  });
}

/* ---------- the gaze engine ---------- */

function showStatus(text) {
  // Not while the dots are up: a camera reopened mid-calibration (the tab
  // came back, or the camera was changed in Settings) would replace
  // "Hold still — measuring." with "Waiting for the camera…", and nothing
  // would ever put the calibration's own line back.
  if (browsing || calibrated || el.overlay.classList.contains("calibrating")) return;
  el.overlaytext.textContent = text;
}

let loading = null;

/* Loading the models takes a few seconds and needs no permission, so it
 * starts as soon as the shelves are up, and is usually done before a card
 * is picked. */
function ensureEngine() {
  if (!loading) {
    loading = tracker.load()
      .catch((error) => { loading = null; throw error; });
  }
  return loading;
}

let cameraOpen = false;
let cameraInUse = "";  // the device id the open camera was asked for
let cameraOpening = null;  // the one ask in flight, shared by everyone waiting

/* One ask at a time.  The tracker retires an open that is still out when a
 * second one starts -- the older ask lets its stream go and throws -- so a
 * tab switched away and back while the permission prompt raised by the pick
 * was still on screen used to kill the very session that had asked for it,
 * with "The camera was let go of before it finished opening." over a Try
 * again button.  Everyone who wants the camera now waits on the same ask. */
function ensureCamera() {
  if (cameraOpen) return Promise.resolve();
  if (cameraOpening) return cameraOpening;
  const wanted = settings.camera;
  const mine = tracker.open(el.cam, wanted).then(() => {
    cameraOpen = true;
    cameraInUse = wanted;
    tracker.start();
  }).finally(() => {
    // Only if it is still ours: releaseCamera may already have put a newer
    // ask, for a different camera, in its place.
    if (cameraOpening === mine) cameraOpening = null;
  });
  cameraOpening = mine;
  return mine;
}

/* Let the camera go, wherever it has got to.  An ask still in flight is
 * retired inside the tracker, so the promise standing for it has to go too:
 * left there, the next ensureCamera would hand out a wait on a camera that
 * is never coming. */
function releaseCamera() {
  tracker.stop();
  cameraOpen = false;
  cameraOpening = null;
  el.cam.srcObject = null;
}

/* Has the camera already been granted?  Chrome shows a prompt by taking the
 * page out of fullscreen, so the answer decides which of the two goes
 * first.  Firefox will not answer the question at all: an unanswerable one
 * counts as a no, which costs nothing but the slower, safer order. */
async function cameraGranted() {
  if (cameraOpen) return true;
  try {
    const status = await navigator.permissions.query({ name: "camera" });
    return status.state === "granted";
  } catch {
    return false;
  }
}

function goFullscreen() {
  if (document.fullscreenElement) return Promise.resolve();
  return document.documentElement.requestFullscreen();
}

/* Answering the permission prompt has spent the click that would have
 * carried the page into fullscreen.  A request made straight afterwards
 * usually still lands; when it does not, ask for the one gesture that will
 * rather than calibrating at a size the video is not going to play at. */
async function fullscreenAfterCamera(my) {
  try {
    await goFullscreen();
    return;
  } catch { /* the click was spent on the prompt */ }
  if (session !== my || document.fullscreenElement) return;
  el.overlay.classList.remove("gone");
  el.overlaytext.textContent = "Camera ready — click anywhere to go fullscreen.";
  await new Promise((resolve) => {
    const done = () => {
      document.removeEventListener("pointerdown", done);
      document.removeEventListener("keydown", done);
      resolve();
    };
    document.addEventListener("pointerdown", done);
    document.addEventListener("keydown", done);
  });
  // Esc during the wait is a keydown like any other: the session has moved
  // on and there is nothing left to go fullscreen for.
  if (session !== my) return;
  try { await goFullscreen(); } catch { /* calibrate where we are, then */ }
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
  // loadHome is the only other thing that puts the skeleton away, so a
  // search that beats it home left three shimmering shelves stacked over
  // the results until the shelves happened to arrive.
  el.loading.hidden = true;
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

/* How long the camera and the models get before the overlay admits that
 * something is wrong and offers the way back.  Comfortably past a cold
 * model load on a slow line; well short of giving up on the session. */
const STARTUP_PATIENCE_MS = 12000;

async function selectClip(clip) {
  if (!browsing) return;
  // Only the file off this device needs the sphere.
  if (clip.local && !renderer) {
    notify(`This browser has no WebGL2, so a file off your device cannot be drawn${rendererError ? ` (${rendererError.message})` : ""}.`);
    return;
  }
  const my = ++session;
  browsing = false;
  started = true;
  playing = clip;
  playerReady = false;
  pendingPlay = false;
  retryAction = "library";
  engineMode = clip.local ? "local" : "embed";
  document.body.classList.toggle("embedded", !clip.local);
  currentMax = qualityCap();
  frameMs = 16;
  slowSince = 0;
  el.retry.textContent = "Try again";
  el.notice.hidden = true;
  document.body.classList.remove("browsing");

  // Wake the media element inside the click, so the browser will let a
  // later, programmatic play() through once calibration is done.
  el.video.load();

  // Fullscreen for the whole session: only this click can grant it, and
  // calibration is best done at the size the video will play at.  The one
  // thing that outranks it is the camera prompt, which chrome shows by
  // dropping the page straight back out of fullscreen -- so the first time
  // it will be asked, the ask goes first and the fullscreen follows it.
  const askFirst = !(await cameraGranted());
  if (session !== my) return;
  if (!askFirst) goFullscreen().catch(() => {});

  el.overlay.classList.remove("gone");
  el.retry.hidden = true;
  el.overlaytext.textContent = "Starting the gaze tracker…";

  hud.setTitle(clip.title);
  qualityText = null;

  if (clip.local) {
    // Nothing to fetch and nobody to ask: the file is already here, and its
    // sound is muxed into it.
    el.video.src = clip.src;
    qualityLine = "Playing from this device";
    playerReady = true;
  } else {
    // Building youtube's player takes a few seconds; let it happen
    // underneath the camera prompt and the calibration countdown rather
    // than before them.
    openEmbed(clip, my);
  }

  // The camera prompt also wants the click's activation.  Ask for it now,
  // while the models finish loading in parallel.
  const camera = ensureCamera();
  // The engine is awaited first, and a failure there returns without ever
  // reaching the camera.  A refusal that then arrives has nobody listening
  // for it, which the browser reports as an unhandled rejection; this marks
  // it handled without taking the await below out of the story.
  camera.catch(() => {});
  // A wait this long is a wait that has gone wrong -- a permission prompt
  // the browser never put on screen, models that are not going to arrive --
  // and the overlay has just hidden the one control that lets go of it,
  // leaving a page reload as the only way back to the shelves.  Put it back.
  const stuck = setTimeout(() => {
    if (session === my && !calibrated) el.retry.hidden = false;
  }, STARTUP_PATIENCE_MS);
  try {
    await ensureEngine();
    await camera;
  } catch (error) {
    clearTimeout(stuck);
    if (session === my) fail(error.message, true);
    return;
  }
  clearTimeout(stuck);
  if (session !== my) return;
  el.retry.hidden = true;
  if (askFirst) await fullscreenAfterCamera(my);
  if (session !== my) return;

  if (everCalibrated) {
    calibrated = true;
    body.rest();
    toast("Using the calibration from earlier — press C to redo it");
    maybePlay();
  } else {
    runCalibration("Look at the dot.");
  }
  watchTabVisibility();
}

/* Everything from youtube plays in youtube's own iframe player, gaze-steered
 * through its spherical API.  It joins the same handshake the local path
 * uses, so calibration and the play gate need not know which engine won. */
async function openEmbed(clip, my) {
  try {
    await embedPlayer.open(clip.id, {
      onEnded: () => { if (session === my) returnToLibrary(); },
      onError: (error) => {
        if (session !== my) return;
        returnToLibrary();
        notify(`“${clip.title}”: ${error.message}`);
      },
    });
    // Not close(): there is one player for the life of the page, so it
    // would stop whatever is loaded *now*.  A session only ends through
    // returnToLibrary, which has closed the player already.
    if (session !== my) return;
    embedPlayer.capHeight(currentMax);
    embedPlayer.pause();  // hold for calibration, like the local path
    // A deep link arrives with no title; the player has the real one.
    const title = embedPlayer.title();
    if (title && playing === clip && clip.title === "Direct link") {
      clip.title = title;
      hud.setTitle(title);
    }
    qualityLine = "youtube player — ads possible";
    playerReady = true;
    if (pendingPlay) {
      pendingPlay = false;
      el.overlay.classList.add("gone");
      tryPlay();
    }
  } catch (error) {
    if (session !== my) return;
    returnToLibrary();
    notify(`“${clip.title}” would not play: ${error.message}`);
  }
}

/* One remote for two engines: the local <video>, or the embed. */
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

/* Whether the picture is stalled waiting for bytes.  The <video> says so
 * through its own events -- `waiting` when playback has run out of buffer,
 * cleared by anything that means frames are moving again -- and youtube's
 * player through its state. */
let videoBuffering = false;
el.video.addEventListener("waiting", () => { videoBuffering = true; });
for (const name of ["playing", "canplay", "pause", "seeked", "emptied"]) {
  el.video.addEventListener(name, () => { videoBuffering = false; });
}

/* Where the clip is, for the HUD: one shape from both engines. */
function mediaStatus() {
  if (engineMode === "embed") return embedPlayer.status();
  return {
    currentTime: el.video.currentTime,
    duration: el.video.duration,
    paused: el.video.paused,
    buffering: videoBuffering && !el.video.paused,
  };
}

/* Playback starts when the slower of the two journeys finishes: the player
 * becoming ready, or the viewer calibrating. */
function maybePlay() {
  if (playerReady) {
    el.overlay.classList.add("gone");
    tryPlay();
  } else {
    pendingPlay = true;
    el.overlay.classList.remove("gone");
    el.overlaytext.textContent = "Starting youtube's player…";
  }
}

function tryPlay() {
  mediaPlay().then(() => {
    if (qualityLine) { toast(qualityLine); qualityLine = null; }
    // The three seconds of HUD a viewer gets are counted from here, not
    // from the click that picked the video a calibration ago.
    lastPointerAt = performance.now();
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
  ringReset();
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
  clearVideo();
  releaseLocal();
  embedPlayer.close();
  engineMode = "embed";
  document.body.classList.remove("embedded");
  body.rest();
  // The camera belongs to a playing session, not to browsing the shelves:
  // release it, light and all, until the next video is picked.
  releaseCamera();
  lastReadingAt = 0;
  lastOut = null;
  readingsStale = false;
  qualityText = null;
  hud.setTitle("");
  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  ringReset();
  el.retry.hidden = true;
  el.retry.textContent = "Try again";
  document.body.classList.add("browsing");
  updateHud();
  paintPeripheral();
  // The chrome is display:none while browsing, but the next pick lifts that
  // before its overlay is up; nothing of the last clip may linger in it.
  hud.paintStatus({ quality: null, engine: "embed", tracker: "ok" });
  hud.paintTransport({ currentTime: 0, duration: NaN, paused: true, volume: settings.volume, muted: settings.muted });
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

/* Let the element go: paused, pointed at nothing, and reloaded, so the
 * decoder lets the last file's frames go with it. */
function clearVideo() {
  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();
}

// A file off this device has one quality: the one it was encoded at.
el.video.addEventListener("loadedmetadata", () => {
  if (engineMode === "local") qualityText = qualityLabel(el.video.videoHeight);
});

el.video.addEventListener("ended", returnToLibrary);
// Only a local file ever reaches this element, so a decode that fails is a
// file this browser cannot read rather than anything to do with the network.
el.video.addEventListener("error", () => {
  if (browsing || !el.video.getAttribute("src")) return;
  const title = playing ? playing.title : "That video";
  returnToLibrary();
  notify(`“${title}” would not play. This browser may not decode that file — H.264 or VP9 in MP4 or WebM is the safe pair.`);
});

/* ---------- the settings panel ---------- */

/* The panel's inputs carry data-setting; settings.js reads and writes them
 * generically, so the markup is free to move. */
bindSettingsPanel(el.settings, () => {
  const capBefore = qualityCap();
  settings = readSettingsPanel(el.settings, settings);
  renderSettingsPanel(el.settings, settings);
  applySettings();
  saveSettings();
  const cap = qualityCap();
  if (cap !== capBefore) {
    currentMax = cap;
    if (started) applyQualityCap(cap);  // re-pin the level, mid-video
  }
});

/* The cameras on offer, refreshed whenever the panel opens.  Labels only
 * arrive once a camera has been granted, so an early list is numbered. */
async function refreshCameras() {
  const cameras = await GazeTracker.cameras();
  fillCameraOptions(el.cameraSelect, cameras, settings.camera);
}

let pausedBySettings = false;

function toggleSettings(force) {
  const show = force === undefined ? el.settings.hidden : force;
  el.settings.hidden = !show;
  // Opening the panel pauses whatever plays; closing it resumes only what
  // the panel itself paused, never a pause the viewer chose.
  if (show) {
    renderSettingsPanel(el.settings, settings);
    refreshCameras().catch(() => {});
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
  renderSettingsPanel(el.settings, settings);
  applySettings();
  saveSettings();
});

/* The transport's two buttons, for a pointer.  Blurred after the click so
 * a Space that follows toggles playback once, through the key handler,
 * rather than twice. */
el.playbtn.addEventListener("click", (event) => {
  event.currentTarget.blur();
  if (!started || !calibrated) return;
  mediaPaused() ? mediaPlay().catch(() => {}) : mediaPause();
});
el.mutebtn.addEventListener("click", (event) => {
  event.currentTarget.blur();
  toggleMute();
});
el.hudgear.addEventListener("click", (event) => {
  event.currentTarget.blur();
  toggleSettings();
});
el.emptyfile.addEventListener("click", () => el.localfile.click());

/* ---------- calibration ---------- */

let awaitingGeneration = null;
let seenResets = 0;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let awayShown = false;

/* The fixation ring says everything the countdown and the hold used to say
 * in words, so the eye never has a reason to leave the dot: three arcs
 * light one per second, then the ring fills with the hold.
 *
 * The two phases are told apart by colour, not by position -- nothing here
 * moves the dot, which sits on the exact centre the calibration measures
 * against.  Counting down, the dot and its arcs are brass: the tracker is
 * not reading yet.  The hold lights the lamp, the page's one live mark. */
function ringCountdown(remaining) {
  el.dot.classList.add("getready");
  for (const arc of el.dot.querySelectorAll(".ring-count")) {
    arc.classList.toggle("on", Number(arc.dataset.third) <= 4 - remaining);
  }
}

function ringHold(fraction) {
  el.dot.classList.remove("getready");
  el.dot.classList.add("holding");
  el.dot.style.setProperty("--fill", String(Math.max(0, Math.min(1, fraction))));
}

function ringReset() {
  el.dot.classList.remove("on", "getready", "holding", "away");
  el.dot.style.setProperty("--fill", "0");
  for (const arc of el.dot.querySelectorAll(".ring-count")) arc.classList.remove("on");
}

/* One line under the ring, one thing at a time. */
function setOverlayLine(text) {
  el.overlaytext.textContent = text;
}

/* The line the measuring phase owns, in one place: a look-away puts it back
 * when the eye returns, and the two must not drift apart. */
const HOLD_LINE = "Hold still — measuring.";

function lookAgain() {
  awayShown = true;
  setOverlayLine("You looked away. Look at the dot.");
  el.dot.style.setProperty("--fill", "0");
  el.dot.classList.add("away");
  setTimeout(() => el.dot.classList.remove("away"), 600);
}

let calibrationRun = 0;

async function runCalibration(headline) {
  // A pass superseded mid-countdown -- Esc, another video, a second resize
  // -- must not wake up later and fight the pass that replaced it.
  const run = ++calibrationRun;
  mediaPause();
  // A play that was only waiting for youtube's player is now waiting for
  // this instead.  Left standing, the moment the player said it was ready it
  // would take the overlay away -- ring, dot, line and all -- and start the
  // clip, and the pass would go on measuring, unseen, against wherever the
  // viewer's eyes had followed the picture to.  finishCalibration asks again
  // when the dots are done.
  pendingPlay = false;
  // Calibration belongs in fullscreen: the size the video plays at.  A key
  // press or a tap carries the permission; a programmatic rerun without a
  // gesture is refused quietly and calibrates where it is.
  goFullscreen().catch(() => {});
  calibrated = false;
  awaitingGeneration = null;
  seenResets = controller.resets;
  body.rest();
  el.overlay.classList.remove("gone");
  el.overlay.classList.add("calibrating");
  el.retry.hidden = true;
  ringReset();
  el.dot.classList.add("on");
  // Count down before the hold starts, so it begins while the viewer is
  // already fixed on the dot rather than still moving onto it.  The count
  // is drawn on the ring, where the eyes already are.
  //
  // These three seconds are not the calibration, and a viewer who thinks
  // they are will hold their breath through them and relax exactly when
  // the measuring starts.  So the countdown says it is only the run-up --
  // in a word after the headline, and in brass rather than lamp -- and the
  // hold announces itself when it actually begins.  Every headline this is
  // called with ends in "look at the dot", so the clause reads on from all
  // of them.
  setOverlayLine(`${headline} Get ready…`);
  for (let count = 3; count > 0; count--) {
    ringCountdown(count);
    await wait(1000);
    if (run !== calibrationRun || browsing) return;
  }
  setOverlayLine(HOLD_LINE);
  ringHold(0);
  awayShown = false;
  awaitingGeneration = controller.recalibrate();
}

function finishCalibration() {
  calibrated = true;
  everCalibrated = true;
  awaitingGeneration = null;
  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  ringReset();
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
  wakeHud();
  const key = event.key.toLowerCase();
  // A control inside the panel owns its own keys (a slider's arrows, a
  // select's space); only Esc reaches past it.
  const inPanel = event.target instanceof Element && event.target.closest("#settings");
  if (event.key === "Escape") {
    if (!el.settings.hidden) toggleSettings(false);
    else returnToLibrary();
  }
  else if (inPanel) return;
  else if (key === "s") toggleSettings();
  else if (key === "r") recentre();
  else if (key === "c") recalibrate();
  else if (key === "m") toggleMute();
  // The play button is gated on a finished calibration; these were not, and
  // Space during the hold started the clip behind the overlay -- the dots
  // then measured against a moving picture the viewer's eyes had followed.
  else if (!calibrated) { /* the dots first */ }
  else if (key === " ") { event.preventDefault(); mediaPaused() ? mediaPlay().catch(() => {}) : mediaPause(); }
  else if (key === "f") {
    document.fullscreenElement ? document.exitFullscreen() : goFullscreen().catch(() => {});
  }
  else if (event.key === "ArrowRight") mediaSeek(5);
  else if (event.key === "ArrowLeft") mediaSeek(-5);
  else if (event.key === "ArrowUp") { event.preventDefault(); setVolume(settings.volume + 0.1); }
  else if (event.key === "ArrowDown") { event.preventDefault(); setVolume(settings.volume - 0.1); }
});

el.touchbar.addEventListener("click", (event) => {
  const action = event.target.dataset && event.target.dataset.action;
  if (action === "library") returnToLibrary();
  else if (action === "recentre") recentre();
  else if (action === "recalibrate") recalibrate();
  else if (action === "settings") toggleSettings();
});

/* A tab nobody is looking at needs no camera: the light goes off, the
 * machine gets its cycles back, and the camera is reopened the moment the
 * tab is looked at again. */
let watchingTab = false;
function watchTabVisibility() {
  if (watchingTab) return;
  watchingTab = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (cameraOpen) releaseCamera();
      return;
    }
    if (started) ensureCamera().catch(() => {});
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

renderSettingsPanel(el.settings, settings);
applySettings();
requestAnimationFrame(frame);
loadHome().then(() => {
  const params = new URLSearchParams(location.search);
  if (params.has("selftest")) selfTest();
  // ?video=<id> jumps straight to one upload; playback will ask for the
  // one click the browser insists on before it plays sound.
  else if (params.get("video")) selectClip({ id: params.get("video"), title: "Direct link" });
});

// For a console or a test harness.
window.lazyvr = { body, controller, tracker, hud, embed: embedPlayer, get request() { return request; }, get reading() { return lastReading; }, get settings() { return settings; }, get engineMode() { return engineMode; }, YAW_LIMIT };
