/* The HUD: what the viewer is told about the session, and how.
 *
 * Two layers.  The awake layer is chrome: it exists while the pointer moves,
 * while paused, and while the settings panel is open -- the moments a
 * viewer is handling the page rather than looking around.  The peripheral
 * layer is a handful of marks that have to be seen without being looked at,
 * because with a 1.8 degree deadzone looking at anything in a corner turns
 * the sphere toward it: the face is lost, the neck is at its end, the
 * picture is buffering, the picture is paused.
 *
 * The pure helpers at the top decide what the marks say; the painter at
 * the bottom puts it on the page and is the only part that touches the
 * DOM.
 */

import { PITCH_LIMIT, YAW_LIMIT } from "./body.js";

/* Seconds into a clock: "1:05", "1:01:01".  Null for anything that is not
 * a finite number, which is what both engines report for a duration they do
 * not know yet. */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const whole = Math.max(0, Math.round(seconds));
  const parts = [Math.floor(whole / 60) % 60, whole % 60];
  if (whole >= 3600) parts.unshift(Math.floor(whole / 3600));
  return parts.map((part, index) => (index ? String(part).padStart(2, "0") : String(part))).join(":");
}

/* The tier a viewer would recognise: "2160p", "1080p60".  The frame rate
 * only matters when it is high; 24, 25 and 30 are all just video. */
export function qualityLabel(height, fps) {
  if (!Number.isFinite(height) || height <= 0) return null;
  const high = Number.isFinite(fps) && fps > 40 ? String(Math.round(fps)) : "";
  return `${Math.round(height)}p${high}`;
}

/* Which player is in use, named for the viewer, not the code. */
export function engineLabel(mode) {
  switch (mode) {
    case "embed": return "youtube player";
    case "local": return "This device";
    default: return "";
  }
}

/* How long the chrome stays up after the pointer stops. */
export const HUD_IDLE_MS = 3000;

/* Whether the playback chrome is up.  A pure reading of the session, so
 * that the one rule with five exemptions lives in one testable place
 * rather than in a handful of timers.
 *
 * Four of the exemptions are the moments the chrome is the thing being
 * used rather than the thing in the way: the library, the run-up to a
 * calibration, the settings panel, and a paused picture, which is being
 * read rather than watched.  The fifth is the pointer itself: `focused` is
 * false only when the window has lost the focus to another application,
 * and a window that cannot see the pointer would have nothing able to
 * bring the chrome back.  Focus that has gone into youtube's iframe does
 * not count -- the catcher over it reports the pointer for us -- so the
 * chrome fades under the embed exactly as it does over the sphere. */
export function hudAwake({ browsing, started, calibrated, settingsOpen, paused, focused, sincePointerMs }) {
  if (browsing || !started || !calibrated) return true;
  if (settingsOpen) return true;
  if (paused) return true;
  if (!focused) return true;
  return sincePointerMs < HUD_IDLE_MS;
}

/* One word for the tracker's health, worst first.  `state` is the control
 * law's word for the last reading, `mirror` whether the second gaze pass
 * is still running, `stale` whether readings have stopped arriving. */
export function trackerHealth({ state, mirror, stale }) {
  if (state === "lost") return "lost";
  if (stale) return "stale";
  if (state === "low confidence") return "dim";
  if (!mirror) return "onepass";
  return "ok";
}

/* Which edge of the screen the neck is being pushed against, and how hard.
 * Body yaw is positive to the viewer's left, pitch positive up; each axis is
 * judged against its own limit, so 90 degrees of yaw is less of a push than
 * 80 degrees of pitch.  With yaw free only the vertical limit exists. */
export function neckEdge({ yaw, pitch, strain, freeYaw }) {
  if (!(strain > 0)) return null;
  const strength = Math.min(1, strain);
  const vertical = pitch / PITCH_LIMIT;
  if (freeYaw) return { side: vertical >= 0 ? "top" : "bottom", strength };
  const horizontal = yaw / YAW_LIMIT;
  if (Math.abs(horizontal) >= Math.abs(vertical)) {
    return { side: horizontal >= 0 ? "left" : "right", strength };
  }
  return { side: vertical >= 0 ? "top" : "bottom", strength };
}

/* ---------- the painter ---------- */

