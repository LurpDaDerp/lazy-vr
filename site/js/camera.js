/* The camera, and where head tracking runs.
 *
 * getUserMedia only exists on the page, so the camera is acquired here and the
 * frames are then moved as far from the render loop as the browser allows:
 *
 *   worker  MediaStreamTrackProcessor turns the track into a stream of frames
 *           and the *stream* is transferred to tracker-worker.js. The page does
 *           no per-frame work, and the track stays here so stop() still turns
 *           the camera light off.
 *   frames  no MediaStreamTrackProcessor (Firefox, Safari): the page grabs one
 *           downscaled ImageBitmap per video frame and posts it; the worker
 *           answers each with "ready", so exactly one is ever in flight.
 *   inline  no usable worker: TrackerEngine runs on the page.
 *
 * Every session (open) gets a run id. The worker tags readings with it and
 * re-checks it after each await; the page drops readings from any other run,
 * so a reading from a retired session can never steer the next one.
 *
 * onError(error, { fatal }): fatal means the tracker stopped itself (the camera
 * ended, never delivered a picture, or crash recovery gave up). By then running
 * is false and the camera is released; error.fatal is set as well. Anything
 * else (a worker crash being recovered, per-frame errors) is not fatal.
 */

/* An unanswered permission prompt leaves getUserMedia pending forever (chrome's
 * quiet permission UI, a prompt deferred until the tab is looked at). After
 * this long the status line says what it is really waiting for. */
const PERMISSION_GRACE_MS = 6000;
/* A stalled CDN import never settles or rejects; after this long, say where the
 * model comes from so a blocked network can be recognised. */
const MODEL_GRACE_MS = 10000;
/* Give up on a camera that is open but never produces a picture. */
const PICTURE_TIMEOUT_MS = 15000;
/* Frames mode posts at most this many pixels across; the face model works at
 * far less, and a smaller bitmap is cheaper to grab and to transfer. */
const FRAME_WIDTH = 640;
const SHAPE = Object.freeze({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });

const LET_GO = "The camera was let go of before it finished opening.";

/* The only failures where asking again (another shape, another device) helps:
 * the camera is present and permitted but would not start. */
const cannotStart = (error) => Boolean(error)
  && (error.name === "AbortError" || error.name === "NotReadableError");

const stopTracks = (stream) => {
  if (stream) for (const track of stream.getTracks()) track.stop();
};

const messageOf = (error) => String((error && error.message) || error || "unknown error");

/* Capture time of a video frame on the absolute ms clock. requestVideoFrameCallback
 * metadata carries captureTime (performance.now() timebase) for camera frames;
 * anything implausible falls back to "now". */
function captureTime(metadata) {
  const now = performance.now();
  const at = metadata && metadata.captureTime;
  if (typeof at === "number" && Number.isFinite(at) && at <= now && now - at < 1000) {
    return performance.timeOrigin + at;
  }
  return performance.timeOrigin + now;
}

/* The cameras for the settings panel. Labels only arrive once a camera has
 * been granted; before that they are numbered. `id` duplicates `deviceId` for
 * callers written against the old shape. */
async function listCameras() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return [];
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
  return devices
    .filter((device) => device.kind === "videoinput")
    .map((device, index) => ({
      deviceId: device.deviceId,
      id: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
    }));
}

export class HeadTracker {
  constructor({ models = "models", onStatus = () => {}, onReading = () => {}, onError = () => {},
    permissionGrace = PERMISSION_GRACE_MS, modelGrace = MODEL_GRACE_MS,
    pictureTimeout = PICTURE_TIMEOUT_MS } = {}) {
    this.models = models.replace(/\/$/, "");
    this.onStatus = onStatus;
    this.onReading = onReading;
    this.onError = onError;
    this.permissionGrace = permissionGrace;
    this.modelGrace = modelGrace;
    this.pictureTimeout = pictureTimeout;

    this.mode = "inline";
    this.rate = 0;
    this.running = false;
    this.error = null;

    this.worker = null;
    this.engine = null;
    this.ready = null;          // single-flight load promise
    this.loaded = false;
    this.loadStage = "";        // the pipeline's last status, repeated by open()
    this.pendingLoad = null;    // { worker, resolve } while a worker is loading
    this.restarted = false;     // the one worker restart has been spent

    this.video = null;
    this.stream = null;
    this.processed = null;      // the track a MediaStreamTrackProcessor is attached to
    // openId: which camera session is live (stop and open bump it; getUserMedia
    // cannot be cancelled, so a late answer checks it and lets go).
    // runId: which transport run readings must carry (bumped per wiring).
    this.openId = 0;
    this.runId = 0;
    this.busy = false;          // a page-driven frame is being grabbed/processed
    this.inflight = false;      // frames mode: a bitmap is with the worker
    this.lastVideoTime = -1;
    this.resize = true;         // frames mode: createImageBitmap honours resize options
    this.reportedRun = 0;       // processing errors go to onError once per run
    this.config = {};           // live engine settings (camera position), re-sent to every engine
    this.watched = null;        // { track, onEnded }: the live session's track
    this.pictureWatch = 0;      // stream mode: timer for a camera that never delivers
  }

