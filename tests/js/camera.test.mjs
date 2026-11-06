/* The camera and the worker transport around TrackerEngine.
 *
 * tracker-core.js imports MediaPipe from a CDN, so it is answered with a stub
 * before anything asks for it. The worker is run for real: tracker-worker.js
 * is evaluated in a vm context per fake Worker, and its dynamic import of
 * tracker-core reaches the same stub through the main loader.
 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

const STUB = "stub:tracker-core";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("tracker-core.js")) return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== STUB) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        const S = () => globalThis.__trackerStub;
        export class TrackerEngine {
          constructor(options) {
            this.options = options;
            this.loaded = false;
            this.resets = 0;
            this.closed = false;
            this.calls = [];
            S().engines.push(this);
          }
          async load() {
            await S().engineLoad(this);
            this.loaded = true;
          }
          reset() { this.resets += 1; }
          configure(config) { (this.configs ||= []).push({ ...config }); }
          process(image, width, height, atMs) {
            this.calls.push({ image, width, height, atMs });
            return S().process(this, image, width, height, atMs);
          }
          close() { this.closed = true; }
        }`,
    };
  },
});

const reading = (atMs) => ({
  t: atMs, tracked: true, reason: "ok",
  head: { yaw: 0, pitch: 0, roll: 0 }, dist: 60, rms: 0.01,
  eye: { x: 0, y: 0, valid: false, blink: false },
  latencyMs: 5, rate: 30,
});

const stub = () => ({
  engines: [],
  engineLoad: () => Promise.resolve(),
  process: (engine, image, width, height, atMs) => reading(atMs),
});
globalThis.__trackerStub = stub();

const { HeadTracker } = await import("../../site/js/camera.js");

const workerUrl = new URL("../../site/js/tracker-worker.js", import.meta.url);
const workerScript = new vm.Script(await readFile(workerUrl, "utf8"), {
  filename: workerUrl.href,
  importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});

/* A fresh worker global scope running the real tracker-worker.js. */
function workerScope(post, perf = performance) {
  const scope = {};
  const sandbox = { self: scope, postMessage: post, performance: perf, console };
  vm.createContext(sandbox);
  workerScript.runInContext(sandbox);
  return scope;
}

/* Enough turns of the event loop for message round-trips to land. Fake
 * workers deliver with setImmediate, which keeps message order. */
const settle = async (rounds = 25) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/* Objects made inside the worker's vm context have that realm's prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const held = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};

/* A frame stream whose reader remembers being cancelled. */
function fakeFrames() {
  let waiting = null;
  let ended = false;
  const queued = [];
  const reader = {
    cancelled: false,
    read() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { waiting = resolve; });
    },
    cancel() {
      reader.cancelled = true;
      ended = true;
      if (waiting) { waiting({ done: true }); waiting = null; }
      return Promise.resolve();
    },
  };
  return {
    reader,
    readable: { getReader: () => reader },
    push(value) {
      if (waiting) { waiting({ done: false, value }); waiting = null; }
      else queued.push({ done: false, value });
    },
    end() {
      ended = true;
      if (waiting) { waiting({ done: true }); waiting = null; }
    },
  };
}

function fakeFrame(timestamp) {
  return {
    displayWidth: 640, displayHeight: 480, timestamp,
    closed: false, close() { this.closed = true; },
  };
}

function fakeVideo() {
  const callbacks = [];
  return {
    srcObject: null, muted: false, playsInline: false,
    videoWidth: 1280, videoHeight: 720, currentTime: 0,
    play: async () => {},
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback(callback) { callbacks.push(callback); return callbacks.length; },
    /* Present one video frame: run every pending frame callback. */
    fire(metadata = {}) {
      const due = callbacks.splice(0);
      for (const callback of due) callback(performance.now(), metadata);
      return due.length;
    },
  };
}

/* The page's world: cameras, a Worker that runs the real worker script, the
 * frame-stream transport, createImageBitmap. */
