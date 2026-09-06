"""LazyVR's server: the page and the search API.

    python server/app.py                 # http://127.0.0.1:8360/
    python server/app.py --host 0.0.0.0  # what the Dockerfile runs

Two jobs, nothing else:

* Serve ``site/`` -- the page itself is still plain static files.
* Answer ``/api/home`` and ``/api/search`` from youtube's 360-filtered
  search, through yt-dlp, cached hard so browsing does not hammer youtube.

Video bytes are not this server's business.  A youtube clip plays in
youtube's own embedded player, straight from the browser, and a local file
never leaves the device -- so nothing a viewer watches flows through this
process, and there is no signed-url dance to keep alive.
"""

from __future__ import annotations

import argparse
import asyncio
import mimetypes
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

HOME_LIMIT = 12
SEARCH_LIMIT = 24
CATEGORY_TTL = 6 * 3600
SEARCH_TTL = 15 * 60

# Windows can misreport these from the registry; the page depends on them.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")
mimetypes.add_type("application/octet-stream", ".onnx")
mimetypes.add_type("font/woff2", ".woff2")

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


@web.middleware
async def cache_headers(request: web.Request, handler):
    """aiohttp's static route sends ETag and Last-Modified but no Cache-Control,
    so browsers guess.  Models and fonts change only with a deploy; the page's
    own files revalidate after five minutes.  The API sets its own headers."""
    response = await handler(request)
    path = request.path
    if (request.method == "GET" and not path.startswith("/api/")
            and "Cache-Control" not in response.headers):
        response.headers["Cache-Control"] = (
            "public, max-age=86400, stale-while-revalidate=604800"
            if path.startswith(("/models/", "/fonts/"))
            else "public, max-age=300, must-revalidate")
    return response


def build_app() -> web.Application:
    app = web.Application(middlewares=[cache_headers])
    app.router.add_get("/", index)
    app.router.add_get("/api/home", api_home)
    app.router.add_get("/api/search", api_search)
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
