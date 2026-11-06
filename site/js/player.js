/* The player screen's DOM: the control bar and its auto-hide, the seek
 * bar, volume, the keyboard map, click / double-click / drag on #surface,
 * the peripheral marks, the panels (camera sheet, big Play, end, error,
 * shortcuts) and the diagnostics painter.
 *
 * It decides nothing about playback: every user intent goes out through
 * the `actions` object app.js hands in, and app.js pushes state back in
 * through the paint/set methods.  Writes are keyed, so calling a painter
 * with the same values costs no DOM work. */

import {
  CLICK_DELAY_MS, DRAG_THRESHOLD_PX, SHORTCUTS, VOLUME_STEP, chromeAwake, clockText, dragToView, formatClock,
  keyAction, periphMarks, seekFraction, seekKey, timeAtFraction, trackFraction, trackingStatus,
} from "./chrome.js";
import { fillFor } from "./settings.js";

// Esc that left fullscreen can arrive late in some engines; ignore it this long.
const FULLSCREEN_ESC_GRACE_MS = 500;

const PANELS = ["camsheet", "bigplay", "endpanel", "errpanel", "shortcuts"];

// Capture can throw (a pointer that is already gone); the gesture still works without it.
function capture(element, pointerId) {
  try { element.setPointerCapture(pointerId); } catch { /* not capturable */ }
}
function release(element, pointerId) {
  try { if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId); } catch { /* gone */ }
}

export class PlayerUI {
  /* actions: {
   *   playPause, seekTo(s), seekBy(d), setVolume(v), volumeBy(d), toggleMute, recenter,
   *   toggleTracking, toggleSettings, closeSettings, settingsOpen(), toggleFullscreen,
   *   back, replay, retry, useCamera, noCamera, bigPlay, drag(dYawDeg, dPitchDeg),
   *   fov() → horizontal degrees, isOpen() → player showing, isPaused() }
   */
  constructor(doc, actions) {
    this.doc = doc;
    this.win = doc.defaultView;
    this.actions = actions;
    const $ = (id) => doc.getElementById(id);
    this.el = {
      body: doc.body, player: $("player"), surface: $("surface"), chrome: $("chrome"),
      title: $("ptitle"), back: $("backbtn"),
      seek: $("seek"), seekPlayed: $("seekplayed"), seekTip: $("seektip"),
      play: $("playbtn"), mute: $("mutebtn"), volume: $("volume"), volumeWrap: doc.querySelector(".volume"),
      clock: $("clock"), recenter: $("recenterbtn"), track: $("trackbtn"), trackLabel: $("tracklabel"),
      sets: $("setsbtn"), fs: $("fsbtn"),
      buffer: $("bufferline"), acquire: $("acquiremark"), face: $("facemark"), away: $("awaymark"),
      diag: $("diagnostics"),
      camsheet: $("camsheet"), bigplay: $("bigplay"), bigplayBtn: $("bigplaybtn"),
      endpanel: $("endpanel"), errpanel: $("errpanel"), errtext: $("errtext"), errretry: $("errretry"),
      shortcuts: $("shortcuts"), shortcutList: $("shortcutlist"),
    };
    this.keyed = new Map();          // element/prop → last written value
    this.lastPointerAt = -Infinity;
    this.asleep = false;
    this.trackState = "off";
    this.trackSince = 0;
    this.buffering = false;
    this.duration = NaN;
    this.current = 0;
    this.seekDrag = null;            // { pointerId, fraction } while scrubbing
    this.press = null;               // a press on the surface
    this.clickTimer = null;
    this.fullscreenExitAt = -Infinity;
    this.diagRows = null;
    this.helpReturn = null;

    this.buildShortcuts();
    this.bindButtons();
    this.bindSeek();
    this.bindVolume();
    this.bindSurface();
    this.bindWake();
    this.bindKeys();
    doc.addEventListener("fullscreenchange", () => {
      const on = Boolean(doc.fullscreenElement);
      if (!on) this.fullscreenExitAt = this.now();
      this.setFullscreen(on);
    });
  }

  now() {
    return this.win.performance.now();
  }

  /* Write only on change.  `key` names the slot; `apply` does the write. */
  put(key, value, apply) {
    if (this.keyed.get(key) === value) return;
    this.keyed.set(key, value);
    apply(value);
  }

  // ------------------------------------------------------------ wiring

