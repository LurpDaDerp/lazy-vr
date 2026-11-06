import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AD_HOLE, CHROME_IDLE_MS, PERMANENT_REFUSALS, SHORTCUTS, chromeAwake, clockText, diagnosticsRows, dragToView,
  formatClock, inAdHole, isVideoId, keyAction, periphMarks, qualityLabel, retryableRefusal, seekFraction, seekKey,
  stepVolume, timeAtFraction, trackFraction, trackerGaveUp, trackingStatus, transportSnapshot, videoIdFrom,
  volumeStep,
} from "../../site/js/chrome.js";

test("formatClock: minutes, hours, and nothing for unknowns", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(65), "1:05");
  assert.equal(formatClock(59.9), "0:59");
  assert.equal(formatClock(3661), "1:01:01");
  assert.equal(formatClock(-3), "0:00");
  assert.equal(formatClock(NaN), null);
  assert.equal(formatClock(undefined), null);
  assert.equal(formatClock(Infinity), null);
});

test("clockText: placeholder until the duration is known, never past the end", () => {
  assert.equal(clockText(0, NaN), "0:00 / –:––");
  assert.equal(clockText(undefined, undefined), "0:00 / –:––");
  assert.equal(clockText(192, 580), "3:12 / 9:40");
  assert.equal(clockText(600, 580), "9:40 / 9:40");
  assert.equal(clockText(NaN, 580), "0:00 / 9:40");
  assert.equal(clockText(12, 0), "0:12 / –:––");
});

test("trackFraction: guarded against NaN, zero and negative spans", () => {
  assert.equal(trackFraction(5, 10), 0.5);
  assert.equal(trackFraction(15, 10), 1);
  assert.equal(trackFraction(-1, 10), 0);
  assert.equal(trackFraction(undefined, 10), 0);
  assert.equal(trackFraction(5, 0), 0);
  assert.equal(trackFraction(5, NaN), 0);
});

test("qualityLabel", () => {
  assert.equal(qualityLabel(2160), "2160p");
  assert.equal(qualityLabel(0), null);
  assert.equal(qualityLabel(null), null);
});

test("chromeAwake: idle hides only while nothing holds it up", () => {
  assert.equal(chromeAwake({ sincePointerMs: 0 }), true);
  assert.equal(chromeAwake({ sincePointerMs: CHROME_IDLE_MS - 1 }), true);
  assert.equal(chromeAwake({ sincePointerMs: CHROME_IDLE_MS }), false);
  assert.equal(chromeAwake({}), false);
  for (const hold of ["paused", "ended", "settingsOpen", "overControl", "panelUp", "keyboardFocus"]) {
    assert.equal(chromeAwake({ [hold]: true, sincePointerMs: 1e9 }), true, hold);
  }
  assert.equal(CHROME_IDLE_MS, 2500);
});

test("trackingStatus: every state has a label, tone and pressed state", () => {
  for (const state of ["tracking", "turning", "away", "acquiring", "starting", "lost", "off", "unavailable"]) {
    const s = trackingStatus(state);
    assert.equal(typeof s.label, "string");
    assert.ok(["on", "busy", "warn", "off"].includes(s.tone), state);
    assert.equal(typeof s.pressed, "boolean");
    assert.ok(s.tip.length > 0);
  }
  assert.deepEqual([trackingStatus("tracking").tone, trackingStatus("tracking").pressed], ["on", true]);
  assert.equal(trackingStatus("lost").label, "Face lost");
  assert.equal(trackingStatus("lost").tone, "warn");
  assert.equal(trackingStatus("off").pressed, false);
  assert.equal(trackingStatus("unavailable").pressed, false);
  assert.equal(trackingStatus("acquiring").tone, "busy");
  // Unknown input falls back to off rather than throwing.
  assert.equal(trackingStatus("nonsense").tone, "off");
  assert.equal(trackingStatus(undefined).tone, "off");
  // Callers may mutate what they get back.
  trackingStatus("tracking").label = "x";
  assert.equal(trackingStatus("tracking").label, "Tracking");
});