const ENGINE_ICON = { embed: "#i-yt", local: "#i-folder" };
const ENGINE_TEXT = { embed: "youtube player", local: "This device" };
const HEALTH_ICON = { ok: "#i-eye", onepass: "#i-eye-one", dim: "#i-eye", stale: "#i-eye-off", lost: "#i-eye-off" };
const HEALTH_TEXT = { ok: "", onepass: "1-pass", dim: "low light", stale: "no signal", lost: "no face" };
const HEALTH_TITLE = {
  ok: "Gaze tracker: fine",
  onepass: "Gaze tracker: one pass, to stay smooth",
  dim: "Gaze tracker: low confidence — more light on your face helps",
  stale: "Gaze tracker: no readings",
  lost: "Gaze tracker: no face in view",
};

/* The horizon ring's geometry: the top of a large circle, ninety degrees
 * of heading across the width, like the rim of the dome seen from the
 * middle seat. */
const RING_W = 320;
const RING_H = 56;
const RING_R = 520;
const RING_SPAN = Math.asin((RING_W / 2 - 4) / RING_R) * 2;  // radians of arc for 90° of heading
const CARDINAL = { 0: "N", 90: "E", 180: "S", 270: "W" };

const wrap180 = (angle) => ((angle % 360) + 540) % 360 - 180;
const sign = (v) => (v >= 0 ? "+" : "");

