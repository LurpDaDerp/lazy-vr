# LazyVR — steer YouTube's 360 videos with your head

A web page. Pick a 360 video off YouTube's shelves, by search, or from a
file on your own disk, and turn your head to look around inside it. It runs
in an ordinary browser tab with a webcam. There is no headset, no install
and no calibration step. The camera picture is processed in your browser and
never leaves the device.

There are two pieces:

- **The page** (`site/`, plain ES modules, no build step) does everything
  perceptual: the webcam, face landmarks, head pose, the steering law and
  the player.
- **The server** (`server/`, or `api/index.py` on Vercel) does the one thing
  a browser cannot. It runs YouTube's search through `yt-dlp`, filtered to
  360° uploads, because YouTube's results page has no CORS headers. It never
  sees a camera frame or a video byte.

A YouTube clip plays in **YouTube's own embedded player**, loaded by the
browser straight from YouTube and steered through the player's spherical
API. Playback is on YouTube's terms: its ads on the clips that carry them
(your own YouTube Premium applies), its view counts, its sign-in.

## Quick start

```
pip install -r server/requirements.txt
python server/app.py                    # http://127.0.0.1:8360/
```

Open the page, pick a video and allow the camera. Sit facing the screen.
After about a second of holding roughly still the view is centred on
wherever you are facing, and from then on turning your head turns the view.
`C` recentres.

The camera needs a secure page: `localhost` works, and so does any
`https://` host. A plain `http://` address on another machine shows the
library but cannot use the camera.

## How steering works

### Head pose, relative to the screen

The pipeline runs per camera frame, normally in a worker (see *Where the
tracking runs*):

1. **MediaPipe FaceLandmarker** (`@mediapipe/tasks-vision` 1.0.1, VIDEO
   mode, one face, iris landmarks included) finds 478 face landmarks on the
   raw, unmirrored frame. It tries the GPU delegate first and falls back to
   the CPU.
2. **solvePnP** (`pose.js`, hand-written) fits MediaPipe's canonical face
   model to 29 rigid landmarks (nose, eye corners, nose base, forehead,
   cheekbones; no lips, lids, brows or jaw). It uses Levenberg–Marquardt on
   SO(3) with Huber-weighted residuals, warm-started from the previous
   frame. The camera's focal length comes from an assumed 78° diagonal field
   of view.
3. **Screen-relative orientation.** The raw solve gives the head's rotation
   relative to the camera. That is not what you want: lean to one side while
   still looking at the middle of the screen and your head *is* rotated
   relative to the camera. So `pose.js` places a pivot roughly where the
   neck turns (8 cm below and 9 cm behind the eye midpoint), smooths it, and
   measures the head's orientation relative to the ray from that pivot to
   the screen centre. The screen centre is assumed to be 12 cm below the
   camera, which is the **Camera position** setting (above: 12 cm, below:
   −10 cm, beside/other: 0). The result: moving around in the frame, leaning
   back, or sitting off to one side while facing the screen all read as
   "looking at the centre", and only actually turning your head counts.
4. **Gates.** A frame is not used for control when the fit is poor
   (normalised reprojection error above 0.06, or above 3× its running 2 s
   median), when the pose jumps more than 25° in one frame (held as a
   suspected outlier unless the next frame lands within 8° of it), when the
   eye corners or nose tip are within 2% of the frame edge, or when the head
   is nearer than 20 cm or farther than 200 cm. Beyond 25° of yaw the
   landmarks on the far side of the face are down-weighted.

### The hybrid law

`steer.js` turns the screen-relative pose into a view. Its numbers are
`STEER_DEFAULTS`:

