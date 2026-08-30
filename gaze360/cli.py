"""Command line: wire the tracker to the control law to the HTTP server."""

from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .control import ControlConfig, GazeController
from .library import VideoLibrary
from .server import GazeServer, SharedState
from .tracker import GazeTracker, MODEL_STEM, load_bundle, run_parity

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODELS = ROOT / "models"
DEFAULT_WEB = ROOT / "web"
DEFAULT_VIDEOS = ROOT / "videos"
DEFAULT_THUMBS = ROOT / ".thumbs"


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gaze360",
        description="Steer a 360 video with your gaze.",
    )
    video = parser.add_argument_group("video")
    video.add_argument("--videos", type=Path, default=DEFAULT_VIDEOS,
                       help="folder of equirectangular clips to browse (default: ./videos)")
    video.add_argument("--video", type=Path, default=None,
                       help="play one file instead, skipping the library")
    video.add_argument("--thumbs", type=Path, default=DEFAULT_THUMBS,
                       help="where to keep generated thumbnails (default: ./.thumbs)")
    video.add_argument("--port", type=int, default=8360)
    video.add_argument("--host", default="127.0.0.1")
    video.add_argument("--no-browser", dest="open_browser", action="store_false",
                       help="do not open a browser tab on start")

    control = parser.add_argument_group("control")
    defaults = ControlConfig()
    control.add_argument("--deadzone-yaw", type=float, default=defaults.deadzone_yaw,
                         help="eye eccentricity that commands no motion, left/right "
                              f"(default: {defaults.deadzone_yaw:g})")
    control.add_argument("--deadzone-pitch", type=float, default=None,
                         help="same, up/down (default: derived from the screen the "
                              "page reports, which gives the eyes less room up and down)")
    control.add_argument("--rate-yaw", type=float, default=defaults.rate_yaw,
                         help="degrees per second of turn per degree of gaze, left/right "
                              f"(default: {defaults.rate_yaw:g})")
    control.add_argument("--rate-pitch", type=float, default=None,
                         help="same, up/down (default: derived from the screen the "
                              "page reports, geared by its aspect ratio)")
    control.add_argument("--max-rate-yaw", type=float, default=defaults.max_rate_yaw,
                         help=f"fastest the view may sweep, deg/s (default: {defaults.max_rate_yaw:g})")
    control.add_argument("--max-rate-pitch", type=float, default=defaults.max_rate_pitch,
                         help=f"same, up/down (default: {defaults.max_rate_pitch:g})")
    control.add_argument("--onset", type=float, default=defaults.onset,
                         help="seconds off centre before the view commits to a turn "
                              f"(default: {defaults.onset:g})")
    control.add_argument("--expo", type=float, default=1.0,
                         help="response curve exponent; 1 is proportional (default: 1)")
    control.add_argument("--tau", type=float, default=0.03,
                         help="gaze smoothing time constant in seconds (default: 0.03)")
    control.add_argument("--min-confidence", type=float, default=0.5,
                         help="in-frame landmark fraction below which the view freezes")
    control.add_argument("--calibration-hold", type=float,
                         default=defaults.calibration_hold,
                         help="seconds of continuous fixation that finish calibration "
                              f"(default: {defaults.calibration_hold:g})")
    control.add_argument("--calibration-tolerance", type=float,
                         default=defaults.calibration_tolerance,
                         help="degrees of wander that restart the pass "
                              f"(default: {defaults.calibration_tolerance:g})")
    control.add_argument("--invert-yaw", action="store_true")
    control.add_argument("--invert-pitch", action="store_true")

    camera = parser.add_argument_group("camera")
    camera.add_argument("--camera", type=int, default=0)
    camera.add_argument("--width", type=int, default=1280)
    camera.add_argument("--height", type=int, default=720)
    camera.add_argument("--camera-fps", type=float, default=60.0)
    camera.add_argument("--backend", choices=("dshow", "msmf"), default="dshow")
    camera.add_argument("--no-mjpeg", dest="mjpeg", action="store_false")
    camera.add_argument("--detector-width", type=int, default=640)
    camera.add_argument("--preview-width", type=int, default=320)
    camera.add_argument("--focal-scale", type=float, default=0.75)
    camera.add_argument("--threads", type=int, default=2)

    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--self-test", action="store_true",
                        help="validate the model bundle and exit; no camera")
    parser.add_argument("--check", action="store_true",
                        help="check every clip in the library and exit; no camera")
    return parser


