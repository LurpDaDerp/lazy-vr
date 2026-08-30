"""LazyVR's server: the page, the search API, and a stream proxy.

    python server/app.py                 # http://127.0.0.1:8360/
    python server/app.py --host 0.0.0.0  # what the Dockerfile runs

Three jobs, nothing else:

* Serve ``site/`` -- the page itself is still plain static files.
* Answer ``/api/home`` and ``/api/search`` from youtube's 360-filtered
  search, through yt-dlp, cached hard so browsing does not hammer youtube.
* Proxy ``/media/<id>/<video|audio>`` byte ranges from the resolved
  googlevideo URLs.  The URLs are signed and bound to this machine's IP and
  carry no CORS headers, so the browser cannot fetch them itself -- and the
  page needs the video as a WebGL texture, which is exactly the fetch CORS
  guards.  Same-origin proxying settles both at once.  It also means every
  video byte flows through this process: host it somewhere with bandwidth.

No ad system exists in this path: the page plays the raw stream.
"""

from __future__ import annotations

import argparse
import asyncio
import mimetypes
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
KNOWN_CODECS = ("vp9", "av01", "avc1")

HOME_LIMIT = 12
SEARCH_LIMIT = 24
CATEGORY_TTL = 6 * 3600
SEARCH_TTL = 15 * 60
INFO_TTL = 30 * 60
URL_MARGIN = 5 * 60  # stop trusting a signed URL this long before it expires

# Windows can misreport these from the registry; the page depends on them.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")
mimetypes.add_type("application/octet-stream", ".onnx")

CACHE = source.TTLCache()
LOCKS: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


async def cached(key: str, producer, ttl: float):
    """One blocking producer call per key per TTL, however many ask."""
    value = CACHE.get(key)
    if value is not None:
        return value
    async with LOCKS[key]:
        value = CACHE.get(key)
        if value is None:
            value = await asyncio.to_thread(producer)
            CACHE.put(key, value, ttl)
    return value


def clean_error(error: Exception) -> str:
    """yt-dlp's messages, without its log prefixes."""
    text = re.sub(r"^ERROR:\s*", "", str(error))
    return re.sub(r"\[[\w:]+\]\s*[\w-]*:?\s*", "", text).strip() or "unavailable"


# ---------------------------------------------------------------- search

async def api_home(request: web.Request) -> web.Response:
    async def shelf(category: dict) -> dict:
        try:
            clips = await cached(f"cat:{category['id']}",
                                 lambda q=category["query"]: source.search_360(q, HOME_LIMIT),
                                 CATEGORY_TTL)
            return {"id": category["id"], "title": category["title"], "clips": clips}
        except Exception as error:  # one dead shelf must not empty the page
            return {"id": category["id"], "title": category["title"], "clips": [],
                    "error": clean_error(error)}

    shelves = await asyncio.gather(*(shelf(c) for c in source.CATEGORIES))
    return web.json_response({"categories": list(shelves)})


async def api_search(request: web.Request) -> web.Response:
    query = " ".join((request.query.get("q") or "").split())[:100]
    if not query:
        raise web.HTTPBadRequest(reason="q is required")
    try:
        clips = await cached(f"q:{query.lower()}",
                             lambda: source.search_360(query, SEARCH_LIMIT),
                             SEARCH_TTL)
    except Exception as error:
        return web.json_response({"error": clean_error(error)}, status=502)
    return web.json_response({"query": query, "clips": clips})


# ---------------------------------------------------------------- streams

def stream_prefs(request: web.Request) -> tuple[tuple[str, ...], int]:
    """What this browser said it can decode, in its preference order."""
    asked = [c for c in (request.query.get("codecs") or "").split(",") if c in KNOWN_CODECS]
    codecs = tuple(asked) or KNOWN_CODECS
    try:
        max_height = max(144, min(4320, int(request.query.get("max", "4320"))))
    except ValueError:
        max_height = 4320
    return codecs, max_height


def checked_id(request: web.Request) -> str:
    vid = request.match_info["vid"]
    if not VIDEO_ID.match(vid):
        raise web.HTTPBadRequest(reason="not a video id")
    return vid


async def picked_for(vid: str, codecs: tuple[str, ...], max_height: int, force: bool = False) -> dict:
    """Resolve and choose streams, remembering the signed URLs for the proxy."""
    key = f"pick:{vid}:{','.join(codecs)}:{max_height}"
    if force:
        CACHE.drop(key)
        CACHE.drop(f"info:{vid}")
    picked = CACHE.get(key)
    if picked is not None:
        return picked
    info = await cached(f"info:{vid}", lambda: source.resolve(vid), INFO_TTL)
    prefer_mp4a = "vp9" not in codecs  # no vp9 means no webm, so no opus either
    picked = source.pick_streams(info, max_height, codecs, prefer_mp4a)
    picked = {
        "title": info.get("title"),
        "duration": info.get("duration"),
        "combined": picked["combined"],
        "video": picked["video"],
        "audio": picked["audio"],
    }
    expires = [source.stream_expiry(picked["video"]["url"])]
    if picked["audio"]:
        expires.append(source.stream_expiry(picked["audio"]["url"]))
    ttl = max(60.0, min(expires) - time.time() - URL_MARGIN)
    CACHE.put(key, picked, ttl)
    return picked


