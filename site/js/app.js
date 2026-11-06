/* LazyVR: youtube's 360 videos (or a 360 file off this disk), steered by
 * head pose, in a plain browser tab.
 *
 * This file is the orchestrator: the library ⇄ player screens, one session
 * per picked video, and the wiring between the parts --
 *   camera.js  HeadTracker: the camera and the worker that turns frames into readings
 *   steer.js   Steering: readings → view, at display rate
 *   embed.js   youtube's player, steered and sized for 360 quality (quality.js)
 *   render.js  the WebGL sphere, for local files only
 *   player.js  the player screen's DOM; chrome.js its pure rules
 *   library.js the shelves and search; settings.js the settings
 *
 * Every async step belongs to a session (`my = ++session`) and re-checks it
 * after each await, so leaving the player strands everything still in flight.
 */

import { HeadTracker } from "./camera.js";
import {
  PERMANENT_REFUSALS, diagnosticsRows, isVideoId, qualityLabel, retryableRefusal, trackerGaveUp, transportSnapshot,
  videoIdFrom, volumeStep,
} from "./chrome.js";
import { EmbedPlayer, refusal } from "./embed.js";
import { Latest, fetchHome, fetchSearch, isAbort, renderResults, renderShelves } from "./library.js";
import { PlayerUI } from "./player.js";
import { MISSING_API_CAP, StallMonitor, chooseTier, decodeCap, tierBelow } from "./quality.js";
import { Renderer } from "./render.js";
import {
  SettingsPanel, createSaver, readSettings, resetSteeringAndPicture, screenOffsetCm, steeringOptions,
} from "./settings.js";
import { Steering } from "./steer.js";

const $ = (id) => document.getElementById(id);
const el = {
  body: document.body, canvas: $("view"), embed: $("embed"), video: $("video"), cam: $("cam"),
  toast: $("toast"), settings: $("settings"), gear: $("gear"), setsbtn: $("setsbtn"),
  home: $("home"), results: $("results"), resultline: $("resultline"), backhome: $("backhome"),
  searchForm: $("search"), query: $("query"), grid: $("grid"), notice: $("libnotice"),
  empty: $("libempty"), emptytech: $("libemptytech"), emptyretry: $("emptyretry"), emptyfile: $("emptyfile"),
  loading: $("libloading"), local: $("local"), localfile: $("localfile"), volumeWrap: document.querySelector(".volume"),
  player: $("player"),
};

const absNowSec = () => (performance.timeOrigin + performance.now()) / 1000;
const HINT = "Turn your head to look around · C recenters";
const NO_CAMERA = "Camera unavailable — drag to look around";

/* ---------- settings ---------- */

const storage = (() => {
  try { return window.localStorage; } catch { return null; }
})();
let settings = readSettings(storage);
const saver = createSaver(storage);
window.addEventListener("pagehide", () => saver.flush());

/* ---------- the parts ---------- */

const steering = new Steering(steeringOptions(settings));
const tracker = new HeadTracker({
  models: "models",
  onStatus: (text) => { trackerStatus = text; },
  onReading,
  onError: onTrackerError,
});
const embed = new EmbedPlayer(el.embed);
embed.fov = settings.fov;
embed.setSound(settings.volume, settings.muted);
applyScreenOffset();

/* The sphere is only needed for a local file; built on first use so a
 * machine without WebGL2 loses only "Play a file…". */
let renderer = null;
function ensureRenderer() {
  if (renderer) return renderer;
  try {
    renderer = new Renderer(el.canvas, el.video, settings.fov);
  } catch (error) {
    toast(`This browser cannot draw a 360 file (${error.message}).`);
    return null;
  }
  return renderer;
}

/* The decode ceiling: answered once, used by every tier choice after. */
let decodeCapHeight = MISSING_API_CAP;
decodeCap().then((cap) => {
  decodeCapHeight = cap;
  if (playerOpen) applyTier();
}, () => {});

/* ---------- session state ---------- */

let session = 0;
let playerOpen = false;
let clip = null;              // { id, title, local?, src? }
let engine = "embed";         // 'embed' | 'local'
let phase = null;             // 'ready' | 'loading' | 'playing' | 'ended' | 'error'
let returnCard = null;        // the card to give focus back to
let pushedEntry = false;      // we pushed a history entry for this player
let weEnteredFullscreen = false;
let fullscreenWaiter = null;  // cleanup for the one-click fullscreen fallback

// Tracking: what the viewer wants, and what the camera is doing.
let trackingWanted = false;
let cameraBlocked = null;     // a reason, when the camera cannot be had
let cameraState = "off";      // 'off' | 'opening' | 'open'
let camOp = 0;                // bumps on every start/stop; stale opens stand down
let reopenOnShow = false;
let declinedThisVisit = false;
let hintShown = false;
let trackerStatus = "";
let lastReading = null;

