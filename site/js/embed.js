/* The fallback engine: youtube's own player in an iframe, steered by the
 * same body.
 *
 * Used when the raw stream is refused -- a bot-challenged host, a region
 * lock, an expired URL.  Playback always works here, because it is youtube
 * playing to youtube; the price is youtube's own presentation, ads included
 * when a clip carries them, and the loss of our renderer's motion blur.
 *
 * The IFrame API exposes setSphericalProperties() on 360 uploads, so the
 * gaze pipeline steers this player exactly as it steers the WebGL sphere:
 * body.view in, camera angles out, every frame the view moved.
 */

import { bestAllowedLevel } from "./quality.js";

const DEG = Math.PI / 180;

export const EMBED_FOV = 75;

/* Named for the viewer, not the API. */
const REFUSALS = {
  2: "the video id is malformed",
  5: "youtube's player broke",
  100: "the video is gone",
  101: "the uploader blocks embedding",
  150: "the uploader blocks embedding",
};

/* body.view (radians) -> the player's spherical properties (degrees).
 * The yaw sign was settled empirically against a live player -- the
 * compass-heading mapping panned mirrored -- so the player's yaw takes
 * body yaw directly.  Pitch is up-positive on both sides.  If a future
 * player build pans mirrored again, this is the one line to flip. */
export function sphericalFromView(view) {
  return {
    yaw: (((view.yaw / DEG) % 360) + 360) % 360,
    pitch: Math.max(-90, Math.min(90, view.pitch / DEG)),
    roll: Math.max(-180, Math.min(180, -view.roll / DEG)),
    fov: EMBED_FOV,
  };
}

/* The iframe is sized for the display's real pixels (capped at 2x so the
 * player's own 360 rendering keeps up -- an oversized canvas is exactly
 * what makes camera motion choppy).  The quality *tier* is not left to the
 * player's size heuristics at all: forceBest() pins it explicitly, which
 * is both sharper and cheaper than impersonating a huge viewport. */
export function overscanFor(width, height, dpr = 1) {
  return Math.min(2, Math.max(1, dpr));
}

/* Steering is a postMessage per call; only bother when the view moved. */
export function movedEnough(last, next, epsilon = 0.02) {
  if (!last) return true;
  const yawGap = Math.abs((((next.yaw - last.yaw) % 360) + 540) % 360 - 180);
  return yawGap > epsilon
    || Math.abs(next.pitch - last.pitch) > epsilon
    || Math.abs(next.roll - last.roll) > epsilon;
}

let apiPromise = null;

function iframeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => {
      apiPromise = null;
      reject(new Error("youtube's player script would not load"));
    };
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    document.head.appendChild(tag);
  });
  return apiPromise;
}

export class EmbedPlayer {
  constructor(container) {
    this.container = container;
    this.player = null;
    this.sent = null;
    this.handlers = {};
    this.maxHeight = Infinity;
    this.fov = EMBED_FOV;
    window.addEventListener("resize", () => this.fit());
  }

  /* The quality ceiling, in tier height; forceBest stays under it. */
  capHeight(maxHeight) {
    this.maxHeight = maxHeight || Infinity;
    this.forceBest();
  }