| | Value | |
|---|---|---|
| Filter | One Euro, min cutoff 0.4 Hz, β 0.05, d-cutoff 1 Hz | on head yaw and pitch, with the frames' capture times |
| Position zone | gain ×3 (× Sensitivity); yaw ±20°, pitch ±25° of head | the view follows your head, magnified, and springs back when you face the screen again |
| Rate zone (yaw only) | past 20° of head yaw, ramping (smoothstep) to 90°/s (× Turn speed) at 35° | hold your head turned and the view keeps turning, all the way round and beyond |
| Rate dwell | 0.15 s | the head must stay past 20° this long, roughly settled, before turning starts |
| Look-away freeze | yaw beyond 45° (released below 40°), pitch beyond 35° (released below 30°) | you looked away from the screen, so the view holds |
| Face lost | no tracked frame for 0.5 s | the view holds |
| View pitch limit | ±85° | |
| Follower | critically damped spring, ω = 22 rad/s; 9 rad/s for 0.5 s after a freeze, recentre or toggle | runs at display rate, so a 30 Hz tracker still gives smooth motion |

In practice, with Sensitivity at 1:

- Within ±20° of yaw the view sits at 3× your head angle, up to ±60°.
  Facing the screen again brings it back. Pitch works the same way up to
  25° of head pitch (±75° of view) and has no rate zone.
- Between 20° and 35° the position term stays at the edge and a turning rate
  is added on top, so the view is continuous across the boundary. The rate
  only starts after the head has stayed past 20° for 0.15 s, moving at under
  30°/s and not swinging back toward the centre. A head swinging out to look
  at something else, or coming back from one, passes through without
  starting a turn.
- Turning accumulates. Bring your head back inside 20° and the view stays
  turned by however far it went; the position zone then works around the
  new heading. `C` or the Recenter button clears it.
- Past 45° (yaw) or 35° (pitch) you are looking away from the screen. The
  view holds where it was, the turning stops, and "Looking away — view held"
  shows after 0.6 s. When you face the screen again the view glides back to
  the live position.
- If the face is lost (out of frame, covered, too dark) the view holds the
  same way. A single dropped frame does not count; 0.5 s without a tracked
  frame does, and "Face lost" shows after 1 s. A turn in progress stops after
  two consecutive untracked frames, so the view never keeps spinning on a
  stale angle.

### Auto-zero, no calibration

There is no calibration screen. "Straight ahead" (the neutral) is learnt
from you:

- At the start of a session, and after the tracking is switched back on,
  the state is "acquiring" and the view holds still. The neutral becomes the
  median of the first 20 consecutive frames in which the head is moving
  under 15°/s and facing within ±15° of the screen. At 30 Hz that is about
  0.7 s.
- If you are steadily off-axis instead (a camera far to one side, a reclined
  seat) and stay that way for 3 s, that pose is accepted as your rest pose.
- Afterwards, whenever you are settled within ±4° of the neutral, the neutral
  eases toward your current pose with a 30 s time constant, so slow drift in
  posture is absorbed without your noticing.
- A face found again after being lost keeps the existing neutral.

**`C` (Recenter)** clears all accumulated turning and dragging and glides
the view back to the video's front. If you are tracked, steady, inside the
position zone and facing the screen, your current pose becomes the new
neutral at once. Otherwise (for example you are looking down at the keyboard
to find `C`) it re-acquires as above, so a glance at the keys never becomes
"straight ahead".

### The eye nudge

On top of the head, where your eyes look adds a small offset: at most ±10°
of yaw and ±6° of pitch. It only applies while the head is inside the
position zone and tracking normally, and it can be switched off with
**Eye assist**.

It needs no calibration because it does not try to measure absolute gaze.
`eyes.js` measures each iris in "eye widths" along the line between that
eye's corners, which cancels head roll and distance. Turning your head while
watching the screen also moves the iris in its socket (the vestibulo-ocular
reflex, plus parallax). That coupling is fitted online per axis as
`h = a + b·sin(head angle)` with a small Kalman filter, and only the residual
counts. The residual is the part of the eye movement your head pose does not
explain, which is close to zero whenever you look at your usual spot from
any head angle. A held look is not learnt as the new rest position: the fit
stops updating while the residual is large. Blinks are detected from the eye
aspect ratio (below 0.65× its running 3 s median, or below 0.15) and held
through, plus 120 ms.

`steer.js` then applies a deadzone with hysteresis (on above 5° of eye
angle, off below 3°) and maps 4°–20° of eye yaw to 0–10° of view (4°–14°
of pitch to 0–6°). The result springs toward its target with a 0.15 s time
constant, and back to zero when your eyes return to rest, blink for longer
than 0.5 s, or the head leaves the zone.

