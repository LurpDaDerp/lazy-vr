/* The camera, and where the gaze pipeline runs.
 *
 * The pipeline itself lives in gaze-core.js and knows nothing about cameras
 * or pages.  This file owns the one thing that must happen on the page --
 * getUserMedia, which no worker can call -- and then gets the work as far
 * away from the render loop as the browser will allow.  Three ways, best
 * first:
 *
 *   worker  a MediaStreamTrackProcessor turns the camera track into a
 *           stream of frames and the *stream* is transferred, so the worker
 *           reads them and the page does nothing at all per frame -- while
 *           the track stays here, where stopping it still turns the camera
 *           light off.  That is the whole point: gaze inference is twenty
 *           to forty milliseconds of main-thread work at 30 Hz, and the
 *           view stuttered because the render loop queued behind it.
 *   frames  no MediaStreamTrackProcessor (Firefox, Safari): the page grabs
 *           one ImageBitmap at a time and hands it over.  The inference
 *           still happens in the worker; only the grab costs the page
 *           anything, and the worker answers every frame so exactly one is
 *           ever in flight.
 *   inline  no worker at all, or the worker would not load its models: the
 *           pipeline runs here, as it always did.
 *
 * The preview is gone, and with it the reason to think about mirroring on
 * this side at all: the detector sees the raw frame, which is what fixes the
 * sign.  The camera's +x is image right, which is where the viewer's own
 * left lands, so looking left gives atan2(x, z) > 0.
 */

import { GazeEngine } from "./gaze-core.js";

/* How long a camera ask may go unanswered before the page is told why it is
 * waiting.  getUserMedia has no timeout of its own: a prompt the browser
 * decides not to put on screen -- chrome's quiet permission UI after a few
 * dismissals, one deferred until the tab is looked at -- leaves the promise
 * pending for as long as the page is open.  Long enough that a granted
 * camera never trips it, short enough to beat the viewer's patience. */
const PERMISSION_GRACE_MS = 6000;

export class GazeTracker {
  /* `models`: URL of the folder with gaze_direct.onnx, the .task file, the
   * metadata and the permutation.  `onStatus(text)` reports loading stages,
   * `onReading(reading)` gets every frame, tracked or not. */
  constructor({ models = "models", onStatus = () => {}, onReading = () => {},
    permissionGrace = PERMISSION_GRACE_MS } = {}) {
    this.models = models.replace(/\/$/, "");
    this.onStatus = onStatus;
    this.permissionGrace = permissionGrace;
    // The pipeline's own last word, and whether it has said its last.  Both
    // are for open(): see the note there.
    this.loadStage = "";
    this.loaded = false;
    this.onReading = onReading;
    this.video = null;
    this.stream = null;
    this.running = false;
    this.rate = 0;
    this.error = null;
    this.worker = null;
    this.engine = null;
    this.mode = "inline";
    this.runId = 0;
    this._mirror = true;
    this.ready = null;
    this.pendingLoad = null;
    this.pendingTest = null;
  }

  /* The second extraction pass, which the page drops when a device is
   * struggling.  Wherever the pipeline is, the flag has to reach it -- and
   * the pipeline drops the pass on its own account too, so every reading
   * carries the truth back. */
  get mirror() {
    return this._mirror;
  }

  set mirror(value) {
    const want = Boolean(value);
    if (want === this._mirror) return;
    this._mirror = want;
    if (this.worker) this.worker.postMessage({ type: "mirror", value: want });
    if (this.engine) this.engine.mirror = want;
  }

  // -- loading ----------------------------------------------------------

  /* A stage the pipeline reached, passed on and remembered.  Every one of
   * them is reported while the shelves are up, where the page shows none of
   * them; open() is the one that needs to say it again. */
  pipelineStatus(text) {
    this.loadStage = text;
    this.onStatus(text);
  }