test("periphMarks: face lost after 1 s, away after 0.6 s, not before", () => {
  assert.equal(periphMarks({ state: "lost", sinceStateMs: 900 }).faceLost, false);
  assert.equal(periphMarks({ state: "lost", sinceStateMs: 1001 }).faceLost, true);
  assert.equal(periphMarks({ state: "away", sinceStateMs: 500 }).away, false);
  assert.equal(periphMarks({ state: "away", sinceStateMs: 700 }).away, true);
  assert.equal(periphMarks({ state: "tracking", sinceStateMs: 1e6 }).faceLost, false);
  assert.equal(periphMarks({ state: "acquiring" }).acquiring, true);
  assert.equal(periphMarks({ state: "starting" }).acquiring, true);
  assert.equal(periphMarks({ state: "lost", sinceStateMs: NaN }).faceLost, false);
  assert.equal(periphMarks({ buffering: 1 }).buffering, true);
  assert.deepEqual(periphMarks(), { acquiring: false, faceLost: false, away: false, buffering: false });
});

test("seek math: pointer to fraction to time", () => {
  assert.equal(seekFraction(150, 100, 200), 0.25);
  assert.equal(seekFraction(50, 100, 200), 0);
  assert.equal(seekFraction(400, 100, 200), 1);
  assert.equal(seekFraction(150, 100, 0), 0);
  assert.equal(seekFraction(NaN, 100, 200), 0);
  assert.equal(timeAtFraction(0.25, 400), 100);
  assert.equal(timeAtFraction(2, 400), 400);
  assert.equal(timeAtFraction(0.5, NaN), 0);
  assert.equal(timeAtFraction(NaN, 100), 0);
});

test("seekKey: slider semantics, clamped, null for foreign keys or unknown duration", () => {
  assert.equal(seekKey("ArrowRight", 10, 100), 15);
  assert.equal(seekKey("ArrowUp", 10, 100), 15);
  assert.equal(seekKey("ArrowLeft", 3, 100), 0);
  assert.equal(seekKey("ArrowDown", 10, 100), 5);
  assert.equal(seekKey("PageUp", 95, 100), 100);
  assert.equal(seekKey("PageDown", 50, 100), 40);
  assert.equal(seekKey("Home", 50, 100), 0);
  assert.equal(seekKey("End", 50, 100), 100);
  assert.equal(seekKey("k", 50, 100), null);
  assert.equal(seekKey("ArrowRight", 50, NaN), null);
  assert.equal(seekKey("ArrowRight", NaN, 100), 5);
});

test("stepVolume: 5% grid, clamped, NaN-safe", () => {
  assert.equal(stepVolume(0.5, 0.05), 0.55);
  assert.equal(stepVolume(0.98, 0.05), 1);
  assert.equal(stepVolume(0.02, -0.05), 0);
  assert.equal(stepVolume(0.33, 0.05), 0.4);
  assert.equal(stepVolume(NaN, -0.05), 0.95);
  assert.equal(stepVolume(0.5, NaN), 0.5);
});

test("volumeStep: a step while muted never overwrites the remembered level", () => {
  // Muted at 80%, down: nothing changes (it used to save volume 0, and the
  // next M came back at 50%).
  assert.equal(volumeStep({ volume: 0.8, muted: true }, -0.05), null);
  assert.equal(volumeStep({ volume: 0, muted: true }, -0.05), null);
  // Muted, up: unmutes, one step up from the remembered level (not 5%).
  assert.deepEqual(volumeStep({ volume: 0.8, muted: true }, 0.05), { volume: 0.85, muted: false });
  assert.deepEqual(volumeStep({ volume: 0, muted: true }, 0.05), { volume: 0.05, muted: false });
  // Unmuted: plain steps; stepping down to 0 does not mute.
  assert.deepEqual(volumeStep({ volume: 0.5, muted: false }, -0.05), { volume: 0.45, muted: false });
  assert.deepEqual(volumeStep({ volume: 0.05, muted: false }, -0.05), { volume: 0, muted: false });
  assert.deepEqual(volumeStep({ volume: 1, muted: false }, 0.05), { volume: 1, muted: false });
});