### Tracking off

`T` or the Tracking button switches head tracking off. The camera is
released and the light goes off. The head and eye contribution glides out,
and dragging still works. Switching it back on opens the camera and
auto-zeroes again.

## The player

Picking a card opens the player with the video already playing:

- If the camera is already allowed, the page goes fullscreen and tracking
  starts.
- If the browser has not asked yet, a small sheet over the playing video
  explains what the camera is for, with **Use camera** and **Watch without
  camera**. The browser's prompt comes first and fullscreen after it,
  because Chrome drops a page out of fullscreen to show a permission prompt.
  If fullscreen is refused by then, the next click anywhere enters it.
- If the camera is blocked or missing, the video plays with tracking off and
  a toast says so.

The first time per visit a hint appears: "Turn your head to look around · C
recenters". While the neutral is being acquired a small "Tracking" pulse
shows in the corner.

The controls are a YouTube-style bar that hides 2.5 s after the pointer
stops, cursor included. It stays up while paused, at the end of the video,
while settings are open, while the pointer is over a control, while a panel
is showing, and while a control has keyboard focus.

- Top: back to library, title.
- Seek bar: click or drag; buffered range and hover time. As a focused
  slider, arrows move ±5 s, PageUp/PageDown ±10 s, and Home/End jump to the
  ends.
- Bottom: play/pause, mute with a volume slider, `elapsed / duration`,
  **Recenter**, **Tracking** (Tracking, Finding you, Starting, Face lost,
  Tracking off, No camera), **Settings**, **Fullscreen**.

Only three things show over the video while the bar is hidden: "Face lost",
"Looking away — view held", and a thin buffering line along the top edge.

On the picture itself, a click plays or pauses (after a 220 ms wait to rule
out a double click), a double click toggles fullscreen, and a press-and-drag
looks around. Over YouTube's iframe these are handled by a transparent layer
of the page's own, so YouTube's drag-to-look never fights the head steering.
So that ads stay skippable, while the bar is showing that layer has a hole
where YouTube draws "Skip ad": the right 24% of the width, between 9% and
26% up from the bottom. Wake the bar (move the mouse), then click Skip.

At the end of the video a panel offers **Replay** and **Back to library**.
Errors show inline with **Retry** (when retrying could help) and **Back to
library**.

### Keyboard shortcuts

| Key | |
|---|---|
| `Space` / `K` | Play or pause |
| `←` / `→` | Back or forward 5 seconds |
| `J` / `L` | Back or forward 10 seconds |
| `↑` / `↓` | Volume (5% steps) |
| `M` | Mute |
| `F` | Fullscreen |
| `C` | Recenter the view |
| `T` | Head tracking on or off |
| `,` | Settings |
| `Esc` | Close settings, or back to the library |
| `?` | These shortcuts |

Shortcuts only act in the player. Keys with Ctrl, Cmd or Alt held are
ignored, and so is auto-repeat (except the arrows). They are also ignored
while typing in a field, inside the settings panel, and on a focused
button's own Space/Enter. In fullscreen the first `Esc` only leaves
fullscreen (the browser takes it); a second one goes back to the library.
The browser's Back button also returns to the library. While the library is
showing, only `Esc` (closing settings) does anything.

`?v=<youtube-id>` (or the older `?video=`) opens the player directly with
one Play button, since sound and fullscreen need a click.

### Watching without a camera

**Watch without camera**, a refused camera, or tracking switched off all
leave the view under the pointer. Drag the picture to look around. It works
like grabbing the world, as on YouTube: drag right and the picture moves
right. One pixel of drag is `field of view / window width` degrees on both
axes. Drag also works while tracking is on: it adds to the head's view, and
`C` clears it.

### Settings

Settings are saved on the device (`localStorage`, key `lazyvr.settings`) and
apply immediately, mid-video included.

