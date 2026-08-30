/* The body that carries a requested turn out.
 *
 * The control law sends the turn *rate* the viewer is asking for.  What
 * carries that request out is meant to read as a head rather than a filter,
 * and a head has mass: a real turn has a bell-shaped velocity profile --
 * gradual onset, a peak in the middle, a firmer stop -- which a 30 Hz stream
 * of angles cannot describe.  So the body is simulated here, at display
 * rate.  Pure: no DOM, no wall clock, so it can be stepped in a test.
 */

export const DEG = Math.PI / 180;

/* How hard the body chases the rate it was asked for.  Asymmetric on
 * purpose: heads decelerate faster than they accelerate, and the firmer stop
 * is also what keeps a sweep from feeling like it coasts past where you
 * wanted it. */
export const K_UP = 6.0;
export const K_DOWN = 10.0;

/* The acceleration ceiling is what shapes a turn.  Far from the requested
 * rate the clamp saturates and the speed ramps linearly; close to it the
 * spring term takes over and it settles.  Trapezoid on the way out,
 * exponential on the way in -- near enough a real turn for two lines.
 *
 * Deliberately no overshoot, tempting though a real head's is: the viewer's
 * own gaze is already a feedback element in this loop, and underdamped
 * machine dynamics plus a human chasing them is how you get a view that
 * hunts. */
export const A_MAX = 380;

/* A neck has an end, and it is not a box.  The head can turn 120 degrees
 * either way and look 90 up or down -- but not both at once: turned right
 * round to the side there is nothing left for looking up.  The reachable set
 * is an ellipse in (yaw, pitch), and where the head sits inside it is one
 * number, its radius: 0 at rest, 1 at the limit.
 *
 * Inside the comfort radius the neck is free.  Beyond it turning further
 * costs effort that climbs steeply as the limit nears, and at the limit the
 * outward component of any request is gone -- the hard stop.  Only the
 * outward part is taxed: coming back is always free, as a real neck springs
 * back, and sliding along the limit (trading yaw for pitch) crawls. */
export const YAW_LIMIT = 120;
export const PITCH_LIMIT = 90;
export const NECK_COMFORT = 0.5;
export const STRAIN_POWER = 2.2;
export const STRAIN_TANGENTIAL = 0.8;
export const STRAIN_TREMOR = 0.12;

export const K_ROLL = 2.5 / A_MAX;
export const MAX_ROLL = 2.5;
export const MAX_BLUR = 6 * DEG;

/* Bringing the view back to where the clip started.  A sweep, not a snap:
 * the whole point of the body is that it has mass.  Proportional to how far
 * there is left to go, so it sets off briskly and arrives gently. */
export const HOME_GAIN = 2.5;
export const HOME_SETTLED = 0.4;

