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
import vm from "node:vm";
import { readFile } from "node:fs/promises";
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
    removeEventListener() {},
  };
}

/* The worker's own side, run for real.  gaze-worker.js is a classic worker
 * script, not a module, so it is read and evaluated in a context holding the
 * three globals it uses -- and never told to "load", which is the one branch
 * that reaches for the CDN. */
async function workerHarness() {
  const source = await readFile(new URL("../../site/js/gaze-worker.js", import.meta.url), "utf8");
  const sent = [];
  const scope = {};
  const sandbox = {
    self: scope,
    postMessage: (message) => sent.push(message),
    performance: { timeOrigin: 0, now: () => Date.now() },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sent, send: (data) => scope.onmessage({ data }) };
}

/* A frame stream the test hands frames to, and whose reader remembers being
 * cancelled -- which is the whole question here. */
function fakeFrames() {
  let waiting = null;
  const queued = [];
  const reader = {
    cancelled: false,
    read() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => { waiting = resolve; });
    },
    cancel() {
      reader.cancelled = true;
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
  };
}

function fakeFrame() {
  return { displayWidth: 640, displayHeight: 480, closed: false, close() { this.closed = true; } };
}

/* The page's side of the world: a camera that answers at once, a worker
 * whose models arrive only when the test says so, and the frame-stream
 * transport the best path needs. */
function harness({ worker = true, processor = true, camera = "open" } = {}) {
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
          // The real worker reports each stage as it reaches it.
          Promise.resolve().then(() => this.onmessage({ data: { type: "status", text: "Loading the face model…" } }));
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

  // A camera that answers at once, or one the browser never answers for:
  // an unshown permission prompt leaves getUserMedia pending for as long as
  // the page is open, and that is the case worth having a test for.
  const asked = held();
  // Two cameras, and the one the browser reaches for first is a stale entry
  // for a webcam that is no longer plugged in.
  const devices = [
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
          if (camera === "pending") return asked.promise;
          // A webcam whose driver will not start the shape asked for, but
          // which opens perfectly well when nothing in particular is asked.
          if (camera === "fussy" && video !== true) throw wontStart();
          // A browser whose own first choice is the camera that is not there:
          // only naming the working one by id gets a picture.
          if (camera === "ranked" && video?.deviceId?.exact !== "real") throw wontStart();
          return stream;
        },
      },
    },
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
    answerCamera: () => asked.release(stream),
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

// -- a wait the page can read --------------------------------------------

test("a prompt the browser never shows says so rather than waiting in silence", async () => {
  // getUserMedia has no timeout of its own, and a prompt the browser
  // decides not to put on screen -- chrome's quiet permission UI, one
  // deferred until the tab is looked at -- leaves it pending for as long as
  // the page is open.  The page sat on "Waiting for the camera…" forever,
  // with no error, nothing to click and nothing to read.
  const h = harness({ camera: "pending" });
  const said = [];
  const tracker = new GazeTracker({ onStatus: (text) => said.push(text), permissionGrace: 5 });
  const opening = tracker.open(h.video);
  await settle();

  assert.match(said.at(-1), /allow|permission/i, `the page was left on: ${said.at(-1)}`);

  // The ask is nudged, never abandoned: answering the prompt late still works.
  let opened = false;
  opening.then(() => { opened = true; });
  await settle();
  assert.equal(opened, false, "the camera ask was given up on");
  h.answerCamera();
  h.finishModels();
  await opening;
  assert.equal(tracker.mode, "worker");
});

test("once the camera is in, the wait is named for the stage the models are at", async () => {
  // Every stage the pipeline reports is reported while the shelves are up,
  // where the page shows none of them.  By the time the overlay is on
  // screen the load is mid-stage and silent, so the camera's own message
  // stood there as the answer to a question it had stopped being.
  const h = harness();
  const said = [];
  const tracker = new GazeTracker({ onStatus: (text) => said.push(text) });
  const loading = tracker.load();
  await settle();  // the shelves are up and the stage has been and gone
  assert.equal(said.at(-1), "Loading the face model…");

  const opening = tracker.open(h.video);
  await settle();

  assert.equal(said.at(-1), "Loading the face model…",
    `the page was left on: ${said.at(-1)}`);

  h.finishModels();
  await Promise.all([loading, opening]);
  assert.equal(said.at(-1), "Camera running");
});

