"""LazyVR on Vercel: one serverless function for search and the page.

Vercel has no long-lived process, so this adapts server/app.py's jobs to a
function's constraints:

* The TTL cache lives in module globals -- a warm instance keeps its
  shelves, a cold start fetches them again.
* Shelves are fetched with a small thread pool to fit the time budget.

Video never comes through here: a youtube clip plays in youtube's own
embedded player, straight from the visitor's browser, and a local file
never leaves the device.  A function that cannot hold a socket open is a
bad place to move media anyway, which is what this used to try.

Any path that is not /api is served from ../site, so the app is whole on
its own: the platform may serve the static files itself (in which case
those requests never arrive here), or route everything through this
service -- both work.
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")
mimetypes.add_type("application/octet-stream", ".onnx")
mimetypes.add_type("font/woff2", ".woff2")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import source  # noqa: E402

HOME_LIMIT = 8
SEARCH_LIMIT = 24
CATEGORY_TTL = 6 * 3600
SEARCH_TTL = 15 * 60

CACHE = source.TTLCache()


def cached(key, producer, ttl):
    value = CACHE.get(key)
    if value is None:
        value = producer()
        CACHE.put(key, value, ttl)
    return value


# ---------------------------------------------------------------- handlers

def api_home():
    def shelf(category):
        try:
            clips = cached(f"cat:{category['id']}",
                           lambda: source.search_360(category["query"], HOME_LIMIT), CATEGORY_TTL)
            return {"id": category["id"], "title": category["title"], "clips": clips}
        except Exception as error:
            return {"id": category["id"], "title": category["title"], "clips": [],
                    "error": str(error)[:200]}
    with ThreadPoolExecutor(max_workers=4) as pool:
        shelves = list(pool.map(shelf, source.CATEGORIES))
    return 200, {"categories": shelves}


def api_search(params):
    query = " ".join((params.get("q", [""])[0]).split())[:100]
    if not query:
        return 400, {"error": "q is required"}
    try:
        clips = cached(f"q:{query.lower()}", lambda: source.search_360(query, SEARCH_LIMIT), SEARCH_TTL)
    except Exception as error:
        return 502, {"error": str(error)[:200]}
    return 200, {"query": query, "clips": clips}


SITE = Path(__file__).resolve().parents[1] / "site"


def static(environ, start_response):
    """The page itself, for a platform that routes everything here."""
    name = (environ.get("PATH_INFO", "/") or "/").lstrip("/") or "index.html"
    target = (SITE / name).resolve()
    if not str(target).startswith(str(SITE)) or not target.is_file():
        return json_response(start_response, 404, {"error": "not found"})
    # Cacheable: the models are seven megabytes and the page a few hundred
    # kilobytes, and without these headers every visit re-fetched all of it
    # through a function invocation.  Models and fonts change only with a
    # deploy, which changes their mtime and so their ETag; the page's own
    # files revalidate after five minutes.
    stat = target.stat()
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    cache = ("public, max-age=86400, stale-while-revalidate=604800"
             if target.parent.name in ("models", "fonts")
             else "public, max-age=300, must-revalidate")
    if environ.get("HTTP_IF_NONE_MATCH") == etag:
        start_response("304 Not Modified", [("ETag", etag), ("Cache-Control", cache)])
        return [b""]
    body = target.read_bytes()
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    start_response("200 OK", [("Content-Type", content_type),
                              ("Content-Length", str(len(body))),
                              ("ETag", etag), ("Cache-Control", cache)])
    return [body]


# ---------------------------------------------------------------- wsgi

def json_response(start_response, status, obj):
    body = json.dumps(obj).encode()
    reasons = {200: "OK", 400: "Bad Request", 404: "Not Found", 502: "Bad Gateway"}
    start_response(f"{status} {reasons.get(status, 'Error')}",
                   [("Content-Type", "application/json"), ("Cache-Control", "no-store"),
                    ("Content-Length", str(len(body)))])
    return [body]


def route_of(environ, params):
    """The original path: the rewrite carries it in ?vkind/vpath, and a
    direct hit (local testing) falls back to PATH_INFO."""
    vkind = params.get("vkind", [None])[0]
    vpath = params.get("vpath", [""])[0]
    if vkind:
        return vkind, [p for p in vpath.split("/") if p]
    parts = [p for p in environ.get("PATH_INFO", "").split("/") if p]
    if parts and parts[0] == "api":
        return parts[0], parts[1:]
    return "", []


def app(environ, start_response):
    params = parse_qs(environ.get("QUERY_STRING", ""))
    kind, parts = route_of(environ, params)
    try:
        if kind == "api" and parts == ["home"]:
            status, obj = api_home()
        elif kind == "api" and parts == ["search"]:
            status, obj = api_search(params)
        elif kind == "":
            return static(environ, start_response)
        else:
            status, obj = 404, {"error": "no such endpoint"}
    except Exception as error:  # a JSON error beats a platform 500 page
        status, obj = 500, {"error": str(error)[:200]}
    return json_response(start_response, status, obj)
