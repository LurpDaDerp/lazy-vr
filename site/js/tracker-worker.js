/* Head tracking off the main thread: hosts TrackerEngine (tracker-core.js).
 *
 * A CLASSIC worker on purpose: MediaPipe's wasm loader uses importScripts(),
 * which module workers lack ("ModuleFactory not set"). ES modules still load
 * through dynamic import().
 *
 * Protocol (page -> worker):
 *   { type: "load", models, config }    load the engine once (config as below)
 *   { type: "configure", config }       live engine settings ({ screenOffsetCm }),
 *                                       kept and applied to the engine once it loads
 *   { type: "stream", stream, run }     new session: read VideoFrames from a
 *                                       transferred MediaStreamTrackProcessor stream
 *   { type: "session", run }            new session fed by "frame" messages
 *   { type: "frame", image, atMs, run } one ImageBitmap; always answered with "ready"
 *   { type: "stop" }                    end the session
 * Worker -> page: status, loaded, loadfailed, reading {run, reading},
 *   ready {run}, error {run, message}, ended {run} (the frame stream closed
 *   while its run was still live).
 *
 * Run ids are assigned by the page. Every reading is checked against the live
 * run AFTER the engine's await, so a session stopped mid-frame never posts.
 */

let engine = null;
let loading = null;
let runId = 0;          // the live session; 0 = none
let reader = null;      // the live pump's reader
let busy = false;       // drop frames rather than queue them: only the newest matters
let config = {};        // the page's live engine settings (camera position)

function applyConfig(target) {
  if (!target || typeof target.configure !== "function") return;
  try {
    target.configure(config);
  } catch (error) {
    say({ type: "error", run: runId, message: reason(error) });
  }
}

const now = () => performance.timeOrigin + performance.now();
const say = (message) => postMessage(message);
const reason = (error) => String((error && error.message) || error);

/* VideoFrame.timestamp (µs, camera clock) mapped onto the absolute ms clock.
 * now − ts is the clock offset plus this frame's delivery delay, so its running
 * minimum is the best offset estimate; a jump of more than a second (or a
 * timestamp going backwards) means the camera clock restarted: re-anchor.
 * With the minimum, mapped times never lie in the future and stay increasing. */
const REANCHOR_MS = 1000;
const clock = { offset: NaN, lastTs: NaN };

function resetClock() {
  clock.offset = NaN;
  clock.lastTs = NaN;
}

function frameTime(timestampUs) {
  const at = now();
  if (typeof timestampUs !== "number" || !Number.isFinite(timestampUs)) return at;
  const ts = timestampUs / 1000;
  const candidate = at - ts;
  if (!Number.isFinite(clock.offset) || !(ts > clock.lastTs) || candidate > clock.offset + REANCHOR_MS) {
    clock.offset = candidate;
  } else if (candidate < clock.offset) {
    clock.offset = candidate;
  }
  clock.lastTs = ts;
  return ts + clock.offset;
}

async function handle(image, width, height, atMs, run) {
  if (!engine || busy || run !== runId) return;
  busy = true;
  try {
    const reading = await engine.process(image, width, height, atMs);
    // The session may have been stopped or replaced while process() ran.
    if (reading && run === runId) {
      reading.run = run;
      say({ type: "reading", run, reading });
    }
  } catch (error) {
    if (run === runId) say({ type: "error", run, message: reason(error) });
  } finally {
    busy = false;
  }
}

/* Read the camera for as long as this run lasts. */
async function pump(stream, run) {
  // Its own reader, not the module slot: see release().
  const own = stream.getReader();
  reader = own;
  while (runId === run) {
    let frame;
    let next;
    try {
      next = await own.read();
    } catch {
      next = { done: true };
    }
    if (next.done) {
      // Still the live run: the camera ended under it (unplugged, revoked), not
      // a page stop. The page drops this if its own stop retired the run first.
      if (runId === run) say({ type: "ended", run });
      break;
    }
    frame = next.value;
    try {
      if (runId === run) {
        await handle(frame, frame.displayWidth || frame.codedWidth,
          frame.displayHeight || frame.codedHeight, frameTime(frame.timestamp), run);
      }
    } finally {
      frame.close();
    }
  }
  release(own);
}

/* Cancel a reader -- by default the live one, but a finished pump names its
 * own. A retired pump can resume after the next session's pump has started;
 * releasing the module slot then would cancel the NEW reader (light on, no
 * readings). */
function release(which = reader) {
  if (!which) return;
  if (which === reader) reader = null;
  try {
    Promise.resolve(which.cancel()).catch(() => {});
  } catch { /* already finished */ }
}

function begin(run) {
  runId = run;
  release();
  resetClock();
  if (!engine) return;
  try {
    engine.reset();
  } catch (error) {
    say({ type: "error", run, message: reason(error) });
  }
}

async function load(models) {
  try {
    // Dynamic, because this is a classic worker: see the note above.
    const { TrackerEngine } = await import("./tracker-core.js");
    const fresh = new TrackerEngine({ models, onStatus: (text) => say({ type: "status", text }) });
    try {
      await fresh.load();
    } catch (error) {
      try { fresh.close(); } catch { /* never loaded */ }
      throw error;
    }
    engine = fresh;
    applyConfig(engine);
    say({ type: "loaded" });
  } catch (error) {
    loading = null;  // let the page ask again
    say({ type: "loadfailed", message: reason(error) });
  }
}

const runOf = (message) => (Number.isInteger(message.run) && message.run > 0 ? message.run : -1);

self.onmessage = async (event) => {
  const message = event.data || {};
  switch (message.type) {
    case "load":
      if (message.config && typeof message.config === "object") config = { ...config, ...message.config };
      if (engine) {
        applyConfig(engine);
        say({ type: "loaded" });
      } else if (!loading) {
        loading = load(message.models);
      }
      break;

    case "stream": {
      const run = runOf(message);
      begin(run);
      // Not awaited (it runs for the session), so its failure is caught here.
      pump(message.stream, run).catch((error) => {
        if (run === runId) say({ type: "error", run, message: reason(error) });
      });
      break;
    }

    case "configure":
      if (message.config && typeof message.config === "object") config = { ...config, ...message.config };
      applyConfig(engine);
      break;

    case "session":
      begin(runOf(message));
      break;

    case "frame": {
      const run = runOf(message);
      const image = message.image;
      try {
        if (image && run === runId) await handle(image, image.width, image.height, message.atMs, run);
      } finally {
        try { if (image) image.close(); } catch { /* already closed */ }
        say({ type: "ready", run });  // backpressure: the page may send the next
      }
      break;
    }

    case "stop":
      runId = 0;
      release();
      break;

    default:
      break;
  }
};