  bindButtons() {
    const { el, actions } = this;
    // A pointer click leaves focus on the button, and a later Space would
    // then press the button instead of play/pause: drop it.  Keyboard
    // activation (detail 0) keeps focus where the user put it.
    const on = (button, fn) => button.addEventListener("click", (event) => {
      if (event.detail > 0) button.blur();
      fn(event);
    });
    on(el.back, () => actions.back());
    on(el.play, () => actions.playPause());
    on(el.mute, () => actions.toggleMute());
    on(el.recenter, () => actions.recenter());
    on(el.track, () => actions.toggleTracking());
    on(el.sets, () => actions.toggleSettings());
    on(el.fs, () => actions.toggleFullscreen());
    on(el.bigplayBtn, () => actions.bigPlay());
    on(this.doc.getElementById("replaybtn"), () => actions.replay());
    on(this.doc.getElementById("endback"), () => actions.back());
    on(el.errretry, () => actions.retry());
    on(this.doc.getElementById("errback"), () => actions.back());
    on(this.doc.getElementById("usecam"), () => actions.useCamera());
    on(this.doc.getElementById("nocam"), () => actions.noCamera());
    on(this.doc.getElementById("shortcutsclose"), () => this.closeHelp());
  }

  buildShortcuts() {
    const list = this.el.shortcutList;
    list.textContent = "";
    for (const [keys, what] of SHORTCUTS) {
      const dt = this.doc.createElement("dt");
      dt.textContent = keys;
      const dd = this.doc.createElement("dd");
      dd.textContent = what;
      list.append(dt, dd);
    }
  }

  // ------------------------------------------------------------ seek bar

