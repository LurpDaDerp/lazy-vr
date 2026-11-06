"""Where the clips come from: YouTube, filtered to real 360 uploads.

Search does not use the Data API and needs no key.  It loads youtube's own
results page with the "360°" feature filter -- the ``sp`` parameter, a tiny
protobuf youtube's search UI writes when you tick that box -- and lets
yt-dlp read the entries flat.  Only equirectangular uploads carry the flag,
so the filter is also the projection check.

Search is the only thing this module asks youtube for.  Playback is
youtube's own embedded player, loaded by the page itself, so nothing here
ever resolves a video's streams: a clip dict is an id, a title and a
thumbnail, and the player takes it from there.

Getting youtube to answer a results page at all is its own problem, and the
answer is in ``impersonate_options`` and ``cookie_options``: look like a
browser while asking, and authenticate as the host configured if youtube
challenges the address anyway.

This module is also where the two deployments meet.  server/app.py and
api/index.py answer the same two endpoints in two different runtimes, and
the owner develops against the first and ships the second, so anything
they would otherwise each decide for themselves -- how many clips a shelf
holds, how long an answer is cached, how an error is worded, what
Cache-Control a file gets -- is decided once, here, where a difference
between local and production cannot hide.

Everything here that decides -- what counts as a clip, how yt-dlp is
configured -- is a pure function over yt-dlp's dictionaries or the
environment, so the tests need neither yt-dlp nor the network.  Only
``search_360`` imports yt-dlp, and it does it lazily.
"""

from __future__ import annotations

import os
import re
import threading
import time
from urllib.parse import urlencode

# The search-filter protobuf for "Features: 360°", base64 as youtube sends it.
SP_360 = "EgJ4AQ=="

# The home page: one search per shelf, cached hard on the server.
CATEGORIES = [
    {"id": "nature", "title": "Nature", "query": "nature scenery relaxation"},
    {"id": "thrill", "title": "Thrill", "query": "roller coaster extreme ride"},
    {"id": "ocean", "title": "Ocean", "query": "underwater scuba diving"},
    {"id": "wildlife", "title": "Wildlife", "query": "wildlife safari animals"},
    {"id": "cities", "title": "Cities", "query": "city walking tour"},
    {"id": "space", "title": "Space", "query": "space planets ISS"},
    {"id": "flight", "title": "Flight", "query": "wingsuit skydiving flight"},
    {"id": "music", "title": "Music", "query": "concert live performance"},
]

# Shorter than this is stingers and loops, not something to sit inside.
MIN_SECONDS = 30

# ------------------------------------------------- what both deployments answer
#
# server/app.py (aiohttp, for a container) and api/index.py (one WSGI
# function, for Vercel) serve the same two endpoints from the same search.
# Every number that shapes an answer therefore lives here and nowhere else:
# the owner develops against the aiohttp server and deploys to Vercel, so a
# constant copied into both files is a difference nobody sees until
# production shows a different page from the one that was tested.

HOME_LIMIT = 12
SEARCH_LIMIT = 24
CATEGORY_TTL = 6 * 3600
SEARCH_TTL = 15 * 60

# Cache-Control, decided once for both deployments (vercel.json repeats the
# static ones as CDN headers; tests/test_api.py checks they agree).
#
# The page's ES modules are unversioned, so html/js/css always revalidate:
# a browser mixing a new app.js with a cached old module gets a dead page
# ("does not provide an export named ...").  Models and fonts are big and
# change rarely.
PAGE_CACHE = "no-cache"                                  # / and index.html
CODE_CACHE = "public, max-age=0, must-revalidate"        # js/, css/, anything else
ASSET_CACHE = "public, max-age=604800, stale-while-revalidate=86400"
LONG_CACHED = ("models", "fonts")

# The API is edge-cached (s-maxage) so a cold function does not re-run eight
# yt-dlp searches per visitor.  Errors are never cached; an empty answer is
# usually youtube challenging us, so it is cached only briefly.
HOME_CACHE = "public, s-maxage=21600, stale-while-revalidate=86400"
HOME_PARTIAL_CACHE = "public, s-maxage=300"
SEARCH_CACHE = "public, s-maxage=900, stale-while-revalidate=3600"
EMPTY_CACHE = "public, s-maxage=60"
NO_STORE = "no-store"

# Sent with every response (vercel.json carries the same set for the CDN).
# Never COOP/COEP (they break the YouTube iframe) and never no-referrer
# (YouTube refuses the embed with error 153).
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": 'camera=(self), fullscreen=(self "https://www.youtube.com"), '
                          'autoplay=(self "https://www.youtube.com")',
}


def static_cache(path: str) -> str:
    """Cache-Control for a static path under site/ ("/", "/js/app.js")."""
    clean = path.split("?", 1)[0].lstrip("/")
    if clean in ("", "index.html"):
        return PAGE_CACHE
    if clean.split("/", 1)[0] in LONG_CACHED:
        return ASSET_CACHE
    return CODE_CACHE


