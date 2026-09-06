/* Gaze angles -> what the viewer is asking the view to do.
 *
 * A rate map: how far off centre you look sets how fast the view turns, and
 * it stays where you left it.  Your eyes are a stick, not a pointer.
 *
 * This module decides *intent* only -- the speed being asked for, and whether
 * the viewer has actually committed to a turn rather than glanced.  The body
 * that carries the intent out lives in body.js, at display rate.
 *
 * Pure: no camera, no clock, no DOM.  Every decision about what a gaze
 * *means* lives here, where it can be tested without hardware.
 */

/* The shape of the screen decides the gearing between the axes.  A screen
 * `a` times wider than it is tall gives the eyes `a` times as much room to
 * travel sideways as up and down, so for both axes to reach the same speed
 * at the same *fraction* of the travel available to them, pitch takes the
 * aspect as gain and gives it straight back on the deadzone:
 *
 *     (E - dz) * g   ==   (E/a - dz/a) * g*a
 *
 * Gear them equally instead and the vertical axis feels dead, because the
 * eye runs out of screen long before the map runs out of gain.
 *
 * Size matters as much as shape.  Calibration happens in some viewport, and
 * the tuning is only true there: shrink the window afterwards and the same
 * screen-edge glance is fewer degrees of eye travel; go fullscreen and it
 * is more.  So a finished centring pass remembers the viewport it happened
 * in, and every deadzone and gain is rescaled by how much each axis has
 * grown since -- deadzones multiplied by it, gains divided -- which keeps
 * one thing invariant: the same *fraction* of the view always asks for the
 * same turn.  At the calibrated size the scales are 1 and this is exactly
 * the aspect law above. */
export const DEFAULT_ASPECT = 16 / 9;
export const MIN_ASPECT = 0.25;
export const MAX_ASPECT = 6.0;
// How far a resize may rescale the map: past this, something is lying.
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 5.0;

/* The narrowest band of gaze that can still mean "not asking for anything".
 *
 * The aspect law above is about *gearing*, and gearing is a property of the
 * screen.  A deadzone has a second job that is nothing to do with the
 * screen: it has to be wider than the gaze estimate's own noise, or it stops
 * being a deadzone at all.  Inside a band that the noise crosses freely, a
 * standing error in the neutral is not suppressed -- it is passed through in
 * proportion to how often the noise carries the reading out of the band, and
 * then multiplied by a gain the aspect law has *raised*.
 *
 * Divided by 16/9 the shipped 1.8 degree band becomes 1.01, which is inside
 * that noise, and the arithmetic is brutal: with eight tenths of a degree of
 * estimator noise and half a degree of standing offset -- a viewer settling
 * into their chair -- yaw creeps 0.7 degrees a minute and pitch creeps 32,
 * on the same map and the same reading.  That is the reported "looking at
 * the middle slowly tilts the camera up": nothing about the calibration dot,
 * nothing about a sign, just a vertical deadzone geared down until it no
 * longer covered the noise it was there to cover.
 *
 * So where gearing and the noise floor disagree, the floor wins.  Above the
 * deadzone the aspect law is untouched: both axes still reach the same rate
 * at the same share of their remaining travel.  A host that names a pitch
 * deadzone outright has said what it wants and gets it. */
export const DEADZONE_FLOOR = 1.5;

