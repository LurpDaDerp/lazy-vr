/* Equirectangular 360 playback steered by gaze.
 *
 * The server sends the angle the view should point at.  This file eases
 * towards it every animation frame with a critically damped spring, which is
 * what turns 30 Hz of gaze into 60 Hz of motion: the target moves in steps,
 * the view moves continuously.  Critically damped means it never overshoots
 * and never oscillates, so it settles cleanly however hard the target jumps.
 *
 * Rendering is a fullscreen quad plus a fragment shader that turns each pixel
 * into a view ray and samples the equirectangular frame.  No sphere mesh, no
 * seam, no 3D library.
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
uniform float uFov;    // vertical field of view, radians
out vec4 frag;

const float PI = 3.14159265359;

void main() {
  // Screen position normalised on height, so the aspect ratio is honest.
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec3 dir = normalize(vec3(p.x, p.y, -0.5 / tan(uFov * 0.5)));

  // Pitch about the camera's own right, then yaw about world up: an FPS
  // camera, so the horizon never rolls.
  float cp = cos(uPitch), sp = sin(uPitch);
  dir = vec3(dir.x, cp * dir.y - sp * dir.z, sp * dir.y + cp * dir.z);
  float cy = cos(uYaw), sy = sin(uYaw);
  dir = vec3(cy * dir.x + sy * dir.z, dir.y, -sy * dir.x + cy * dir.z);

  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  frag = texture(uTex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}`;

const canvas = document.getElementById("view");
const video = document.getElementById("video");
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });

if (!gl) {
  document.getElementById("overlaytext").textContent =
    "This browser has no WebGL2, which the 360 renderer needs.";
}

/* ---------- view state ---------- */

const view = { yaw: 0, pitch: 0, fov: 75 * Math.PI / 180 };
const target = { yaw: 0, pitch: 0 };
const velocity = { yaw: 0, pitch: 0 };
const DEG = Math.PI / 180;

/* Seconds to close most of the gap to the target. Low enough to feel
 * immediate, high enough to absorb the gaze estimate's jitter. */
let smoothTime = 0.13;

let started = false;
let calibrated = false;

/* Critically damped spring (the standard SmoothDamp formulation).  Solved
 * per step rather than Euler-integrated, so it stays stable no matter how
 * long a frame takes -- a dropped frame must not make the view explode. */
function ease(current, goal, axis, dt) {
  const omega = 2 / Math.max(smoothTime, 1e-4);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const gap = current - goal;
  const temp = (velocity[axis] + omega * gap) * dt;
  velocity[axis] = (velocity[axis] - omega * temp) * decay;
  return goal + (gap + temp) * decay;
}

/* ---------- GL setup ---------- */

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

let program, uniforms, texture;

function initGL() {
  program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, "pos");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // REPEAT on longitude closes the 0/360 seam in hardware.  WebGL2 allows it
  // on a non-power-of-two texture; WebGL1 would not.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  uniforms = {
    res: gl.getUniformLocation(program, "uRes"),
    yaw: gl.getUniformLocation(program, "uYaw"),
    pitch: gl.getUniformLocation(program, "uPitch"),
    fov: gl.getUniformLocation(program, "uFov"),
  };
}

function resize() {
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * scale);
  const height = Math.round(canvas.clientHeight * scale);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

/* Upload only on a genuinely new video frame: the clip is 30 fps and the
 * display is usually 60, so this halves a 3840x1920 texture upload. */
let pendingFrame = false;
function watchFrames() {
  if (!video.requestVideoFrameCallback) {
    pendingFrame = true;
    return;
  }
  video.requestVideoFrameCallback(() => {
    pendingFrame = true;
    watchFrames();
  });
}

function draw() {
  if (pendingFrame && video.readyState >= 2) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
    if (video.requestVideoFrameCallback) pendingFrame = false;
  }
  gl.uniform2f(uniforms.res, canvas.width, canvas.height);
  gl.uniform1f(uniforms.yaw, view.yaw);
  gl.uniform1f(uniforms.pitch, view.pitch);
  gl.uniform1f(uniforms.fov, view.fov);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ---------- the loop ---------- */

let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (started && calibrated) {
    // Both axes ease independently and simultaneously.
    view.yaw = ease(view.yaw, target.yaw, "yaw", dt);
    view.pitch = ease(view.pitch, target.pitch, "pitch", dt);
  }

  resize();
  draw();
  updateCompass();
  requestAnimationFrame(frame);
}

