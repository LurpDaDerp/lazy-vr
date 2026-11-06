/* Settings v4: the model (pure, tested), the debounced saver, and the
 * panel binding.  Nothing touches the DOM at import time, so node can test
 * the model.  app.js decides what the settings do. */

export const SETTINGS_KEY = "lazyvr.settings";
export const SETTINGS_VERSION = 4;

export const QUALITY_CHOICES = Object.freeze([1080, 1440, 2160, 4320]);

/* Where the camera sits relative to the screen centre, in cm (pose.js
 * screenOffsetCm: positive = above). */
export const CAMERA_POSITIONS = Object.freeze({ above: 12, below: -10, beside: 0 });

export const SETTINGS_DEFAULTS = Object.freeze({
  // Steering (names match STEER_DEFAULTS, so they pass straight through).
  sensitivity: 1,
  turnSpeed: 1,
  eyeAssist: true,
  invertYaw: false,
  invertPitch: false,
  // Picture.
  fov: 100,                 // horizontal field of view, degrees
  quality: "auto",          // "auto" or a tier height from QUALITY_CHOICES
  // Sound, set from the control bar.
  volume: 1,
  muted: false,
  // Camera.
  camera: "",               // a deviceId, or "" for the default camera
  cameraPosition: "above",  // a key of CAMERA_POSITIONS
  // Interface.
  diagnostics: false,
  version: SETTINGS_VERSION,
});

/* What "Reset steering & picture" puts back; sound, camera and the
 * interface are left alone. */
export const RESETTABLE = Object.freeze(["sensitivity", "turnSpeed", "eyeAssist", "invertYaw", "invertPitch", "fov", "quality"]);

// An absent value (null, "", undefined) is the default, not Number()'s 0.
const bound = (value, lo, hi, fallback) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/* Any stored object → a complete, sane v4 settings object.  Keys are picked
 * off the defaults, so v3's sens/deadzone/free/blur/hints/invx/invy are
 * dropped on the way through.  Coming from before v4, fov is reset: it was
 * a vertical angle then and is horizontal now. */
export function normalize(stored) {
  const raw = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = { ...SETTINGS_DEFAULTS };
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
  }
  const legacy = !(Number(raw.version) >= SETTINGS_VERSION);
  if (legacy) out.fov = SETTINGS_DEFAULTS.fov;

  const D = SETTINGS_DEFAULTS;
  out.sensitivity = bound(out.sensitivity, 0.5, 2, D.sensitivity);
  out.turnSpeed = bound(out.turnSpeed, 0.5, 2, D.turnSpeed);
  out.eyeAssist = flag(out.eyeAssist, D.eyeAssist);
  out.invertYaw = flag(out.invertYaw, D.invertYaw);
  out.invertPitch = flag(out.invertPitch, D.invertPitch);
  out.fov = bound(out.fov, 60, 120, D.fov);
  out.quality = QUALITY_CHOICES.includes(Number(out.quality)) ? Number(out.quality) : "auto";
  out.volume = bound(out.volume, 0, 1, D.volume);
  out.muted = flag(out.muted, D.muted);
  out.camera = typeof out.camera === "string" ? out.camera : "";
  out.cameraPosition = Object.prototype.hasOwnProperty.call(CAMERA_POSITIONS, out.cameraPosition)
    ? out.cameraPosition : D.cameraPosition;
  out.diagnostics = flag(out.diagnostics, D.diagnostics);
  out.version = SETTINGS_VERSION;
  return out;
}

export function readSettings(storage) {
  let stored = {};
  try {
    stored = JSON.parse(storage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch { /* unreadable, or no storage: defaults */ }
  return normalize(stored);
}

export function writeSettings(settings, storage) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...normalize(settings), version: SETTINGS_VERSION }));
    return true;
  } catch {
    return false;   // quota or a refusing storage; the session keeps them
  }
}

/* Steering and picture back to defaults; everything else kept. */
export function resetSteeringAndPicture(settings) {
  const next = { ...normalize(settings) };
  for (const key of RESETTABLE) next[key] = SETTINGS_DEFAULTS[key];
  return next;
}

/* The part of the settings Steering.configure takes. */
export function steeringOptions(settings) {
  return {
    sensitivity: settings.sensitivity,
    turnSpeed: settings.turnSpeed,
    eyeAssist: settings.eyeAssist,
    invertYaw: settings.invertYaw,
    invertPitch: settings.invertPitch,
  };
}

export function screenOffsetCm(settings) {
  return CAMERA_POSITIONS[settings && settings.cameraPosition] ?? CAMERA_POSITIONS.above;
}

/* Saves at most once per `delay` ms of quiet; flush() writes now (call it on
 * pagehide).  Timers are injectable for tests. */
export function createSaver(storage, { delay = 300, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null;
  let timer = null;
  const flush = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (pending) {
      const settings = pending;
      pending = null;
      writeSettings(settings, storage);
    }
  };
  return {
    save(settings) {
      pending = settings;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, delay);
    },
    flush,
    get pending() { return pending !== null; },
  };
}

/* ---------- the panel ----------
 * Inputs carry data-setting="<key>", readouts data-output="<key>". */

export const FORMAT = {
  sensitivity: (v) => `×${Number(v).toFixed(2)}`,
  turnSpeed: (v) => `×${Number(v).toFixed(2)}`,
  fov: (v) => `${Math.round(v)}°`,
};

