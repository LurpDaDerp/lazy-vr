/* The gaze pipeline itself: models in, one image at a time, angles out.
 *
 * MediaPipe's FaceLandmarker reads the same .task file the Python server
 * used, onnxruntime-web runs the same gaze_direct.onnx, and geometry.js
 * builds the model's inputs the same way (held to the numpy original by a
 * fixture).
 *
 * Two extraction passes per frame, as the reference pipeline did: the frame
 * as captured and horizontally flipped, each with its own detection, and the
 * mean of the two clouds goes to the model.  The two disagree by about a
 * hundredth of an interocular distance at the irises, and averaging cancels
 * the extractor's per-side noise and its side-dependent pitch offset.  On a
 * device that cannot keep up, the second pass is dropped rather than the
 * frame rate.
 *
 * The detector sees the RAW frame, never a mirrored one: that fixes the sign
 * unambiguously.  The camera's +x is image right, which is where the
 * viewer's own left lands, so looking left gives atan2(x, z) > 0.
 *
 * Nothing here knows where the image came from, and nothing here touches the
 * page: the image is anything drawImage accepts -- a <video>, a VideoFrame,
 * an ImageBitmap -- and the scratch canvas is an OffscreenCanvas wherever one
 * exists.  That is what lets the whole pipeline run inside a worker, which is
 * where it belongs: every millisecond it spends is a millisecond the render
 * loop is not turning the view.
 */

import { FaceLandmarker, FilesetResolver } from
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
import * as ort from
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/ort.wasm.min.mjs";

import {
  NUM_LANDMARKS, SubjectStatistics, averageClouds, cameraContext, combineGaze,
  eyeVisibility, flattenLandmarks, gazeAngles, landmarkValidity, mirrorCloud,
  mirrorContext, mirrorValidity, weak3dCloud,
} from "./geometry.js";

const MEDIAPIPE_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/";

/* Calibrated fx / image width for a typical webcam; the model's context ray
 * is scaled by it. */
export const FOCAL_SCALE = 0.75;
/* The flipped frame is drawn this wide for its detection; the landmarks are
 * normalised, so only the aspect ratio has to be honest. */
const MIRROR_WIDTH = 640;
/* If a frame takes longer than this on average the mirror pass is dropped:
 * a single pass at a usable rate beats two passes at a crawl. */
export const MIRROR_BUDGET_MS = 45;

/* Scratch for the flipped pass.  A worker has no document, and a main
 * thread that has OffscreenCanvas is better off with one anyway: it keeps
 * the scratch out of the page's own compositing. */
function scratchCanvas() {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1);
  return document.createElement("canvas");
}

export class GazeEngine {
  /* `models`: URL of the folder with gaze_direct.onnx, the .task file, the
   * metadata and the permutation.  `onStatus(text)` reports loading stages. */
  constructor({ models = "models", onStatus = () => {} } = {}) {
    this.models = models.replace(/\/$/, "");
    this.onStatus = onStatus;
    this.mirror = true;
    this.frameTimes = [];
    this.rate = 0;
  }

  // -- loading ----------------------------------------------------------