test("transportSnapshot: ended pins the clock to the end, whatever the engine still reports", () => {
  // youtube's stale time after a paused seek to the end: 2:19 of 4:31.
  assert.deepEqual(
    transportSnapshot({ phase: "ended", time: 139, duration: 271, buffered: 0.5, paused: false }),
    { currentTime: 271, duration: 271, buffered: 1, paused: true },
  );
  // Ended with no known duration: nothing to pin to; pass through.
  assert.equal(transportSnapshot({ phase: "ended", time: 12, duration: NaN, buffered: 0, paused: true }).currentTime, 12);
  assert.deepEqual(
    transportSnapshot({ phase: "playing", time: 139, duration: 271, buffered: 0.6, paused: false }),
    { currentTime: 139, duration: 271, buffered: 0.6, paused: false },
  );
  for (const phase of ["ready", "error", null]) {
    const s = transportSnapshot({ phase, time: 50, duration: 271, buffered: 1, paused: true });
    assert.equal(s.currentTime, 0, String(phase));
    assert.ok(Number.isNaN(s.duration));
    assert.equal(s.buffered, 0);
  }
});

test("retryableRefusal: no Retry for refusals a retry cannot change", () => {
  assert.deepEqual([...PERMANENT_REFUSALS].sort((a, b) => a - b), [2, 100, 101, 150]);
  for (const code of [2, 100, 101, 150, "150"]) assert.equal(retryableRefusal(code), false, String(code));
  // A broken player, a referrer problem, an unknown or missing code: worth a retry.
  for (const code of [5, 153, 999, undefined, null]) assert.equal(retryableRefusal(code), true, String(code));
});

test("trackerGaveUp: a fatal report, or a stopped tracker, ends an open session's tracking", () => {
  const open = { playerOpen: true, trackingWanted: true, cameraState: "open" };
  assert.equal(trackerGaveUp({ ...open, fatal: true, running: false }), true);
  assert.equal(trackerGaveUp({ ...open, fatal: true, running: true }), true);    // reported before stopping
  assert.equal(trackerGaveUp({ ...open, fatal: false, running: false }), true);  // no flag, but stopped
  // A recovered crash or a per-frame error: the tracker is still running.
  assert.equal(trackerGaveUp({ ...open, fatal: false, running: true }), false);
  assert.equal(trackerGaveUp({ ...open }), false);
  // Nothing to fall back from: still opening (open() rejects for itself), off, not wanted, no player.
  assert.equal(trackerGaveUp({ ...open, cameraState: "opening", fatal: true, running: false }), false);
  assert.equal(trackerGaveUp({ ...open, cameraState: "off", fatal: true }), false);
  assert.equal(trackerGaveUp({ ...open, trackingWanted: false, fatal: true }), false);
  assert.equal(trackerGaveUp({ ...open, playerOpen: false, fatal: true }), false);
  assert.equal(trackerGaveUp(), false);
});

test("dragToView: grab the world, hFov per viewport width", () => {
  const d = dragToView(100, 0, 100, 1000);
  assert.equal(d.yaw, 10);          // drag right: view turns left (yaw > 0)
  assert.equal(d.pitch, 0);
  assert.equal(dragToView(0, 50, 100, 1000).pitch, 5);   // drag down: view turns up
  assert.equal(dragToView(-200, -100, 120, 1200).yaw, -20);
  assert.deepEqual(dragToView(10, 10, 100, 0), { yaw: 0, pitch: 0 });
  assert.deepEqual(dragToView(NaN, NaN, 100, 1000), { yaw: 0, pitch: 0 });
});

test("inAdHole: the right 24%, 9%-26% up from the bottom", () => {
  assert.deepEqual({ ...AD_HOLE }, { left: 0.76, bottom: 0.09, top: 0.26 });
  assert.equal(inAdHole(900, 850, 1000, 1000), true);
  assert.equal(inAdHole(700, 850, 1000, 1000), false);
  assert.equal(inAdHole(900, 950, 1000, 1000), false);   // too low: the bottom bar
  assert.equal(inAdHole(900, 700, 1000, 1000), false);   // too high
  assert.equal(inAdHole(900, 850, 0, 1000), false);
});

