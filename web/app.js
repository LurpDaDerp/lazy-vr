/* Equirectangular 360 playback steered by gaze.
 *
 * The server sends the turn *rate* the viewer is asking for.  This file owns
 * where the view actually points, because what carries that request out is
 * meant to read as a head rather than a filter, and a head has mass: a real
 * turn has a bell-shaped velocity profile -- gradual onset, a peak in the
 * middle, a firmer stop -- which a 30 Hz stream of angles cannot describe.
 * So the body is simulated here, at display rate.
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
  // land on the same texel.  The branch is on a uniform, so every fragment
  // takes the same side of it and it costs nothing.
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

const canvas = document.getElementById("view");
const video = document.getElementById("video");
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });

if (!gl) {
  document.getElementById("overlaytext").textContent =
    "This browser has no WebGL2, which the 360 renderer needs.";
}

/* ---------- the body ---------- */

const DEG = Math.PI / 180;

/* What the shader is given, in radians. */
const view = { yaw: 0, pitch: 0, roll: 0, blur: 0, fov: 75 * DEG };

/* The body carrying the view, in degrees.  Kept separate from `view` because
 * the sway is added on the way out and must not accumulate. */
const body = {
  yaw: 0, pitch: 0,
  yawRate: 0, pitchRate: 0,   // degrees per second
  yawAccel: 0,                // degrees per second squared, drives the roll
  strain: 0,                  // 0 free, 1 at the end of the neck
  roll: 0,
  // Its own clock, accumulated from the frame steps rather than read off the
  // wall, so the sway is tied to the same time base as the motion.
  clock: 0,
};

/* How hard the body chases the rate it was asked for.  Asymmetric on purpose:
 * heads decelerate faster than they accelerate, and the firmer stop is also
 * what keeps a sweep from feeling like it coasts past where you wanted it.
 * These set the settle once the acceleration clamp has stopped biting, so
 * raising them sharpens the last part of a change of direction. */
const K_UP = 6.0;
const K_DOWN = 10.0;

/* The acceleration ceiling is what shapes a turn.  Far from the requested
 * rate the clamp saturates and the speed ramps linearly; close to it the
 * spring term takes over and it settles.  Trapezoid on the way out,
 * exponential on the way in -- near enough a real turn for two lines.
 *
 * Deliberately no overshoot, tempting though a real head's is: the viewer's
 * own gaze is already a feedback element in this loop, and underdamped
 * machine dynamics plus a human chasing them is how you get a view that
 * hunts. Critically damped or a shade above, and no further.
 *
 * This is the number that decides how quickly a change of gaze becomes a
 * change of motion, since any sizeable change starts out clamped by it. */
const A_MAX = 380;

/* A neck has an end, and it is not a box.  The head can turn 120 degrees
 * either way and look 90 up or down -- but not both at once: turned right
 * round to the side there is nothing left for looking up, and vice versa.
 * The reachable set is an ellipse in (yaw, pitch), and where the head sits
 * inside it is a single number, its radius: 0 at rest, 1 at the limit.
 *
 * Inside the comfort radius the neck is free.  Beyond it turning further
 * costs effort that climbs steeply as the limit nears, and at the limit the
 * outward component of any request is gone -- the hard stop.  Only the
 * outward part is taxed: coming back is always free, as a real neck springs
 * back, and sliding along the boundary (trading yaw for pitch) is only
 * mildly resisted. */
const YAW_LIMIT = 120;
const PITCH_LIMIT = 90;
const NECK_COMFORT = 0.5;      // radius inside which the neck is unloaded
const STRAIN_POWER = 2.2;      // how steeply the resistance climbs past it
const STRAIN_TANGENTIAL = 0.8; // how much sliding along the limit is taxed
const STRAIN_TREMOR = 0.12;    // degrees of shake at full strain

const K_ROLL = 2.5 / A_MAX;  // a full-tilt acceleration leans it 2.5 degrees
const MAX_ROLL = 2.5;
const MAX_BLUR = 6 * DEG;

/* Bringing the view back to where the clip started.  A sweep, not a snap:
 * the whole point of the body is that it has mass, and teleporting the
 * camera would throw every bit of that away.  Proportional to how far there
 * is left to go, so it sets off briskly and arrives gently -- and it goes
 * through the same acceleration limit as everything else, so it starts and
 * stops like a turn rather than a cut. */