  async load() {
    this.onStatus("Loading the gaze model…");
    const [meta, permutation] = await Promise.all([
      fetch(`${this.models}/gaze_direct.meta.json`).then((r) => r.json()),
      fetch(`${this.models}/mirror_permutation.json`).then((r) => r.json()),
    ]);
    if (permutation.length !== NUM_LANDMARKS) throw new Error("mirror permutation must have 478 entries");
    this.permutation = Int32Array.from(permutation);
    const gate = meta.eye_gate || {};
    this.eyeGate = [Number(gate.low ?? 0), Number(gate.high ?? 0)];
    const stats = meta.subject_stats || {};
    this.stats = new SubjectStatistics(stats.training_mean || [0, 0, 0, 0]);

    ort.env.wasm.wasmPaths = ORT_DIST;
    // One thread: multi-threaded WASM needs cross-origin isolation headers a
    // plain static host does not send, and this graph is small.
    ort.env.wasm.numThreads = 1;
    this.session = await ort.InferenceSession.create(`${this.models}/gaze_direct.onnx`, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    const context = this.session.inputNames;
    for (const name of ["cloud", "context", "validity"]) {
      if (!context.includes(name)) throw new Error(`model is missing input ${name}`);
    }
    this.contextWidth = 7;  // ray_x, ray_y, iod/focal + the four subject statistics

    this.onStatus("Loading the face model…");
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
    const options = (runningMode) => ({
      baseOptions: { modelAssetPath: `${this.models}/face_landmarker.task`, delegate: "GPU" },
      runningMode,
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("VIDEO"));
      this.flippedLandmarker = await FaceLandmarker.createFromOptions(fileset, options("IMAGE"));
    } catch (error) {
      // No usable GPU delegate: fall back to the CPU one.
      const cpu = (mode) => ({ ...options(mode), baseOptions: { ...options(mode).baseOptions, delegate: "CPU" } });
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, cpu("VIDEO"));
      this.flippedLandmarker = await FaceLandmarker.createFromOptions(fileset, cpu("IMAGE"));
    }

    this.flipCanvas = scratchCanvas();
    this.flipContext = this.flipCanvas.getContext("2d", { willReadFrequently: false });
    // One set of batch buffers for the life of the engine: allocating
    // ~12 KB of Float32Arrays thirty times a second is pure GC churn.
    this.cloudBatch = new Float32Array(2 * NUM_LANDMARKS * 3);
    this.contextBatch = new Float32Array(2 * this.contextWidth);
    this.validityBatch = new Float32Array(2 * NUM_LANDMARKS);
    await this.warmUp();
    this.onStatus("Ready");
  }

  async warmUp() {
    const cloud = new Float32Array(2 * NUM_LANDMARKS * 3);
    cloud[33 * 3] = -0.5; cloud[263 * 3] = 0.5;
    cloud[NUM_LANDMARKS * 3 + 33 * 3] = -0.5; cloud[NUM_LANDMARKS * 3 + 263 * 3] = 0.5;
    await this.run(cloud, new Float32Array(2 * this.contextWidth), new Float32Array(2 * NUM_LANDMARKS).fill(1));
  }

  /* Prove the graph reproduces the exporter's reference frames, as the
   * Python self-test did.  Returns the worst |dgaze|. */
  async selfTest() {
    const parity = await fetch(`${this.models}/parity.json`).then((r) => r.json());
    const batch = parity.cloud.length;
    const cloud = Float32Array.from(parity.cloud.flat(2));
    const context = Float32Array.from(parity.context.flat());
    const validity = Float32Array.from(parity.validity.flat());
    const { gaze } = await this.run(cloud, context, validity, batch);
    let worst = 0;
    parity.gaze.flat().forEach((expected, i) => { worst = Math.max(worst, Math.abs(gaze[i] - expected)); });
    if (!(worst <= parity.tolerance)) throw new Error(`parity diff ${worst.toExponential(2)} exceeds ${parity.tolerance}`);
    return worst;
  }

  // -- one frame ----------------------------------------------------------

