/* YouTube's own player in an iframe, steered by the view and sized for 360.
 *
 * Quality: the embed ignores every quality call; it picks its tier from the
 * iframe's layout size.  So the iframe is laid out at k·W × k·H (k from the
 * tier quality.js chose) and drawn back at W × H with transform: scale(1/k)
 * inside an overflow-hidden stage.  See quality.js for the tier math.
 *
 * Lifecycle: ONE YT.Player for the life of the page (creating one per video
 * leaks listeners and workers).  The first open() builds it with the video;
 * later opens loadVideoById into it (autoplays).  close() bumps an era so a
 * build still in flight knows its session is gone.
 *
 * Its chrome is off (controls:0, disablekb, fs:0); the page draws its own.
 * Ads are drawn by YouTube regardless and must stay clickable.
 */

import { LEVEL_HEIGHTS, layoutScale, K_MAX } from "./quality.js";

const DEG = Math.PI / 180;
const API_TIMEOUT_MS = 15000;
const READY_TIMEOUT_MS = 15000;
const FIT_DEBOUNCE_MS = 150;

export { K_MAX };

/* Named for the viewer, not the API. */
export const REFUSALS = Object.freeze({
  2: "the video id is malformed",
  5: "youtube's player broke",
  100: "the video is gone",
  101: "the uploader blocks embedding",
  150: "the uploader blocks embedding",
  153: "the page sent no referrer, so youtube refused to play",
});

export function refusal(code) {
  return REFUSALS[code] || `youtube's player refused (${code})`;
}

/* View (radians) → the player's spherical properties (degrees).
 *
 * Sign contract, shared with render.js: view.yaw > 0 = view turned to the
 * user's LEFT.  YouTube's yaw "increases as the viewer turns left" (IFrame
 * API reference) and that was confirmed on a live player, so it is passed
 * straight through.  If a player build ever pans mirrored, flip this line. */
export function sphericalFromView(view) {
  return {
    yaw: (((view.yaw / DEG) % 360) + 360) % 360,
    pitch: Math.max(-90, Math.min(90, view.pitch / DEG)),
    roll: Math.max(-180, Math.min(180, -(view.roll || 0) / DEG)) || 0,  // no -0 / NaN
  };
}

/* The app's FOV is horizontal; YouTube's is "along the longer edge", which
 * is the vertical one on a portrait viewport.  Clamped to YouTube's 30–120. */
export function youtubeFov(hFovDeg, width, height) {
  let fov = Number.isFinite(hFovDeg) ? hFovDeg : 100;
  if (width > 0 && height > width) {
    fov = 2 * Math.atan(Math.tan((fov * DEG) / 2) * (height / width)) / DEG;
  }
  return Math.max(30, Math.min(120, fov));
}

/* Steering is a postMessage per call; only send when it shows.  0.1° is
 * below what anyone sees and keeps a still head from posting every frame.
 * fov is compared exactly: it only changes when the user asks. */
export function movedEnough(last, next, epsilon = 0.1) {
  if (!last) return true;
  if (last.fov !== next.fov) return true;
  const yawGap = Math.abs((((next.yaw - last.yaw) % 360) + 540) % 360 - 180);
  return yawGap > epsilon
    || Math.abs(next.pitch - last.pitch) > epsilon
    || Math.abs(next.roll - last.roll) > epsilon;
}

// ------------------------------------------------------------ iframe API

let apiPromise = null;
let apiTag = null;

/* Loads https://www.youtube.com/iframe_api once.  Rejects after 15 s (a
 * content blocker can let the loader through and block the widget script, so
 * onYouTubeIframeAPIReady never fires); a later call tries again. */
export function iframeApi(timeoutMs = API_TIMEOUT_MS) {
  if (apiPromise) return apiPromise;
  const attempt = new Promise((resolve, reject) => {
    if (window.YT && typeof window.YT.Player === "function" && window.YT.loaded !== 0) {
      resolve(window.YT);
      return;
    }
    let timer = null;
    const fail = (message) => {
      clearTimeout(timer);
      if (apiPromise === attempt) apiPromise = null;
      reject(new Error(message));
    };
    timer = setTimeout(() => fail("youtube's player script never became ready"), timeoutMs);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof previous === "function") { try { previous(); } catch { /* not ours */ } }
      resolve(window.YT);
    };
    // A tag from a timed-out attempt may still be loading; do not add another.
    if (!apiTag) {
      apiTag = document.createElement("script");
      apiTag.src = "https://www.youtube.com/iframe_api";
      apiTag.async = true;
      apiTag.onerror = () => {
        if (apiTag && apiTag.parentNode) apiTag.parentNode.removeChild(apiTag);
        apiTag = null;
        fail("youtube's player script would not load");
      };
      document.head.appendChild(apiTag);
    }
  });
  apiPromise = attempt;
  return attempt;
}

