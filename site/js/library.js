/* The start screen: shelves of youtube's 360 uploads, and a search box.
 *
 * Everything comes from this site's own server -- /api/home for the
 * shelves, /api/search for the box -- which asks youtube's search with the
 * 360° feature filter, so every card is a real equirectangular upload.
 */

/* JSON from our own API.  An abort is rethrown as is (callers recognise it
 * by name); every other failure becomes a sentence for the page. */
async function getJson(url, { signal } = {}) {
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    throw new Error("the LazyVR server is not answering");
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    /* an error page, not JSON */
  }
  if (!response.ok || (data && data.error)) {
    throw new Error((data && data.error) || `the server said ${response.status}`);
  }
  if (!data || typeof data !== "object") throw new Error("the server's answer was not readable");
  return data;
}

export const fetchHome = (options) => getJson("api/home", options);
export const fetchSearch = (query, options) => getJson(`api/search?q=${encodeURIComponent(query)}`, options);

export const isAbort = (error) => Boolean(error && error.name === "AbortError");

/* Newest wins: start() aborts whatever the previous start() began and hands
 * back a signal plus a check that stays true only while this run is the
 * latest.  Used for search, where an abandoned query must never render. */
export class Latest {
  constructor() {
    this.controller = null;
    this.run = 0;
  }

  start() {
    this.abort();
    const controller = new AbortController();
    const run = ++this.run;
    this.controller = controller;
    return { signal: controller.signal, current: () => run === this.run && !controller.signal.aborted };
  }

  abort() {
    this.run += 1;
    if (this.controller) this.controller.abort();
    this.controller = null;
  }
}

/* Thumbnail candidates for a card.  The server hands out mqdefault
 * (320×180, the 1x picture), and hqdefault (480×360, letterboxed 4:3 that
 * object-fit: cover crops back to 16:9) always exists too: those two are all
 * a shelf card gets, hqdefault serving as its 2x source.  A shelf of cards at
 * 2x would otherwise pull a 1280px JPEG per card (megabytes before anything
 * plays).  Only the results grid's bigger cards (`large`) are offered hq720
 * (1280×720), which some uploads lack: youtube then answers with a 120×90
 * grey placeholder that fires load, not error, so makeCard checks what came
 * back (isPlaceholder) and drops to the two safe sizes. */
const YT_THUMB = /^https:\/\/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//;

export function thumbSources(clip, { large = false } = {}) {
  const thumb = clip && typeof clip.thumb === "string" ? clip.thumb : "";
  const match = YT_THUMB.exec(thumb);
  if (!match) return { src: thumb, srcset: "", fallback: "" };
  const base = `https://i.ytimg.com/vi/${match[1]}`;
  const safe = `${base}/mqdefault.jpg 320w, ${base}/hqdefault.jpg 480w`;
  return { src: `${base}/mqdefault.jpg`, srcset: large ? `${safe}, ${base}/hq720.jpg 1280w` : safe, fallback: safe };
}

/* Whether a loaded thumbnail is youtube's "no such size" placeholder: a
 * 4:3 picture where a 16:9 hq720 was asked for.  (hqdefault is 4:3 by
 * design, so only the optional size is judged.) */
export function isPlaceholder(currentSrc, naturalWidth, naturalHeight) {
  if (!/\/hq720\.jpg(?:$|\?)/.test(currentSrc || "")) return false;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return false;
  return naturalWidth / naturalHeight < 1.5;
}

/* The card widths the CSS gives (library.css): shelves clamp(240px, 22vw,
 * 320px), the results grid fills columns of at least 260px. */
const SHELF_SIZES = "(min-width: 1455px) 320px, (min-width: 1091px) 22vw, 240px";
const GRID_SIZES = "(min-width: 1200px) 25vw, (min-width: 700px) 40vw, 90vw";

export function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return null;
  const whole = Math.round(seconds);
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts.map((part, index) => (index ? String(part).padStart(2, "0") : String(part))).join(":");
}

export function formatViews(views) {
  if (views == null || !isFinite(views)) return null;
  return `${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(views)} views`;
}

/* Cards near the viewport are about to load; their strips may shimmer. */
const loadWatcher = typeof IntersectionObserver === "function"
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const strip = entry.target.parentNode;
        if (strip && !strip.classList.contains("loaded") && !strip.classList.contains("blank")) {
          strip.classList.add("loading");
        }
        loadWatcher.unobserve(entry.target);
      }
    }, { rootMargin: "600px" })
  : null;

/* Cards about to be dropped, released from the watcher above first.  An
 * IntersectionObserver holds a strong reference to everything it is still
 * observing, so a card whose picture never came into view would keep its
 * <img> -- and the strip around it -- alive for the life of the page: run
 * the same search half a dozen times and every result set is still there.
 * The row watcher below is disconnected for exactly this reason. */
function releaseCards(container) {
  if (!loadWatcher) return;
  for (const image of container.querySelectorAll("img")) loadWatcher.unobserve(image);
}

/* One observer for every shelf row, released when the shelves are rebuilt,
 * so a row that has gone from the page is not kept alive by its watcher. */
const rowWatcher = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => { for (const entry of entries) entry.target.__update?.(); })
  : null;

