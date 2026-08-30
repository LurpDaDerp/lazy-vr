"""Serve a camera-original MP4 as if its index were at the front.

A file straight off a 360 camera usually carries its ``moov`` atom -- the index
a player needs before it can show anything -- *after* the two gigabytes of
``mdat`` it describes.  A browser then cannot start until it has hunted to the
end of the file, and seeking stays awkward afterwards.  The usual cure is to
rewrite the file (``ffmpeg -movflags +faststart``), which costs a second copy
of it on disk.

This module does the same rearrangement virtually.  ``moov`` is parsed once
into memory, its chunk offsets are corrected for the move, and the server
presents ``ftyp + moov + mdat`` while reading the original bytes from their
original places.  Nothing is written, the file is untouched, and the player
sees a faststart file.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

# Boxes worth descending into on the way to a chunk-offset table.
CONTAINERS = frozenset({"moov", "trak", "mdia", "minf", "stbl", "edts", "mvex"})
UINT32_MAX = 0xFFFFFFFF


class Mp4Error(Exception):
    """The file is not a rearrangeable MP4."""


@dataclass(frozen=True)
class Atom:
    type: str
    offset: int  # where the atom's header starts
    size: int  # header plus payload
    header: int  # 8, or 16 for a 64-bit size

    @property
    def end(self) -> int:
        return self.offset + self.size

    @property
    def body(self) -> int:
        return self.offset + self.header


def _parse_header(data: bytes, position: int, extent: int) -> tuple[str, int, int] | None:
    """Decode one atom header: ``(type, size, header length)``.

    ``extent`` is where the enclosing container ends, used only to resolve a
    size of 0 ("runs to the end").  The payload is not bounds-checked here --
    the caller knows whether it holds the whole container or just a header.
    """
    if position + 8 > len(data):
        return None
    size, kind = struct.unpack_from(">I4s", data, position)
    header = 8
    if size == 1:
        if position + 16 > len(data):
            raise Mp4Error("truncated 64-bit atom header")
        size = struct.unpack_from(">Q", data, position + 8)[0]
        header = 16
    elif size == 0:
        size = extent - position
    if size < header:
        raise Mp4Error(f"atom {kind!r} at {position} has an impossible size {size}")
    try:
        name = kind.decode("ascii")
    except UnicodeDecodeError as error:
        raise Mp4Error("non-ASCII atom type") from error
    return name, size, header


def _read_atom(data: bytes, position: int, limit: int) -> Atom | None:
    """Read an atom whose whole payload is present in ``data``."""
    parsed = _parse_header(data, position, limit)
    if parsed is None:
        return None
    name, size, header = parsed
    if position + size > limit:
        raise Mp4Error(f"atom {name!r} at {position} overruns its container")
    return Atom(name, position, size, header)


def walk(data: bytes, start: int, limit: int) -> Iterator[Atom]:
    """Yield the atoms laid out in ``data[start:limit]``."""
    position = start
    while position < limit:
        atom = _read_atom(data, position, limit)
        if atom is None:
            return
        yield atom
        position = atom.end


def top_level_atoms(path: Path) -> list[Atom]:
    """Read the file's top-level atom table without reading its payloads."""
    size = path.stat().st_size
    atoms: list[Atom] = []
    position = 0
    with path.open("rb") as handle:
        while position < size:
            handle.seek(position)
            head = handle.read(16)
            if len(head) < 8:
                break
            parsed = _parse_header(head, 0, size - position)
            if parsed is None:
                break
            name, extent, header = parsed
            atom = Atom(name, position, extent, header)
            if atom.end > size:
                raise Mp4Error(f"atom {name!r} overruns the file")
            atoms.append(atom)
            position = atom.end
    return atoms


def _offset_tables(moov: bytes) -> list[tuple[str, int, int]]:
    """Locate every chunk-offset table: ``(kind, entry_start, entry_count)``."""
    found: list[tuple[str, int, int]] = []

    def descend(start: int, limit: int) -> None:
        for atom in walk(moov, start, limit):
            if atom.type in ("stco", "co64"):
                if atom.body + 8 > atom.end:
                    raise Mp4Error(f"{atom.type} is too short")
                count = struct.unpack_from(">I", moov, atom.body + 4)[0]
                width = 4 if atom.type == "stco" else 8
                first = atom.body + 8
                if first + count * width > atom.end:
                    raise Mp4Error(f"{atom.type} entry count {count} overruns the box")
                found.append((atom.type, first, count))
            elif atom.type in CONTAINERS:
                descend(atom.body, atom.end)

    descend(0, len(moov))
    return found


