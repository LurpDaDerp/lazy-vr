/* Secondary eye offset from iris-in-socket position, without calibration
 * (research-headpose.md §6). Pure module.
 *
 * The iris is measured in "eye widths" in each eye's corner-line frame, so head roll
 * and distance drop out. Turning the head while watching the screen also moves the
 * iris in the socket (vestibulo-ocular reflex + parallax); that coupling is fitted
 * online per axis as h = a + b·sin(headRel) and only the residual is reported, so the
 * output is ~0 whenever the user looks at their usual spot, at any head angle.
 * Signs match the head: x > 0 eyes toward the user's right, y > 0 up. Degrees.
 */

import { OneEuro, RollingMedian, TimedMedian, clamp } from "./filters.js";

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/* MediaPipe indices. cR is the corner on the user's right, cL on the user's left.
 * EAR points p1..p6 (p1/p4 corners, p2/p6 and p3/p5 vertical pairs). */
export const EYES = Object.freeze({
  right: Object.freeze({ cR: 33, cL: 133, iris: 468, ear: Object.freeze([33, 160, 158, 133, 153, 144]) }),
  left: Object.freeze({ cR: 362, cL: 263, iris: 473, ear: Object.freeze([362, 385, 387, 263, 373, 380]) }),
});

const MIN_EYE_PX = 2;        // an eye narrower than this is not measurable
const SINGLE_EYE_RATIO = 0.6; // narrower eye below this fraction of the wider one is dropped

const scratch = { hx: 0, vy: 0, w: 0, ear: 0, ok: false };

const span = (lm, W, H, i, j) => Math.hypot((lm[3 * i] - lm[3 * j]) * W, (lm[3 * i + 1] - lm[3 * j + 1]) * H);

function measureEye(lm, W, H, eye, out) {
  const ax = lm[3 * eye.cR] * W, ay = lm[3 * eye.cR + 1] * H;
  const bx = lm[3 * eye.cL] * W, by = lm[3 * eye.cL + 1] * H;
  const ix = lm[3 * eye.iris] * W, iy = lm[3 * eye.iris + 1] * H;
  const dx = ax - bx, dy = ay - by, d2 = dx * dx + dy * dy;
  const qx = ix - 0.5 * (ax + bx), qy = iy - 0.5 * (ay + by);
  out.w = Math.sqrt(d2);
  out.hx = (qx * dx + qy * dy) / d2;
  out.vy = (qx * -dy + qy * dx) / d2;  // (−d.y, d.x) points up in the image when d points to image left
  const p = eye.ear;
  out.ear = (span(lm, W, H, p[1], p[5]) + span(lm, W, H, p[2], p[4])) / (2 * span(lm, W, H, p[0], p[3]));
  out.ok = out.w >= MIN_EYE_PX && Number.isFinite(out.hx) && Number.isFinite(out.vy) && Number.isFinite(out.ear);
  return out;
}

/* Fill `out` with { hx, vy, ear, wR, wL, earR, earL, hxR, hxL, vyR, vyL, ok } from the
 * flat normalised landmarks. hx/vy/ear combine both eyes weighted by width², or use only
 * the wider eye when the other is under 0.6× its width (strong yaw). */
export function eyeFeatures(lm, width, height, out = {}) {
  out.ok = false;
  if (!lm || lm.length < 474 * 3 || !(width > 0) || !(height > 0)) {
    out.hx = out.vy = out.ear = 0; out.wR = out.wL = out.earR = out.earL = 0;
    out.hxR = out.hxL = out.vyR = out.vyL = 0;
    return out;
  }
  const r = measureEye(lm, width, height, EYES.right, scratch);
  const okR = r.ok, hxR = r.hx, vyR = r.vy, wR = r.w, earR = r.ear;
  const l = measureEye(lm, width, height, EYES.left, scratch);
  const okL = l.ok, hxL = l.hx, vyL = l.vy, wL = l.w, earL = l.ear;
  out.wR = okR ? wR : 0; out.wL = okL ? wL : 0;
  out.earR = okR ? earR : 0; out.earL = okL ? earL : 0;
  out.hxR = okR ? hxR : 0; out.vyR = okR ? vyR : 0;
  out.hxL = okL ? hxL : 0; out.vyL = okL ? vyL : 0;

  let kR = okR ? wR * wR : 0, kL = okL ? wL * wL : 0;
  if (okR && okL) {
    if (wR < SINGLE_EYE_RATIO * wL) kR = 0;
    else if (wL < SINGLE_EYE_RATIO * wR) kL = 0;
  }
  const k = kR + kL;
  if (!(k > 0)) { out.hx = out.vy = out.ear = 0; return out; }
  out.hx = (kR * (okR ? hxR : 0) + kL * (okL ? hxL : 0)) / k;
  out.vy = (kR * (okR ? vyR : 0) + kL * (okL ? vyL : 0)) / k;
  out.ear = (kR * (okR ? earR : 0) + kL * (okL ? earL : 0)) / k;
  out.ok = true;
  return out;
}

