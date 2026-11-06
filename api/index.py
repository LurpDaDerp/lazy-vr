"""LazyVR on Vercel: the search API as one WSGI function.

The page itself (site/) is served by Vercel's CDN (vercel.json
outputDirectory); only /api/* is rewritten here.  server/app.py is the same
API for local runs and containers; anything that shapes an answer lives in
server/source.py so the two cannot drift.

The TTL cache lives in module globals (a warm instance keeps it), requests
for the same key are single-flighted, and Cache-Control lets the edge hold
answers so a cold instance rarely has to search at all.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import source  # noqa: E402

CACHE = source.TTLCache()
LOCKS = source.KeyedLocks()


def cached(key, producer, ttl):
    return source.cached_call(CACHE, LOCKS, key, producer, ttl)


# ---------------------------------------------------------------- handlers

def shelf(category):
    try:
        clips = cached(f"cat:{category['id']}",
                       lambda: source.search_360(category["query"], source.HOME_LIMIT),
                       source.CATEGORY_TTL)
        return {"id": category["id"], "title": category["title"], "clips": clips}
    except Exception as error:  # one dead shelf must not empty the page
        return {"id": category["id"], "title": category["title"], "clips": [],
                "error": source.clean_error(error)}


def api_home():
    """-> (status, body, cache-control)"""
    with ThreadPoolExecutor(max_workers=4) as pool:
        shelves = list(pool.map(shelf, source.CATEGORIES))
    return 200, {"categories": shelves}, source.home_cache(shelves)


def api_search(params):
    """-> (status, body, cache-control)"""
    query = " ".join((params.get("q", [""])[0]).split())[:100]
    if not query:
        return 400, {"error": "q is required"}, source.NO_STORE
    try:
        clips = cached(f"q:{query.lower()}",
                       lambda: source.search_360(query, source.SEARCH_LIMIT), source.SEARCH_TTL)
    except Exception as error:
        return 502, {"error": source.clean_error(error)}, source.NO_STORE
    return 200, {"query": query, "clips": clips}, source.search_cache(clips)


# ---------------------------------------------------------------- wsgi

REASONS = {200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed",
           500: "Internal Server Error", 502: "Bad Gateway"}


def json_response(start_response, status, obj, cache=source.NO_STORE, head=False):
    body = json.dumps(obj).encode()
    start_response(f"{status} {REASONS.get(status, 'Error')}",
                   [("Content-Type", "application/json"), ("Cache-Control", cache),
                    ("Content-Length", str(len(body)))])
    return [b""] if head else [body]


def endpoint(environ, params):
    """The endpoint name ("home", "search") or None.

    Vercel's rewrite keeps the original request path, so PATH_INFO is
    /api/home.  If a platform ever hands us the rewritten path instead
    (/api/index.py), fall back to ?path= or the legacy ?vpath=."""
    parts = [p for p in (environ.get("PATH_INFO") or "").split("/") if p]
    if parts and parts[0] == "api":
        parts = parts[1:]
    if not parts or parts[0] in ("index.py", "index"):
        hint = (params.get("path") or params.get("vpath") or [""])[0]
        parts = [p for p in hint.split("/") if p]
        if parts and parts[0] == "api":
            parts = parts[1:]
    return parts[0] if len(parts) == 1 else None


def app(environ, start_response):
    method = environ.get("REQUEST_METHOD", "GET").upper()
    head = method == "HEAD"
    params = parse_qs(environ.get("QUERY_STRING", ""))
    name = endpoint(environ, params)
    try:
        if name not in ("home", "search"):
            status, obj, cache = 404, {"error": "no such endpoint"}, source.NO_STORE
        elif method not in ("GET", "HEAD"):
            status, obj, cache = 405, {"error": "use GET"}, source.NO_STORE
        elif name == "home":
            status, obj, cache = api_home()
        else:
            status, obj, cache = api_search(params)
    except Exception:  # a JSON error beats a platform 500 page
        # Fixed message: the exception text usually quotes deployment paths.
        traceback.print_exc()
        status, obj, cache = 500, {"error": "the server could not answer that"}, source.NO_STORE
    return json_response(start_response, status, obj, cache, head)
