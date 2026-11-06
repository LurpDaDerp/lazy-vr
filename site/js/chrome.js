/* Pure helpers for the player screen: clocks, the auto-hide rule, the
 * tracking button's state, seek and drag math, the keyboard map.  No DOM,
 * no timers: player.js and app.js own the side effects, and this file is
 * what tests/js/chrome.test.mjs pins. */

export const CHROME_IDLE_MS = 2500;      // chrome hides after this long without the pointer
export const CLICK_DELAY_MS = 220;       // a click waits this long for a possible double click
export const DRAG_THRESHOLD_PX = 6;      // movement that turns a press into a drag
export const SEEK_STEP = 5;              // ←/→ and the seek slider's arrows
export const SEEK_JUMP = 10;             // J/L and PageUp/PageDown on the seek slider
export const VOLUME_STEP = 0.05;         // ↑/↓
export const FACE_LOST_AFTER_MS = 1000;  // 'lost' must last this long before the mark shows
export const AWAY_AFTER_MS = 600;        // likewise 'away'

/* Where youtube draws "Skip ad", as fractions of the player: the right 24%
 * of the width, between 9% and 26% up from the bottom. */
export const AD_HOLE = Object.freeze({ left: 0.76, bottom: 0.09, top: 0.26 });

/* "1:05", "1:01:01"; null for anything that is not a finite number (both
 * engines report NaN or undefined for a duration they do not know yet). */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const whole = Math.max(0, Math.floor(seconds));
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts.map((part, index) => (index ? String(part).padStart(2, "0") : String(part))).join(":");
}

/* The bottom bar's clock: "3:12 / 9:40", with a placeholder until the
 * duration is known.  The elapsed side is floored like the duration side,
 * so the two never disagree at the very end (9:40 / 9:39). */
export function clockText(current, duration) {
  const total = Number.isFinite(duration) && duration > 0 ? duration : NaN;
  const now = Number.isFinite(total) ? Math.min(Math.max(0, current || 0), total) : Math.max(0, current || 0);
  return `${formatClock(Number.isFinite(now) ? now : 0)} / ${formatClock(total) ?? "–:––"}`;
}

/* 0..1 for a track; 0 for anything unusable.  The answer reaches the DOM as
 * a percentage and the CSSOM silently drops "NaN%", which would leave the
 * previous clip's width standing. */
export function trackFraction(value, span) {
  if (!Number.isFinite(value) || !Number.isFinite(span) || span <= 0) return 0;
  return Math.min(1, Math.max(0, value / span));
}

/* "2160p" from a frame height; null when unknown. */
export function qualityLabel(height) {
  if (!Number.isFinite(height) || height <= 0) return null;
  return `${Math.round(height)}p`;
}

/* Whether the playback chrome is up.  Every exemption is a moment the chrome
 * is being used rather than being in the way.  The window losing focus is
 * deliberately not one: chrome that never hides on a second monitor is the
 * bug this replaced. */
export function chromeAwake({
  paused = false, ended = false, settingsOpen = false, overControl = false,
  panelUp = false, keyboardFocus = false, sincePointerMs = Infinity,
} = {}) {
  if (paused || ended || settingsOpen || overControl || panelUp || keyboardFocus) return true;
  return sincePointerMs < CHROME_IDLE_MS;
}

/* The tracking button.  `state` is Steering.state ('acquiring' | 'tracking'
 * | 'turning' | 'away' | 'lost' | 'off') or one of the app's own words:
 * 'starting' (the camera is opening) and 'unavailable' (no camera, or it
 * was refused).  tone: 'on' | 'busy' | 'warn' | 'off'. */
const TRACKING = {
  tracking: { label: "Tracking", tone: "on", pressed: true, tip: "Head tracking on" },
  turning: { label: "Tracking", tone: "on", pressed: true, tip: "Head tracking on" },
  away: { label: "Tracking", tone: "on", pressed: true, tip: "Looking away — view held" },
  acquiring: { label: "Finding you", tone: "busy", pressed: true, tip: "Head tracking is finding your face" },
  starting: { label: "Starting", tone: "busy", pressed: true, tip: "Opening the camera" },
  lost: { label: "Face lost", tone: "warn", pressed: true, tip: "No face in view — the view is held" },
  off: { label: "Tracking off", tone: "off", pressed: false, tip: "Head tracking off — drag to look around" },
  unavailable: { label: "No camera", tone: "off", pressed: false, tip: "Camera unavailable — drag to look around" },
};