function harness({ worker = true, processor = true, camera = "open" } = {}) {
  const env = {
    workers: [], processors: [], tracks: [], streams: [], asks: [], bitmaps: [],
    pending: [],
  };
  const models = held();
  globalThis.__trackerStub = stub();
  globalThis.__trackerStub.engineLoad = () => models.promise.then((ok) => {
    if (!ok) throw new Error("no models");
  });

  const fakeTrack = () => {
    const listeners = new Set();
    const track = {
      kind: "video", stopped: false, ends: [],
      // As in the browser, stop() ends the processor's stream but never fires "ended".
      stop() {
        if (track.stopped) return;
        track.stopped = true;
        for (const end of track.ends) end();
      },
      clone: () => fakeTrack(),
      addEventListener(type, listener) { if (type === "ended") listeners.add(listener); },
      removeEventListener(type, listener) { if (type === "ended") listeners.delete(listener); },
      get listening() { return listeners.size; },
      /* The source goes away (unplugged, permission revoked): the processor's
       * stream closes and "ended" fires. The light is off, so it counts as stopped. */
      unplug({ event = true } = {}) {
        if (track.stopped) return;
        track.stopped = true;
        for (const end of track.ends) end();
        if (event) for (const listener of [...listeners]) { listeners.delete(listener); listener({ type: "ended" }); }
      },
    };
    env.tracks.push(track);
    return track;
  };
  const fakeStream = () => {
    const tracks = [fakeTrack()];
    const stream = {
      getVideoTracks: () => tracks.slice(),
      getTracks: () => tracks.slice(),
      addTrack: (track) => { tracks.push(track); },
      removeTrack: (track) => {
        const at = tracks.indexOf(track);
        if (at >= 0) tracks.splice(at, 1);
      },
    };
    env.streams.push(stream);
    return stream;
  };

  if (worker) {
    globalThis.Worker = class FakeWorker {
      constructor(url) {
        this.url = String(url);
        this.posted = [];
        this.sent = [];
        this.terminated = false;
        this.scope = workerScope((data) => {
          this.sent.push(data);
          setImmediate(() => { if (!this.terminated && this.onmessage) this.onmessage({ data }); });
        });
        env.workers.push(this);
      }
      postMessage(data) {
        this.posted.push(data);
        if (this.terminated) return;
        setImmediate(() => { if (!this.terminated) this.scope.onmessage({ data }); });
      }
      terminate() { this.terminated = true; }
      crash(message = "RuntimeError: memory access out of bounds") {
        if (this.onerror) this.onerror({ message });
      }
    };
  } else {
    delete globalThis.Worker;
  }

  if (processor) {
    globalThis.MediaStreamTrackProcessor = class {
      constructor({ track, maxBufferSize }) {
        this.track = track;
        this.maxBufferSize = maxBufferSize;
        this.frames = fakeFrames();
        this.readable = this.frames.readable;
        // A stopped track ends its processor's stream, as in the browser.
        track.ends.push(() => this.frames.end());
        env.processors.push(this);
      }
    };
  } else {
    delete globalThis.MediaStreamTrackProcessor;
  }

  globalThis.createImageBitmap = async (source, options) => {
    if (env.rejectResize && options) throw new TypeError("resize options unsupported");
    const bitmap = {
      source, options,
      width: options ? options.resizeWidth : source.videoWidth,
      height: options ? options.resizeHeight : source.videoHeight,
      closed: false, close() { this.closed = true; },
    };
    env.bitmaps.push(bitmap);
    return bitmap;
  };

  // A stale entry for an unplugged webcam ranks first.
  const devices = [
    { kind: "audioinput", deviceId: "mic", label: "Microphone" },
    { kind: "videoinput", deviceId: "ghost", label: "USB 2.0 Camera" },
    { kind: "videoinput", deviceId: "real", label: "NexiGo N60 FHD Webcam" },
  ];
  const wontStart = () => {
    const failed = new Error("Could not start video source");
    failed.name = "AbortError";
    return failed;
  };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        enumerateDevices: async () => devices,
        getUserMedia: async ({ video }) => {
          env.asks.push(video);
          if (camera === "pending") {
            const ask = held();
            env.pending.push(ask);
            return ask.promise;
          }
          if (camera === "fussy" && video !== true) throw wontStart();
          if (camera === "ranked" && video?.deviceId?.exact !== "real") throw wontStart();
          return fakeStream();
        },
      },
    },
    configurable: true, writable: true,
  });

  globalThis.location = { href: "https://lazyvr.test/", host: "lazyvr.test" };
  globalThis.window = { isSecureContext: true };
  globalThis.requestAnimationFrame = () => 0;

  return {
    env,
    video: fakeVideo(),
    finishModels: () => models.release(true),
    failModels: () => models.release(false),
    answerCamera: () => { for (const ask of env.pending.splice(0)) ask.release(fakeStream()); },
    get worker() { return env.workers.at(-1); },
    get stream() { return env.streams.at(-1); },
    get processor() { return env.processors.at(-1); },
    lightOn: () => env.tracks.some((track) => !track.stopped),
  };
}

/* A tracker whose worker is loaded and whose camera is open (worker mode by default). */
async function running(options = {}, trackerOptions = {}) {
  const h = harness(options);
  const readings = [];
  const errors = [];
  const said = [];
  // What onError's second argument said, and whether the camera was already let go.
  const notes = [];
  const tracker = new HeadTracker({
    onReading: (r) => readings.push(r),
    onError: (e, info) => {
      errors.push(e);
      notes.push({ ...info, running: tracker.running, stream: tracker.stream });
    },
    onStatus: (text) => said.push(text),
    ...trackerOptions,
  });
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await opening;
  await settle();
  return { h, tracker, readings, errors, said, notes };
}

const engineOf = (h, which = "worker") => globalThis.__trackerStub.engines
  .filter((engine) => (which === "worker") === engine.options.models.startsWith("https://"))
  .at(-1);

// -- the transport is chosen against a pipeline that exists ------------------

test("a camera that opens while the models load still hands the frames to the worker", async () => {
  const h = harness();
  const tracker = new HeadTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.mode, "worker");
  assert.equal(tracker.running, true);
  const stream = h.worker.posted.find((m) => m.type === "stream");
  assert.ok(stream, "the frame stream never reached the worker");
  assert.equal(stream.run, tracker.runId);
  assert.equal(h.processor.maxBufferSize, 1);
  assert.equal(h.video.srcObject, null, "the page took frames the worker was going to read");
  assert.match(h.worker.url, /tracker-worker\.js$/);
  assert.equal(h.worker.posted[0].models, "https://lazyvr.test/models");
});

test("the worker takes the frames when the models are already in", async () => {
  const h = harness();
  const tracker = new HeadTracker();
  const loading = tracker.load();
  h.finishModels();
  await loading;
  assert.equal(tracker.mode, "worker");
  await tracker.open(h.video);

  assert.equal(tracker.mode, "worker");
  assert.equal(h.worker.posted.filter((m) => m.type === "stream").length, 1);
});

test("the camera position reaches the engine, set before, during or after the load", async () => {
  // Set before the worker exists: rides along with "load".
  const h = harness();
  const tracker = new HeadTracker();
  tracker.configure({ screenOffsetCm: -10 });
  const loading = tracker.load();
  await settle();
  // Changed while the models load: still reaches the engine once it exists.
  tracker.configure({ screenOffsetCm: 0 });
  h.finishModels();
  await loading;
  await settle();
  const worker = engineOf(h, "worker");
  assert.equal(worker.configs.at(-1).screenOffsetCm, 0);
  // Changed while running.
  tracker.configure({ screenOffsetCm: 12 });
  await settle();
  assert.equal(worker.configs.at(-1).screenOffsetCm, 12);
  // Junk is ignored.
  tracker.configure({ screenOffsetCm: NaN });
  await settle();
  assert.equal(worker.configs.at(-1).screenOffsetCm, 12);

  // Inline: the page's engine gets it on creation and live.
  const hi = harness({ worker: false });
  const inline = new HeadTracker();
  inline.configure({ screenOffsetCm: -10 });
  const inlineLoad = inline.load();
  await settle();
  hi.finishModels();
  await inlineLoad;
  assert.equal(inline.engine.configs.at(-1).screenOffsetCm, -10);
  inline.configure({ screenOffsetCm: 0 });
  assert.equal(inline.engine.configs.at(-1).screenOffsetCm, 0);
});

test("without a frame stream the page carries the frames, still to the worker", async () => {
  const { h, tracker } = await running({ processor: false });

  assert.equal(tracker.mode, "frames");
  assert.equal(h.video.srcObject, h.stream);
  assert.ok(!h.worker.posted.some((m) => m.type === "stream"));
  const session = h.worker.posted.find((m) => m.type === "session");
  assert.equal(session.run, tracker.runId);
});

