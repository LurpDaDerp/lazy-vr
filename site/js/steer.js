/* Head steering: tracker readings -> view, at display rate.
 *
 * Pure: no DOM, timers or globals beyond Math, so it can be stepped in a test.
 * Degrees inside; radians only in `view` (the embed/render contract).
 *
 * Clocks: readings carry `t` in absolute ms (performance.timeOrigin +
 * performance.now() at capture). tick(nowSec) must be given seconds on the SAME
 * absolute clock -- e.g. (performance.timeOrigin + rafTimestamp) / 1000 -- because
 * "lost" is decided by comparing the two.
 *
 * Signs: head yaw > 0 = user turned to their right; view.yaw > 0 = view turned to
 * the user's left. So head yaw is negated on the way to the view (head right =>
 * view.yaw decreases); pitch passes straight through (head up => view up).
 *
 * The law (spec section 5): One Euro on the screen-relative head pose, an
 * auto-zero neutral, a position zone (gain x3, springs back), a yaw rate zone
 * beyond it for full 360, a freeze when the user looks away or the face is lost,
 * a small eye offset, and a critically damped follower at display rate.
 */

import { OneEuro } from "./filters.js";

const DEG = Math.PI / 180;
const RESUME_SECONDS = 0.5;   // follower runs at resumeOmega this long after a jump
const RESUME_BLEND = 0.2;     // ...easing to followOmega over its last part (no re-acceleration)
const RATE_PAUSE_RUN = 2;     // consecutive untracked readings that pause the rate
const MAX_DT = 0.1;           // display steps longer than this are clamped
const LIVE = new Set(["tracking", "turning"]);

export const STEER_DEFAULTS = Object.freeze({
  // position zone
  yawGain: 3, pitchGain: 3,
  yawZone: 20, pitchZone: 25,
  // rate zone (yaw only)
  rateFull: 35,
  maxRate: 90,
  rateDwell: 0.15,
  // Not in the spec table: the dwell only counts while the head is roughly
  // settled in the zone -- slower than rateArmSpeed overall and not heading back
  // toward the centre faster than rateArmInward -- so a turn away, or back from
  // a look-away, passes through without arming it. Once armed, turning
  // continues whatever the head does until it leaves the zone.
  rateArmSpeed: 30, rateArmInward: 8,
  // freeze
  freezeYaw: 45, freezeYawExit: 40, freezePitch: 35, freezePitchExit: 30,
  staleAfter: 0.5,
  viewPitchLimit: 85,
  // filtering & neutral
  oneEuro: Object.freeze({ minCutoff: 0.4, beta: 0.05, dCutoff: 1.0 }),
  neutralFrames: 20, neutralMaxSpeed: 15,
  // Not in the spec table: auto-zero only takes frames roughly facing the screen
  // (head pose is screen-relative, so that reads ~0), so a glance at the keyboard
  // never becomes the neutral. A head held steady off-axis this long is taken as
  // the user's real rest pose (off-axis camera, reclined user) and accepted.
  neutralAcquireYaw: 15, neutralAcquirePitch: 15, neutralAcquireWait: 3,
  neutralAdaptTau: 30, neutralAdaptBand: 4,   // tau <= 0 pins the neutral
  // eye offset
  eyeYawMax: 10, eyePitchMax: 6,
  eyeEnter: 5, eyeExit: 3,
  eyeYawSpan: Object.freeze([4, 20]), eyePitchSpan: Object.freeze([4, 14]),
  eyeReturnTau: 0.15,
  // Not in the spec table: during a blink the tracker reports valid:false but
  // holds the last angles. Holding the eye target that long keeps every blink
  // from twitching the view back; a longer closure releases it.
  eyeBlinkHold: 0.5,
  // follower
  followOmega: 22,
  resumeOmega: 9,
  // user settings
  sensitivity: 1, turnSpeed: 1, eyeAssist: true, invertYaw: false, invertPitch: false,
  enabled: true,
});

/* Short UI label for a steering state. */
export function trackingLabel(state) {
  switch (state) {
    case "tracking": case "turning": return "On";
    case "acquiring": return "Acquiring";
    case "away": return "View held";
    case "lost": return "Face lost";
    case "off": return "Off";
    default: return "";
  }
}

const clampAbs = (x, limit) => (x > limit ? limit : x < -limit ? -limit : x);
const finite = Number.isFinite;

