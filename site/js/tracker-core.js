/* TrackerEngine: one camera frame in, one reading out.
 * MediaPipe FaceLandmarker (VIDEO mode, iris included) -> HeadPoseEstimator (pose.js)
 * -> EyeTracker (eyes.js). Runs in the tracker worker or inline on the page; it never
 * touches the DOM. All the maths lives in the pure modules; this file is plumbing. */

import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

import { HeadPoseEstimator } from "./pose.js";
import { EyeTracker, eyeFeatures } from "./eyes.js";

const MEDIAPIPE_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const NUM_LANDMARKS = 478;
/* Consecutive detect exceptions before the GPU landmarker is replaced by a CPU one. */
export const MAX_DETECT_ERRORS = 5;
/* A gap this long means the camera stopped (tab hidden, camera switched): restart the rate window. */
export const IDLE_GAP_MS = 1000;
const RATE_WINDOW = 60;

const nowMs = () => performance.timeOrigin + performance.now();

/* MediaPipe's wasm routes its stderr to console.error, so a healthy start prints
 * "INFO: Created TensorFlow Lite XNNPACK delegate for CPU." as an error. Demote
 * exactly those "INFO:" lines to console.debug; every real error passes through. */
(function quietMediaPipeInfo() {
  const error = console.error;
  if (error.lazyvrQuiet) return;
  const quiet = function (...args) {
    if (typeof args[0] === "string" && args[0].startsWith("INFO: ")) {
      console.debug(...args);
      return;
    }
    error.apply(console, args);
  };
  quiet.lazyvrQuiet = true;
  console.error = quiet;
})();

export class TrackerEngine {
  constructor({ models = "models", onStatus = () => {}, screenOffsetCm } = {}) {
    this.models = String(models).replace(/\/$/, "");
    this.onStatus = onStatus;
    this.pose = new HeadPoseEstimator(screenOffsetCm === undefined ? {} : { screenOffsetCm });
    this.eyes = new EyeTracker();
    this.lm = new Float32Array(NUM_LANDMARKS * 3);
    this.features = {};
    this.landmarker = null;
    this.delegate = null;        // 'GPU' | 'CPU'
    this.fileset = null;
    this.loading = null;
    this.recreating = null;
    this.cpuFallbackDone = false;
    this.detectErrors = 0;
    this.lastError = null;
    this.lastTs = -Infinity;     // last timestamp handed to detectForVideo
    this.closed = false;
    this.frameTimes = new Float64Array(RATE_WINDOW);
    this.rate = 0;
    this.resetRate();
  }

  // -- loading ------------------------------------------------------------------------

  /* Idempotent and single-flight. */
  load() {
    if (!this.loading) {
      this.loading = this.loadOnce().catch((error) => {
        this.loading = null;  // allow a retry
        throw error;
      });
    }
    return this.loading;
  }

  async loadOnce() {
    this.onStatus("Loading the face model…");
    this.fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    let landmarker = null;
    try {
      landmarker = await this.create("GPU");
      await this.warmUp(landmarker);  // a GPU delegate can construct and still fail on first use
      this.delegate = "GPU";
    } catch (gpuError) {
      closeQuietly(landmarker);
      landmarker = null;
      try {
        landmarker = await this.create("CPU");
        await this.warmUp(landmarker);
      } catch (cpuError) {
        closeQuietly(landmarker);
        throw cpuError;
      }
      this.delegate = "CPU";
      this.cpuFallbackDone = true;
    }
    if (this.closed) { closeQuietly(landmarker); return; }
    this.landmarker = landmarker;
    this.onStatus("Ready");
  }

