# gaze360 — steer a 360 video with your eyes

Play an equirectangular 360 video and move the camera by looking. Look left and
the view turns left; look back at the centre of the screen and it comes back to
where it started. No mouse, no headset, no per-user training.

Gaze comes from the `gaze-direct` model: 478 MediaPipe landmarks into one ONNX
graph, out comes a camera-frame gaze vector. No head-pose solver and no
personal calibration beyond a two-second centring pass.

## Start

```powershell
.\run.bat
```

The first launch creates `.venv` and installs the two packages. It then opens
your webcam, serves the player on `http://127.0.0.1:8360/`, and opens a browser
tab.

Click **Begin** and a green dot appears in the middle of the screen. Stare at
it: three seconds of countdown to let your eyes settle on it, then about two
seconds of sampling while you hold still. That pass is what teaches the player
where your neutral gaze sits — everything afterwards is measured from it. Press
`C` any time to run it again.

```powershell
.\run.bat --video "D:\clips\my360.mp4"   # any equirectangular mp4
.\run.bat --self-test                    # validate the model bundle, no camera
.\run.bat --no-browser                   # do not open a tab
```

`--video` defaults to `..\gaze-demo\testvid.mp4`. Nothing is ever copied or
modified; the file is read where it lies.

| Key | |
|---|---|
| `C` | recalibrate — stare at the green dot |
| `Space` | play / pause |
| `F` | fullscreen |
| `H` | hide the overlay |
| `←` `→` | seek five seconds |

## How it steers

Absolute mapping. Your gaze offset from centre sets the view *angle*, so
looking back to the middle of the screen brings the view back to where it
started — the view is an extension of where you are looking, not a joystick
you have to re-centre.

```
e     = smoothed gaze angle − calibrated centre
view  = sign(e) · gain · (|e| − deadzone)      clamped to the axis limit
```

The two axes are independent and deliberately not equally geared. A viewer
sweeps their eyes much further horizontally than vertically, so an even gain
leaves the vertical axis feeling dead: pitch gets nearly twice the gain and
half the deadzone, and eight degrees of upward glance is worth a 49° look up.

| Flag | Default | |
|---|---|---|
| `--gain-yaw` | 4 | degrees of view per degree of gaze, left/right |
| `--gain-pitch` | 7 | degrees of view per degree of gaze, up/down |
| `--deadzone-yaw` | 2° | gaze error that commands no motion, left/right |
| `--deadzone-pitch` | 1° | gaze error that commands no motion, up/down |
| `--max-yaw` | 180° | furthest the view may turn |
| `--max-pitch` | 85° | furthest the view may look up or down |
| `--smooth-time` | 0.13 s | how long the view takes to reach a new target |
| `--expo` | 1 | response curve; 1 is proportional |
| `--tau` | 0.03 s | gaze smoothing, before the easing |

Turn the gains up for more reach per glance, `--smooth-time` down for a
snappier feel and up for a calmer one.

### Smoothness and lag

Gaze arrives at 30 Hz; the display runs at 60 or more. The browser eases
towards each new target with a **critically damped spring**, which is what
turns stepped readings into continuous motion — critically damped meaning it
converges without ever overshooting or oscillating, however hard the target
jumps. Both axes ease independently, so a diagonal glance traces a straight
diagonal.

Latency is dominated by things with hard floors: the webcam delivers 30.5
frames per second whatever mode is requested, and detection plus inference
costs about 14 ms. What is left to spend is the smoothing, so `--tau` is short
(30 ms) and the easing does the rest of the work where it can run at display
rate rather than gaze rate.

Absolute mapping cannot show you what is directly behind you — reaching 180°
would take a 47° glance. That is the price of having the view come home when
you look back at the centre, which is the behaviour worth having.

Three details that matter more than they sound:

- **Losing your face holds the view.** A blink or a hand across the face must
  not throw the view back to centre, so the last target is kept until tracking
  returns. An absolute target cannot run away, unlike a pan speed.
- **Calibration eases home.** Pressing `C` returns the view to the origin
  while you are being asked to look at the centre, rather than snapping when
  the countdown ends.
- **Calibration counts down before it samples.** Sampling the instant you
  press the key would average in the moment your eyes were still travelling
  towards the dot. Where your webcam sits relative to your screen is a real
  per-setup bias, and this pass is what removes it — so it is worth the three
  seconds. Press `C` again whenever you shift in your seat.

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
show anything — *after* the video data. In `testvid.mp4` that puts a 163 KB
index behind 2 GB of frames, so a browser cannot start until it has hunted to
the end of the file.

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

**The view wobbles when you hold still.** Press `C` and hold still while it
recalibrates. If it persists, widen the deadzones: `--deadzone-yaw 3
--deadzone-pitch 2`.

**It moves too far, or not far enough.** `--gain-yaw` and `--gain-pitch` are
the sensitivity of each axis independently.

**It feels twitchy, or laggy.** `--smooth-time` is the trade: 0.08 is snappy
and shows more of the estimate's jitter, 0.2 is calm and trails further behind.
