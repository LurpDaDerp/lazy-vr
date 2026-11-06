/* Equirectangular 360 rendering for local files.
 *
 * A fullscreen triangle plus a fragment shader that turns each pixel into a
 * view ray and samples the equirect frame: no mesh, no seam, no 3D library.
 * The video is uploaded only on a genuinely new frame
 * (requestVideoFrameCallback).
 *
 * Field of view: the app's FOV is HORIZONTAL (the same semantic YouTube's
 * embed uses on desktop); the shader wants the vertical one, derived from
 * the canvas aspect in verticalFov().
 *
 * Sign contract, shared with embed.js: view.yaw > 0 turns the view to the
 * user's LEFT; view.pitch > 0 looks up.  directionFor() below mirrors the
 * shader so the tests can pin this.
 */

const VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uRes;
uniform float uYaw;    // radians, + turns left
uniform float uPitch;  // radians, + looks up
uniform float uRoll;   // radians
uniform float uFov;    // VERTICAL field of view, radians
uniform float uBlur;   // radians of yaw smeared across one exposure
out vec4 frag;

const float PI = 3.14159265359;
const int TAPS = 5;

vec4 sampleSphere(vec3 dir) {
  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  return texture(uTex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}

vec3 spin(vec3 dir, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec3(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);
}

void main() {
  // Normalised on height, so uFov is the vertical FOV and aspect is honest.
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float cr = cos(uRoll), sr = sin(uRoll);
  p = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y);

  vec3 dir = normalize(vec3(p.x, p.y, -0.5 / tan(uFov * 0.5)));

  // Pitch about the camera's right, then yaw about world up (FPS camera).
  float cp = cos(uPitch), sp = sin(uPitch);
  dir = vec3(dir.x, cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);
  dir = spin(dir, uYaw);

  if (uBlur < 0.0008) {
    frag = sampleSphere(dir);
    return;
  }
  vec4 total = vec4(0.0);
  for (int i = 0; i < TAPS; i++) {
    float step = (float(i) / float(TAPS - 1) - 0.5) * uBlur;
    total += sampleSphere(spin(dir, step));
  }
  frag = total / float(TAPS);
}`;

const DEG = Math.PI / 180;
const MAX_DPR = 2;

/* Horizontal FOV (radians) → vertical FOV for a width×height drawing area. */
export function verticalFov(hFovRad, width, height) {
  const h = Number.isFinite(hFovRad) ? Math.min(Math.max(hFovRad, 1e-3), Math.PI - 1e-3) : 100 * DEG;
  if (!(width > 0) || !(height > 0)) return h;
  return 2 * Math.atan(Math.tan(h / 2) * (height / width));
}

/* JS mirror of the shader's ray for a screen point p (normalised on height,
 * +x right, +y up).  Returns { lon, lat } in radians: lon > 0 is to the
 * right of the frame centre (texture u > 0.5), lat > 0 up.  Keep in step
 * with FS. */
export function directionFor(px, py, view, vFovRad) {
  const cr = Math.cos(view.roll || 0), sr = Math.sin(view.roll || 0);
  const x0 = cr * px - sr * py, y0 = sr * px + cr * py;
  let x = x0, y = y0, z = -0.5 / Math.tan(vFovRad / 2);
  const n = Math.hypot(x, y, z);
  x /= n; y /= n; z /= n;
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  [y, z] = [cp * y - sp * z, sp * y + cp * z];
  const c = Math.cos(view.yaw), s = Math.sin(view.yaw);
  [x, z] = [c * x + s * z, -s * x + c * z];
  return { lon: Math.atan2(x, -z), lat: Math.asin(Math.max(-1, Math.min(1, y))) };
}

export class Renderer {
  /* Throws if the browser has no WebGL2.  hFovDegrees is HORIZONTAL. */
  constructor(canvas, video, hFovDegrees = 100) {
    this.canvas = canvas;
    this.video = video;
    this.hFov = 100 * DEG;
    this.fov = hFovDegrees * DEG;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw new Error("This browser has no WebGL2, which the 360 renderer needs.");
    this.gl = gl;
    this.pendingFrame = false;
    this.lost = false;          // nothing may be drawn between loss and restore
    this.sizeDirty = true;      // re-measure the canvas before the next draw
    this.dpr = 0;
    this.frameGen = 0;          // invalidates superseded rVFC chains
    this.frameHandle = null;
    this.watchContext();
    this.watchSize();
    this.init();
    this.watchFrames();
    // A new source (src set, load()) restarts the frame chain: the browser
    // may drop the old chain's callback when the media element reloads.
    if (typeof video.addEventListener === "function") {
      video.addEventListener("loadeddata", () => this.rearm());
    }
  }

  /* Horizontal FOV in radians (the app's semantic); non-finite is ignored. */
  get fov() { return this.hFov; }
  set fov(radians) {
    if (Number.isFinite(radians) && radians > 0) this.hFov = Math.min(radians, Math.PI - 1e-3);
  }
  setFov(degrees) { this.fov = degrees * DEG; }

  /* Context loss (driver reset, GPU switch, memory pressure) is silent and
   * permanent unless handled: preventDefault earns the restore; init()
   * rebuilds every GL object on the new context. */
  watchContext() {
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      try {
        this.init();
      } catch {
        return; // stays lost; a later restore tries again
      }
      this.lost = false;
      // New texture is a black pixel and the viewport is unset; the canvas
      // kept its size, so resize() would not notice.
      this.pendingFrame = true;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    });
  }

  /* Resize only when the element actually changes size. */
  watchSize() {
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => { this.sizeDirty = true; });
      this.observer.observe(this.canvas);
    }
  }

  compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }

  init() {
    const gl = this.gl;
    const program = gl.createProgram();
    const shaders = [this.compile(gl.VERTEX_SHADER, VS), this.compile(gl.FRAGMENT_SHADER, FS)];
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    // The linked program keeps what it needs; free the shader objects so a
    // rebuild per context loss leaves nothing behind.
    for (const shader of shaders) { gl.detachShader(program, shader); gl.deleteShader(shader); }

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, "pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // REPEAT on longitude closes the 0/360 seam in hardware.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Black until the first frame; RGBA is the fast video-upload path.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.texWidth = 1;
    this.texHeight = 1;

    this.uniforms = {
      res: gl.getUniformLocation(program, "uRes"),
      yaw: gl.getUniformLocation(program, "uYaw"),
      pitch: gl.getUniformLocation(program, "uPitch"),
      roll: gl.getUniformLocation(program, "uRoll"),
      fov: gl.getUniformLocation(program, "uFov"),
      blur: gl.getUniformLocation(program, "uBlur"),
    };
  }

  /* Upload only on a genuinely new video frame.  Each call starts a fresh
   * chain and retires the previous one (cancelled where supported, ignored
   * by generation otherwise), so re-arming never doubles up. */
  watchFrames() {
    const video = this.video;
    if (typeof video.requestVideoFrameCallback !== "function") {
      this.pendingFrame = true;
      return;
    }
    if (this.frameHandle !== null && typeof video.cancelVideoFrameCallback === "function") {
      try { video.cancelVideoFrameCallback(this.frameHandle); } catch { /* already fired */ }
    }
    const gen = ++this.frameGen;
    const onFrame = () => {
      if (gen !== this.frameGen) return;
      this.pendingFrame = true;
      this.frameHandle = video.requestVideoFrameCallback(onFrame);
    };
    this.frameHandle = video.requestVideoFrameCallback(onFrame);
  }

  /* New source on the same element: upload its first frame, restart the chain. */
  rearm() {
    this.pendingFrame = true;
    this.watchFrames();
  }

  /* Set the video's source (optional) and re-arm.  Call with no argument
   * when src was already set elsewhere. */
  setSource(src) {
    if (src !== undefined) this.video.src = src;
    this.rearm();
  }

  /* Match the drawing buffer to the element.  Returns true if it changed.
   * Reads layout, so draw() only calls it when the size may have changed
   * (ResizeObserver fired, DPR changed, or there is no observer). */
  resize() {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    this.dpr = dpr;
    this.sizeDirty = typeof ResizeObserver !== "function";
    const scale = Math.min(dpr, MAX_DPR);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    return true;
  }

  draw(view) {
    if (this.lost) return;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    if (this.sizeDirty || dpr !== this.dpr) this.resize();
    const gl = this.gl;
    const video = this.video;
    if (this.pendingFrame && video.readyState >= 2 && video.videoWidth) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // Re-specify storage only on a size change; sub-image is far cheaper
      // for 4K+ frames.
      if (this.texWidth !== video.videoWidth || this.texHeight !== video.videoHeight) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.texWidth = video.videoWidth;
        this.texHeight = video.videoHeight;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
      }
      if (typeof video.requestVideoFrameCallback === "function") this.pendingFrame = false;
    }
    gl.uniform2f(this.uniforms.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.yaw, finiteOr0(view.yaw));
    gl.uniform1f(this.uniforms.pitch, finiteOr0(view.pitch));
    gl.uniform1f(this.uniforms.roll, finiteOr0(view.roll));
    gl.uniform1f(this.uniforms.fov, verticalFov(this.hFov, this.canvas.width, this.canvas.height));
    gl.uniform1f(this.uniforms.blur, finiteOr0(view.blur));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function finiteOr0(x) {
  return Number.isFinite(x) ? x : 0;
}