  /* Live settings for the pose solver (today: screenOffsetCm, from the camera
   * position setting). Kept here so a worker loaded or restarted later gets them too. */
  configure({ screenOffsetCm } = {}) {
    if (!Number.isFinite(screenOffsetCm)) return;
    this.config = { ...this.config, screenOffsetCm };
    const message = { type: "configure", config: this.config };
    if (this.worker) this.worker.postMessage(message);
    if (this.pendingLoad && this.pendingLoad.worker !== this.worker) this.pendingLoad.worker.postMessage(message);
    if (this.engine && typeof this.engine.configure === "function") this.engine.configure(this.config);
  }

  // -- loading ------------------------------------------------------------

  pipelineStatus(text) {
    this.loadStage = text;
    this.onStatus(text);
  }

  /* Idempotent and single-flight: the page may preload while open() also waits
   * on it. A failed load is forgotten so the next call is a fresh attempt. */
  load() {
    if (!this.ready) {
      const ready = this.loadOnce().catch((error) => {
        if (this.ready === ready) this.ready = null;
        throw error;
      });
      this.ready = ready;
    }
    return this.ready;
  }

  async loadOnce() {
    if (!await this.loadWorker()) await this.loadInline();
    this.loaded = true;
  }

  /* tracker-core.js imports MediaPipe from a CDN at its top level, so it is
   * imported lazily: a static import would make the whole page wait on jsDelivr. */
  async loadInline() {
    this.mode = "inline";
    const { TrackerEngine } = await import("./tracker-core.js");
    const engine = new TrackerEngine({ models: this.models, onStatus: (text) => this.pipelineStatus(text) });
    if (typeof engine.configure === "function") engine.configure(this.config);
    try {
      await engine.load();
    } catch (error) {
      try { engine.close(); } catch { /* never loaded */ }
      throw error;
    }
    this.engine = engine;
  }

  /* Resolves false for any failure (no Worker, no dynamic import in workers,
   * model load failed) so the caller can fall back to inline. Classic worker:
   * MediaPipe's wasm loader needs importScripts. */
  async loadWorker() {
    if (typeof Worker === "undefined") return false;
    let worker;
    try {
      worker = new Worker(new URL("./tracker-worker.js", import.meta.url));
    } catch {
      return false;
    }
    const settled = new Promise((resolve) => { this.pendingLoad = { worker, resolve }; });
    worker.onmessage = (event) => this.fromWorker(worker, event.data);
    worker.onerror = (event) => this.workerFailed(worker, event);
    worker.onmessageerror = (event) => this.workerFailed(worker, event);
    // The worker resolves URLs against its own location; name the models absolutely.
    // The live settings ride along, so the engine is configured the moment it exists.
    worker.postMessage({ type: "load", models: new URL(this.models, location.href).href, config: this.config });
    if (!await settled) {
      try { worker.terminate(); } catch { /* already gone */ }
      return false;
    }
    this.worker = worker;
    this.mode = "worker";
    return true;
  }

  settleLoad(worker, ok) {
    if (!this.pendingLoad || this.pendingLoad.worker !== worker) return;
    const { resolve } = this.pendingLoad;
    this.pendingLoad = null;
    resolve(ok);
  }