/* ---------- gaze stream ---------- */

const el = {
  state: document.getElementById("state"),
  heading: document.getElementById("heading"),
  gaze: document.getElementById("gaze"),
  rate: document.getElementById("rate"),
  perf: document.getElementById("perf"),
  overlay: document.getElementById("overlay"),
  overlaytext: document.getElementById("overlaytext"),
  begin: document.getElementById("begin"),
  progress: document.getElementById("progress"),
  progresswrap: document.getElementById("progresswrap"),
  needle: document.getElementById("compassneedle"),
  marks: document.getElementById("compassmarks"),
  dot: document.getElementById("fixation"),
};

let packet = { deadzone_yaw: 2, deadzone_pitch: 1, span_yaw: 12, span_pitch: 12 };
let lastPacketAt = 0;

const source = new EventSource("/gaze");
source.onmessage = (event) => {
  packet = JSON.parse(event.data);
  lastPacketAt = performance.now();
  target.yaw = packet.yaw * DEG;
  target.pitch = packet.pitch * DEG;
  if (packet.smooth_time) smoothTime = packet.smooth_time;
  render(packet);
};

/* An absolute target is safe to hold if the tracker goes quiet -- unlike a
 * rate, it cannot run away -- so this only reports the silence. */
setInterval(() => {
  if (lastPacketAt && performance.now() - lastPacketAt > 400) {
    el.state.textContent = "no signal";
    el.state.className = "val bad";
  }
}, 200);

const WARN = { "low confidence": 1, calibrating: 1, stalled: 1 };

function render(p) {
  if (!calibrated && started && awaitingGeneration !== null
      && p.generation >= awaitingGeneration) {
    el.progress.style.width = `${Math.round(p.calibration * 100)}%`;
    if (p.calibration >= 1) finishCalibration();
  }

  el.state.textContent = p.state;
  el.state.className = "val" +
    (p.state === "lost" || p.state === "stalled" ? " bad"
      : WARN[p.state] ? " warn" : "");

  const heading = ((-view.yaw / DEG) % 360 + 360) % 360;
  el.heading.textContent = `${heading.toFixed(0)}°`;
  el.gaze.textContent =
    `${p.yaw_error >= 0 ? "+" : ""}${p.yaw_error.toFixed(1)}, ` +
    `${p.pitch_error >= 0 ? "+" : ""}${p.pitch_error.toFixed(1)}`;
  el.rate.textContent =
    `${p.yaw >= 0 ? "+" : ""}${p.yaw.toFixed(0)}, ` +
    `${p.pitch >= 0 ? "+" : ""}${p.pitch.toFixed(0)}°`;
  el.perf.textContent = `${p.gaze_fps.toFixed(0)} Hz  ${p.latency_ms.toFixed(0)} ms`;
  drawStick(p);
}

function updateCompass() {
  const heading = ((-view.yaw / DEG) % 360 + 360) % 360;
  el.marks.style.backgroundPositionX = `${-heading / 360 * 4 * el.marks.clientWidth}px`;
}

/* ---------- the deadzone widget ---------- */

const stick = document.getElementById("stick").getContext("2d");

/* The axes are geared and dead-zoned independently, so the widget draws
 * rectangles, not circles: the dead area really is a box, and it is wider
 * than it is tall because pitch is the more sensitive axis. */
function drawStick(p) {
  const size = 150, c = size / 2, pad = 10;
  const sx = (c - pad) / Math.max(p.span_yaw, 1);
  const sy = (c - pad) / Math.max(p.span_pitch, 1);
  stick.clearRect(0, 0, size, size);

  stick.strokeStyle = "rgba(255,255,255,.16)";
  stick.lineWidth = 1;
  stick.strokeRect(c - p.span_yaw * sx, c - p.span_pitch * sy,
                   2 * p.span_yaw * sx, 2 * p.span_pitch * sy);

  // Inside this box nothing moves.
  stick.strokeStyle = "rgba(255,255,255,.30)";
  stick.setLineDash([3, 3]);
  stick.strokeRect(c - p.deadzone_yaw * sx, c - p.deadzone_pitch * sy,
                   2 * p.deadzone_yaw * sx, 2 * p.deadzone_pitch * sy);
  stick.setLineDash([]);

  stick.strokeStyle = "rgba(255,255,255,.10)";
  stick.beginPath();
  stick.moveTo(c, 6); stick.lineTo(c, size - 6);
  stick.moveTo(6, c); stick.lineTo(size - 6, c);
  stick.stroke();

  // Mirrored in x to agree with the mirrored webcam preview above it.
  const x = c - clamp(p.yaw_error, p.span_yaw) * sx;
  const y = c - clamp(p.pitch_error, p.span_pitch) * sy;
  const live = p.yaw !== 0 || p.pitch !== 0;
  if (live) {
    stick.strokeStyle = "rgba(110,231,183,.55)";
    stick.lineWidth = 2;
    stick.beginPath();
    stick.moveTo(c, c);
    stick.lineTo(x, y);
    stick.stroke();
  }
  stick.fillStyle = live ? "#6ee7b7" : "rgba(255,255,255,.55)";
  stick.beginPath();
  stick.arc(x, y, 5, 0, 2 * Math.PI);
  stick.fill();
}