export function makeCard(clip, onPick, sizes = SHELF_SIZES, { large = false } = {}) {
  const root = document.createElement("button");
  root.className = "card";
  root.type = "button";
  root.setAttribute("aria-label", `Play ${clip.title}`);
  if (clip.id) root.dataset.id = clip.id;

  const strip = document.createElement("span");
  strip.className = "strip";
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  // The seat and its shimmer show until the picture is there; a picture
  // that never comes leaves a plain seat rather than a shimmer forever.
  const sources = thumbSources(clip, { large });
  const safeOnly = () => sources.fallback && image.srcset !== sources.fallback;
  // Not once: after a placeholder is swapped out, the safe picture's own
  // load is the one that shows the card.
  image.addEventListener("load", () => {
    if (safeOnly() && isPlaceholder(image.currentSrc, image.naturalWidth, image.naturalHeight)) {
      image.srcset = sources.fallback;
      return;
    }
    strip.classList.remove("loading");
    strip.classList.add("loaded");
  });
  const failed = () => {
    // hq720 is missing for some uploads; fall back once to the sizes that
    // always exist before giving up on the picture.
    if (safeOnly()) {
      image.srcset = sources.fallback;
      return;
    }
    image.removeEventListener("error", failed);
    strip.classList.remove("loading");
    strip.classList.add("blank");
  };
  image.addEventListener("error", failed);
  // The shimmer starts when the browser is about to fetch the picture (the
  // same margin a lazy image loads at), not the moment the card exists.
  if (loadWatcher) loadWatcher.observe(image);
  if (sources.srcset) {
    image.sizes = sizes;
    image.srcset = sources.srcset;
  }
  image.src = sources.src;
  // Already cached: loaded now, unless it is the placeholder (whose load
  // event is still to come and swaps it out).
  if (image.complete && image.naturalWidth && !isPlaceholder(image.currentSrc, image.naturalWidth, image.naturalHeight)) {
    strip.classList.add("loaded");
  }
  const badge = document.createElement("span");
  badge.className = "badge";
  const length = formatDuration(clip.duration);
  badge.hidden = !length;
  if (length) badge.textContent = length;
  strip.append(image, badge);

  const title = document.createElement("span");
  title.className = "cardtitle";
  title.textContent = clip.title;

  const meta = document.createElement("span");
  meta.className = "cardmeta";
  const bits = [clip.channel, formatViews(clip.views)].filter(Boolean);
  bits.forEach((text, index) => {
    if (index) meta.appendChild(document.createElement("i"));
    const span = document.createElement("span");
    span.textContent = text;
    meta.appendChild(span);
  });

  root.append(strip, title, meta);
  root.addEventListener("click", () => onPick(clip, root));
  return root;
}

/* A shelf's arrow: an icon button in the gutter, one per direction. */
function makeArrow(dir) {
  const arrow = document.createElement("button");
  arrow.type = "button";
  arrow.className = "btn-icon shelf-arrow";
  arrow.dataset.dir = dir;
  arrow.setAttribute("aria-label", dir === "prev" ? "Scroll back" : "Scroll forward");
  arrow.innerHTML = `<svg class="icon"><use href="#i-chevron-${dir === "prev" ? "left" : "right"}"/></svg>`;
  return arrow;
}

/* The arrows scroll the row by most of a screen, and each is disabled
 * once the row cannot go further its way.  Disabling the arrow that holds
 * keyboard focus would drop focus on the body, so it is handed across. */
function armShelf(row, prev, next) {
  const still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = (sign) =>
    row.scrollBy({ left: sign * row.clientWidth * 0.8, behavior: still ? "auto" : "smooth" });
  const update = () => {
    const end = row.scrollWidth - row.clientWidth;
    const stuck = { prev: row.scrollLeft <= 1, next: row.scrollLeft >= end - 1 };
    for (const arrow of [prev, next]) if (!stuck[arrow.dataset.dir]) arrow.disabled = false;
    for (const arrow of [prev, next]) {
      if (!stuck[arrow.dataset.dir] || arrow.disabled) continue;
      const other = arrow === prev ? next : prev;
      if (document.activeElement === arrow && !other.disabled) other.focus({ preventScroll: true });
      arrow.disabled = true;
    }
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  row.addEventListener("scroll", update, { passive: true });
  // The row's width changes with the window and when the home page is
  // hidden for a search and shown again; the observer reports both.
  row.__update = update;
  if (rowWatcher) rowWatcher.observe(row);
  else window.addEventListener("resize", update);
  update();
}

/* The home page: one horizontal shelf per category. */
export function renderShelves(container, categories, onPick) {
  if (rowWatcher) rowWatcher.disconnect();
  releaseCards(container);
  container.textContent = "";
  let total = 0;
  for (const category of categories) {
    if (!category.clips || !category.clips.length) continue;
    total += category.clips.length;
    const section = document.createElement("section");
    section.className = "shelf";
    const head = document.createElement("h2");
    head.textContent = category.title;
    const row = document.createElement("div");
    row.className = "shelfrow";
    for (const clip of category.clips) row.appendChild(makeCard(clip, onPick));
    const prev = makeArrow("prev");
    const next = makeArrow("next");
    section.append(head, row, prev, next);
    container.appendChild(section);
    armShelf(row, prev, next);
  }
  return total;
}

/* Search results: a plain grid. */
export function renderResults(grid, clips, onPick) {
  releaseCards(grid);
  grid.textContent = "";
  for (const clip of clips) grid.appendChild(makeCard(clip, onPick, GRID_SIZES, { large: true }));
  return clips.length;
}
