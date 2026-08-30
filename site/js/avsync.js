/* Two elements, one clock.
 *
 * Above 720p youtube stores video and audio as separate tracks, so the page
 * plays a <video> and an <audio> and this keeps them honest.  The video is
 * the clock: play, pause, and seeks are mirrored onto the audio as they
 * happen, and a slow watch corrects the drift that mirroring cannot see.
 *
 * Correction has two gears.  Small drift is steered out by trimming the
 * audio's playbackRate a few percent -- inaudible, and free of the click a
 * jump makes.  Large drift (a stall, a background tab) is snapped.
 */

export const SNAP = 0.4;     // seconds of drift that get jumped, not steered
export const STEER = 0.06;   // seconds of drift worth steering at all
export const TRIM = 0.04;    // how hard steering leans on playbackRate
export const WATCH_MS = 500;

export class AVSync {
  /* `video` is the element everything else already controls; `audio` is the
   * shadow.  Pass {watch: false} in tests and drive `tick()` by hand. */
  constructor(video, audio, options = {}) {
    this.video = video;
    this.audio = audio;
    this.enabled = false;
    const follow = () => this.follow();
    for (const name of ["play", "pause", "seeking", "seeked", "waiting", "playing", "ratechange"]) {
      video.addEventListener(name, follow);
    }
    if (options.watch !== false) setInterval(() => this.tick(), WATCH_MS);
  }

  /* Point both elements at a clip.  `audioSrc` is null for a muxed or
   * silent clip, and the shadow stands down entirely. */
  set(videoSrc, audioSrc) {
    this.video.src = videoSrc;
    this.enabled = Boolean(audioSrc);
    if (this.enabled) {
      this.audio.src = audioSrc;
    } else {
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }

  clear() {
    this.enabled = false;
    for (const element of [this.video, this.audio]) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
  }

  /* Mirror the video's current state onto the audio.  Called on every state
   * event; written so calling it twice is the same as calling it once. */
  follow() {
    if (!this.enabled) return;
    const running = !this.video.paused && !this.video.seeking
      && this.video.readyState >= 3 /* enough to be advancing */;
    if (Math.abs(this.audio.currentTime - this.video.currentTime) > SNAP) {
      this.audio.currentTime = this.video.currentTime;
    }
    if (running && this.audio.paused) this.audio.play().catch(() => {});
    else if (!running && !this.audio.paused) this.audio.pause();
  }

  /* The slow watch: steer small drift, snap large, re-mirror missed state. */
  tick() {
    if (!this.enabled) return;
    this.follow();
    if (this.video.paused || this.audio.paused) {
      this.audio.playbackRate = this.video.playbackRate;
      return;
    }
    const drift = this.audio.currentTime - this.video.currentTime; // + = audio ahead
    if (Math.abs(drift) > SNAP) {
      this.audio.currentTime = this.video.currentTime;
      this.audio.playbackRate = this.video.playbackRate;
    } else if (Math.abs(drift) > STEER) {
      this.audio.playbackRate = this.video.playbackRate * (1 - Math.sign(drift) * TRIM);
    } else {
      this.audio.playbackRate = this.video.playbackRate;
    }
  }
}