export function trackingStatus(state) {
  return { ...(TRACKING[state] || TRACKING.off) };
}

/* The peripheral marks, from how long the steering has been in its state.
 * A face lost for a blink or a glance away for a moment marks nothing. */
export function periphMarks({ state, sinceStateMs = 0, buffering = false } = {}) {
  const held = Number.isFinite(sinceStateMs) ? sinceStateMs : 0;
  return {
    acquiring: state === "acquiring" || state === "starting",
    faceLost: state === "lost" && held > FACE_LOST_AFTER_MS,
    away: state === "away" && held > AWAY_AFTER_MS,
    buffering: Boolean(buffering),
  };
}

/* Pointer x over a track of [left, left + width) → 0..1. */
export function seekFraction(clientX, left, width) {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/* A fraction of the clip → seconds; 0 when the duration is unknown. */
export function timeAtFraction(fraction, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction)) * duration;
}

/* The seek slider's keys (WAI-ARIA slider pattern) → the new time, or null
 * for a key the slider does not own.  Unknown duration: nothing to move. */
export function seekKey(key, current, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const now = Number.isFinite(current) ? current : 0;
  const to = {
    ArrowLeft: now - SEEK_STEP, ArrowDown: now - SEEK_STEP,
    ArrowRight: now + SEEK_STEP, ArrowUp: now + SEEK_STEP,
    PageDown: now - SEEK_JUMP, PageUp: now + SEEK_JUMP,
    Home: 0, End: duration,
  }[key];
  return to === undefined ? null : Math.min(duration, Math.max(0, to));
}

/* Volume by a step, kept on the 5% grid so repeated steps land on round
 * numbers whatever the starting point. */
export function stepVolume(volume, delta) {
  const base = Number.isFinite(volume) ? volume : 1;
  const next = Math.round((base + (Number.isFinite(delta) ? delta : 0)) * 20) / 20;
  return Math.min(1, Math.max(0, next));
}

/* A pointer drag → view-space degrees.  Grab-the-world, as youtube does it:
 * dragging right pulls the picture right, which turns the view left
 * (view.yaw > 0 is left); dragging down turns it up.  One horizontal pixel
 * is hFov / viewport width degrees, and the same scale serves pitch. */
export function dragToView(dxPx, dyPx, hFovDeg, viewportWidth) {
  if (!(viewportWidth > 0) || !(hFovDeg > 0)) return { yaw: 0, pitch: 0 };
  const perPx = hFovDeg / viewportWidth;
  const yaw = Number.isFinite(dxPx) ? dxPx * perPx : 0;
  const pitch = Number.isFinite(dyPx) ? dyPx * perPx : 0;
  return { yaw, pitch };
}

/* Whether a point sits in youtube's skip-ad hole, in the surface's own
 * pixels.  CSS draws the hole (player.css); this is the same rectangle for
 * code that needs to ask. */
export function inAdHole(x, y, width, height) {
  if (!(width > 0) || !(height > 0)) return false;
  const fromBottom = (height - y) / height;
  return x / width >= AD_HOLE.left && fromBottom >= AD_HOLE.bottom && fromBottom <= AD_HOLE.top;
}

/* ?v=<id> (or the old ?video=<id>) → a youtube id, or null. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const isVideoId = (id) => typeof id === "string" && VIDEO_ID.test(id);

export function videoIdFrom(search) {
  let params;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return null;
  }
  for (const name of ["v", "video"]) {
    const id = params.get(name);
    if (isVideoId(id)) return id;
  }
  return null;
}

/* ---------- the keyboard map ---------- */

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
const ACTIVATING = new Set(["BUTTON", "A", "SUMMARY"]);

const KEYMAP = {
  " ": "playpause", k: "playpause",
  ArrowLeft: "back5", ArrowRight: "fwd5",
  j: "back10", l: "fwd10",
  ArrowUp: "volup", ArrowDown: "voldown",
  m: "mute", f: "fullscreen", c: "recenter", t: "tracking",
  ",": "settings", "?": "help",
};