def home_cache(shelves: list[dict]) -> str:
    """Full answer -> long; some shelves failed or came back empty -> short;
    nothing at all -> not cached."""
    good = [s for s in shelves if s.get("clips") and not s.get("error")]
    if not good:
        return NO_STORE
    return HOME_CACHE if len(good) == len(shelves) else HOME_PARTIAL_CACHE


def search_cache(clips: list) -> str:
    return SEARCH_CACHE if clips else EMPTY_CACHE


class KeyedLocks:
    """Per-key locks that exist only while someone holds or waits on them,
    so a stream of unique search keys cannot grow the table.  Thread-safe."""

    def __init__(self):
        self._guard = threading.Lock()
        self._locks: dict = {}  # key -> [lock, users]

    def __len__(self):
        with self._guard:
            return len(self._locks)

    def acquire(self, key):
        with self._guard:
            entry = self._locks.get(key)
            if entry is None:
                entry = self._locks[key] = [threading.Lock(), 0]
            entry[1] += 1
        entry[0].acquire()
        return entry

    def release(self, key, entry):
        entry[0].release()
        with self._guard:
            entry[1] -= 1
            if entry[1] == 0 and self._locks.get(key) is entry:
                del self._locks[key]


def cached_call(cache: "TTLCache", locks: KeyedLocks, key, producer, ttl: float):
    """Single-flight: one producer call per key per TTL, however many threads
    ask at once.  A failure is not cached; the next waiter tries itself."""
    value = cache.get(key)
    if value is not None:
        return value
    entry = locks.acquire(key)
    try:
        value = cache.get(key)
        if value is None:
            value = producer()
            cache.put(key, value, cache_ttl(value, ttl))
        return value
    finally:
        locks.release(key, entry)


def search_url(query: str) -> str:
    return "https://www.youtube.com/results?" + urlencode({"search_query": query, "sp": SP_360})


def to_clip(entry: dict) -> dict | None:
    """One flat search entry -> what a library card needs, or None to skip it."""
    vid = entry.get("id")
    title = (entry.get("title") or "").strip()
    if not vid or not title or title in ("[Private video]", "[Deleted video]"):
        return None
    if entry.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        return None
    if "/shorts/" in (entry.get("url") or ""):
        return None
    duration = entry.get("duration")
    if duration is not None and duration < MIN_SECONDS:
        return None
    return {
        "id": vid,
        "title": title,
        "channel": entry.get("channel") or entry.get("uploader") or "",
        "duration": duration,
        "thumb": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
        "views": entry.get("view_count"),
    }


# ---------------------------------------------------------------- cache

class TTLCache:
    """The smallest cache that can say no: value or None, never stale.

    Expired entries are dropped when read; entries never read again would
    otherwise pile up for the life of the process, so a put on a cache past
    SWEEP_AT sweeps the dead ones out first.

    Locked, because the Vercel function fetches the home page's eight
    shelves across a thread pool: the sweep walks the dict, and a walk that
    another thread inserts into raises "dictionary changed size during
    iteration" -- a 500 for the whole page, from the cache of all places."""

    SWEEP_AT = 512

    def __init__(self, clock=time.time):
        self._values: dict = {}
        self._clock = clock
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            item = self._values.get(key)
            if item is None:
                return None
            value, expires = item
            if expires <= self._clock():
                self._values.pop(key, None)
                return None
            return value

    def put(self, key, value, ttl: float):
        with self._lock:
            if len(self._values) >= self.SWEEP_AT:
                now = self._clock()
                for stale in [k for k, (_, expires) in self._values.items() if expires <= now]:
                    self._values.pop(stale, None)
                # Sweeping only helps if something has actually expired, and
                # a search key is whatever the visitor typed: a script asking
                # a fresh nonsense question every second mints unbounded
                # *live* entries, and on a 512mb machine that ends with the
                # OOM killer.  When the sweep frees nothing, the oldest go.
                while len(self._values) >= self.SWEEP_AT:
                    self._values.pop(next(iter(self._values)))
            self._values[key] = (value, self._clock() + ttl)

    def drop(self, key):
        with self._lock:
            self._values.pop(key, None)


# An empty result is usually not the truth.  youtube answers a challenged
# request with a results page that has no entries rather than with an
# error, so "no clips" and "we are being blocked right now" look identical
# from here -- and caching that under CATEGORY_TTL leaves the home page
# blank for six hours after one bad minute.  Keep an empty answer only long
# enough that a reloading visitor does not hammer youtube.
EMPTY_TTL = 60


def cache_ttl(value, ttl: float) -> float:
    """How long an answer is worth keeping, given what the answer was."""
    return ttl if value else EMPTY_TTL