export const DEFAULTS = Object.freeze({
  // Eye eccentricity that commands no motion, in degrees of visual angle.
  // People do not recruit the head for gaze shifts below roughly 18 degrees,
  // so that is the physiological ceiling; a viewer sitting at a screen
  // cannot turn their real head to help, so it is walked a long way down,
  // and the onset gate does the glance rejection the deadzone would
  // otherwise have to.  Below about a degree and a half the band is inside
  // the gaze estimate's own noise, and anywhere near that floor every scrap
  // of bias in the calibrated centre reads as a slow standing turn -- so it
  // sits a little clear of it rather than on it, and C is for the rest.
  deadzoneYaw: 1.8,
  deadzonePitch: null,        // null: derive from the screen
  // Degrees per second of turn per degree of gaze past the deadzone.  With
  // the deadzone above, the fastest sweep on offer arrives inside fourteen
  // degrees of eye travel -- a glance rather than a stare.
  rateYaw: 10.6,
  ratePitch: null,            // null: derive from the screen
  maxRateYaw: 128.0,
  // null: the same ceiling as yaw.  The gearing below has already made the
  // two axes ask for the same rate at the same fraction of the screen, so
  // the *cap* is where that law is kept or broken -- and a lower one broke
  // it, because pitch reached its ceiling at 7.3 degrees of eye travel
  // where yaw ran to 16.3, then sat a quarter slower for the whole of the
  // rest of the screen.  A host that genuinely wants a gentler vertical
  // may still set a number here.
  maxRatePitch: null,
  // Eccentricity must stay outside the deadzone this long before the view
  // commits.  In a natural gaze shift the eye saccades and the head follows
  // 60-120 ms later; without any lag the world feels welded to the eyeball.
  // Deliberately under that range: gaze arrives at ~30 Hz, so the wait can
  // only end on a sample boundary, and 0.03 reliably means one sample where
  // 0.033 would quietly cost two at the 30.5 fps a typical webcam returns.
  onset: 0.03,
  expo: 1.0,
  // Gaze smoothing time constant.  Short: the body's acceleration limit is
  // itself a heavy low-pass on the rate.
  tau: 0.02,
  minConfidence: 0.5,
  // Calibration is a fixation test, not a sample count: hold one spot for
  // this long, and wander further than the tolerance and it starts again.
  calibrationHold: 1.4,
  calibrationTolerance: 2.5,
  // The longest a reading may go missing mid-hold and still count as the
  // same hold.  Generous enough for a couple of dropped frames at 30 Hz,
  // tight enough that a blink, a hand across the lens or a glance the
  // tracker could not read cannot be spliced over.
  calibrationGap: 0.25,
  // How fast the neutral follows a viewer who is not asking for anything.
  //
  // The view is an integrator with no way home: nothing pulls it back, so
  // whatever mean rate survives the deadzone is turned into angle and kept,
  // for as long as the clip lasts.  The calibrated centre is measured once,
  // in a second and a half, and everything that moves afterwards -- a viewer
  // settling into their chair, the estimator's own slow wander, the tiny
  // sampling error in the mean itself -- lands on it as a standing error and
  // comes out as a standing turn.
  //
  // So the neutral is not a constant: while the eyes are inside the deadzone
  // -- while nothing at all is being asked for -- it eases towards where
  // they actually are, with a time constant far longer than any glance.  A
  // deliberate turn is never touched, because a deliberate turn is by
  // definition outside the deadzone.  Set to 0 to pin the neutral where
  // calibration left it.
  neutralTau: 10.0,
  invertYaw: false,
  invertPitch: false,
});