function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

/* ---------- start-up and keys ---------- */

function send(action) {
  return fetch("/cmd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  })
    .then((response) => response.json())
    .catch(() => null);
}

/* Which centring pass the page is waiting on.  Python starts collecting the
 * moment it launches, long before this tab exists, so the stream is already
 * reporting a finished pass.  Without matching generations the first packet
 * after the countdown satisfies the progress bar and the whole step vanishes
 * before the viewer has seen it. */
let awaitingGeneration = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCalibration(headline) {
  calibrated = false;
  awaitingGeneration = null;
  velocity.yaw = velocity.pitch = 0;
  target.yaw = target.pitch = 0;
  view.yaw = view.pitch = 0;

  el.overlay.classList.remove("gone");
  el.overlay.classList.add("calibrating");
  el.begin.classList.add("gone");
  el.progresswrap.classList.remove("on");
  el.dot.classList.add("on");

  // Count down before sampling starts, so the samples are taken while the
  // viewer is already fixed on the dot rather than still moving onto it.
  for (let count = 3; count > 0; count--) {
    el.overlaytext.innerHTML = `${headline}<br><span class="count">${count}</span>`;
    await wait(1000);
  }
  el.overlaytext.innerHTML = `${headline}<br><span class="count">hold still…</span>`;
  el.progress.style.width = "0%";
  el.progresswrap.classList.add("on");

  const reply = await send("recenter");
  // If the command did not get through, accept any pass rather than leave the
  // viewer staring at a dot forever.
  awaitingGeneration =
    reply && typeof reply.result === "number" ? reply.result : 0;
}

function finishCalibration() {
  calibrated = true;
  awaitingGeneration = null;
  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.remove("on");
}

el.begin.addEventListener("click", () => {
  started = true;
  video.loop = true;
  video.play().catch(() => {});
  runCalibration("Look at the dot.");
  watchForBackgroundedTab();
});

/* Chrome will not fetch media for a tab that is not in the foreground: the
 * request is simply never issued, so the sphere stays black with no error
 * anywhere. Say so instead of leaving a blank screen, and retry the moment the
 * tab is looked at. */
function watchForBackgroundedTab() {
  const hint = document.createElement("div");
  hint.id = "bghint";
  hint.textContent =
    "Bring this tab to the front — the browser will not load video in a background tab.";
  Object.assign(hint.style, {
    position: "fixed", bottom: "64px", left: "50%", transform: "translateX(-50%)",
    padding: "10px 18px", borderRadius: "8px", background: "rgba(251,191,36,.15)",
    border: "1px solid rgba(251,191,36,.5)", color: "#fbbf24", display: "none",
    backdropFilter: "blur(14px)",
  });
  document.body.appendChild(hint);

  setInterval(() => {
    const stuck = video.readyState === 0 && started;
    hint.style.display = stuck && document.visibilityState === "hidden" ? "" : "none";
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && video.readyState === 0) {
      video.load();
      video.play().catch(() => {});
      watchFrames();
    }
  });
}

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (key === "c" && started) {
    runCalibration("Recalibrating — look at the dot.");
  } else if (key === " ") {
    event.preventDefault();
    video.paused ? video.play() : video.pause();
  } else if (key === "f") {
    document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen().catch(() => {});
  } else if (key === "h") {
    document.body.classList.toggle("hidden-hud");
  } else if (event.key === "ArrowRight") {
    video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
  } else if (event.key === "ArrowLeft") {
    video.currentTime = Math.max(0, video.currentTime - 5);
  }
});

if (gl) {
  initGL();
  watchFrames();
  requestAnimationFrame(frame);
}
