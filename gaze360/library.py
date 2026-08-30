"""What 360 footage is on disk, what it looks like, and how to serve it.

The player used to be pointed at one file on the command line.  A folder of
downloads needs three more things: stable ids the browser can ask for, enough
metadata to draw a card, and a thumbnail.

Thumbnails are the horizon band of the sphere, unrolled -- the middle half of
the equirectangular frame, cropped out and left equirectangular rather than
reprojected.  The poles of a 360 frame are stretched to mush and carry
nothing, while the band around the horizon is where the whole clip lives, and
keeping it unrolled is what lets a card pan across the full turn on hover.

ffmpeg does the extraction if it is on PATH.  When it is not, the library
still works: the cards simply have no picture and no duration.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from .mp4 import VideoSource, open_video

# What a browser will play and this module knows how to serve.
CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/webm",
}

# yt-dlp names the single-stream files it downloads before muxing
# "<title>.f313.mp4".  They vanish when the merge finishes; until then they
# would show up as duplicate, silent copies of a clip already in the list.
INTERMEDIATE = re.compile(r"\.f\d+$")

# Fullwidth stand-ins a downloader substitutes for characters a filename
# cannot hold.  Put the real punctuation back, for display only.
UNSAFE_SUBSTITUTES = {
    "｜": "|",
    "：": ":",
    "？": "?",
    "＂": '"',
    "＊": "*",
    "＜": "<",
    "＞": ">",
    "⧸": "/",
}

THUMB_SIZE = (1600, 400)  # 4:1 -- the geometry the card's pan is built around
THUMB_ATTEMPTS = 3  # before a clip is written off as undecodable

# How long a file must sit unchanged before it counts as finished.
#
# A downloader's temporary names are easy to skip, but the final .mp4 is not
# always one of them: the mux step writes straight to it, so a file with the
# right name and no .part suffix can still be growing.  Playing one of those
# gets a clip with no index and no end.  A file being written has an mtime of
# right now; a finished one does not.
SETTLE_SECONDS = 15.0
FFMPEG_TIMEOUT = 300.0
PROBE_TIMEOUT = 60.0
# A FastStartSource holds the whole moov atom in memory, which on a long 8K
# clip is megabytes.  Keep only the handful most recently played.
SOURCES_CACHED = 4


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def _run(command: list[str], timeout: float) -> subprocess.CompletedProcess | None:
    """Run a tool, returning None rather than raising if it is unusable."""
    try:
        return subprocess.run(
            command,
            capture_output=True,
            timeout=timeout,
            check=False,
            # Windows: keep ffmpeg from flashing up a console window of its own.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return None


def display_title(stem: str) -> str:
    """Turn a download's filename into something worth reading on a card."""
    title = INTERMEDIATE.sub("", stem)
    for substitute, real in UNSAFE_SUBSTITUTES.items():
        title = title.replace(substitute, real)
    return re.sub(r"\s+", " ", title).strip() or stem


def slug(path: Path) -> str:
    """A stable, URL-safe id for a file, unique within one directory."""
    keep = re.sub(r"[^a-zA-Z0-9]+", "-", path.stem).strip("-").lower()
    return keep[:60] or "clip"


@dataclass
class Entry:
    """One clip, as the library knows it."""

    id: str
    title: str
    path: Path
    size: int
    mtime: float
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    probed: bool = False
    # False while the file is still being written; it is listed, but as a
    # download in progress rather than as something that can be played.
    settled: bool = True

    @property
    def content_type(self) -> str:
        return CONTENT_TYPES.get(self.path.suffix.lower(), "video/mp4")

    @property
    def quality(self) -> str | None:
        """The shorthand a viewer recognises for this clip's resolution.

        360 footage is named by the width of the equirectangular frame, not
        by its height: the file everyone calls 8K is 7680x3840, which by the
        flat-video convention would be a 4K frame.
        """
        width = self.width or (self.height * 2 if self.height else None)
        if not width:
            return None
        for edge, name in ((7000, "8K"), (5600, "6K"), (4800, "5K"),
                           (3400, "4K"), (2600, "3K"), (1800, "2K")):
            if width >= edge:
                return name
        return f"{self.height}p" if self.height else None

    def describe(self, has_thumb: bool) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "file": self.path.name,
            "size": self.size,
            "duration": self.duration,
            "width": self.width,
            "height": self.height,
            "quality": self.quality,
            "thumb": has_thumb,
            "probed": self.probed,
            "settled": self.settled,
        }