export function createHud(doc = document) {
  const $ = (id) => doc.getElementById(id);
  const el = {
    title: $("hudtitle"),
    ring: $("ring"),
    quality: $("quality"), engine: $("engine"), engineIcon: $("engineicon"),
    tracker: $("tracker"), trackerIcon: $("trackericon"),
    playIcon: $("playicon"), playBtn: $("playbtn"),
    elapsed: $("elapsed"), duration: $("duration"), played: $("played"),
    soundIcon: $("soundicon"), muteBtn: $("mutebtn"), vollevel: $("vollevel"),
    bufferline: $("bufferline"), edge: $("edge"), facemark: $("facemark"), pausemark: $("pausemark"),
    dState: $("d-state"), dHeading: $("d-heading"), dGaze: $("d-gaze"), dRate: $("d-rate"), dTurn: $("d-turn"),
    dNeck: $("d-neck"), dPerf: $("d-perf"), stick: $("stick"),
  };
  const ring = el.ring.getContext("2d");
  const stick = el.stick.getContext("2d");
  const font = getComputedStyle(doc.body).fontFamily;

  // Hoisted: constant across redraws.  A CanvasGradient is an object the
  // collector would otherwise sweep once per frame during a turn, and the
  // font string is parsed on every assignment.
  const ringFont = `600 11px ${font}`;
  const rimStyle = ring.createLinearGradient(0, 0, RING_W, 0);
  rimStyle.addColorStop(0, "rgba(58, 70, 128, 0)");
  rimStyle.addColorStop(0.18, "rgba(58, 70, 128, 0.9)");
  rimStyle.addColorStop(0.82, "rgba(58, 70, 128, 0.9)");
  rimStyle.addColorStop(1, "rgba(58, 70, 128, 0)");
  const BRASS = "#9c8560";
  const LAMP = "#f0b56b";
  const SCRIM = "rgba(6, 8, 20, 0.85)";

  let ringDpr = 0;
  let shownHeading = "";
  let shownTransport = "";
  let shownClock = "";
  let shownStatus = "";
  let shownPeriphery = "";
  let shownTitle = null;

  function fitRing() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (dpr === ringDpr) return;
    ringDpr = dpr;
    el.ring.width = Math.round(RING_W * dpr);
    el.ring.height = Math.round(RING_H * dpr);
    el.ring.style.width = `${RING_W}px`;
    el.ring.style.height = `${RING_H}px`;
  }

  return {
    setTitle(text) {
      const value = text || "";
      if (value === shownTitle) return;
      shownTitle = value;
      el.title.textContent = value;
      el.title.hidden = !value;
    },

    /* The ring: brass ticks on a dusk arc scrolling under a lamp lubber
     * line.  `heading` in degrees, 0..360, 0 being where the clip started.
     * The number itself lives in the diagnostics: a numeral is read, and
     * the ring is meant to be seen. */
    paintCompass(heading) {
      // A tenth of a degree is finer than the eye; a DOM write and a
      // redraw for an unchanged number is work for nothing.
      const key = heading.toFixed(1);
      if (key === shownHeading) return;
      shownHeading = key;

      fitRing();
      const dpr = ringDpr;
      const cx = RING_W / 2;
      const cy = RING_R + 6;
      ring.setTransform(dpr, 0, 0, dpr, 0, 0);
      ring.clearRect(0, 0, RING_W, RING_H);
      ring.lineCap = "round";
      ring.font = ringFont;
      ring.textAlign = "center";
      ring.textBaseline = "middle";

      // Every stroke goes down twice: a wider scrim first, so the ring
      // reads over a bright sky without a compositor filter on the canvas.
      const stroke = (style, width, alpha) => {
        ring.globalAlpha = alpha;
        ring.strokeStyle = style;
        ring.lineWidth = width;
        ring.stroke();
      };

      // The rim, fading into the dark at both ends through its gradient.
      ring.beginPath();
      ring.arc(cx, cy, RING_R, -Math.PI / 2 - RING_SPAN / 2, -Math.PI / 2 + RING_SPAN / 2);
      stroke(SCRIM, 3, 0.9);
      stroke(rimStyle, 1, 1);

      // Ticks every ten degrees of heading, longer every thirty, longest
      // and lettered at the cardinal points; they fade toward the ends
      // with the rim.
      for (let h = 0; h < 360; h += 10) {
        const a = wrap180(h - heading);
        const away = Math.abs(a);
        if (away > 45) continue;
        const phi = (a / 90) * RING_SPAN;
        const dx = Math.sin(phi), dy = -Math.cos(phi);
        const px = cx + RING_R * dx, py = cy + RING_R * dy;
        const cardinal = h % 90 === 0;
        const len = cardinal ? 12 : h % 30 === 0 ? 8 : 5;
        const edge = away > 30 ? 1 - Math.pow((away - 30) / 15, 2) : 1;
        const fade = (1 - Math.pow(away / 45, 2) * 0.75) * edge;
        const width = cardinal ? 1.5 : 1;
        ring.beginPath();
        ring.moveTo(px, py);
        ring.lineTo(px - dx * len, py - dy * len);
        stroke(SCRIM, width + 2, fade * 0.9);
        stroke(BRASS, width, fade * (cardinal ? 1 : 0.9));
        if (cardinal) {
          const tx = px - dx * 22, ty = py - dy * 22;
          ring.globalAlpha = fade * 0.9;
          ring.lineWidth = 3;
          ring.strokeStyle = SCRIM;
          ring.strokeText(CARDINAL[h], tx, ty);
          ring.globalAlpha = fade;
          ring.fillStyle = BRASS;
          ring.fillText(CARDINAL[h], tx, ty);
        }
      }

      // The lubber line: the one lamp-lit mark.
      ring.beginPath();
      ring.moveTo(cx, 1.5);
      ring.lineTo(cx, 15);
      stroke(SCRIM, 4, 0.9);
      stroke(LAMP, 2, 1);
      ring.globalAlpha = 1;
    },

    /* Quality, engine and tracker: three marks in the top corner. */
    paintStatus({ quality, engine, tracker }) {
      const key = `${quality}|${engine}|${tracker}`;
      if (key === shownStatus) return;
      shownStatus = key;
      el.quality.querySelector(".mark-text").textContent = quality || "—";
      el.quality.hidden = !quality;
      el.engine.dataset.engine = engine;
      el.engineIcon.setAttribute("href", ENGINE_ICON[engine] || "#i-yt");
      el.engine.querySelector(".mark-text").textContent = ENGINE_TEXT[engine] || "";
      el.engine.title = engineLabel(engine);
      el.tracker.dataset.health = tracker;
      el.trackerIcon.setAttribute("href", HEALTH_ICON[tracker] || "#i-eye");
      el.tracker.querySelector(".mark-text").textContent = HEALTH_TEXT[tracker] || "";
      el.tracker.title = HEALTH_TITLE[tracker] || "";
    },

    /* The transport line: play state, clock, progress, sound.  The clock
     * changes every second and the rest almost never, so they are keyed
     * apart: a tick rewrites two text nodes and a width, not nine
     * attributes (a <use> href re-instantiates the symbol even when equal). */
    paintTransport({ currentTime, duration, paused, volume, muted }) {
      const elapsed = formatClock(currentTime) || "0:00";
      const total = formatClock(duration);
      const fraction = total && duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
      const clockKey = `${elapsed}|${total}|${fraction.toFixed(4)}`;
      if (clockKey !== shownClock) {
        shownClock = clockKey;
        el.elapsed.textContent = elapsed;
        el.duration.textContent = total || "–:––";
        el.played.style.width = `${(fraction * 100).toFixed(2)}%`;
      }
      const stateKey = `${paused}|${volume}|${muted}`;
      if (stateKey !== shownTransport) {
        shownTransport = stateKey;
        el.playIcon.setAttribute("href", paused ? "#i-play" : "#i-pause");
        el.playBtn.setAttribute("aria-label", paused ? "Play" : "Pause");
        const silent = muted || volume <= 0;
        el.soundIcon.setAttribute("href", silent ? "#i-sound-off" : "#i-sound");
        el.muteBtn.setAttribute("aria-label", silent ? "Unmute" : "Mute");
        el.vollevel.style.width = `${Math.round((muted ? 0 : volume) * 100)}%`;
      }
    },

    /* The marks that show without waking the chrome. */
    paintPeripheral({ tracker, edge, buffering, paused }) {
      const side = edge ? edge.side : "";
      const strength = edge ? edge.strength.toFixed(2) : "0";
      const key = `${tracker}|${side}|${strength}|${buffering}|${paused}`;
      if (key === shownPeriphery) return;
      shownPeriphery = key;
      el.facemark.classList.toggle("on", tracker === "lost" || tracker === "stale");
      el.pausemark.classList.toggle("on", Boolean(paused));
      el.bufferline.classList.toggle("on", Boolean(buffering));
      el.edge.dataset.side = side;
      el.edge.style.setProperty("--strength", strength);
    },

    /* The readout and the stick, for whoever switched them on. */
    paintDiagnostics({ out, reading, body, limits, heading }) {
      el.dState.textContent = out.state;
      el.dHeading.textContent = `${Math.round(heading || 0) % 360}°`;
      el.dState.dataset.tone = out.state === "lost" ? "bad"
        : out.state === "low confidence" || out.state === "calibrating" || out.state === "committing" ? "warn" : "";
      el.dGaze.textContent = `${sign(out.yawError)}${out.yawError.toFixed(1)}, ${sign(out.pitchError)}${out.pitchError.toFixed(1)}`;
      el.dRate.textContent = `${sign(out.yawRate)}${out.yawRate.toFixed(0)}, ${sign(out.pitchRate)}${out.pitchRate.toFixed(0)}°/s`;
      el.dTurn.textContent = `${sign(body.yawRate)}${body.yawRate.toFixed(0)}, ${sign(body.pitchRate)}${body.pitchRate.toFixed(0)}°/s`;
      el.dNeck.textContent = body.strain >= 0.999 ? "at the limit"
        : body.strain > 0 ? `${Math.round(body.strain * 100)}% strained`
        : body.freeYaw ? "free · 360°" : "free";
      el.dNeck.dataset.tone = body.strain >= 0.999 ? "bad" : body.strain > 0.5 ? "warn" : "";
      el.dPerf.textContent = `${reading.rate.toFixed(0)} Hz  ${reading.latencyMs.toFixed(0)} ms${reading.mirror ? "" : "  1-pass"}`;

      // The stick: the deadzone box and where the eyes are, screen-handed.
      const size = 96, c = size / 2, pad = 8;
      const sx = (c - pad) / Math.max(limits.spanYaw, 1);
      const sy = (c - pad) / Math.max(limits.spanPitch, 1);
      stick.clearRect(0, 0, size, size);
      stick.strokeStyle = "rgba(156, 133, 96, 0.35)";
      stick.lineWidth = 1;
      stick.strokeRect(c - limits.spanYaw * sx, c - limits.spanPitch * sy, 2 * limits.spanYaw * sx, 2 * limits.spanPitch * sy);
      stick.strokeStyle = "rgba(156, 133, 96, 0.7)";
      stick.setLineDash([3, 3]);
      stick.strokeRect(c - limits.deadzoneYaw * sx, c - limits.deadzonePitch * sy,
        2 * limits.deadzoneYaw * sx, 2 * limits.deadzonePitch * sy);
      stick.setLineDash([]);
      const clamp = (v, l) => Math.max(-l, Math.min(l, v));
      const x = c - clamp(out.yawError, limits.spanYaw) * sx;
      const y = c - clamp(out.pitchError, limits.spanPitch) * sy;
      const live = out.yawRate !== 0 || out.pitchRate !== 0;
      if (live) {
        stick.strokeStyle = "rgba(240, 181, 107, 0.6)";
        stick.lineWidth = 2;
        stick.beginPath(); stick.moveTo(c, c); stick.lineTo(x, y); stick.stroke();
      }
      stick.fillStyle = live ? "#f0b56b" : "rgba(230, 232, 245, 0.6)";
      stick.beginPath(); stick.arc(x, y, 4, 0, 2 * Math.PI); stick.fill();
    },

    /* The diagnostics state line, for the no-signal and error cases the
     * tick reports outside a reading. */
    setDiagnosticsState(text, tone = "") {
      el.dState.textContent = text;
      el.dState.dataset.tone = tone;
    },
  };
}
