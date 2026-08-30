# gaze360 — steer a 360 video with your eyes

Pick a clip from a library of equirectangular 360 video and move the camera by
looking. Look left and the view turns left; look back at the centre of the
screen and it comes back to where it started. No mouse, no headset, no per-user
training.

Gaze comes from the `gaze-direct` model: 478 MediaPipe landmarks into one ONNX
graph, out comes a camera-frame gaze vector. No head-pose solver and no
personal calibration beyond one short centring pass per visit.

## Start

```powershell
.\run.bat
```

The first launch creates `.venv` and installs the two packages. It then opens
your webcam, serves the player on `http://127.0.0.1:8360/`, and opens a browser
tab.

Put equirectangular `.mp4` or `.webm` files in `videos\` and they appear on the
start screen as a scrollable grid. Clips that land while the page is open turn
up on their own, so a folder that is still downloading fills in as it goes.

Click a clip and a green dot appears in the middle of the screen. Stare at it:
three seconds of countdown to let your eyes settle, then hold still until the
bar fills. Look away and it starts over. That pass teaches the player where
your neutral gaze sits — everything afterwards is measured from it — and it
only happens once a visit; `C` runs it again whenever you shift in your seat.
When the clip ends the grid comes back; `Esc` returns to it sooner.

```powershell
.\run.bat --videos "D:\clips"            # browse a different folder
.\run.bat --video "D:\clips\my360.mp4"   # skip the library, play one file
.\run.bat --check                        # will every clip play? no camera
.\run.bat --self-test                    # validate the model bundle, no camera
.\run.bat --no-browser                   # do not open a tab
```

`--videos` defaults to `videos\`. Nothing is ever copied or modified; every
file is read where it lies.

### Calibration

Where your eyes sit relative to your webcam is a real per-setup bias, and the
centring pass is what removes it. It is a **fixation test**, not a countdown:
after three seconds to settle, you have to hold one spot continuously. Wander
further than `--calibration-tolerance` and the bar goes back to zero, the dot
flashes amber, and the screen says you looked away. It ends when you have
genuinely held still for `--calibration-hold`, so it cannot finish on a gaze
that was still travelling.

It runs **once per visit**. Where your eyes sit does not change between clips,
so the second clip starts playing immediately. `C` forces a fresh pass whenever
you shift in your seat.

`R` is the other one, and does something different: it turns the view back to
where the clip started. `C` moves the reference the view is measured from; `R`
moves the view. It sweeps rather than cuts — the body still has mass — and any
steering of your own cancels it, so there is no sweep to sit through if you
change your mind.

### Thumbnails

Each card's picture is the horizon band of the sphere, unrolled: ffmpeg takes
one frame a fifth of the way in, keeps the middle half of it and leaves it
equirectangular. The poles of a 360 frame are stretched to mush and carry
nothing, while that band is where the clip actually lives — and keeping it
unrolled is what lets the card pan across the whole turn when you hover it.

They are built in the background into `.thumbs\`, named after each file's size
and modification time, so the cost is paid once and a re-download rebuilds its
own picture. Without ffmpeg on `PATH` the library still works; the cards simply
have no picture and no duration. Delete `.thumbs\` to force a rebuild.

| Key | |
|---|---|
| `R` | recentre — turn the view back to where the clip started |
| `C` | recalibrate — stare at the green dot |
| `Space` | play / pause |
| `F` | fullscreen |
| `H` | hide the overlay |
| `←` `→` | seek five seconds |
| `Esc` | back to the library |

## How it steers

Rate control. Your eyes are a stick, not a pointer: how far off centre you
look sets how fast the view *turns*, and it stays where you left it. Hold your
eyes to the left and it keeps sweeping left; look back to the middle and it
stops, exactly there. Nothing returns on its own, so anywhere is reachable —
including all the way around — at the price of having to steer back.

```
e     = smoothed gaze angle − calibrated centre
rate  = sign(e) · gain · (|e| − deadzone)      clamped to the axis limit
```

Python decides only that much: the speed you are asking for. Where the view
actually points is worked out in the browser, at display rate, because what
carries the request out is meant to read as a head rather than a filter.

### Why pitch is geared harder than yaw

A screen `a` times wider than it is tall gives your eyes `a` times as much
room to travel sideways as up and down. For both axes to reach the same speed
at the same *fraction* of the travel available to them, pitch takes the aspect
as gain and gives it straight back on the deadzone:

```
(E − dz) · g   ≡   (E/a − dz/a) · g·a
```

Gear them equally instead and the vertical axis feels dead, because the eye
runs out of screen long before the map runs out of gain.

**`a` is measured, not assumed.** The page reports the viewport it is actually
filling and re-reports whenever that changes, so an ultrawide, a 4:3 monitor
and a rotated tablet each get their own gearing — and going fullscreen
re-gears too, because swallowing the browser chrome changes the shape of the
picture your eyes are crossing. On a screen taller than it is wide the
relationship simply inverts and pitch gears *slower* than yaw, which is right:
there is more room to look up than sideways.

| screen | pitch deadzone | pitch rate |
|---|---|---|
| 4:3 | 2.25° | 12.8 |
| 16:9 | 1.69° | 17.1 |
| 21:9 | 1.29° | 22.4 |
| 9:16 (portrait) | 5.33° | 5.4 |

The pitch *ceiling* is the one thing not scaled: that is a comfort cap,
vertical motion being the more provocative axis with only 180° end to end.

| Flag | Default | |
|---|---|---|
| `--rate-yaw` | 9.6 | deg/s of turn per degree of gaze, left/right |
| `--rate-pitch` | from the screen | same, up/down — `--rate-yaw` × aspect |
| `--deadzone-yaw` | 3° | gaze eccentricity that commands no motion |
| `--deadzone-pitch` | from the screen | same, up/down — `--deadzone-yaw` ÷ aspect |
| `--max-rate-yaw` | 128°/s | fastest the view may sweep |
| `--max-rate-pitch` | 96°/s | same, up/down; a comfort cap |
| `--onset` | 0.03 s | off centre before the view commits to a turn |
| `--calibration-hold` | 1.4 s | continuous fixation that finishes a pass |
| `--calibration-tolerance` | 2.5° | wander that restarts one |
| `--expo` | 1 | response curve; 1 is proportional |
| `--tau` | 0.02 s | gaze smoothing, before the body |

The deadzone is set in degrees of visual angle, not screen fraction: people do
not recruit the head for gaze shifts below roughly 18°, so that is the
physiological ceiling and 3° is walked a long way down from it — a viewer
sitting at a screen cannot turn their real head to help, and the onset gate is
doing the work of rejecting glances that the deadzone would otherwise have to.

### The body

The camera is not a filter on your gaze, it is a limb obeying it, and four
things do nearly all the work of selling that.

**Acceleration is limited, not velocity.** A first-order smoother has its
maximum acceleration the instant motion begins and then a decaying tail; a
real head turn is the other way round, with a bell-shaped velocity profile.
Clamping acceleration at 380°/s² gives a linear ramp while the clamp bites and
an exponential settle once it does not — trapezoid out, exponential in. The
stiffness is asymmetric (6 up, 10 down) because heads stop faster than they
start, which is also what stops the view feeling like it coasts past where you
wanted it. Deliberately no overshoot, tempting though a real head's is: your
own gaze is already a feedback element in this loop, and underdamped machine
dynamics plus a human chasing them is how you get a view that hunts.

**The turn starts ~33 ms late.** Respond the instant the gaze crosses the
deadzone and the world feels welded to your eyeball; add a lag and it reads as
a separate limb obeying you. In a natural gaze shift the eye saccades and the
head follows 60–120 ms behind — this is deliberately under that, tuned for
responsiveness on the grounds that a viewer sitting at a screen cannot turn
their real head to help anyway. It is a commit gate rather than a delay line,
so it costs nothing once moving, and it still rejects a single-sample noise
spike.

The delay it buys moves in whole gaze samples, because the gate can only open
when a reading arrives. At ~30 Hz that means one sample (~33 ms) or two
(~66 ms), with nothing in between, so `--onset` wants to sit comfortably below
one step rather than near it: at the 30.5 FPS this webcam returns, 0.033 would
need two samples and quietly cost twice what it reads as.

**The neck has an end, and it is not a box.** The head turns 120° either way
and looks 90° up or down — but not both at once: turned right round to the
side there is nothing left for looking up. The reachable set is an ellipse in
(yaw, pitch), and where the head sits inside it is one number, its radius.
Inside half that radius the neck is free. Beyond it, turning further costs
effort that climbs steeply as the limit nears — a full-speed sweep is still at
118°/s at 60% of the way out, 97°/s at 80%, 69°/s at 90%, and zero at the
end, where the outward part of any request is simply gone. Only the outward
part is taxed: coming back is free, as a real neck springs back, and sliding
along the limit — trading yaw for pitch — crawls rather than sweeps. Held
near the end the head is not quite steady, either.

**It never sits perfectly still.** Two octaves of value noise, 0.25° of yaw
and 0.15° of pitch at 0.15–0.4 Hz, faded out the moment the view is genuinely
turning. A perfectly static camera is the plainest tell that there is no body
behind it.

Two smaller ones: a roll of up to 2.5° driven by yaw *acceleration*, so the
head leans into the two ends of a sweep rather than throughout it; and five
taps of directional motion blur along the yaw axis, which besides being what a
turning head sees also hides the judder a 30 Hz gaze pipeline puts into a fast
rotation.

None of these are things a viewer can name. They just stop it feeling like a
tripod.

### Latency

Latency is dominated by things with hard floors: the webcam delivers 30.5
frames per second whatever mode is requested, and detection plus inference
costs about 14 ms. What is left to spend is the smoothing, so `--tau` is short
(30 ms) and the body does the rest of the work where it can run at display
rate rather than gaze rate.

Two details that matter more than they sound:

- **Losing your face asks for a stop.** A blink or a hand across the face
  must not keep you turning, so anything that is not a clear reading commands
  zero rate and the body coasts to a halt. A rate is not an angle: repeated
  forever while the tracker is quiet it would spin you round and round, so a
  stale packet is read as "stop", never as "carry on".
- **Coming back has to earn the turn again.** Losing tracking shuts the onset
  gate, so a refound face waits out the commit delay rather than resuming a
  sweep you may no longer want.

## Design

Python is headless — it owns the webcam and the control law and serves HTTP.
The browser is the whole interface, so keystrokes land in the window you are
already looking at.

```
capture thread  ->  MediaPipe landmarker  ->  mailbox
                                                 |
                     inference thread: gaze_direct.onnx  ->  GazeSample
                                                 |
                               GazeController  ->  (yaw, pitch) target
                                                 |
                    SSE  ->  browser: spring towards it  ->  WebGL