test("with no worker the camera waits for the in-page engine, and resets it", async () => {
  const h = harness({ worker: false });
  const tracker = new HeadTracker();
  let readyWhenOpened = null;
  const loading = tracker.load();
  const opening = tracker.open(h.video).then(() => {
    readyWhenOpened = Boolean(tracker.engine && tracker.engine.loaded);
  });
  await settle();
  assert.equal(readyWhenOpened, null, "open() finished before the engine loaded");
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.mode, "inline");
  assert.equal(readyWhenOpened, true);
  assert.equal(tracker.engine.resets, 1);
  assert.equal(h.video.srcObject, h.stream);
});

test("a worker whose models fail falls back to the in-page engine", async () => {
  const h = harness();
  globalThis.__trackerStub.engineLoad = (engine) => (engine.options.models.startsWith("https://")
    ? Promise.reject(new Error("no GPU in workers"))
    : Promise.resolve());
  const tracker = new HeadTracker();
  await tracker.load();

  assert.equal(tracker.mode, "inline");
  assert.equal(h.worker.terminated, true);
  assert.equal(tracker.worker, null);
  assert.ok(tracker.engine.loaded);
});

test("with no pipeline at all open() says so and lets the camera go", async () => {
  const h = harness({ worker: false });
  const tracker = new HeadTracker();
  const opening = tracker.open(h.video);
  await settle();
  h.failModels();

  await assert.rejects(opening, /head tracking could not load.*no models/i);
  assert.equal(h.lightOn(), false, "the camera light stayed on with nothing to track");
  assert.equal(tracker.running, false);
});

// -- one load, however many callers ------------------------------------------

test("load() is asked once however many times it is called", async () => {
  const h = harness();
  const tracker = new HeadTracker();
  const first = tracker.load();
  const second = tracker.load();
  assert.equal(first, second);
  h.finishModels();
  await Promise.all([first, second]);
  await tracker.load();

  assert.equal(h.env.workers.length, 1);
  assert.equal(h.worker.posted.filter((m) => m.type === "load").length, 1);
});

test("a load that failed can be asked again", async () => {
  const h = harness({ worker: false });
  const tracker = new HeadTracker();
  const first = tracker.load();
  h.failModels();
  await assert.rejects(first, /no models/);
  assert.equal(globalThis.__trackerStub.engines[0].closed, true, "the failed engine was not closed");

  globalThis.__trackerStub.engineLoad = () => Promise.resolve();
  await tracker.load();
  assert.ok(tracker.engine.loaded);
});

// -- readings and run ids -----------------------------------------------------

test("readings arrive tagged with the live run, and the engine is reset per open", async () => {
  const { h, tracker, readings } = await running();
  const engine = engineOf(h);
  assert.equal(engine.resets, 1);

  h.processor.frames.push(fakeFrame(1_000_000));
  await settle();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].run, tracker.runId);
  assert.equal(readings[0].tracked, true);
  assert.equal(tracker.rate, 30);

  tracker.stop();
  await tracker.open(h.video);
  await settle();
  assert.equal(engine.resets, 2, "the second session reused the first one's tracking state");
  const streams = h.worker.posted.filter((m) => m.type === "stream");
  assert.equal(streams.length, 2);
  assert.ok(streams[1].run > streams[0].run);
});

test("a frame still in the engine when its session ends never reaches the page", async () => {
  const { h, tracker, readings } = await running();
  const slow = held();
  globalThis.__trackerStub.process = (engine, image, w, hgt, atMs) => slow.promise.then(() => reading(atMs));

  h.processor.frames.push(fakeFrame(1_000_000));
  await settle();
  assert.equal(engineOf(h).calls.length, 1, "the frame never reached the engine");

  tracker.stop();
  const opening = tracker.open(h.video);
  await settle();
  await opening;
  slow.release();
  await settle();

  assert.equal(readings.length, 0, "a reading from a stopped session steered the next one");
  assert.ok(!h.worker.sent.some((m) => m.type === "reading"), "the worker posted for a retired run");

  globalThis.__trackerStub.process = (engine, image, w, hgt, atMs) => reading(atMs);
  h.processor.frames.push(fakeFrame(2_000_000));
  await settle();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].run, tracker.runId);
});

test("the page drops readings from any run but the live one", async () => {
  const { h, tracker, readings } = await running();
  const live = tracker.runId;
  tracker.fromWorker(h.worker, { type: "reading", run: live - 1, reading: reading(1) });
  tracker.fromWorker(h.worker, { type: "reading", run: live + 1, reading: reading(2) });
  assert.equal(readings.length, 0);
  tracker.fromWorker(h.worker, { type: "reading", run: live, reading: reading(3) });
  assert.equal(readings.length, 1);

  tracker.stop();
  tracker.fromWorker(h.worker, { type: "reading", run: live, reading: reading(4) });
  assert.equal(readings.length, 1, "a reading after stop() was delivered");
});

test("VideoFrame timestamps reach the engine on the absolute clock", async () => {
  const { h } = await running();
  const before = performance.timeOrigin + performance.now();
  h.processor.frames.push(fakeFrame(5_000_000));
  await settle();
  h.processor.frames.push(fakeFrame(5_033_333));
  await settle();
  const after = performance.timeOrigin + performance.now();

  const [first, second] = engineOf(h).calls.map((call) => call.atMs);
  assert.ok(first >= before && first <= after, `first frame at ${first}`);
  assert.ok(second > first && second <= after);
  assert.ok(second - first <= 33.334 + 1e-6, "the frame spacing came from the wall clock, not the camera");
});

test("processing errors reach onError once per session", async () => {
  const { h, tracker, errors } = await running();
  globalThis.__trackerStub.process = () => { throw new Error("detect failed"); };
  h.processor.frames.push(fakeFrame(1_000_000));
  await settle();
  h.processor.frames.push(fakeFrame(1_033_000));
  await settle();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /detect failed/);
  assert.match(String(tracker.error), /detect failed/);
});

// -- frames mode: one bitmap in flight ------------------------------------------

