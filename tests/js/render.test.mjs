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
