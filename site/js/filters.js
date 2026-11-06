/* Small signal-processing helpers shared by the tracking pipeline.
 * Pure: no DOM, no timers, no globals beyond Math. Times are in seconds. */

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export const lerp = (a, b, t) => a + (b - a) * t;

/* Wrap an angle in degrees into (-180, 180]. */
export function wrapDegrees(d) {
  if (!Number.isFinite(d)) return d;
  const r = d - 360 * Math.floor((d + 180) / 360);  // [-180, 180)
  return r === -180 ? 180 : r;
}

const TWO_PI = 2 * Math.PI;
const smoothing = (cutoff, dt) => 1 / (1 + 1 / (TWO_PI * cutoff * dt));

/* One Euro filter (Casiez et al. 2012).
 * - first sample passes through and seeds the state;
 * - a non-finite sample is ignored (returns the current output);
 * - dt <= 0 or a non-finite time leaves the state untouched (returns the current output). */
export class OneEuro {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.value = NaN;  // last output; NaN until the first usable sample
    this.dx = 0;
    this.t = NaN;
  }

  get initialized() { return Number.isFinite(this.value); }

  filter(x, tSec) {
    if (!Number.isFinite(x)) return this.value;
    if (!this.initialized) {
      if (!Number.isFinite(tSec)) return x;  // cannot seed a time base
      this.value = x;
      this.dx = 0;
      this.t = tSec;
      return x;
    }
    const dt = tSec - this.t;
    if (!(dt > 0)) return this.value;  // also catches NaN
    const dx = (x - this.value) / dt;
    this.dx += (dx - this.dx) * smoothing(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.value += (x - this.value) * smoothing(cutoff, dt);
    this.t = tSec;
    return this.value;
  }
}

/* Median of the last n finite samples. Non-finite samples are ignored. */
export class RollingMedian {
  constructor(n = 5) {
    this.n = Math.max(1, Math.floor(n) || 1);
    this.ring = new Float64Array(this.n);
    this.sorted = new Float64Array(this.n);
    this.reset();
  }

  reset() {
    this.count = 0;
    this.head = 0;  // next write slot
    this.median = NaN;
  }

  push(x) {
    if (!Number.isFinite(x)) return this.median;
    this.ring[this.head] = x;
    this.head = (this.head + 1) % this.n;
    if (this.count < this.n) this.count += 1;
    // n is small (5 frames): copy and insertion-sort.
    const s = this.sorted;
    const start = (this.head - this.count + this.n) % this.n;
    for (let k = 0; k < this.count; k++) {
      const v = this.ring[(start + k) % this.n];
      let j = k - 1;
      while (j >= 0 && s[j] > v) { s[j + 1] = s[j]; j -= 1; }
      s[j + 1] = v;
    }
    const c = this.count;
    this.median = c & 1 ? s[c >> 1] : 0.5 * (s[c / 2 - 1] + s[c / 2]);
    return this.median;
  }
}

/* Median over a sliding time window (seconds), e.g. the 2 s RMS median and the
 * 3 s open-eye EAR median. Samples older than tSec - windowSec are dropped.
 * Time going backwards is treated as a discontinuity: the window restarts. */
export class TimedMedian {
  constructor(windowSec, maxSamples = 1024) {
    this.windowSec = windowSec;
    this.maxSamples = maxSamples;
    this.times = [];   // FIFO, oldest first (shifted from `start` to avoid O(n) shifts)
    this.values = [];
    this.sorted = [];
    this.start = 0;
    this.median = NaN;
  }

  get count() { return this.times.length - this.start; }

  reset() {
    this.times.length = 0;
    this.values.length = 0;
    this.sorted.length = 0;
    this.start = 0;
    this.median = NaN;
  }

  push(x, tSec) {
    if (!Number.isFinite(x) || !Number.isFinite(tSec)) return this.median;
    const n = this.times.length;
    if (n > this.start && tSec < this.times[n - 1]) this.reset();
    this.times.push(tSec);
    this.values.push(x);
    this.insertSorted(x);
    this.evict(tSec);
    this.updateMedian();
    return this.median;
  }

  /* Drop samples outside the window ending at tSec without adding one. */
  prune(tSec) {
    if (!Number.isFinite(tSec)) return this.median;
    this.evict(tSec);
    this.updateMedian();
    return this.median;
  }

  evict(tSec) {
    const horizon = tSec - this.windowSec;
    while (this.count > 0 && (this.times[this.start] < horizon || this.count > this.maxSamples)) {
      this.removeSorted(this.values[this.start]);
      this.start += 1;
    }
    // Compact the FIFO occasionally so the arrays do not grow without bound.
    if (this.start > 256 && this.start * 2 > this.times.length) {
      this.times.splice(0, this.start);
      this.values.splice(0, this.start);
      this.start = 0;
    }
  }

  insertSorted(x) {
    const s = this.sorted;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < x) lo = mid + 1; else hi = mid; }
    s.splice(lo, 0, x);
  }

  removeSorted(x) {
    const s = this.sorted;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < x) lo = mid + 1; else hi = mid; }
    if (lo < s.length && s[lo] === x) s.splice(lo, 1);
  }

  updateMedian() {
    const s = this.sorted, c = s.length;
    this.median = c === 0 ? NaN : c & 1 ? s[c >> 1] : 0.5 * (s[c / 2 - 1] + s[c / 2]);
  }
}