export const EYE_DEFAULTS = Object.freeze({
  // blinks
  blinkRatio: 0.65,      // EAR below this × open-eye median => blink
  blinkAbs: 0.15,        // ...or below this absolutely
  squintRatio: 0.85,     // EAR in [blinkRatio, squintRatio] × median => vy weight halved
  earWindow: 3,          // s, running median of open-eye EAR
  earMinSamples: 10,     // relative blink test only after this many open frames
  blinkHold: 0.12,       // s, keep holding after the eye reopens
  // coupling fit h = a + b·sin(headRel), per axis
  initFrames: 15,        // a starts as the median of this many frames
  bPrior: -0.31,
  aSd: 0.03, bSd: 0.10,
  noiseSd: 0.015,
  aProcessSd: 0.0005, bProcessSd: 0.0005,   // per frame
  bMin: -0.45, bMax: -0.15,
  robustRes: 0.03,       // robust weight min(1, robustRes/|res|)
  gate: 0.035,           // update only while |res| is below this (≈5°)...
  wideGate: 0.08,        // ...or this during the first wideGateSec of the fit
  wideGateSec: 3,
  // A held look must not be learnt as the rest offset (it would then rebound the
  // other way when the eyes come back). Once the median-smoothed residual leaves
  // lockRes the axis stops fitting, and resumes only after unlockSec back inside.
  lockRes: 0.02,         // eye widths (≈3°, steer's eyeExit)
  unlockSec: 0.5,
  fitYawMax: 35, fitPitchMax: 25,
  // residual -> angle -> filters
  gain: 0.38,            // eye widths per unit sin(eye rotation)
  medianFrames: 5,
  oneEuro: Object.freeze({ minCutoff: 0.6, beta: 0.02, dCutoff: 1 }),
  gapReset: 0.5,         // s without a usable frame => restart the median and One Euro
});

/* Two-state Kalman filter for h = a + b·s with clamped b. */
class CouplingFit {
  init(a, b, aSd, bSd) {
    this.a = a; this.b = b;
    this.p00 = aSd * aSd; this.p01 = 0; this.p11 = bSd * bSd;
  }

  predict(qa, qb) { this.p00 += qa; this.p11 += qb; }

  residual(z, s) { return z - (this.a + this.b * s); }

  update(z, s, r, bMin, bMax) {
    const innov = this.residual(z, s);
    const h0 = this.p00 + s * this.p01, h1 = this.p01 + s * this.p11;  // P·Hᵀ
    const S = h0 + s * h1 + r;
    if (!(S > 0)) return;
    const k0 = h0 / S, k1 = h1 / S;
    this.a += k0 * innov;
    this.b = clamp(this.b + k1 * innov, bMin, bMax);
    this.p00 -= k0 * h0;
    this.p01 -= k0 * h1;
    this.p11 -= k1 * h1;
  }
}

const median = (arr) => {
  const s = Array.from(arr).sort((x, y) => x - y), n = s.length;
  return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
};

export class EyeTracker {
  constructor(opts = {}) {
    this.opts = { ...EYE_DEFAULTS, ...opts, oneEuro: { ...EYE_DEFAULTS.oneEuro, ...(opts.oneEuro || {}) } };
    const o = this.opts;
    this.fitH = new CouplingFit();
    this.fitV = new CouplingFit();
    this.earMedian = new TimedMedian(o.earWindow);
    this.medX = new RollingMedian(o.medianFrames);
    this.medY = new RollingMedian(o.medianFrames);
    this.resMedH = new RollingMedian(o.medianFrames);
    this.resMedV = new RollingMedian(o.medianFrames);
    this.lockH = { locked: false, calmSince: NaN };
    this.lockV = { locked: false, calmSince: NaN };
    this.euroX = new OneEuro(o.oneEuro);
    this.euroY = new OneEuro(o.oneEuro);
    this.initH = new Float64Array(o.initFrames);
    this.initV = new Float64Array(o.initFrames);
    this.reset();
  }

  reset() {
    this.ready = false;
    this.initCount = 0;
    this.fitStart = NaN;
    this.earMedian.reset();
    this.blinkUntil = -Infinity;
    this.lastT = NaN;
    this.x = 0;
    this.y = 0;
    this.resetFilters();
  }

  resetFilters() {
    this.medX.reset(); this.medY.reset();
    this.euroX.reset(); this.euroY.reset();
    this.resMedH.reset(); this.resMedV.reset();
    // After a gap the residual history is gone: start unlocked, the gate still applies.
    this.lockH.locked = false; this.lockH.calmSince = NaN;
    this.lockV.locked = false; this.lockV.calmSince = NaN;
  }

