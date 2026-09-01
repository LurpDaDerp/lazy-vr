"""LazyVR on Vercel: one serverless function for search, streams and media.

Vercel has no long-lived process, so this adapts server/app.py's three jobs
to a function's constraints:

* Resolved stream URLs live in module globals -- a warm instance keeps them,
  a cold start re-resolves.  googlevideo URLs are IP-bound, so a chunk
  served by a different instance than the one that resolved gets a 403 and
  re-resolves in place; that is expected, not an error.
* The media relay clamps every response to one small chunk: the platform
  buffers function bodies with a hard ceiling, and the <video> element's own
  range requests do the rest of the work naturally.
* Shelves are fetched with a small thread pool to fit the time budget.

Any path that is not /api or /media is served from ../site, so the app is
whole on its own: the platform may serve the static files itself (in which
case those requests never arrive here), or route everything through this
service -- both work.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs
from urllib.request import Request, urlopen

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".task")
mimetypes.add_type("application/octet-stream", ".onnx")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import source  # noqa: E402

CHUNK = 3_500_000  # stay under the platform's response-body ceiling
HOME_LIMIT = 8
SEARCH_LIMIT = 24
CATEGORY_TTL = 6 * 3600
SEARCH_TTL = 15 * 60
URL_MARGIN = 5 * 60
KNOWN_CODECS = ("vp9", "av01", "avc1")

CACHE = source.TTLCache()


def cached(key, producer, ttl):
    value = CACHE.get(key)
    if value is None:
        value = producer()
        CACHE.put(key, value, ttl)
    return value


def prefs_from(params) -> tuple[tuple[str, ...], int]:
    asked = [c for c in (params.get("codecs", [""])[0]).split(",") if c in KNOWN_CODECS]
    codecs = tuple(asked) or KNOWN_CODECS
    try:
        max_height = max(144, min(4320, int(params.get("max", ["4320"])[0])))
    except ValueError:
        max_height = 4320
    return codecs, max_height


def picked_for(vid: str, codecs: tuple[str, ...], max_height: int, force: bool = False) -> dict:
    import time
    key = f"pick:{vid}:{','.join(codecs)}:{max_height}"
    if force:
        CACHE.drop(key)
        CACHE.drop(f"info:{vid}")
    picked = CACHE.get(key)
    if picked is not None:
        return picked
    info = cached(f"info:{vid}", lambda: source.resolve(vid), 30 * 60)
    chosen = source.pick_streams(info, max_height, codecs, prefer_mp4a="vp9" not in codecs)
    picked = {"title": info.get("title"), "duration": info.get("duration"),
              "combined": chosen["combined"], "video": chosen["video"], "audio": chosen["audio"]}
    expires = [source.stream_expiry(picked["video"]["url"])]
    if picked["audio"]:
        expires.append(source.stream_expiry(picked["audio"]["url"]))
    CACHE.put(key, picked, max(60.0, min(expires) - time.time() - URL_MARGIN))
    return picked


def track_json(vid, kind, fmt, codecs, max_height):
    query = f"codecs={','.join(codecs)}&max={max_height}"
    return {"src": f"/media/{vid}/{kind}?{query}", "height": fmt.get("height"),
            "width": fmt.get("width"), "fps": fmt.get("fps"),
            "codec": source.codec_family(fmt["vcodec"]) if kind == "video" else fmt.get("acodec"),
            "ext": fmt.get("ext")}


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


def api_streams(vid, params):
    codecs, max_height = prefs_from(params)
    try:
        picked = picked_for(vid, codecs, max_height)
    except LookupError as error:
        return 415, {"error": str(error)}
    except Exception as error:
        return 502, {"error": str(error)[:200]}
    return 200, {"id": vid, "title": picked["title"], "duration": picked["duration"],
                 "combined": picked["combined"],
                 "video": track_json(vid, "video", picked["video"], codecs, max_height),
                 "audio": track_json(vid, "audio", picked["audio"], codecs, max_height)
                 if picked["audio"] else None}


def media(environ, start_response, vid, kind, params):
    codecs, max_height = prefs_from(params)
    # Clamp whatever range the browser asked for to one bounded chunk: the
    # platform buffers function bodies with a hard ceiling, and googlevideo
    # refuses an open-ended range on some signed urls anyway.  The <video>
    # element comes back for the next chunk on its own.
    asked = source.bounded_range(environ.get("HTTP_RANGE"), window=CHUNK)

    for attempt in (1, 2):
        try:
            picked = picked_for(vid, codecs, max_height, force=attempt > 1)
        except Exception as error:
            return json_response(start_response, 502, {"error": str(error)[:200]})
        fmt = picked.get(kind)
        if not fmt:
            return json_response(start_response, 404, {"error": f"no separate {kind} track"})
        request = Request(fmt["url"], headers={"Range": asked})
        try:
            with urlopen(request, timeout=40) as upstream:
                body = upstream.read()
                headers = [("Cache-Control", "no-store"), ("Accept-Ranges", "bytes")]
                for name in ("Content-Type", "Content-Range"):
                    if upstream.headers.get(name):
                        headers.append((name, upstream.headers[name]))
                headers.append(("Content-Length", str(len(body))))
                start_response(f"{upstream.status} {'Partial Content' if upstream.status == 206 else 'OK'}", headers)
                return [body]
        except HTTPError as error:
            if error.code in (403, 410) and attempt == 1:
                continue  # the signed URL went stale, or another instance resolved it
            return json_response(start_response, 502, {"error": f"upstream said {error.code}"})
        except OSError as error:
            return json_response(start_response, 502, {"error": str(error)[:200]})
    return json_response(start_response, 502, {"error": "youtube keeps refusing the stream"})


SITE = Path(__file__).resolve().parents[1] / "site"


def static(environ, start_response):
    """The page itself, for a platform that routes everything here."""
    name = (environ.get("PATH_INFO", "/") or "/").lstrip("/") or "index.html"
    target = (SITE / name).resolve()
    if not str(target).startswith(str(SITE)) or not target.is_file():
        return json_response(start_response, 404, {"error": "not found"})
    body = target.read_bytes()
    content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    start_response("200 OK", [("Content-Type", content_type),
                              ("Content-Length", str(len(body)))])
    return [body]


# ---------------------------------------------------------------- wsgi

def json_response(start_response, status, obj):
    body = json.dumps(obj).encode()
    reasons = {200: "OK", 400: "Bad Request", 404: "Not Found", 415: "Unsupported Media Type",
               502: "Bad Gateway"}
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
    if parts and parts[0] in ("api", "media"):
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
        elif kind == "api" and len(parts) == 2 and parts[0] == "streams" and \
                re.match(r"^[A-Za-z0-9_-]{11}$", parts[1]):
            status, obj = api_streams(parts[1], params)
        elif kind == "media" and len(parts) == 2 and parts[1] in ("video", "audio") and \
                re.match(r"^[A-Za-z0-9_-]{11}$", parts[0]):
            return media(environ, start_response, parts[0], parts[1], params)
        elif kind == "":
            return static(environ, start_response)
        else:
            status, obj = 404, {"error": "no such endpoint"}
    except Exception as error:  # a JSON error beats a platform 500 page
        status, obj = 500, {"error": str(error)[:200]}
    return json_response(start_response, status, obj)
