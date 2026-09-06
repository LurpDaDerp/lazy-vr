/* Which quality tier a display actually deserves.
 *
 * An 8K equirect on a 1440p monitor is pixels the screen cannot show,
 * bought with a decode most machines cannot afford -- the single biggest
 * cause of a stuttering camera.  So the cap is set by the display itself:
 * the screen's *physical* pixels (fullscreen-sized, not window-sized),
 * matched to youtube's tier ladder.  Uploads are equirect in 16:9 frames,
 * so a tier's width is what must cover the screen's width, which is the
 * tier height times 16/9 -- hence the 9/16 below.
 *
 * The cap is a tier height, and youtube's player is the one engine that can
 * act on it: it pins the named level that matches (LEVEL_HEIGHTS below).  A
 * file off this device has only the encode it was made with.
 */

export const TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 2880, 4320];

/* The names the iframe player calls its tiers. */
export const LEVEL_HEIGHTS = {
  tiny: 144, small: 240, medium: 360, large: 480,
  hd720: 720, hd1080: 1080, hd1440: 1440, hd2160: 2160, hd2880: 2880,
  highres: 4320,
};

/* The smallest tier that still covers the display's physical width. */
export function screenTier(width, height, dpr = 1) {
  const physical = Math.max(width, height) * Math.max(1, dpr);
  const needed = physical * 9 / 16;
  for (const tier of TIERS) {
    if (tier >= needed - 1) return tier;
  }
  return TIERS[TIERS.length - 1];
}

export function tierBelow(height) {
  const index = TIERS.indexOf(height);
  return index > 0 ? TIERS[index - 1] : null;
}

/* The best of the player's offered levels that stays under the cap; when
 * everything offered is above it, the lowest real level on offer. */
export function bestAllowedLevel(levels, maxHeight) {
  let best = null;
  let bestHeight = -1;
  for (const level of levels || []) {
    const height = LEVEL_HEIGHTS[level];
    if (!height) continue;  // "auto" and friends
    if (height <= maxHeight && height > bestHeight) {
      best = level;
      bestHeight = height;
    }
  }
  if (best) return best;
  const real = (levels || []).filter((level) => LEVEL_HEIGHTS[level]);
  return real.length ? real[real.length - 1] : null;
}
