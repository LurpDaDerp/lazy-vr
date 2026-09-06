/* The start screen: shelves of youtube's 360 uploads, and a search box.
 *
 * Everything comes from this site's own server -- /api/home for the
 * shelves, /api/search for the box -- which asks youtube's search with the
 * 360° feature filter, so every card is a real equirectangular upload.
 */

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error("the LazyVR server is not answering");
  }
  let data = null;
  try {
    data = await response.json();
  } catch { /* an error page, not JSON */ }
  if (!response.ok || (data && data.error)) {
    throw new Error((data && data.error) || `the server said ${response.status}`);
  }
  return data;
}

export const fetchHome = () => getJson("api/home");
export const fetchSearch = (query) => getJson(`api/search?q=${encodeURIComponent(query)}`);
export const fetchStreams = (id, prefs) =>
  getJson(`api/streams/${encodeURIComponent(id)}?codecs=${prefs.codecs}&max=${prefs.max}`);

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

/* One observer for every shelf row, released when the shelves are rebuilt,
 * so a row that has gone from the page is not kept alive by its watcher. */
const rowWatcher = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => { for (const entry of entries) entry.target.__update?.(); })
  : null;

export function makeCard(clip, onPick) {
  const root = document.createElement("button");
  root.className = "card";
  root.type = "button";
  root.setAttribute("aria-label", `Play ${clip.title}`);

  const strip = document.createElement("span");
  strip.className = "strip";
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  // The seat and its shimmer show until the picture is there; a picture
  // that never comes leaves a plain seat rather than a shimmer forever.
  image.addEventListener("load", () => { strip.classList.remove("loading"); strip.classList.add("loaded"); }, { once: true });
  image.addEventListener("error", () => { strip.classList.remove("loading"); strip.classList.add("blank"); }, { once: true });
  // The shimmer starts when the browser is about to fetch the picture (the
  // same margin a lazy image loads at), not the moment the card exists.
  if (loadWatcher) loadWatcher.observe(image);
  image.src = clip.thumb;
  if (image.complete && image.naturalWidth) strip.classList.add("loaded");
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
  root.addEventListener("click", () => onPick(clip));
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
  grid.textContent = "";
  for (const clip of clips) grid.appendChild(makeCard(clip, onPick));
  return clips.length;
}