// Quality.
let tierCeiling = null;       // session-sticky step-down after stalls
let stallToasted = false;
const stalls = new StallMonitor();

let localUrl = null;
let localBuffering = false;

/* ---------- the player UI ---------- */

const ui = new PlayerUI(document, {
  playPause, seekTo, seekBy, setVolume, volumeBy, toggleMute,
  recenter: () => { if (playerOpen) steering.recenter(); },
  toggleTracking, toggleSettings, closeSettings: () => panel.close(),
  settingsOpen: () => panel.isOpen,
  toggleFullscreen, back, replay, retry, useCamera, noCamera, bigPlay,
  drag: (dYaw, dPitch) => { if (playerOpen) steering.drag(dYaw, dPitch); },
  fov: () => settings.fov,
  isOpen: () => playerOpen,
  isPaused: mediaPaused,
});
ui.setVolume(settings.volume, settings.muted);
ui.showDiagnostics(settings.diagnostics);
ui.setFullscreen(Boolean(document.fullscreenElement));

const panel = new SettingsPanel(el.settings, {
  getSettings: () => settings,
  onChange: (key, next) => {
    settings = next;
    saver.save(settings);
    applySetting(key);
  },
  onReset: () => {
    settings = resetSteeringAndPicture(settings);
    saver.save(settings);
    panel.render();
    for (const key of ["sensitivity", "fov", "quality"]) applySetting(key);
  },
  onOpen: () => {
    ui.setSettingsExpanded(true);
    el.gear.setAttribute("aria-expanded", "true");
    tracker.cameras().then((cameras) => panel.fillCameras(cameras, settings.camera), () => {});
    paintQualityLine();
  },
  onClose: () => {
    ui.setSettingsExpanded(false);
    el.gear.setAttribute("aria-expanded", "false");
  },
  toggles: [el.gear, el.setsbtn],
});

function toggleSettings() {
  panel.toggle();
}

/* One setting changed: tell whoever obeys it. */
function applySetting(key) {
  switch (key) {
    case "sensitivity": case "turnSpeed": case "eyeAssist": case "invertYaw": case "invertPitch":
      steering.configure(steeringOptions(settings));
      break;
    case "fov":
      embed.fov = settings.fov;
      if (renderer) renderer.setFov(settings.fov);
      applyTierSoon();
      break;
    case "quality":
      applyTier();
      break;
    case "camera":
      // A different device mid-session: reopen on it.
      if (playerOpen && trackingWanted && cameraState !== "off") startCamera(session);
      break;
    case "cameraPosition":
      applyScreenOffset();
      break;
    case "diagnostics":
      ui.showDiagnostics(settings.diagnostics);
      break;
    default:
      break;
  }
}

/* Camera position feeds the pose solver (in the worker, or inline); the
 * tracker keeps it and hands it to every engine it loads. */
function applyScreenOffset() {
  tracker.configure({ screenOffsetCm: screenOffsetCm(settings) });
}

/* ---------- sound ---------- */

function applySound() {
  el.video.volume = settings.volume;
  el.video.muted = settings.muted;
  embed.setSound(settings.volume, settings.muted);
  ui.setVolume(settings.volume, settings.muted);
}

function setVolume(volume) {
  if (!Number.isFinite(volume)) return;
  settings = { ...settings, volume: Math.max(0, Math.min(1, volume)), muted: volume > 0 ? false : settings.muted };
  applySound();
  saver.save(settings);
}

let volumeShowTimer = null;
function volumeBy(delta) {
  // Muted, ↓ changes nothing (the remembered level survives); ↑ unmutes from it.
  const next = volumeStep(settings, delta);
  if (next) {
    settings = { ...settings, ...next };
    applySound();
    saver.save(settings);
  }
  // Show the slider for a moment so the key press has something to answer it.
  el.volumeWrap.classList.add("open");
  clearTimeout(volumeShowTimer);
  volumeShowTimer = setTimeout(() => el.volumeWrap.classList.remove("open"), 1200);
}

function toggleMute() {
  // Unmuting at zero volume would be silent; bring some volume back.
  const muted = !settings.muted;
  settings = { ...settings, muted, volume: !muted && settings.volume === 0 ? 0.5 : settings.volume };
  applySound();
  saver.save(settings);
}

/* ---------- toasts and notices ---------- */

function toast(message, ms = 2800) {
  el.toast.textContent = message;
  el.toast.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.toast.classList.remove("on"), ms);
}

function notify(message) {
  el.notice.textContent = message;
  el.notice.hidden = !message;
}