test("frames mode keeps exactly one downscaled bitmap in flight", async () => {
  const { h, tracker, readings } = await running({ processor: false });
  const slow = held();
  globalThis.__trackerStub.process = (engine, image, w, hgt, atMs) => slow.promise.then(() => reading(atMs));

  h.video.fire({ captureTime: performance.now() - 5 });
  h.video.fire();  // grab still pending: skipped
  await settle();
  h.video.fire();  // with the worker: skipped
  await settle();

  const frames = () => h.worker.posted.filter((m) => m.type === "frame");
  assert.equal(frames().length, 1);
  const [sent] = frames();
  assert.equal(sent.run, tracker.runId);
  assert.deepEqual(sent.image.options, { resizeWidth: 640, resizeHeight: 360, resizeQuality: "low" });
  assert.equal(engineOf(h).calls[0].width, 640);
  assert.equal(engineOf(h).calls[0].height, 360);

  slow.release();
  await settle();
  assert.equal(readings.length, 1);
  assert.equal(sent.image.closed, true, "the worker kept the bitmap");

  h.video.fire();
  await settle();
  assert.equal(frames().length, 2, "the next frame was not sent once the worker was ready");
});

test("a late 'ready' from a retired run does not open a second slot", async () => {
  const { h, tracker } = await running({ processor: false });
  tracker.inflight = true;
  tracker.fromWorker(h.worker, { type: "ready", run: tracker.runId - 1 });
  assert.equal(tracker.inflight, true);
  tracker.fromWorker(h.worker, { type: "ready", run: tracker.runId });
  assert.equal(tracker.inflight, false);
});

test("a camera already at most 640 wide is grabbed as it is", async () => {
  const h0 = harness({ processor: false });
  h0.video.videoWidth = 640;
  h0.video.videoHeight = 480;
  const tracker = new HeadTracker();
  const opening = tracker.open(h0.video);
  await settle();
  h0.finishModels();
  await opening;
  h0.video.fire();
  await settle();
  assert.equal(h0.env.bitmaps.length, 1);
  assert.equal(h0.env.bitmaps[0].options, undefined);
});

test("a browser that rejects the resize options gets full-size grabs from then on", async () => {
  const { h } = await running({ processor: false });
  h.env.rejectResize = true;
  h.video.fire();
  await settle();
  h.video.fire();
  await settle();
  assert.equal(h.env.bitmaps.length, 2);
  assert.ok(h.env.bitmaps.every((bitmap) => bitmap.options === undefined));
  assert.equal(h.worker.posted.filter((m) => m.type === "frame").length, 2);
});

test("inline mode feeds the engine the frame's capture time", async () => {
  const { h, tracker, readings } = await running({ worker: false });
  const captured = performance.now() - 12;
  h.video.fire({ captureTime: captured });
  await settle();

  const engine = tracker.engine;
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].atMs, performance.timeOrigin + captured);
  assert.equal(engine.calls[0].width, 1280);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].run, tracker.runId);
});

// -- a wait the page can read ------------------------------------------------------

test("a prompt the browser never shows says so rather than waiting in silence", async () => {
  const h = harness({ camera: "pending" });
  const said = [];
  const tracker = new HeadTracker({ onStatus: (text) => said.push(text), permissionGrace: 5 });
  const opening = tracker.open(h.video);
  await new Promise((r) => setTimeout(r, 20));

  assert.match(said.at(-1), /allow|permission/i, `the page was left on: ${said.at(-1)}`);
  let opened = false;
  opening.then(() => { opened = true; });
  await settle();
  assert.equal(opened, false, "the camera ask was given up on");
  h.answerCamera();
  h.finishModels();
  await opening;
  assert.equal(tracker.mode, "worker");
});

test("once the camera is in, the wait is named for the stage the model is at", async () => {
  const h = harness();
  const said = [];
  const tracker = new HeadTracker({ onStatus: (text) => said.push(text) });
  const loading = tracker.load();
  tracker.pipelineStatus("Loading the face model…");  // as the engine would report
  const opening = tracker.open(h.video);
  await settle();
  assert.equal(said.at(-1), "Loading the face model…", `the page was left on: ${said.at(-1)}`);

  h.finishModels();
  await Promise.all([loading, opening]);
  assert.equal(said.at(-1), "Camera running");
});

test("a model that never arrives says where it is coming from", async () => {
  const h = harness();
  const said = [];
  const tracker = new HeadTracker({ onStatus: (text) => said.push(text), modelGrace: 1 });
  const opening = tracker.open(h.video);
  await new Promise((r) => setTimeout(r, 20));

  assert.match(said.at(-1), /cdn|jsdelivr|blocker/i, `the page was left on: ${said.at(-1)}`);
  h.finishModels();
  await opening;
  assert.equal(said.at(-1), "Camera running");
  assert.ok(said.some((text) => /head-tracking model/.test(text)), said.join(" | "));
});

// -- a camera let go of before it arrives --------------------------------------------

test("a stop while the ask is still out releases the camera when it arrives", async () => {
  const h = harness({ camera: "pending" });
  const tracker = new HeadTracker({ permissionGrace: 1e9 });
  const opening = tracker.open(h.video).catch((error) => error);
  await settle();
  tracker.stop();
  h.answerCamera();
  h.finishModels();

  assert.match((await opening).message, /let go of/);
  assert.equal(h.lightOn(), false, "the camera was left running with nobody holding it");
  assert.equal(tracker.stream, null);
  assert.equal(tracker.running, false);
});

test("a stop while the model loads lets go and never wires the frames", async () => {
  const h = harness();
  const tracker = new HeadTracker();
  const opening = tracker.open(h.video).catch((error) => error);
  await settle();
  tracker.stop();
  h.finishModels();

  assert.match((await opening).message, /let go of/);
  await settle();
  assert.equal(h.lightOn(), false);
  assert.ok(!h.worker.posted.some((m) => m.type === "stream"));
});

test("a second ask retires the first rather than leaving two cameras open", async () => {
  const h = harness({ camera: "pending" });
  const tracker = new HeadTracker({ permissionGrace: 1e9 });
  const first = tracker.open(h.video).catch((error) => error);
  const second = tracker.open(h.video);
  await settle();
  h.answerCamera();
  h.finishModels();

  assert.match((await first).message, /let go of/);
  await second;
  assert.equal(tracker.mode, "worker");
  assert.equal(h.worker.posted.filter((m) => m.type === "stream").length, 1);
  const [firstStream, secondStream] = h.env.streams;
  assert.equal(firstStream.getTracks()[0].stopped, true);
  assert.equal(secondStream.getTracks()[0].stopped, false);
  assert.equal(tracker.stream, secondStream);
});