export function clampAspect(aspect) {
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

export function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/* Shaped response for one axis: zero inside the deadzone, then `gain` per
 * degree beyond it, saturating at `limit`.  `expo` above 1 trades
 * sensitivity near the centre for reach at the edges; 1 is proportional. */
export function responseAngle(error, deadzone, gain, limit, expo = 1) {
  // Every one of these reaches the view as an angle that is added to the
  // last one, so a single non-finite number here is not a bad frame -- it is
  // a view that is NaN for the rest of the session and never comes back.
  if (!Number.isFinite(error) || !Number.isFinite(deadzone)
    || !Number.isFinite(gain) || !Number.isFinite(limit)) return 0;
  const magnitude = Math.abs(error);
  if (magnitude <= deadzone) return 0;
  let beyond = magnitude - deadzone;
  if (expo !== 1) beyond = Math.pow(beyond, expo);
  return Math.sign(error) * Math.min(gain * beyond, limit);
}

/* Exponential moving average with a time constant rather than a fixed
 * weight, so the smoothing is the same at 20 Hz and at 60 Hz, and a long gap
 * -- a face lost and refound -- snaps to the new value instead of easing
 * towards a stale one. */
class Ema {
  constructor(tau) {
    this.tau = Math.max(0, tau);
    this.reset();
  }

  reset() {
    this.value = null;
    this.last = null;
  }

  update(sample, timestamp) {
    if (this.value === null || this.tau <= 0) {
      this.value = sample;
      this.last = timestamp;
      return sample;
    }
    const dt = timestamp - this.last;
    this.last = timestamp;
    if (dt <= 0) return this.value;  // a clock that went backwards says nothing
    const alpha = 1 - Math.exp(-dt / this.tau);
    this.value += alpha * (sample - this.value);
    return this.value;
  }
}

export class GazeController {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    // The viewport being filled (any units; only ratios matter), and the
    // one the last centring pass finished in -- the map's reference size.
    this.width = 16;
    this.height = 9;
    this.calWidth = null;
    this.calHeight = null;
    this.yawEma = new Ema(this.config.tau);
    this.pitchEma = new Ema(this.config.tau);
    this.centre = [0, 0];
    this.calibrated = false;
    // Bumped on every centring pass, so a page can tell one pass's progress
    // from a previous pass's.
    this.generation = 0;
    // Bumped every time the viewer looks away mid-pass, so the page can say
    // so rather than show a bar that quietly went backwards.
    this.resets = 0;
    this.resetFixation();
    this.committed = false;
    this.outsideSince = null;
    // When the neutral last eased towards the eyes; null means "no usable
    // reading since", so the next one starts a fresh interval rather than
    // settling across the gap.
    this.settledAt = null;
  }

  // -- geometry ---------------------------------------------------------

  /* How much each axis of the viewport has grown since the viewer
   * calibrated.  Before any pass completes the current viewport is its own
   * reference, which is exactly the plain aspect law. */
  get scaleX() {
    return this.calWidth ? clampScale(this.width / this.calWidth) : 1;
  }

  get scaleY() {
    return this.calHeight ? clampScale(this.height / this.calHeight) : 1;
  }

  /* The screen shape the pitch gearing is derived at: the calibrated one. */
  get referenceAspect() {
    const width = this.calWidth ?? this.width;
    const height = this.calHeight ?? this.height;
    return clampAspect(width / Math.max(height, 1e-6));
  }

  /* Deadzones grow with the view and gains give the growth straight back,
   * so the same fraction of the view always asks for the same turn. */
  get deadzoneYaw() {
    return this.config.deadzoneYaw * this.scaleX;
  }

  get rateYaw() {
    return this.config.rateYaw / this.scaleX;
  }

  /* The one place the aspect law is overruled.  A pitch deadzone the host
   * named is honoured as given; one this module derived is not allowed
   * below the estimator's noise, at the size it will actually be used --
   * hence after the viewport scaling, which can shrink it as easily as the
   * aspect can. */
  get deadzonePitch() {
    const named = this.config.deadzonePitch;
    if (named !== null && named !== undefined) return named * this.scaleY;
    return Math.max(this.config.deadzoneYaw / this.referenceAspect * this.scaleY, DEADZONE_FLOOR);
  }

  get ratePitch() {
    return (this.config.ratePitch ?? this.config.rateYaw * this.referenceAspect) / this.scaleY;
  }

  /* The fastest turn either axis will ask for.  Not scaled by the viewport:
   * this is an output rate in world degrees, not an eye eccentricity, so a
   * bigger window must not make the view spin faster -- the gearing above
   * is what the screen's shape and size act on. */
  get maxRatePitch() {
    return this.config.maxRatePitch ?? this.config.maxRateYaw;
  }

  /* The viewport being filled, in any consistent units.  Anything unusable
   * leaves it alone: a bad number here would gear an axis into uselessness,
   * and a page is at liberty to report nonsense while it is still laying
   * itself out. */
  setViewport(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    this.width = w;
    this.height = h;
  }

  /* Live tuning: a settings panel changes the base numbers and the getters
   * carry the change into the very next sample. */
  configure(partial) {
    Object.assign(this.config, partial);
  }

  /* What the HUD needs to draw the axes, at the current screen size. */
  get limits() {
    const c = this.config;
    const deadzoneYaw = this.deadzoneYaw;
    const deadzonePitch = this.deadzonePitch;
    return {
      deadzoneYaw,
      deadzonePitch,
      // Where the axis saturates: the eccentricity at which the viewer is
      // already asking for the fastest turn on offer.
      spanYaw: deadzoneYaw + c.maxRateYaw / Math.max(this.rateYaw, 1e-6),
      spanPitch: deadzonePitch + this.maxRatePitch / Math.max(this.ratePitch, 1e-6),
      maxRateYaw: c.maxRateYaw,
      maxRatePitch: this.maxRatePitch,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
    };
  }

  // -- calibration ------------------------------------------------------

  resetFixation() {
    this.streak = [];
    this.streakStart = null;
    this.streakAt = null;
    this.progress = 0;
  }

  /* Re-run the centring pass: one dot, one hold, and the mean of the
   * fixation becomes where straight ahead is. */
  recalibrate() {
    this.calibrated = false;
    this.generation += 1;
    this.resetFixation();
    this.release();
    this.settledAt = null;
    return this.generation;
  }

  get calibrationProgress() {
    return this.calibrated ? 1 : this.progress;
  }

  /* One sample of the hold-still test.  The reading is compared against the
   * mean of the streak so far rather than its first sample, so a slow drift
   * off the dot is caught as surely as a jump. */
  fixate(yaw, pitch, timestamp) {
    const c = this.config;
    // The hold is a *continuous* stretch of held-still readings, and the
    // progress bar measures wall-clock time rather than samples -- so
    // without this, a face lost mid-hold is silently spliced over.  Cover
    // the lens for a second and uncover it and the very next sample sees
    // the hold's full duration elapsed and finishes the pass on a centre
    // averaged from the three frames taken before the gap.
    if (this.streakAt !== null && timestamp - this.streakAt > c.calibrationGap) {
      this.resetFixation();
      this.resets += 1;
    }
    this.streakAt = timestamp;
    if (this.streak.length) {
      let meanYaw = 0, meanPitch = 0;
      for (const [y, p] of this.streak) { meanYaw += y; meanPitch += p; }
      meanYaw /= this.streak.length;
      meanPitch /= this.streak.length;
      if (Math.hypot(yaw - meanYaw, pitch - meanPitch) > c.calibrationTolerance) {
        this.resetFixation();
        this.resets += 1;
        return;
      }
    }
    if (this.streakStart === null) this.streakStart = timestamp;
    this.streak.push([yaw, pitch]);
    const hold = Math.max(1e-6, c.calibrationHold);
    const held = Math.max(0, timestamp - this.streakStart);
    this.progress = Math.min(1, held / hold);
    if (held >= hold) {
      let meanYaw = 0, meanPitch = 0;
      for (const [y, p] of this.streak) { meanYaw += y; meanPitch += p; }
      this.centre = [meanYaw / this.streak.length, meanPitch / this.streak.length];
      this.finish();
    }
  }

  /* The pass is done: bank everything the map is relative to.  The tuning
   * is only true for the viewport it happened in, so that is remembered,
   * and a later resize rescales against it instead of drifting. */
  finish() {
    this.calibrated = true;
    this.progress = 1;
    this.calWidth = this.width;
    this.calHeight = this.height;
  }

  // -- the map ----------------------------------------------------------

  /* `sample`: {yaw, pitch, tracked, confidence, timestamp (seconds)}. */
  update(sample) {
    const c = this.config;
    // The timestamp is as load-bearing as the angles: it drives the
    // smoothing, the onset gate and the hold, and one non-finite value put
    // through the smoother would leave it NaN for good -- a controller that
    // never commands anything again and never says why.
    const usable = sample.tracked && Number.isFinite(sample.yaw)
      && Number.isFinite(sample.pitch) && Number.isFinite(sample.timestamp);
    if (!usable) {
      // A blink or a hand across the face must not command a turn, but it
      // must not fling the view back either: ask for a stop.
      this.yawEma.reset();
      this.pitchEma.reset();
      this.release();
      this.settledAt = null;
      return this.still("lost", 0, 0, sample.confidence);
    }

    const yaw = this.yawEma.update(sample.yaw, sample.timestamp);
    const pitch = this.pitchEma.update(sample.pitch, sample.timestamp);
    const trusted = !(sample.confidence < c.minConfidence);

    if (!this.calibrated) {
      // A reading too poor to steer on is too poor to *measure* on.  It
      // used to go straight into the streak, so a half-seen face during the
      // hold could put its own offset into the one number every later error
      // is taken against -- and the deadzone is not wide enough to hide it.
      if (trusted) this.fixate(yaw, pitch, sample.timestamp);
      return this.still("calibrating", 0, 0, sample.confidence);
    }

    const centre = this.centre;
    const yawError = yaw - centre[0];
    const pitchError = pitch - centre[1];

    if (!trusted) {
      this.release();
      this.settledAt = null;
      return this.still("low confidence", yawError, pitchError, sample.confidence);
    }

    // The onset gate: eccentricity has to stay out of the deadzone for a
    // moment before anything moves.  Once it has, the gate stays open until
    // the eyes come back inside, so it cannot re-trigger mid-turn.
    const outside = Math.abs(yawError) > this.deadzoneYaw || Math.abs(pitchError) > this.deadzonePitch;
    if (!outside) {
      this.release();
    } else {
      if (this.outsideSince === null) this.outsideSince = sample.timestamp;
      if (sample.timestamp - this.outsideSince >= c.onset) this.committed = true;
    }

    // Inside the deadzone nothing is being asked for, which is exactly when
    // the neutral is allowed to learn where "nothing" is.
    this.settle(outside, yawError, pitchError, sample.timestamp);

    if (!this.committed) {
      return this.still(outside ? "committing" : "holding", yawError, pitchError, sample.confidence);
    }

    let yawRate = responseAngle(yawError, this.deadzoneYaw, this.rateYaw, c.maxRateYaw, c.expo);
    let pitchRate = responseAngle(pitchError, this.deadzonePitch, this.ratePitch, this.maxRatePitch, c.expo);
    if (c.invertYaw) yawRate = -yawRate;
    if (c.invertPitch) pitchRate = -pitchRate;

    return {
      yawRate, pitchRate,
      state: yawRate || pitchRate ? "steering" : "holding",
      yawError, pitchError,
      confidence: sample.confidence,
      committed: true,
    };
  }

  /* Ease the neutral towards the eyes while they are asking for nothing.
   *
   * `outside` is the whole gate, and it is deliberately the *reading*, not
   * the commitment: a glance that is still waiting out the onset is already
   * a request, and letting the neutral chase it would quietly eat the very
   * turn about to be committed.  Inside the deadzone there is nothing to
   * eat, so the only thing this can follow is where the viewer's straight
   * ahead has actually got to.
   *
   * A gap in the readings is not settled across.  While the face was gone
   * the eyes were anywhere, and one long interval would put an alpha of
   * nearly one on a single sample -- the neutral snapping to wherever the
   * viewer happened to be looking when the tracker found them again.  What
   * counts as a gap is the same tolerance the hold uses: readings that far
   * apart are not one continuous look at anything. */
  settle(outside, yawError, pitchError, timestamp) {
    const last = this.settledAt;
    this.settledAt = timestamp;
    const tau = this.config.neutralTau;
    if (outside || last === null || !(tau > 0)) return;
    const dt = timestamp - last;
    if (!(dt > 0) || dt > this.config.calibrationGap) return;
    const alpha = 1 - Math.exp(-dt / tau);
    this.centre[0] += alpha * yawError;
    this.centre[1] += alpha * pitchError;
  }

  release() {
    this.committed = false;
    this.outsideSince = null;
  }

  /* Ask for a stop.  The body decides how gently to come to one. */
  still(state, yawError, pitchError, confidence) {
    return { yawRate: 0, pitchRate: 0, state, yawError, pitchError, confidence, committed: this.committed };
  }
}