def track_json(vid: str, kind: str, fmt: dict, codecs: tuple[str, ...], max_height: int) -> dict:
    query = f"codecs={','.join(codecs)}&max={max_height}"
    return {
        "src": f"/media/{vid}/{kind}?{query}",
        "height": fmt.get("height"),
        "width": fmt.get("width"),
        "fps": fmt.get("fps"),
        "codec": source.codec_family(fmt["vcodec"]) if kind == "video" else fmt.get("acodec"),
        "ext": fmt.get("ext"),
    }


async def api_streams(request: web.Request) -> web.Response:
    vid = checked_id(request)
    codecs, max_height = stream_prefs(request)
    try:
        picked = await picked_for(vid, codecs, max_height)
    except LookupError as error:
        return web.json_response({"error": str(error)}, status=415)
    except Exception as error:
        return web.json_response({"error": clean_error(error)}, status=502)
    return web.json_response({
        "id": vid,
        "title": picked["title"],
        "duration": picked["duration"],
        "combined": picked["combined"],
        "video": track_json(vid, "video", picked["video"], codecs, max_height),
        "audio": track_json(vid, "audio", picked["audio"], codecs, max_height) if picked["audio"] else None,
    })


# ---------------------------------------------------------------- proxy

COPY_HEADERS = ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")


async def media(request: web.Request) -> web.StreamResponse:
    vid = checked_id(request)
    kind = request.match_info["kind"]
    if kind not in ("video", "audio"):
        raise web.HTTPNotFound()
    codecs, max_height = stream_prefs(request)

    headers = {}
    if "Range" in request.headers:
        headers["Range"] = request.headers["Range"]

    session: ClientSession = request.app["session"]
    for attempt in (1, 2):
        try:
            picked = await picked_for(vid, codecs, max_height, force=attempt > 1)
        except Exception as error:
            raise web.HTTPBadGateway(reason=clean_error(error))
        fmt = picked.get(kind)
        if not fmt:
            raise web.HTTPNotFound(reason=f"this clip has no separate {kind} track")
        async with session.get(fmt["url"], headers=headers) as upstream:
            # A signed URL that has gone stale answers 403; resolve afresh once.
            if upstream.status in (403, 410) and attempt == 1:
                continue
            response = web.StreamResponse(status=upstream.status)
            for name in COPY_HEADERS:
                if name in upstream.headers:
                    response.headers[name] = upstream.headers[name]
            response.headers.setdefault("Accept-Ranges", "bytes")
            response.headers["Cache-Control"] = "no-store"
            await response.prepare(request)
            try:
                async for chunk in upstream.content.iter_chunked(1 << 16):
                    await response.write(chunk)
            except (ConnectionResetError, asyncio.CancelledError):
                pass  # the <video> element seeks by dropping connections
            await response.write_eof()
            return response
    raise web.HTTPBadGateway(reason="youtube keeps refusing the stream")


# ---------------------------------------------------------------- wiring

async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(SITE / "index.html")


def tailscale_ipv4() -> str:
    """This machine's Tailscale IPv4, from the tailscale CLI."""
    import subprocess
    try:
        result = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        raise SystemExit("could not ask tailscale for an IP -- is Tailscale installed and up?")
    for line in result.stdout.decode(errors="replace").splitlines():
        if line.strip():
            return line.strip()
    raise SystemExit("tailscale reported no IPv4 address")


async def client_session(app: web.Application):
    app["session"] = ClientSession(timeout=ClientTimeout(total=None, connect=20, sock_read=45))
    yield
    await app["session"].close()


def build_app() -> web.Application:
    app = web.Application()
    app.cleanup_ctx.append(client_session)
    app.router.add_get("/", index)
    app.router.add_get("/api/home", api_home)
    app.router.add_get("/api/search", api_search)
    app.router.add_get("/api/streams/{vid}", api_streams)
    app.router.add_get("/media/{vid}/{kind}", media)
    app.router.add_static("/", SITE, show_index=False)
    return app


def main() -> int:
    parser = argparse.ArgumentParser(description="run the LazyVR server")
    parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to serve beyond this machine")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8360")),
                        help="port to listen on (default: $PORT if a platform sets it, else 8360)")
    parser.add_argument("--tailscale", action="store_true",
                        help="also bind this machine's Tailscale IP, so devices on the "
                             "tailnet can open the site; the LAN stays closed")
    args = parser.parse_args()
    hosts = [args.host]
    if args.tailscale and args.host != "0.0.0.0":
        address = tailscale_ipv4()
        if address not in hosts:
            hosts.append(address)
    print("LazyVR on:")
    for host in hosts:
        print(f"  http://{host}:{args.port}/")
    if len(hosts) > 1 or args.host == "0.0.0.0":
        print("note: browsers only give the CAMERA to a secure page, so on a remote")
        print("      device an http:// address browses but cannot start gaze steering.")
        print(f"      For that, publish it with TLS:  tailscale serve --bg {args.port}")
    web.run_app(build_app(), host=hosts if len(hosts) > 1 else hosts[0], port=args.port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