function smoothstep(u) {
  if (!(u > 0)) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b), n = s.length;
  return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

function copyDefaults() {
  const o = { ...STEER_DEFAULTS };
  o.oneEuro = { ...STEER_DEFAULTS.oneEuro };
  o.eyeYawSpan = [...STEER_DEFAULTS.eyeYawSpan];
  o.eyePitchSpan = [...STEER_DEFAULTS.eyePitchSpan];
  return o;
}

/* One eye axis: hysteresis deadzone on |e|, then span -> 0..max, sign kept. */
function eyeAxis(e, active, enter, exit, span, max) {
  const a = Math.abs(e);
  const on = active ? a >= exit : a > enter;
  if (!on) return { on, target: 0 };
  const u = (a - span[0]) / (span[1] - span[0]);
  return { on, target: Math.sign(e) * max * (u <= 0 ? 0 : u >= 1 ? 1 : u) };
}

/* Exact critically damped step toward a fixed goal: stable for any dt. */
function follow(x, v, goal, omega, dt) {
  if (!(omega > 0)) return [goal, 0];
  const e = x - goal, w = v + omega * e, decay = Math.exp(-omega * dt);
  return [goal + (e + w * dt) * decay, (v - omega * w * dt) * decay];
}

export class Steering {
  constructor(options = {}) {
    this.options = copyDefaults();
    this.enabled = true;
    this.view = { yaw: 0, pitch: 0, roll: 0, blur: 0 };
    this.offset = { yaw: 0, pitch: 0 };       // rate + drag, view-space degrees
    this.eyeView = { yaw: 0, pitch: 0 };      // current eye contribution, head-space degrees
    this._euroYaw = new OneEuro(this.options.oneEuro);
    this._euroPitch = new OneEuro(this.options.oneEuro);
    this._runYaw = [];                        // steady frames toward the neutral
    this._runPitch = [];
    this._diag = {
      head: { yaw: 0, pitch: 0 }, cmd: { yaw: 0, pitch: 0 }, eye: { x: 0, y: 0 },
      eyeView: { yaw: 0, pitch: 0 }, offset: { yaw: 0, pitch: 0 }, pos: { yaw: 0, pitch: 0 },
      rate: 0, state: "acquiring", neutral: null,
    };
    this._diagNeutral = { yaw: 0, pitch: 0 };
    this.reset();
    this.configure(options);
  }

  configure(partial) {
    if (!partial || typeof partial !== "object") return;
    const o = this.options;
    for (const key of Object.keys(partial)) {
      if (!(key in STEER_DEFAULTS) || key === "enabled") continue;
      const v = partial[key], d = STEER_DEFAULTS[key];
      if (key === "oneEuro") {
        if (!v || typeof v !== "object") continue;
        const next = { ...o.oneEuro };
        if (finite(v.minCutoff) && v.minCutoff > 0) next.minCutoff = v.minCutoff;
        if (finite(v.beta) && v.beta >= 0) next.beta = v.beta;
        if (finite(v.dCutoff) && v.dCutoff > 0) next.dCutoff = v.dCutoff;
        o.oneEuro = next;
        // The filter keeps its parameters private to its constructor; a fresh one
        // reseeds on the next sample (no jump: it seeds at the raw value).
        this._euroYaw = new OneEuro(next);
        this._euroPitch = new OneEuro(next);
      } else if (Array.isArray(d)) {
        if (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && v[1] > v[0]) {
          o[key] = [v[0], v[1]];
        }
      } else if (typeof d === "boolean") {
        if (typeof v !== "boolean") continue;
        // Flipping an axis moves the target by twice the head term: glide there.
        if ((key === "invertYaw" || key === "invertPitch") && v !== o[key]) this._resumePending = true;
        o[key] = v;
      } else if (finite(v) && v >= 0) {
        if (key === "neutralFrames") {
          const n = Math.max(1, Math.round(v));
          if (n !== o.neutralFrames) { this._runYaw.length = 0; this._runPitch.length = 0; }
          o.neutralFrames = n;
        } else {
          o[key] = v;
        }
      }
    }
    if (typeof partial.enabled === "boolean") this.setEnabled(partial.enabled);
  }