class VideoLibrary:
    """The contents of a folder, prepared for the browser in the background.

    Scanning is cheap and happens on demand, so a clip that finishes
    downloading while the page is open turns up on the next poll.  Probing and
    thumbnailing are slow, so a worker thread does them and the page watches
    the count climb.
    """

    def __init__(self, directory: Path, cache: Path, only: str | None = None) -> None:
        self.directory = Path(directory).resolve()
        self.cache = Path(cache).resolve()
        # ``--video one.mp4`` is a library of exactly one clip.
        self.only = only
        self._lock = threading.RLock()
        self._entries: "OrderedDict[str, Entry]" = OrderedDict()
        self._sources: "OrderedDict[str, VideoSource]" = OrderedDict()
        self._scanned_at = 0.0
        self._stopping = threading.Event()
        self._worker: threading.Thread | None = None
        self._attempts: dict[str, int] = {}
        # filename -> (size when last seen, when it was last seen to change)
        self._seen: dict[str, tuple[int, float | None]] = {}
        self.tools = have("ffmpeg") and have("ffprobe")

    def _settled(self, path: Path, stat, now: float) -> bool:
        """Has this file stopped growing?

        Two signals, because neither is enough alone.  A file being written
        has an mtime of a moment ago, which catches a download this process
        has only just laid eyes on.  And a file this process has watched
        change size is growing whatever its mtime claims, which covers a
        filesystem lazy about timestamps on an open handle.
        """
        remembered = self._seen.get(path.name)
        changed_at = None  # None means: never seen this file change size
        if remembered is not None:
            size, changed_at = remembered
            if size != stat.st_size:
                changed_at = now
        self._seen[path.name] = (stat.st_size, changed_at)

        if time.time() - stat.st_mtime < SETTLE_SECONDS:
            return False
        # Only an observed change casts doubt on a file.  Merely having been
        # seen for the first time does not, or a folder of finished clips
        # would sit unplayable for no reason on every start.
        return changed_at is None or now - changed_at >= SETTLE_SECONDS

    # -- what is on disk -------------------------------------------------

    def scan(self) -> list[Entry]:
        """Re-read the directory, keeping what is already known about a file."""
        if self.directory.is_dir():
            files = [
                path
                for path in self.directory.iterdir()
                if path.is_file()
                and path.suffix.lower() in CONTENT_TYPES
                and not INTERMEDIATE.search(path.stem)
                and (self.only is None or path.name == self.only)
            ]
        else:
            files = []

        now = time.monotonic()
        found: "OrderedDict[str, Entry]" = OrderedDict()
        for path in sorted(files, key=lambda item: item.name.lower()):
            try:
                stat = path.stat()
            except OSError:
                continue  # vanished between the listing and the stat
            settled = self._settled(path, stat, now)
            identifier = slug(path)
            while identifier in found:
                identifier += "-2"
            previous = self._entries.get(identifier)
            if (
                previous is not None
                and previous.path == path
                and previous.size == stat.st_size
                and previous.mtime == stat.st_mtime
            ):
                found[identifier] = previous  # unchanged: keep what was probed
            else:
                found[identifier] = Entry(
                    id=identifier,
                    title=display_title(path.stem),
                    path=path,
                    size=stat.st_size,
                    mtime=stat.st_mtime,
                )
            found[identifier].settled = settled

        with self._lock:
            for gone in [key for key in self._sources if key not in found]:
                self._sources.pop(gone, None)
            for name in [key for key in self._seen if key not in {
                entry.path.name for entry in found.values()
            }]:
                self._seen.pop(name, None)
            self._entries = found
            self._scanned_at = time.monotonic()
            return list(found.values())

    def entries(self, max_age: float = 2.0) -> list[Entry]:
        """The current list, rescanning if the last look was long enough ago."""
        with self._lock:
            if self._scanned_at and time.monotonic() - self._scanned_at < max_age:
                return list(self._entries.values())
        return self.scan()

    def entry(self, identifier: str) -> Entry | None:
        with self._lock:
            return self._entries.get(identifier)

    def describe(self) -> dict:
        """Everything the start screen needs to draw itself."""
        cards = [item.describe(self.thumb(item.id) is not None) for item in self.entries()]
        return {
            "clips": cards,
            "ready": sum(1 for card in cards if card["thumb"]),
            "downloading": sum(1 for card in cards if not card["settled"]),
            "total": len(cards),
            "preparing": self._worker is not None and self._worker.is_alive(),
            "tools": self.tools,
            "directory": str(self.directory),
        }

    # -- serving ---------------------------------------------------------

    def source(self, identifier: str) -> VideoSource | None:
        """A byte source for one clip, with its index moved to the front."""
        entry = self.entry(identifier)
        if entry is None or not entry.path.is_file():
            return None
        with self._lock:
            cached = self._sources.get(identifier)
            if cached is not None and cached.size == entry.size:
                self._sources.move_to_end(identifier)
                return cached
        opened = open_video(entry.path)
        with self._lock:
            self._sources[identifier] = opened
            self._sources.move_to_end(identifier)
            while len(self._sources) > SOURCES_CACHED:
                self._sources.popitem(last=False)
        return opened

    def thumb(self, identifier: str) -> Path | None:
        entry = self.entry(identifier)
        if entry is None:
            return None
        path = self._thumb_path(entry)
        return path if path.is_file() else None

    def _thumb_path(self, entry: Entry) -> Path:
        # Size and mtime are in the name, so a re-download rebuilds the picture
        # rather than showing the one made from the file it replaced.
        return self.cache / f"{entry.id}-{entry.size}-{int(entry.mtime)}.jpg"

    def _refused(self, entry: Entry) -> Path:
        return self._thumb_path(entry).with_suffix(".failed")

    # -- preparation -----------------------------------------------------

    def start(self) -> None:
        """Probe and thumbnail everything, in the background, and keep watching."""
        if not self.tools or self._worker is not None:
            return
        self._worker = threading.Thread(
            target=self._prepare_loop, name="library", daemon=True
        )
        self._worker.start()

    def stop(self) -> None:
        self._stopping.set()

    def _prepare_loop(self) -> None:
        try:
            self.cache.mkdir(parents=True, exist_ok=True)
        except OSError:
            return
        while not self._stopping.is_set():
            settled = self._prepare_pass()
            # Nothing left to do: wait for a download to land, then look again.
            if settled:
                self._stopping.wait(5.0)

    def _prepare_pass(self) -> bool:
        """One sweep of the directory.  True when there was nothing to do."""
        idle = True
        for entry in self.scan():
            if self._stopping.is_set():
                return True
            if not entry.settled:
                # Still being written.  Probing it would read a truncated
                # header and thumbnailing it would cache a picture of a file
                # that is about to change underneath the cache key.
                idle = False
                continue
            if not entry.probed:
                self._probe(entry)
                idle = False
            if not self._thumb_path(entry).is_file() and not self._refused(entry).is_file():
                self._thumbnail(entry)
                idle = False
        return idle

    def _probe(self, entry: Entry) -> None:
        result = _run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height:format=duration",
                "-of", "json", str(entry.path),
            ],
            PROBE_TIMEOUT,
        )
        entry.probed = True  # a file ffprobe cannot read is not worth retrying
        if result is None or result.returncode != 0:
            return
        try:
            data = json.loads(result.stdout or b"{}")
        except ValueError:
            return
        streams = data.get("streams") or [{}]
        entry.width = streams[0].get("width")
        entry.height = streams[0].get("height")
        try:
            entry.duration = float((data.get("format") or {})["duration"])
        except (KeyError, TypeError, ValueError):
            entry.duration = None

    def _seek_to(self, entry: Entry) -> float:
        """A frame far enough in to be past the title card, but not the end.

        A fifth of the way in clears the intro on a long clip without
        landing somewhere unrepresentative, and staying half a second short
        of the end keeps a very short clip from seeking past its last frame.
        """
        if not entry.duration:
            return 20.0
        return max(0.0, min(entry.duration * 0.2, 120.0, entry.duration - 0.5))

    def _thumbnail(self, entry: Entry) -> None:
        target = self._thumb_path(entry)
        partial = target.with_suffix(".part.jpg")
        width, height = THUMB_SIZE
        result = _run(
            [
                "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                # Seek before -i so ffmpeg jumps rather than decoding its way
                # in; on an 8K file the difference is minutes.
                "-ss", f"{self._seek_to(entry):.2f}",
                "-i", str(entry.path),
                "-frames:v", "1",
                # Middle half of the frame: the horizon band, poles discarded.
                "-vf", f"crop=iw:ih/2:0:ih/4,scale={width}:{height},setsar=1",
                "-q:v", "4",
                str(partial),
            ],
            FFMPEG_TIMEOUT,
        )
        if result is None or result.returncode != 0 or not partial.is_file():
            partial.unlink(missing_ok=True)
            # A clip that has only just finished downloading may still be
            # being muxed, so one failure means nothing.  After a few, give
            # up and leave a marker rather than retrying every five seconds
            # for the life of the process.
            self._attempts[entry.id] = self._attempts.get(entry.id, 0) + 1
            if self._attempts[entry.id] >= THUMB_ATTEMPTS:
                try:
                    self._refused(entry).touch(exist_ok=True)
                except OSError:
                    pass
            return
        self._attempts.pop(entry.id, None)
        try:
            partial.replace(target)  # atomic: never serve a half-written jpeg
        except OSError:
            partial.unlink(missing_ok=True)