  /* Fit lock for one axis from its smoothed residual; true while learning is allowed. */
  fitOpen(lock, smoothed, tSec, wide) {
    const o = this.opts;
    if (wide) { lock.locked = false; lock.calmSince = NaN; return true; }
    if (Math.abs(smoothed) > o.lockRes) { lock.locked = true; lock.calmSince = NaN; return false; }
    if (!lock.locked) return true;
    if (!Number.isFinite(lock.calmSince)) lock.calmSince = tSec;
    if (tSec - lock.calmSince >= o.unlockSec) lock.locked = false;
    return !lock.locked;
  }

  output(valid, blink) { return { x: this.x, y: this.y, valid, blink }; }

  /* features: eyeFeatures() output; headYawRel/headPitchRel: screen-relative head angles
   * (degrees, before neutral subtraction); headOk: the pose estimate is usable. */
  update(features, headYawRel, headPitchRel, tSec, headOk) {
    const o = this.opts;
    if (!headOk || !features || !features.ok || !Number.isFinite(headYawRel)
      || !Number.isFinite(headPitchRel) || !Number.isFinite(tSec)
      || !Number.isFinite(features.hx) || !Number.isFinite(features.vy)) {
      return this.output(false, false);
    }
    if (tSec <= this.lastT) return this.output(false, tSec < this.blinkUntil);  // stale / out of order
    if (tSec - this.lastT > o.gapReset) this.resetFilters();
    this.lastT = tSec;

    // Blink gate against the running median of open-eye EAR.
    const ear = features.ear;
    const med = this.earMedian.prune(tSec);
    const haveMedian = this.earMedian.count >= o.earMinSamples;
    const closed = !(ear >= o.blinkAbs) || (haveMedian && ear < o.blinkRatio * med);
    if (closed) this.blinkUntil = tSec + o.blinkHold;
    else this.earMedian.push(ear, tSec);
    if (closed || tSec < this.blinkUntil) return this.output(false, true);
    const vWeight = haveMedian && ear < o.squintRatio * med ? 0.5 : 1;

    const sYaw = Math.sin(headYawRel * RAD), sPitch = Math.sin(headPitchRel * RAD);
    const inFitRange = Math.abs(headYawRel) < o.fitYawMax && Math.abs(headPitchRel) < o.fitPitchMax;

    if (!this.ready) {
      if (inFitRange) {
        // Seed a with the prior coupling removed, so a start with the head turned is not biased.
        this.initH[this.initCount] = features.hx - o.bPrior * sYaw;
        this.initV[this.initCount] = features.vy - o.bPrior * sPitch;
        this.initCount += 1;
        if (this.initCount >= o.initFrames) {
          this.fitH.init(median(this.initH), o.bPrior, o.aSd, o.bSd);
          this.fitV.init(median(this.initV), o.bPrior, o.aSd, o.bSd);
          this.fitStart = tSec;
          this.ready = true;
        }
      }
      if (!this.ready) return this.output(false, false);
    }

    const qa = o.aProcessSd * o.aProcessSd, qb = o.bProcessSd * o.bProcessSd;
    this.fitH.predict(qa, qb);
    this.fitV.predict(qa, qb);
    // The innovation (pre-update residual) is the eye offset.
    const resH = this.fitH.residual(features.hx, sYaw);
    const resV = this.fitV.residual(features.vy, sPitch);

    const wide = tSec - this.fitStart < o.wideGateSec;
    const openH = this.fitOpen(this.lockH, this.resMedH.push(resH), tSec, wide);
    const openV = this.fitOpen(this.lockV, this.resMedV.push(resV), tSec, wide);
    if (inFitRange) {
      const gate = wide ? o.wideGate : o.gate;
      const r = o.noiseSd * o.noiseSd;
      const robust = (res) => Math.min(1, o.robustRes / Math.max(Math.abs(res), 1e-12));
      if (openH && Math.abs(resH) < gate) this.fitH.update(features.hx, sYaw, r / robust(resH), o.bMin, o.bMax);
      if (openV && Math.abs(resV) < gate) this.fitV.update(features.vy, sPitch, r / (robust(resV) * vWeight), o.bMin, o.bMax);
    }

    const ex = Math.asin(clamp(resH / o.gain, -1, 1)) * DEG;
    const ey = Math.asin(clamp(resV / o.gain, -1, 1)) * DEG;
    const x = this.euroX.filter(this.medX.push(ex), tSec);
    const y = this.euroY.filter(this.medY.push(ey), tSec);
    if (Number.isFinite(x)) this.x = x;
    if (Number.isFinite(y)) this.y = y;
    return this.output(true, false);
  }
}