/* ---------- media: one remote for two engines ---------- */

function mediaPaused() {
  if (!playerOpen || phase === "ready" || phase === "ended" || phase === "error") return true;
  return engine === "embed" ? embed.paused : el.video.paused;
}

function mediaPlay() {
  if (engine === "embed") {
    embed.play();
    return;
  }
  const my = session;
  el.video.play().catch((error) => {
    if (session !== my || !playerOpen) return;
    if (error && error.name === "NotAllowedError") ui.showBigPlay("blocked");
  });
}

function mediaPause() {
  if (engine === "embed") embed.pause();
  else el.video.pause();
}

function playPause() {
  if (!playerOpen) return;
  if (phase === "ready") { bigPlay(); return; }
  if (phase === "ended") { replay(); return; }
  if (phase === "error") return;
  if (mediaPaused()) mediaPlay(); else mediaPause();
}

function mediaTime() {
  return engine === "embed" ? embed.currentTime() : el.video.currentTime || 0;
}

function mediaDuration() {
  if (engine === "embed") return embed.duration() || NaN;
  const d = el.video.duration;
  return Number.isFinite(d) && d > 0 ? d : NaN;
}

function localBuffered() {
  const video = el.video;
  const d = mediaDuration();
  if (!Number.isFinite(d)) return 0;
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i += 1) {
    if (video.buffered.start(i) <= t + 0.5 && video.buffered.end(i) >= t) return video.buffered.end(i) / d;
  }
  return 0;
}

function seekTo(seconds) {
  if (!playerOpen || phase === "ready" || phase === "error" || !Number.isFinite(seconds)) return;
  stalls.seeked(absNowSec());
  if (engine === "embed") {
    embed.seekTo(seconds);
  } else {
    const d = mediaDuration();
    el.video.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(seconds, Math.max(0, d - 0.1)) : seconds);
  }
  if (phase === "ended") {
    phase = "playing";
    ui.showEnd(false);
    mediaPlay();
  }
}

function seekBy(delta) {
  seekTo(mediaTime() + delta);
}

function replay() {
  if (!playerOpen || phase !== "ended") return;
  phase = "playing";
  ui.showEnd(false);
  stalls.seeked(absNowSec());
  if (engine === "embed") embed.seekTo(0); else el.video.currentTime = 0;
  mediaPlay();
}

/* ---------- the frame loop: only while the player is open ---------- */

let raf = 0;
let lastFrame = 0;
let lastUi = 0;
let lastDiag = 0;
let fps = NaN;

function startLoop() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function frame(now) {
  raf = 0;
  if (!playerOpen) return;
  raf = requestAnimationFrame(frame);
  const dt = now - lastFrame;
  lastFrame = now;
  if (dt > 0 && dt < 1000) fps = Number.isFinite(fps) ? fps + 0.05 * (1000 / dt - fps) : 1000 / dt;

  const view = steering.tick((performance.timeOrigin + now) / 1000);
  if (engine === "embed") embed.steer(view);
  else if (renderer) renderer.draw(view);

  if (now - lastUi >= 250) {
    lastUi = now;
    paintUi();
  }
  if (settings.diagnostics && now - lastDiag >= 100) {
    lastDiag = now;
    paintDiagnostics(view);
  }
}

function trackingUiState() {
  if (cameraBlocked) return "unavailable";
  if (!trackingWanted) return "off";
  if (cameraState === "opening") return "starting";
  return steering.state;
}

function paintUi() {
  // Ended with a known duration pins the clock to the end (transportSnapshot),
  // so the live time and buffer are only read when they will be shown.
  const playable = phase === "playing" || phase === "loading" || phase === "ended";
  const duration = playable ? mediaDuration() : NaN;
  const live = playable && !(phase === "ended" && Number.isFinite(duration));
  ui.paintTransport(transportSnapshot({
    phase,
    time: live ? mediaTime() : 0,
    duration,
    buffered: !live ? 0 : engine === "embed" ? embed.bufferedFraction() : localBuffered(),
    paused: mediaPaused(),
  }));
  const buffering = phase === "playing" && (engine === "embed" ? embed.buffering : localBuffering && !el.video.paused);
  ui.setBuffering(buffering);
  ui.setTracking(trackingUiState());
  ui.setFullscreen(Boolean(document.fullscreenElement));
  ui.tick();
}

function currentQuality() {
  if (engine === "embed") {
    const q = embed.quality();
    return { label: q ? qualityLabel(q.height) : null, k: embed.k };
  }
  return { label: qualityLabel(el.video.videoHeight), k: NaN };
}