  /* New session: forget neutral, offsets and filters; the view snaps to 0. */
  reset() {
    this._euroYaw.reset();
    this._euroPitch.reset();
    this._runYaw.length = 0;
    this._runPitch.length = 0;
    this._hasNeutral = false;
    this._nYaw = 0; this._nPitch = 0;
    this._fYaw = 0; this._fPitch = 0;         // filtered screen-relative head pose
    this._hYaw = 0; this._hPitch = 0;         // command: filtered - neutral
    this._holdYaw = 0; this._holdPitch = 0;   // command feeding the position term (held when frozen)
    this._speed = Infinity;                   // filtered angular speed of the last tracked reading
    this._away = false;
    this._overSince = null;                   // reading time |h_yaw| first exceeded yawZone
    this._lastReadingT = -Infinity;           // seconds; ordering guard
    this._lastTrackedT = null;                // seconds
    this._lastReadingTracked = false;
    this._untrackedRun = 0;                   // consecutive untracked readings
    this._offAxisSince = null;                // acquiring: steady-off-axis since (seconds)
    this._eyeInX = 0; this._eyeInY = 0;
    this._eyeOnX = false; this._eyeOnY = false;
    this._eyeTargetYaw = 0; this._eyeTargetPitch = 0;
    this._blinkSince = null;
    this.eyeView.yaw = 0; this.eyeView.pitch = 0;
    this.offset.yaw = 0; this.offset.pitch = 0;
    this._posYaw = 0; this._posPitch = 0;
    this._yaw = 0; this._pitch = 0;           // follower position, degrees
    this._vYaw = 0; this._vPitch = 0;         // follower velocity, degrees/s
    this._rate = 0;
    this._lastTick = null;
    this._resumeUntil = -Infinity;
    this._resumePending = false;
    this.view.yaw = 0; this.view.pitch = 0; this.view.roll = 0; this.view.blur = 0;
    this.state = this.enabled ? "acquiring" : "off";
  }

  push(reading) {
    if (!reading || typeof reading !== "object" || !finite(reading.t)) return;
    const t = reading.t / 1000;
    if (!(t > this._lastReadingT)) return;   // out of order or duplicate
    this._lastReadingT = t;
    if (!this.enabled) return;

    const head = reading.head;
    const tracked = reading.tracked === true && head && finite(head.yaw) && finite(head.pitch);
    this._lastReadingTracked = !!tracked;
    this._untrackedRun = tracked ? 0 : this._untrackedRun + 1;
    if (!tracked) return;                   // never moves anything; staleness is judged in tick
    const o = this.options;

    // A gap long enough to count as lost: the filter's history no longer describes the head.
    const gap = this._lastTrackedT === null ? Infinity : t - this._lastTrackedT;
    if (gap > o.staleAfter) {
      this._euroYaw.reset();
      this._euroPitch.reset();
      this._runYaw.length = 0;
      this._runPitch.length = 0;
      this._overSince = null;
      this._offAxisSince = null;
    }
    const fy = this._euroYaw.filter(head.yaw, t);
    const fp = this._euroPitch.filter(head.pitch, t);
    const fresh = gap > o.staleAfter;
    this._speed = fresh ? 0 : Math.hypot(fy - this._fYaw, fp - this._fPitch) / gap;
    // d|yaw|/dt about the neutral (< 0 = heading back toward the centre).
    const outward = fresh || !this._hasNeutral ? 0
      : (Math.abs(fy - this._nYaw) - Math.abs(this._fYaw - this._nYaw)) / gap;
    this._fYaw = fy; this._fPitch = fp;
    this._lastTrackedT = t;
    const steady = this._speed < o.neutralMaxSpeed;

    if (!this._hasNeutral) {
      // Auto-zero: the median of a run of consecutive steady frames facing the
      // screen; off-axis frames count only once the head has stayed off-axis
      // for neutralAcquireWait (a run never mixes the two).
      const facing = Math.abs(fy) <= o.neutralAcquireYaw && Math.abs(fp) <= o.neutralAcquirePitch;
      if (facing) {
        if (this._offAxisSince !== null) {
          this._offAxisSince = null;
          this._runYaw.length = 0; this._runPitch.length = 0;
        }
      } else if (this._offAxisSince === null) {
        this._offAxisSince = t;
        this._runYaw.length = 0; this._runPitch.length = 0;
      }
      const waiting = !facing && t - this._offAxisSince < o.neutralAcquireWait;
      if (!steady || waiting) { this._runYaw.length = 0; this._runPitch.length = 0; return; }
      this._runYaw.push(fy);
      this._runPitch.push(fp);
      if (this._runYaw.length < o.neutralFrames) return;
      this._nYaw = median(this._runYaw);
      this._nPitch = median(this._runPitch);
      this._hasNeutral = true;
      this._offAxisSince = null;
      this._runYaw.length = 0; this._runPitch.length = 0;
    }

    let hy = fy - this._nYaw, hp = fp - this._nPitch;

    if (this._away) {
      if (Math.abs(hy) < o.freezeYawExit && Math.abs(hp) < o.freezePitchExit) this._away = false;
    } else if (Math.abs(hy) > o.freezeYaw || Math.abs(hp) > o.freezePitch) {
      this._away = true;
    }
    if (this._away) {
      // Frozen: the position term keeps its held value; dwell restarts on return.
      this._hYaw = hy; this._hPitch = hp;
      this._overSince = null;
      this._clearEyeTarget();
      return;
    }

    // Slow re-centring while the user is settled near the neutral.
    const tau = o.neutralAdaptTau;
    if (tau > 0 && steady && gap > 0 && gap <= o.staleAfter
      && Math.abs(hy) < o.neutralAdaptBand && Math.abs(hp) < o.neutralAdaptBand) {
      const k = 1 - Math.exp(-gap / tau);
      this._nYaw += (fy - this._nYaw) * k;
      this._nPitch += (fp - this._nPitch) * k;
      hy = fy - this._nYaw; hp = fp - this._nPitch;
    }
    this._hYaw = hy; this._hPitch = hp;
    this._holdYaw = hy; this._holdPitch = hp;

    if (Math.abs(hy) > o.yawZone) {
      const armed = this._overSince !== null && t - this._overSince >= o.rateDwell;
      const settled = this._speed < o.rateArmSpeed && outward > -o.rateArmInward;
      if (!armed && !settled) this._overSince = null;   // passing through: the dwell restarts
      else if (this._overSince === null) this._overSince = t;
    } else {
      this._overSince = null;
    }

    this._updateEyeTarget(reading.eye, t, Math.abs(hy) <= o.yawZone);
  }