test("videoIdFrom: ?v= and the legacy ?video=, validated", () => {
  assert.equal(videoIdFrom("?v=sPyAQQklc1s"), "sPyAQQklc1s");
  assert.equal(videoIdFrom("?video=sPyAQQklc1s"), "sPyAQQklc1s");
  assert.equal(videoIdFrom("?v=short"), null);
  assert.equal(videoIdFrom("?v=<script>alert"), null);
  assert.equal(videoIdFrom(""), null);
  assert.equal(videoIdFrom(undefined), null);
  assert.equal(isVideoId("sPyAQQklc1s"), true);
  assert.equal(isVideoId(null), false);
});

const press = (key, extra = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, target: { tag: "BODY" }, ...extra });
const PLAYING = { library: false, settingsOpen: false, helpOpen: false, fullscreen: false, modal: false };

test("keyAction: the map, exactly", () => {
  const expect = {
    " ": "playpause", k: "playpause", K: "playpause",
    ArrowLeft: "back5", ArrowRight: "fwd5", j: "back10", l: "fwd10",
    ArrowUp: "volup", ArrowDown: "voldown", m: "mute", f: "fullscreen", F: "fullscreen",
    c: "recenter", t: "tracking", ",": "settings", "?": "help", Escape: "back",
  };
  for (const [key, action] of Object.entries(expect)) assert.equal(keyAction(press(key), PLAYING), action, key);
  for (const key of ["r", "s", "x", "Enter", "Tab", "1"]) assert.equal(keyAction(press(key), PLAYING), null, key);
  // Every listed shortcut row exists.
  assert.equal(SHORTCUTS.length, 11);
});

test("keyAction: modifiers are the browser's", () => {
  for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
    assert.equal(keyAction(press("c", { [mod]: true }), PLAYING), null, mod);
    assert.equal(keyAction(press("ArrowLeft", { [mod]: true }), PLAYING), null, mod);
    assert.equal(keyAction(press("Escape", { [mod]: true }), PLAYING), null, mod);
  }
  // Shift is fine: ? needs it, and Shift+K is still K.
  assert.equal(keyAction(press("?", { shiftKey: true }), PLAYING), "help");
});

test("keyAction: auto-repeat only for arrows", () => {
  assert.equal(keyAction(press("ArrowRight", { repeat: true }), PLAYING), "fwd5");
  assert.equal(keyAction(press("ArrowUp", { repeat: true }), PLAYING), "volup");
  for (const key of [" ", "f", "m", "c", "t", "Escape", "j"]) {
    assert.equal(keyAction(press(key, { repeat: true }), PLAYING), null, key);
  }
});

test("keyAction: Esc closes settings, then help, then goes back; never in fullscreen", () => {
  assert.equal(keyAction(press("Escape"), { ...PLAYING, settingsOpen: true }), "close-settings");
  assert.equal(keyAction(press("Escape"), { ...PLAYING, helpOpen: true }), "close-help");
  assert.equal(keyAction(press("Escape"), { ...PLAYING, fullscreen: true }), null);
  assert.equal(keyAction(press("Escape"), { ...PLAYING, fullscreen: true, settingsOpen: true }), "close-settings");
  assert.equal(keyAction(press("Escape"), { ...PLAYING, modal: true }), "back");
});

test("keyAction: the library only gets Esc-closes-settings", () => {
  const library = { ...PLAYING, library: true };
  assert.equal(keyAction(press("Escape"), library), null);
  assert.equal(keyAction(press("Escape"), { ...library, settingsOpen: true }), "close-settings");
  for (const key of [" ", "k", "f", "c", "ArrowLeft", ","]) assert.equal(keyAction(press(key), library), null, key);
});

