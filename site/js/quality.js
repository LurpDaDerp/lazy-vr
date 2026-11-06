/* Which YouTube tier a 360 video needs, and what this device can decode.
 *
 * The embed ignores every documented quality call (setPlaybackQuality, vq,
 * suggestedQuality are no-ops since 2019).  What it does obey is the iframe's
 * *layout* size, so embed.js sizes the iframe for the tier chosen here and
 * scales it back down with a CSS transform.
 *
 * A 360 frame spreads its width over the whole circle while the viewport
 * shows only hFov of it, so the tier that pixel-matches a 1920 px window at
 * 100° is ~6900 px wide -- far above the "screen-sized" tier.  Labels map to
 * frame WIDTH for 360 uploads (hd2160 = 3840 wide, 2:1 or 16:9 high).
 *
 * Pure apart from decodeCap(), which only touches the MediaCapabilities
 * object it is handed.
 */

/* The ladder by frame width.  hd2880 exists on YouTube but is left out of
 * the target ladder on purpose: 8K is the only step above 4K we aim for. */
export const TIERS = Object.freeze([
  Object.freeze({ label: "tiny", w: 256, h: 144 }),
  Object.freeze({ label: "small", w: 426, h: 240 }),
  Object.freeze({ label: "medium", w: 640, h: 360 }),
  Object.freeze({ label: "large", w: 854, h: 480 }),
  Object.freeze({ label: "hd720", w: 1280, h: 720 }),
  Object.freeze({ label: "hd1080", w: 1920, h: 1080 }),
  Object.freeze({ label: "hd1440", w: 2560, h: 1440 }),
  Object.freeze({ label: "hd2160", w: 3840, h: 2160 }),
  Object.freeze({ label: "highres", w: 7680, h: 4320 }),
]);

/* Every label the player may report, as the "p" number people know. */
export const LEVEL_HEIGHTS = Object.freeze({
  tiny: 144, small: 240, medium: 360, large: 480,
  hd720: 720, hd1080: 1080, hd1440: 1440, hd2160: 2160, hd2880: 2880,
  highres: 4320,
});

export const DEFAULT_FOV = 100;   // horizontal degrees
export const AUTO_CEILING = 2160; // auto never asks for 8K: a 33 MP render per frame
export const MISSING_API_CAP = 2160;

const finite = (x) => typeof x === "number" && Number.isFinite(x);

/* Equirect width that pixel-matches the viewport at the centre of view:
 * screen px/deg = cssWidth·dpr/hFov, frame px/deg = width/360. */
export function requiredWidth(cssWidth, dpr = 1, hFovDeg = DEFAULT_FOV) {
  if (!finite(cssWidth) || cssWidth <= 0) return 0;
  const density = finite(dpr) && dpr > 0 ? dpr : 1;
  const fov = finite(hFovDeg) && hFovDeg > 0 && hFovDeg <= 360 ? hFovDeg : DEFAULT_FOV;
  return (360 * cssWidth * density) / fov;
}

/* Tier object for a label, a height or a tier; null when unknown. */
export function tierOf(value) {
  if (value && typeof value === "object" && finite(value.w)) return value;
  if (typeof value === "string") {
    const height = LEVEL_HEIGHTS[value];
    if (!height) return null;
    return TIERS.find((tier) => tier.label === value) || null;
  }
  if (finite(value)) return TIERS.find((tier) => tier.h === value) || null;
  return null;
}

/* A cap given as a height, a label, a tier or "auto"-like junk → a height
 * (Infinity = uncapped). */
function capToHeight(cap) {
  if (cap == null) return Infinity;
  if (finite(cap)) return cap > 0 ? cap : Infinity;
  if (typeof cap === "string") return LEVEL_HEIGHTS[cap] || (finite(Number(cap)) && Number(cap) > 0 ? Number(cap) : Infinity);
  if (typeof cap === "object" && finite(cap.h)) return cap.h;
  return Infinity;
}