  fromWorker(worker, data) {
    const loading = this.pendingLoad && this.pendingLoad.worker === worker;
    if (worker !== this.worker && !loading) return;  // a retired worker
    if (!data || typeof data !== "object") return;
    switch (data.type) {
      case "status":
        this.pipelineStatus(data.text);
        break;
      case "loaded":
        this.settleLoad(worker, true);
        break;
      case "loadfailed":
        if (data.message) console.warn("LazyVR: the head-tracking worker would not start —", data.message);
        this.settleLoad(worker, false);
        break;
      case "reading":
        if (worker === this.worker) this.deliver(data.reading, data.run);
        break;
      case "ended":
        // The frame stream closed under a live run: the camera went away.
        if (worker === this.worker && data.run === this.runId && this.running) {
          this.halt(new Error("The camera stopped."));
        }
        break;
      case "ready":
        // A late "ready" from a retired run must not open a second slot.
        if (data.run === this.runId) this.inflight = false;
        break;
      case "error":
        if (data.run === this.runId) {
          this.pictureArrived(data.run);  // frames are arriving, even if they fail
          this.processingError(new Error(data.message), data.run);
        }
        break;
      default:
        break;
    }
  }

  deliver(reading, run) {
    if (!reading || !this.running || run !== this.runId) return;
    this.pictureArrived(run);
    reading.run = run;
    if (Number.isFinite(reading.rate)) this.rate = reading.rate;
    this.onReading(reading);
  }

  report(error, { fatal = false } = {}) {
    this.error = error;
    if (fatal && error && typeof error === "object") error.fatal = true;
    try {
      this.onError(error, { fatal });
    } catch (listenerError) {
      console.error(listenerError);
    }
  }

  /* The tracker stops itself: release the camera first, so a listener that
   * reacts already sees running false, then say so as fatal. */
  halt(error) {
    this.stop();
    this.report(error, { fatal: true });
  }

  /* Per-frame failures repeat at frame rate; tell the listener once per run. */
  processingError(error, run) {
    this.error = error;
    if (this.reportedRun === run) return;
    this.reportedRun = run;
    this.report(error);
  }

  // -- worker crash recovery -------------------------------------------------

  workerFailed(worker, event) {
    if (this.pendingLoad && this.pendingLoad.worker === worker) {
      this.settleLoad(worker, false);   // failed while loading: loadWorker() handles it
      return;
    }
    if (worker !== this.worker) return;
    this.worker = null;
    this.inflight = false;
    try { worker.terminate(); } catch { /* already gone */ }
    // Start recovering first: it swaps this.ready synchronously, so a listener
    // that reacts to onError by calling open() waits for the recovery.
    const recovery = this.recover();
    const detail = event && event.message;
    this.report(new Error(`The head-tracking worker stopped${detail ? `: ${detail}` : "."}`));
    recovery.catch((error) => console.error(error));
  }

  /* One worker restart per tracker; after that (or if the restart fails) the
   * engine runs inline. A live session is rewired onto whatever comes back. */
  async recover() {
    const session = this.openId;
    const restart = !this.restarted;
    this.restarted = true;
    const recovering = (async () => {
      if (restart && await this.loadWorker()) return;
      await this.loadInline();
    })();
    // open() and load() calls made meanwhile wait for the recovery, not the old load.
    const ready = recovering.catch((error) => {
      if (this.ready === ready) this.ready = null;
      this.loaded = false;
      throw error;
    });
    ready.catch(() => {});  // nobody may be waiting; the failure is reported below
    this.ready = ready;
    try {
      await recovering;
    } catch (error) {
      const failed = new Error(`Head tracking could not be restarted: ${messageOf(error)}`);
      // Nothing left to process frames: let the camera go rather than keep the light on.
      // With no live session nothing stops; an open() waiting on it fails by itself.
      if (this.running && this.openId === session) this.halt(failed);
      else this.report(failed);
      return;
    }
    // Rewire only a session that had been wired; an open() still on its way
    // wires itself once the recovery settles.
    if (!this.running || this.openId !== session || !this.stream) return;
    try {
      await this.begin(session);
    } catch (error) {
      if (this.openId !== session) return;
      this.halt(error);
    }
  }

  // -- the camera -----------------------------------------------------------

  cameras() {
    return listCameras();
  }

  static cameras() {
    return listCameras();
  }