test("an open retired while the model loads does not take the newer camera with it", async () => {
  const h = harness();
  const tracker = new HeadTracker();
  const first = tracker.open(h.video).catch((error) => error);
  await settle();
  const second = tracker.open(h.video, "real");
  await settle();
  assert.equal(h.env.streams.length, 2);
  h.finishModels();

  assert.match((await first).message, /let go of/);
  await second;
  const [older, newer] = h.env.streams;
  assert.equal(older.getTracks()[0].stopped, true);
  assert.equal(newer.getTracks()[0].stopped, false, "the retired open stopped the live camera");
  assert.equal(tracker.stream, newer);
  assert.equal(tracker.running, true);
});

test("opening while a session runs releases the previous camera first", async () => {
  const { h, tracker } = await running();
  const old = h.stream;
  await tracker.open(h.video, "real");
  assert.equal(old.getTracks()[0].stopped, true);
  assert.notEqual(tracker.stream, old);
  assert.equal(tracker.running, true);
});

test("a stop while the element is still finding its size lets go rather than claiming success", async () => {
  const h = harness({ processor: false });
  h.video.videoWidth = 0;
  const tracker = new HeadTracker();
  const opening = tracker.open(h.video).then(() => "opened", (error) => error.message);
  await settle();
  h.finishModels();
  await settle();

  tracker.stop();
  const outcome = await Promise.race([
    opening,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 800)),
  ]);
  assert.match(String(outcome), /let go of/,
    outcome === "hung" ? "open() never came back" : `open() said: ${outcome}`);
  assert.equal(h.lightOn(), false);
});

test("a picture that will not play is an error, not a silent session", async () => {
  const h = harness({ worker: false });
  h.video.videoWidth = 0;
  h.video.play = async () => {
    const failed = new Error("play() refused");
    failed.name = "NotAllowedError";
    throw failed;
  };
  const tracker = new HeadTracker();
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await assert.rejects(opening, /would not play \(NotAllowedError\)/);
  assert.equal(h.lightOn(), false);
});

// -- the open ladder ------------------------------------------------------------------

test("the camera is asked for 1280x720 at 30, facing the user", async () => {
  const { h } = await running();
  assert.deepEqual(h.env.asks[0], {
    facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
  });
});

test("a driver that will not start the asked-for shape is asked again for any shape", async () => {
  const { h, tracker } = await running({ camera: "fussy" });
  assert.equal(tracker.mode, "worker");
  assert.equal(tracker.stream, h.stream);
  assert.equal(h.env.asks.at(-1), true);
});

test("a camera that will not start at all says so in words", async () => {
  const h = harness();
  navigator.mediaDevices.getUserMedia = async () => {
    const failed = new Error("Could not start video source");
    failed.name = "AbortError";
    throw failed;
  };
  const tracker = new HeadTracker();
  await assert.rejects(tracker.open(h.video), /would start.*close|close.*would start/is);
});

test("a refused camera says how to allow it", async () => {
  const h = harness();
  navigator.mediaDevices.getUserMedia = async () => {
    const failed = new Error("Permission denied");
    failed.name = "NotAllowedError";
    throw failed;
  };
  await assert.rejects(new HeadTracker().open(h.video), /refused.*allow/is);
});

test("a browser that reaches for a camera that is gone is told to try the others", async () => {
  const { h, tracker } = await running({ camera: "ranked" });
  assert.equal(tracker.stream, h.stream);
  assert.deepEqual(h.env.asks.at(-1).deviceId, { exact: "real" });
  assert.equal(tracker.mode, "worker");
});

test("naming a camera that is gone still finds the one that is there", async () => {
  const h = harness({ camera: "ranked" });
  const tracker = new HeadTracker();
  const opening = tracker.open(h.video, "ghost");
  await settle();
  h.finishModels();
  await opening;
  assert.equal(tracker.stream, h.stream);
  // The named camera is not asked for twice.
  assert.equal(h.env.asks.filter((ask) => ask?.deviceId?.exact === "ghost").length, 1);
});

test("cameras() lists video inputs as {deviceId, label}, numbered before permission", async () => {
  harness();
  navigator.mediaDevices.enumerateDevices = async () => [
    { kind: "videoinput", deviceId: "a", label: "" },
    { kind: "audioinput", deviceId: "m", label: "Mic" },
    { kind: "videoinput", deviceId: "b", label: "Desk cam" },
  ];
  const cameras = await new HeadTracker().cameras();
  assert.deepEqual(cameras.map(({ deviceId, label }) => ({ deviceId, label })), [
    { deviceId: "a", label: "Camera 1" },
    { deviceId: "b", label: "Desk cam" },
  ]);
  navigator.mediaDevices.enumerateDevices = async () => { throw new Error("nope"); };
  assert.deepEqual(await HeadTracker.cameras(), []);
});

// -- the light goes off ---------------------------------------------------------------

test("stop() turns the light off, ends the worker's reading and drops what is in flight", async () => {
  const { h, tracker, readings } = await running();
  const frames = h.processor.frames;
  tracker.stop();
  await settle();

  assert.equal(h.lightOn(), false);
  assert.equal(tracker.running, false);
  assert.equal(tracker.stream, null);
  assert.ok(h.worker.posted.some((m) => m.type === "stop"));
  assert.equal(frames.reader.cancelled, true, "the worker kept reading a stopped camera");
  const frame = fakeFrame(9_000_000);
  frames.push(frame);
  await settle();
  assert.equal(frame.closed, false, "a retired pump was still reading");
  assert.equal(readings.length, 0);
});

test("stop() in frames mode also lets go of the element and the frame loop", async () => {
  const { h, tracker } = await running({ processor: false });
  tracker.stop();
  assert.equal(h.lightOn(), false);
  assert.equal(h.video.srcObject, null);
  h.video.fire();
  await settle();
  assert.equal(h.env.bitmaps.length, 0, "the frame loop outlived its session");
  assert.equal(h.video.fire(), 0, "the retired chain rescheduled itself");
});

// -- a camera that goes away ---------------------------------------------------------------

/* A fatal report: the tracker had already stopped and released the camera. */
const assertFatal = (errors, notes, pattern) => {
  assert.equal(errors.length, 1, `expected one report, got ${errors.map((e) => e.message).join(" | ")}`);
  assert.match(errors[0].message, pattern);
  assert.equal(errors[0].fatal, true);
  assert.equal(notes[0].fatal, true);
  assert.equal(notes[0].running, false, "the listener heard before the tracker stopped");
  assert.equal(notes[0].stream, null, "the listener heard before the camera was let go");
};

