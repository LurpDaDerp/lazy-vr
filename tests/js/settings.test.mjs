import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAMERA_POSITIONS, RESETTABLE, SETTINGS_DEFAULTS, SETTINGS_KEY, SETTINGS_VERSION, createSaver, fillFor,
  normalize, readSettings, resetSteeringAndPicture, screenOffsetCm, steeringOptions, writeSettings,
} from "../../site/js/settings.js";

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    writes: () => map,
  };
}

test("defaults: v4, steering at ×1, horizontal fov 100", () => {
  const s = normalize({});
  assert.deepEqual(s, { ...SETTINGS_DEFAULTS });
  assert.equal(SETTINGS_VERSION, 4);
  assert.equal(SETTINGS_KEY, "lazyvr.settings");
  assert.equal(s.fov, 100);
  assert.equal(s.sensitivity, 1);
  assert.equal(s.turnSpeed, 1);
  assert.equal(s.eyeAssist, true);
  assert.equal(s.cameraPosition, "above");
  assert.equal(s.diagnostics, false);
});

test("defaults: never the frozen object itself", () => {
  const s = normalize({});
  s.sensitivity = 2;
  assert.equal(SETTINGS_DEFAULTS.sensitivity, 1);
});

test("migration from v3: gaze keys dropped, fov reset, sound/camera/diagnostics carried", () => {
  const v3 = {
    version: 3, sens: 1.6, deadzone: 2.4, free: true, blur: false, hints: false, invx: true, invy: true,
    fov: 85, quality: 1440, volume: 0.4, muted: true, camera: "cam-123", diagnostics: true,
  };
  const s = normalize(v3);
  assert.deepEqual(Object.keys(s).sort(), Object.keys(SETTINGS_DEFAULTS).sort());
  for (const gone of ["sens", "deadzone", "free", "blur", "hints", "invx", "invy"]) assert.equal(gone in s, false, gone);
  assert.equal(s.fov, 100, "fov semantics changed (vertical → horizontal): reset");
  assert.equal(s.volume, 0.4);
  assert.equal(s.muted, true);
  assert.equal(s.camera, "cam-123");
  assert.equal(s.diagnostics, true);
  assert.equal(s.quality, 1440);
  // The old inversions were for gaze; head inversion starts off.
  assert.equal(s.invertYaw, false);
  assert.equal(s.invertPitch, false);
  assert.equal(s.version, 4);
});

test("migration: no version at all is legacy too", () => {
  assert.equal(normalize({ fov: 70 }).fov, 100);
});

test("v4 keeps its own fov, and a future version is not treated as legacy", () => {
  assert.equal(normalize({ version: 4, fov: 70 }).fov, 70);
  assert.equal(normalize({ version: 5, fov: 70 }).fov, 70);
});

test("bounds: garbage and out-of-range values cannot break steering", () => {
  const s = normalize({
    version: 4, sensitivity: 9, turnSpeed: -1, fov: 500, volume: 3, quality: 999,
    eyeAssist: "yes", invertYaw: 1, muted: "true", camera: 42, cameraPosition: "ceiling", diagnostics: null,
  });
  assert.equal(s.sensitivity, 2);
  assert.equal(s.turnSpeed, 0.5);
  assert.equal(s.fov, 120);
  assert.equal(s.volume, 1);
  assert.equal(s.quality, "auto");
  assert.equal(s.eyeAssist, true);
  assert.equal(s.invertYaw, false);
  assert.equal(s.muted, false);
  assert.equal(s.camera, "");
  assert.equal(s.cameraPosition, "above");
  assert.equal(s.diagnostics, false);
  assert.equal(normalize({ version: 4, fov: 10 }).fov, 60);
  assert.equal(normalize({ version: 4, sensitivity: "" }).sensitivity, 1);
  assert.equal(normalize({ version: 4, sensitivity: null }).sensitivity, 1);
  assert.equal(normalize({ version: 4, sensitivity: "1.5" }).sensitivity, 1.5);
  assert.equal(normalize({ version: 4, sensitivity: NaN }).sensitivity, 1);
  assert.equal(normalize({ version: 4, sensitivity: true }).sensitivity, 1);
  assert.equal(normalize({ version: 4, quality: "2160" }).quality, 2160);
  assert.equal(normalize({ version: 4, volume: 0 }).volume, 0);
});