function paintDiagnostics(view) {
  ui.paintDiagnostics(diagnosticsRows({
    steer: steering.diagnostics(),
    view,
    tracker: trackingWanted && cameraState !== "off"
      ? { rate: tracker.rate, latencyMs: lastReading ? lastReading.latencyMs : NaN, mode: tracker.mode }
      : null,
    quality: currentQuality(),
    fps,
  }));
}

function paintQualityLine() {
  const label = playerOpen ? currentQuality().label : null;
  panel.setQualityLine(label ? `Playing at ${label}` : "");
}

/* ---------- quality (youtube only) ---------- */

function applyTier() {
  if (!playerOpen || engine !== "embed") return;
  embed.setTier(chooseTier({
    cssWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    hFov: settings.fov,
    setting: settings.quality,
    decodeCap: decodeCapHeight,
    ceiling: tierCeiling,
  }));
}

let tierTimer = null;
function applyTierSoon() {
  clearTimeout(tierTimer);
  tierTimer = setTimeout(applyTier, 200);
}
window.addEventListener("resize", applyTierSoon);
document.addEventListener("fullscreenchange", () => {
  applyTierSoon();
  if (!document.fullscreenElement) weEnteredFullscreen = false;
});

/* Three stalls in a minute: size the layout one tier down for the rest of
 * this video, never back up. */
function stepQualityDown() {
  // In a narrow window adjacent tiers can clamp to the same layout (K_MAX),
  // so keep stepping until the iframe's layout actually shrinks.
  const before = embed.layout().innerW;
  let tier = embed.tier;
  for (;;) {
    const below = tierBelow(tier);
    if (!below || below.w < 1280) return;
    tierCeiling = below;
    applyTier();
    if (embed.layout().innerW < before) break;
    tier = below;
  }
  if (!stallToasted) {
    stallToasted = true;
    toast("Lowering quality to keep it smooth");
  }
}

/* ---------- media events ---------- */

function onMediaPlaying(my) {
  if (session !== my || !playerOpen) return;
  const first = phase !== "playing";
  if (phase === "loading" || phase === "playing") phase = "playing";
  stalls.playing(absNowSec());
  ui.showBigPlay(null);
  if (first && engine === "embed" && !clip.title) {
    const title = embed.title();
    if (title) {
      clip.title = title;
      ui.setTitle(title);
      document.title = `${title} · LazyVR`;
    }
  }
}

function onMediaBuffering(my) {
  if (session !== my || !playerOpen) return;
  if (engine === "embed" && stalls.buffering(absNowSec())) stepQualityDown();
}

function onMediaEnded(my) {
  if (session !== my || !playerOpen) return;
  phase = "ended";
  ui.showEnd(true);
  ui.setBuffering(false);
}

function embedHandlers(my) {
  return {
    onPlaying: () => onMediaPlaying(my),
    onBuffering: () => onMediaBuffering(my),
    onPaused: () => { if (session === my) stalls.paused(absNowSec()); },
    onEnded: () => onMediaEnded(my),
    onError: (message, code) => {
      if (session !== my || !playerOpen) return;
      showError(`youtube would not play this video: ${message}.`, { retry: retryableRefusal(code) });
    },
    onAutoplayBlocked: () => {
      if (session === my && playerOpen && phase !== "ended") ui.showBigPlay("blocked");
    },
    onQuality: () => { if (session === my && panel.isOpen) paintQualityLine(); },
  };
}

const localActive = () => playerOpen && engine === "local" && el.video.getAttribute("src");

el.video.addEventListener("playing", () => { localBuffering = false; if (localActive()) onMediaPlaying(session); });
el.video.addEventListener("waiting", () => { localBuffering = true; });
for (const name of ["canplay", "pause", "seeked", "emptied"]) {
  el.video.addEventListener(name, () => { localBuffering = false; });
}
el.video.addEventListener("ended", () => { if (localActive()) onMediaEnded(session); });
el.video.addEventListener("error", () => {
  if (!localActive()) return;
  showError("This browser could not decode that file. H.264 or VP9 in MP4 or WebM is the safe pair.", { retry: false });
});

function showError(message, { retry = true } = {}) {
  phase = "error";
  ui.showBigPlay(null);
  ui.showEnd(false);
  ui.showSheet(false);
  ui.showError(message, { retry });
}

/* Retry the same video in the same session. */
function retry() {
  if (!playerOpen || phase !== "error") return;
  ui.showError(null);
  phase = "loading";
  startMedia(session);
}

/* ---------- opening and closing the player ---------- */

