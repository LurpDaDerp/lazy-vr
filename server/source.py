"""Where the clips come from: YouTube, filtered to real 360 uploads.

Search does not use the Data API and needs no key.  It loads youtube's own
results page with the "360°" feature filter -- the ``sp`` parameter, a tiny
protobuf youtube's search UI writes when you tick that box -- and lets
yt-dlp read the entries flat.  Only equirectangular uploads carry the flag,
so the filter is also the projection check.

Streams are resolved per video, on demand.  Above 720p youtube serves video
and audio as separate tracks, so the picker returns one of each and the page
keeps the two elements in step; the URLs it returns are signed, IP-bound and
short-lived, which is why the server proxies the bytes rather than handing
the URLs to the browser.

Everything here that decides -- what counts as a clip, which format wins --
is a pure function over yt-dlp's dictionaries, so the tests need neither
yt-dlp nor the network.  Only ``search_360`` and ``resolve`` import yt-dlp,
and they do it lazily.
"""

from __future__ import annotations

import os
import time
from urllib.parse import parse_qs, urlencode, urlsplit

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


# ---------------------------------------------------------------- formats

def codec_family(vcodec: str) -> str:
    """The name a browser's decoder support is asked about."""
    if vcodec.startswith(("vp9", "vp09")):
        return "vp9"
    if vcodec.startswith("av01"):
        return "av01"
    if vcodec.startswith(("avc1", "h264")):
        return "avc1"
    return vcodec.split(".")[0]


def _plain_http(fmt: dict) -> bool:
    return bool(fmt.get("url")) and fmt.get("protocol") in (None, "https", "http")


def pick_video(formats: list[dict], max_height: int = 4320,
               codecs: tuple[str, ...] = ("vp9", "av01", "avc1")) -> dict | None:
    """The best video track the asking browser can decode.

    Height first, then the browser's own codec preference order, then frame
    rate.  A video-only track beats a muxed one: the muxed ladder stops at
    720p, and audio is handled separately anyway.
    """
    best, best_key = None, None
    for fmt in formats or []:
        vcodec = fmt.get("vcodec")
        if not _plain_http(fmt) or not vcodec or vcodec == "none":
            continue
        family = codec_family(vcodec)
        if family not in codecs:
            continue
        height = fmt.get("height") or 0
        if height <= 0 or height > max_height:
            continue
        video_only = fmt.get("acodec") in (None, "none")
        key = (int(video_only), height, -codecs.index(family),
               fmt.get("fps") or 0, fmt.get("tbr") or 0)
        if best_key is None or key > best_key:
            best, best_key = fmt, key
    return best


def pick_audio(formats: list[dict], prefer_mp4a: bool = False) -> dict | None:
    """The best audio-only track: the original language, then the codec the
    browser prefers (Safari cannot play opus-in-webm), then bitrate."""
    wanted = "mp4a" if prefer_mp4a else "opus"
    best, best_key = None, None
    for fmt in formats or []:
        acodec = fmt.get("acodec")
        if not _plain_http(fmt) or not acodec or acodec == "none":
            continue
        if fmt.get("vcodec") not in (None, "none"):
            continue
        family = "mp4a" if acodec.startswith("mp4a") else acodec
        language = fmt.get("language_preference")
        key = (language if isinstance(language, (int, float)) else 0,
               1 if family.startswith(wanted) else 0,
               fmt.get("abr") or fmt.get("tbr") or 0)
        if best_key is None or key > best_key:
            best, best_key = fmt, key
    return best


def pick_streams(info: dict, max_height: int = 4320,
                 codecs: tuple[str, ...] = ("vp9", "av01", "avc1"),
                 prefer_mp4a: bool = False) -> dict:
    """What the page will actually play: {"video": fmt, "audio": fmt | None}.

    audio is None either because the video track is muxed (sound rides along)
    or because the clip genuinely has no audio; "combined" says which.
    """
    formats = info.get("formats") or []
    video = pick_video(formats, max_height, codecs)
    if video is None:
        raise LookupError("no stream this browser can decode")
    combined = video.get("acodec") not in (None, "none")
    audio = None if combined else pick_audio(formats, prefer_mp4a)
    return {"video": video, "audio": audio, "combined": combined}


def stream_expiry(url: str, now: float | None = None) -> float:
    """When a resolved googlevideo URL stops working.  The URL says so
    itself (``expire=<unix>``); four hours if it does not."""
    now = time.time() if now is None else now
    try:
        expire = int(parse_qs(urlsplit(url).query)["expire"][0])
    except (KeyError, ValueError, IndexError):
        return now + 4 * 3600
    return float(expire)


# ---------------------------------------------------------------- cache

class TTLCache:
    """The smallest cache that can say no: value or None, never stale."""

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
        self._values[key] = (value, self._clock() + ttl)

    def drop(self, key):
        self._values.pop(key, None)


# ---------------------------------------------------------------- yt-dlp

_QUIET = {"quiet": True, "no_warnings": True, "skip_download": True}

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
    return {**_QUIET, **cookie_options(), **extra}


def search_360(query: str, limit: int = 24) -> list[dict]:
    """Flat search entries -> clip dicts, already filtered.  Blocking."""
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


def resolve(video_id: str) -> dict:
    """The full format list for one video.  Blocking, a few seconds."""
    from yt_dlp import YoutubeDL

    with YoutubeDL(ydl_options(noplaylist=True)) as ydl:
        return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
