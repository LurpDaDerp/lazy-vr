/* The page's markup and styles, read as text: the module preload list
 * against the real import graph, the controls' accessible names, and the
 * few CSS rules that carry a behaviour (hit sizes, one tooltip at a time,
 * no animation behind the player). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const site = new URL("../../site/", import.meta.url);
const read = (path) => readFileSync(new URL(path, site), "utf8");
const html = read("index.html");

/* Every module reachable from app.js through static imports. */
function staticGraph(entry) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = read(`js/${name}`);
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["']\.\/([\w-]+\.js)["']/gms)) {
      visit(match[1]);
    }
  };
  visit(entry);
  return seen;
}

const tagOf = (id) => {
  const match = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`, "s").exec(html);
  assert.ok(match, `#${id} is in the page`);
  return match[0];
};

test("modulepreload lists exactly the static module graph, so no import level waits on the last", () => {
  const preloads = new Set([...html.matchAll(/<link rel="modulepreload" href="js\/([\w-]+\.js)">/g)].map((m) => m[1]));
  const graph = staticGraph("app.js");
  assert.ok(graph.has("filters.js"), "the graph reaches the third level");
  assert.deepEqual([...preloads].sort(), [...graph].sort());
  // Worker-side modules load on demand.
  for (const lazy of ["tracker-core.js", "tracker-worker.js", "pose.js", "eyes.js"]) assert.equal(preloads.has(lazy), false);
  // In <head>, before the stylesheets' end, and the entry script still runs.
  assert.ok(html.indexOf('rel="modulepreload"') < html.indexOf("</head>"));
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
});

test("the tracking toggle keeps one name; its changing word is the description", () => {
  const track = tagOf("trackbtn");
  assert.match(track, /aria-label="Head tracking"/);
  assert.match(track, /aria-describedby="tracklabel"/);
  assert.match(track, /aria-pressed=/);
  assert.match(html, /<span id="tracklabel">/);
  // Recenter is named on its own too, whatever happens to its visible word.
  assert.match(tagOf("recenterbtn"), /aria-label="Recenter"/);
});

test("focus taken back from youtube's iframe has a place to land: #player is focusable by script only", () => {
  assert.match(tagOf("player"), /tabindex="-1"/);
  assert.match(read("css/player.css"), /#player:focus\s*\{\s*outline:\s*none;/);
});

test("narrow windows hide the button words visually, never with display: none", () => {
  const css = read("css/player.css");
  const narrow = css.slice(css.indexOf("@media (max-width: 640px)"));
  const rule = /\.pbtn\.labeled span\s*\{([^}]*)\}/.exec(narrow);
  assert.ok(rule);
  assert.doesNotMatch(rule[1], /display:\s*none/);
  assert.match(rule[1], /clip-path:\s*inset\(50%\)/);
});

test("the seek bar and the volume slider have the 40px hit band", () => {
  const css = read("css/player.css");
  const band = /\.seek::before\s*\{([^}]*)\}/.exec(css);
  assert.ok(band, ".seek::before widens the hit band");
  assert.match(band[1], /top:\s*-10px/);
  assert.match(band[1], /bottom:\s*-10px/);
  assert.match(/\.seek\s*\{([^}]*)\}/.exec(css)[1], /height:\s*20px/);
  assert.match(/\.volume input\[type="range"\]\s*\{([^}]*)\}/.exec(css)[1], /height:\s*var\(--control\)/);
  assert.match(read("css/tokens.css"), /--control:\s*40px/);
});

test("the tracking button dims only its glyph when off or busy; the word stays Star", () => {
  const css = read("css/player.css");
  assert.match(css, /#trackbtn\[data-tone="busy"\] \.icon, #trackbtn\[data-tone="off"\] \.icon \{ color: var\(--star-dim\); \}/);
  assert.doesNotMatch(css, /#trackbtn\[data-tone="(busy|off)"\]\s*[,{]/);
  // The bottom wash is DESIGN.md's 260px.
  assert.match(/^#chrome::after\s*\{([^}]*)\}/m.exec(css)[1], /height:\s*260px/);
});

test("one tooltip at a time: a hovered control hides the focused one's", () => {
  const css = read("css/player.css");
  assert.match(css, /#chrome:has\(\[data-tip\]:hover\) \[data-tip\]:focus-visible:not\(:hover\)::after\s*\{[^}]*visibility:\s*hidden/);
});

test("nothing in the hidden library animates behind the player, skeletons included", () => {
  const css = read("css/library.css");
  const off = /((?:body:not\(\.browsing\) #library [^,{]+,\s*)*body:not\(\.browsing\) #library [^,{]+)\{\s*animation:\s*none;\s*\}/.exec(css);
  assert.ok(off, "an off-switch exists");
  const selectors = off[1].split(",").map((s) => s.trim());
  for (const animated of [".strip", ".skeleton h2", ".skeleton .shelfrow i::before", ".skeleton .shelfrow i::after"]) {
    assert.ok(selectors.includes(`body:not(.browsing) #library ${animated}`), animated);
  }
});
