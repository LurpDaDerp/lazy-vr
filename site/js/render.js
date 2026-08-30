/* Equirectangular 360 rendering.
 *
 * A fullscreen quad plus a fragment shader that turns each pixel into a view
 * ray and samples the equirectangular frame.  No sphere mesh, no seam, no 3D
 * library.  The video is uploaded as a texture only on a genuinely new
 * frame: a 30 fps clip on a 60 Hz display would otherwise upload the same
 * 8K frame twice.
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
uniform float uRoll;   // radians, the head leaning into a turn
uniform float uFov;    // vertical field of view, radians
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
  // Screen position normalised on height, so the aspect ratio is honest.
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  // Roll the sampling plane rather than the sphere: one rotation here
  // instead of three out there, and the result is identical.
  float cr = cos(uRoll), sr = sin(uRoll);
  p = vec2(cr * p.x - sr * p.y, sr * p.x + cr * p.y);

  vec3 dir = normalize(vec3(p.x, p.y, -0.5 / tan(uFov * 0.5)));

  // Pitch about the camera's own right, then yaw about world up: an FPS
  // camera, so the horizon never rolls of its own accord.
  float cp = cos(uPitch), sp = sin(uPitch);
  dir = vec3(dir.x, cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);
  dir = spin(dir, uYaw);

  // Under a fraction of a degree the smear is invisible and every tap would
  // land on the same texel.  The branch is on a uniform, so it costs nothing.
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

export class Renderer {
  /* Throws if the browser has no WebGL2. */
  constructor(canvas, video, fovDegrees = 75) {
    this.canvas = canvas;
    this.video = video;
    this.fov = fovDegrees * Math.PI / 180;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) throw new Error("This browser has no WebGL2, which the 360 renderer needs.");
    this.gl = gl;
    this.pendingFrame = false;
    this.init();
    this.watchFrames();
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
    gl.attachShader(program, this.compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, this.compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

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
    // A black frame until the first video frame arrives.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));

    this.uniforms = {
      res: gl.getUniformLocation(program, "uRes"),
      yaw: gl.getUniformLocation(program, "uYaw"),
      pitch: gl.getUniformLocation(program, "uPitch"),
      roll: gl.getUniformLocation(program, "uRoll"),
      fov: gl.getUniformLocation(program, "uFov"),
      blur: gl.getUniformLocation(program, "uBlur"),
    };
  }

  /* Upload only on a genuinely new video frame. */
  watchFrames() {
    if (!this.video.requestVideoFrameCallback) {
      this.pendingFrame = true;
      return;
    }
    this.video.requestVideoFrameCallback(() => {
      this.pendingFrame = true;
      this.watchFrames();
    });
  }

  /* Match the drawing buffer to the element.  Returns true if it changed. */
  resize() {
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(this.canvas.clientWidth * scale);
    const height = Math.round(this.canvas.clientHeight * scale);
    if (this.canvas.width === width && this.canvas.height === height) return false;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    return true;
  }

  draw(view) {
    const gl = this.gl;
    if (this.pendingFrame && this.video.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
      if (this.video.requestVideoFrameCallback) this.pendingFrame = false;
    }
    gl.uniform2f(this.uniforms.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.yaw, view.yaw);
    gl.uniform1f(this.uniforms.pitch, view.pitch);
    gl.uniform1f(this.uniforms.roll, view.roll);
    gl.uniform1f(this.uniforms.fov, this.fov);
    gl.uniform1f(this.uniforms.blur, view.blur);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