def shift_chunk_offsets(moov: bytearray, delta: int, window: tuple[int, int]) -> int:
    """Add ``delta`` to every chunk offset inside ``window``; return how many moved.

    ``window`` is the half-open span of original file offsets whose bytes the
    move displaces.  Offsets outside it address bytes that do not move, so they
    are left exactly as they are.
    """
    low, high = window
    moved = 0
    for kind, first, count in _offset_tables(bytes(moov)):
        if kind == "stco":
            for index in range(count):
                at = first + 4 * index
                value = struct.unpack_from(">I", moov, at)[0]
                if low <= value < high:
                    shifted = value + delta
                    if shifted > UINT32_MAX:
                        # Correcting this would require promoting the table to
                        # 64-bit, which resizes moov and invalidates the very
                        # offsets being computed.  Refuse instead of corrupt.
                        raise Mp4Error(
                            "a 32-bit chunk offset would overflow; "
                            "remux with ffmpeg -movflags +faststart"
                        )
                    struct.pack_into(">I", moov, at, shifted)
                    moved += 1
        else:
            for index in range(count):
                at = first + 8 * index
                value = struct.unpack_from(">Q", moov, at)[0]
                if low <= value < high:
                    struct.pack_into(">Q", moov, at, value + delta)
                    moved += 1
    return moved


class VideoSource:
    """A byte range of an MP4, however the file happens to be laid out."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.size = self.path.stat().st_size
        self.rearranged = False

    def chunks(self, start: int, end: int, block: int) -> Iterator[bytes]:
        """Yield ``[start, end]`` inclusive, in pieces of at most ``block``."""
        remaining = end - start + 1
        with self.path.open("rb") as handle:
            handle.seek(start)
            while remaining > 0:
                piece = handle.read(min(block, remaining))
                if not piece:
                    return
                remaining -= len(piece)
                yield piece


class FastStartSource(VideoSource):
    """Presents ``ftyp + moov + <everything else>`` over an unmodified file.

    The virtual file is the same length as the original -- ``moov`` is moved,
    not added -- so byte ranges stay meaningful and the player's seeking works
    normally.
    """

    def __init__(self, path: Path, header: bytes, cut: int, moov: Atom) -> None:
        super().__init__(path)
        self._header = header  # original bytes before moov's new home, then moov
        self._cut = cut  # where moov used to be inserted, in original offsets
        self._moov = moov
        self.rearranged = True

    def chunks(self, start: int, end: int, block: int) -> Iterator[bytes]:
        length = end - start + 1
        head = len(self._header)

        if start < head:
            piece = self._header[start : min(head, end + 1)]
            yield piece
            length -= len(piece)
            start += len(piece)
        if length <= 0:
            return

        # Past the header the virtual file is the original file with moov's
        # bytes skipped: everything from the old insertion point up to moov,
        # then everything after moov.
        with self.path.open("rb") as handle:
            for begin, finish in self._tail_spans(start - head, length):
                handle.seek(begin)
                remaining = finish - begin
                while remaining > 0:
                    piece = handle.read(min(block, remaining))
                    if not piece:
                        return
                    remaining -= len(piece)
                    yield piece

    def _tail_spans(self, skip: int, length: int) -> list[tuple[int, int]]:
        """Map a run of the virtual tail onto original-file spans."""
        # The tail is two runs laid end to end.
        runs = [(self._cut, self._moov.offset), (self._moov.end, self.size)]
        spans: list[tuple[int, int]] = []
        for begin, finish in runs:
            extent = finish - begin
            if skip >= extent:
                skip -= extent
                continue
            begin += skip
            skip = 0
            take = min(length, finish - begin)
            if take <= 0:
                break
            spans.append((begin, begin + take))
            length -= take
            if length <= 0:
                break
        return spans


def open_video(path: Path) -> VideoSource:
    """Return a source that always presents the index first.

    Falls back to serving the file untouched when it is already faststart, or
    when anything about it is not understood -- a player that copes on its own
    is better than a player handed a file this module guessed wrong about.
    """
    path = Path(path)
    try:
        atoms = top_level_atoms(path)
    except (Mp4Error, OSError):
        return VideoSource(path)

    moov = next((atom for atom in atoms if atom.type == "moov"), None)
    if moov is None:
        return VideoSource(path)
    media = next((atom for atom in atoms if atom.type == "mdat"), None)
    if media is None or moov.offset < media.offset:
        return VideoSource(path)  # already faststart

    # moov goes directly after the leading ftyp; everything between that point
    # and moov's old home slides forward by moov's length.
    lead = [atom for atom in atoms if atom.type == "ftyp" and atom.offset < moov.offset]
    cut = lead[-1].end if lead else 0

    try:
        with path.open("rb") as handle:
            handle.seek(0)
            prefix = handle.read(cut)
            handle.seek(moov.offset)
            body = bytearray(handle.read(moov.size))
        if len(body) != moov.size:
            raise Mp4Error("moov is truncated")
        shift_chunk_offsets(body, moov.size, (cut, moov.offset))
    except (Mp4Error, OSError, struct.error):
        return VideoSource(path)

    return FastStartSource(path, prefix + bytes(body), cut, moov)