const HOME_GAIN = 2.5;      // per second
const HOME_SETTLED = 0.4;   // degrees, near enough to call it home
let homing = false;

let started = false;
let calibrated = false;

function wrapDegrees(angle) {
  return angle - 360 * Math.floor((angle + 180) / 360);
}

/* One octave of value noise: smooth, deterministic, no library. */
function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x) {
  const whole = Math.floor(x), part = x - whole;
  const smooth = part * part * (3 - 2 * part);
  return (hash(whole) * (1 - smooth) + hash(whole + 1) * smooth) * 2 - 1;
}

function approachRate(current, goal, dt) {
  const stiffness = Math.abs(goal) > Math.abs(current) ? K_UP : K_DOWN;
  const accel = clamp((goal - current) * stiffness, A_MAX);
  return { rate: current + accel * dt, accel };
}

/* Where the head sits in the neck's reachable ellipse: its radius (0 at
 * rest, 1 at the limit) and the outward unit direction, in the normalised
 * space where the ellipse is a circle. */
function neckRadius(yaw, pitch) {
  const nx = yaw / YAW_LIMIT, ny = pitch / PITCH_LIMIT;
  const r = Math.hypot(nx, ny);
  return { r, ux: r > 1e-9 ? nx / r : 0, uy: r > 1e-9 ? ny / r : 0 };
}

/* How much of the neck's give is used up, 0 to 1.  Nothing inside the
 * comfort radius, then a curve that starts gently and steepens, so the first
 * resistance is barely there and the last few degrees are hard won. */
function neckStrain(r) {
  const past = (r - NECK_COMFORT) / (1 - NECK_COMFORT);
  return past <= 0 ? 0 : Math.min(1, Math.pow(past, STRAIN_POWER));
}

/* Put a requested rate through the neck.  The outward component is scaled
 * by what give remains; the tangential component only mildly; inward is
 * untouched. */
function resist(yawRate, pitchRate) {
  const { r, ux, uy } = neckRadius(body.yaw, body.pitch);
  const strain = neckStrain(r);
  body.strain = strain;
  if (strain <= 0) return { yawRate, pitchRate };
  // Into the normalised space, where "outward" is a clean direction.
  const vx = yawRate / YAW_LIMIT, vy = pitchRate / PITCH_LIMIT;
  const outward = vx * ux + vy * uy;
  const tx = vx - outward * ux, ty = vy - outward * uy;
  const give = 1 - strain;
  const along = outward > 0 ? outward * give : outward;
  const slide = 1 - STRAIN_TANGENTIAL * strain;
  const rx = along * ux + tx * slide, ry = along * uy + ty * slide;
  return { yawRate: rx * YAW_LIMIT, pitchRate: ry * PITCH_LIMIT };
}

/* The hard stop.  The rate limiting above means the body arrives slowly,
 * but it has momentum and can still cross the line by a hair; put it back
 * on the line and take the outward velocity away, so it rests against the
 * limit rather than bouncing off it. */
function holdAtLimit() {
  const { r, ux, uy } = neckRadius(body.yaw, body.pitch);
  if (r <= 1) return;
  body.yaw = ux * YAW_LIMIT;
  body.pitch = uy * PITCH_LIMIT;
  const vx = body.yawRate / YAW_LIMIT, vy = body.pitchRate / PITCH_LIMIT;
  const outward = vx * ux + vy * uy;
  if (outward > 0) {
    body.yawRate = (vx - outward * ux) * YAW_LIMIT;
    body.pitchRate = (vy - outward * uy) * PITCH_LIMIT;
  }
}