  bindSeek() {
    const seek = this.el.seek;
    const fractionAt = (event) => {
      const rect = seek.getBoundingClientRect();
      return seekFraction(event.clientX, rect.left, rect.width);
    };
    const hoverAt = (fraction) => {
      seek.style.setProperty("--hover", `${(fraction * 100).toFixed(2)}%`);
      this.el.seekTip.textContent = formatClock(timeAtFraction(fraction, this.duration)) || "";
    };
    seek.addEventListener("pointermove", (event) => {
      const fraction = fractionAt(event);
      hoverAt(fraction);
      if (this.seekDrag && event.pointerId === this.seekDrag.pointerId) {
        this.seekDrag.fraction = fraction;
        this.paintPlayed(fraction);
      }
    });
    seek.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.knownDuration()) return;
      event.preventDefault();   // no text selection, no focus jump
      capture(seek, event.pointerId);
      const fraction = fractionAt(event);
      this.seekDrag = { pointerId: event.pointerId, fraction };
      seek.classList.add("active");
      hoverAt(fraction);
      this.paintPlayed(fraction);
    });
    const finish = (event, commit) => {
      const drag = this.seekDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      this.seekDrag = null;
      seek.classList.remove("active");
      release(seek, event.pointerId);
      if (commit) {
        const to = timeAtFraction(drag.fraction, this.duration);
        this.current = to;
        this.actions.seekTo(to);
      }
      this.paintPlayed(trackFraction(this.current, this.duration));
    };
    seek.addEventListener("pointerup", (event) => finish(event, true));
    seek.addEventListener("pointercancel", (event) => finish(event, false));
    seek.addEventListener("lostpointercapture", (event) => finish(event, false));
    seek.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const to = seekKey(event.key, this.current, this.duration);
      if (to === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.current = to;
      this.paintPlayed(trackFraction(to, this.duration));
      this.actions.seekTo(to);
      this.wake();
    });
  }

  knownDuration() {
    return Number.isFinite(this.duration) && this.duration > 0;
  }

  paintPlayed(fraction) {
    this.put("played", fraction.toFixed(4), (v) => this.el.seek.style.setProperty("--played", `${(v * 100).toFixed(2)}%`));
  }

  // ------------------------------------------------------------ volume

  bindVolume() {
    const input = this.el.volume;
    input.addEventListener("input", () => {
      input.style.setProperty("--fill", fillFor(input.value, input.min, input.max));
      this.actions.setVolume(Number(input.value));
    });
    // A pointer that let go of the slider leaves focus on it; give Space
    // back to play/pause.
    input.addEventListener("pointerup", () => setTimeout(() => input.blur(), 0));
  }

  // ------------------------------------------------------------ surface

  bindSurface() {
    const surface = this.el.surface;
    surface.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.actions.isOpen()) return;
      capture(surface, event.pointerId);
      this.press = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, dragging: false, type: event.pointerType };
    });
    surface.addEventListener("pointermove", (event) => {
      const press = this.press;
      if (!press || press.id !== event.pointerId) return;
      if (!press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
      if (!press.dragging) {
        press.dragging = true;
        this.el.body.classList.add("dragging");
        this.cancelClick();
      }
      const d = dragToView(event.clientX - press.lastX, event.clientY - press.lastY, this.actions.fov(), this.win.innerWidth);
      press.lastX = event.clientX;
      press.lastY = event.clientY;
      if (d.yaw || d.pitch) this.actions.drag(d.yaw, d.pitch);
    });
    const end = (event, cancelled) => {
      const press = this.press;
      if (!press || press.id !== event.pointerId) return;
      this.press = null;
      this.el.body.classList.remove("dragging");
      release(surface, event.pointerId);
      if (cancelled || press.dragging) return;
      this.surfaceClick(press.type);
    };
    surface.addEventListener("pointerup", (event) => end(event, false));
    surface.addEventListener("pointercancel", (event) => end(event, true));
    surface.addEventListener("lostpointercapture", (event) => end(event, true));
  }

  /* One click waits CLICK_DELAY_MS for a second; two make a double click.
   * A tap on a touch screen first just brings the chrome back. */
  surfaceClick(pointerType) {
    if (this.panelUp()) return;
    if (pointerType === "touch" && this.asleep) {
      this.wake();
      return;
    }
    if (this.clickTimer !== null) {
      this.cancelClick();
      this.actions.toggleFullscreen();   // still inside the gesture
      return;
    }
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      if (this.actions.isOpen() && !this.panelUp()) this.actions.playPause();
    }, CLICK_DELAY_MS);
  }

  cancelClick() {
    if (this.clickTimer !== null) clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }

  // ------------------------------------------------------------ waking

  bindWake() {
    const wake = () => this.wake();
    this.doc.addEventListener("pointermove", wake, { passive: true });
    this.doc.addEventListener("pointerdown", wake, { passive: true });
    this.doc.addEventListener("wheel", wake, { passive: true });
    this.el.chrome.addEventListener("focusin", wake);
  }

  wake() {
    if (!this.actions.isOpen()) return;
    this.lastPointerAt = this.now();
    if (this.asleep) this.tick();
  }

  /* Re-evaluate the auto-hide rule.  Cheap enough for ~4 Hz. */
  tick() {
    if (!this.actions.isOpen()) {
      this.setAsleep(false);
      return;
    }
    const chrome = this.el.chrome;
    const awake = chromeAwake({
      paused: this.actions.isPaused(),
      settingsOpen: this.actions.settingsOpen(),
      overControl: Boolean(chrome.querySelector(".pbtn:hover, .seek:hover, .volume:hover")) || this.seekDrag !== null,
      panelUp: this.panelUp(),
      keyboardFocus: Boolean(chrome.querySelector(":focus-visible")),
      sincePointerMs: this.now() - this.lastPointerAt,
    });
    this.setAsleep(!awake);
    this.paintPeriphery();
  }

  setAsleep(asleep) {
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    this.el.body.classList.toggle("chrome-asleep", asleep);
  }

  // ------------------------------------------------------------ keyboard

  bindKeys() {
    this.doc.addEventListener("keydown", (event) => {
      // Any key wakes the chrome first: a hidden control cannot take focus,
      // so Tab must find the bar already visible.
      if (!event.repeat) this.wake();
      const t = event.target && event.target.nodeType === 1 ? event.target : null;
      const action = keyAction({
        key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, repeat: event.repeat,
        target: t ? {
          tag: t.tagName, type: (t.type || "").toLowerCase(), role: t.getAttribute("role"),
          editable: t.isContentEditable, inSettings: Boolean(t.closest("#settings")),
        } : {},
      }, {
        library: !this.actions.isOpen(),
        settingsOpen: this.actions.settingsOpen(),
        helpOpen: !this.el.shortcuts.hidden,
        fullscreen: Boolean(this.doc.fullscreenElement) || this.now() - this.fullscreenExitAt < FULLSCREEN_ESC_GRACE_MS,
        modal: this.modalUp(),
      });
      if (!action) return;
      event.preventDefault();
      this.run(action);
    });
  }

  run(action) {
    const a = this.actions;
    switch (action) {
      case "playpause": a.playPause(); break;
      case "back5": a.seekBy(-5); break;
      case "fwd5": a.seekBy(5); break;
      case "back10": a.seekBy(-10); break;
      case "fwd10": a.seekBy(10); break;
      case "volup": a.volumeBy(VOLUME_STEP); break;
      case "voldown": a.volumeBy(-VOLUME_STEP); break;
      case "mute": a.toggleMute(); break;
      case "fullscreen": a.toggleFullscreen(); break;
      case "recenter": a.recenter(); break;
      case "tracking": a.toggleTracking(); break;
      case "settings": a.toggleSettings(); break;
      case "help": this.toggleHelp(); break;
      case "close-settings": a.closeSettings(); break;
      case "close-help": this.closeHelp(); break;
      case "back": a.back(); break;
      default: break;
    }
  }

  // ------------------------------------------------------------ painters

  /* A new clip: reset everything that belonged to the last one. */
  reset(title) {
    this.keyed.clear();
    this.duration = NaN;
    this.current = 0;
    this.seekDrag = null;
    this.press = null;
    this.cancelClick();
    this.buffering = false;
    this.diagRows = null;
    this.el.diag.textContent = "";
    for (const id of PANELS) this.el[id].hidden = true;
    this.el.bigplay.classList.remove("ready");
    this.setTitle(title);
    this.paintTransport({ currentTime: 0, duration: NaN, buffered: 0, paused: true });
    this.lastPointerAt = this.now();
    this.setAsleep(false);
  }

  setTitle(title) {
    this.put("title", title || "", (v) => {
      this.el.title.textContent = v;
      this.el.title.title = v;
    });
  }

  /* { currentTime, duration, buffered (0..1), paused } */
  paintTransport({ currentTime, duration, buffered, paused }) {
    const total = Number.isFinite(duration) && duration > 0 ? duration : NaN;
    this.duration = total;
    if (!this.seekDrag) {
      this.current = Number.isFinite(currentTime) ? currentTime : 0;
      this.paintPlayed(trackFraction(this.current, total));
    }
    this.put("buffered", trackFraction(buffered, 1).toFixed(3), (v) => this.el.seek.style.setProperty("--buffered", `${(v * 100).toFixed(1)}%`));
    const clock = clockText(this.current, total);
    this.put("clock", clock, (v) => { this.el.clock.textContent = v; });
    const known = Number.isFinite(total);
    this.put("seek-known", known, (v) => {
      this.el.seek.classList.toggle("unknown", !v);
      this.el.seek.setAttribute("aria-valuemax", v ? String(Math.floor(total)) : "0");
      this.el.seek.setAttribute("aria-disabled", v ? "false" : "true");
    });
    if (known) this.put("seek-max", Math.floor(total), (v) => this.el.seek.setAttribute("aria-valuemax", String(v)));
    this.put("seek-now", Math.floor(this.current), (v) => {
      this.el.seek.setAttribute("aria-valuenow", String(v));
      this.el.seek.setAttribute("aria-valuetext", known ? `${formatClock(v)} of ${formatClock(total)}` : formatClock(v));
    });
    this.setPaused(paused);
  }

  setPaused(paused) {
    this.put("paused", Boolean(paused), (v) => {
      this.el.play.querySelector("use").setAttribute("href", v ? "#i-play" : "#i-pause");
      this.el.play.setAttribute("aria-label", v ? "Play" : "Pause");
      this.el.play.dataset.tip = v ? "Play (K)" : "Pause (K)";
    });
  }

  setVolume(volume, muted) {
    const silent = muted || volume === 0;
    const icon = silent ? "#i-sound-off" : volume < 0.5 ? "#i-sound-low" : "#i-sound";
    this.put("vol-icon", icon, (v) => this.el.mute.querySelector("use").setAttribute("href", v));
    this.put("vol-muted", Boolean(muted), (v) => {
      this.el.mute.setAttribute("aria-label", v ? "Unmute" : "Mute");
      this.el.mute.dataset.tip = v ? "Unmute (M)" : "Mute (M)";
    });
    const shown = muted ? 0 : volume;
    this.put("vol-value", shown, (v) => {
      if (this.doc.activeElement !== this.el.volume) this.el.volume.value = String(v);
      this.el.volume.style.setProperty("--fill", fillFor(v, 0, 1));
      this.el.volume.setAttribute("aria-valuetext", `${Math.round(v * 100)}%`);
    });
  }

  /* `state` is Steering.state or 'starting' / 'unavailable'. */
  setTracking(state) {
    if (state !== this.trackState) {
      this.trackState = state;
      this.trackSince = this.now();
    }
    const s = trackingStatus(state);
    this.put("track", state, () => {
      const button = this.el.track;
      button.dataset.tone = s.tone;
      button.setAttribute("aria-pressed", String(s.pressed));
      button.dataset.tip = `${s.tip} (T)`;
      button.querySelector("use").setAttribute("href", s.pressed ? "#i-tracking" : "#i-tracking-off");
      this.el.trackLabel.textContent = s.label;
    });
  }

  setFullscreen(on) {
    this.put("fs", on, (v) => {
      this.el.fs.querySelector("use").setAttribute("href", v ? "#i-fullscreen-exit" : "#i-fullscreen");
      this.el.fs.setAttribute("aria-label", v ? "Exit fullscreen" : "Fullscreen");
      this.el.fs.dataset.tip = v ? "Exit fullscreen (F)" : "Fullscreen (F)";
    });
  }

  setSettingsExpanded(open) {
    this.el.sets.setAttribute("aria-expanded", String(Boolean(open)));
  }

  setBuffering(on) {
    this.buffering = Boolean(on);
  }

  paintPeriphery() {
    const open = this.actions.isOpen();
    const marks = open
      ? periphMarks({ state: this.trackState, sinceStateMs: this.now() - this.trackSince, buffering: this.buffering })
      : { acquiring: false, faceLost: false, away: false, buffering: false };
    // Nothing floats over a panel that is asking a question.
    const quiet = this.panelUp();
    this.put("m-buffer", marks.buffering && !quiet, (v) => this.el.buffer.classList.toggle("on", v));
    this.put("m-acquire", marks.acquiring && !quiet, (v) => this.el.acquire.classList.toggle("on", v));
    this.put("m-face", marks.faceLost && !quiet, (v) => this.el.face.classList.toggle("on", v));
    this.put("m-away", marks.away && !quiet, (v) => this.el.away.classList.toggle("on", v));
  }

  // ------------------------------------------------------------ panels

  panelUp() {
    return PANELS.some((id) => !this.el[id].hidden);
  }

  /* Panels that take the keyboard away from the shortcuts (Esc still works). */
  modalUp() {
    return !this.el.camsheet.hidden || !this.el.bigplay.hidden || !this.el.endpanel.hidden || !this.el.errpanel.hidden;
  }

  showPanel(id, on, focusId = null) {
    const panel = this.el[id];
    if (panel.hidden === !on) return;
    panel.hidden = !on;
    if (on && focusId) this.doc.getElementById(focusId).focus({ preventScroll: true });
    else if (!on && panel.contains(this.doc.activeElement)) this.doc.activeElement.blur();
    this.wake();
    this.tick();
  }

  showSheet(on) { this.showPanel("camsheet", on, "usecam"); }

  /* mode: null (hidden) | 'blocked' (autoplay refused) | 'ready' (deep link) */
  showBigPlay(mode) {
    this.el.bigplay.classList.toggle("ready", mode === "ready");
    this.showPanel("bigplay", Boolean(mode), "bigplaybtn");
  }

  showEnd(on) { this.showPanel("endpanel", on, "replaybtn"); }

  /* message: string to show, or null to hide.  retry: whether Retry is offered. */
  showError(message, { retry = true } = {}) {
    if (message) {
      this.el.errtext.textContent = message;
      this.el.errretry.hidden = !retry;
    }
    this.showPanel("errpanel", Boolean(message), message ? (retry ? "errretry" : "errback") : null);
  }

  toggleHelp() {
    if (this.el.shortcuts.hidden) {
      this.helpReturn = this.doc.activeElement;
      this.showPanel("shortcuts", true, "shortcutsclose");
    } else {
      this.closeHelp();
    }
  }

  closeHelp() {
    if (this.el.shortcuts.hidden) return;
    this.showPanel("shortcuts", false);
    const back = this.helpReturn;
    this.helpReturn = null;
    if (back && back.isConnected && back !== this.doc.body) back.focus({ preventScroll: true });
  }

  hideAllPanels() {
    for (const id of PANELS) this.el[id].hidden = true;
    this.el.bigplay.classList.remove("ready");
  }

  // ------------------------------------------------------------ diagnostics

  showDiagnostics(on) {
    this.put("diag-on", Boolean(on), (v) => { this.el.diag.hidden = !v; });
  }

  /* rows: [[key, value, tone], ...] from chrome.diagnosticsRows. */
  paintDiagnostics(rows) {
    if (this.el.diag.hidden) return;
    if (!this.diagRows || this.diagRows.length !== rows.length) {
      this.el.diag.textContent = "";
      this.diagRows = rows.map(([key]) => {
        const row = this.doc.createElement("div");
        row.className = "row";
        const k = this.doc.createElement("span");
        k.className = "key";
        k.textContent = key;
        const v = this.doc.createElement("span");
        v.className = "val";
        row.append(k, v);
        this.el.diag.appendChild(row);
        return { value: v, text: null, tone: null };
      });
    }
    rows.forEach(([, value, tone], i) => {
      const slot = this.diagRows[i];
      if (slot.text !== value) { slot.value.textContent = value; slot.text = value; }
      if (slot.tone !== tone) {
        if (tone) slot.value.dataset.tone = tone; else delete slot.value.dataset.tone;
        slot.tone = tone;
      }
    });
  }
}