- **Steering**: Sensitivity (×0.5–×2, how far the view turns for a head
  turn), Turn speed (×0.5–×2, the rate zone's speed), Eye assist, Invert
  horizontal, Invert vertical.
- **Picture**: Field of view (60–120°, horizontal, default 100°), Max
  quality (Auto, 1080p, 1440p, 4K, 8K), and a read-only "Playing at …" line.
- **Camera**: device, and Camera position (above, below or beside the
  screen).
- **Interface**: Diagnostics. A small readout appears bottom-left showing
  state, filtered head pose, eye angle, view, tracker rate, latency and mode,
  quality label and layout scale, and display fps.
- **Reset steering & picture** puts those two groups back to defaults and
  leaves volume, camera and diagnostics alone.

### A video off your own disk

**Play a file…**, or dropping a video anywhere on the page, plays it on a
WebGL2 sphere with the same steering, keys and drag. The file is never
uploaded: the page points a `<video>` element at an object URL. Anything the
browser can decode works; H.264 or VP9 in MP4 or WebM is the safe choice.
The footage should be equirectangular. A file has only the one encode it was
made with, so none of the quality logic below applies.

## Picture quality for 360

**Why a viewport-sized stream looks soft.** A 360 frame spreads its width
around the whole circle, but the window shows only the field of view. A
1920-wide stream viewed at 100° puts about 533 source pixels across a
1920-pixel window, a 3.6× upscale. To pixel-match the window, the stream
needs to be

```
required width = 360 × window width (CSS px) × devicePixelRatio / horizontal FOV
```

which for a 1920 px window at 100° is about 6900 px. YouTube labels 360
tiers by frame width (hd2160 is 3840 wide), and `quality.js` picks the
smallest tier on the ladder (720p, 1080p, 1440p, 4K, 8K, plus the small
ones) that covers the required width, limited by a cap.

**Layout scaling.** The embedded player ignores every documented quality
call (`setPlaybackQuality`, `vq`, `suggestedQuality` have done nothing since
2019). It picks its tier from the iframe's *layout* size. So `embed.js`
lays the iframe out at `k × window size`, with `k = tier width / window
width` clamped to 1–3, and draws it back at window size with
`transform: scale(1/k)` inside an overflow-hidden stage. With a capped tier
narrower than the window, `k` can go down to 0.5 (laid out smaller, scaled
up), which is the only way to honour a lower cap. The fit is redone,
debounced, on resize and on entering or leaving fullscreen.

**The cap.**

- **Decode cap**: `MediaCapabilities.decodingInfo` is asked about VP9 and
  AV1 at 3840×1920 and 7680×3840. A tier is allowed if at least one codec is
  reported supported, smooth *and* power-efficient: 8K, else 4K, else 1440p.
  If the API is missing or does not answer, the cap is 4K. Browsers answer
  optimistically, so this is permission to try rather than a guarantee.
- **Auto** (the default Max quality) is `min(decode cap, 4K)`. Auto never
  asks for 8K.
- **Max quality** 1080p, 1440p or 4K is honoured as chosen. 8K is still
  bounded by the decode cap.
- **Stall step-down**: three buffering stalls within 60 s (not counting the
  first 3 s of playback, the 5 s after a seek, or the brief buffering
  YouTube shows on every resume from pause) step the layout down one tier
  for the rest of that video, never below 720p and never back up. A toast
  says "Lowering quality to keep it smooth" once. Opening a video again
  starts from the full target.

What is actually playing is shown in Settings ("Playing at 2160p") and in
the diagnostics readout. An upload that was never encoded at the target
tier simply plays at its best.

## Privacy

- Camera frames are processed in the browser, normally in a worker. They are
  never uploaded, recorded or sent to the server. There is no camera preview.
- The server only answers search requests and serves static files.
- The face model (`site/models/face_landmarker.task`) is served by the site.
  MediaPipe's code and wasm come from jsDelivr.
- The camera is released (light off) when you leave the player, switch
  tracking off, or hide the tab. It reopens when the tab comes back if
  tracking was on.
- YouTube videos play in YouTube's own embed, which sees what any YouTube
  embed sees. Local files are never uploaded.
- Settings live in `localStorage` on the device. One `sessionStorage` flag
  remembers that the hint was shown this visit.

## Where the tracking runs

`camera.js` (`HeadTracker`) opens the camera (ideal 1280×720 at 30 fps,
user-facing) on the page, because `getUserMedia` only exists there. It hands
frames to `tracker-worker.js`, which hosts `TrackerEngine`
(`tracker-core.js`). It uses the best transport the browser offers:

| Mode | How frames get there | Cost to the page |
|---|---|---|
| `worker` | a `MediaStreamTrackProcessor` stream (buffer of 1) is transferred to the worker | nothing per frame |
| `frames` | no processor (Firefox, Safari): one 640-px-wide `ImageBitmap` at a time, each acknowledged, so one is ever in flight | the grab |
| `inline` | no usable worker: the engine runs on the page | all of it |

The worker is a classic worker that loads ES modules with dynamic `import()`,
because MediaPipe's wasm loader uses `importScripts()`, which module
workers do not allow. Every session has a run
id, and readings from a previous session are dropped. If the worker crashes
after loading it is restarted once, then the tracker falls back to inline
mode. After five consecutive detector failures on the GPU it switches to the
CPU once.

## Running it

### Locally

```
pip install -r server/requirements.txt
python server/app.py                    # http://127.0.0.1:8360/
python server/app.py --host 0.0.0.0     # serve beyond this machine
python server/app.py --port 9000        # or set $PORT
```

### Docker

```
docker build -t lazyvr .
docker run -p 8360:8360 lazyvr
```

The container is the whole product, page and search. It listens on `$PORT`
when a platform sets one (else 8360) and binds `0.0.0.0`. Put TLS in front of
it, because the camera only works on a secure page.

### From another device on your tailnet

```
python server/app.py --tailscale
```

This binds localhost plus this machine's Tailscale IP, so any device on your
tailnet can open `http://<tailscale-ip>:8360/`. The exact URL is printed at
startup. The LAN stays closed. If a remote device cannot connect, Windows'
firewall is blocking inbound Python; accept the prompt it shows on first
bind, or allow the port once.

A plain `http://100.x…` address is not a secure page, so a remote device can
browse but cannot start head tracking. `tailscale serve --bg 8360` publishes
the same server at `https://<machine>.<tailnet>.ts.net/` with a real
certificate, camera included (`tailscale serve reset` undoes it).

### Hosting

No video passes through the server, so the smallest free tier is enough.
Every platform below terminates HTTPS for you.

- **Fly.io**: `fly launch --copy-config --name <yours>`, then `fly deploy`
  (`fly.toml` is committed).
- **Render**: *New → Blueprint* on the repo; `render.yaml` does the rest.
  The free plan sleeps between visits.
- **Railway**: *Deploy from repo*; the Dockerfile is detected.
- **Any VPS or home server**: `docker run -d --restart unless-stopped -p
  8360:8360 lazyvr` behind Caddy or nginx for TLS, or `tailscale serve --bg
  8360` for a tailnet-only `https://…ts.net` URL.
- **Vercel**: see below.

### Vercel

`vercel` deploys a preview, `vercel --prod` production. `vercel.json` sets
it up as:

- **The page from the CDN.** `outputDirectory` is `site/` with no build
  step, so the HTML, modules, fonts and face model are static files on
  Vercel's CDN. `index.html` is `no-cache`; `/js/*` and `/css/*` are
  `max-age=0, must-revalidate` (ETag revalidation keeps the modules in step
  after a deploy); `/models/*` and `/fonts/*` are cached for a week.
- **`/api/*` to one Python function.** A rewrite sends `/api/home` and
  `/api/search` to `api/index.py`, which imports `server/source.py` (the same
  search code the aiohttp server uses). Root `requirements.txt` is the
  function's dependencies. Answers are cached in module globals while an
  instance stays warm and single-flighted per key. They also carry
  `s-maxage` so the edge holds them: home for 6 hours when every shelf
  succeeded (5 minutes when some failed), searches for 15 minutes.
- **Headers.** `nosniff`, `strict-origin-when-cross-origin` (the embed
  refuses to play without a referrer, error 153), and a `Permissions-Policy`
  allowing the camera for the site and fullscreen/autoplay for YouTube. No
  COOP/COEP, which would break the iframe.

`.vercelignore` keeps tests, docs and other local files out of the upload.

### Keeping search alive

- `yt-dlp` breaks as YouTube changes. When the shelves come up empty,
  redeploy with a fresh one. Install `curl-cffi` alongside it (both
  requirements files include it): that keeps a cloud host off YouTube's bot
  challenge, and it matters far more there than at home.
- YouTube sometimes challenges **datacenter IPs** ("confirm you're not a
  bot"). If search fails on a cloud host but works from home, that is what
  happened. A home or tailnet host is rarely challenged, and cookies fix it
  when it does happen.

#### When YouTube challenges the server

The server only ever asks YouTube for a results page, and
`server/source.py` does what it can before cookies are needed.

**What the request looks like.** YouTube reads the TLS and HTTP/2 handshake
before it reads a cookie, and Python's own fingerprint on a datacenter IP is
exactly the combination that gets challenged. With `curl-cffi` installed,
requests carry Chrome's fingerprint. It is optional at runtime: without it
the server asks for no impersonation rather than failing.
`LAZYVR_IMPERSONATE=off` opts out.

**A different IP.** `LAZYVR_PROXY=socks5://host:port` when an address is
simply burnt.

If that still gets challenged, give yt-dlp cookies. They must belong to the
machine the **server** runs on; a site can never read a visitor's own
YouTube cookies, and must not try.

| Variable | Meaning |
|---|---|
| `LAZYVR_COOKIES_FROM_BROWSER` | read a browser profile on the server's own machine: `chrome`, `edge`, `firefox`, or `chrome:Profile 1` |
| `LAZYVR_COOKIES_FILE` | path to a Netscape-format `cookies.txt` |
| `LAZYVR_COOKIES` | the file's *content*, passed by value (the form a platform secret takes) |

For Vercel, export cookies on your own machine and add them as a secret.
**Close the browser first**, because a running Chrome locks its cookie
database and the export fails. Then:

```
yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download "https://www.youtube.com/watch?v=jNQXAC9IVRw"
vercel env add LAZYVR_COOKIES        # paste the content of cookies.txt
vercel deploy
```

Cookies make every request count against that Google account, and accounts
used this way can be rate-limited or flagged. The yt-dlp wiki recommends a
throwaway account.

### Where the videos come from

The home page has eight shelves (Nature, Thrill, Ocean, Wildlife, Cities,
Space, Flight, Music), and the top bar searches by keyword. Both go through
`/api/home` and `/api/search`, which run the query against YouTube's search
with the **360° feature filter** (the `sp` parameter YouTube's own filter
sets). Only equirectangular uploads carry that flag, so everything that comes
back renders correctly on the sphere. No API key is involved. Clips under
30 s are dropped. Shelves are cached for six hours, searches for fifteen
minutes.

## Layout

```
site/                 the page (served as-is; no build step)
  index.html
  css/                tokens, base, library, player, overlay, settings
  fonts/              Atkinson Hyperlegible Next
  models/             face_landmarker.task
  js/app.js           orchestrator: library ⇄ player, sessions, wiring
  js/player.js        player screen: control bar, auto-hide, keyboard, pointer, panels
  js/chrome.js        pure player helpers: clocks, auto-hide rule, keymap, SHORTCUTS
  js/settings.js      settings model (v4) and panel
  js/library.js       shelves, search, cards
  js/camera.js        HeadTracker: camera, worker transport
  js/tracker-worker.js  classic worker hosting the engine
  js/tracker-core.js  TrackerEngine: FaceLandmarker → pose → eyes, one frame → one reading
  js/pose.js          canonical model, solvePnP, screen-relative pose, gates
  js/eyes.js          iris features, blinks, head–eye coupling fit
  js/filters.js       One Euro, rolling medians, helpers
  js/steer.js         Steering: readings → view (the hybrid law)
  js/embed.js         YouTube iframe player: layout scaling, steering, transport
  js/quality.js       360 tier choice, decode cap, stall monitor
  js/render.js        WebGL2 sphere for local files
server/               app.py (aiohttp: static files + the API), source.py (search,
                      caching, cookies/proxy/impersonation), requirements.txt
api/index.py          the same API as one Vercel function
tests/                JS tests (node --test) and Python tests (unittest)
vercel.json           CDN for site/, rewrite /api/* to the function, headers
Dockerfile, fly.toml, render.yaml
```

## Tests

```
node --test "tests/js/*.test.mjs"          # pose, eyes, filters, steering, quality, embed,
                                           # camera transport, player helpers, settings, page
python -m unittest discover -s tests       # the search source and the API
```

The JS tests cover the pure modules directly: solvePnP recovering known
poses, screen-relative compensation, and the gates; the eye coupling fit and
blink handling; the steering law (auto-zero only when steady, the position
zone and its spring-back, continuity at the zone edge, the rate dwell, full
360 turning, freeze and resume, the eye bounds and hysteresis, inverts,
recenter, tracking off/on, drag, NaN robustness and the sign conventions);
tier choice, layout scale, decode cap and stall policy; the keymap. Camera
transport runs in a stubbed worker harness with fake frames and a fake
`getUserMedia`. The Python tests run without yt-dlp or the network.

## Troubleshooting

**The Tracking button says "No camera".** The camera was refused, is
missing, or is in use by another app. Allow it in the browser's site
settings, then press `T`. On a plain `http` page that is not `localhost` the
browser will not even ask.

**It stays on "Finding you".** Auto-zero needs about 20 steady frames with
your face in view. Hold still facing the screen. If the camera is far off to
the side, holding still for 3 s is enough. Good light on your face helps
more than anything.

**"Face lost" keeps appearing.** Both eyes and the nose must stay inside the
frame, and you must be 20–200 cm from the camera. Backlighting (a window
behind you) and very low light are the usual causes. The diagnostics readout
shows the tracker rate; under 15 Hz it is marked, and tracking will feel
loose.

**The view is off-centre when I face the screen, or slowly turns.** Press
`C` while facing the middle of the screen. If it keeps happening, check
**Camera position** in settings. If the view is turning on its own, your
neutral pose is 20° or more from where you are now facing, which is the rate
zone; `C` fixes that too.

**The view stops following me.** You turned more than 45° sideways or 35°
up or down ("Looking away — view held"). Face the screen again and it glides
back.

**Left/right or up/down feels backwards.** Use Invert horizontal or Invert
vertical in settings.

**The view moves too much, or too little.** Sensitivity scales the position
zone; Turn speed scales the continuous turning. Switch off Eye assist if
glancing around the picture moves it more than you want.

**The picture is soft.** Check "Playing at …" in settings. A narrow window
needs a smaller tier; fullscreen asks for more. Max quality may be capping
it, or the device's decode cap (reported optimistically) may have limited it
to 1440p. After repeated stalls the video steps down for the rest of that
viewing; reopen it to start from the full target. Some uploads are simply
not encoded at higher tiers.

**A shelf or search says YouTube gave nothing back.** Almost always a stale
`yt-dlp`: `pip install -U yt-dlp` (or rebuild the container) and restart.

**Every shelf is empty and search returns nothing.** The server could not
read YouTube's results page. On a cloud host this is the bot challenge:
check that `curl-cffi` actually installed, then try cookies, then
`LAZYVR_PROXY` (all three above). Elsewhere it is usually a stale `yt-dlp`.

**One video will not play, and the others do.** The clip is age-restricted,
region-locked, or its uploader has disabled embedding. These are YouTube's
answers to the browser, and nothing here can change them. Error 153 means
the page sent no referrer; do not serve the page with
`Referrer-Policy: no-referrer`.

**I cannot skip an ad.** Move the mouse so the control bar shows; the
picture layer then lets clicks through to YouTube's "Skip ad" button.

**A local file will not play.** The browser has to decode it on its own, and
the sphere needs WebGL2. H.264 or VP9 in MP4 or WebM plays everywhere; HEVC,
ProRes and most `.mkv` do not.

**The camera light goes off when I switch tabs.** That is intended: a hidden
tab releases the camera, and it reopens when you come back.