  _updateEyeTarget(eye, t, inZone) {
    const o = this.options;
    const valid = !!eye && typeof eye === "object" && eye.valid === true && finite(eye.x) && finite(eye.y);
    if (valid) { this._eyeInX = eye.x; this._eyeInY = eye.y; }
    const usable = o.eyeAssist && inZone && !!eye && typeof eye === "object";
    if (usable && valid) {
      this._blinkSince = null;
      const ax = eyeAxis(eye.x, this._eyeOnX, o.eyeEnter, o.eyeExit, o.eyeYawSpan, o.eyeYawMax);
      const ay = eyeAxis(eye.y, this._eyeOnY, o.eyeEnter, o.eyeExit, o.eyePitchSpan, o.eyePitchMax);
      this._eyeOnX = ax.on; this._eyeOnY = ay.on;
      this._eyeTargetYaw = ax.target; this._eyeTargetPitch = ay.target;
      return;
    }
    if (usable && eye.blink === true) {
      if (this._blinkSince === null) this._blinkSince = t;
      if (t - this._blinkSince <= o.eyeBlinkHold) return;   // hold through the blink
    } else {
      this._blinkSince = null;
    }
    this._clearEyeTarget();
  }

  _clearEyeTarget() {
    this._eyeOnX = false; this._eyeOnY = false;
    this._eyeTargetYaw = 0; this._eyeTargetPitch = 0;
  }

  _resolveState(now) {
    const o = this.options;
    let state;
    if (!this.enabled) state = "off";
    else if (!this._hasNeutral) state = "acquiring";
    else if (this._lastTrackedT === null
      || (now !== null && now - this._lastTrackedT > o.staleAfter)) state = "lost";
    else if (this._away) state = "away";
    else if (this._overSince !== null && Math.abs(this._hYaw) > o.yawZone
      && this._lastTrackedT - this._overSince >= o.rateDwell) state = "turning";
    else state = "tracking";
    if (state === "lost") this._overSince = null;
    if (state !== "tracking") { this._clearEyeTarget(); this._blinkSince = null; }
    this.state = state;
    return state;
  }

