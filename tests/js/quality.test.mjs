/* The quality policy: the display sets the cap, the ladder is walked. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bestAllowedLevel, screenTier, tierBelow } from "../../site/js/quality.js";

test("screen: common monitors get their own class, not 8K", () => {
  assert.equal(screenTier(1920, 1080, 1), 1080);
  assert.equal(screenTier(2560, 1440, 1), 1440);
  assert.equal(screenTier(3840, 2160, 1), 2160);
});

test("screen: an in-between display rounds up, never down", () => {
  assert.equal(screenTier(3440, 1440, 1), 2160);  // ultrawide: 3440 wide
  assert.equal(screenTier(1920, 1200, 1), 1080);  // 16:10: still 1920 wide
});

test("screen: density counts — physical pixels, not CSS ones", () => {
  assert.equal(screenTier(1920, 1080, 2), 2160);
  assert.equal(screenTier(390, 844, 3), 1440);    // a dense phone
});

test("screen: orientation does not matter, and monsters are capped", () => {
  assert.equal(screenTier(844, 390, 3), screenTier(390, 844, 3));
  assert.equal(screenTier(15360, 8640, 1), 4320);
});

test("ladder: one rung down, and the bottom has none", () => {
  assert.equal(tierBelow(2160), 1440);
  assert.equal(tierBelow(4320), 2880);
  assert.equal(tierBelow(144), null);
});

test("levels: the best offered level under the cap wins", () => {
  const offered = ["highres", "hd2160", "hd1440", "hd1080", "hd720", "auto"];
  assert.equal(bestAllowedLevel(offered, 1440), "hd1440");
  assert.equal(bestAllowedLevel(offered, 4320), "highres");
  assert.equal(bestAllowedLevel(offered, 2880), "hd2160");
});

test("levels: when everything offered is too tall, take the lowest real one", () => {
  assert.equal(bestAllowedLevel(["hd2160", "hd1440", "auto"], 720), "hd1440");
});

test("levels: junk offerings yield nothing", () => {
  assert.equal(bestAllowedLevel(["auto", "default"], 2160), null);
  assert.equal(bestAllowedLevel([], 2160), null);
});