/* Leave whatever is playing and put the player screen up for `next`. */
function beginSession(next, { card = null, history: mode = "push" } = {}) {
  if (playerOpen) teardownSession();
  const my = ++session;
  playerOpen = true;
  clip = next;
  engine = next.local ? "local" : "embed";
  phase = "loading";
  returnCard = card || returnCard;
  tierCeiling = null;
  stallToasted = false;
  stalls.reset();
  lastReading = null;
  localBuffering = false;
  cameraBlocked = null;
  trackingWanted = false;
  steering.reset();
  steering.setEnabled(false);

  el.body.classList.remove("browsing");
  el.body.classList.toggle("embedded", engine === "embed");
  document.title = next.title ? `${next.title} · LazyVR` : "LazyVR";
  notify("");
  ui.reset(next.title);
  ui.setVolume(settings.volume, settings.muted);
  ui.setTracking("off");
  ui.showDiagnostics(settings.diagnostics);
  if (panel.isOpen) panel.close({ restoreFocus: false });

  if (mode === "push") {
    history.pushState({ lazyvr: "player", v: next.id || null }, "", next.id ? `?v=${next.id}` : location.pathname);
    pushedEntry = true;
  } else if (mode === "replace") {
    history.replaceState({ lazyvr: "player", v: next.id || null }, "", next.id ? `?v=${next.id}` : location.pathname);
  }
  lastFrame = performance.now();
  lastUi = 0;
  startLoop();
  return my;
}

/* A user gesture started this: media, fullscreen and the camera may all
 * use it. */
function start(my) {
  ui.showBigPlay(null);
  phase = "loading";
  startMedia(my);
  startTrackingFlow(my);
}

function startMedia(my) {
  if (engine === "embed") {
    embed.fov = settings.fov;
    embed.setSound(settings.volume, settings.muted);
    applyTier();
    embed.open(clip.id, embedHandlers(my)).catch((error) => {
      if (session !== my || !playerOpen) return;
      showError(`youtube's player would not start: ${error.message}.`, { retry: retryableRefusal(refusalCode(error)) });
    });
  } else {
    renderer.setFov(settings.fov);
    applySound();
    el.video.src = clip.src;
    renderer.setSource();
    mediaPlay();
  }
}

/* A refusal before youtube's player was ready arrives as an Error; its code
 * is on it when embed.js attaches one, else read back from the message. */
function refusalCode(error) {
  if (error && Number.isFinite(error.code)) return error.code;
  const message = error && error.message;
  return PERMANENT_REFUSALS.find((code) => refusal(code) === message) ?? null;
}

/* Pick from the library (a click: a user gesture). */
function pick(next, card = null, historyMode = "push") {
  if (next.local && !ensureRenderer()) {
    if (next.src) URL.revokeObjectURL(next.src);
    return;
  }
  const my = beginSession(next, { card, history: historyMode });
  // After beginSession: its teardown releases the previous file's URL.
  if (next.local) localUrl = next.src;
  start(my);
}

/* A deep link or a history entry: the player is up with one big Play, since
 * fullscreen and sound both need a gesture. */
function openReady(id) {
  beginSession({ id, title: "" }, { history: "none" });
  phase = "ready";
  ui.showBigPlay("ready");
  embed.preload();
  // No library renders on a deep link, so its idle preload never runs: fetch
  // the face model now, while the viewer reaches for Play.
  tracker.load().catch((error) => console.warn("LazyVR: head tracking preload failed:", error.message));
}

function bigPlay() {
  if (!playerOpen) return;
  if (phase === "ready") {
    start(session);
    return;
  }
  ui.showBigPlay(null);
  mediaPlay();
}

/* Stop everything a session owns; the screen stays as it is. */
function teardownSession() {
  session += 1;
  stopCamera();
  trackingWanted = false;
  reopenOnShow = false;
  if (fullscreenWaiter) fullscreenWaiter();
  if (engine === "embed") embed.close();
  clearVideo();
  releaseLocal();
  ui.hideAllPanels();
  ui.closeHelp();
}