/* The largest ladder tier at or under a height cap (the bottom rung if the
 * cap is below everything). */
export function tierAtMost(cap) {
  const limit = capToHeight(cap);
  let best = TIERS[0];
  for (const tier of TIERS) if (tier.h <= limit) best = tier;
  return best;
}

/* Smallest tier whose width covers requiredW, limited by the cap. */
export function targetTier(requiredW, cap) {
  const ceiling = tierAtMost(cap);
  const need = finite(requiredW) ? requiredW : 0;
  for (const tier of TIERS) {
    if (tier.h > ceiling.h) break;
    if (tier.w >= need) return tier;
  }
  return ceiling;
}

/* One rung down the ladder, or null at the bottom. */
export function tierBelow(tier) {
  const current = tierOf(tier);
  if (!current) return null;
  const index = TIERS.findIndex((t) => t.label === current.label);
  return index > 0 ? TIERS[index - 1] : null;
}

/* The cap (a height) for a "Max quality" setting.  Auto = min(decode, 4K);
 * an explicit 1080/1440/2160 is honoured as asked; 8K stays bounded by what
 * the device can decode. */
export function qualityCap(setting, decodeCapHeight = MISSING_API_CAP) {
  const decode = finite(decodeCapHeight) && decodeCapHeight > 0 ? decodeCapHeight : MISSING_API_CAP;
  const asked = Number(setting);
  if (setting === "auto" || setting == null || !finite(asked) || asked <= 0) {
    return Math.min(decode, AUTO_CEILING);
  }
  if (asked > AUTO_CEILING) return Math.min(asked, decode);
  return asked;
}

/* Everything the app needs in one call.  `ceiling` is the session-sticky
 * stall step-down (a tier/label/height, or null). */
export function chooseTier({ cssWidth, dpr = 1, hFov = DEFAULT_FOV, setting = "auto",
  decodeCap: decode = MISSING_API_CAP, ceiling = null } = {}) {
  const cap = Math.min(qualityCap(setting, decode), capToHeight(ceiling));
  return targetTier(requiredWidth(cssWidth, dpr, hFov), cap);
}

/* Layout scale for the iframe: big enough that its CSS layout width is the
 * tier's frame width, never shrunk, never past kMax (YouTube's own UI --
 * ads, the skip button -- shrinks by 1/k). */
export const K_MAX = 3;
export function layoutScale(cssWidth, tierWidth, kMax = K_MAX) {
  if (!finite(cssWidth) || cssWidth <= 0 || !finite(tierWidth) || tierWidth <= 0) return 1;
  const max = finite(kMax) && kMax >= 1 ? kMax : 1;
  return Math.min(max, Math.max(1, tierWidth / cssWidth));
}

// ------------------------------------------------------------ decode cap

const PROBES = Object.freeze({
  4320: [
    { contentType: 'video/webm; codecs="vp09.00.61.08"', width: 7680, height: 3840, bitrate: 60e6, framerate: 30 },
    { contentType: 'video/mp4; codecs="av01.0.16M.08"', width: 7680, height: 3840, bitrate: 60e6, framerate: 30 },
  ],
  2160: [
    { contentType: 'video/webm; codecs="vp09.00.51.08"', width: 3840, height: 1920, bitrate: 30e6, framerate: 30 },
    { contentType: 'video/mp4; codecs="av01.0.13M.08"', width: 3840, height: 1920, bitrate: 30e6, framerate: 30 },
  ],
});

const PROBE_TIMEOUT_MS = 1500;
const decodeCache = new WeakMap();

/* 'ok' | 'no' | 'unknown' (threw, rejected or timed out). */
async function probe(mc, video) {
  let timer;
  try {
    const info = await Promise.race([
      mc.decodingInfo({ type: "media-source", video }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS); }),
    ]);
    if (!info) return "unknown";
    return info.supported && info.smooth && info.powerEfficient ? "ok" : "no";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/* Highest tier height this device decodes smoothly and power-efficiently:
 * 4320, 2160 or 1440.  No API (or an API that answers nothing) → 2160.
 * Cached per MediaCapabilities object; never rejects.
 * Note: browsers report smooth/powerEfficient optimistically until they have
 * stats, so this is permission to try a tier, not a guarantee. */