  /* Point the player at one video.  Resolves when it is ready to obey;
   * `onEnded` and `onError` fire for everything after that.
   *
   * ONE player for the life of the page.  Creating and destroying youtube
   * players per video leaks message listeners and workers -- each pick made
   * the page a little heavier until only a reload cured it -- so the first
   * open builds the player and every later one just loads into it. */
  async open(videoId, handlers = {}) {
    this.handlers = handlers;
    this.sent = null;
    if (this.player) {
      this.player.loadVideoById(videoId);
      this.fit();
      return;
    }
    const YT = await iframeApi();
    const mount = document.createElement("div");
    this.container.appendChild(mount);
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const overscan = overscanFor(width, height, window.devicePixelRatio || 1);
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("youtube's player never became ready"));
      }, 15000);
      this.player = new YT.Player(mount, {
        videoId,
        width: Math.round(width * overscan),
        height: Math.round(height * overscan),
        playerVars: {
          autoplay: 1, controls: 0, rel: 0, iv_load_policy: 3,
          playsinline: 1, disablekb: 1, fs: 0, origin: location.origin,
        },
        events: {
          onReady: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          onError: (event) => {
            const error = new Error(REFUSALS[event.data] || `youtube's player refused (${event.data})`);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(error);
            } else if (this.handlers.onError) {
              this.handlers.onError(error);
            }
          },
          onStateChange: (event) => {
            if (event.data === YT.PlayerState.PLAYING) {
              this.forceBest();
              this.muteCaptions();
            }
            if (event.data === YT.PlayerState.ENDED && this.handlers.onEnded) this.handlers.onEnded();
          },
        },
      });
    });
    this.fit();
  }

  /* Size the reused iframe for the current window and pixel density, and
   * scale it down onto the window, centred, covering. */
  fit() {
    const iframe = this.player && typeof this.player.getIframe === "function"
      ? this.player.getIframe() : null;
    if (!iframe) return;
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    const overscan = overscanFor(width, height, window.devicePixelRatio || 1);
    const innerW = Math.round(width * overscan);
    const innerH = Math.round(height * overscan);
    if (typeof this.player.setSize === "function"
        && (parseInt(iframe.getAttribute("width"), 10) !== innerW
            || parseInt(iframe.getAttribute("height"), 10) !== innerH)) {
      this.player.setSize(innerW, innerH);
    }
    const scale = Math.max(width / innerW, height / innerH);
    iframe.style.position = "absolute";
    iframe.style.left = `${(width - innerW * scale) / 2}px`;
    iframe.style.top = `${(height - innerH * scale) / 2}px`;
    iframe.style.transformOrigin = "top left";
    iframe.style.transform = `scale(${scale})`;
  }

  /* Subtitles off, and kept off: the captions module reloads with every
   * video, so this is re-asserted on every PLAYING alongside the quality. */
  muteCaptions() {
    if (!this.player) return;
    for (const module of ["captions", "cc"]) {
      try { this.player.unloadModule(module); } catch { /* not loaded */ }
    }
  }

  /* Pin the player to the best tier the display deserves.  The documented
   * quality API has been a no-op for years, but the range form still works
   * in current players; asserted on every PLAYING, so the downshift after
   * a stall is undone as soon as playback resumes. */
  forceBest() {
    const player = this.player;
    if (!player || typeof player.getAvailableQualityLevels !== "function") return;
    const best = bestAllowedLevel(player.getAvailableQualityLevels(), this.maxHeight);
    if (!best) return;
    try {
      if (typeof player.setPlaybackQualityRange === "function") {
        player.setPlaybackQualityRange(best, best);
      }
      player.setPlaybackQuality(best);
    } catch { /* an older player build; nothing more to be done */ }
  }

  steer(view) {
    if (!this.player || typeof this.player.setSphericalProperties !== "function") return;
    const props = sphericalFromView(view);
    props.fov = Math.max(30, Math.min(120, this.fov));
    if (!movedEnough(this.sent, props)) return;
    this.sent = props;
    this.player.setSphericalProperties({ ...props, enableOrientationSensor: false });
  }

  /* Like video.play(): resolves once playing, rejects when the browser
   * wants a click first. */
  async ensurePlaying() {
    if (!this.player) throw new Error("no player");
    const YT = window.YT;
    this.player.playVideo();
    const began = performance.now();
    while (performance.now() - began < 1800) {
      const state = this.player.getPlayerState();
      if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("autoplay was blocked");
  }

  pause() {
    if (this.player && typeof this.player.pauseVideo === "function") this.player.pauseVideo();
  }

  get paused() {
    const YT = window.YT;
    if (!YT || !this.player || typeof this.player.getPlayerState !== "function") return true;
    const state = this.player.getPlayerState();
    return state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING;
  }

  seek(delta) {
    if (!this.player || typeof this.player.getCurrentTime !== "function") return;
    this.player.seekTo(Math.max(0, this.player.getCurrentTime() + delta), true);
  }

  /* Stand down, keeping the player for the next video (see open). */
  close() {
    this.handlers = {};
    this.sent = null;
    if (this.player) {
      try { this.player.stopVideo(); } catch { /* mid-load; it will stop */ }
    }
  }
}
