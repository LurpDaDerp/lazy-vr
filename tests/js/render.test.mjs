/* The 360 renderer's hold on its WebGL context.
 *
 * No pixels are checked here -- node has no GPU and the shaders are proved
 * by looking at the thing.  What is checked is the part that has no picture
 * to give it away: a context that is taken back, and whether anything is
 * ever built on the new one.
 */

import test from "node:test";
import assert from "node:assert/strict";

// resize() asks the page how many physical pixels a css pixel is worth.
globalThis.window = { devicePixelRatio: 1 };

const { Renderer } = await import("../../site/js/render.js");

/* Enough of WebGL2 to be built on: every call is recorded, every create
 * hands back a distinct object so a rebuild can be told from a reuse, and
 * the two "did it work" queries always say yes. */
function fakeGl() {
  const gl = {
    calls: [], made: [],
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, TEXTURE_2D: 7, RGBA: 8, UNSIGNED_BYTE: 9,
    FLOAT: 10, TEXTURE_WRAP_S: 11, TEXTURE_WRAP_T: 12, TEXTURE_MIN_FILTER: 13,
    TEXTURE_MAG_FILTER: 14, REPEAT: 15, CLAMP_TO_EDGE: 16, LINEAR: 17,
    TRIANGLES: 18, UNPACK_FLIP_Y_WEBGL: 19,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getAttribLocation: () => 0,
    getUniformLocation: (program, name) => ({ name }),
  };
  const note = (name) => (...args) => { gl.calls.push(name); return args; };
  for (const name of ["shaderSource", "compileShader", "attachShader", "detachShader",
    "deleteShader", "linkProgram", "useProgram", "bindBuffer", "bufferData",
    "enableVertexAttribArray", "vertexAttribPointer", "bindTexture", "texParameteri",
    "texImage2D", "texSubImage2D", "pixelStorei", "viewport", "uniform1f", "uniform2f",
    "drawArrays"]) gl[name] = note(name);
  for (const name of ["createShader", "createProgram", "createBuffer", "createTexture"]) {
    gl[name] = () => { const made = { kind: name }; gl.made.push(made); return made; };
  }
  return gl;
}

function fakeCanvas(gl) {
  const listeners = {};
  return {
    width: 0, height: 0, clientWidth: 800, clientHeight: 600,
    getContext: () => gl,
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    fire(type, event = {}) { for (const handler of listeners[type] || []) handler(event); },
  };
}

const fakeVideo = () => ({ readyState: 4, videoWidth: 3840, videoHeight: 1920 });
const view = { yaw: 0, pitch: 0, roll: 0, blur: 0 };

test("a context that is taken back is asked for again", () => {
  // A driver reset, a laptop waking on the other GPU, or the browser
  // reclaiming a background tab's memory takes the context away, and every
  // object made on it goes too.  Unhandled, the loss is silent and
  // permanent: gl calls afterwards quietly do nothing, so the video is black
  // for the rest of the session with no error anywhere.
  const gl = fakeGl();
  const canvas = fakeCanvas(gl);
  const renderer = new Renderer(canvas, fakeVideo());
  const built = gl.made.length;

  let defaulted = true;
  canvas.fire("webglcontextlost", { preventDefault() { defaulted = false; } });
  assert.equal(defaulted, false, "the loss was not prevented, so no restore is ever offered");

  gl.calls.length = 0;
  renderer.draw(view);
  assert.deepEqual(gl.calls, [], "drew on a context that was gone");

  canvas.fire("webglcontextrestored");
  assert.ok(gl.made.length > built, "nothing was rebuilt on the new context");

  gl.calls.length = 0;
  renderer.draw(view);
  assert.ok(gl.calls.includes("drawArrays"), "drawing never resumed");
});