  tick(nowSec) {
    if (!finite(nowSec)) return this.view;
    if (this._lastTick === null) {
      this._lastTick = nowSec;
      this._resolveState(nowSec);
      return this.view;
    }
    let dt = nowSec - this._lastTick;
    if (!(dt > 0)) return this.view;
    this._lastTick = nowSec;
    if (dt > MAX_DT) dt = MAX_DT;
    const o = this.options;

    const prev = this.state;
    const state = this._resolveState(nowSec);
    if (this._resumePending || (!LIVE.has(prev) && LIVE.has(state))) {
      this._resumeUntil = nowSec + RESUME_SECONDS;
      this._resumePending = false;
    }

    const sYaw = o.invertYaw ? -1 : 1, sPitch = o.invertPitch ? -1 : 1;

    // Rate zone: integrate into the offset (the target), not the spring. Paused
    // after RATE_PAUSE_RUN consecutive untracked readings so a face lost mid-turn
    // cannot keep spinning on a stale angle until the stale timeout, while one
    // rejected frame (bad fit, jump) does not hitch a continuous turn.
    let rate = 0;
    if (state === "turning" && this._untrackedRun < RATE_PAUSE_RUN) {
      const span = o.rateFull - o.yawZone;
      const u = span > 0 ? (Math.abs(this._hYaw) - o.yawZone) / span : 1;
      rate = -sYaw * Math.sign(this._hYaw) * o.maxRate * o.turnSpeed * smoothstep(u);
      this.offset.yaw += rate * dt;
    }
    this._rate = rate;

    // Eye term: first-order spring toward its target (0 unless tracking).
    const ke = o.eyeReturnTau > 0 ? 1 - Math.exp(-dt / o.eyeReturnTau) : 1;
    this.eyeView.yaw += (this._eyeTargetYaw - this.eyeView.yaw) * ke;
    this.eyeView.pitch += (this._eyeTargetPitch - this.eyeView.pitch) * ke;

    // Compose the target (degrees).
    const g = o.sensitivity;
    this._posYaw = o.yawGain * g * clampAbs(this._holdYaw, o.yawZone);
    this._posPitch = o.pitchGain * g * clampAbs(this._holdPitch, o.pitchZone);
    const L = o.viewPitchLimit;
    const targetYaw = -(this._posYaw + this.eyeView.yaw) * sYaw + this.offset.yaw;
    const targetPitch = clampAbs((this._posPitch + this.eyeView.pitch) * sPitch + this.offset.pitch, L);

    // Follower. Yaw goes the short way round (same bearing, nearest turn), so the
    // output stays continuous and a recenter after laps never unwinds them.
    // After a jump the follower glides at resumeOmega, easing up to followOmega
    // over the last RESUME_BLEND s: a hard switch re-accelerates the glide's tail.
    const ease = Math.min(1, Math.max(0, (this._resumeUntil - nowSec) / RESUME_BLEND));
    const omega = o.followOmega + (o.resumeOmega - o.followOmega) * ease;
    const goalYaw = targetYaw + 360 * Math.round((this._yaw - targetYaw) / 360);
    [this._yaw, this._vYaw] = follow(this._yaw, this._vYaw, goalYaw, omega, dt);
    [this._pitch, this._vPitch] = follow(this._pitch, this._vPitch, targetPitch, omega, dt);
    if (this._pitch > L) { this._pitch = L; if (this._vPitch > 0) this._vPitch = 0; }
    else if (this._pitch < -L) { this._pitch = -L; if (this._vPitch < 0) this._vPitch = 0; }
    if (!finite(this._yaw) || !finite(this._vYaw)) { this._yaw = goalYaw; this._vYaw = 0; }
    if (!finite(this._pitch) || !finite(this._vPitch)) { this._pitch = targetPitch; this._vPitch = 0; }

    this.view.yaw = this._yaw * DEG;
    this.view.pitch = this._pitch * DEG;
    return this.view;
  }

