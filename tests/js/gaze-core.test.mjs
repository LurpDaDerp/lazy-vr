/* The pipeline's own bookkeeping.
 *
 * gaze-core.js imports MediaPipe and onnxruntime straight off a CDN, which
 * node can neither resolve nor fetch, so both are answered with an empty
 * module before they are ever asked for.  Nothing under test here touches
 * either: the frame-rate window and the heuristic that reads it are plain
 * arithmetic on the timestamps the transports hand in.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("https://")) return { url: `stub:${specifier}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("stub:")) return next(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export const FaceLandmarker = {};
        export const FilesetResolver = {};
        export const env = { wasm: {} };
        export const InferenceSession = {};
        export class Tensor {}`,
    };
  },
});

const { GazeEngine, MIRROR_BUDGET_MS, IDLE_GAP_MS } =
  await import("../../site/js/gaze-core.js");

/* One reading per timestamp, which is all reading() needs to keep the rate. */
const feed = (engine, times) => {
  for (const at of times) {
    engine.reading({ yaw: 0, pitch: 0, tracked: true, confidence: 1 }, [1, 1], 5, at);
  }
};

const run = (start, count, period) =>
  Array.from({ length: count }, (unused, i) => start + i * period);

test("a device keeping up keeps the mirror pass", () => {
  const engine = new GazeEngine();
  feed(engine, run(0, 40, 20));

  assert.equal(engine.mirror, true);
  assert.ok(Math.abs(engine.rate - 50) < 1, `the rate reported ${engine.rate}`);
});

test("a device that really cannot keep up loses it", () => {
  const engine = new GazeEngine();
  feed(engine, run(0, 40, MIRROR_BUDGET_MS + 15));

  assert.equal(engine.mirror, false);
});

test("a pause between sessions does not cost the mirror pass", () => {
  // The engine outlives the camera: the settings panel changing camera, or a
  // tab hidden and looked at again, stops one session and starts the next on
  // the same engine.  The window still held sixty timestamps from before the
  // pause, so the first reading back averaged the whole idle stretch over
  // sixty frames -- every period far past the budget -- and the mirror pass
  // was dropped on the spot and stayed dropped, on a machine that was
  // keeping up perfectly well.
  const engine = new GazeEngine();
  feed(engine, run(0, 40, 20));
  assert.equal(engine.mirror, true);

  feed(engine, run(30000, 40, 20));

  assert.equal(engine.mirror, true, "an idle stretch was averaged in and the mirror pass went");
  assert.ok(Math.abs(engine.rate - 50) < 1, `the rate reported ${engine.rate}`);
});

test("the gap that starts the window over is longer than any real frame", () => {
  // A slow frame is the device struggling and must still count against the
  // budget; only a stretch with no device at all is thrown away.
  assert.ok(IDLE_GAP_MS > MIRROR_BUDGET_MS * 4);
});