// -- a camera let go of before it arrives --------------------------------

test("a stop while the ask is still out releases the camera when it arrives", async () => {
  // getUserMedia cannot be cancelled.  Escape, or the overlay's way back,
  // calls stop() -- which finds this.stream still null and has nothing to
  // stop -- and then the ask resolves onto a tracker nobody is watching.
  // The track stays live: the camera light stays on with no session behind
  // it, and the next ask finds the device held and fails with AbortError.
  const h = harness({ camera: "pending" });
  const tracker = new GazeTracker({ permissionGrace: 1e9 });
  const opening = tracker.open(h.video).catch((error) => error);

  await settle();
  tracker.stop();          // the viewer pressed Escape while the prompt sat there
  h.answerCamera();        // ...and the prompt was answered afterwards
  h.finishModels();
  await opening;

  assert.equal(h.track.stopped, true, "the camera was left running with nobody holding it");
  assert.equal(tracker.stream, null, "an abandoned stream was kept");
  assert.equal(tracker.running, false);
});

test("a second ask retires the first rather than leaving two cameras open", async () => {
  const h = harness({ camera: "pending" });
  const tracker = new GazeTracker({ permissionGrace: 1e9 });
  const first = tracker.open(h.video).catch((error) => error);
  const second = tracker.open(h.video).catch((error) => error);

  await settle();
  h.answerCamera();
  h.finishModels();
  await Promise.all([first, second]);

  assert.equal(tracker.mode, "worker");
  assert.equal(h.posted.filter((m) => m.type === "stream").length, 1,
    "both asks wired their frames to the worker");
});

// -- a camera that will not start the shape it was asked for --------------

test("a driver that will not start the asked-for shape is asked again for any shape", async () => {
  // Chrome answers "AbortError: Could not start video source" when the
  // device is there and permitted but the mode it was asked for will not
  // start.  A plain ask usually does, and the alternative was to tell the
  // viewer the camera could not be opened when it could.
  const h = harness({ camera: "fussy" });
  const tracker = new GazeTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.mode, "worker");
  assert.equal(tracker.stream, h.stream);
});

test("a camera that will not start at all says so in words", async () => {
  const h = harness({ camera: "fussy" });
  // ...even for the plain ask.
  navigator.mediaDevices.getUserMedia = async () => {
    const failed = new Error("Could not start video source");
    failed.name = "AbortError";
    throw failed;
  };
  const tracker = new GazeTracker();
  // Not "(AbortError)": a name the viewer cannot act on is not an answer.
  await assert.rejects(tracker.open(h.video), /would start.*close|close.*would start/is);
});

// -- the browser's own first choice is not there --------------------------

test("a browser that reaches for a camera that is gone is told to try the others", async () => {
  // Chrome keeps a ranking of cameras and hands an unqualified ask its
  // first choice, and that ranking can still name a webcam long since
  // unplugged: the device opens, fails to start, and the ask comes back
  // AbortError with a working camera sitting behind it in the list.
  const h = harness({ camera: "ranked" });
  const tracker = new GazeTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video);
  await settle();
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.stream, h.stream);
  assert.equal(tracker.mode, "worker");
});

test("naming a camera that is gone still finds the one that is there", async () => {
  const h = harness({ camera: "ranked" });
  const tracker = new GazeTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video, "ghost");
  await settle();
  h.finishModels();
  await Promise.all([loading, opening]);

  assert.equal(tracker.stream, h.stream);
});

// -- a camera let go of on the very last stretch ---------------------------