test("keyAction: text fields, selects and the settings panel keep their keys", () => {
  const inField = (tag, type) => press("k", { target: { tag, type } });
  assert.equal(keyAction(inField("INPUT", "search"), PLAYING), null);
  assert.equal(keyAction(inField("INPUT", "text"), PLAYING), null);
  assert.equal(keyAction(inField("INPUT", undefined), PLAYING), null);
  assert.equal(keyAction(inField("TEXTAREA"), PLAYING), null);
  assert.equal(keyAction(inField("SELECT"), PLAYING), null);
  assert.equal(keyAction(press("k", { target: { tag: "DIV", editable: true } }), PLAYING), null);
  assert.equal(keyAction(press("f", { target: { tag: "INPUT", type: "range", inSettings: true } }), PLAYING), null);
  // Esc still closes settings from inside them.
  assert.equal(keyAction(press("Escape", { target: { tag: "SELECT", inSettings: true } }), { ...PLAYING, settingsOpen: true }), "close-settings");
});

test("keyAction: sliders keep navigation keys, pass the rest", () => {
  const range = { tag: "INPUT", type: "range" };
  assert.equal(keyAction(press("ArrowUp", { target: range }), PLAYING), null);
  assert.equal(keyAction(press("Home", { target: range }), PLAYING), null);
  assert.equal(keyAction(press(" ", { target: range }), PLAYING), "playpause");
  assert.equal(keyAction(press("m", { target: range }), PLAYING), "mute");
  const seek = { tag: "DIV", role: "slider" };
  assert.equal(keyAction(press("ArrowLeft", { target: seek }), PLAYING), null);
  assert.equal(keyAction(press("k", { target: seek }), PLAYING), "playpause");
});

test("keyAction: a focused button owns Space and Enter (no double toggle)", () => {
  assert.equal(keyAction(press(" ", { target: { tag: "BUTTON" } }), PLAYING), null);
  assert.equal(keyAction(press("Enter", { target: { tag: "BUTTON" } }), PLAYING), null);
  assert.equal(keyAction(press(" ", { target: { tag: "DIV", role: "button" } }), PLAYING), null);
  assert.equal(keyAction(press(" ", { target: { tag: "INPUT", type: "checkbox" } }), PLAYING), null);
  // Other keys still work from a focused button.
  assert.equal(keyAction(press("k", { target: { tag: "BUTTON" } }), PLAYING), "playpause");
  assert.equal(keyAction(press("ArrowRight", { target: { tag: "BUTTON" } }), PLAYING), "fwd5");
});

test("keyAction: a modal panel (sheet, end, error, ready) passes only Esc", () => {
  const modal = { ...PLAYING, modal: true };
  for (const key of [" ", "k", "f", "c", "ArrowLeft", "?"]) assert.equal(keyAction(press(key), modal), null, key);
});

test("keyAction: junk input does not throw", () => {
  assert.equal(keyAction(null, PLAYING), null);
  assert.equal(keyAction({}, PLAYING), null);
  assert.equal(keyAction({ key: undefined, target: null }, PLAYING), null);
  assert.equal(keyAction(press("k")), "playpause");   // ctx defaults to playing
});

test("diagnosticsRows: every row present with sane fallbacks", () => {
  const empty = diagnosticsRows();
  assert.deepEqual(empty.map((r) => r[0]), ["state", "head", "eye", "view", "tracker", "quality", "fps"]);
  assert.equal(empty.find((r) => r[0] === "tracker")[1], "off");

  const rows = diagnosticsRows({
    steer: { state: "lost", head: { yaw: 3.14, pitch: -2 }, eye: { x: 1, y: NaN } },
    view: { yaw: Math.PI / 2, pitch: 0 },
    tracker: { rate: 12, latencyMs: 18.4, mode: "worker" },
    quality: { label: "2160p", k: 2 },
    fps: 59.7,
  });
  const get = (key) => rows.find((r) => r[0] === key);
  assert.deepEqual(get("state"), ["state", "lost", "bad"]);
  assert.equal(get("head")[1], "+3.1, -2.0°");
  assert.equal(get("eye")[1], "+1.0, –°");
  assert.equal(get("view")[1], "+90.0, +0.0°");
  assert.equal(get("tracker")[1], "12 Hz · 18 ms · worker");
  assert.equal(get("tracker")[2], "warn");
  assert.equal(get("quality")[1], "2160p · k 2.00");
  assert.equal(get("fps")[1], "60");
});