test("not an object: defaults", () => {
  for (const junk of [null, undefined, "x", 42, [1, 2]]) assert.deepEqual(normalize(junk), { ...SETTINGS_DEFAULTS });
});

test("read/write round trip; unreadable storage means defaults", () => {
  const storage = memoryStorage();
  const s = { ...normalize({}), sensitivity: 1.25, volume: 0.3 };
  assert.equal(writeSettings(s, storage), true);
  const stored = JSON.parse(storage.getItem(SETTINGS_KEY));
  assert.equal(stored.version, 4);
  assert.deepEqual(readSettings(storage), s);
  assert.deepEqual(readSettings(memoryStorage({ [SETTINGS_KEY]: "{not json" })), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(readSettings(null), { ...SETTINGS_DEFAULTS });
  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  assert.equal(writeSettings(s, refusing), false);
  assert.equal(writeSettings(s, null), false);
});

test("reset: steering and picture only; volume, mute, camera and interface stay", () => {
  const custom = normalize({
    version: 4, sensitivity: 1.7, turnSpeed: 0.6, eyeAssist: false, invertYaw: true, invertPitch: true,
    fov: 70, quality: 1080, volume: 0.25, muted: true, camera: "cam-9", cameraPosition: "below", diagnostics: true,
  });
  const reset = resetSteeringAndPicture(custom);
  for (const key of RESETTABLE) assert.equal(reset[key], SETTINGS_DEFAULTS[key], key);
  assert.equal(reset.volume, 0.25);
  assert.equal(reset.muted, true);
  assert.equal(reset.camera, "cam-9");
  assert.equal(reset.cameraPosition, "below");
  assert.equal(reset.diagnostics, true);
  assert.notEqual(reset, custom);
  assert.equal(custom.sensitivity, 1.7, "input not mutated");
});

test("steeringOptions and screenOffsetCm", () => {
  const s = normalize({ version: 4, sensitivity: 1.5, invertPitch: true, cameraPosition: "below" });
  assert.deepEqual(steeringOptions(s), { sensitivity: 1.5, turnSpeed: 1, eyeAssist: true, invertYaw: false, invertPitch: true });
  assert.equal(screenOffsetCm(s), -10);
  assert.equal(screenOffsetCm({ cameraPosition: "above" }), 12);
  assert.equal(screenOffsetCm({ cameraPosition: "beside" }), 0);
  assert.equal(screenOffsetCm({}), 12);
  assert.equal(screenOffsetCm(null), 12);
  assert.deepEqual({ ...CAMERA_POSITIONS }, { above: 12, below: -10, beside: 0 });
});

test("createSaver: debounced, last write wins, flush writes now", () => {
  const storage = memoryStorage();
  const timers = new Map();
  let nextId = 1;
  const saver = createSaver(storage, {
    delay: 300,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  saver.save({ ...normalize({}), sensitivity: 1.1 });
  saver.save({ ...normalize({}), sensitivity: 1.2 });
  assert.equal(timers.size, 1, "one pending timer");
  assert.equal(storage.getItem(SETTINGS_KEY), null, "nothing written yet");
  assert.equal(saver.pending, true);
  const [[, { fn, ms }]] = timers;
  assert.equal(ms, 300);
  fn();
  assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).sensitivity, 1.2);
  assert.equal(saver.pending, false);

  saver.save({ ...normalize({}), sensitivity: 1.3 });
  saver.flush();
  assert.equal(JSON.parse(storage.getItem(SETTINGS_KEY)).sensitivity, 1.3);
  assert.equal(timers.size, 0);
  saver.flush();   // nothing pending: harmless
});

test("fillFor: slider fill percentage, guarded", () => {
  assert.equal(fillFor(1, 0.5, 2), "33.3%");
  assert.equal(fillFor(100, 60, 120), "66.7%");
  assert.equal(fillFor(500, 60, 120), "100.0%");
  assert.equal(fillFor("x", 0, 1), "0.0%");
  assert.equal(fillFor(1, 1, 1), "0.0%");
});