function closePlayer() {
  if (!playerOpen) return;
  teardownSession();
  playerOpen = false;
  phase = null;
  clip = null;
  pushedEntry = false;
  stopLoop();
  steering.reset();
  if (panel.isOpen) panel.close({ restoreFocus: false });
  el.body.classList.add("browsing");
  el.body.classList.remove("embedded", "chrome-asleep", "dragging");
  document.title = "LazyVR";
  ui.tick();
  if (weEnteredFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  weEnteredFullscreen = false;
  const card = returnCard;
  returnCard = null;
  // After the style flip, so the card is focusable again.
  requestAnimationFrame(() => {
    if (card && card.isConnected) card.focus({ preventScroll: false });
  });
  // A deep link opened before the shelves arrived leaves them to load now.
  if (homeState === "idle") loadHome();
}

/* The back button, Esc, the end and error panels' Back: leave through
 * history when we added an entry, so the browser's Back stays in step. */
function back() {
  if (!playerOpen) return;
  if (pushedEntry && history.state && history.state.lazyvr === "player") {
    history.back();   // popstate closes the player
    return;
  }
  closePlayer();
  history.replaceState(null, "", location.pathname);
}

window.addEventListener("popstate", (event) => {
  const state = event.state;
  if (playerOpen) {
    pushedEntry = false;
    closePlayer();
  }
  // Forward into a player entry: back to the ready state (it needs a click).
  // The entry before it is the library's, so Back may use history again.
  if (state && state.lazyvr === "player" && isVideoId(state.v)) {
    openReady(state.v);
    pushedEntry = true;
  }
});

function clearVideo() {
  if (!el.video.getAttribute("src")) return;
  el.video.pause();
  el.video.removeAttribute("src");
  el.video.load();
}

function releaseLocal() {
  if (!localUrl) return;
  URL.revokeObjectURL(localUrl);
  localUrl = null;
}

/* ---------- fullscreen ---------- */

function goFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement || typeof root.requestFullscreen !== "function") return Promise.resolve(false);
  return root.requestFullscreen({ navigationUI: "hide" }).then(() => {
    weEnteredFullscreen = true;
    return true;
  });
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else goFullscreen().catch(() => toast("The browser refused fullscreen — press F to try again"));
}

/* Answering the camera prompt can spend the click that would have carried
 * the page into fullscreen.  Try straight away; if refused, the next press
 * anywhere does it (and is not also taken as a click on the picture). */
function fullscreenAfterCamera(my) {
  goFullscreen().catch(() => {
    if (session !== my || document.fullscreenElement) return;
    toast("Click anywhere to go fullscreen", 4000);
    const done = (event) => {
      cleanup();
      if (session !== my || document.fullscreenElement) return;
      if (event.target && event.target.closest && event.target.closest("#surface")) event.stopPropagation();
      goFullscreen().catch(() => {});
    };
    const cleanup = () => {
      document.removeEventListener("pointerdown", done, true);
      if (fullscreenWaiter === cleanup) fullscreenWaiter = null;
    };
    if (fullscreenWaiter) fullscreenWaiter();
    fullscreenWaiter = cleanup;
    document.addEventListener("pointerdown", done, true);
  });
}

/* ---------- the camera and tracking ---------- */

/* 'granted' | 'denied' | 'prompt'.  Browsers that will not answer count as
 * 'prompt', which only costs the slower, safer order. */
async function cameraPermission() {
  try {
    const status = await navigator.permissions.query({ name: "camera" });
    return status.state;
  } catch {
    return "prompt";
  }
}

async function startTrackingFlow(my) {
  if (declinedThisVisit) {
    goFullscreen().catch(() => {});
    setTrackingOff();
    return;
  }
  const permission = await cameraPermission();
  if (session !== my || !playerOpen) return;
  if (permission === "granted") {
    goFullscreen().catch(() => {});
    startCamera(my);
  } else if (permission === "denied") {
    goFullscreen().catch(() => {});
    cameraUnavailable("Camera access is blocked for this site.");
  } else {
    // Ask in our own words first; the video plays behind the sheet.
    ui.showSheet(true);
  }
}

function useCamera() {
  if (!playerOpen) return;
  ui.showSheet(false);
  startCamera(session, { fullscreenAfter: true });
}

function noCamera() {
  if (!playerOpen) return;
  declinedThisVisit = true;
  ui.showSheet(false);
  setTrackingOff();
  goFullscreen().catch(() => {});
}

function setTrackingOff() {
  stopCamera();
  trackingWanted = false;
  steering.setEnabled(false);
  ui.setTracking(trackingUiState());
}

function cameraUnavailable(reason, message = NO_CAMERA, ms = 2800) {
  stopCamera();
  trackingWanted = false;
  cameraBlocked = reason || "unavailable";
  steering.setEnabled(false);
  ui.setTracking("unavailable");
  toast(message, ms);
}

/* The tracker reports its errors here.  Once it has given up (a fatal
 * report: it has already stopped itself), the session falls back to tracking
 * off: the button says so, the picture keeps playing and drag still looks
 * around, and T or the button asks for the camera again. */
function onTrackerError(error, info) {
  const message = error && error.message ? error.message : String(error);
  console.warn("LazyVR head tracking:", message);
  if (!trackerGaveUp({
    fatal: Boolean(info && info.fatal), running: tracker.running, playerOpen, trackingWanted, cameraState,
  })) return;
  const why = message.replace(/[.\s]+$/, "");
  cameraUnavailable(message, `Head tracking stopped (${why}). Drag to look around, or press T to try again.`, 6000);
}