export function fillFor(value, min, max) {
  const lo = Number(min);
  const hi = Number(max);
  const v = Number(value);
  const fraction = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && Number.isFinite(v) ? (v - lo) / (hi - lo) : 0;
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`;
}

function writeInput(input, settings) {
  const key = input.dataset.setting;
  if (input.type === "checkbox") input.checked = Boolean(settings[key]);
  else input.value = String(settings[key]);
  if (input.type === "range") input.style.setProperty("--fill", fillFor(input.value, input.min, input.max));
}

function writeOutput(output, settings) {
  const key = output.dataset.output;
  const format = FORMAT[key];
  output.textContent = format ? format(settings[key]) : String(settings[key]);
}

/* Everything, e.g. on open or after a reset. */
export function renderSettingsPanel(root, settings) {
  for (const input of root.querySelectorAll("[data-setting]")) writeInput(input, settings);
  for (const output of root.querySelectorAll("[data-output]")) writeOutput(output, settings);
}

/* Only the one setting that moved: its slider fill and its readout. */
export function renderSetting(root, key, settings) {
  for (const input of root.querySelectorAll(`[data-setting="${key}"]`)) {
    if (input.type === "range") input.style.setProperty("--fill", fillFor(input.value, input.min, input.max));
  }
  for (const output of root.querySelectorAll(`[data-output="${key}"]`)) writeOutput(output, settings);
}

/* One input's value into a copy of the settings, normalised. */
export function readSetting(input, settings) {
  const key = input.dataset.setting;
  const next = { ...settings };
  // A select whose options have not arrived yet has no answer.
  if (input.tagName === "SELECT" && input.selectedIndex < 0) return next;
  if (input.type === "checkbox") next[key] = input.checked;
  else if (input.type === "range") next[key] = Number(input.value);
  else next[key] = input.value;
  return normalize({ ...next, version: SETTINGS_VERSION });
}

/* The camera select: the default first, then the devices; a saved device
 * that is not connected stays listed, marked as gone. */
export function fillCameraOptions(select, cameras, current) {
  while (select.options.length > 1) select.remove(1);
  let found = !current;
  for (const camera of cameras || []) {
    const id = camera.deviceId || camera.id;
    if (!id) continue;
    const option = select.ownerDocument.createElement("option");
    option.value = id;
    option.textContent = camera.label || "Camera";
    select.appendChild(option);
    if (id === current) found = true;
  }
  if (!found) {
    const option = select.ownerDocument.createElement("option");
    option.value = current;
    option.textContent = "Chosen camera (not connected)";
    select.appendChild(option);
  }
  select.value = current || "";
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/* The panel as a non-modal dialog: focus moves in on open and back on close;
 * Esc (via the app's key handler) and a press outside close it.
 *
 * options: { getSettings(), onChange(key, next), onReset(), onOpen(), onClose(),
 *            toggles: [elements that open/close it, ignored by click-outside] } */
export class SettingsPanel {
  constructor(root, options) {
    this.root = root;
    this.options = options;
    this.returnFocus = null;
    this.qualityLine = root.querySelector("[data-quality-line]");
    this.cameraSelect = root.querySelector("select[data-setting='camera']");

    root.addEventListener("input", (event) => {
      const input = event.target;
      if (!input || !input.matches("[data-setting]")) return;
      // Selects and checkboxes report through 'change' as well; 'input' is
      // enough for all three in current engines.
      const key = input.dataset.setting;
      const next = readSetting(input, options.getSettings());
      renderSetting(root, key, next);
      options.onChange(key, next);
    });
    const reset = root.querySelector("[data-action='reset']");
    if (reset) reset.addEventListener("click", () => options.onReset());
    const close = root.querySelector("[data-action='close']");
    if (close) close.addEventListener("click", () => this.close());

    // Capture, so a press on the picture that closes the panel does not
    // also reach the player's surface and toggle playback.
    root.ownerDocument.addEventListener("pointerdown", (event) => {
      if (!this.isOpen || root.contains(event.target)) return;
      if ((options.toggles || []).some((el) => el && el.contains(event.target))) return;
      this.close({ restoreFocus: false });
      if (event.target.closest && event.target.closest("#surface")) event.stopPropagation();
    }, true);
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open() {
    if (this.isOpen) return;
    const doc = this.root.ownerDocument;
    this.returnFocus = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    renderSettingsPanel(this.root, this.options.getSettings());
    this.root.hidden = false;
    const first = this.root.querySelector(FOCUSABLE);
    if (first) first.focus({ preventScroll: true });
    if (this.options.onOpen) this.options.onOpen();
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    const hadFocus = this.root.contains(this.root.ownerDocument.activeElement);
    this.root.hidden = true;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && hadFocus && back && back.isConnected && back.offsetParent !== null) {
      back.focus({ preventScroll: true });
    } else if (hadFocus) {
      this.root.ownerDocument.activeElement.blur?.();
    }
    if (this.options.onClose) this.options.onClose();
  }

  toggle() {
    if (this.isOpen) this.close(); else this.open();
  }

  render() {
    renderSettingsPanel(this.root, this.options.getSettings());
  }

  /* "Playing at 2160p", or nothing when unknown. */
  setQualityLine(text) {
    if (!this.qualityLine) return;
    this.qualityLine.textContent = text || "";
    this.qualityLine.hidden = !text;
  }

  fillCameras(cameras, current) {
    if (this.cameraSelect) fillCameraOptions(this.cameraSelect, cameras, current);
  }
}
