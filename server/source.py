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

Getting youtube to answer at all is its own problem, and the answer is in
``client_ladder`` and ``impersonate_options``: ask the player clients that
still serve an unknown IP, look like a browser while asking, and never let
yt-dlp's own format selector turn a thin list into an error.

Everything here that decides -- what counts as a clip, which format wins,
which clients to ask -- is a pure function over yt-dlp's dictionaries or
the environment, so the tests need neither yt-dlp nor the network.  Only
``search_360`` and ``resolve`` import yt-dlp, and they do it lazily.
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


# How much of a track to ask googlevideo for at a time.
#
# This is throughput, and the numbers are not close.  Measured against a
# live googlevideo, one signed url, same file, same minute:
#
#     Range: bytes=0-             1.9 Mbit/s
#     Range: bytes=0-16777215     2.2 Mbit/s
#     Range: bytes=0-8388607    158   Mbit/s
#     Range: bytes=16777216-25165823
#                               150   Mbit/s
#
# An open-ended range is served at roughly playback rate, and so is a
# bounded one over about ten megabytes; a bounded read under that is served
# as fast as the link goes.  `Range: bytes=0-` is exactly what a <video>
# element asks for first, so the whole library used to arrive at 2 Mbit/s
# -- fine for 720p, hopeless for the 4K and 8K this player is for, and the
# stalls read as the picture stuttering rather than as a slow download.
#
# So every upstream read is a window under the threshold, and app.py
# stitches the windows back into one response.  (yt-dlp does the same thing
# for the same reason; its --http-chunk-size is the same order.)
UPSTREAM_WINDOW = 8 << 20


def parse_range(header: str | None) -> tuple[int, int | None] | None:
    """``(first byte, last byte or None)`` from a Range header.

    Absent is ``(0, None)``: a reader who said nothing wants all of it.
    ``None`` means a form we decline to understand -- a suffix range
    (``bytes=-500``, the *last* 500 bytes) or a multipart one -- which
    callers pass through as it came rather than guess at.  No media element
    sends either.
    """
    text = (header or "").strip()
    if not text:
        return (0, None)
    unit, sign, spec = text.partition("=")
    if not sign or unit.strip().lower() != "bytes" or "," in spec:
        return None
    first, dash, last = spec.partition("-")
    if not dash or not first.strip():
        return None
    try:
        return (int(first.strip()), int(last.strip()) if last.strip() else None)
    except ValueError:
        return None


def bounded_range(header: str | None, window: int = UPSTREAM_WINDOW) -> str:
    """The Range to ask googlevideo for, given what the reader asked us:
    the same span, cut down to one window.  A form parse_range declines is
    handed on untouched."""
    asked = parse_range(header)
    if asked is None:
        return header
    start, last = asked
    stop = start + window - 1
    if last is not None:
        stop = min(stop, last)
    return f"bytes={start}-{stop}"


def total_size(content_range: str | None) -> int | None:
    """The whole track's length, out of an upstream ``bytes a-b/total``.

    None when the header is missing or the total is a ``*`` -- the relay
    then simply streams until the windows run dry."""
    if not content_range or "/" not in content_range:
        return None
    tail = content_range.rsplit("/", 1)[1].strip()
    return int(tail) if tail.isdigit() else None


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
    # We want youtube's format *list*, never yt-dlp's pick from it: the
    # choosing happens in pick_streams, against what the asking browser
    # said it can decode.  Without this, a list yt-dlp's own default
    # selector finds no winner in raises "Requested format is not
    # available" -- which is not "no formats", it is "no format matched
    # bestvideo+bestaudio" -- and one trimmed list would send the whole
    # library to the embed fallback.
    "ignore_no_formats_error": True,
    "extractor_retries": 3,
    "retries": 3,
    "socket_timeout": 20,
}