async function startCamera(my, { fullscreenAfter = false } = {}) {
  const op = ++camOp;
  trackingWanted = true;
  cameraBlocked = null;
  cameraState = "opening";
  steering.setEnabled(true);
  ui.setTracking("starting");
  try {
    await tracker.open(el.cam, settings.camera);
  } catch (error) {
    // Stopped or superseded meanwhile (tab hidden, a new session): not a failure.
    if (op !== camOp || session !== my || !playerOpen) return;
    cameraState = "off";
    cameraBlocked = error.message;
    trackingWanted = false;
    steering.setEnabled(false);
    ui.setTracking("unavailable");
    toast(`${NO_CAMERA}. ${error.message}`, 6000);
    if (fullscreenAfter) fullscreenAfterCamera(my);
    return;
  }
  if (op !== camOp || session !== my || !playerOpen) return;
  cameraState = "open";
  applyScreenOffset();
  if (fullscreenAfter) fullscreenAfterCamera(my);
  if (!hintShown) {
    hintShown = true;
    try { sessionStorage.setItem("lazyvr.hint", "1"); } catch { /* fine */ }
    toast(HINT, 4000);
  }
}

function stopCamera() {
  camOp += 1;
  if (cameraState !== "off") tracker.stop();
  cameraState = "off";
  el.cam.srcObject = null;
}

/* The tracking button / T.  Off → on asks for the camera (this is a gesture,
 * so a prompt may appear); on → off lets the camera go. */
function toggleTracking() {
  if (!playerOpen) return;
  if (trackingWanted) {
    setTrackingOff();
    toast("Head tracking off — drag to look around");
    return;
  }
  ui.showSheet(false);
  startCamera(session);
}

function onReading(reading) {
  if (!playerOpen || !trackingWanted || cameraState === "off") return;
  lastReading = reading;
  steering.push(reading);
}

try { hintShown = sessionStorage.getItem("lazyvr.hint") === "1"; } catch { /* no storage */ }

/* A hidden tab needs no camera: light off, steering freezes on its own (no
 * readings → 'lost').  Back in view, reopen if this session still wants it.
 * The camera op counter, not a flag, decides whose open is current. */
document.addEventListener("visibilitychange", () => {
  if (!playerOpen) return;
  if (document.hidden) {
    if (trackingWanted && cameraState !== "off") {
      stopCamera();
      reopenOnShow = true;
    }
  } else if (reopenOnShow) {
    reopenOnShow = false;
    if (trackingWanted) startCamera(session);
  }
});

/* youtube's iframe is another document: a key pressed while it has focus
 * never reaches the shortcuts, and nothing shows where focus went.  So it is
 * kept out of the tab order (whenever youtube builds or rebuilds it), and a
 * click that does carry focus in (the skip-ad hole) has it taken back on the
 * next tick -- a synchronous blur() inside the window's blur event does not
 * move focus out of a cross-origin frame.  #player (tabindex -1) takes it:
 * focusing a chrome button instead would hold the chrome awake. */
const untabIframes = () => {
  for (const frame of el.embed.querySelectorAll("iframe")) {
    if (frame.getAttribute("tabindex") !== "-1") frame.setAttribute("tabindex", "-1");
  }
};
untabIframes();
new MutationObserver(untabIframes).observe(el.embed, { childList: true, subtree: true });

window.addEventListener("blur", () => {
  const active = document.activeElement;
  if (!(active && active.tagName === "IFRAME" && el.embed.contains(active))) return;
  setTimeout(() => {
    if (playerOpen && document.activeElement === active) el.player.focus({ preventScroll: true });
  }, 0);
});

/* ---------- the library ---------- */

const homeLatest = new Latest();
const searchLatest = new Latest();
let homeState = "idle";   // 'idle' | 'loading' | 'ok' | 'failed'

async function loadHome() {
  const run = homeLatest.start();
  homeState = "loading";
  el.loading.hidden = !el.results.hidden;
  el.empty.hidden = true;
  let data;
  try {
    data = await fetchHome({ signal: run.signal });
  } catch (error) {
    if (isAbort(error) || !run.current()) return;
    homeState = "failed";
    el.loading.hidden = true;
    el.empty.hidden = !el.results.hidden;
    el.emptytech.textContent = `The server said: ${error.message}. If you host this page, check that it is running and can reach the internet.`;
    return;
  }
  if (!run.current()) return;
  el.loading.hidden = true;
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const total = renderShelves(el.home, categories, onPick);
  homeState = total ? "ok" : "failed";
  el.empty.hidden = Boolean(total) || !el.results.hidden;
  const dead = categories.filter((c) => c.error);
  if (dead.length && total) {
    notify(`Some shelves came back empty (${dead.map((c) => c.title).join(", ")}): ${dead[0].error}`);
  }
  schedulePreload();
}