def validate(args: argparse.Namespace) -> None:
    # The pitch pair may be None, meaning "derive it from the screen".
    if args.deadzone_yaw < 0 or (args.deadzone_pitch or 0) < 0:
        raise SystemExit("deadzones must not be negative")
    if args.rate_yaw <= 0 or (args.rate_pitch if args.rate_pitch is not None else 1) <= 0:
        raise SystemExit("turn rates must be positive")
    if args.max_rate_yaw <= 0 or args.max_rate_pitch <= 0:
        raise SystemExit("turn rate limits must be positive")
    if args.onset < 0:
        raise SystemExit("--onset must not be negative")
    if args.calibration_hold <= 0:
        raise SystemExit("--calibration-hold must be positive")
    if args.calibration_tolerance <= 0:
        raise SystemExit("--calibration-tolerance must be positive")
    if args.expo <= 0:
        raise SystemExit("--expo must be positive")
    if args.tau < 0:
        raise SystemExit("--tau must not be negative")
    if not 0 < args.focal_scale:
        raise SystemExit("--focal-scale must be positive")


def self_test(args: argparse.Namespace) -> int:
    model, metadata, _ = load_bundle(args.models_dir, args.threads)
    diff = run_parity(model, args.models_dir)
    fps, latency = model.benchmark(100)
    gate = metadata.get("eye_gate") or {}
    print(
        f"bundle OK: {MODEL_STEM} {int(metadata.get('parameters', 0)):,} parameters, "
        f"context width {model.context_width}, far-eye gate "
        f"{gate.get('low')}-{gate.get('high')}"
    )
    print(f"parity OK: max |dgaze| {diff:.2e}")
    print(f"inference: {fps:.1f} FPS / {latency:.2f} ms per frame (mirror TTA, batch 2)")
    return 0


def check_library(args: argparse.Namespace) -> int:
    """Report whether every clip in the folder can actually be played.

    Answers the only question that matters before a session: will each of
    these files load in the browser?  That needs three things -- the download
    has finished, ffprobe can read a picture out of it, and the index reaches
    the player before the frames do.
    """
    library, folder = open_library(args)
    clips = library.scan()
    if not clips:
        print(f"no clips in {folder}")
        return 1

    print(f"checking {len(clips)} clip(s) in {folder}\n")
    problems = 0
    for clip in clips:
        notes: list[str] = []
        if not clip.settled:
            notes.append("still downloading")
        else:
            library._probe(clip)
            if not clip.width or not clip.duration:
                notes.append("ffprobe could not read it")
            source = library.source(clip.id)
            if source is None:
                notes.append("cannot be opened")
            else:
                head = b"".join(source.chunks(0, 8191, 8192))
                if b"ftyp" not in head[:64]:
                    notes.append("no ftyp: not an MP4-family file")
                elif b"moov" not in head:
                    # mp4.py moves the index to the front; if it is still not
                    # there, the browser will stall hunting for it.
                    notes.append("index not at the front; playback will stall")
            if library.thumb(clip.id) is None:
                notes.append("no thumbnail yet")

        size = f"{clip.size / 1e9:.2f} GB"
        shape = f"{clip.width}x{clip.height}" if clip.width else "?"
        length = f"{clip.duration / 60:.0f} min" if clip.duration else "?"
        # Only the first two count as failures; a missing thumbnail is
        # cosmetic and the background worker builds it on the next run.
        fatal = [note for note in notes if note != "no thumbnail yet"]
        problems += bool(fatal)
        mark = "FAIL" if fatal else "ok  "
        print(f"  {mark} {shape:>10} {length:>7} {size:>9}  {clip.title[:46]}")
        for note in notes:
            print(f"         - {note}")

    playable = len(clips) - problems
    print(f"\n{playable} of {len(clips)} clip(s) ready to play")
    return 1 if problems else 0