test("the first frame after a restore is uploaded again", () => {
  // The canvas keeps its size through a loss, so resize() would say nothing
  // changed and never set the new context's viewport; and the new texture is
  // one black pixel until a frame is put in it.
  const gl = fakeGl();
  const canvas = fakeCanvas(gl);
  const renderer = new Renderer(canvas, fakeVideo());
  renderer.resize();

  canvas.fire("webglcontextlost", { preventDefault() {} });
  gl.calls.length = 0;
  canvas.fire("webglcontextrestored");
  assert.ok(gl.calls.includes("viewport"), "the new context was left with no viewport");

  gl.calls.length = 0;
  renderer.draw(view);
  assert.ok(gl.calls.includes("texImage2D"), "the black placeholder was never replaced");
});

test("the shader objects do not pile up across rebuilds", () => {
  // The linked program holds everything it needs; the shaders are only kept
  // alive by being attached, and one rebuild per context loss would leave a
  // pair behind each time.
  const gl = fakeGl();
  const canvas = fakeCanvas(gl);
  const unused = new Renderer(canvas, fakeVideo());
  assert.equal(gl.calls.filter((name) => name === "deleteShader").length, 2);
  assert.equal(gl.calls.filter((name) => name === "detachShader").length, 2);
  assert.ok(unused);
});

// ---- field of view, signs, sizing, frame chain -----------------------------

const { verticalFov, directionFor } = await import("../../site/js/render.js");
const DEG = Math.PI / 180;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("fov: horizontal semantics -- the vertical uniform comes from the aspect", () => {
  near(verticalFov(100 * DEG, 1000, 1000), 100 * DEG);
  near(verticalFov(90 * DEG, 1600, 900), 2 * Math.atan(900 / 1600));
  near(verticalFov(100 * DEG, 0, 0), 100 * DEG);       // no size yet
  near(verticalFov(NaN, 1600, 900), verticalFov(100 * DEG, 1600, 900));
  // The edge of the screen sits exactly hFov/2 off-centre.
  const aspect = 16 / 9;
  const v = verticalFov(100 * DEG, 1600, 900);
  const edge = directionFor(aspect / 2, 0, { yaw: 0, pitch: 0, roll: 0 }, v);
  near(edge.lon, 50 * DEG, 1e-9);
});

test("fov: the uniform sent is vertical, recomputed for the canvas", () => {
  const gl = fakeGl();
  const sent = [];
  gl.uniform1f = (loc, value) => sent.push([loc.name, value]);
  const canvas = fakeCanvas(gl);
  canvas.clientWidth = 1600;
  canvas.clientHeight = 900;
  const renderer = new Renderer(canvas, fakeVideo(), 90);
  near(renderer.fov, 90 * DEG);
  renderer.draw(view);
  near(sent.find(([n]) => n === "uFov")[1], 2 * Math.atan(900 / 1600));
  renderer.setFov(120);
  near(renderer.fov, 120 * DEG);
  renderer.fov = NaN;                // ignored
  near(renderer.fov, 120 * DEG);
});

test("signs: positive yaw looks left, positive pitch looks up (same contract as embed)", () => {
  const v = 60 * DEG;
  const ahead = directionFor(0, 0, { yaw: 0, pitch: 0, roll: 0 }, v);
  near(ahead.lon, 0);
  near(ahead.lat, 0);
  const left = directionFor(0, 0, { yaw: 30 * DEG, pitch: 0, roll: 0 }, v);
  near(left.lon, -30 * DEG, 1e-9);   // lon < 0 = left of the frame centre
  // Screen-right shows lon > 0, so the content once on the left is now centred.
  assert.ok(directionFor(0.3, 0, { yaw: 0, pitch: 0, roll: 0 }, v).lon > 0);
  const up = directionFor(0, 0, { yaw: 0, pitch: 20 * DEG, roll: 0 }, v);
  near(up.lat, 20 * DEG, 1e-9);
});

test("the shader keeps the conventions directionFor mirrors", async () => {
  // Guard against the JS mirror drifting from the GLSL: the lines that
  // decide the signs must still be there.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../site/js/render.js", import.meta.url), "utf8");
  assert.ok(src.includes("float lon = atan(dir.x, -dir.z);"));
  assert.ok(src.includes("return vec3(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);"));
  assert.ok(src.includes("dir = vec3(dir.x, cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);"));
  assert.ok(src.includes("uniform float uFov;    // VERTICAL"));
});

