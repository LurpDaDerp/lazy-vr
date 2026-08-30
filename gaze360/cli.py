"""Command line: wire the tracker to the control law to the HTTP server."""

from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser
from pathlib import Path

from .control import ControlConfig, GazeController
from .server import GazeServer, SharedState
from .tracker import GazeTracker, MODEL_STEM, load_bundle, run_parity

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODELS = ROOT / "models"
DEFAULT_WEB = ROOT / "web"
DEFAULT_VIDEO = ROOT.parent / "gaze-demo" / "testvid.mp4"


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gaze360",
        description="Steer a 360 video with your gaze.",
    )
    video = parser.add_argument_group("video")
    video.add_argument("--video", type=Path, default=DEFAULT_VIDEO,
                       help="equirectangular mp4 to play (default: the gaze-demo test clip)")
    video.add_argument("--port", type=int, default=8360)
    video.add_argument("--host", default="127.0.0.1")
    video.add_argument("--no-browser", dest="open_browser", action="store_false",
                       help="do not open a browser tab on start")

    control = parser.add_argument_group("control")
    control.add_argument("--gain-yaw", type=float, default=4.0,
                         help="degrees of view per degree of gaze, left/right (default: 4)")
    control.add_argument("--gain-pitch", type=float, default=7.0,
                         help="degrees of view per degree of gaze, up/down (default: 7)")
    control.add_argument("--deadzone-yaw", type=float, default=2.0,
                         help="gaze error that commands no motion, left/right (default: 2)")
    control.add_argument("--deadzone-pitch", type=float, default=1.0,
                         help="gaze error that commands no motion, up/down (default: 1)")
    control.add_argument("--max-yaw", type=float, default=180.0,
                         help="furthest the view may turn left/right (default: 180)")
    control.add_argument("--max-pitch", type=float, default=85.0,
                         help="furthest the view may look up/down (default: 85)")
    control.add_argument("--smooth-time", type=float, default=0.13,
                         help="seconds the view takes to reach a new target (default: 0.13)")
    control.add_argument("--expo", type=float, default=1.0,
                         help="response curve exponent; 1 is proportional (default: 1)")
    control.add_argument("--tau", type=float, default=0.03,
                         help="gaze smoothing time constant in seconds (default: 0.03)")
    control.add_argument("--min-confidence", type=float, default=0.5,
                         help="in-frame landmark fraction below which the view freezes")
    control.add_argument("--calibration-samples", type=int, default=45)
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
    return parser


def validate(args: argparse.Namespace) -> None:
    if args.deadzone_yaw < 0 or args.deadzone_pitch < 0:
        raise SystemExit("deadzones must not be negative")
    if args.gain_yaw <= 0 or args.gain_pitch <= 0:
        raise SystemExit("gains must be positive")
    if args.max_yaw <= 0 or args.max_pitch <= 0:
        raise SystemExit("view limits must be positive")
    if args.smooth_time < 0:
        raise SystemExit("--smooth-time must not be negative")
    if args.expo <= 0:
        raise SystemExit("--expo must be positive")
    if args.tau < 0:
        raise SystemExit("--tau must not be negative")
    if args.calibration_samples < 1:
        raise SystemExit("--calibration-samples must be at least 1")
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


def run(args: argparse.Namespace) -> int:
    validate(args)
    if args.self_test:
        return self_test(args)

    video = Path(args.video).expanduser().resolve()
    if not video.is_file():
        raise SystemExit(f"video not found: {video}\nPass --video <path to a 360 mp4>")

    controller = GazeController(
        ControlConfig(
            gain_yaw=args.gain_yaw,
            gain_pitch=args.gain_pitch,
            deadzone_yaw=args.deadzone_yaw,
            deadzone_pitch=args.deadzone_pitch,
            max_yaw=args.max_yaw,
            max_pitch=args.max_pitch,
            expo=args.expo,
            tau=args.tau,
            min_confidence=args.min_confidence,
            calibration_samples=args.calibration_samples,
            invert_yaw=args.invert_yaw,
            invert_pitch=args.invert_pitch,
        )
    )
    state = SharedState(controller.config, args.smooth_time)

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
        )

    tracker.on_reading = on_reading
    tracker.on_preview = state.set_preview

    server = GazeServer(
        (args.host, args.port),
        state,
        DEFAULT_WEB,
        video,
        {"recenter": controller.recalibrate},
    )

    tracker.start()
    width, height, fps, codec = tracker.settings
    print(f"camera {args.camera}: {width}x{height} @ {fps:.1f} FPS, codec={codec!r}")
    layout = (
        "index moved to the front for streaming"
        if server.source.rearranged
        else "already streamable"
    )
    print(f"video: {video.name} ({video.stat().st_size / 1e9:.2f} GB, {layout})")

    url = f"http://{args.host}:{args.port}/"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"\n  open {url}\n")
    print("  look left / right / up / down to pan.  C recalibrates, F fullscreen,")
    print("  space pauses.  Ctrl+C here to quit.\n")
    if args.open_browser:
        webbrowser.open(url)

    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nstopping ...")
    finally:
        server.shutdown()
        server.server_close()
        tracker.stop()
    return 0


def main() -> int:
    return run(make_parser().parse_args())


if __name__ == "__main__":
    sys.exit(main())
