/* The engine for everything from youtube: its own player in an iframe,
 * steered by the same body.
 *
 * Playback always works here, because it is youtube playing to youtube; the
 * price is ads when a clip carries them, and the loss of our renderer's
 * motion blur.
 *
 * The IFrame API exposes setSphericalProperties() on 360 uploads, so the
 * gaze pipeline steers this player exactly as it steers the WebGL sphere:
 * body.view in, camera angles out, every frame the view moved.
 *
 * Its own chrome is off (see playerVars): LazyVR draws a transport, a
 * title and a heading of its own, and two of each would fight.  Every
 * control the page needs it drives through this class instead.
 */

import { LEVEL_HEIGHTS, bestAllowedLevel } from "./quality.js";

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

/* The iframe is built at window size and no larger.
 *
 * It used to be built at the display's pixel density -- 2x linear, four
 * times the area on a retina panel -- on the theory that a big viewport
 * coaxes a better tier out of the player.  It does not: forceBest() pins
 * the tier explicitly, so all the extra pixels bought was a 360 renderer
 * doing four times the work per frame, inside an iframe, while our camera
 * updates queued up behind it.  That was most of the embed's judder. */
export function overscanFor(width, height, dpr = 1) {
  return 1;
}

/* Steering is a postMessage per call; only bother when the view moved.
 *
 * The threshold is a tenth of a degree rather than a hundredth, because the
 * body never quite holds still -- the idle sway alone would otherwise post a
 * message every frame for the length of the clip, and the player would
 * redraw for a movement no one can see.  A real turn is 0.2 degrees per
 * frame at its slowest, so nothing the viewer asked for is ever missed. */
export function movedEnough(last, next, epsilon = 0.1) {
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
    this.pendingCue = null;
    this.handlers = {};
    this.maxHeight = Infinity;
    this.fov = EMBED_FOV;
    this.volume = 1;
    this.muted = false;
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
      this.fit();
      // Cue, not load: cueVideoById brings the video up without starting it,
      // which is exactly the hold calibration wants -- loadVideoById
      // autoplays, and raced the pause() the caller makes straight
      // afterwards, so a clip could be several seconds in and audible under
      // the calibration overlay.  And wait for it: returning here as soon
      // as the call was made meant `playerReady` said yes while the player
      // still held the *previous* video, so capHeight, pause and title all
      // spoke to the wrong clip.
      await this.cued(videoId);
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
        // youtube's own chrome, off: `controls` takes the bottom bar and
        // the hover gradients that would sit under our transport,
        // `modestbranding` the logo, `rel` the end-screen grid, and
        // `iv_load_policy` the annotations.  `disablekb` keeps its
        // shortcuts off Space, the arrows, M and F, which app.js binds;
        // `fs` because LazyVR owns fullscreen for the whole session.  None
        // of this reaches the ad UI, which youtube draws regardless -- a
        // skip button must stay there, and stay clickable.
        playerVars: {
          autoplay: 1, controls: 0, modestbranding: 1, rel: 0, iv_load_policy: 3,
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
            } else if (this.pendingCue) {
              this.settleCue(error);
            } else if (this.handlers.onError) {
              this.handlers.onError(error);
            }
          },
          onStateChange: (event) => {
            if (event.data === YT.PlayerState.CUED) this.settleCue();
            if (event.data === YT.PlayerState.PLAYING) {
              this.forceBest();
              this.muteCaptions();
              this.setSound(this.volume, this.muted);
            }
            if (event.data === YT.PlayerState.ENDED && this.handlers.onEnded) this.handlers.onEnded();
          },
        },
      });
    });
    this.fit();
  }

  /* Hand the live player a new video and wait until it says it has it.
   * The player keeps one onStateChange for its whole life, so CUED lands
   * here however many videos have been through it. */
  cued(videoId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.settleCue(new Error("youtube's player never took the video")), 15000);
      this.pendingCue = { resolve, reject, timer };
      this.player.cueVideoById(videoId);
    });
  }

  settleCue(error) {
    const pending = this.pendingCue;
    if (!pending) return;
    this.pendingCue = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
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

  /* Volume as a fraction, mute as a flag; remembered for a player that is
   * not built yet and re-asserted when it is. */
  setSound(volume, muted) {
    this.volume = volume;
    this.muted = muted;
    const player = this.player;
    if (!player || typeof player.setVolume !== "function") return;
    try {
      player.setVolume(Math.round(volume * 100));
      if (muted) player.mute(); else player.unMute();
    } catch { /* mid-load; applied on the next PLAYING */ }
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

  /* The tier the player is actually showing, in pixels of height, or null
   * before it has said. */
  currentHeight() {
    const player = this.player;
    if (!player || typeof player.getPlaybackQuality !== "function") return null;
    try {
      return LEVEL_HEIGHTS[player.getPlaybackQuality()] || null;
    } catch {
      return null;
    }
  }

  /* The video's own title, once the player has it.  A deep link arrives
   * with nothing but an id, and this is the only place the real title
   * exists now that nothing else asks youtube about the clip. */
  title() {
    const player = this.player;
    if (!player || typeof player.getVideoData !== "function") return null;
    try {
      return (player.getVideoData() || {}).title || null;
    } catch {
      return null;
    }
  }

  /* Where the clip is, in the shape the <video> element reports. */
  status() {
    const YT = window.YT;
    const player = this.player;
    if (!YT || !player || typeof player.getPlayerState !== "function") {
      return { currentTime: 0, duration: NaN, paused: true, buffering: false };
    }
    const state = player.getPlayerState();
    return {
      currentTime: typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0,
      duration: typeof player.getDuration === "function" ? player.getDuration() || NaN : NaN,
      paused: state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING,
      buffering: state === YT.PlayerState.BUFFERING,
    };
  }

  /* Stand down, keeping the player for the next video (see open). */
  close() {
    this.handlers = {};
    this.sent = null;
    // A session let go of while its video was still arriving: whoever is
    // waiting on the cue is told, rather than left on a promise the state
    // change for this video will never resolve.
    this.settleCue(new Error("the video was let go of before it loaded"));
    if (this.player) {
      try { this.player.stopVideo(); } catch { /* mid-load; it will stop */ }
    }
  }
}
