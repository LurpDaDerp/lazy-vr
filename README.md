# LazyVR — steer YouTube's 360 videos with your eyes

A web page. Open it, pick a 360 video from YouTube — off the shelves or by
search — look around: look left and the view turns left, look back to the
middle and it stops where it is. No headset, no mouse, no install, no ads.

Two pieces. The **page** does everything perceptual in the browser: the
webcam, the face landmarks, the gaze model, the control law, the rendering.
The **server** is small and does only what a browser cannot: it asks
YouTube's search (through `yt-dlp`, filtered to 360° uploads) and proxies
the raw video streams, because the stream URLs YouTube signs are bound to
the server's IP and carry no CORS headers — and the page needs the video as
a WebGL texture, which is exactly the fetch CORS guards.

Playing the raw stream is also why there are no ads: this player has no ad
system to inject them. The flip side is worth saying plainly — pulling
streams this way is against YouTube's terms of service, and it depends on
`yt-dlp` keeping up with YouTube, so keep it updated and keep this for
personal use.

Gaze comes from the `gaze-direct` model: 478 MediaPipe landmarks into one
ONNX graph, out comes a camera-frame gaze vector. No head-pose solver and no
personal calibration beyond one short centring pass per visit.

## Run it

```
pip install -r server/requirements.txt
python server/app.py                    # http://127.0.0.1:8360/
```

Or as a container:

```
docker build -t lazyvr .
docker run -p 8360:8360 lazyvr
```

## Host it

The container is the whole product — page, search, proxy — and nothing in it
refers back to any particular machine. Every visitor's webcam and gaze
inference belong to *their* browser: the models load onto the visiting
device and the server never sees a camera frame; it only searches YouTube
and relays stream bytes. The server listens on `$PORT` when a platform
injects one (else 8360) and binds `0.0.0.0` inside the container.

Pick a platform — each terminates HTTPS for you, which is exactly what the
camera needs:

- **Fly.io** — `fly launch --copy-config --name <yours>`, then `fly deploy`
  (`fly.toml` is committed).
- **Render** — *New → Blueprint* on the repo; `render.yaml` does the rest.
  The free plan sleeps between visits.
- **Railway** — *Deploy from repo*; the Dockerfile is detected.
- **Any VPS / home server** — `docker run -d --restart unless-stopped -p
  8360:8360 lazyvr` behind Caddy or nginx for TLS — or `tailscale serve
  --bg 8360` for a tailnet-only `https://…ts.net` URL with no reverse proxy
  at all.
- **Vercel** — `vercel` deploys a preview, `vercel --prod` the real thing.
  There is no long-lived server there, so `api/index.py` (wired by
  `vercel.json`) re-implements the API and relay as one serverless
  function: shelves and search work the same, and the media relay serves
  bounded chunks that the `<video>` element's own range requests string
  together. Serverless caveats: cold starts re-resolve streams, and
  YouTube's datacenter-IP challenge (below) applies with full force.

Three hosting realities:

- Every video byte a viewer watches flows **through the server**: give it
  bandwidth — an active 4K–8K viewer pulls tens of Mbit/s.
- `yt-dlp` rots as YouTube changes; redeploy with a fresh one when streams
  stop resolving.
