/* The start screen: the manifest, and a grid of cards drawn from it.
 *
 * The site is static, so the library is a file -- library.json, written by
 * tools/build_library.py -- rather than a folder scanned on demand.  Each
 * card's picture is the horizon band of the sphere, left unrolled and four
 * times wider than the card shows, so hovering pans across the whole turn.
 */

export async function loadManifest(url = "library.json") {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`library.json: ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.clips)) throw new Error("library.json has no clips");
  return data;
}

export function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return null;
  const whole = Math.round(seconds);
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts.map((part, index) => (index ? String(part).padStart(2, "0") : String(part))).join(":");
}

export function makeCard(clip, onPick) {
  const root = document.createElement("button");
  root.className = "card";
  root.type = "button";
  root.setAttribute("aria-label", `Play ${clip.title}${clip.quality ? `, ${clip.quality}` : ""}`);

  const strip = document.createElement("span");
  strip.className = "strip" + (clip.thumb ? "" : " waiting");
  const image = document.createElement("img");
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  if (clip.thumb) image.src = clip.thumb;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.hidden = !clip.quality;
  if (clip.quality) badge.textContent = clip.quality;
  strip.append(image, badge);

  const title = document.createElement("span");
  title.className = "cardtitle";
  title.textContent = clip.title;

  const meta = document.createElement("span");
  meta.className = "cardmeta mono";
  const length = formatDuration(clip.duration);
  if (length) meta.textContent = length;

  root.append(strip, title, meta);
  root.addEventListener("click", () => onPick(clip));
  return root;
}

export function renderLibrary(grid, manifest, onPick) {
  grid.textContent = "";
  for (const clip of manifest.clips) grid.appendChild(makeCard(clip, onPick));
  return manifest.clips.length;
}