/* For tests: forget the module-level loader state. */
export function resetIframeApiForTests() {
  apiPromise = null;
  apiTag = null;
}

// ------------------------------------------------------------ the player

const raf = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : null);

export class EmbedPlayer {
  /* options.readyTimeoutMs / apiTimeoutMs exist for tests. */
  constructor(container, { readyTimeoutMs = READY_TIMEOUT_MS, apiTimeoutMs = API_TIMEOUT_MS } = {}) {
    this.container = container;
    this.readyTimeoutMs = readyTimeoutMs;
    this.apiTimeoutMs = apiTimeoutMs;
    this.player = null;      // a READY YT.Player, or null
    this.stage = null;       // overflow-hidden W×H box holding the iframe
    this.building = null;    // the in-flight first build, joined by later opens
    this.handlers = {};
    this.released = 0;       // era; close() bumps it
    this.fov = 100;          // horizontal degrees (settings)
    this.volume = 1;
    this.muted = false;
    this.tier = null;        // quality.js tier the layout is sized for
    this.k = 1;              // current layout scale
    this.size = { width: 0, height: 0 };   // stage size in CSS px
    this.applied = null;     // last { innerW, innerH, k } pushed to the iframe
    this.sent = null;        // last spherical properties sent
    this.queued = null;      // properties waiting for the next frame
    this.frameBusy = false;  // a send already happened this frame
    this.assertOnPlay = false;
    this.playbackQuality = null;
    this.state = -1;
    this.fitTimer = null;

    const refit = () => {
      clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => this.fit(), FIT_DEBOUNCE_MS);
    };
    window.addEventListener("resize", refit);
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("fullscreenchange", refit);
    }
  }

  /* Load the iframe API early (library idle) so the first pick is fast. */
  preload() {
    return iframeApi(this.apiTimeoutMs).then(() => true, () => false);
  }

  /* Point the player at a video; it starts playing on its own (autoplay).
   * Resolves once the player has been handed the video.  Everything after
   * that arrives through the handlers:
   *   onPlaying(), onBuffering(), onPaused(), onEnded(), onError(message, code),
   *   onAutoplayBlocked(), onQuality(label)
   * Rejects if the player cannot be built, refuses the first video before it
   * is ready, or the session is closed meanwhile ("let go of"). */
  async open(videoId, handlers = {}) {
    this.handlers = handlers || {};
    this.sent = null;
    this.queued = null;
    this.playbackQuality = null;
    this.assertOnPlay = true;
    const era = this.released;
    // A pick during the first build joins it rather than building a second
    // player (which would orphan the first iframe for the life of the page).
    if (this.building) {
      try { await this.building; } catch { /* it failed and tore itself down */ }
      if (this.released !== era) throw new Error("the video was let go of before it loaded");
    }
    if (this.player) {
      this.fit();
      this.player.loadVideoById(videoId);
      return;
    }
    let finished;
    this.building = new Promise((resolve) => { finished = resolve; });
    try {
      await this.build(videoId, era);
    } finally {
      this.building = null;
      finished();
    }
  }

  measure() {
    const width = this.container.clientWidth || window.innerWidth || 0;
    const height = this.container.clientHeight || window.innerHeight || 0;
    this.size = { width, height };
    return this.size;
  }

  layout() {
    const { width, height } = this.measure();
    const k = layoutScale(width, this.tier ? this.tier.w : width, K_MAX);
    return { width, height, k, innerW: Math.round(width * k), innerH: Math.round(height * k) };
  }

  async build(videoId, era) {
    const YT = await iframeApi(this.apiTimeoutMs);
    if (this.released !== era) throw new Error("the video was let go of before it loaded");
    const stage = document.createElement("div");
    stage.className = "embed-stage";
    Object.assign(stage.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", overflow: "hidden" });
    const mount = document.createElement("div");
    stage.appendChild(mount);
    this.container.appendChild(stage);
    const { innerW, innerH } = this.layout();

    let built = null;
    const teardown = () => {
      try { if (built && typeof built.destroy === "function") built.destroy(); } catch { /* half-built */ }
      if (stage.parentNode) stage.parentNode.removeChild(stage);
      if (this.player === built) this.player = null;
      if (this.stage === stage) this.stage = null;
    };

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => settle(new Error("youtube's player never became ready")), this.readyTimeoutMs);
        const options = {
          videoId,
          width: innerW,
          height: innerH,
          // Never set a no-referrer policy anywhere: YouTube answers 153.
          playerVars: {
            enablejsapi: 1, origin: location.origin, controls: 0, disablekb: 1, fs: 0,
            playsinline: 1, iv_load_policy: 3, rel: 0, autoplay: 1, cc_load_policy: 0,
          },
          events: {
            onReady: () => settle(),
            onError: (event) => {
              const code = event && event.data;
              if (!settled) settle(new Error(refusal(code)));
              else this.emit("onError", refusal(code), code);
            },
            onStateChange: (event) => this.onState(event && event.data),
            onPlaybackQualityChange: (event) => {
              this.playbackQuality = event && event.data;
              this.emit("onQuality", this.playbackQuality);
            },
            onAutoplayBlocked: () => this.emit("onAutoplayBlocked"),
          },
        };
        try {
          built = new YT.Player(mount, options);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      // Timed out or refused before ready: nothing about this player can be
      // trusted to have its methods, so the next open builds fresh.
      teardown();
      throw error;
    }

    if (this.released !== era) {
      // close() ran while building; the player came up autoplaying.  Keep it
      // (it is ready and reusable) but silence it.
      this.player = built;
      this.stage = stage;
      try { built.stopVideo(); } catch { /* never played */ }
      throw new Error("the video was let go of before it loaded");
    }
    this.player = built;
    this.stage = stage;
    this.applied = null;
    this.fit();
  }

  emit(name, ...args) {
    const handler = this.handlers[name];
    if (typeof handler !== "function") return;
    try {
      handler(...args);
    } catch (error) {
      // An app bug must not unwind into YouTube's callback; surface it.
      if (typeof reportError === "function") reportError(error);
      else console.error(error);
    }
  }

  onState(state) {
    const PS = (window.YT && window.YT.PlayerState) || {};
    this.state = state;
    if (state === PS.PLAYING) {
      if (this.assertOnPlay) {
        // First PLAYING of this video: the 360 renderer has just come up
        // with its own default view, so re-send ours; re-assert sound and
        // captions, which reload per video.
        this.assertOnPlay = false;
        this.sent = null;
        this.muteCaptions();
        this.setSound(this.volume, this.muted);
      }
      this.emit("onPlaying");
    } else if (state === PS.BUFFERING) {
      this.emit("onBuffering");
    } else if (state === PS.PAUSED) {
      this.emit("onPaused");
    } else if (state === PS.ENDED) {
      this.emit("onEnded");
    }
  }

  /* Size the layout for the current tier.  Skips the postMessage when
   * nothing changed. */
  fit() {
    clearTimeout(this.fitTimer);
    this.fitTimer = null;
    const player = this.player;
    const iframe = player && typeof player.getIframe === "function" ? player.getIframe() : null;
    const { width, height, k, innerW, innerH } = this.layout();
    this.k = k;
    if (!iframe || !width || !height) return;
    const a = this.applied;
    if (a && a.innerW === innerW && a.innerH === innerH && a.k === k) return;
    if (typeof player.setSize === "function") player.setSize(innerW, innerH);
    const style = iframe.style;
    style.position = "absolute";
    style.left = "0";
    style.top = "0";
    style.transformOrigin = "0 0";
    style.transform = k === 1 ? "none" : `scale(${1 / k})`;
    this.applied = { innerW, innerH, k };
  }

  /* The tier (quality.js) to size the layout for; null = window-sized.
   * Applied immediately when a player exists, else at build. */
  setTier(tier) {
    const next = tier && Number.isFinite(tier.w) ? tier : null;
    if ((next && next.label) === (this.tier && this.tier.label)) return;
    this.tier = next;
    this.fit();
  }

  /* What is actually playing: { label, height } or null before it says. */
  quality() {
    let label = null;
    const player = this.player;
    if (player && typeof player.getPlaybackQuality === "function") {
      try { label = player.getPlaybackQuality() || null; } catch { label = null; }
    }
    if (!label || label === "unknown" || label === "auto") label = this.playbackQuality;
    if (!label || !LEVEL_HEIGHTS[label]) return null;
    return { label, height: LEVEL_HEIGHTS[label] };
  }

  /* Captions off, and kept off: the captions module reloads per video. */
  muteCaptions() {
    if (!this.player || typeof this.player.unloadModule !== "function") return;
    for (const module of ["captions", "cc"]) {
      try { this.player.unloadModule(module); } catch { /* not loaded */ }
    }
  }

  /* volume 0..1, muted flag; remembered for a player not built yet. */
  setSound(volume, muted) {
    if (Number.isFinite(volume)) this.volume = Math.max(0, Math.min(1, volume));
    this.muted = !!muted;
    const player = this.player;
    if (!player || typeof player.setVolume !== "function") return;
    try {
      player.setVolume(Math.round(this.volume * 100));
      if (this.muted) player.mute(); else player.unMute();
    } catch { /* mid-load; re-asserted on the first PLAYING */ }
  }

  /* Called every display frame with the steering view (radians).  Sends at
   * most once per animation frame, and only when the view moved enough. */
  steer(view) {
    if (!view || !Number.isFinite(view.yaw) || !Number.isFinite(view.pitch)) return;
    if (!this.player || typeof this.player.setSphericalProperties !== "function") return;
    const props = sphericalFromView(view);
    props.fov = youtubeFov(this.fov, this.size.width, this.size.height);
    if (!movedEnough(this.sent, props)) { this.queued = null; return; }
    if (this.frameBusy) { this.queued = props; return; }
    this.send(props);
  }

  send(props) {
    this.sent = props;
    try {
      this.player.setSphericalProperties({ ...props, enableOrientationSensor: false });
    } catch { /* not a 360 video yet, or mid-load */ }
    if (typeof requestAnimationFrame !== "function") return;
    this.frameBusy = true;
    raf(() => {
      this.frameBusy = false;
      const queued = this.queued;
      this.queued = null;
      if (queued && this.player && movedEnough(this.sent, queued)) this.send(queued);
    });
  }

  // ---------------------------------------------------------- transport

  call(name, ...args) {
    const player = this.player;
    if (!player || typeof player[name] !== "function") return undefined;
    try { return player[name](...args); } catch { return undefined; }
  }

  play() { this.call("playVideo"); }
  pause() { this.call("pauseVideo"); }

  get paused() {
    const PS = window.YT && window.YT.PlayerState;
    if (!PS || !this.player) return true;
    const state = this.call("getPlayerState");
    return state !== PS.PLAYING && state !== PS.BUFFERING;
  }

  get buffering() {
    const PS = window.YT && window.YT.PlayerState;
    return !!PS && this.call("getPlayerState") === PS.BUFFERING;
  }

  /* Seconds; 0 when unknown. */
  currentTime() {
    const t = this.call("getCurrentTime");
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  /* Seconds; 0 until the player knows (YouTube's own convention). */
  duration() {
    const d = this.call("getDuration");
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  /* 0..1 of the video loaded so far. */
  bufferedFraction() {
    const f = this.call("getVideoLoadedFraction");
    return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
  }

  seekTo(seconds) {
    if (!Number.isFinite(seconds)) return;
    const duration = this.duration();
    let target = Math.max(0, seconds);
    // Seeking onto the very end ends the video; stop just short of it.
    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.25));
    this.call("seekTo", target, true);
  }

  seek(delta) {
    if (!Number.isFinite(delta)) return;
    this.seekTo(this.currentTime() + delta);
  }

  /* The video's title once the player has it (deep links have only an id). */
  title() {
    const data = this.call("getVideoData");
    return (data && data.title) || null;
  }

  /* { currentTime, duration, paused, buffering } in <video>-like shape. */
  status() {
    return {
      currentTime: this.currentTime(),
      duration: this.duration(),
      paused: this.paused,
      buffering: this.buffering,
    };
  }

  /* Stand down, keeping the player for the next video. */
  close() {
    this.handlers = {};
    this.sent = null;
    this.queued = null;
    this.assertOnPlay = false;
    this.playbackQuality = null;
    this.released += 1;
    this.call("stopVideo");
  }
}
