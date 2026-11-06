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
import sys
from pathlib import Path

from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"

# The limits, the TTLs and the cache headers live in source.py, shared with
# api/index.py, so the Vercel deployment cannot quietly answer differently
# from the one that gets developed against.

# Windows can misreport these from the registry; the page depends on them.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")
mimetypes.add_type("font/woff2", ".woff2")

CACHE = source.TTLCache()


class KeyedLocks:
    """asyncio twin of source.KeyedLocks: a lock per key that exists only
    while someone holds or waits on it, so unique search keys cannot grow
    the table without bound."""

    def __init__(self):
        self._locks: dict[str, list] = {}  # key -> [asyncio.Lock, users]

    def __len__(self):
        return len(self._locks)

    async def acquire(self, key):
        entry = self._locks.get(key)
        if entry is None:
            entry = self._locks[key] = [asyncio.Lock(), 0]
        entry[1] += 1
        try:
            await entry[0].acquire()
        except BaseException:  # cancelled while waiting
            self._forget(key, entry)
            raise
        return entry

    def release(self, key, entry):
        entry[0].release()
        self._forget(key, entry)

    def _forget(self, key, entry):
        entry[1] -= 1
        if entry[1] == 0 and self._locks.get(key) is entry:
            del self._locks[key]


LOCKS = KeyedLocks()


async def cached(key: str, producer, ttl: float):
    """One blocking producer call per key per TTL, however many ask."""
    value = CACHE.get(key)
    if value is not None:
        return value
    entry = await LOCKS.acquire(key)
    try:
        value = CACHE.get(key)
        if value is None:
            value = await asyncio.to_thread(producer)
            CACHE.put(key, value, source.cache_ttl(value, ttl))
    finally:
        LOCKS.release(key, entry)
    return value


def api_json(obj, status: int = 200, cache: str = source.NO_STORE) -> web.Response:
    """Every API answer, shaped and headed the way the Vercel function's are.
    Errors are JSON with an ``error`` key: the page shows ``data.error``."""
    return web.json_response(obj, status=status, headers={"Cache-Control": cache})


# ---------------------------------------------------------------- search

async def api_home(request: web.Request) -> web.Response:
    async def shelf(category: dict) -> dict:
        try:
            clips = await cached(f"cat:{category['id']}",
                                 lambda q=category["query"]: source.search_360(q, source.HOME_LIMIT),
                                 source.CATEGORY_TTL)
            return {"id": category["id"], "title": category["title"], "clips": clips}
        except Exception as error:  # one dead shelf must not empty the page
            return {"id": category["id"], "title": category["title"], "clips": [],
                    "error": source.clean_error(error)}

    shelves = list(await asyncio.gather(*(shelf(c) for c in source.CATEGORIES)))
    return api_json({"categories": shelves}, cache=source.home_cache(shelves))


async def api_search(request: web.Request) -> web.Response:
    query = " ".join((request.query.get("q") or "").split())[:100]
    if not query:
        return api_json({"error": "q is required"}, status=400)
    try:
        clips = await cached(f"q:{query.lower()}",
                             lambda: source.search_360(query, source.SEARCH_LIMIT),
                             source.SEARCH_TTL)
    except Exception as error:
        return api_json({"error": source.clean_error(error)}, status=502)
    return api_json({"query": query, "clips": clips}, cache=source.search_cache(clips))


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
    """The static files' Cache-Control, the same rule vercel.json gives the
    CDN (source.static_cache).  API handlers set their own."""
    response = await handler(request)
    if (request.method in ("GET", "HEAD") and not request.path.startswith("/api/")
            and "Cache-Control" not in response.headers):
        response.headers["Cache-Control"] = source.static_cache(request.path)
    return response


@web.middleware
async def security_headers(request: web.Request, handler):
    """vercel.json's security headers, for parity.  Never COOP/COEP (they break
    the YouTube iframe) and never a no-referrer policy (YouTube error 153)."""
    try:
        response = await handler(request)
    except web.HTTPException as error:
        response = error
        _secure(response)
        raise
    _secure(response)
    return response


def _secure(response):
    for name, value in source.SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)


def build_app() -> web.Application:
    app = web.Application(middlewares=[security_headers, cache_headers])
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
        print("      device an http:// address browses but cannot start head tracking.")
        print(f"      For that, publish it with TLS:  tailscale serve --bg {args.port}")
    web.run_app(build_app(), host=hosts if len(hosts) > 1 else hosts[0], port=args.port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
