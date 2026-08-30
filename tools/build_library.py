"""Turn a folder of 360 clips into what the site needs: a manifest and thumbnails.

    python tools/build_library.py                 # ./videos -> site/library.json + site/thumbs/
    python tools/build_library.py --video-base https://cdn.example.com/lazyvr/
    python tools/build_library.py --check         # report, write nothing

The site is static, so nothing scans the folder at run time.  This does the
scanning once, up front, and writes ``site/library.json``: one entry per
clip with its URL, title, duration, resolution and thumbnail.  The page reads
that and nothing else.

Where the clips live is the ``--video-base`` decision.  Relative (the
default, ``videos/``) means they sit next to the page, which suits a local
preview and any host that will serve multi-gigabyte files with range
requests.  Absolute means object storage -- the realistic home for hundreds
of gigabytes -- and the page fetches each clip from there.  Either way the
manifest carries the full URL, and the page does not care.

Thumbnails are the horizon band of the sphere, unrolled: the middle half of
the equirectangular frame, cropped out and deliberately left equirectangular
rather than reprojected.  The poles carry nothing; the band around the
horizon is where the clip lives, and keeping it unrolled lets a card pan
across the full turn.

Needs ffmpeg and ffprobe on PATH.  Nothing else beyond the standard library.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
CONTENT_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/webm"}
# yt-dlp names the single-stream files it downloads before muxing
# "<title>.f313.mp4"; until the merge they are silent duplicates.
INTERMEDIATE = re.compile(r"\.f\d+$")
UNSAFE_SUBSTITUTES = {"｜": "|", "：": ":", "？": "?", "＂": '"', "＊": "*", "＜": "<", "＞": ">", "⧸": "/"}
THUMB_SIZE = (1600, 400)  # 4:1 -- the geometry the card's pan is built around
# A file whose mtime is this recent is probably still being written: the
# mux step writes straight to the final name, with no .part suffix.
SETTLE_SECONDS = 15.0


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def run(command: list[str], timeout: float) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(command, capture_output=True, timeout=timeout, check=False,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
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


def quality(width: int | None, height: int | None) -> str | None:
    """The shorthand a viewer recognises.  360 footage is named by the width
    of the equirectangular frame, not by its height."""
    width = width or (height * 2 if height else None)
    if not width:
        return None
    for edge, name in ((7000, "8K"), (5600, "6K"), (4800, "5K"), (3400, "4K"), (2600, "3K"), (1800, "2K")):
        if width >= edge:
            return name
    return f"{height}p" if height else None


@dataclass
class Clip:
    id: str
    title: str
    path: Path
    size: int
    mtime: float
    duration: float | None = None
    width: int | None = None
    height: int | None = None
    codec: str | None = None
    faststart: bool | None = None
    thumb: str | None = None
    problems: list[str] | None = None

    @property
    def settled(self) -> bool:
        return time.time() - self.mtime >= SETTLE_SECONDS


def scan(directory: Path) -> list[Clip]:
    """Every playable, finished file in the folder, sorted by name."""
    if not directory.is_dir():
        return []
    files = [p for p in directory.iterdir()
             if p.is_file() and p.suffix.lower() in CONTENT_TYPES and not INTERMEDIATE.search(p.stem)]
    clips: list[Clip] = []
    seen: set[str] = set()
    for path in sorted(files, key=lambda item: item.name.lower()):
        try:
            stat = path.stat()
        except OSError:
            continue
        identifier = slug(path)
        while identifier in seen:
            identifier += "-2"
        seen.add(identifier)
        clips.append(Clip(identifier, display_title(path.stem), path, stat.st_size, stat.st_mtime))
    return clips


def probe(clip: Clip) -> None:
    result = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                  "-show_entries", "stream=width,height,codec_name:format=duration",
                  "-of", "json", str(clip.path)], 60.0)
    if result is None or result.returncode != 0:
        return
    try:
        data = json.loads(result.stdout or b"{}")
    except ValueError:
        return
    stream = (data.get("streams") or [{}])[0]
    clip.width = stream.get("width")
    clip.height = stream.get("height")
    clip.codec = stream.get("codec_name")
    try:
        clip.duration = float((data.get("format") or {})["duration"])
    except (KeyError, TypeError, ValueError):
        clip.duration = None


def is_faststart(path: Path) -> bool | None:
    """True if the MP4 index (moov) comes before the media (mdat).

    A browser cannot start a file whose index is at the end until it has
    hunted through gigabytes to find it.  None for a file that is not an
    MP4-family container (WebM has no such problem).
    """
    if path.suffix.lower() not in (".mp4", ".m4v"):
        return None
    size = path.stat().st_size
    position = 0
    try:
        with path.open("rb") as handle:
            while position + 8 <= size:
                handle.seek(position)
                head = handle.read(16)
                if len(head) < 8:
                    break
                length, kind = struct.unpack_from(">I4s", head, 0)
                header = 8
                if length == 1 and len(head) >= 16:
                    length = struct.unpack_from(">Q", head, 8)[0]
                    header = 16
                elif length == 0:
                    length = size - position
                if kind == b"moov":
                    return True
                if kind == b"mdat":
                    return False
                if length < header:
                    return None
                position += length
    except OSError:
        return None
    return None


def remux_faststart(path: Path) -> bool:
    """Move the index to the front in place, without re-encoding."""
    temp = path.with_name(path.stem + ".faststart" + path.suffix)
    result = run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(path),
                  "-c", "copy", "-movflags", "+faststart", str(temp)], 3600.0)
    if result is None or result.returncode != 0 or not temp.is_file():
        temp.unlink(missing_ok=True)
        return False
    temp.replace(path)
    return True


def seek_for(clip: Clip) -> float:
    """A frame far enough in to be past the title card, but not the end."""
    if not clip.duration:
        return 20.0
    return max(0.0, min(clip.duration * 0.2, 120.0, clip.duration - 0.5))


def thumbnail(clip: Clip, target: Path) -> bool:
    """Write the horizon band of a frame a fifth of the way in."""
    if target.is_file() and target.stat().st_mtime >= clip.mtime:
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(".part.jpg")
    width, height = THUMB_SIZE
    result = run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                  "-ss", f"{seek_for(clip):.2f}", "-i", str(clip.path), "-frames:v", "1",
                  "-vf", f"crop=iw:ih/2:0:ih/4,scale={width}:{height},setsar=1",
                  "-q:v", "4", str(partial)], 300.0)
    if result is None or result.returncode != 0 or not partial.is_file():
        partial.unlink(missing_ok=True)
        return False
    partial.replace(target)
    return True


def manifest_entry(clip: Clip, video_base: str) -> dict:
    return {
        "id": clip.id,
        "title": clip.title,
        "src": video_base + quote(clip.path.name),
        "thumb": clip.thumb,
        "duration": clip.duration,
        "width": clip.width,
        "height": clip.height,
        "quality": quality(clip.width, clip.height),
        "codec": clip.codec,
        "size": clip.size,
    }


def build(videos: Path, site: Path, video_base: str, check_only: bool, remux: bool,
          log=print) -> tuple[list[Clip], list[Clip]]:
    """Returns (included, excluded)."""
    if not video_base.endswith("/"):
        video_base += "/"
    clips = scan(videos)
    if not clips:
        log(f"no clips in {videos}")
        return [], []
    if not (have("ffmpeg") and have("ffprobe")):
        raise SystemExit("ffmpeg and ffprobe must be on PATH")

    included: list[Clip] = []
    excluded: list[Clip] = []
    thumbs = site / "thumbs"
    for clip in clips:
        clip.problems = []
        if not clip.settled:
            clip.problems.append("still being written")
            excluded.append(clip)
            log(f"  skip  {clip.title[:56]}  (still being written)")
            continue
        probe(clip)
        if not clip.width or not clip.duration:
            clip.problems.append("ffprobe could not read it")
        clip.faststart = is_faststart(clip.path)
        if clip.faststart is False:
            if remux and not check_only:
                log(f"  remux {clip.title[:56]}  (moving the index to the front)")
                if remux_faststart(clip.path):
                    clip.faststart = True
                    clip.size = clip.path.stat().st_size
                    clip.mtime = clip.path.stat().st_mtime
                else:
                    clip.problems.append("remux failed")
            else:
                clip.problems.append("index at the end: playback will stall (use --remux)")
        if not check_only:
            target = thumbs / f"{clip.id}.jpg"
            if thumbnail(clip, target):
                clip.thumb = f"thumbs/{clip.id}.jpg"
            else:
                clip.problems.append("no thumbnail (ffmpeg could not decode a frame)")
        fatal = [p for p in clip.problems if "thumbnail" not in p]
        shape = f"{clip.width}x{clip.height}" if clip.width else "?"
        length = f"{clip.duration / 60:.0f} min" if clip.duration else "?"
        mark = "FAIL" if fatal else "ok  "
        log(f"  {mark}  {shape:>10} {length:>7} {clip.size / 1e9:6.2f} GB  {clip.title[:50]}")
        for problem in clip.problems:
            log(f"          - {problem}")
        (excluded if fatal else included).append(clip)

    if not check_only:
        manifest = {
            "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "clips": [manifest_entry(clip, video_base) for clip in included],
        }
        site.mkdir(parents=True, exist_ok=True)
        (site / "library.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
        log(f"\nwrote {site / 'library.json'}: {len(included)} clip(s), {len(excluded)} left out")
    else:
        log(f"\n{len(included)} of {len(clips)} clip(s) ready to serve")
    return included, excluded


def main(argv: list[str] | None = None) -> int:
    # Clip titles carry whatever characters the downloader kept; a Windows
    # console in a legacy code page must not be able to stop the build.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--videos", type=Path, default=ROOT / "videos", help="folder of clips (default: ./videos)")
    parser.add_argument("--site", type=Path, default=ROOT / "site", help="the static site root (default: ./site)")
    parser.add_argument("--video-base", default="videos/",
                        help="URL prefix the page fetches clips from (default: videos/, next to the page)")
    parser.add_argument("--remux", action="store_true",
                        help="move a trailing MP4 index to the front in place (no re-encode)")
    parser.add_argument("--check", action="store_true", help="report on every clip; write nothing")
    args = parser.parse_args(argv)
    included, excluded = build(args.videos.resolve(), args.site.resolve(), args.video_base, args.check, args.remux)
    return 1 if excluded or not included else 0


if __name__ == "__main__":
    sys.exit(main())