  /* Neutral := the current pose if it is a trustworthy "looking at the screen"
   * pose; otherwise re-acquire. Offsets clear and the view glides to the front. */
  recenter() {
    const o = this.options;
    this.offset.yaw = 0; this.offset.pitch = 0;
    this._clearEyeTarget();
    this._blinkSince = null;
    this.eyeView.yaw = 0; this.eyeView.pitch = 0;
    if (this.enabled) {
      // Beyond that zone the user is more likely glancing at the keyboard for
      // the C key than facing the screen; zeroing there would skew every look after.
      // Within the zone of the old neutral is not enough on its own: a keyboard
      // 20 deg below a good neutral would pass. The pose must also face the
      // screen in absolute terms, or sit right at the current neutral (which may
      // itself be an accepted off-axis rest pose).
      const facing = Math.abs(this._fYaw) <= o.neutralAcquireYaw && Math.abs(this._fPitch) <= o.neutralAcquirePitch;
      const atNeutral = Math.abs(this._hYaw) <= o.neutralAdaptBand && Math.abs(this._hPitch) <= o.neutralAdaptBand;
      const trusted = this._hasNeutral && LIVE.has(this.state) && this._lastReadingTracked
        && this._speed < o.neutralMaxSpeed
        && Math.abs(this._hYaw) <= o.yawZone && Math.abs(this._hPitch) <= o.pitchZone
        && (facing || atNeutral);
      if (trusted) {
        this._nYaw = this._fYaw; this._nPitch = this._fPitch;
      } else {
        this._hasNeutral = false;
      }
      this._runYaw.length = 0; this._runPitch.length = 0;
      this._offAxisSince = null;
    }
    this._hYaw = 0; this._hPitch = 0;
    this._holdYaw = 0; this._holdPitch = 0;
    this._away = false;
    this._overSince = null;
    this._resumePending = true;
    this._resolveState(this._lastTick);
  }

  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    this.options.enabled = on;
    // Either way the head and eye terms leave the target; the follower glides.
    this._holdYaw = 0; this._holdPitch = 0;
    this._hYaw = 0; this._hPitch = 0;
    this._clearEyeTarget();
    this._blinkSince = null;
    this.eyeView.yaw = 0; this.eyeView.pitch = 0;
    this._away = false;
    this._overSince = null;
    this._rate = 0;
    if (on) {
      // Back on: auto-zero again from fresh readings.
      this._hasNeutral = false;
      this._runYaw.length = 0; this._runPitch.length = 0;
      this._euroYaw.reset(); this._euroPitch.reset();
      this._lastTrackedT = null;
      this._lastReadingTracked = false;
      this._untrackedRun = 0;
      this._offAxisSince = null;
      this._speed = Infinity;
    } else {
      this._resumePending = true;
    }
    this._resolveState(this._lastTick);
  }

  /* Manual look in view-space degrees (dYaw > 0 turns the view to the user's left). */
  drag(dYawDeg, dPitchDeg) {
    if (finite(dYawDeg)) this.offset.yaw += dYawDeg;
    if (!finite(dPitchDeg) || dPitchDeg === 0) return;
    const o = this.options, L = o.viewPitchLimit;
    const head = (o.pitchGain * o.sensitivity * clampAbs(this._holdPitch, o.pitchZone) + this.eyeView.pitch)
      * (o.invertPitch ? -1 : 1);
    const p = this.offset.pitch;
    // Never drag the composed pitch past the limit, and never pull the offset the
    // other way just because the head term alone is already past it.
    this.offset.pitch = dPitchDeg > 0
      ? Math.min(p + dPitchDeg, Math.max(p, L - head))
      : Math.max(p + dPitchDeg, Math.min(p, -L - head));
  }

  /* Cheap: fills and returns the same object every call. */
  diagnostics() {
    const d = this._diag;
    d.head.yaw = this._fYaw; d.head.pitch = this._fPitch;
    d.cmd.yaw = this._hYaw; d.cmd.pitch = this._hPitch;
    d.eye.x = this._eyeInX; d.eye.y = this._eyeInY;
    d.eyeView.yaw = this.eyeView.yaw; d.eyeView.pitch = this.eyeView.pitch;
    d.offset.yaw = this.offset.yaw; d.offset.pitch = this.offset.pitch;
    d.pos.yaw = this._posYaw; d.pos.pitch = this._posPitch;
    d.rate = this._rate;
    d.state = this.state;
    if (this._hasNeutral) {
      this._diagNeutral.yaw = this._nYaw; this._diagNeutral.pitch = this._nPitch;
      d.neutral = this._diagNeutral;
    } else {
      d.neutral = null;
    }
    return d;
  }
}