- YouTube sometimes challenges **datacenter IPs** ("confirm you're not a
  bot"). If searches or streams die on a cloud host but work from home,
  that is what happened; a home or tailnet host is rarely challenged, and
  cookies are the cure when it strikes (next section).

### When youtube challenges the server ("confirm you're not a bot")

Give yt-dlp cookies. They must belong to the machine the **server** runs on
— a site can never read a visitor's own youtube cookies, and must not try.
Three ways in, by environment variable:

| Variable | Meaning |
|---|---|
| `LAZYVR_COOKIES_FROM_BROWSER` | read a browser profile on the server's own machine: `chrome`, `edge`, `firefox`, or `chrome:Profile 1` |
| `LAZYVR_COOKIES_FILE` | path to a Netscape-format `cookies.txt` |
| `LAZYVR_COOKIES` | the file's *content*, passed by value — the shape a platform secret takes |

For Vercel, export cookies on your own machine and hand them over as a
secret. **Close the browser first** — a running Chrome locks its cookie
database and the export fails — then:

```
yt-dlp --cookies-from-browser chrome --cookies cookies.txt --skip-download "https://www.youtube.com/watch?v=jNQXAC9IVRw"
vercel env add LAZYVR_COOKIES        # paste the content of cookies.txt
vercel deploy
```

Cookies make every request count against that google account, and accounts
used this way can be rate-limited or flagged; the yt-dlp wiki recommends a
throwaway account, and it is good advice.

### From another device on your tailnet

```
python server/app.py --tailscale
```

binds localhost plus this machine's Tailscale IP, so any device signed into
your tailnet can open `http://<tailscale-ip>:8360/` — the exact URL is
printed at startup. The LAN stays closed; only the tailnet is let in. If a
remote device cannot connect, Windows' firewall is blocking inbound Python —
accept the prompt it shows on first bind, or allow the port once.

One catch: browsers hand the camera only to a **secure** page, and
`http://100.x…` is not one, so a remote device can browse the library but
cannot start gaze steering. `tailscale serve --bg 8360` is the proper fix:
it publishes the same server at `https://<machine>.<tailnet>.ts.net/` with a
real certificate, camera included (`tailscale serve reset` undoes it).

Chrome will ask for the camera the first time you pick a video. A green dot
appears: three seconds to settle, then hold still until the bar fills — and
the dot then hops up-right for one more short hold. The first dot teaches
the player where your neutral gaze sits; the second measures what a screen
pixel is worth to your eyes, which is what lets a moved or resized window
stay aimed (see below). Look away and the current dot starts over. It runs
once a visit, `C` reruns it whenever you shift in your seat, a real change
of screen size — fullscreen, a snapped window — pauses the video and reruns
the dots by itself, and the camera is released — light off — whenever you
are back in the library.

| Key | |
|---|---|
| `R` | recentre — turn the view back to where the video started |
| `C` | recalibrate — stare at the green dot |
| `Space` | play / pause |
| `F` | fullscreen |
| `H` | hide the overlay |
| `←` `→` | seek five seconds |
| `Esc` | back to the library |

On a phone there is no keyboard; the three that matter appear as buttons.

`?selftest` on the URL runs the gaze graph in *your* browser against the
exporter's eight reference frames and reports the worst deviation, without
opening a camera. `?video=<youtube-id>` jumps straight to one upload.

## Where the videos come from

The home page is shelves — Nature, Thrill, Ocean, Wildlife, Cities, Space,
Flight, Music — and the top bar searches by keyword. Both go through
`/api/…` on the server, which runs the query against YouTube's own search
with the **360° feature filter** (the `sp` parameter YouTube's search UI
sets when you tick that box). Only equirectangular uploads carry the flag,
so the filter is also the projection check: everything that comes back
renders correctly on the sphere. No API key is involved. Shelves are cached
for six hours, searches for fifteen minutes.

Picking a video resolves it with `yt-dlp`. Above 720p YouTube stores video
and audio separately, so the page plays a `<video>` and an `<audio>` and
`avsync.js` keeps them honest: state changes are mirrored as they happen,
small drift is steered out by trimming the audio's playbackRate a few
percent (inaudible), a stall's worth of drift is snapped.

The page tells the server what it can decode (`vp9`/`av01`/`avc1`, in its
own preference order) and the server picks the best track within that —
tallest first, up to 8K on a desktop, capped at 4K on phones. Seeking works
because the proxy passes byte ranges straight through to YouTube's servers.
The resolved URLs expire after ~6 hours; the proxy re-resolves on a 403, and
a video left paused overnight will ask to be picked again.

When the raw stream is refused outright — the bot-challenge on a datacenter
host, a region lock — the page falls back to **youtube's own iframe player**
for that video, steered by the same gaze pipeline through the player's
spherical API. Playback then always works, at youtube's price: its
presentation, ads included when a clip carries them (a viewer's own youtube
premium applies), and no motion blur. A toast says which engine you got.

## How it steers

Rate control. Your eyes are a stick, not a pointer: how far off centre you
look sets how fast the view *turns*, and it stays where you left it. Hold your
eyes to the left and it keeps sweeping left; look back to the middle and it
stops, exactly there. Nothing returns on its own; `R` turns you home.

```
e     = smoothed gaze angle − calibrated centre
rate  = sign(e) · gain · (|e| − deadzone)      clamped to the axis limit
```

`control.js` decides only that much: the speed you are asking for, and
whether you have actually committed to a turn rather than glanced. Where the
view points is worked out by `body.js`, at display rate, because what carries
the request out is meant to read as a head rather than a filter.

### Why pitch is geared harder than yaw

A screen `a` times wider than it is tall gives your eyes `a` times as much
room to travel sideways as up and down. For both axes to reach the same speed
at the same *fraction* of the travel available to them, pitch takes the aspect
as gain and gives it straight back on the deadzone:

```
(E − dz) · g   ≡   (E/a − dz/a) · g·a
```

`a` is measured, not assumed: the page reads the viewport it is filling and
re-reads it on every resize and on fullscreen. An ultrawide, a 4:3 monitor and
a phone held upright each get their own gearing, and on a screen taller than
it is wide pitch gears *slower* than yaw, which is right.

Size matters as much as shape. Calibration is only true for the viewport it
happened in: go fullscreen afterwards and the same screen-edge glance is
*more* degrees of eye travel than the map was tuned for. So a finished
centring pass remembers its viewport, and every deadzone and gain rescales
by how much each axis has grown since — deadzones multiplied by it, gains
divided — keeping one thing invariant: the same **fraction** of the view
always asks for the same turn. At the calibrated size the scales are 1 and
nothing changes.

A moved window needs more than a ratio: a side-snapped window taken
fullscreen puts "straight ahead" somewhere physically different on the
monitor. That is what the second calibration dot is for. It sits a known
number of pixels from the first, so the difference between the two
fixations measures degrees-of-gaze per screen pixel — magnitude *and* sign,
per axis — and whenever the viewport's centre moves on the monitor, the
calibrated centre is shifted by exactly what those pixels are worth. An
implausible measurement (a botched second fixation) is discarded rather
than believed. The one assumption is one monitor at one viewing distance;
after dragging to a different monitor, press `C`.

| screen | pitch deadzone | pitch rate |
|---|---|---|
| 4:3 | 2.25° | 12.8 |
| 16:9 | 1.69° | 17.1 |
| 21:9 | 1.29° | 22.4 |
| 9:16 (portrait) | 5.33° | 5.4 |

| Setting (`control.js`) | Default | |
|---|---|---|
| `rateYaw` | 9.6 | deg/s of turn per degree of gaze, left/right |
| `ratePitch` | from the screen | `rateYaw` × aspect |
| `deadzoneYaw` | 3° | gaze eccentricity that commands no motion |
| `deadzonePitch` | from the screen | `deadzoneYaw` ÷ aspect |
| `maxRateYaw` | 128°/s | fastest the view may sweep |
| `maxRatePitch` | 96°/s | same, up/down; a comfort cap |
| `onset` | 0.03 s | off centre before the view commits to a turn |
| `calibrationHold` | 1.4 s | continuous fixation that finishes a pass |
| `calibrationTolerance` | 2.5° | wander that restarts one |
| `tau` | 0.02 s | gaze smoothing, before the body |

The deadzone is set in degrees of visual angle, not screen fraction. People do
not recruit the head for gaze shifts below roughly 18°, so that is the
physiological ceiling and 3° is walked a long way down from it — a viewer at a
screen cannot turn their real head to help, and the onset gate does the glance
rejection the deadzone would otherwise have to.

### The body

The camera is not a filter on your gaze, it is a limb obeying it, and a few
things do nearly all the work of selling that. None of them is something a
viewer can name; they just stop it feeling like a tripod.

**Acceleration is limited, not velocity.** A first-order smoother has its
maximum acceleration the instant motion begins and a decaying tail after; a
real head turn is the other way round, with a bell-shaped velocity profile.
Clamping acceleration at 380°/s² gives a linear ramp while the clamp bites and
an exponential settle once it does not. The stiffness is asymmetric (6 up, 10
down) because heads stop faster than they start, which is also what stops the
view feeling like it coasts past where you wanted it. Deliberately no
overshoot: your own gaze is already a feedback element in this loop, and
underdamped machine dynamics plus a human chasing them is how you get a view
that hunts.

**The turn starts ~33 ms late.** Respond the instant the gaze crosses the
deadzone and the world feels welded to your eyeball; add a lag and it reads
as a separate limb obeying you. In a natural gaze shift the eye saccades and
the head follows 60–120 ms behind; this is deliberately under that, tuned for
responsiveness. It is a commit gate rather than a delay line, so it costs
nothing once moving. The delay moves in whole gaze samples, because the gate
can only open when a reading arrives: at ~30 Hz that is one sample or two,
with nothing in between.

**The neck has an end, and it is not a box.** The head turns 120° either way
and looks 90° up or down — but not both at once: turned right round to the
side there is nothing left for looking up. The reachable set is an ellipse in
(yaw, pitch), and where the head sits inside it is one number, its radius.
Inside half that radius the neck is free. Beyond it, turning further costs
effort that climbs steeply as the limit nears — a full-speed sweep is still at
118°/s at 60% of the way out, 97°/s at 80%, 69°/s at 90%, and zero at the
end, where the outward part of any request is simply gone. Only the outward
part is taxed: coming back is free, as a real neck springs back, and sliding
along the limit — trading yaw for pitch — crawls rather than sweeps. Held near
the end the head is not quite steady, either.

**It never sits perfectly still.** Two octaves of value noise, a third of a
degree of yaw and a sixth of pitch, faded out the moment the view is
genuinely turning. A perfectly static camera is the plainest tell that there
is no body behind it.

Two smaller ones: a roll of up to 2.5° driven by yaw *acceleration*, so the
head leans into the two ends of a sweep rather than throughout it; and five
taps of directional motion blur along the yaw axis, which besides being what
a turning head sees also hides the judder a 30 Hz gaze pipeline puts into a
fast rotation.

### Losing your face asks for a stop

A blink or a hand across the face must not keep you turning, so anything that
is not a clear reading commands zero rate and the body coasts to a halt. A
rate is not an angle: repeated forever while the tracker is quiet it would
spin you round and round, so silence is read as "stop", never as "carry on",
and a refound face has to wait out the commit delay before a turn resumes.

## The gaze pipeline, in the browser

`gaze.js` runs where the camera is. MediaPipe's FaceLandmarker
(`@mediapipe/tasks-vision`) reads `face_landmarker.task`; onnxruntime-web
runs `gaze_direct.onnx`; `geometry.js` builds the model's inputs. Both
libraries load from jsDelivr with pinned versions; the model files load
from the site.

Per frame: detect landmarks on the raw camera frame, detect again on a
horizontally flipped copy and un-mirror it through the 478-point left/right
permutation, average the two clouds (this cancels the extractor's per-side
noise and its side-dependent pitch offset), normalise into the eye-centred
weak-3D cloud, build the camera context — the calibrated ray through the eye
midpoint plus the running median of four eye statistics — mark out-of-frame
landmarks invalid, and run the graph on a batch of two: the cloud and its
mirror, whose gaze is un-mirrored and averaged with the direct one.

The detector sees the **raw** frame, never a mirrored one, because the sign
of "left" depends on it: the camera's +x is image right, which is where your
own left lands. The preview is mirrored for display only, in CSS.

`geometry.js` is held to the numpy original by a fixture the numpy produced
(`tests/fixtures/geometry_parity.json`, made by `tools/export_fixtures.py`):
eight frames, every intermediate quantity, agreement to 1e-12. And
`?selftest` runs the graph itself against the exporter's reference outputs;
in Chrome it agrees to 2e-7, the same figure the Python parity check gave.

### On a phone

It runs, with caveats. The face landmarker and the gaze graph take real
compute; a recent phone manages 15–25 gaze readings a second, and if it cannot
keep up the second (mirrored) extraction pass is dropped automatically to
protect the frame rate — the HUD then says `1-pass`. Streams are capped at 4K
for coarse-pointer devices because most phone decoders stop there. The axes
re-gear themselves for a portrait screen (see above).

## Tests

```
node --test "tests/js/*.test.mjs"          # geometry parity, control law, body, avsync
python -m unittest discover -s tests       # the youtube source: clips, format picking
```

The control law's tests pin its defining properties — a held gaze keeps
turning, a brief glance moves nothing, both axes reach the same speed at the
same share of their travel on any screen shape. The body's pin the neck: exact
limits on each axis, the ellipse never exceeded from any direction, the sweep
slowing band by band, release free, sliding a crawl. The source's pin what
counts as a clip and which format each browser is handed; they run without
yt-dlp or the network.

## Layout

```
site/            the page: index.html, style.css, js/, models/
server/          app.py (aiohttp: static + api + stream proxy), source.py
                 (search, format picking), requirements.txt
tools/           export_fixtures.py (regenerates the parity fixtures)
tests/           JS tests (node --test) and Python tests (unittest), fixtures
Dockerfile       page + server as one deployable container
```

## Troubleshooting

**"Camera access was refused."** Allow the camera for the site in the
browser's site settings and reload. On a page served over plain `http` that
is not `localhost`, the browser will not even ask.

**A shelf or search says youtube gave nothing back.** Almost always a stale
`yt-dlp`: `pip install -U yt-dlp` (or rebuild the container) and restart.

**"Would not stream" on every video.** Same cure. If only one video, it is
usually age-restricted or region-locked — those resolve for no one.

**The video stays black in a background tab.** Chrome does not load media in
a tab that is not in front. Bring it forward; the page reloads it.

**Sound drifts out of step.** It should be steered back within a second or
two; a persistent offset means the browser is throttling the audio element —
check that power saving is not aggressive. `Esc` and re-pick resets both
clocks.

**The view drifts when you hold still.** Press `C` and hold still while it
recalibrates. A rate map cannot tolerate a biased centre the way a position
map could — a small standing offset is a slow permanent turn.

**Calibration never finishes.** It ends on stillness, so it waits forever if
the reading is too noisy to sit inside `calibrationTolerance`. Better light
on your face helps more than anything; raising the tolerance in `control.js`
is the fallback.

**It is slow on a phone.** The HUD's `tracker` row shows the gaze rate. Under
about 15 Hz the mirror pass has already been dropped (`1-pass`); below that
the phone is simply too slow for the landmarker.
