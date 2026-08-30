"""Static files, the video, the gaze stream and the webcam preview.

All of it on ``http.server``.  Server-Sent Events carry the control packets and
a ``multipart/x-mixed-replace`` endpoint carries the preview, which together
replace a hand-rolled RFC 6455 WebSocket server -- same latency on localhost,
no handshake or frame masking to get wrong, and still no pip dependency beyond
what the gaze pipeline already needs.
"""

from __future__ import annotations

import json
import mimetypes
import sys
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

from .control import ControlOutput
from .library import VideoLibrary


# How long a reading may go unrefreshed before the HUD calls it stalled.
STALE_AFTER = 0.4
GAZE_HZ = 50.0
PREVIEW_HZ = 12.0
BLOCK = 256 * 1024
DROPPED = (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)

_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
# Ids are made by gaze360.library.slug, so anything else is not worth looking
# up -- and refusing them here keeps a path separator out of a lookup key.
_ID = re.compile(r"^[a-z0-9-]{1,80}$")


def route_id(route: str, prefix: str) -> str | None:
    """The clip id in ``/video/<id>``, or None if it could not be one."""
    identifier = unquote(route[len(prefix):])
    return identifier if _ID.match(identifier) else None


class RangeNotSatisfiable(Exception):
    """The client asked for bytes that do not exist; answer 416."""


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Resolve a ``Range`` header to inclusive ``(start, end)`` byte offsets.

    Returns ``None`` when the header is absent or cannot be honoured, which
    means "send the whole body with a plain 200".  Raises
    ``RangeNotSatisfiable`` when the client named a range this file cannot
    supply.  ``SimpleHTTPRequestHandler`` implements none of this, and a 2 GB
    video needs it both to start playing and to seek.
    """
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if match is None:
        # An unsupported unit or a multi-range request: decline, do not fail.
        return None
    first, last = match.group(1), match.group(2)
    if not first and not last:
        return None

    if not first:
        # Suffix form: the final N bytes.
        length = int(last)
        if length == 0 or size == 0:
            raise RangeNotSatisfiable(header)
        return (max(0, size - length), size - 1)

    start = int(first)
    if start >= size:
        raise RangeNotSatisfiable(header)
    if not last:
        return (start, size - 1)
    end = int(last)
    if end < start:
        # Backwards range: malformed, so ignore the header entirely.
        return None
    return (start, min(end, size - 1))


@dataclass
class GazePacket:
    """What the browser needs each tick."""

    # Degrees per second the viewer is asking for.  Not an angle: the browser
    # owns where the view actually points, because the body that carries this
    # out has to be simulated at display rate.
    yaw_rate: float = 0.0
    pitch_rate: float = 0.0
    state: str = "starting"
    committed: bool = False
    yaw_error: float = 0.0
    pitch_error: float = 0.0
    confidence: float = 0.0
    calibration: float = 0.0
    # How many times the viewer has looked away mid-pass, so the page can say
    # so instead of showing a bar that quietly went backwards.
    calibration_resets: int = 0
    generation: int = 0
    deadzone_yaw: float = 2.0
    deadzone_pitch: float = 1.0
    span_yaw: float = 12.0
    span_pitch: float = 12.0
    max_rate_yaw: float = 120.0
    max_rate_pitch: float = 90.0
    # The screen shape the gearing is currently derived from, echoed back so
    # the page can see its own report was understood.
    aspect: float = 16.0 / 9.0
    gaze_fps: float = 0.0
    latency_ms: float = 0.0
    eye_visibility: tuple[float, float] = (1.0, 1.0)


class SharedState:
    """The handoff between the tracker thread and every HTTP responder."""

    def __init__(self, geometry) -> None:
        """``geometry`` is the controller.

        Its limits are read afresh on every packet rather than copied once,
        because the gearing between the axes follows the shape of the screen
        and the page can change that at any moment by resizing.
        """
        self._lock = threading.Lock()
        self._geometry = geometry
        self._packet = GazePacket(**geometry.limits)
        self._updated = 0.0
        self._preview: bytes | None = None

    def publish(
        self,
        output: ControlOutput,
        calibration: float,
        generation: int,
        gaze_fps: float,
        latency_ms: float,
        eye_visibility: tuple[float, float],
        calibration_resets: int = 0,
    ) -> None:
        with self._lock:
            self._packet = GazePacket(
                yaw_rate=output.yaw_rate,
                pitch_rate=output.pitch_rate,
                state=output.state,
                committed=output.committed,
                calibration_resets=calibration_resets,
                yaw_error=output.yaw_error,
                pitch_error=output.pitch_error,
                confidence=output.confidence,
                calibration=calibration,
                generation=generation,
                gaze_fps=gaze_fps,
                latency_ms=latency_ms,
                eye_visibility=eye_visibility,
                **self._geometry.limits,
            )
            self._updated = time.monotonic()

    def set_preview(self, jpeg: bytes) -> None:
        with self._lock:
            self._preview = jpeg

    @property
    def preview(self) -> bytes | None:
        with self._lock:
            return self._preview

    def snapshot(self) -> dict:
        with self._lock:
            packet = self._packet
            age = time.monotonic() - self._updated if self._updated else None
        data = asdict(packet)
        if age is not None and age > STALE_AFTER:
            # A rate is not safe to hold.  An angle could be repeated forever
            # and the view would simply sit there, but a turn speed repeated
            # forever spins the viewer round and round, so a tracker that has
            # gone quiet has to be read as "stop", not as "carry on".
            data["state"] = "stalled"
            data["yaw_rate"] = 0.0
            data["pitch_rate"] = 0.0
        return data


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LazyVR"

    # Silence the per-request access log; SSE and MJPEG would flood it.
    def log_message(self, format: str, *args) -> None:
        return

    def log_error(self, format: str, *args) -> None:
        return

    @property
    def state(self) -> SharedState:
        return self.server.state

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0]
        streaming = route in ("/gaze", "/preview.mjpg")
        try:
            if streaming and self.command == "HEAD":
                # An endless body has no meaningful HEAD; say so rather than
                # stream forever into a client that wants only headers.
                self.send_error(405)
            elif route == "/gaze":
                self._gaze_stream()
            elif route == "/library":
                self._json(self.server.library.describe())
            elif route.startswith("/video/"):
                self._video(route_id(route, "/video/"))
            elif route.startswith("/thumb/"):
                self._thumb(route_id(route, "/thumb/"))
            elif route == "/preview.mjpg":
                self._preview_stream()
            else:
                self._static(route)
        except DROPPED:
            pass

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/cmd":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
            action = str(payload.get("action", ""))
        except (ValueError, UnicodeDecodeError):
            self.send_error(400, "malformed command")
            return
        handler = self.server.commands.get(action)
        if handler is None:
            self.send_error(404, f"unknown action {action!r}")
            return
        # Every handler takes the whole payload; most ignore it, but the ones
        # that carry a value -- the screen shape, say -- need it.
        self._json({"ok": True, "action": action, "result": handler(payload)})

    # -- routes ---------------------------------------------------------

    def _static(self, route: str) -> None:
        name = "index.html" if route == "/" else route.lstrip("/")
        path = (self.server.web_root / name).resolve()
        if self.server.web_root not in path.parents or not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _thumb(self, identifier: str | None) -> None:
        path = self.server.library.thumb(identifier) if identifier else None
        if path is None:
            # Not an error: the worker has simply not reached this clip yet,
            # and the card is drawing a placeholder until it does.
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        # Named after the file's size and mtime, so it can be cached hard.
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _video(self, identifier: str | None) -> None:
        entry = self.server.library.entry(identifier) if identifier else None
        if entry is not None and not entry.settled:
            # Still downloading: it has no index yet and no end, so a player
            # handed it would stall rather than fail.  Say so instead.
            self.send_error(409, "still downloading")
            return
        source = self.server.library.source(identifier) if entry else None
        if entry is None or source is None:
            self.send_error(404, "no such clip")
            return
        size = source.size
        try:
            span = parse_range(self.headers.get("Range"), size)
        except RangeNotSatisfiable:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        start, end = span if span else (0, size - 1)
        length = end - start + 1
        self.send_response(206 if span else 200)
        self.send_header("Content-Type", entry.content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if span:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        for chunk in source.chunks(start, end, BLOCK):
            self.wfile.write(chunk)

    do_HEAD = do_GET

    def _gaze_stream(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        period = 1.0 / GAZE_HZ
        while not self.server.stopping.is_set():
            payload = json.dumps(self.state.snapshot(), separators=(",", ":"))
            self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
            self.wfile.flush()
            time.sleep(period)

    def _preview_stream(self) -> None:
        boundary = "gazeframe"
        self.send_response(200)
        self.send_header(
            "Content-Type", f"multipart/x-mixed-replace; boundary={boundary}"
        )
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        period = 1.0 / PREVIEW_HZ
        while not self.server.stopping.is_set():
            frame = self.state.preview
            if frame:
                head = (
                    f"--{boundary}\r\nContent-Type: image/jpeg\r\n"
                    f"Content-Length: {len(frame)}\r\n\r\n"
                ).encode("ascii")
                self.wfile.write(head)
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            time.sleep(period)

    def _json(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class GazeServer(ThreadingHTTPServer):
    daemon_threads = True
    # NOT on Windows.  There SO_REUSEADDR lets a second server bind a port that
    # is already being served, rather than only reclaiming one in TIME_WAIT as
    # it does on POSIX.  A leftover instance then keeps answering while the new
    # one appears to start cleanly, so edits and flags silently do nothing.
    # Better to fail the bind and say so.
    allow_reuse_address = sys.platform != "win32"

    def server_bind(self) -> None:
        try:
            super().server_bind()
        except OSError as error:
            host, port = self.server_address[:2]
            raise SystemExit(
                f"cannot listen on {host}:{port} — {error.strerror or error}.\n"
                f"Another gaze360 is probably still running; close it, or pass "
                f"--port to use a different one."
            ) from error

    def __init__(
        self,
        address: tuple[str, int],
        state: SharedState,
        web_root: Path,
        library: VideoLibrary,
        commands: dict[str, Callable[[dict], object]],
    ) -> None:
        super().__init__(address, Handler)
        self.state = state
        self.web_root = Path(web_root).resolve()
        self.library = library
        self.commands = commands
        self.stopping = threading.Event()

    def handle_error(self, request, client_address) -> None:
        """Swallow the ordinary disconnect.

        A browser drops connections constantly here -- every video seek
        abandons an in-flight range request, and the SSE and MJPEG streams end
        by being closed from the far side.  ``socketserver`` prints a full
        traceback for each one, below the handler's own try/except, which
        would bury the real output.  Anything else still gets reported.
        """
        if not isinstance(sys.exc_info()[1], DROPPED):
            super().handle_error(request, client_address)

    def shutdown(self) -> None:  # noqa: D102
        self.stopping.set()
        super().shutdown()