function stepBody(dt) {
  let askedYaw = packet.yaw_rate || 0;
  let askedPitch = packet.pitch_rate || 0;

  if (homing) {
    // Steering wins.  Nobody should have to sit out a sweep they have
    // changed their mind about.
    if (packet.committed && (askedYaw || askedPitch)) {
      homing = false;
    } else {
      const leftYaw = -body.yaw;
      const leftPitch = -body.pitch;
      askedYaw = leftYaw * HOME_GAIN;
      askedPitch = leftPitch * HOME_GAIN;
      const arrived = Math.abs(leftYaw) < HOME_SETTLED
        && Math.abs(leftPitch) < HOME_SETTLED
        && Math.abs(body.yawRate) < 2 && Math.abs(body.pitchRate) < 2;
      if (arrived) {
        homing = false;
        body.yaw = body.pitch = 0;
        body.yawRate = body.pitchRate = 0;
      }
    }
  }

  const want = resist(
    clamp(askedYaw, packet.max_rate_yaw || 120),
    clamp(askedPitch, packet.max_rate_pitch || 90));

  const turned = approachRate(body.yawRate, want.yawRate, dt);
  body.yawRate = turned.rate;
  body.yawAccel = turned.accel;
  body.pitchRate = approachRate(body.pitchRate, want.pitchRate, dt).rate;

  body.yaw += body.yawRate * dt;
  body.pitch += body.pitchRate * dt;
  holdAtLimit();

  // A head leans into a turn.  Driven by acceleration rather than speed, so
  // the lean happens at the two ends of a sweep instead of throughout it.
  const wantRoll = clamp(-K_ROLL * body.yawAccel, MAX_ROLL);
  body.roll += (wantRoll - body.roll) * Math.min(1, dt * 6);

  // Idle sway.  A perfectly still camera is the plainest tell that there is
  // no body behind it, so it never quite stops -- but it fades out the
  // moment the view is genuinely turning, where it would just be noise.
  const speed = Math.hypot(body.yawRate, body.pitchRate);
  const calm = 1 - Math.min(1, speed / 40);
  const t = (body.clock += dt);
  const swayYaw = calm * (noise(t * 0.18) * 0.18 + noise(t * 0.36 + 11) * 0.07);
  const swayPitch = calm * (noise(t * 0.15 + 5) * 0.11 + noise(t * 0.30 + 23) * 0.04);
  // A neck held near its limit is not steady.  Faster and finer than the
  // sway, and only there when the strain is.
  const shake = STRAIN_TREMOR * body.strain * body.strain;
  const tremorYaw = shake * noise(t * 7.3 + 41);
  const tremorPitch = shake * noise(t * 8.1 + 57);

  view.yaw = (body.yaw + swayYaw + tremorYaw) * DEG;
  view.pitch = (body.pitch + swayPitch + tremorPitch) * DEG;
  view.roll = body.roll * DEG;
  // Smear along the direction of travel over one exposure.  As well as being
  // what a turning head sees, it hides the judder a 30 Hz gaze pipeline puts
  // into a fast rotation.
  view.blur = Math.min(MAX_BLUR, Math.abs(body.yawRate) * DEG * dt);
}

function restBody() {
  homing = false;
  body.yaw = body.pitch = body.roll = body.clock = body.strain = 0;
  body.yawRate = body.pitchRate = body.yawAccel = 0;
  view.yaw = view.pitch = view.roll = view.blur = 0;
}

/* Turn back to where the clip started.  Distinct from recalibrating, which
 * re-measures where the viewer's eyes sit: this moves the view, not the
 * reference it is measured from. */
function goHome() {
  if (browsing || !calibrated) return;
  const away = Math.abs(body.yaw) + Math.abs(body.pitch);
  if (away < HOME_SETTLED) {
    toast("Already facing the start");
    return;
  }
  homing = true;
  toast("Turning back to the start");
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
    roll: gl.getUniformLocation(program, "uRoll"),
    fov: gl.getUniformLocation(program, "uFov"),
    blur: gl.getUniformLocation(program, "uBlur"),
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
  reportScreen();
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
  gl.uniform1f(uniforms.roll, view.roll);
  gl.uniform1f(uniforms.fov, view.fov);
  gl.uniform1f(uniforms.blur, view.blur);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* ---------- the loop ---------- */

let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (started && calibrated) stepBody(dt);

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
  turn: document.getElementById("turn"),
  neck: document.getElementById("neck"),
  perf: document.getElementById("perf"),
  north: document.getElementById("compassnorth"),
  overlay: document.getElementById("overlay"),
  overlaytext: document.getElementById("overlaytext"),
  progress: document.getElementById("progress"),
  progresswrap: document.getElementById("progresswrap"),
  needle: document.getElementById("compassneedle"),
  marks: document.getElementById("compassmarks"),
  dot: document.getElementById("fixation"),
  toast: document.getElementById("toast"),
  grid: document.getElementById("grid"),
  notice: document.getElementById("libnotice"),
  count: document.getElementById("libcount"),
  empty: document.getElementById("libempty"),
  dir: document.getElementById("libdir"),
};