```

**Python decides, the browser eases.** Python sends the angle the view should
point at; the browser springs towards it every animation frame. Every decision
— gains, deadzones, calibration, what to do when tracking drops — stays in pure
Python where it can be tested without hardware, while the interpolation that
has to run at display rate runs there.

**Server-Sent Events, not WebSockets.** A hand-rolled RFC 6455 server is a
handshake plus frame masking; SSE is a long-lived `text/event-stream` response,
and the webcam preview rides a `multipart/x-mixed-replace` endpoint that an
`<img>` tag consumes with no JavaScript at all. Same latency on localhost, far
less to get wrong, and no dependency beyond what the gaze model already needs.

**No 3D library.** The renderer is a fullscreen quad and a fragment shader that
turns each pixel into a view ray and samples the equirectangular frame
directly. No sphere mesh, no seam — `REPEAT` on longitude closes it in
hardware — and nothing to download.

### Streaming a camera-original file

A 360 camera writes its `moov` atom — the index a player needs before it can
show anything — *after* the video data. On a typical clip in the library that
puts a few hundred KB of index behind gigabytes of frames, so a browser cannot
start until it has hunted to the end of the file.

`gaze360/mp4.py` rearranges it virtually: `moov` is parsed once into memory,
its chunk offsets are corrected for the move, and the server presents
`ftyp + moov + mdat` while reading the original bytes from their original
places. Opening the 2 GB file costs 2.5 ms, nothing is written, and the file is
untouched. Anything not understood is served verbatim rather than guessed at.

The rearrangement is verified lossless: ffmpeg decodes the virtual stream to
byte-identical video and audio hashes, from a non-seekable pipe — which only
works because the index now leads.

## Model bundle

`gaze360/gaze_core/` is copied **byte-identical** from the gaze-direct demo, so
re-syncing after a retrain is a plain file copy:

```powershell
copy ..\gaze-demo\gaze_demo\geometry.py   gaze360\gaze_core\
copy ..\gaze-demo\gaze_demo\extraction.py gaze360\gaze_core\
copy ..\gaze-demo\gaze_demo\model.py      gaze360\gaze_core\
copy ..\gaze-demo\models\*                models\
```

Startup verifies the ONNX and permutation digests, requires a camera-frame
declaration, and replays the recorded parity frames; a stale or cross-wired
bundle is refused before the camera opens. See `MODEL_CARD.md` in gaze-demo for
the model itself.

### One departure from the demo

The demo detects on the *mirrored* preview so its arrow lines up with what you
see. This player detects on the **raw** frame, which fixes the sign
unambiguously: the camera's `+x` is image right, your own left lands on image
right, so looking left gives `atan2(x, z) > 0`. The preview is mirrored for
display only. The model is mirror-equivariant and runs mirror TTA internally,
so this costs no accuracy.

Signs are verified against a labelled equirectangular test pattern rather than
trusted on paper: at yaw `+45°` the `FRONT` marker sits where the projection
says it must, to the pixel. `--invert-yaw` and `--invert-pitch` are there
anyway.

## Tests

```powershell
.\test.bat
```

123 tests, all stdlib. The control law is pure and covered directly — per-axis
deadzones and gains, saturation, that a held gaze holds the view still, that
looking back to centre returns it, that both axes move together and neither
scales the other, and frame-rate independence of the smoother. The MP4 rearrangement is checked against
byte-built fixtures on the invariant that every corrected chunk offset must
still address its own bytes. The server is booted for real and every route
exercised, including 206, 416 and a declined multi-range.

## Camera

Defaults to DirectShow, MJPEG, 1280×720 at 60 FPS requested — though the
webcam this was built against returns 30.5 FPS in every mode offered, and that
input rate, not the pipeline, is what sets the gaze rate.

```powershell
.\run.bat --camera 1            # another camera index
.\run.bat --backend msmf        # if DirectShow fails
.\run.bat --focal-scale 0.92    # calibrated fx / image width (default 0.75)
```

If the camera will not open: allow camera access for desktop apps in Windows
Settings > Privacy & security > Camera, and close Teams, Zoom, OBS or any
browser tab that may own it.

## Troubleshooting

**The video stays black.** Chrome does not load media in a background tab.
Bring the window to the front and reload.

**A card has no picture.** ffmpeg has not reached that clip yet — the count
under the wordmark says how many are done. A card that never gets one is a file
ffmpeg could not decode; the clip may still play.

**The grid is empty.** The start screen names the folder it read. Files still
downloading are skipped until they are complete: `.part` files and the
`.f313.mp4` single-stream files a downloader leaves behind before muxing.

**The view drifts when you hold still.** Press `C` and hold still while it
recalibrates. If it persists, widen the deadzones: `--deadzone-yaw 8
--deadzone-pitch 4.5`. A rate map cannot tolerate a biased centre the way a
position map could — a small standing offset is a slow permanent turn.

**Calibration never finishes.** It ends on stillness, so it will wait forever
if the reading is too noisy to sit inside `--calibration-tolerance`. Raise it
(`--calibration-tolerance 4`) or shorten the hold (`--calibration-hold 1.0`).

**It turns too fast, or too slowly.** `--rate-yaw` and `--rate-pitch` are the
sensitivity of each axis; `--max-rate-yaw` and `--max-rate-pitch` cap the
sweep. Keep the 16/9 ratio between the two rates unless your screen is not
16:9, in which case use your own aspect.

**It starts turning before you meant it to.** Raise `--onset` — the eyes have
to stay off centre that long before anything moves, so a longer gate rejects
more glances. Lower it if the view feels reluctant.