  create(delegate) {
    return FaceLandmarker.createFromOptions(this.fileset, {
      baseOptions: { modelAssetPath: `${this.models}/face_landmarker.task`, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.6,
      minTrackingConfidence: 0.6,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
  }

  /* One detection on a blank ImageBitmap (the same kind of input frames mode sends):
   * compiles the graph so the first real frame is not slow, and surfaces a broken
   * delegate while we can still fall back. */
  async warmUp(landmarker) {
    if (typeof createImageBitmap !== "function" || typeof ImageData === "undefined") return;
    const bitmap = await createImageBitmap(new ImageData(64, 64));
    try {
      landmarker.detectForVideo(bitmap, this.nextTimestamp(nowMs()));
    } finally {
      bitmap.close();
    }
  }

  /* After repeated runtime failures on the GPU, swap in a CPU landmarker (once). */
  fallBackToCpu() {
    if (this.recreating || this.cpuFallbackDone || this.delegate !== "GPU" || this.closed) return;
    this.cpuFallbackDone = true;
    const failed = this.landmarker;
    this.landmarker = null;
    closeQuietly(failed);
    this.onStatus("Switching head tracking to the CPU…");
    this.recreating = this.create("CPU").then((landmarker) => {
      if (this.closed) { closeQuietly(landmarker); return; }
      this.landmarker = landmarker;
      this.delegate = "CPU";
      this.detectErrors = 0;
      this.onStatus("Ready");
    }, (error) => {
      this.lastError = error;
      this.onStatus("Head tracking could not restart on the CPU");
    }).finally(() => { this.recreating = null; });
  }

  // -- per session / per frame ----------------------------------------------------------

  /* New session: forget pose, eye fit and frame rate. The detector's timestamp
   * floor is kept because MediaPipe requires increasing timestamps for its lifetime. */
  reset() {
    this.pose.reset();
    this.eyes.reset();
    this.detectErrors = 0;
    this.resetRate();
  }

  /* Live settings that reach the pose estimator (e.g. camera position). */
  configure({ screenOffsetCm, dfov } = {}) {
    const patch = {};
    if (Number.isFinite(screenOffsetCm)) patch.screenOffsetCm = screenOffsetCm;
    if (Number.isFinite(dfov) && dfov > 0) patch.dfov = dfov;
    this.pose.configure(patch);
  }

  nextTimestamp(atMs) {
    const ts = Math.max(this.lastTs + 1, Number.isFinite(atMs) ? atMs : nowMs());
    this.lastTs = ts;
    return ts;
  }

  /* image: anything detectForVideo accepts (VideoFrame, ImageBitmap, video, canvas);
   * width/height: its pixel size; atMs: absolute capture time (timeOrigin-based ms).
   * Returns a reading, or null when there is nothing to run on (no size, or the
   * landmarker is being rebuilt). Throws on detector errors (after counting them). */
  process(image, width, height, atMs) {
    if (!(width > 0) || !(height > 0)) return null;
    if (!this.landmarker) {
      if (this.recreating) return null;
      if (this.closed) return null;
      throw this.lastError || new Error("Head tracking is not loaded yet");
    }
    const started = performance.now();
    const t = Number.isFinite(atMs) ? atMs : nowMs();

    let result;
    try {
      result = this.landmarker.detectForVideo(image, this.nextTimestamp(t));
      this.detectErrors = 0;
    } catch (error) {
      this.lastError = error;
      this.detectErrors += 1;
      if (this.detectErrors >= MAX_DETECT_ERRORS) this.fallBackToCpu();
      throw error;
    }

    const face = result && result.faceLandmarks && result.faceLandmarks[0];
    const tSec = t / 1000;
    let pose;
    if (face) {
      flatten(face, this.lm);
      pose = this.pose.estimate(this.lm, width, height, tSec);
      eyeFeatures(this.lm, width, height, this.features);
    } else {
      pose = this.pose.estimate(null, width, height, tSec);
      this.features.ok = false;
    }
    const eye = this.eyes.update(this.features, pose.yaw, pose.pitch, tSec, pose.ok);
    this.updateRate(t);

    return {
      t,
      tracked: pose.ok,
      reason: pose.reason,
      head: { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll },
      dist: pose.dist,
      rms: pose.rms,
      eye: { x: eye.x, y: eye.y, valid: eye.valid, blink: eye.blink },
      latencyMs: performance.now() - started,
      rate: this.rate,
    };
  }

  close() {
    this.closed = true;
    closeQuietly(this.landmarker);
    this.landmarker = null;
  }

  // -- frame rate -------------------------------------------------------------------------

  resetRate() {
    this.rateCount = 0;
    this.rateHead = 0;
    this.rate = 0;
  }

  updateRate(t) {
    const n = this.rateCount, buf = this.frameTimes;
    if (n > 0) {
      const last = buf[(this.rateHead - 1 + RATE_WINDOW) % RATE_WINDOW];
      if (t - last > IDLE_GAP_MS || t < last) this.resetRate();
    }
    buf[this.rateHead] = t;
    this.rateHead = (this.rateHead + 1) % RATE_WINDOW;
    if (this.rateCount < RATE_WINDOW) this.rateCount += 1;
    if (this.rateCount > 1) {
      const first = buf[(this.rateHead - this.rateCount + RATE_WINDOW) % RATE_WINDOW];
      const span = t - first;
      if (span > 0) this.rate = (this.rateCount - 1) / (span / 1000);
    }
  }
}

/* MediaPipe's [{x, y, z}, ...] -> the reused flat array; missing points become NaN. */
function flatten(face, out) {
  const n = Math.min(face.length, NUM_LANDMARKS);
  for (let i = 0; i < n; i++) {
    const p = face[i];
    out[3 * i] = p.x; out[3 * i + 1] = p.y; out[3 * i + 2] = p.z;
  }
  if (n < NUM_LANDMARKS) out.fill(NaN, 3 * n);
  return out;
}

function closeQuietly(landmarker) {
  if (!landmarker) return;
  try { landmarker.close(); } catch { /* already gone */ }
}