  /* `image` is anything drawImage and MediaPipe both accept; `atMs` is the
   * frame's time on an absolute clock (timeOrigin + now), so that a reading
   * produced in a worker and a reading produced here mean the same thing.
   * Returns a reading, or null if the image was unusable. */
  async process(image, width, height, atMs) {
    if (!width || !height) return null;
    const started = performance.now();
    const lost = () => this.reading({ yaw: 0, pitch: 0, tracked: false, confidence: 0 },
      [0, 0], performance.now() - started, atMs);

    const result = this.landmarker.detectForVideo(image, atMs);
    const face = result.faceLandmarks && result.faceLandmarks[0];
    if (!face) return lost();

    let landmarks = flattenLandmarks(face);
    if (this.mirror) {
      const flipped = this.detectFlipped(image, width, height);
      if (flipped) landmarks = averageClouds(landmarks, flattenLandmarks(flipped), this.permutation);
    }

    let cloud, context, validity;
    try {
      cloud = weak3dCloud(landmarks, width, height);
      context = cameraContext(landmarks, width, height, FOCAL_SCALE);
      validity = landmarkValidity(landmarks);
    } catch (error) {
      return lost();
    }
    context = context.concat(this.stats.push(cloud));

    const gaze = await this.predict(cloud, context, validity);
    const [yaw, pitch] = gazeAngles(gaze);
    let inside = 0;
    for (let i = 0; i < NUM_LANDMARKS; i++) inside += validity[i];
    // The fraction of landmarks inside the frame is the honest quality
    // signal.  Eye visibility is not: the far-eye gate is relative, so it
    // drops exactly when the viewer turns -- when we most want to pan.
    return this.reading({ yaw, pitch, tracked: true, confidence: inside / NUM_LANDMARKS },
      eyeVisibility(cloud, ...this.eyeGate), performance.now() - started, atMs);
  }

  detectFlipped(image, width, height) {
    const w = Math.min(MIRROR_WIDTH, width);
    const h = Math.max(1, Math.round(height * w / width));
    if (this.flipCanvas.width !== w || this.flipCanvas.height !== h) {
      this.flipCanvas.width = w;
      this.flipCanvas.height = h;
    }
    const ctx = this.flipContext;
    ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.drawImage(image, 0, 0, w, h);
    const result = this.flippedLandmarker.detect(this.flipCanvas);
    return result.faceLandmarks && result.faceLandmarks[0];
  }

  /* Mirror test-time augmentation in one batch-2 call: the second row is the
   * left/right-permuted cloud with x negated, the context ray's x negated
   * and the validity permuted; its gaze is un-mirrored and averaged with the
   * direct row. */
  async predict(cloud, context, validity) {
    this.cloudBatch.set(cloud, 0);
    this.cloudBatch.set(mirrorCloud(cloud, this.permutation), NUM_LANDMARKS * 3);
    this.contextBatch.set(context, 0);
    this.contextBatch.set(mirrorContext(context), this.contextWidth);
    this.validityBatch.set(validity, 0);
    this.validityBatch.set(mirrorValidity(validity, this.permutation), NUM_LANDMARKS);
    const { gaze } = await this.run(this.cloudBatch, this.contextBatch, this.validityBatch);
    return combineGaze(gaze.subarray(0, 3), gaze.subarray(3, 6));
  }

  async run(cloud, context, validity, batch = 2) {
    const feeds = {
      cloud: new ort.Tensor("float32", cloud, [batch, NUM_LANDMARKS, 3]),
      context: new ort.Tensor("float32", context, [batch, this.contextWidth]),
      validity: new ort.Tensor("float32", validity, [batch, NUM_LANDMARKS]),
    };
    const out = await this.session.run(feeds);
    return { gaze: out.gaze.data, rotation: out.rotation.data };
  }

  /* Wrap one frame's answer, and keep the running frame rate that decides
   * whether this device can still afford the second pass. */
  reading(sample, visibility, latencyMs, atMs) {
    this.frameTimes.push(atMs);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    if (this.frameTimes.length > 1) {
      const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
      this.rate = (this.frameTimes.length - 1) / (span / 1000);
      const period = span / (this.frameTimes.length - 1);
      if (this.mirror && this.frameTimes.length >= 30 && period > MIRROR_BUDGET_MS) this.mirror = false;
    }
    return {
      // Absolute seconds.  The control law only ever takes differences, so
      // the origin does not matter -- but it must be the *same* origin on
      // both sides of a worker boundary, and timeOrigin is not.
      sample: { ...sample, timestamp: atMs / 1000 },
      eyeVisibility: visibility,
      latencyMs,
      rate: this.rate,
      mirror: this.mirror,
    };
  }
}
