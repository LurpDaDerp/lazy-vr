/* Where the camera's frames end up.
 *
 * The pipeline itself never runs here: gaze-core.js imports MediaPipe and
 * onnxruntime straight off a CDN, which node cannot resolve, so that module
 * is answered with a stub before it is ever asked for.  What is under test
 * is the wiring around it -- which transport open() picks, and whether the
 * thing it picks is there yet.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const STUB = "stub:gaze-core";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("gaze-core.js")) return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== STUB) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export class GazeEngine {
          constructor(options) {
            this.options = options;
            this.loaded = false;
            globalThis.__gazeStub.engines.push(this);
          }
          async load() {
            await globalThis.__gazeStub.engineLoad;
            this.loaded = true;
          }
          async process() { return null; }
        }`,
    };
  },
});

globalThis.__gazeStub = { engines: [], engineLoad: Promise.resolve() };

const { GazeTracker } = await import("../../site/js/gaze.js");

/* Enough turns of the microtask and timer queues for every settled promise
 * in the tracker to have run its continuations. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

const held = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};

function fakeVideo() {
  return {
    srcObject: null, muted: false, playsInline: false,
    videoWidth: 1280, videoHeight: 720, currentTime: 0,
    play: async () => {},
    addEventListener() {},
  };
}

/* The page's side of the world: a camera that answers at once, a worker
 * whose models arrive only when the test says so, and the frame-stream
 * transport the best path needs. */
function harness({ worker = true, processor = true } = {}) {
  const posted = [];
  const load = held();
  const track = { stopped: false, stop() { this.stopped = true; } };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  let instance = null;

  globalThis.__gazeStub = { engines: [], engineLoad: Promise.resolve() };

  if (worker) {
    globalThis.Worker = class {
      constructor(url) { this.url = url; instance = this; }
      postMessage(message) {
        posted.push(message);
        if (message.type === "load") {
          load.promise.then((ok) => this.onmessage({ data: { type: ok ? "loaded" : "loadfailed" } }));
        }
      }
      terminate() { this.terminated = true; }
    };
  } else {
    delete globalThis.Worker;
  }

  if (processor) {
    globalThis.MediaStreamTrackProcessor = class {
      constructor({ track: t }) { this.readable = { track: t }; }
    };
  } else {
    delete globalThis.MediaStreamTrackProcessor;
  }

  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => stream } },
    configurable: true, writable: true,
  });

  // The page's two globals the tracker reads: the models folder is named
  // against the document's URL, and the http/https question decides which
  // "no camera here" it would have thrown.
  globalThis.location = { href: "https://lazyvr.test/", host: "lazyvr.test" };
  globalThis.window = { isSecureContext: true };
  globalThis.requestAnimationFrame = () => 0;

  return {
    posted, stream, track, video: fakeVideo(),
    finishModels: () => load.release(true),
    failModels: () => load.release(false),
    get worker() { return instance; },
  };
}

// -- the transport is chosen against a pipeline that exists ---------------

test("a camera that opens while the models load still hands the frames over", async () => {
  // The camera is the fast one: granted on an earlier visit it answers in
  // milliseconds, well inside the seconds the models take.  Deciding the
  // transport on what load() had got to at that moment sent the frames
  // nowhere, and the readings -- and the calibration bar with them -- never
  // started.
  const h = harness();
  const tracker = new GazeTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.mode, "worker");
  assert.ok(h.posted.some((m) => m.type === "stream"), "the frame stream never reached the worker");
  assert.equal(h.video.srcObject, null, "the page took frames the worker was going to read");
});

test("the worker takes the frames when the models are already in", async () => {
  const h = harness();
  const tracker = new GazeTracker();
  const loading = tracker.load();
  h.finishModels();
  await loading;
  await tracker.open(h.video);

  assert.equal(tracker.mode, "worker");
  assert.ok(h.posted.some((m) => m.type === "stream"));
});

test("without a frame stream the page carries them, still to the worker", async () => {
  const h = harness({ processor: false });
  const tracker = new GazeTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.mode, "frames");
  assert.equal(h.video.srcObject, h.stream);
  assert.ok(!h.posted.some((m) => m.type === "stream"));
});

test("with no worker at all the camera waits for the in-process pipeline", async () => {
  const h = harness({ worker: false });
  const engine = held();
  globalThis.__gazeStub.engineLoad = engine.promise;
  const tracker = new GazeTracker();

  let readyWhenOpened = null;
  const loading = tracker.load();
  const opening = tracker.open(h.video).then(() => {
    readyWhenOpened = Boolean(tracker.engine && tracker.engine.loaded);
  });
  await settle();
  engine.release();
  await Promise.all([loading, opening]);

  assert.equal(tracker.mode, "inline");
  assert.equal(readyWhenOpened, true, "the camera opened onto a half-loaded pipeline");
});

test("start() says so rather than going quiet when there is nothing to run", async () => {
  // A silent return here is what a stuck calibration bar looks like from
  // the page: frames arriving, nothing processing them, no error anywhere.
  const h = harness({ worker: false });
  const tracker = new GazeTracker();
  tracker.video = h.video;
  tracker.mode = "inline";
  tracker.start();

  assert.equal(tracker.running, false);
  assert.match(String(tracker.error), /pipeline/i);
});

// -- one load, however many callers --------------------------------------

test("load() is asked once however many times it is called", async () => {
  const h = harness();
  const tracker = new GazeTracker();
  const first = tracker.load();
  const second = tracker.load();
  h.finishModels();
  await Promise.all([first, second]);

  assert.equal(h.posted.filter((m) => m.type === "load").length, 1);
});

test("a load that failed can be asked again", async () => {
  const h = harness({ worker: false });
  const engine = held();
  globalThis.__gazeStub.engineLoad = engine.promise.then(() => { throw new Error("no models"); });
  const tracker = new GazeTracker();
  const first = tracker.load();
  engine.release();
  await assert.rejects(first, /no models/);

  globalThis.__gazeStub.engineLoad = Promise.resolve();
  await tracker.load();
  assert.ok(tracker.engine.loaded);
});
