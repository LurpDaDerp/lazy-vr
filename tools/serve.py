"""A local preview of the site, for development only.

    python tools/serve.py            # http://127.0.0.1:8360/

Serves ``site/`` and maps ``/videos/`` onto the repository's clip folder, so
a preview works without copying hundreds of gigabytes into the site.  The
deployed site needs none of this: it is static files on any host.

Python's stock static server does not honour Range requests, and a browser
cannot seek -- or, for a file with a trailing index, even start -- without
them.  This one does.  Nothing else is added; it is not a production server.
"""

from __future__ import annotations

import argparse
import mimetypes
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
VIDEOS = ROOT / "videos"
BLOCK = 256 * 1024
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")
mimetypes.add_type("application/octet-stream", ".onnx")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("video/webm", ".webm")


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE), **kwargs)

    def log_message(self, format, *args):  # noqa: A002 - the base class's name
        return

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/videos/"):
            candidate = (VIDEOS / self.unquote(clean[len("/videos/"):])).resolve()
            if VIDEOS.resolve() in candidate.parents or candidate == VIDEOS.resolve():
                return str(candidate)
        return super().translate_path(path)

    @staticmethod
    def unquote(text):
        from urllib.parse import unquote
        return unquote(text)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = Path(self.translate_path(self.path))
        header = self.headers.get("Range")
        if not header or not path.is_file():
            return super().do_GET()
        size = path.stat().st_size
        match = _RANGE.match(header.strip())
        if not match:
            return super().do_GET()
        first, last = match.group(1), match.group(2)
        if not first and not last:
            return super().do_GET()
        if not first:
            start, end = max(0, size - int(last)), size - 1
        else:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1
        if start >= size or end < start:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        try:
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    piece = handle.read(min(BLOCK, remaining))
                    if not piece:
                        break
                    self.wfile.write(piece)
                    remaining -= len(piece)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass


def main() -> int:
    parser = argparse.ArgumentParser(description="preview the site locally")
    parser.add_argument("--port", type=int, default=8360)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"serving {SITE} on http://{args.host}:{args.port}/  (videos from {VIDEOS})")
    print("Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
