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

Or as a container, which is also how you host it:

```
docker build -t lazyvr .
docker run -p 8360:8360 lazyvr
```

Deploy the container to anything that runs Docker — Fly.io, Railway, a VPS —
and put HTTPS in front (the platform's ingress usually is already): browsers
refuse the camera to an insecure page. Two hosting realities to plan for:
every video byte a viewer watches flows **through the server**, so give it
bandwidth; and `yt-dlp` rots as YouTube changes, so redeploy with a fresh
one when streams stop resolving.

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
appears: three seconds to settle, then hold still until the bar fills. Look
away and it starts over. That pass teaches the player where your neutral
gaze sits, happens once a visit, and `C` runs it again whenever you shift in
your seat.

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