test("a stop while the element is still finding its size lets go rather than claiming success", async () => {
  // The page carries the frames, so open() waits for the element to reach
  // loadedmetadata.  A stop landing in there has already stopped the track,
  // and a stopped track never reaches it: the await held open() for the life
  // of the page, and the one time it did come back it said "Camera running"
  // for a session with no camera -- which the page believes, marks open, and
  // never asks about again.
  const h = harness({ processor: false });
  h.video.videoWidth = 0;
  const tracker = new GazeTracker();
  const loading = tracker.load();
  const opening = tracker.open(h.video).then(() => "opened", (error) => error.message);
  await settle();
  h.finishModels();
  await loading;
  await settle();

  tracker.stop();
  const outcome = await Promise.race([
    opening,
    new Promise((resolve) => setTimeout(() => resolve("hung"), 800)),
  ]);
  assert.match(String(outcome), /let go of/,
    outcome === "hung" ? "open() never came back" : `open() said: ${outcome}`);
});

// -- models that never arrive ---------------------------------------------

test("models that never arrive say where they are coming from", async () => {
  // gaze-core.js imports MediaPipe and onnxruntime off jsDelivr, and an
  // import that a filter or a blocker stalls never settles and never
  // rejects.  The overlay sat on the loading line with nothing to read.
  const h = harness();
  const said = [];
  const tracker = new GazeTracker({ onStatus: (text) => said.push(text), modelGrace: 1 });
  const opening = tracker.open(h.video);
  await settle();

  assert.match(said.at(-1), /cdn|jsdelivr|blocker/i, `the page was left on: ${said.at(-1)}`);

  // Named, not abandoned: a slow line that gets there is still a success.
  h.finishModels();
  await opening;
  assert.equal(said.at(-1), "Camera running");
});

// -- one slot, two askers -------------------------------------------------

test("a second self-test retires the first rather than stranding it", async () => {
  const h = harness();
  const tracker = new GazeTracker();
  const loading = tracker.load();
  h.finishModels();
  await loading;

  const first = tracker.selfTest().then(() => "resolved", (error) => error.message);
  const second = tracker.selfTest();
  assert.match(await first, /took this one's place/);

  tracker.fromWorker({ type: "selftest", worst: 1e-6 });
  assert.equal(await second, 1e-6);
});

test("a self-test with no pipeline behind it says so", async () => {
  harness({ worker: false });
  const tracker = new GazeTracker();
  await assert.rejects(tracker.selfTest(), /not loaded/);
});

// -- the worker's own reader ----------------------------------------------

test("a second camera's frames are not cancelled by the first pump unwinding", async () => {
  // A pump is suspended in read(), or mid-inference, when its run is
  // retired, and the next camera can be open and pumping by the time it
  // resumes -- which is what a camera change in the settings panel and a
  // return from a hidden tab both do.  Releasing whatever the module-level
  // slot held by then cancelled the *new* reader, so the camera light came
  // on and not one reading ever came back.
  const w = await workerHarness();
  const first = fakeFrames();
  const second = fakeFrames();

  w.send({ type: "stream", stream: first.readable });
  w.send({ type: "stream", stream: second.readable });
  await settle();

  assert.equal(first.reader.cancelled, true, "the retired pump kept its reader");
  assert.equal(second.reader.cancelled, false, "the old pump cancelled the new pump's reader");

  const frame = fakeFrame();
  second.push(frame);
  await settle();
  assert.equal(frame.closed, true, "the second camera's frames were never read");
});

test("a stop lets go of the reader and the frames stop being read", async () => {
  const w = await workerHarness();
  const frames = fakeFrames();
  w.send({ type: "stream", stream: frames.readable });
  await settle();

  w.send({ type: "stop" });
  await settle();
  assert.equal(frames.reader.cancelled, true);

  // And the pump is really gone: a frame offered afterwards is left where it
  // is rather than read, so the retired run cannot go on posting readings
  // over the top of whatever session comes next.
  const frame = fakeFrame();
  frames.push(frame);
  await settle();
  assert.equal(frame.closed, false, "a retired pump was still reading");
  assert.deepEqual(w.sent, []);
});
