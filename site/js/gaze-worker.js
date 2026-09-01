/* The gaze pipeline, off the main thread.
 *
 * Two landmarker passes and an ONNX graph, thirty times a second, is twenty
 * to forty milliseconds of work per frame.  On the main thread that is most
 * of the frame budget, and it lands squarely between the render loop and the
 * screen: the view stutters not because the maths is wrong but because
 * nothing got to draw.  (It is also why this felt smooth when the same
 * pipeline ran on a Python server -- the browser had nothing left to do but
 * draw.)  Here it runs beside the page instead of in front of it.
 *
 * A CLASSIC worker, deliberately, though everything it loads is a module.
 * MediaPipe's fileset resolver loads its wasm with importScripts(), which a
 * module worker is forbidden to have; in one the face model dies with
 * "ModuleFactory not set."  A classic worker keeps importScripts and can
 * still pull in ES modules with dynamic import(), so this is the one shape
 * that satisfies both.
 *
 * Frames arrive one of two ways.  Preferably the page hands over the
 * ReadableStream of a MediaStreamTrackProcessor -- transferred, so the
 * frames are read here and the page does nothing at all per frame, while the
 * track itself stays on the page where stopping it turns the camera light
 * off.  Where that cannot be had, the page passes one ImageBitmap at a time
 * and each is answered, so exactly one is ever in flight.
 */

let engine = null;
let reader = null;
let runId = 0;
/* Frames are dropped rather than queued: a backlog of stale frames turns a
 * slow device into a laggy one, and the newest frame is the only one worth
 * having. */
let busy = false;

const now = () => performance.timeOrigin + performance.now();
const say = (message) => postMessage(message);
const reason = (error) => String((error && error.message) || error);

async function handle(image, width, height, atMs) {
  if (!engine || busy) return;
  busy = true;
  try {
    const reading = await engine.process(image, width, height, atMs);
    if (reading) say({ type: "reading", reading });
  } catch (error) {
    say({ type: "error", message: reason(error) });
  } finally {
    busy = false;
  }
}

/* Read the camera straight through, for as long as this run lasts. */
async function pump(stream, mine) {
  reader = stream.getReader();
  while (runId === mine) {
    let frame;
    try {
      const next = await reader.read();
      if (next.done) break;
      frame = next.value;
    } catch {
      break;  // the page stopped the track: a stop, not a fault
    }
    if (runId === mine) {
      await handle(frame, frame.displayWidth || frame.codedWidth,
        frame.displayHeight || frame.codedHeight, now());
    }
    frame.close();
  }
  release();
}

function release() {
  if (!reader) return;
  const finished = reader;
  reader = null;
  try { finished.cancel(); } catch { /* already finished */ }
}

self.onmessage = async (event) => {
  const message = event.data || {};
  switch (message.type) {
    case "load":
      try {
        // Dynamic, because this is a classic worker: see the note above.
        const { GazeEngine } = await import("./gaze-core.js");
        engine = new GazeEngine({
          models: message.models,
          onStatus: (text) => say({ type: "status", text }),
        });
        await engine.load();
        say({ type: "loaded" });
      } catch (error) {
        say({ type: "loadfailed", message: reason(error) });
      }
      break;

    case "stream":
      release();
      pump(message.stream, ++runId);
      break;

    case "frame":
      try {
        await handle(message.image, message.image.width, message.image.height, message.atMs);
      } finally {
        message.image.close();
        say({ type: "ready" });  // backpressure: the page may send the next
      }
      break;

    case "mirror":
      if (engine) engine.mirror = Boolean(message.value);
      break;

    case "stop":
      runId += 1;
      release();
      break;

    case "selftest":
      try {
        say({ type: "selftest", worst: await engine.selfTest() });
      } catch (error) {
        say({ type: "selftest", message: reason(error) });
      }
      break;

    default:
      break;
  }
};