def open_library(args: argparse.Namespace) -> tuple[VideoLibrary, Path]:
    """The folder to browse, or the one-clip folder ``--video`` implies."""
    if args.video is not None:
        one = Path(args.video).expanduser().resolve()
        if not one.is_file():
            raise SystemExit(f"video not found: {one}")
        cache = Path(args.thumbs).expanduser()
        return VideoLibrary(one.parent, cache, only=one.name), one.parent

    folder = Path(args.videos).expanduser().resolve()
    if not folder.is_dir():
        raise SystemExit(
            f"no video folder at {folder}\n"
            f"Put equirectangular clips there, or pass --videos <folder>."
        )
    return VideoLibrary(folder, Path(args.thumbs).expanduser()), folder


def run(args: argparse.Namespace) -> int:
    validate(args)
    if args.self_test:
        return self_test(args)
    if args.check:
        return check_library(args)

    library, folder = open_library(args)

    controller = GazeController(
        ControlConfig(
            deadzone_yaw=args.deadzone_yaw,
            deadzone_pitch=args.deadzone_pitch,
            rate_yaw=args.rate_yaw,
            rate_pitch=args.rate_pitch,
            max_rate_yaw=args.max_rate_yaw,
            max_rate_pitch=args.max_rate_pitch,
            onset=args.onset,
            expo=args.expo,
            tau=args.tau,
            min_confidence=args.min_confidence,
            calibration_hold=args.calibration_hold,
            calibration_tolerance=args.calibration_tolerance,
            invert_yaw=args.invert_yaw,
            invert_pitch=args.invert_pitch,
        )
    )
    state = SharedState(controller)

    print("loading the gaze bundle ...")
    tracker = GazeTracker(
        models_dir=args.models_dir,
        camera_index=args.camera,
        width=args.width,
        height=args.height,
        camera_fps=args.camera_fps,
        backend=args.backend,
        mjpeg=args.mjpeg,
        detector_width=args.detector_width,
        focal_scale=args.focal_scale,
        threads=args.threads,
        preview_width=args.preview_width,
    )

    def on_reading(reading) -> None:
        output = controller.update(reading.sample)
        state.publish(
            output,
            controller.calibration_progress,
            controller.generation,
            tracker.gaze_rate.rate,
            reading.latency_ms,
            reading.eye_visibility,
            controller.resets,
        )

    tracker.on_reading = on_reading
    tracker.on_preview = state.set_preview

    server = GazeServer(
        (args.host, args.port),
        state,
        DEFAULT_WEB,
        library,
        {
            "recenter": lambda payload: controller.recalibrate(),
            # The page measures the viewport it is filling; the gearing
            # between the axes follows it.
            "screen": lambda payload: controller.set_aspect(payload.get("aspect")),
        },
    )

    tracker.start()
    width, height, fps, codec = tracker.settings
    print(f"camera {args.camera}: {width}x{height} @ {fps:.1f} FPS, codec={codec!r}")

    clips = library.scan()
    gigabytes = sum(clip.size for clip in clips) / 1e9
    print(f"library: {len(clips)} clip(s) in {folder} ({gigabytes:.1f} GB)")
    if not clips:
        print("  the folder is empty; the start screen will say so")
    if not library.tools:
        print("  ffmpeg/ffprobe not on PATH: no thumbnails, no durations")
    library.start()

    url = f"http://{args.host}:{args.port}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"\n  open {url}\n")
    print("  pick a clip, hold still for the centring pass, then look left /")
    print("  right / up / down to pan.  C recalibrates, F fullscreen, space")
    print("  pauses, M switches between recentring and joystick, Esc goes back")
    print("  to the library.  Ctrl+C here to quit.\n")
    if args.open_browser:
        webbrowser.open(url)

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nstopping ...")
    finally:
        library.stop()
        server.shutdown()
        server.server_close()
        tracker.stop()
    return 0


def main() -> int:
    return run(make_parser().parse_args())


if __name__ == "__main__":
    sys.exit(main())