test("a camera unplugged mid-session stops the tracker and says so, once, as fatal", async () => {
  const { h, tracker, errors, notes } = await running();
  const worker = h.worker;
  h.stream.getVideoTracks()[0].unplug();
  await settle();

  assertFatal(errors, notes, /camera stopped/i);
  assert.equal(tracker.running, false);
  assert.equal(tracker.stream, null);
  assert.ok(worker.posted.some((m) => m.type === "stop"));
});

test("a frame stream that closes under a live run is reported by the worker, as fatal", async () => {
  const { h, tracker, errors, notes } = await running();
  const run = tracker.runId;
  h.stream.getVideoTracks()[0].unplug({ event: false });
  await settle();

  assert.ok(h.worker.sent.some((m) => m.type === "ended" && m.run === run), "the worker kept quiet");
  assertFatal(errors, notes, /camera stopped/i);
  assert.equal(tracker.running, false);
});

test("a camera unplugged in frames mode stops the tracker as well", async () => {
  const { h, tracker, errors, notes } = await running({ processor: false });
  assert.equal(tracker.mode, "frames");
  h.stream.getVideoTracks()[0].unplug();
  await settle();

  assertFatal(errors, notes, /camera stopped/i);
  assert.equal(tracker.running, false);
  assert.equal(h.video.srcObject, null);
});

test("stop() is not a camera going away: nothing is reported", async () => {
  const { h, tracker, errors } = await running();
  const track = h.stream.getVideoTracks()[0];
  tracker.stop();
  await settle();
  assert.equal(track.listening, 0, "the stopped session still listens to its track");
  assert.ok(!h.worker.sent.some((m) => m.type === "ended" && m.run === tracker.runId));
  assert.equal(errors.length, 0);
});

test("after a crash only the live clone is watched, and its end is fatal", async () => {
  const { h, tracker, errors, notes } = await running();
  const old = h.processor.track;
  h.worker.crash();
  await settle();
  assert.equal(errors.length, 1);
  assert.notEqual(tracker.error && tracker.error.fatal, true, "a recovered crash is not fatal");
  assert.equal(notes[0].fatal, false);
  assert.equal(old.listening, 0, "the cloned-away track is still watched");
  assert.equal(tracker.running, true);

  h.processor.track.unplug();
  await settle();
  assert.equal(errors.length, 2);
  assert.match(errors[1].message, /camera stopped/i);
  assert.equal(notes[1].fatal, true);
  assert.equal(notes[1].running, false);
});

test("a stream-mode camera that never delivers a picture is given up on", async () => {
  const { tracker, errors, notes } = await running({}, { pictureTimeout: 40 });
  assert.equal(tracker.mode, "worker");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assertFatal(errors, notes, /never delivered a picture/);
  assert.equal(tracker.running, false);
});

test("a stream-mode camera that delivers is not given up on", async () => {
  const { h, tracker, errors, readings } = await running({}, { pictureTimeout: 40 });
  h.processor.frames.push(fakeFrame(1_000_000));
  await settle();
  assert.equal(readings.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(errors.length, 0);
  assert.equal(tracker.running, true);
  tracker.stop();
});

// -- a retired ask asks nothing more ---------------------------------------------------------

const notReadable = () => Object.assign(new Error("Could not start video source"), { name: "NotReadableError" });

test("a stop while a busy camera is being asked for asks no other camera", async () => {
  const h = harness();
  const asks = [];
  const first = held();
  navigator.mediaDevices.getUserMedia = async ({ video }) => {
    asks.push(video);
    if (asks.length === 1) {
      await first.promise;
      throw notReadable();
    }
    return { getTracks: () => [], getVideoTracks: () => [] };
  };
  const tracker = new HeadTracker({ permissionGrace: 1e9 });
  const opening = tracker.open(h.video, "busy");
  await settle();
  tracker.stop();
  first.release();
  await assert.rejects(opening, /let go/);
  assert.equal(asks.length, 1, `a retired open went on to ask for ${JSON.stringify(asks.slice(1))}`);
});

test("a stop during the walk over every camera ends the walk", async () => {
  const h = harness();
  const asks = [];
  const ghost = held();
  navigator.mediaDevices.getUserMedia = async ({ video }) => {
    asks.push(video);
    if (video?.deviceId?.exact === "ghost") await ghost.promise;
    throw notReadable();
  };
  const tracker = new HeadTracker({ permissionGrace: 1e9 });
  const opening = tracker.open(h.video);
  await settle();
  assert.deepEqual(asks.at(-1).deviceId, { exact: "ghost" }, "the walk over named cameras never began");
  tracker.stop();
  ghost.release();
  await assert.rejects(opening, /let go/);
  assert.ok(!asks.some((ask) => ask?.deviceId?.exact === "real"), "a retired walk asked for the next camera");
});

// -- a worker that dies -----------------------------------------------------------------

test("a worker that crashes mid-session is restarted once and the session carries on", async () => {
  const { h, tracker, readings, errors } = await running();
  const dead = h.worker;
  const oldTrack = h.processor.track;
  const runBefore = tracker.runId;
  dead.crash();
  await settle();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /worker stopped.*memory access/);
  assert.equal(dead.terminated, true);
  assert.equal(h.env.workers.length, 2, "the worker was not restarted");
  const fresh = h.worker;
  assert.equal(tracker.worker, fresh);
  assert.equal(tracker.mode, "worker");
  const stream = fresh.posted.find((m) => m.type === "stream");
  assert.ok(stream, "the restarted worker was never given the camera");
  assert.ok(stream.run > runBefore);
  assert.equal(stream.run, tracker.runId);
  assert.equal(oldTrack.stopped, true, "the dead worker's processor was left attached");
  assert.notEqual(h.processor.track, oldTrack);
  assert.equal(h.lightOn(), true, "the restart turned the camera off");
  assert.equal(tracker.running, true);

  h.processor.frames.push(fakeFrame(1_000_000));
  await settle();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].run, tracker.runId);

  tracker.stop();
  assert.equal(h.lightOn(), false, "the cloned track survived stop()");
});