function onPick(next, card) {
  if (playerOpen) return;
  pick(next, card);
}

el.emptyretry.addEventListener("click", () => loadHome());

el.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = el.query.value.trim();
  if (!query) return;
  const run = searchLatest.start();
  el.query.blur();
  el.results.hidden = false;
  el.home.hidden = true;
  el.loading.hidden = true;
  el.empty.hidden = true;
  el.grid.textContent = "";
  el.resultline.textContent = `Searching youtube's 360 videos for “${query}”…`;
  let data;
  try {
    data = await fetchSearch(query, { signal: run.signal });
  } catch (error) {
    if (isAbort(error) || !run.current()) return;
    el.resultline.textContent = `Search failed: ${error.message}`;
    return;
  }
  if (!run.current()) return;
  const count = renderResults(el.grid, Array.isArray(data.clips) ? data.clips : [], onPick);
  el.resultline.textContent = count
    ? `${count} result${count === 1 ? "" : "s"} for “${query}”`
    : `Nothing in 360 for “${query}” — try broader words`;
  if (count) schedulePreload();
});

el.backhome.addEventListener("click", () => {
  searchLatest.abort();
  el.results.hidden = true;
  el.home.hidden = false;
  el.query.value = "";
  el.loading.hidden = homeState !== "loading";
  el.empty.hidden = homeState !== "failed";
  if (homeState === "idle") loadHome();
});

/* Once the library is up and the browser is idle: the face model and
 * youtube's script, so the first pick starts fast. */
let preloaded = false;
function schedulePreload() {
  if (preloaded) return;
  preloaded = true;
  const go = () => {
    tracker.load().catch((error) => console.warn("LazyVR: head tracking preload failed:", error.message));
    embed.preload();
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 2000 });
  else setTimeout(go, 1500);
}

/* ---------- a file off this device ---------- */

const PLAYABLE = /\.(mp4|m4v|webm|mkv|mov|ogv)$/i;

function playLocalFile(file) {
  if (!file) return;
  if (!(file.type || "").startsWith("video/") && !PLAYABLE.test(file.name)) {
    const message = `“${file.name}” does not look like a video file.`;
    if (playerOpen) toast(message); else notify(message);
    return;
  }
  if (!ensureRenderer()) return;
  // While playing, the file replaces the video in place (no new history entry).
  const card = playerOpen ? null : document.activeElement;
  const title = file.name.replace(/\.[a-z0-9]{2,4}$/i, "");
  pick({ id: null, title, local: true, src: URL.createObjectURL(file) }, card, playerOpen ? "replace" : "push");
}

el.local.addEventListener("click", () => el.localfile.click());
el.emptyfile.addEventListener("click", () => el.localfile.click());
el.localfile.addEventListener("change", () => {
  const file = el.localfile.files && el.localfile.files[0];
  el.localfile.value = "";   // so the same file twice still fires
  playLocalFile(file);
});

/* Drop anywhere, library or player.  The default for a dropped file is to
 * navigate the tab to it, which would end the app; never allow it. */
let dragDepth = 0;
const draggingFile = (event) => Array.from(event.dataTransfer ? event.dataTransfer.types : []).includes("Files");

function showDrop(on) {
  if (!on) dragDepth = 0;
  el.body.classList.toggle("dropping", on);
}

document.addEventListener("dragenter", (event) => {
  if (!draggingFile(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDrop(true);
});
document.addEventListener("dragover", (event) => {
  if (!draggingFile(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", () => {
  if (dragDepth && --dragDepth === 0) showDrop(false);
});
document.addEventListener("dragend", () => showDrop(false));
document.addEventListener("drop", (event) => {
  if (!draggingFile(event)) return;
  event.preventDefault();
  showDrop(false);
  playLocalFile(event.dataTransfer.files && event.dataTransfer.files[0]);
});

/* ---------- start ---------- */

el.gear.addEventListener("click", () => toggleSettings());

const deepLink = videoIdFrom(location.search);
if (deepLink) {
  // Straight to the player; the shelves load when the viewer comes back.
  history.replaceState({ lazyvr: "player", v: deepLink }, "", `?v=${deepLink}`);
  openReady(deepLink);
} else {
  if (location.search) history.replaceState(null, "", location.pathname);
  loadHome();
}

// For a console or a test harness.
window.lazyvr = {
  steering, tracker, embed, ui, panel,
  get renderer() { return renderer; },
  get settings() { return settings; },
  get reading() { return lastReading; },
  get state() { return { session, playerOpen, phase, engine, trackingWanted, cameraState, cameraBlocked, trackerStatus }; },
};