export function decodeCap(mc = globalThis.navigator && globalThis.navigator.mediaCapabilities) {
  if (!mc || typeof mc.decodingInfo !== "function") return Promise.resolve(MISSING_API_CAP);
  let cached = decodeCache.get(mc);
  if (!cached) {
    cached = (async () => {
      const [eight, four] = await Promise.all([
        Promise.all(PROBES[4320].map((video) => probe(mc, video))),
        Promise.all(PROBES[2160].map((video) => probe(mc, video))),
      ]);
      if (eight.includes("ok")) return 4320;
      if (four.includes("ok")) return 2160;
      if ([...eight, ...four].every((answer) => answer === "unknown")) return MISSING_API_CAP;
      return 1440;
    })();
    decodeCache.set(mc, cached);
  }
  return cached;
}

// ------------------------------------------------------------ stall policy

/* Decides when repeated rebuffering means the layout tier should step down.
 * Fed the player's BUFFERING / PLAYING transitions and the app's own seeks;
 * times in seconds on any monotonic clock.  Counts stalls only after
 * playback has started, outside the start-up grace, and not the buffering a
 * seek causes.  `buffering()` returns true once per `threshold` stalls inside
 * `windowSec`; the caller steps the tier down (and never back up). */
export class StallMonitor {
  constructor({ threshold = 3, windowSec = 60, graceSec = 3, stepGraceSec = 10, seekWindowSec = 5 } = {}) {
    this.threshold = threshold;
    this.seekWindowSec = seekWindowSec;
    this.windowSec = windowSec;
    this.graceSec = graceSec;
    this.stepGraceSec = stepGraceSec;
    this.reset();
  }

  /* New video. */
  reset() {
    this.startedAt = null;
    this.quietUntil = -Infinity;
    this.stalls = [];
    this.inStall = false;
    this.seekAt = null;
    this.lastT = -Infinity;
    this.steps = 0;
  }

  /* Accepts t only when finite and not going backwards. */
  accept(t) {
    if (!finite(t) || t < this.lastT) return false;
    this.lastT = t;
    return true;
  }

  playing(t) {
    if (!this.accept(t)) return;
    if (this.startedAt === null) {
      this.startedAt = t;
      this.quietUntil = Math.max(this.quietUntil, t + this.graceSec);
    }
    this.inStall = false;
    this.seekAt = null;
  }

  /* The app seeked: buffering within seekWindowSec of it is not a stall.
   * (A seek inside the buffer may produce no state change at all, so the
   * excuse expires rather than waiting for the next PLAYING.) */
  seeked(t) {
    if (!this.accept(t)) return;
    this.seekAt = t;
    this.inStall = false;
  }

  /* Paused/ended: a later BUFFERING is a fresh transition. */
  paused(t) {
    if (!this.accept(t)) return;
    this.inStall = false;
  }

  buffering(t) {
    if (!this.accept(t)) return false;
    if (this.inStall) return false;          // the same stall reported twice
    this.inStall = true;
    if (this.startedAt === null) return false; // initial load
    if (this.seekAt !== null) {
      const sinceSeek = t - this.seekAt;
      this.seekAt = null;
      if (sinceSeek <= this.seekWindowSec) return false;
    }
    if (t < this.quietUntil) return false;
    this.stalls.push(t);
    while (this.stalls.length && this.stalls[0] <= t - this.windowSec) this.stalls.shift();
    if (this.stalls.length < this.threshold) return false;
    this.stalls.length = 0;
    this.steps += 1;
    // The tier switch itself rebuffers; do not count that against the new tier.
    this.quietUntil = t + this.stepGraceSec;
    return true;
  }
}
