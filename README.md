# gaze360 — steer a 360 video with your eyes

Play an equirectangular 360 video and move the camera by looking. Look left and
the view pans left; look back to the centre and it stops. No mouse, no
headset, no per-user training.

Gaze comes from the `gaze-direct` model: 478 MediaPipe landmarks into one ONNX
graph, out comes a camera-frame gaze vector. No head-pose solver and no
personal calibration beyond a two-second centring pass.

## Start

```powershell
.\run.bat
```

The first launch creates `.venv` and installs the two packages. It then opens
your webcam, serves the player on `http://127.0.0.1:8360/`, and opens a browser
tab. Click **Begin**, hold still while it learns where your neutral gaze sits,
and then look around.

```powershell
.\run.bat --video "D:\clips\my360.mp4"   # any equirectangular mp4
.\run.bat --self-test                    # validate the model bundle, no camera
.\run.bat --no-browser                   # do not open a tab
```

`--video` defaults to `..\gaze-demo\testvid.mp4`. Nothing is ever copied or
modified; the file is read where it lies.

| Key | |
|---|---|
| `C` | recalibrate — look at the centre of the screen |
| `Space` | play / pause |
| `F` | fullscreen |
| `H` | hide the overlay |
| `←` `→` | seek five seconds |

## How it steers

Rate control, the way a joystick works. Gaze angle past a deadzone sets the pan
*speed*, not the pan *position*:

```
e    = smoothed gaze angle − calibrated centre
u    = clamp((|e| − deadzone) / (max_angle − deadzone), 0, 1)
rate = sign(e) · max_speed · u²
```

Position mapping was the obvious alternative and it does not work here. You can
only look about ±35° before leaving the screen, so a 1:1 mapping can never
show you what is behind you, and multiplying it up to reach 360° multiplies the
model's error with it. Rate control reaches every direction and turns gaze
noise into something the integral averages away.

The squared response gives fine control near the centre and a fast pan at the
extremes. The 6° deadzone is sized against the model's 6.5° error, so a still
gaze drifts exactly zero.

| Flag | Default | |
|---|---|---|
| `--deadzone` | 6° | gaze error that commands no motion |
| `--max-angle` | 26° | error at which the pan reaches full speed |
| `--max-speed` | 120°/s | a full turn in three seconds |
| `--expo` | 2.0 | response curve; `1` is linear |
| `--tau` | 0.08 s | gaze smoothing time constant |
| `--min-confidence` | 0.5 | in-frame landmark fraction below which the view freezes |

`--max-speed` is the one most worth tuning to taste.

Three behaviours that matter more than they sound:

- **Losing your face freezes the view.** No face, or too much of it out of
  frame, forces the rate to zero. Otherwise glancing away would spin the world
  forever.
- **The browser stops on silence.** If the tracker dies, the last rate would
  keep panning. The page zeroes the rate after 400 ms without a packet, and the
  server sends zero once a reading goes stale.
- **Startup calibration.** Where your webcam sits relative to your screen is a
  real per-setup bias. The centring pass removes it; `C` redoes it if you move.

## Design

Python is headless — it owns the webcam and the control law and serves HTTP.
The browser is the whole interface, so keystrokes land in the window you are
already looking at.

```
webcam thread  ->  MediaPipe landmarker  ->  mailbox
                                                |
                    inference thread: gaze_direct.onnx  ->  GazeSample
                                                |
                              GazeController  ->  (yaw_rate, pitch_rate)
                                                |
                        SSE  ->  browser: yaw += yaw_rate·dt  ->  WebGL
```

**Python sends velocity; the browser integrates position.** Gaze arrives at
20–40 Hz but the view must move at the display's refresh rate. Sending absolute
angles would turn every late packet into visible stutter; sending rates
confines network jitter to the setpoint, and `requestAnimationFrame` integrates
smoothly regardless. It also puts every decision in pure Python where it can be
tested, leaving the browser two lines of arithmetic.

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

105 tests, all stdlib. The control law is pure and covered directly — deadzone
boundaries, saturation, the quadratic shape, frame-rate independence of the
smoother, gating, recentring. The MP4 rearrangement is checked against
byte-built fixtures on the invariant that every corrected chunk offset must
still address its own bytes. The server is booted for real and every route
exercised, including 206, 416 and a declined multi-range.

## Camera

Defaults to DirectShow, MJPEG, 1280×720 at 60 FPS.

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

**The view drifts on its own.** Press `C` and hold still. If it persists, widen
the deadzone: `--deadzone 8`.

**Panning feels twitchy or sluggish.** `--max-speed` sets the top rate and
`--tau` the smoothing; raise `--tau` to 0.15 for a calmer feel.