test("resize: measured once, then only when the observer says so", () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
  };
  try {
    const gl = fakeGl();
    const canvas = fakeCanvas(gl);
    let reads = 0;
    let width = 800;
    Object.defineProperty(canvas, "clientWidth", { get() { reads += 1; return width; } });
    const renderer = new Renderer(canvas, fakeVideo());
    renderer.draw(view);
    assert.equal(canvas.width, 800);
    const after = reads;
    for (let i = 0; i < 10; i += 1) renderer.draw(view);
    assert.equal(reads, after, "the canvas was measured every frame");
    width = 1000;
    observers[0].cb([]);
    renderer.draw(view);
    assert.equal(canvas.width, 1000);
    // A DPR change (monitor move) re-measures too.
    window.devicePixelRatio = 2;
    renderer.draw(view);
    assert.equal(canvas.width, 2000);
    window.devicePixelRatio = 3;      // capped at 2
    renderer.draw(view);
    assert.equal(canvas.width, 2000);
  } finally {
    delete globalThis.ResizeObserver;
    window.devicePixelRatio = 1;
  }
});

test("frames: a new source re-arms the rVFC chain without doubling it", () => {
  const gl = fakeGl();
  const callbacks = new Map();
  let next = 0;
  const cancelled = [];
  const listeners = {};
  const video = {
    ...fakeVideo(),
    requestVideoFrameCallback(fn) { next += 1; callbacks.set(next, fn); return next; },
    cancelVideoFrameCallback(id) { cancelled.push(id); callbacks.delete(id); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  };
  const renderer = new Renderer(fakeCanvas(gl), video);
  assert.equal(callbacks.size, 1);

  renderer.setSource("blob:new");
  assert.equal(video.src, "blob:new");
  assert.equal(callbacks.size, 1, "the old chain was not retired");
  assert.deepEqual(cancelled, [1]);
  assert.equal(renderer.pendingFrame, true, "the new source's first frame is not uploaded");

  // The loadeddata event re-arms too, for callers that set src themselves.
  for (const fn of listeners.loadeddata) fn();
  assert.equal(callbacks.size, 1);

  // The live chain still marks frames and keeps itself going.
  const gen = renderer.frameGen;
  renderer.pendingFrame = false;
  const live = [...callbacks.values()][0];
  live();
  assert.equal(renderer.pendingFrame, true);
  assert.equal(renderer.frameGen, gen);
  assert.equal(callbacks.size, 2, "the live chain re-requested");
});

test("frames: a retired chain without cancel support is ignored by generation", () => {
  const gl = fakeGl();
  const fns = [];
  const video = { ...fakeVideo(), requestVideoFrameCallback(fn) { fns.push(fn); return fns.length; } };
  const renderer = new Renderer(fakeCanvas(gl), video);
  renderer.rearm();
  renderer.pendingFrame = false;
  const before = fns.length;
  fns[0]();                           // the first, retired chain fires
  assert.equal(renderer.pendingFrame, false);
  assert.equal(fns.length, before, "a retired chain re-requested itself");
});

test("draw: NaN view components never reach the GPU", () => {
  const gl = fakeGl();
  const sent = [];
  gl.uniform1f = (loc, value) => sent.push(value);
  const renderer = new Renderer(fakeCanvas(gl), fakeVideo());
  renderer.draw({ yaw: NaN, pitch: Infinity, roll: undefined, blur: NaN });
  assert.ok(sent.every(Number.isFinite));
});

test("restore: a failed rebuild leaves the renderer lost instead of throwing", () => {
  const gl = fakeGl();
  const canvas = fakeCanvas(gl);
  const renderer = new Renderer(canvas, fakeVideo());
  canvas.fire("webglcontextlost", { preventDefault() {} });
  gl.getProgramParameter = () => false;
  gl.getProgramInfoLog = () => "context lost again";
  assert.doesNotThrow(() => canvas.fire("webglcontextrestored"));
  assert.equal(renderer.lost, true);
});
