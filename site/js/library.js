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
  image.src = clip.thumb;
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

/* The home page: one horizontal shelf per category. */
export function renderShelves(container, categories, onPick) {
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
    section.append(head, row);
    container.appendChild(section);
  }
  return total;
}

/* Search results: a plain grid. */
export function renderResults(grid, clips, onPick) {
  grid.textContent = "";
  for (const clip of clips) grid.appendChild(makeCard(clip, onPick));
  return clips.length;
}
