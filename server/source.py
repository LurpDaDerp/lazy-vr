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

Everything here that decides -- what counts as a clip, how yt-dlp is
configured -- is a pure function over yt-dlp's dictionaries or the
environment, so the tests need neither yt-dlp nor the network.  Only
``search_360`` imports yt-dlp, and it does it lazily.
"""

from __future__ import annotations

import os
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
    SWEEP_AT sweeps the dead ones out first."""

    SWEEP_AT = 512

    def __init__(self, clock=time.time):
        self._values: dict = {}
        self._clock = clock

    def get(self, key):
        item = self._values.get(key)
        if item is None:
            return None
        value, expires = item
        if expires <= self._clock():
            self._values.pop(key, None)
            return None
        return value

    def put(self, key, value, ttl: float):
        if len(self._values) >= self.SWEEP_AT:
            now = self._clock()
            for stale in [k for k, (_, expires) in self._values.items() if expires <= now]:
                self._values.pop(stale, None)
        self._values[key] = (value, self._clock() + ttl)

    def drop(self, key):
        self._values.pop(key, None)


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


def _materialized(content: str) -> str:
    """The passed-by-value cookies, as the file yt-dlp insists on."""
    global _cookie_path
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