  /* The pipeline, loaded once.  Two callers want it finished -- the page,
   * which starts it as soon as the shelves are up, and open() below, which
   * cannot choose a transport until it knows where the pipeline ended up --
   * and the second must join the first rather than load a second copy.  A
   * load that failed is forgotten, so a retry is a fresh attempt. */
  load() {
    if (!this.ready) {
      this.ready = this.loadOnce().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async loadOnce() {
    if (await this.loadWorker()) { this.loaded = true; return; }
    this.mode = "inline";
    this.engine = new GazeEngine({ models: this.models, onStatus: (text) => this.pipelineStatus(text) });
    this.engine.mirror = this._mirror;
    await this.engine.load();
    this.loaded = true;
  }

  /* Build the worker and have it load the models.  Returns false for any
   * reason at all -- no Worker, no dynamic import there, a GPU delegate that
   * will not start -- and the caller falls back to loading in-process, so a
   * browser that cannot do this is slower but never broken.
   *
   * Classic, not module: MediaPipe's wasm loader needs importScripts, which
   * a module worker does not have. */
  async loadWorker() {
    if (typeof Worker === "undefined") return false;
    let worker;
    try {
      worker = new Worker(new URL("./gaze-worker.js", import.meta.url));
    } catch {
      return false;
    }
    const settled = new Promise((resolve) => { this.pendingLoad = resolve; });
    worker.onmessage = (event) => this.fromWorker(event.data);
    worker.onerror = () => {
      if (this.pendingLoad) { this.pendingLoad(false); this.pendingLoad = null; }
    };
    // The worker resolves URLs against its own location, one folder deeper
    // than the page; the models folder has to be named absolutely.
    worker.postMessage({ type: "load", models: new URL(this.models, location.href).href });
    if (!await settled) {
      worker.terminate();
      return false;
    }
    this.worker = worker;
    this.mode = "worker";
    return true;
  }

  fromWorker(data) {
    switch (data.type) {
      case "status":
        this.pipelineStatus(data.text);
        break;
      case "loaded":
      case "loadfailed":
        if (data.message) console.warn("LazyVR: the gaze worker would not start —", data.message);
        if (this.pendingLoad) { this.pendingLoad(data.type === "loaded"); this.pendingLoad = null; }
        break;
      case "reading":
        this._mirror = data.reading.mirror;
        this.rate = data.reading.rate;
        this.onReading(data.reading);
        break;
      case "ready":
        this.inflight = false;
        break;
      case "error":
        this.error = new Error(data.message);
        break;
      case "selftest":
        if (this.pendingTest) {
          if (data.message) this.pendingTest.reject(new Error(data.message));
          else this.pendingTest.resolve(data.worst);
          this.pendingTest = null;
        }
        break;
      default:
        break;
    }
  }

  /* Prove the graph reproduces the exporter's reference frames, wherever it
   * ended up running.  Returns the worst |dgaze|. */
  selfTest() {
    if (!this.worker) return this.engine.selfTest();
    return new Promise((resolve, reject) => {
      this.pendingTest = { resolve, reject };
      this.worker.postMessage({ type: "selftest" });
    });
  }

  // -- the camera ---------------------------------------------------------

  /* The cameras this device offers, for the settings panel.  Labels are
   * only handed out once a camera has been granted; before that the list
   * still says how many there are, numbered. */
  static async cameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
    return devices
      .filter((device) => device.kind === "videoinput")
      .map((device, index) => ({
        id: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }));
  }

  /* Ask for the front camera.  Throws with a readable message when it is
   * refused or absent.  `videoElement` carries the frames only on the paths
   * that need it; the worker prefers to hold the track itself. */
  async open(videoElement, deviceId = "") {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(window.isSecureContext
        ? "This browser is too old to open a camera."
        : `This page was opened over plain http (${location.host}), and browsers `
          + "only allow the camera on a secure page. Open this site's https "
          + "address instead.");
    }
    this.onStatus("Waiting for the camera…");
    // A chosen camera is asked for by id; otherwise whichever faces the
    // viewer.  An id that no longer exists (a webcam since unplugged) is
    // not an error worth stopping for: fall back to the default ask.
    const shape = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    const asks = deviceId
      ? [{ deviceId: { exact: deviceId }, ...shape }, { facingMode: "user", ...shape }]
      : [{ facingMode: "user", ...shape }];
    // An ask that goes unanswered is nudged, never abandoned: the prompt may
    // still be sitting behind an omnibox icon, and answering it late has to
    // keep working.  All that changes is that the page stops claiming to be
    // waiting on a camera when it is really waiting on a person.
    const nudge = setTimeout(() => {
      this.onStatus("Still waiting for permission to use the camera — look for the "
        + "camera icon at the right of the address bar and choose Allow.");
    }, this.permissionGrace);
    let error = null;
    try {
      for (const video of asks) {
        try {
          this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
          error = null;
          break;
        } catch (caught) {
          error = caught;
          if (caught && caught.name === "NotAllowedError") break;
        }
      }
    } finally {
      clearTimeout(nudge);
    }
    if (error) {
      const why = error && error.name;
      if (why === "NotAllowedError") throw new Error("Camera access was refused. Allow the camera for this site and reload.");
      if (why === "NotFoundError") throw new Error("No camera was found on this device.");
      if (why === "NotReadableError") throw new Error("The camera is in use by another app.");
      throw new Error(`The camera could not be opened (${why || error}).`);
    }
    this.video = videoElement;

    // Which of the three carries the frames depends on where the pipeline
    // ended up, and load() only settles that at the very end: the worker is
    // not adopted until its models are in.  The camera is much the faster
    // of the two -- granted on an earlier visit it answers in milliseconds,
    // well inside the seconds the models take -- so choosing here on what
    // load() happened to have reached would send the frames to a worker
    // that is not there yet, take the inline path instead, and then watch
    // load() move `mode` out from under it.  Nothing would process a frame
    // again, and the page would sit at a calibration bar that never moves.
    //
    // The ask still goes first: getUserMedia wants the click while it is
    // still warm, and waiting before it would spend that.  A load that
    // failed is the caller's to report; all that matters here is that it is
    // no longer in flight.

    // From here the wait belongs to the pipeline, so name the pipeline's
    // stage.  Its own statuses were all spent while the shelves were up,
    // where the page shows none of them, so by now "Waiting for the camera…"
    // is the answer to a question that has stopped being asked -- and where
    // the models are slow, or a CDN has gone quiet, that stale line is the
    // whole of what the viewer ever sees.
    if (!this.loaded) this.onStatus(this.loadStage || "Loading the gaze pipeline…");
    await this.load().catch(() => {});

    if (this.worker && typeof MediaStreamTrackProcessor !== "undefined") {
      const [track] = this.stream.getVideoTracks();
      try {
        // The stream of frames goes; the track stays.  Transferring the
        // track itself would work too, and would leave nothing on this side
        // able to switch the camera off.
        const frames = new MediaStreamTrackProcessor({ track }).readable;
        this.worker.postMessage({ type: "stream", stream: frames }, [frames]);
        this.mode = "worker";
        this.onStatus("Camera running");
        return;
      } catch { /* not available here after all; carry the frames over */ }
    }

    this.mode = this.worker ? "frames" : "inline";
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.videoWidth) resolve();
      else this.video.addEventListener("loadedmetadata", resolve, { once: true });
    });
    this.onStatus("Camera running");
  }

  start() {
    if (this.running) return;
    if (this.mode === "worker") {
      if (!this.stream) return;
      this.running = true;
      this.worker.postMessage({ type: "start" });
      return;
    }
    if (!this.video) return;
    // Frames with nowhere to go.  Silence here looks exactly like a healthy
    // tracker that cannot see a face -- a bar that never moves and no error
    // anywhere -- so it is worth saying.
    if (this.mode === "frames" ? !this.worker : !this.engine) {
      this.error = new Error("The gaze pipeline was not loaded before the camera started.");
      return;
    }
    this.running = true;
    this.busy = false;
    this.inflight = false;
    this.lastVideoTime = -1;
    // The token retires the previous session's tick chain.  Without it, a
    // stopped chain's still-pending frame callback sees `running` true
    // again after a restart and keeps rescheduling itself -- one extra
    // chain per stop/start cycle, forever, until a reload.
    const run = this.runId = this.runId + 1;
    const tick = () => {
      if (!this.running || this.runId !== run) return;
      this.schedule(tick);
      if (this.busy || this.inflight) return;
      if (this.video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = this.video.currentTime;
      this.busy = true;
      this.frame().catch((error) => { this.error = error; }).finally(() => { this.busy = false; });
    };
    this.schedule(tick);
  }

  schedule(tick) {
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  /* One frame, on whichever of the two page-driven paths is in force. */
  async frame() {
    const atMs = performance.timeOrigin + performance.now();
    if (this.mode === "frames") {
      const image = await createImageBitmap(this.video);
      // Answered with "ready", so exactly one frame is ever in flight and
      // the worker is never handed a backlog it can only throw away.
      this.inflight = true;
      this.worker.postMessage({ type: "frame", image, atMs }, [image]);
      return;
    }
    const reading = await this.engine.process(
      this.video, this.video.videoWidth, this.video.videoHeight, atMs);
    if (!reading) return;
    this._mirror = reading.mirror;
    this.rate = reading.rate;
    this.onReading(reading);
  }

  stop() {
    this.running = false;
    this.runId += 1;
    this.inflight = false;
    if (this.worker) this.worker.postMessage({ type: "stop" });
    // Stopping the track also ends the transferred frame stream, so the
    // worker's read loop finishes on its own.
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
  }
}