test("a second crash falls back to the in-page engine", async () => {
  const { h, tracker, readings, errors } = await running();
  h.worker.crash();
  await settle();
  h.worker.crash("again");
  await settle();

  assert.equal(h.env.workers.length, 2, "the worker was restarted more than once");
  assert.equal(errors.length, 2);
  assert.equal(tracker.mode, "inline");
  assert.equal(tracker.worker, null);
  assert.ok(tracker.engine && tracker.engine.loaded);
  assert.equal(tracker.engine.resets, 1);
  assert.equal(h.video.srcObject, h.stream);
  assert.equal(h.lightOn(), true);

  h.video.fire();
  await settle();
  assert.equal(readings.length, 1);
  assert.equal(readings[0].run, tracker.runId);
  tracker.stop();
  assert.equal(h.lightOn(), false);
});

test("a restart whose worker will not load falls back to the in-page engine", async () => {
  const { h, tracker, readings } = await running();
  globalThis.__trackerStub.engineLoad = (engine) => (engine.options.models.startsWith("https://")
    ? Promise.reject(new Error("GPU lost"))
    : Promise.resolve());
  h.worker.crash();
  await settle();

  assert.equal(h.env.workers.length, 2);
  assert.equal(h.worker.terminated, true);
  assert.equal(tracker.mode, "inline");
  h.video.fire();
  await settle();
  assert.equal(readings.length, 1);
});

test("when nothing can be restarted the camera is let go and the listener told", async () => {
  const { h, tracker, errors } = await running();
  globalThis.__trackerStub.engineLoad = () => Promise.reject(new Error("CDN gone"));
  h.worker.crash();
  await settle();

  assert.equal(errors.length, 2);
  assert.match(errors[1].message, /could not be restarted.*CDN gone/);
  assert.equal(tracker.running, false);
  assert.equal(h.lightOn(), false);
  assert.equal(tracker.error, errors[1]);
});

test("a recovery that gives up has let the camera go before the fatal report", async () => {
  const { h, errors, notes } = await running();
  globalThis.__trackerStub.engineLoad = () => Promise.reject(new Error("CDN gone"));
  h.worker.crash();
  await settle();

  assert.equal(notes[0].fatal, false, "the crash itself is being recovered");
  assert.match(errors[1].message, /could not be restarted/);
  assert.equal(errors[1].fatal, true);
  assert.deepEqual([notes[1].fatal, notes[1].running, notes[1].stream], [true, false, null]);
});

test("a recovery with no session open that fails is not fatal", async () => {
  const h = harness();
  const notes = [];
  const tracker = new HeadTracker({ onError: (e, info) => notes.push(info) });
  const loading = tracker.load();
  h.finishModels();
  await loading;
  globalThis.__trackerStub.engineLoad = () => Promise.reject(new Error("CDN gone"));
  h.worker.crash();
  await settle();
  assert.deepEqual(notes.map((n) => n.fatal), [false, false]);
  assert.equal(tracker.running, false);
});

test("a rewire that fails after a crash stops the tracker and reports it as fatal", async () => {
  const { h, tracker, errors, notes } = await running({ processor: false });
  h.video.videoWidth = 0;
  h.video.play = async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); };
  h.worker.crash();
  // attachVideo polls every 100 ms for the failed play().
  for (let i = 0; i < 40 && errors.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(errors.length, 2);
  assert.match(errors[1].message, /would not play/);
  assert.deepEqual([notes[1].fatal, notes[1].running, notes[1].stream], [true, false, null]);
  assert.equal(tracker.running, false);
  assert.equal(h.lightOn(), false);
});

test("a crash with no session open restarts quietly, and the next open uses it", async () => {
  const h = harness();
  const errors = [];
  const tracker = new HeadTracker({ onError: (e) => errors.push(e) });
  const loading = tracker.load();
  h.finishModels();
  await loading;
  h.worker.crash();
  await settle();

  assert.equal(errors.length, 1);
  assert.equal(h.env.workers.length, 2);
  assert.ok(!h.worker.posted.some((m) => m.type === "stream"));
  await tracker.open(h.video);
  assert.equal(tracker.mode, "worker");
  assert.equal(h.worker.posted.filter((m) => m.type === "stream").length, 1);
});

test("a crash while the camera prompt is up wires the camera once, to the new worker", async () => {
  const h = harness({ camera: "pending" });
  const tracker = new HeadTracker({ permissionGrace: 1e9, onError: () => {} });
  const loading = tracker.load();
  h.finishModels();
  await loading;
  const opening = tracker.open(h.video);
  await settle();
  const dead = h.worker;
  dead.crash();
  h.answerCamera();
  await opening;
  await settle();

  assert.equal(h.env.workers.length, 2);
  assert.ok(!dead.posted.some((m) => m.type === "stream"));
  assert.equal(h.worker.posted.filter((m) => m.type === "stream").length, 1);
  assert.equal(tracker.mode, "worker");
});

test("a message the page cannot read counts as a crash", async () => {
  const { h, errors } = await running();
  h.worker.onmessageerror({});
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(h.env.workers.length, 2);
});

test("a worker that dies while loading is not a crash: the engine moves in-page", async () => {
  const h = harness();
  const errors = [];
  const tracker = new HeadTracker({ onError: (e) => errors.push(e) });
  const loading = tracker.load();
  await settle();
  h.worker.crash("import failed");
  h.finishModels();
  await loading;

  assert.equal(tracker.mode, "inline");
  assert.equal(errors.length, 0);
  assert.equal(h.env.workers.length, 1);
});

// -- the worker's own side --------------------------------------------------------------

/* The worker script alone, with a clock the test drives. */
function workerHarness() {
  globalThis.__trackerStub = stub();
  const sent = [];
  const clock = { now: 1000 };
  const scope = workerScope((message) => sent.push(message),
    { timeOrigin: 0, now: () => clock.now });
  return { sent, clock, send: (data) => scope.onmessage({ data }) };
}

async function loadedWorker() {
  const w = workerHarness();
  w.send({ type: "load", models: "https://lazyvr.test/models" });
  await settle();
  assert.deepEqual(plain(w.sent.map((m) => m.type)), ["loaded"]);
  w.sent.length = 0;
  w.engine = globalThis.__trackerStub.engines[0];
  return w;
}

test("worker: load reports loaded, and a failing engine is closed and reported", async () => {
  const w = workerHarness();
  globalThis.__trackerStub.engineLoad = () => Promise.reject(new Error("wasm 404"));
  w.send({ type: "load", models: "x" });
  await settle();
  assert.deepEqual(plain(w.sent), [{ type: "loadfailed", message: "wasm 404" }]);
  assert.equal(globalThis.__trackerStub.engines[0].closed, true);

  globalThis.__trackerStub.engineLoad = () => Promise.resolve();
  w.send({ type: "load", models: "x" });
  await settle();
  assert.equal(w.sent.at(-1).type, "loaded");
});

