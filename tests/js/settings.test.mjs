/* The settings store: defaults, the deadzone migration, and the bounds that
 * keep hand-edited storage from breaking the map. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEADZONE_FLOOR, DEFAULTS as CONTROL } from "../../site/js/control.js";
import {
  SETTINGS_DEFAULTS, SETTINGS_VERSION, normalize, readSettings, writeSettings,
} from "../../site/js/settings.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    dump: () => Object.fromEntries(map),
  };
}

test("defaults: nothing stored means the shipped defaults, current version", () => {
  const settings = normalize({});
  assert.deepEqual(settings, { ...SETTINGS_DEFAULTS });
  assert.equal(settings.version, SETTINGS_VERSION);
  assert.equal(settings.deadzone, CONTROL.deadzoneYaw);
});

test("defaults: normalize never hands back the frozen defaults object", () => {
  const settings = normalize({});
  settings.sens = 2;
  assert.equal(SETTINGS_DEFAULTS.sens, 1);
});

test("migration: a setting this page no longer has is dropped, not carried", () => {
  // The raw-stream engine is gone, and so are its keys.  Spreading the
  // stored blob over the defaults would keep them in the object, write them
  // back on the next save, and read them again for ever after.
  const settings = normalize({ version: 2, engine: "stream", codecs: "vp9,av01", maxfps: 60 });
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(SETTINGS_DEFAULTS).sort());
  assert.equal("engine" in settings, false);
  assert.equal("codecs" in settings, false);
  // And what a stored blob does still name is kept.
  assert.equal(normalize({ version: 2, engine: "stream", sens: 1.6 }).sens, 1.6);
});

test("migration: a stored array or a stored string is not a settings object", () => {
  assert.deepEqual(normalize([1, 2, 3]), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(normalize("nonsense"), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(normalize(null), { ...SETTINGS_DEFAULTS });
});

test("migration: a deadzone that was only ever a past default moves on", () => {
  assert.equal(normalize({ version: 1, deadzone: 3.0 }).deadzone, CONTROL.deadzoneYaw);
  assert.equal(normalize({ version: 2, deadzone: 1.5 }).deadzone, CONTROL.deadzoneYaw);
  assert.equal(normalize({ deadzone: 1.5 }).deadzone, CONTROL.deadzoneYaw);
});

test("migration: a deadzone the viewer chose survives the version bump", () => {
  const settings = normalize({ version: 2, deadzone: 2.4 });
  assert.equal(settings.deadzone, 2.4);
  assert.equal(settings.version, SETTINGS_VERSION);
});

test("migration: a current-version save is never migrated, even at an old default", () => {
  assert.equal(normalize({ version: SETTINGS_VERSION, deadzone: 1.5 }).deadzone, 1.5);
});

test("bounds: numbers are clamped to their sliders, garbage falls back", () => {
  const settings = normalize({ sens: 9, deadzone: 0, fov: 200 });
  assert.equal(settings.sens, 2.5);
  // Not 0, and not 1 either: below the noise floor a deadzone stops being a
  // deadzone, and the bias in the calibrated centre walks the view.
  assert.equal(settings.deadzone, DEADZONE_FLOOR);
  assert.equal(settings.fov, 100);
  const junk = normalize({ sens: "abc", deadzone: null, fov: undefined, version: SETTINGS_VERSION });
  assert.equal(junk.sens, 1);
  assert.equal(junk.deadzone, CONTROL.deadzoneYaw);
  assert.equal(junk.fov, 75);
});

test("bounds: quality is one of the offered tiers or auto", () => {
  assert.equal(normalize({ quality: "1440" }).quality, 1440);
  assert.equal(normalize({ quality: 2160 }).quality, 2160);
  assert.equal(normalize({ quality: "999" }).quality, "auto");
  assert.equal(normalize({ quality: "auto" }).quality, "auto");
});

test("bounds: booleans are strict, and blur defaults on", () => {
  const settings = normalize({ blur: undefined, invx: "yes", invy: 1, free: true });
  assert.equal(settings.blur, true);
  assert.equal(settings.invx, false);
  assert.equal(settings.invy, false);
  assert.equal(settings.free, true);
  assert.equal(normalize({ blur: false }).blur, false);
});

test("new keys: camera id, diagnostics, key hints, volume and mute", () => {
  const settings = normalize({});
  assert.equal(settings.camera, "");
  assert.equal(settings.diagnostics, false);
  assert.equal(settings.hints, true);
  assert.equal(settings.volume, 1);
  assert.equal(settings.muted, false);
  const chosen = normalize({ camera: "abc123", diagnostics: true, hints: false, volume: 0.4, muted: true });
  assert.equal(chosen.camera, "abc123");
  assert.equal(chosen.diagnostics, true);
  assert.equal(chosen.hints, false);
  assert.equal(chosen.volume, 0.4);
  assert.equal(chosen.muted, true);
  const junk = normalize({ camera: 42, volume: 3, muted: "no" });
  assert.equal(junk.camera, "");
  assert.equal(junk.volume, 1);
  assert.equal(junk.muted, false);
  assert.equal(normalize({ volume: -1 }).volume, 0);
});

test("storage: unreadable or missing storage yields defaults", () => {
  assert.deepEqual(readSettings(memoryStorage()), { ...SETTINGS_DEFAULTS });
  const broken = { getItem: () => { throw new Error("private window"); } };
  assert.deepEqual(readSettings(broken), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(readSettings(memoryStorage({ "lazyvr.settings": "{not json" })), { ...SETTINGS_DEFAULTS });
});

test("storage: a round trip keeps what was chosen and stamps the version", () => {
  const storage = memoryStorage();
  writeSettings({ ...SETTINGS_DEFAULTS, sens: 1.6, quality: 1080, hints: false }, storage);
  const back = readSettings(storage);
  assert.equal(back.sens, 1.6);
  assert.equal(back.quality, 1080);
  assert.equal(back.hints, false);
  assert.equal(back.version, SETTINGS_VERSION);
  const failing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.doesNotThrow(() => writeSettings({ ...SETTINGS_DEFAULTS }, failing));
});