def clean_error(error: Exception, env=os.environ) -> str:
    """What a viewer may be told when the search does not come back.

    Two things have to come off first.  yt-dlp writes for a terminal, so
    its messages arrive wearing log prefixes -- ``ERROR: [youtube:tab]
    <id>:`` -- that mean nothing on a shelf.  And they quote whatever they
    were configured with, so a failed request can carry the proxy URL,
    credentials included, or the path of the cookie jar into an HTTP
    response; both are named here and struck out by value.  The length cap
    keeps a stack-trace-sized message out of the JSON."""
    text = re.sub(r"^ERROR:\s*", "", str(error))
    text = re.sub(r"\[[\w:]+\]\s*[\w-]*:?\s*", "", text)
    for secret in ((env.get("LAZYVR_PROXY") or "").strip(),
                   (env.get("LAZYVR_COOKIES_FILE") or "").strip(),
                   _cookie_path or ""):
        if secret:
            text = text.replace(secret, "<redacted>")
    return text.strip()[:200] or "unavailable"


# ---------------------------------------------------------------- yt-dlp

_QUIET = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "extractor_retries": 3,
    "retries": 3,
    "socket_timeout": 20,
}


def proxy_options(env=os.environ) -> dict:
    """``LAZYVR_PROXY``: the last resort when an IP is simply burnt."""
    proxy = (env.get("LAZYVR_PROXY") or "").strip()
    return {"proxy": proxy} if proxy else {}


_impersonate: dict | None = None


def impersonate_options(env=os.environ) -> dict:
    """Chrome's TLS fingerprint, if this install can produce one.

    youtube's bot check reads the handshake before it reads a cookie:
    python's own TLS and HTTP/2 fingerprints are recognisable at a glance,
    and a datacenter IP with a python fingerprint is precisely the pair
    that gets challenged.  ``pip install "yt-dlp[default,curl-cffi]"`` puts
    a real Chrome fingerprint within reach.

    An impersonation target that is not installed is an *error* at request
    time rather than a warning, so this asks for nothing unless curl_cffi
    is importable.  ``LAZYVR_IMPERSONATE=off`` opts out."""
    global _impersonate
    if (env.get("LAZYVR_IMPERSONATE") or "").strip().lower() in ("off", "0", "false", "no"):
        return {}
    if _impersonate is None:
        try:
            import curl_cffi  # noqa: F401
            from yt_dlp.networking.impersonate import ImpersonateTarget
        except ImportError:
            _impersonate = {}
        else:
            _impersonate = {"impersonate": ImpersonateTarget("chrome")}
    return dict(_impersonate)

# youtube sometimes challenges an unfamiliar IP -- datacenter ranges above
# all -- with "Sign in to confirm you're not a bot", and yt-dlp's answer is
# cookies.  They must belong to wherever *this process* runs (a site can
# never read a visitor's own youtube cookies, and must not want to), so the
# host says how through the environment:
#
#   LAZYVR_COOKIES_FROM_BROWSER=chrome        read a browser profile on this
#                                             machine (chrome, edge, firefox,
#                                             optionally browser:profile)
#   LAZYVR_COOKIES_FILE=/path/cookies.txt     a Netscape-format export
#   LAZYVR_COOKIES=<file content>             the same, passed by value --
#                                             the shape a platform secret
#                                             takes; written to a temp file
#
# Cookies mean the requests count against that google account; the yt-dlp
# wiki recommends a throwaway.

_cookie_path: str | None = None
_cookie_lock = threading.Lock()


def _materialized(content: str) -> str:
    """The passed-by-value cookies, as the file yt-dlp insists on.

    Written once per process and guarded, because the Vercel function fans
    the home page's shelves out across a thread pool: on a cold instance
    four threads reach this at the same moment, and unguarded they each
    write their own temp file and three of them leak for the life of the
    instance."""
    global _cookie_path
    with _cookie_lock:
        if _cookie_path is None:
            import tempfile
            handle = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8")
            handle.write(content)
            handle.close()
            _cookie_path = handle.name
        return _cookie_path


def cookie_options(env=os.environ) -> dict:
    """The yt-dlp options the environment asks for; {} when it asks nothing."""
    content = env.get("LAZYVR_COOKIES")
    if content and content.strip():
        return {"cookiefile": _materialized(content)}
    path = env.get("LAZYVR_COOKIES_FILE")
    if path:
        return {"cookiefile": path}
    browser = env.get("LAZYVR_COOKIES_FROM_BROWSER")
    if browser:
        return {"cookiesfrombrowser": tuple(browser.split(":"))}
    return {}


def ydl_options(**extra) -> dict:
    """One yt-dlp configuration: quiet, authenticated as the host asked,
    and fingerprinted if this install can manage it."""
    return {**_QUIET, **cookie_options(), **proxy_options(), **impersonate_options(), **extra}


def search_360(query: str, limit: int = 24) -> list[dict]:
    """Flat search entries -> clip dicts, already filtered.  Blocking.

    No player client is named here: reading a results page never asks
    youtube for a stream, so what matters is only that the request looks
    ordinary -- which is the fingerprint, the cookies and the proxy, all of
    which ydl_options already carries."""
    from yt_dlp import YoutubeDL

    options = ydl_options(extract_flat="in_playlist", playlistend=max(limit * 2, 30))
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(search_url(query), download=False)
    clips = []
    for entry in info.get("entries") or []:
        clip = to_clip(entry)
        if clip:
            clips.append(clip)
        if len(clips) >= limit:
            break
    return clips