test("worker: a second camera's frames are not cancelled by the first pump unwinding", async () => {
  const w = await loadedWorker();
  const first = fakeFrames();
  const second = fakeFrames();
  w.send({ type: "stream", stream: first.readable, run: 1 });
  w.send({ type: "stream", stream: second.readable, run: 2 });
  await settle();

  assert.equal(first.reader.cancelled, true, "the retired pump kept its reader");
  assert.equal(second.reader.cancelled, false, "the old pump cancelled the new pump's reader");
  const frame = fakeFrame(1_000_000);
  second.push(frame);
  await settle();
  assert.equal(frame.closed, true, "the second camera's frames were never read");
  assert.equal(w.sent.at(-1).run, 2);
  assert.equal(w.sent.at(-1).reading.run, 2);
  assert.equal(w.engine.resets, 2);
});

test("worker: a stop lets go of the reader and the frames stop being read", async () => {
  const w = await loadedWorker();
  const frames = fakeFrames();
  w.send({ type: "stream", stream: frames.readable, run: 1 });
  await settle();
  w.send({ type: "stop" });
  await settle();
  assert.equal(frames.reader.cancelled, true);

  const frame = fakeFrame(1_000_000);
  frames.push(frame);
  await settle();
  assert.equal(frame.closed, false, "a retired pump was still reading");
  assert.deepEqual(w.sent, []);
});

test("worker: the run is checked again after the engine's await", async () => {
  const w = await loadedWorker();
  const slow = held();
  globalThis.__trackerStub.process = (engine, image, width, height, atMs) => slow.promise.then(() => reading(atMs));
  const frames = fakeFrames();
  w.send({ type: "stream", stream: frames.readable, run: 1 });
  const frame = fakeFrame(1_000_000);
  frames.push(frame);
  await settle();
  assert.equal(w.engine.calls.length, 1);

  w.send({ type: "stop" });
  slow.release();
  await settle();
  assert.deepEqual(w.sent, [], "a stopped run posted a reading");
  assert.equal(frame.closed, true);
});

test("worker: frames carry their run; stale ones are closed and still answered", async () => {
  const w = await loadedWorker();
  w.send({ type: "session", run: 3 });
  assert.equal(w.engine.resets, 1);

  const stale = { width: 640, height: 360, closed: false, close() { this.closed = true; } };
  await w.send({ type: "frame", image: stale, atMs: 1, run: 2 });
  assert.equal(stale.closed, true);
  assert.equal(w.engine.calls.length, 0, "a stale frame was processed");
  assert.deepEqual(plain(w.sent), [{ type: "ready", run: 2 }]);

  const live = { width: 640, height: 360, closed: false, close() { this.closed = true; } };
  await w.send({ type: "frame", image: live, atMs: 1234, run: 3 });
  assert.equal(live.closed, true);
  assert.equal(w.engine.calls[0].atMs, 1234);
  assert.deepEqual(plain(w.sent.slice(1).map((m) => [m.type, m.run])), [["reading", 3], ["ready", 3]]);
});

test("worker: VideoFrame timestamps map onto the absolute clock, never ahead of it", async () => {
  const w = await loadedWorker();
  const frames = fakeFrames();
  w.send({ type: "stream", stream: frames.readable, run: 1 });
  const at = [];
  const feed = async (now, timestamp) => {
    w.clock.now = now;
    frames.push(fakeFrame(timestamp));
    await settle(4);
    at.push(w.engine.calls.at(-1).atMs);
  };

  await feed(1000, 5_000_000);          // anchor: 5000 ms on the camera = 1000 now
  assert.equal(at[0], 1000);
  await feed(1045, 5_033_000);          // delivered late: keeps the camera spacing
  assert.equal(at[1], 1033);
  await feed(1060, 5_066_000);          // delivered faster than the anchor: re-anchors earlier
  assert.equal(at[2], 1060);
  assert.ok(at[2] > at[1]);
  await feed(1100, 5_099_000);
  assert.equal(at[3], 1093);
  await feed(1140, 20_000);             // the camera clock restarted
  assert.equal(at[4], 1140);
  await feed(1180, 53_000);
  assert.equal(at[5], 1173);
  await feed(3000, 86_000);             // stalled for seconds: re-anchor, never in the past by seconds
  assert.equal(at[6], 3000);
  await feed(3050, undefined);          // no timestamp at all
  assert.equal(at[7], 3050);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `time went backwards at ${i}`);

  // A new session forgets the old anchor.
  w.send({ type: "stream", stream: frames.readable, run: 2 });
  const next = fakeFrames();
  w.send({ type: "stream", stream: next.readable, run: 3 });
  w.clock.now = 4000;
  next.push(fakeFrame(119_000));  // the old anchor would place this at 3033
  await settle(4);
  assert.equal(w.engine.calls.at(-1).atMs, 4000);
});

test("worker: a frame that arrives while one is processing is dropped, not queued", async () => {
  const w = await loadedWorker();
  const slow = held();
  globalThis.__trackerStub.process = (engine, image, width, height, atMs) => slow.promise.then(() => reading(atMs));
  w.send({ type: "session", run: 1 });
  const a = { width: 1, height: 1, close() { this.closed = true; } };
  const b = { width: 1, height: 1, close() { this.closed = true; } };
  const first = w.send({ type: "frame", image: a, atMs: 1, run: 1 });
  await w.send({ type: "frame", image: b, atMs: 2, run: 1 });
  assert.equal(b.closed, true);
  assert.equal(w.engine.calls.length, 1);
  slow.release();
  await first;
  assert.deepEqual(plain(w.sent.map((m) => m.type)), ["ready", "reading", "ready"]);
});

test("a listener that reopens on a crash waits for the recovery", async () => {
  const h = harness();
  let reopening = null;
  const tracker = new HeadTracker({
    onError: () => { reopening = tracker.open(h.video); },
  });
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await opening;
  h.worker.crash();
  await reopening;
  await settle();

  assert.equal(tracker.mode, "worker");
  assert.equal(tracker.running, true);
  assert.equal(h.worker.posted.filter((m) => m.type === "stream").length, 1);
});