let packet = { deadzone_yaw: 2, deadzone_pitch: 1, span_yaw: 12, span_pitch: 12 };
let lastPacketAt = 0;

const source = new EventSource("/gaze");
source.onmessage = (event) => {
  packet = JSON.parse(event.data);
  lastPacketAt = performance.now();
  render(packet);
};

/* A rate cannot be held safely while the tracker is quiet: repeated forever
 * it would spin the viewer round and round.  Silence has to be read as
 * "stop".  The server zeroes a stale packet too; this covers the case where
 * the packets themselves stopped arriving. */
setInterval(() => {
  if (lastPacketAt && performance.now() - lastPacketAt > 400) {
    el.state.textContent = "no signal";
    el.state.className = "val bad";
    packet.yaw_rate = 0;
    packet.pitch_rate = 0;
  }
}, 200);

const WARN = { "low confidence": 1, calibrating: 1, committing: 1, stalled: 1 };

let toastTimer = null;

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("on"), 2400);
}

function render(p) {
  if (!calibrated && started && awaitingGeneration !== null
      && p.generation >= awaitingGeneration) {
    el.progress.style.width = `${Math.round(p.calibration * 100)}%`;
    // The bar going backwards on its own would be baffling, so say why.
    if (p.calibration_resets !== seenResets) {
      seenResets = p.calibration_resets;
      lookAgain();
    }
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
  // What is being asked for, next to what the body is actually doing.
  el.rate.textContent =
    `${p.yaw_rate >= 0 ? "+" : ""}${p.yaw_rate.toFixed(0)}, ` +
    `${p.pitch_rate >= 0 ? "+" : ""}${p.pitch_rate.toFixed(0)}°/s`;
  el.turn.textContent =
    `${body.yawRate >= 0 ? "+" : ""}${body.yawRate.toFixed(0)}, ` +
    `${body.pitchRate >= 0 ? "+" : ""}${body.pitchRate.toFixed(0)}°/s`;
  el.neck.textContent = body.strain <= 0 ? "free"
    : body.strain >= 0.999 ? "at the limit"
    : `${Math.round(body.strain * 100)}% strained`;
  el.neck.className = "val" + (body.strain >= 0.999 ? " bad" : body.strain > 0.5 ? " warn" : "");
  el.perf.textContent = `${p.gaze_fps.toFixed(0)} Hz  ${p.latency_ms.toFixed(0)} ms`;
  drawStick(p);
}

/* The strip shows a quarter of the turn across its full width, so a mark
 * sits at (its bearing relative to the centre) / 90 of the way across. */
const COMPASS_SPAN = 90;

function updateCompass() {
  const heading = ((-view.yaw / DEG) % 360 + 360) % 360;
  el.marks.style.backgroundPositionX = `${-heading / 360 * 4 * el.marks.clientWidth}px`;

  // Every tick looks alike, so the strip alone cannot say which way is which.
  // Mark the bearing the clip starts at, and hide it when it is behind you.
  const bearing = wrapDegrees(-heading);
  const visible = Math.abs(bearing) <= COMPASS_SPAN / 2;
  el.north.style.display = visible ? "" : "none";
  if (visible) el.north.style.left = `${50 + (bearing / COMPASS_SPAN) * 100}%`;
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

function send(action, extra) {
  return fetch("/cmd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  })
    .then((response) => response.json())
    .catch(() => null);
}

/* How the two axes are geared against each other depends on the shape of the
 * screen: a wide one gives the eyes more room to sweep sideways than up and
 * down, and only the page knows what shape it is.  Reported from the canvas
 * rather than from `screen`, because what matters is the picture the eyes are
 * actually crossing -- which changes when the window is resized or when
 * fullscreen swallows the browser chrome. */
let reportedAspect = 0;

function reportScreen() {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  if (!isFinite(aspect) || aspect <= 0) return;
  // resize() runs every frame; only speak up when the shape actually moved.
  if (Math.abs(aspect - reportedAspect) < 0.02) return;
  reportedAspect = aspect;
  send("screen", { aspect });
}

/* Which centring pass the page is waiting on.  Python starts collecting the
 * moment it launches, long before this tab exists, so the stream is already
 * reporting a finished pass.  Without matching generations the first packet
 * after the countdown satisfies the progress bar and the whole step vanishes
 * before the viewer has seen it. */
let awaitingGeneration = null;
/* Calibration is a fixation test: the server counts how long the gaze has
 * held one spot and starts the count again the moment it wanders.  This is
 * how many restarts the page has already told the viewer about. */
let seenResets = 0;
let calibrationHeadline = "Look at the dot.";
/* Where the eyes sit is a property of the viewer, not of the clip, so one
 * pass covers the whole visit.  C forces another. */
let everCalibrated = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lookAgain() {
  el.overlaytext.innerHTML =
    `${calibrationHeadline}<br><span class="count away">You looked away</span>`;
  el.dot.classList.add("nudge");
  setTimeout(() => el.dot.classList.remove("nudge"), 600);
}

async function runCalibration(headline) {
  calibrated = false;
  awaitingGeneration = null;
  calibrationHeadline = headline;
  seenResets = packet.calibration_resets || 0;
  restBody();

  el.overlay.classList.remove("gone");
  el.overlay.classList.add("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.add("on");

  // Count down before sampling starts, so the hold begins while the viewer
  // is already fixed on the dot rather than still moving onto it.
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
  everCalibrated = true;
  awaitingGeneration = null;
  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.remove("on");
  // Held at the first frame while the centring pass ran; let it go now.
  if (!browsing) {
    video.currentTime = 0;
    video.play().catch(() => {});
  }
}

/* ---------- the library ---------- */

/* Cards are kept and reused across polls rather than rebuilt.  Rebuilding
 * would restart every thumbnail's download and kill the sweep under the
 * pointer each time a download finishes elsewhere in the folder. */
const cards = new Map();
let browsing = true;
let playing = null;  // the clip on screen, for anything that has to name it

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return null;
  const whole = Math.round(seconds);
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts
    .map((part, index) => (index ? String(part).padStart(2, "0") : String(part)))
    .join(":");
}

function makeCard(clip) {
  const root = document.createElement("button");
  root.className = "card";
  root.type = "button";

  const strip = document.createElement("span");
  strip.className = "strip waiting";
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.hidden = true;
  strip.append(image, badge);

  const title = document.createElement("span");
  title.className = "cardtitle";
  const meta = document.createElement("span");
  meta.className = "cardmeta mono";

  root.append(strip, title, meta);
  root.addEventListener("click", () => selectClip(clip.id, clip.title));
  return { root, strip, image, badge, title, meta };
}

function updateCard(card, clip) {
  card.title.textContent = clip.title;
  // A clip that is still being written has no index and no end yet, so it
  // is listed but cannot be picked.
  card.root.disabled = !clip.settled;
  card.root.classList.toggle("downloading", !clip.settled);
  card.root.setAttribute(
    "aria-label",
    clip.settled
      ? `Play ${clip.title}${clip.quality ? `, ${clip.quality}` : ""}`
      : `${clip.title} — still downloading`);

  if (clip.thumb) {
    const source = `/thumb/${clip.id}`;
    // Only assign once: reassigning the same URL restarts the fetch.
    if (card.image.getAttribute("src") !== source) card.image.src = source;
    card.strip.classList.remove("waiting");
  }

  card.badge.hidden = !clip.quality;
  if (clip.quality) card.badge.textContent = clip.quality;

  const facts = clip.settled
    ? [formatDuration(clip.duration)].filter(Boolean)
    : ["downloading"];
  card.meta.textContent = "";
  facts.forEach((fact, index) => {
    if (index) card.meta.appendChild(document.createElement("i"));
    const span = document.createElement("span");
    span.textContent = fact;
    card.meta.appendChild(span);
  });
}

function summarise(data) {
  if (!data.total) return "No clips found";
  const playable = data.total - data.downloading;
  const parts = [`${playable} clip${playable === 1 ? "" : "s"}`];
  if (data.downloading) parts.push(`${data.downloading} still downloading`);
  if (!data.tools) parts.push("ffmpeg not found, so no thumbnails");
  else if (data.ready < playable) parts.push(`thumbnails ${data.ready}/${playable}`);
  return parts.join(" · ");
}

function renderLibrary(data) {
  if (el.dir) el.dir.textContent = data.directory;
  const present = new Set();

  for (const clip of data.clips) {
    present.add(clip.id);
    let card = cards.get(clip.id);
    if (!card) {
      card = makeCard(clip);
      cards.set(clip.id, card);
    }
    updateCard(card, clip);
  }
  for (const [id, card] of cards) {
    if (!present.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
  // Re-append in the server's order.  Moving an existing node does not
  // reload its picture, so a clip that lands mid-download slots into
  // place without disturbing the rest of the grid.
  el.grid.append(...data.clips.map((clip) => cards.get(clip.id).root));

  el.empty.hidden = data.total > 0;
  el.count.textContent = summarise(data);
  return data;
}

async function loadLibrary() {
  try {
    const response = await fetch("/library", { cache: "no-store" });
    if (!response.ok) throw new Error(response.status);
    return renderLibrary(await response.json());
  } catch {
    el.count.textContent = "Cannot reach the server";
    return null;
  }
}

/* Poll while the grid is on screen: clips are still downloading and their
 * thumbnails are still being built, so the page fills in as they arrive. */
async function watchLibrary() {
  for (;;) {
    const data = browsing ? await loadLibrary() : null;
    const settled = data && !data.downloading
    && data.ready === data.total && data.total;
    await wait(settled && !browsing ? 5000 : settled ? 4000 : 2000);
  }
}

/* ---------- picking a clip ---------- */

function selectClip(id, title) {
  if (!browsing) return;
  browsing = false;
  started = true;
  playing = { id, title };
  el.notice.hidden = true;
  document.body.classList.remove("browsing");

  video.loop = false;
  video.src = `/video/${id}`;
  video.load();
  // Chrome only lets script call play() on an element a person has already
  // started.  Start it here, inside the click, and hold it on the first
  // frame until the centring pass is done -- otherwise the clip would be
  // several seconds in by the time the overlay lifts.
  const gesture = video.play();
  if (gesture) {
    gesture.then(() => { if (!calibrated) video.pause(); }).catch(() => {});
  }

  if (everCalibrated) {
    // Where this viewer's eyes sit has not changed since the last clip, so
    // there is nothing to measure again.  Straight into the video.
    calibrated = true;
    restBody();
    el.overlay.classList.add("gone");
    video.currentTime = 0;
    video.play().catch(() => {});
    toast("Using the calibration from earlier — press C to redo it");
  } else {
    runCalibration("Look at the dot.");
  }
  watchForBackgroundedTab();
  return title;
}

function returnToLibrary() {
  browsing = true;
  started = false;
  calibrated = false;
  playing = null;
  awaitingGeneration = null;

  video.pause();
  // Drop the range request as well as the picture; a 4 GB clip should not
  // keep streaming behind the grid.
  video.removeAttribute("src");
  video.load();

  restBody();

  el.overlay.classList.add("gone");
  el.overlay.classList.remove("calibrating");
  el.progresswrap.classList.remove("on");
  el.dot.classList.remove("on");
  document.body.classList.add("browsing");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  loadLibrary();
}

video.addEventListener("ended", returnToLibrary);

/* A clip the browser cannot decode, or one the server refused because it is
 * still downloading, would otherwise leave the viewer staring at a dot that
 * never goes away. */
video.addEventListener("error", () => {
  if (browsing || !video.getAttribute("src")) return;
  const title = playing ? playing.title : "That clip";
  returnToLibrary();
  notify(`${title} would not play. It may still be downloading, or the file may be damaged.`);
});

function notify(message) {
  el.notice.textContent = message;
  el.notice.hidden = false;
}

/* Chrome will not fetch media for a tab that is not in the foreground: the
 * request is simply never issued, so the sphere stays black with no error
 * anywhere. Say so instead of leaving a blank screen, and retry the moment the
 * tab is looked at. */
let watchingTab = false;
function watchForBackgroundedTab() {
  if (watchingTab) return;  // one watcher, however many clips get played
  watchingTab = true;
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
  // While the grid is up the keys belong to it: arrows and space scroll,
  // Tab and Enter pick a card.  Only the player's keys are intercepted.
  if (browsing) return;

  if (event.key === "Escape") {
    returnToLibrary();
  } else if (key === "r" && started) {
    goHome();
  } else if (key === "c" && started) {
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

// Tell the server what shape of screen it is steering, before anything asks
// to be steered.  Without WebGL the loop never runs, so resize() never does.
reportScreen();
watchLibrary();
