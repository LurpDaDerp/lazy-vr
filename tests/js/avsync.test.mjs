/* The audio shadow: mirrored state, steered drift, snapped stalls. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AVSync, SNAP, STEER, TRIM } from "../../site/js/avsync.js";

class FakeMedia {
  constructor() {
    this.paused = true;
    this.seeking = false;
    this.readyState = 4;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.src = "";
    this.listeners = {};
  }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  emit(name) { for (const fn of this.listeners[name] || []) fn(); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() {}
}

function rig() {
  const video = new FakeMedia();
  const audio = new FakeMedia();
  const sync = new AVSync(video, audio, { watch: false });
  return { video, audio, sync };
}

test("a clip with a separate audio track arms the shadow", () => {
  const { audio, sync } = rig();
  sync.set("/media/x/video", "/media/x/audio");
  assert.equal(sync.enabled, true);
  assert.equal(audio.src, "/media/x/audio");
});

test("a muxed or silent clip stands the shadow down", () => {
  const { audio, sync } = rig();
  audio.src = "left-over";
  sync.set("/media/x/video", null);
  assert.equal(sync.enabled, false);
  assert.equal(audio.src, "");
});

test("play and pause are mirrored as they happen", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.paused = false;
  video.emit("playing");
  assert.equal(audio.paused, false);
  video.paused = true;
  video.emit("pause");
  assert.equal(audio.paused, true);
});

test("a seek drags the audio clock with it", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.currentTime = 90;
  video.emit("seeked");
  assert.equal(audio.currentTime, 90);
});

test("audio waits while the video is seeking or starved", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.paused = false;
  audio.paused = false;
  video.seeking = true;
  video.emit("seeking");
  assert.equal(audio.paused, true);
  video.seeking = false;
  video.readyState = 2;
  video.emit("waiting");
  assert.equal(audio.paused, true);
});

test("small drift is steered out through playbackRate, not jumped", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.paused = false;
  audio.paused = false;
  video.currentTime = 100;
  audio.currentTime = 100 + (STEER + SNAP) / 2; // ahead: slow the audio down
  sync.tick();
  assert.equal(audio.currentTime, 100 + (STEER + SNAP) / 2);
  assert.ok(Math.abs(audio.playbackRate - (1 - TRIM)) < 1e-9);
  audio.currentTime = 100 - (STEER + SNAP) / 2; // behind: speed it up
  sync.tick();
  assert.ok(Math.abs(audio.playbackRate - (1 + TRIM)) < 1e-9);
});

test("large drift is snapped and the rate restored", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.paused = false;
  audio.paused = false;
  audio.playbackRate = 1 - TRIM;
  video.currentTime = 100;
  audio.currentTime = 100 + SNAP * 3;
  sync.tick();
  assert.equal(audio.currentTime, 100);
  assert.equal(audio.playbackRate, 1);
});

test("drift inside the steering band leaves the rate alone", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.paused = false;
  audio.paused = false;
  video.currentTime = 100;
  audio.currentTime = 100 + STEER / 2;
  sync.tick();
  assert.equal(audio.playbackRate, 1);
});

test("the video's own playbackRate carries through the steering", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.playbackRate = 2;
  video.emit("ratechange");
  sync.tick();
  assert.equal(audio.playbackRate, 2);
});

test("a disarmed shadow ignores everything", () => {
  const { video, audio, sync } = rig();
  sync.set("v", null);
  video.paused = false;
  video.emit("playing");
  sync.tick();
  assert.equal(audio.paused, true);
});

test("clear stops both elements and forgets their sources", () => {
  const { video, audio, sync } = rig();
  sync.set("v", "a");
  video.paused = false;
  audio.paused = false;
  sync.clear();
  assert.equal(video.paused, true);
  assert.equal(audio.paused, true);
  assert.equal(video.src, "");
  assert.equal(audio.src, "");
  assert.equal(sync.enabled, false);
});