  /* Acquire the camera and start delivering readings. Rejects with a readable
   * message when the camera is refused, absent, busy, or the session was
   * stopped before it finished opening. */
  async open(videoElement, deviceId = "") {
    this.stop();  // one camera at a time; also retires any ask still out
    const mine = ++this.openId;
    this.error = null;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(globalThis.window && window.isSecureContext === false
        ? `This page was opened over plain http (${location.host}), and browsers `
          + "only allow the camera on a secure page. Open this site's https address instead."
        : "This browser is too old to open a camera.");
    }
    this.onStatus("Waiting for the camera…");
    const stream = await this.acquire(deviceId, mine);
    if (mine !== this.openId) {
      // stop() ran while the prompt was up and had nothing to release yet.
      stopTracks(stream);
      throw new Error(LET_GO);
    }
    this.stream = stream;
    this.video = videoElement;
    this.processed = null;

    // The ask went first to use the click while it is warm; now wait for the
    // pipeline, naming its stage (its statuses were shown while nobody looked).
    if (!this.loaded) this.onStatus(this.loadStage || "Loading head tracking…");
    const slow = setTimeout(() => {
      if (this.loaded || mine !== this.openId) return;
      this.onStatus("The head-tracking model is still downloading. It comes from a CDN "
        + "(cdn.jsdelivr.net) — a network filter or a content blocker can hold it up.");
    }, this.modelGrace);
    // After a worker crash this.ready is the recovery, so this waits for it.
    let loadError = null;
    await this.load().catch((error) => { loadError = error; });
    clearTimeout(slow);
    // Abandoned meanwhile: whoever retired this open already stopped this.stream,
    // which may now belong to a newer session, so only touch our own tracks.
    if (mine !== this.openId) {
      stopTracks(stream);
      throw new Error(LET_GO);
    }
    if (!this.worker && !this.engine) {
      this.stop();
      throw new Error(`Head tracking could not load${loadError ? ` (${messageOf(loadError)})` : ""}.`);
    }
    try {
      await this.begin(mine);
    } catch (error) {
      if (mine !== this.openId) {
        stopTracks(stream);
        throw new Error(LET_GO);
      }
      this.stop();
      throw error;
    }
    this.onStatus("Camera running");
  }

  /* The ladder: the chosen device, then the user-facing camera, then a bare
   * ask (some drivers refuse the ideal shape with AbortError yet open on
   * `true`), then -- if the browser keeps choosing a camera that will not start
   * (chrome can rank an unplugged webcam first) -- every other camera by id. */
  async acquire(deviceId, mine) {
    const asks = deviceId
      ? [{ deviceId: { exact: deviceId }, ...SHAPE }, { facingMode: "user", ...SHAPE }, true]
      : [{ facingMode: "user", ...SHAPE }, true];
    // Nudged, never abandoned: a prompt answered late must still work.
    const nudge = setTimeout(() => {
      if (mine !== this.openId) return;
      this.onStatus("Still waiting for permission to use the camera — look for the "
        + "camera icon at the right of the address bar and choose Allow.");
    }, this.permissionGrace);
    let error = null;
    const walk = async (list) => {
      for (const video of list) {
        // Retired (a stop, or a newer open): ask nothing more, or another
        // camera's light could come on after the viewer said no camera.
        if (mine !== this.openId) return null;
        try {
          const got = await navigator.mediaDevices.getUserMedia({ video, audio: false });
          error = null;
          return got;
        } catch (caught) {
          error = caught;
          // A refusal or an empty desk is an answer about the camera itself.
          if (caught && (caught.name === "NotAllowedError" || caught.name === "NotFoundError")) return null;
        }
      }
      return null;
    };
    let stream = null;
    try {
      stream = await walk(asks);
      if (!stream && cannotStart(error) && mine === this.openId) {
        // Permission is granted by now, so the ids enumerate for real.
        const named = (await listCameras())
          .filter((camera) => camera.deviceId && camera.deviceId !== deviceId)
          .map((camera) => ({ deviceId: { exact: camera.deviceId }, ...SHAPE }));
        if (named.length) stream = await walk(named);
      }
    } finally {
      clearTimeout(nudge);
    }
    if (stream) return stream;
    if (mine !== this.openId) throw new Error(LET_GO);
    const why = error && error.name;
    if (why === "NotAllowedError") throw new Error("Camera access was refused. Allow the camera for this site and reload.");
    if (why === "NotFoundError") throw new Error("No camera was found on this device.");
    if (cannotStart(error)) {
      throw new Error("No camera on this device would start — not the one the browser "
        + "chose, nor any other it lists. Something else may have them open: close "
        + "Teams, Zoom or the Camera app and try again.");
    }
    throw new Error(`The camera could not be opened (${why || messageOf(error)}).`);
  }

  /* Wire the current stream to the current pipeline under a new run id. Used by
   * open() and by crash recovery. */
  async begin(session) {
    const run = ++this.runId;
    this.running = true;
    this.busy = false;
    this.inflight = false;
    this.lastVideoTime = -1;
    this.reportedRun = 0;
    this.clearPictureWatch();
    const track = this.freshTrack();
    this.watchTrack(track, session);

    if (this.worker && track && typeof MediaStreamTrackProcessor !== "undefined") {
      try {
        // maxBufferSize 1: a slow frame never builds a backlog of stale ones.
        const readable = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable;
        this.processed = track;
        this.worker.postMessage({ type: "stream", stream: readable, run }, [readable]);
        this.mode = "worker";
        this.watchPicture(run);
        return;
      } catch { /* no transferable streams here: the page carries the frames */ }
    }

    if (this.worker) {
      this.mode = "frames";
      this.worker.postMessage({ type: "session", run });
    } else if (this.engine) {
      this.mode = "inline";
      this.engine.reset();
    } else {
      throw new Error("Head tracking is not loaded.");
    }
    await this.attachVideo(session);
    if (session !== this.openId) throw new Error(LET_GO);
    if (run !== this.runId) return;  // a crash recovery rewired this session meanwhile
    this.tick(run);
  }

  /* A track that ends on its own (unplugged, permission revoked, the system took
   * the camera) stops the tracker. stop() never fires "ended", so a normal
   * teardown cannot set this off; the guards drop a retired session's track. */
  watchTrack(track, session) {
    this.unwatchTrack();
    if (!track || typeof track.addEventListener !== "function") return;
    const onEnded = () => {
      if (!this.watched || this.watched.track !== track) return;
      if (session !== this.openId || !this.running) return;
      this.halt(new Error("The camera stopped."));
    };
    track.addEventListener("ended", onEnded, { once: true });
    this.watched = { track, onEnded };
  }

  unwatchTrack() {
    const watched = this.watched;
    this.watched = null;
    if (watched && typeof watched.track.removeEventListener === "function") {
      watched.track.removeEventListener("ended", watched.onEnded);
    }
  }

  /* Stream mode never sees the picture on the page (attachVideo's timeout
   * covers the other modes): a run with no reading or error by the deadline
   * has a camera that opened but delivers nothing. */
  watchPicture(run) {
    this.clearPictureWatch();
    const watch = setTimeout(() => {
      if (this.pictureWatch !== watch) return;
      this.pictureWatch = 0;
      if (run !== this.runId || !this.running) return;
      this.halt(new Error("The camera opened but never delivered a picture."));
    }, this.pictureTimeout);
    // Node only (the tests): never hold the process open for it.
    if (typeof watch === "object" && typeof watch.unref === "function") watch.unref();
    this.pictureWatch = watch;
  }

  pictureArrived(run) {
    if (this.pictureWatch && run === this.runId) this.clearPictureWatch();
  }

  clearPictureWatch() {
    if (this.pictureWatch) clearTimeout(this.pictureWatch);
    this.pictureWatch = 0;
  }

  /* A processor stays attached to its track. After a crash its stream died with
   * the worker; swapping in a clone (same source, so the light stays on) and
   * stopping the old track ends that processor cleanly. */
  freshTrack() {
    const stream = this.stream;
    const [track] = stream ? stream.getVideoTracks() : [];
    if (!track || track !== this.processed || typeof track.clone !== "function"
      || typeof stream.addTrack !== "function" || typeof stream.removeTrack !== "function") {
      return track;
    }
    const fresh = track.clone();
    stream.addTrack(fresh);
    stream.removeTrack(track);
    track.stop();
    this.processed = null;
    return fresh;
  }

  /* Play the stream in the page's video element and wait for its size. The
   * wait polls as well as listening: a track stopped mid-wait never reaches
   * loadedmetadata, and a retired session must not hold open() forever. */
  async attachVideo(session) {
    const video = this.video;
    if (!video) throw new Error("No video element to carry the camera picture.");
    if (video.srcObject !== this.stream) video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    let failed = null;
    Promise.resolve()
      .then(() => video.play())
      .catch((error) => { failed = error || new Error("play() failed"); });
    const started = Date.now();
    await new Promise((resolve) => {
      const check = () => {
        if (video.videoWidth || failed || session !== this.openId
          || Date.now() - started > this.pictureTimeout) {
          clearInterval(watch);
          video.removeEventListener("loadedmetadata", check);
          resolve();
        }
      };
      const watch = setInterval(check, 100);
      video.addEventListener("loadedmetadata", check);
      Promise.resolve().then(check);
    });
    if (session !== this.openId) throw new Error(LET_GO);
    // A paused element never fires frame callbacks, so a failed play() is fatal.
    if (failed) throw new Error(`The camera picture would not play (${failed.name || messageOf(failed)}).`);
    if (video.videoWidth) return;
    throw new Error("The camera opened but never delivered a picture.");
  }

  // -- page-driven frames (frames and inline modes) --------------------------

  tick(run) {
    const video = this.video;
    const perFrame = typeof video.requestVideoFrameCallback === "function";
    const next = (callback) => {
      if (perFrame) video.requestVideoFrameCallback(callback);
      else requestAnimationFrame(callback);
    };
    const step = (_now, metadata) => {
      if (run !== this.runId) return;  // retires this chain for good
      next(step);
      if (this.busy || this.inflight) return;
      if (!perFrame) {
        // rAF fires per display frame; only a new video frame is worth a pass.
        if (video.currentTime === this.lastVideoTime) return;
        this.lastVideoTime = video.currentTime;
      }
      this.busy = true;
      this.frame(run, captureTime(perFrame ? metadata : null))
        .catch((error) => { if (run === this.runId) this.processingError(error, run); })
        .finally(() => { if (run === this.runId) this.busy = false; });
    };
    next(step);
  }

  async frame(run, atMs) {
    const video = this.video;
    if (this.mode === "frames") {
      const worker = this.worker;
      if (!worker) return;  // crashed; recovery will rewire
      const image = await this.grab(video);
      if (run !== this.runId || worker !== this.worker) {
        image.close();
        return;
      }
      try {
        worker.postMessage({ type: "frame", image, atMs, run }, [image]);
      } catch (error) {
        image.close();
        throw error;
      }
      this.inflight = true;  // cleared by the worker's "ready" for this run
      return;
    }
    const engine = this.engine;
    if (!engine) return;
    const reading = await engine.process(video, video.videoWidth, video.videoHeight, atMs);
    this.deliver(reading, run);
  }

  /* A bitmap at most FRAME_WIDTH wide, keeping the aspect. Browsers that reject
   * the resize options get a full-size grab from then on. */
  async grab(video) {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (this.resize !== false && width > FRAME_WIDTH && height > 0) {
      const options = {
        resizeWidth: FRAME_WIDTH,
        resizeHeight: Math.max(1, Math.round(height * FRAME_WIDTH / width)),
        resizeQuality: "low",
      };
      try {
        return await createImageBitmap(video, options);
      } catch {
        const plain = await createImageBitmap(video);  // throws if the video itself is the problem
        this.resize = false;
        return plain;
      }
    }
    return createImageBitmap(video);
  }

  // -- teardown -------------------------------------------------------------

  /* Release the camera (light off) and drop anything still in flight. Also
   * retires an open() still waiting on the permission prompt or the model. */
  stop() {
    this.running = false;
    this.runId += 1;
    this.openId += 1;
    this.busy = false;
    this.inflight = false;
    this.unwatchTrack();
    this.clearPictureWatch();
    if (this.worker) this.worker.postMessage({ type: "stop" });
    const stream = this.stream;
    this.stream = null;
    this.processed = null;
    // Stopping the track also ends a transferred frame stream.
    stopTracks(stream);
    if (stream && this.video && this.video.srcObject === stream) this.video.srcObject = null;
  }
}
