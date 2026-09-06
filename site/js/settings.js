/* The settings store: what the viewer can adjust, saved on this device.
 *
 * Pure over the stored object, so the migration and the bounds can be
 * tested without a page.  app.js owns what the settings *do* (the control
 * law, the body, the renderer, the media elements); this file owns what
 * they *are*.
 */

import { DEADZONE_FLOOR, DEFAULTS as CONTROL } from "./control.js";

export const SETTINGS_KEY = "lazyvr.settings";
export const SETTINGS_VERSION = 3;

// Every deadzone this page has shipped as its own default -- 3.0 in version
// 1, 1.5 in version 2.  See the migration in normalize().
export const LEGACY_DEADZONES = [3.0, 1.5];

export const QUALITY_CHOICES = Object.freeze([1080, 1440, 2160, 4320]);

export const SETTINGS_DEFAULTS = Object.freeze({
  // Steering.
  sens: 1,                       // rate multiplier
  deadzone: CONTROL.deadzoneYaw, // degrees of gaze that command no motion
  free: false,                   // full 360 yaw: the neck switched off
  invx: false,
  invy: false,
  // Picture.
  fov: 75,                       // vertical field of view, degrees
  blur: true,                    // motion blur on fast turns
  quality: "auto",               // "auto" or a tier height
  // Sound.  Saved like a television remembers its volume.
  volume: 1,
  muted: false,
  // Camera: a deviceId, or "" for whichever camera faces the viewer.
  camera: "",
  // Interface.
  hints: true,                   // the key hints under the picture
  diagnostics: false,            // the readout and the gaze stick
  version: SETTINGS_VERSION,
});

// Number(null) and Number("") are both 0, which would read as a chosen
// value at the bottom of the slider; an absent value is the default.
const bound = (value, lo, hi, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/* A stored object, of any age, into a complete and sane settings object.
 *
 * The keys are *picked* off the defaults rather than spread over them, so a
 * setting this page no longer has is dropped on the way through instead of
 * being carried in the object, written back by the next save, and read
 * again for ever after.  That is what a version number is for; spreading
 * the stored blob would leave the raw engine's codec preference in storage
 * long after the engine that read it was deleted. */
export function normalize(stored) {
  const raw = stored && typeof stored === "object" ? stored : {};
  const settings = { ...SETTINGS_DEFAULTS };
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    if (key in raw) settings[key] = raw[key];
  }

  /* Sensitivity is a multiplier, so a stored 1 follows the default wherever
   * it goes.  The deadzone is not: it is an absolute number of degrees, so a
   * returning viewer would keep the old one for ever and never see the
   * change.
   *
   * A stored value that is exactly some past default was never chosen, only
   * persisted -- so it moves on.  Anything else the viewer picked on
   * purpose, and that stays.  The version is read off what was *stored*:
   * taking it from the merged object would let the current default answer
   * for a save that predates it, and no migration would ever run. */
  if (raw.version !== SETTINGS_VERSION) {
    if (LEGACY_DEADZONES.some((old) => Math.abs(Number(settings.deadzone) - old) < 1e-9)) {
      settings.deadzone = CONTROL.deadzoneYaw;
    }
  }
  settings.version = SETTINGS_VERSION;

  // Old or hand-edited storage must not be able to break the map.
  settings.sens = bound(settings.sens, 0.4, 2.5, 1);
  // Not below the floor: under about a degree and a half the band sits
  // inside the gaze estimate's own noise, and every scrap of bias in the
  // calibrated centre then reads as a slow standing turn.  The derived
  // pitch deadzone is held to the same floor in control.js -- a slider that
  // could go under it would simply move the drift onto yaw instead.
  settings.deadzone = bound(settings.deadzone, DEADZONE_FLOOR, 8, CONTROL.deadzoneYaw);
  settings.fov = bound(settings.fov, 60, 100, 75);
  settings.volume = bound(settings.volume, 0, 1, 1);
  settings.blur = settings.blur !== false;
  settings.hints = settings.hints !== false;
  settings.invx = settings.invx === true;
  settings.invy = settings.invy === true;
  settings.free = settings.free === true;
  settings.muted = settings.muted === true;
  settings.diagnostics = settings.diagnostics === true;
  settings.camera = typeof settings.camera === "string" ? settings.camera : "";
  settings.quality = QUALITY_CHOICES.includes(Number(settings.quality))
    ? Number(settings.quality) : "auto";
  return settings;
}

/* Read from storage; a private window, cleared storage, or garbage all
 * mean the defaults. */
export function readSettings(storage) {
  let stored = {};
  try {
    stored = JSON.parse(storage.getItem(SETTINGS_KEY) || "{}") || {};
  } catch { /* unreadable: start over */ }
  return normalize(stored);
}

export function writeSettings(settings, storage) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: SETTINGS_VERSION }));
  } catch { /* quota, or a storage that refuses; the session still has them */ }
}

/* ---------- the panel ----------
 *
 * Inputs carry data-setting="<key>"; readouts carry data-output="<key>".
 * The markup can be rearranged freely and nothing here needs to know. */

const FORMAT = {
  sens: (v) => `×${Number(v).toFixed(2)}`,
  deadzone: (v) => `${Number(v).toFixed(1)}°`,
  fov: (v) => `${Math.round(v)}°`,
  volume: (v) => `${Math.round(v * 100)}%`,
};

function fillFor(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 1;
  const value = Number(input.value);
  const fraction = max > min ? (value - min) / (max - min) : 0;
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`;
}

/* Push a settings object into the panel's inputs and readouts. */
export function renderSettingsPanel(root, settings) {
  for (const input of root.querySelectorAll("[data-setting]")) {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = Boolean(settings[key]);
    else input.value = String(settings[key]);
    if (input.type === "range") input.style.setProperty("--fill", fillFor(input));
  }
  for (const output of root.querySelectorAll("[data-output]")) {
    const key = output.dataset.output;
    const format = FORMAT[key];
    output.textContent = format ? format(settings[key]) : String(settings[key]);
  }
}

/* Read the panel back into a settings object, normalised. */
export function readSettingsPanel(root, settings) {
  const next = { ...settings };
  for (const input of root.querySelectorAll("[data-setting]")) {
    const key = input.dataset.setting;
    // A select whose options are not there yet (the camera list arrives
    // after a device round trip) has no answer; keep what was saved.
    if (input.tagName === "SELECT" && input.selectedIndex < 0) continue;
    if (input.type === "checkbox") next[key] = input.checked;
    else if (input.type === "range") next[key] = Number(input.value);
    else next[key] = input.value;
  }
  return normalize(next);
}

/* Call `onInput` whenever any setting input changes. */
export function bindSettingsPanel(root, onInput) {
  root.addEventListener("input", (event) => {
    if (event.target && event.target.matches("[data-setting]")) onInput(event.target.dataset.setting);
  });
}

/* The camera select: the default first, then whatever the device offers.
 * A saved id that is no longer present stays selectable so the viewer can
 * see what they had picked, marked as gone. */
export function fillCameraOptions(select, cameras, current) {
  while (select.options.length > 1) select.remove(1);
  let found = !current;
  for (const camera of cameras) {
    if (!camera.id) continue;
    const option = document.createElement("option");
    option.value = camera.id;
    option.textContent = camera.label;
    select.appendChild(option);
    if (camera.id === current) found = true;
  }
  if (!found) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = "Chosen camera (not connected)";
    select.appendChild(option);
  }
  select.value = current || "";
}