# The player clients youtube will still serve to an IP it does not know.
#
# Measured rather than assumed, against a live youtube.  Of the eleven
# clients yt-dlp knows, `visionos` is the only one that both answers an
# unknown IP with no PO token and hands back urls that then actually serve
# bytes.  `web` -- half of yt-dlp's own default pair -- returns a format
# list with no playable entry at all, as do tv, ios, mweb and web_safari,
# so the stock configuration is one dead client and one live one, and it
# fails outright the moment the live one is challenged.
#
# `android_vr` is the near miss, and worth naming so nobody adds it back:
# it resolves beautifully from any IP, and every url it produces answers
# 403 -- open range, bounded range, with its own http_headers or without.
# A client that resolves and cannot stream is worse than no client, because
# pick_video will happily choose its track over an identical playable one.
FREE_CLIENTS = ("visionos",)

# The second rung: clients that normally want a PO token.  Paired with
# `formats=missing_pot` below, yt-dlp offers their tokenless formats
# anyway -- often playable, and always better than giving up -- and any
# configured cookies do their best work here.
TOKEN_CLIENTS = ("tv_simply", "web_safari", "mweb", "tv")


def has_playable(info: dict) -> bool:
    """Did this attempt come back with a track a browser could actually
    fetch?  Plain https only: HLS and DASH manifests are not something the
    proxy can hand to a <video> element by the byte."""
    for fmt in info.get("formats") or []:
        vcodec = fmt.get("vcodec")
        if vcodec and vcodec != "none" and _plain_http(fmt):
            return True
    return False


def client_ladder(env=os.environ) -> list[tuple[str, ...]]:
    """Which clients to ask, in which order, widening as attempts fail.

    ``LAZYVR_PLAYER_CLIENTS=android_vr,tv`` replaces the ladder outright,
    so a host whose IP youtube treats differently can be retuned without a
    redeploy."""
    named = tuple(name for name in (env.get("LAZYVR_PLAYER_CLIENTS") or "").replace(",", " ").split())
    if named:
        return [named]
    return [FREE_CLIENTS, FREE_CLIENTS + TOKEN_CLIENTS]


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


def ydl_options(clients: tuple[str, ...] | None = None, **extra) -> dict:
    """One yt-dlp configuration: quiet, authenticated as the host asked,
    fingerprinted if it can be, and aimed at the given player clients.

    ``formats=missing_pot`` keeps the tracks youtube served without a PO
    token instead of discarding them unheard; they usually play."""
    options = {**_QUIET, **cookie_options(), **proxy_options(), **impersonate_options()}
    if clients:
        options["extractor_args"] = {"youtube": {"player_client": list(clients),
                                                 "formats": ["missing_pot"]}}
    return {**options, **extra}


class Refused(Exception):
    """youtube would not hand over a playable track for this video."""


def search_360(query: str, limit: int = 24) -> list[dict]:
    """Flat search entries -> clip dicts, already filtered.  Blocking.

    No player client here: reading a results page never asks youtube for a
    stream, so what matters is only that the request looks ordinary --
    which is the fingerprint, the cookies and the proxy, all of which
    ydl_options already carries."""
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
    """The full format list for one video.  Blocking, a few seconds.

    Climbs the client ladder rather than trusting one ask.  The first rung
    needs neither a PO token nor a cookie and answers most of the time; the
    next widens to the clients that usually want one, since a tokenless
    format from them still plays more often than not.

    An attempt that comes back with a format list containing nothing
    fetchable is a failure like any other, and one that raises nothing --
    so has_playable is what decides a rung, not the absence of an
    exception.  Only when every rung has been tried does this give up, and
    it gives up with whatever youtube actually said, so the page can pass
    the reason on instead of silently falling back."""
    from yt_dlp import YoutubeDL

    url = f"https://www.youtube.com/watch?v={video_id}"
    last: Exception | None = None
    for clients in client_ladder():
        try:
            with YoutubeDL(ydl_options(clients=clients, noplaylist=True)) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as error:  # noqa: BLE001 -- try the next rung, whatever it was
            last = error
            continue
        if info and has_playable(info):
            return info
        last = Refused(f"youtube served no playable track to {', '.join(clients)}")
    raise last or Refused("youtube would not resolve this video")