/* The shortcuts popover lists exactly these. */
export const SHORTCUTS = Object.freeze([
  ["Space / K", "Play or pause"],
  ["← / →", "Back or forward 5 seconds"],
  ["J / L", "Back or forward 10 seconds"],
  ["↑ / ↓", "Volume"],
  ["M", "Mute"],
  ["F", "Fullscreen"],
  ["C", "Recenter the view"],
  ["T", "Head tracking on or off"],
  [",", "Settings"],
  ["Esc", "Close settings, or back to the library"],
  ["?", "These shortcuts"],
]);

/* One keydown → an action name, or null to leave the event alone.
 *
 * `event` is { key, ctrlKey, metaKey, altKey, repeat, target } where target
 * is { tag, type, role, editable, inSettings } (plain data, so this stays
 * testable).  `ctx` is { library, settingsOpen, helpOpen, fullscreen, modal }:
 * `fullscreen` should also be true for a moment after leaving fullscreen,
 * because the Esc that left it must not also leave the player. */
export function keyAction(event, ctx = {}) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = typeof event.key === "string" && event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const target = event.target || {};

  if (key === "Escape") {
    if (event.repeat) return null;
    if (ctx.settingsOpen) return "close-settings";
    if (ctx.helpOpen) return "close-help";
    if (ctx.library || ctx.fullscreen) return null;
    return "back";
  }
  // While the library shows, the page has no shortcuts beyond Esc above.
  if (ctx.library) return null;
  if (target.inSettings) return null;   // the panel's controls own their keys
  const tag = target.tag || "";
  if (tag === "TEXTAREA" || tag === "SELECT" || target.editable) return null;
  if (tag === "INPUT" && TEXT_TYPES.has(target.type || "text")) return null;
  // A slider keeps its own navigation keys and passes the rest on, so Space
  // still plays after the volume slider has been touched.
  if ((tag === "INPUT" && target.type === "range") || target.role === "slider") {
    if (NAV_KEYS.has(key)) return null;
  }
  // A focused button activates itself on Space/Enter; acting here as well
  // would toggle twice.
  if ((key === " " || key === "Enter") &&
      (ACTIVATING.has(tag) || target.role === "button" || (tag === "INPUT" && target.type === "checkbox"))) {
    return null;
  }
  if (event.repeat && !ARROWS.has(key)) return null;
  if (ctx.modal) return null;
  return KEYMAP[key] || null;
}

/* ---------- diagnostics ---------- */

const signed = (v, digits = 1) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(digits)}` : "–");
const pair = (a, b, unit = "°") => `${signed(a)}, ${signed(b)}${unit}`;
const RAD = 180 / Math.PI;

/* The readout's rows: [key, value, tone].  `steer` is Steering.diagnostics(),
 * `view` the view in radians, `tracker` { rate, latencyMs, mode }, `quality`
 * { label, k }, `fps` the display rate. */
export function diagnosticsRows({ steer = null, view = null, tracker = null, quality = null, fps = NaN } = {}) {
  const state = steer && steer.state ? steer.state : "–";
  const stateTone = state === "lost" ? "bad" : state === "away" || state === "acquiring" ? "warn" : "";
  const rows = [["state", state, stateTone]];
  rows.push(["head", steer && steer.head ? pair(steer.head.yaw, steer.head.pitch) : "–", ""]);
  rows.push(["eye", steer && steer.eye ? pair(steer.eye.x, steer.eye.y) : "–", ""]);
  rows.push(["view", view ? pair(view.yaw * RAD, view.pitch * RAD) : "–", ""]);
  if (tracker) {
    const rate = Number.isFinite(tracker.rate) ? `${Math.round(tracker.rate)} Hz` : "– Hz";
    const latency = Number.isFinite(tracker.latencyMs) ? ` · ${Math.round(tracker.latencyMs)} ms` : "";
    const mode = tracker.mode ? ` · ${tracker.mode}` : "";
    const tone = Number.isFinite(tracker.rate) && tracker.rate > 0 && tracker.rate < 15 ? "warn" : "";
    rows.push(["tracker", `${rate}${latency}${mode}`, tone]);
  } else {
    rows.push(["tracker", "off", ""]);
  }
  const k = quality && Number.isFinite(quality.k) ? ` · k ${quality.k.toFixed(2)}` : "";
  rows.push(["quality", `${(quality && quality.label) || "–"}${k}`, ""]);
  rows.push(["fps", Number.isFinite(fps) ? String(Math.round(fps)) : "–", Number.isFinite(fps) && fps < 40 ? "warn" : ""]);
  return rows;
}
