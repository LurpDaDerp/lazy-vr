import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  Latest, fetchHome, fetchSearch, formatDuration, formatViews, isAbort, isPlaceholder, thumbSources,
} from "../../site/js/library.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("Latest: a new start aborts the previous run and only the newest is current", () => {
  const latest = new Latest();
  const a = latest.start();
  assert.equal(a.current(), true);
  const b = latest.start();
  assert.equal(a.signal.aborted, true);
  assert.equal(a.current(), false);
  assert.equal(b.current(), true);
  latest.abort();
  assert.equal(b.signal.aborted, true);
  assert.equal(b.current(), false);
});

test("fetchSearch: passes the signal, no cache override, and rethrows aborts as aborts", async () => {
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return json({ clips: [] }); };
  const controller = new AbortController();
  await fetchSearch("a b&c", { signal: controller.signal });
  assert.equal(seen.url, "api/search?q=a%20b%26c");
  assert.equal(seen.init.signal, controller.signal);
  assert.equal("cache" in seen.init, false);

  globalThis.fetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  await assert.rejects(fetchSearch("x"), (error) => isAbort(error));
});

test("fetchHome: readable errors for a dead server, an error body and a non-JSON body", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(fetchHome(), /not answering/);
  globalThis.fetch = async () => json({ error: "youtube said no" }, 502);
  await assert.rejects(fetchHome(), /youtube said no/);
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError("x"); } });
  await assert.rejects(fetchHome(), /500/);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } });
  await assert.rejects(fetchHome(), /not readable/);
  globalThis.fetch = async () => json({ categories: [] });
  assert.deepEqual(await fetchHome(), { categories: [] });
});

test("thumbSources: srcset for youtube thumbs, with a fallback that drops hq720", () => {
  const s = thumbSources({ thumb: "https://i.ytimg.com/vi/sPyAQQklc1s/mqdefault.jpg" }, { large: true });
  assert.equal(s.src, "https://i.ytimg.com/vi/sPyAQQklc1s/mqdefault.jpg");
  assert.match(s.srcset, /hqdefault\.jpg 480w/);
  assert.match(s.srcset, /hq720\.jpg 1280w/);
  assert.doesNotMatch(s.fallback, /hq720/);
  assert.match(s.fallback, /hqdefault\.jpg 480w/);
  const other = thumbSources({ thumb: "https://example.com/x.jpg" });
  assert.deepEqual(other, { src: "https://example.com/x.jpg", srcset: "", fallback: "" });
  assert.deepEqual(thumbSources({}), { src: "", srcset: "", fallback: "" });
});

test("thumbSources: a shelf card gets only the two sizes that always exist (no 1280px pull at 2x)", () => {
  const s = thumbSources({ thumb: "https://i.ytimg.com/vi/sPyAQQklc1s/mqdefault.jpg" });
  assert.equal(s.srcset,
    "https://i.ytimg.com/vi/sPyAQQklc1s/mqdefault.jpg 320w, https://i.ytimg.com/vi/sPyAQQklc1s/hqdefault.jpg 480w");
  assert.equal(s.srcset, s.fallback);
  assert.doesNotMatch(s.srcset, /hq720|sddefault|maxres/);
});

test("isPlaceholder: youtube's 4:3 grey stand-in for a missing hq720, and nothing else", () => {
  const hq720 = "https://i.ytimg.com/vi/Fy6uxsLX-Xc/hq720.jpg";
  assert.equal(isPlaceholder(hq720, 120, 90), true);
  assert.equal(isPlaceholder(hq720, 30, 22.5), true);    // density-corrected, same shape
  assert.equal(isPlaceholder(hq720, 1280, 720), false);
  assert.equal(isPlaceholder(hq720, 316, 177.75), false);
  // hqdefault is 4:3 by design; never judged.
  assert.equal(isPlaceholder("https://i.ytimg.com/vi/Fy6uxsLX-Xc/hqdefault.jpg", 480, 360), false);
  assert.equal(isPlaceholder("https://i.ytimg.com/vi/Fy6uxsLX-Xc/mqdefault.jpg", 120, 90), false);
  assert.equal(isPlaceholder(hq720, 0, 0), false);
  assert.equal(isPlaceholder("", 120, 90), false);
  assert.equal(isPlaceholder(undefined, 120, 90), false);
});

test("formatDuration and formatViews", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(NaN), null);
  assert.equal(formatViews(1500), "1.5K views");
  assert.equal(formatViews(null), null);
});