export function clamp(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

/* One octave of value noise: smooth, deterministic, no library. */
function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

export function noise(x) {
  const whole = Math.floor(x), part = x - whole;
  const smooth = part * part * (3 - 2 * part);
  return (hash(whole) * (1 - smooth) + hash(whole + 1) * smooth) * 2 - 1;
}

/* Where the head sits in the neck's reachable ellipse: its radius and the
 * outward unit direction, in the normalised space where the ellipse is a
 * circle. */
export function neckRadius(yaw, pitch) {
  const nx = yaw / YAW_LIMIT, ny = pitch / PITCH_LIMIT;
  const r = Math.hypot(nx, ny);
  return { r, ux: r > 1e-9 ? nx / r : 0, uy: r > 1e-9 ? ny / r : 0 };
}

/* How much of the neck's give is used up, 0 to 1.  Nothing inside the
 * comfort radius, then a curve that starts gently and steepens, so the first
 * resistance is barely there and the last few degrees are hard won. */
export function neckStrain(r) {
  const past = (r - NECK_COMFORT) / (1 - NECK_COMFORT);
  return past <= 0 ? 0 : Math.min(1, Math.pow(past, STRAIN_POWER));
}

export class Body {
  constructor() {
    this.rest();
  }

  rest() {
    this.yaw = 0; this.pitch = 0;          // degrees
    this.yawRate = 0; this.pitchRate = 0;  // degrees per second
    this.yawAccel = 0;                     // drives the roll
    this.strain = 0;                       // 0 free, 1 at the end of the neck
    this.roll = 0;
    this.clock = 0;                        // its own time base, for the sway
    this.homing = false;
    // What the renderer is given, in radians.
    this.view = { yaw: 0, pitch: 0, roll: 0, blur: 0 };
  }

  /* Turn back to where the clip started.  Returns false if already there. */
  goHome() {
    if (Math.abs(this.yaw) + Math.abs(this.pitch) < HOME_SETTLED) return false;
    this.homing = true;
    return true;
  }

  approach(current, goal, dt) {
    const stiffness = Math.abs(goal) > Math.abs(current) ? K_UP : K_DOWN;
    const accel = clamp((goal - current) * stiffness, A_MAX);
    return { rate: current + accel * dt, accel };
  }

  /* Put a requested rate through the neck.  The outward component is
   * scaled by what give remains; the tangential component more mildly;
   * inward is untouched. */
  resist(yawRate, pitchRate) {
    const { r, ux, uy } = neckRadius(this.yaw, this.pitch);
    const strain = neckStrain(r);
    this.strain = strain;
    if (strain <= 0) return { yawRate, pitchRate };
    const vx = yawRate / YAW_LIMIT, vy = pitchRate / PITCH_LIMIT;
    const outward = vx * ux + vy * uy;
    const tx = vx - outward * ux, ty = vy - outward * uy;
    const along = outward > 0 ? outward * (1 - strain) : outward;
    const slide = 1 - STRAIN_TANGENTIAL * strain;
    return {
      yawRate: (along * ux + tx * slide) * YAW_LIMIT,
      pitchRate: (along * uy + ty * slide) * PITCH_LIMIT,
    };
  }

  /* The hard stop.  The body has momentum and can cross the line by a hair;
   * put it back on the line and take the outward velocity away, so it rests
   * against the limit rather than bouncing off it. */
  holdAtLimit() {
    const { r, ux, uy } = neckRadius(this.yaw, this.pitch);
    if (r <= 1) return;
    this.yaw = ux * YAW_LIMIT;
    this.pitch = uy * PITCH_LIMIT;
    const vx = this.yawRate / YAW_LIMIT, vy = this.pitchRate / PITCH_LIMIT;
    const outward = vx * ux + vy * uy;
    if (outward > 0) {
      this.yawRate = (vx - outward * ux) * YAW_LIMIT;
      this.pitchRate = (vy - outward * uy) * PITCH_LIMIT;
    }
  }

  /* One display frame.  `request`: {yawRate, pitchRate, committed,
   * maxRateYaw, maxRatePitch}; `dt` in seconds. */
  step(request, dt) {
    let askedYaw = request.yawRate || 0;
    let askedPitch = request.pitchRate || 0;

    if (this.homing) {
      // Steering wins.  Nobody should have to sit out a sweep they have
      // changed their mind about.
      if (request.committed && (askedYaw || askedPitch)) {
        this.homing = false;
      } else {
        askedYaw = -this.yaw * HOME_GAIN;
        askedPitch = -this.pitch * HOME_GAIN;
        const arrived = Math.abs(this.yaw) < HOME_SETTLED && Math.abs(this.pitch) < HOME_SETTLED
          && Math.abs(this.yawRate) < 2 && Math.abs(this.pitchRate) < 2;
        if (arrived) {
          this.homing = false;
          this.yaw = this.pitch = this.yawRate = this.pitchRate = 0;
        }
      }
    }

    const want = this.resist(
      clamp(askedYaw, request.maxRateYaw || 128),
      clamp(askedPitch, request.maxRatePitch || 96));

    const turned = this.approach(this.yawRate, want.yawRate, dt);
    this.yawRate = turned.rate;
    this.yawAccel = turned.accel;
    this.pitchRate = this.approach(this.pitchRate, want.pitchRate, dt).rate;

    this.yaw += this.yawRate * dt;
    this.pitch += this.pitchRate * dt;
    this.holdAtLimit();

    // A head leans into a turn.  Driven by acceleration rather than speed,
    // so the lean happens at the two ends of a sweep, not throughout it.
    const wantRoll = clamp(-K_ROLL * this.yawAccel, MAX_ROLL);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 6);

    // Idle sway.  A perfectly still camera is the plainest tell that there
    // is no body behind it, so it never quite stops -- but it fades out the
    // moment the view is genuinely turning, where it would just be noise.
    const speed = Math.hypot(this.yawRate, this.pitchRate);
    const calm = 1 - Math.min(1, speed / 40);
    const t = (this.clock += dt);
    const swayYaw = calm * (noise(t * 0.18) * 0.18 + noise(t * 0.36 + 11) * 0.07);
    const swayPitch = calm * (noise(t * 0.15 + 5) * 0.11 + noise(t * 0.30 + 23) * 0.04);
    // A neck held near its limit is not steady.
    const shake = STRAIN_TREMOR * this.strain * this.strain;
    const tremorYaw = shake * noise(t * 7.3 + 41);
    const tremorPitch = shake * noise(t * 8.1 + 57);

    this.view.yaw = (this.yaw + swayYaw + tremorYaw) * DEG;
    this.view.pitch = (this.pitch + swayPitch + tremorPitch) * DEG;
    this.view.roll = this.roll * DEG;
    // Smear along the direction of travel over one exposure: what a turning
    // head sees, and cover for the judder a 30 Hz gaze pipeline puts into a
    // fast rotation.
    this.view.blur = Math.min(MAX_BLUR, Math.abs(this.yawRate) * DEG * dt);
    return this.view;
  }
}
