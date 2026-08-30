"""Unit tests for the virtual faststart rearrangement.

The MP4s here are built byte by byte in the test so nothing external is
needed.  The invariant every test is really checking: a chunk offset in the
rearranged file must address the same bytes it addressed in the original.
"""

import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.mp4 import (
    Mp4Error,
    VideoSource,
    open_video,
    shift_chunk_offsets,
    top_level_atoms,
)


def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def stco(offsets) -> bytes:
    body = b"\0\0\0\0" + struct.pack(">I", len(offsets))
    body += b"".join(struct.pack(">I", value) for value in offsets)
    return box(b"stco", body)


def co64(offsets) -> bytes:
    body = b"\0\0\0\0" + struct.pack(">I", len(offsets))
    body += b"".join(struct.pack(">Q", value) for value in offsets)
    return box(b"co64", body)


def moov_with(table: bytes) -> bytes:
    """Wrap an offset table in the moov/trak/mdia/minf/stbl nesting."""
    return box(b"moov", box(b"trak", box(b"mdia", box(b"minf", box(b"stbl", table)))))


FTYP = box(b"ftyp", b"isom\x00\x00\x02\x00isomiso2")


def build(media: bytes, table_for, faststart: bool = False) -> bytes:
    """Assemble ftyp + mdat + moov, with chunk offsets pointing into mdat."""
    mdat_payload_at = len(FTYP) + 8
    moov = moov_with(table_for(mdat_payload_at))
    if faststart:
        return FTYP + moov + box(b"mdat", media)
    return FTYP + box(b"mdat", media) + moov


class TrailingMoovTests(unittest.TestCase):
    """The camera-original layout: moov after a large mdat."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.media = bytes((index * 7 + 3) % 256 for index in range(4096))
        # Four chunks, evenly spaced through the media.
        self.chunk_at = lambda base: stco([base, base + 1024, base + 2048, base + 3072])
        self.raw = build(self.media, self.chunk_at)
        self.path = Path(self.tmp.name) / "clip.mp4"
        self.path.write_bytes(self.raw)
        self.source = open_video(self.path)

    def tearDown(self):
        self.tmp.cleanup()

    def whole(self) -> bytes:
        return b"".join(self.source.chunks(0, self.source.size - 1, 512))

    def test_is_rearranged(self):
        self.assertTrue(self.source.rearranged)

    def test_length_is_preserved(self):
        self.assertEqual(self.source.size, len(self.raw))
        self.assertEqual(len(self.whole()), len(self.raw))

    def test_moov_now_precedes_mdat(self):
        out = Path(self.tmp.name) / "out.mp4"
        out.write_bytes(self.whole())
        order = [atom.type for atom in top_level_atoms(out)]
        self.assertEqual(order.index("moov"), order.index("ftyp") + 1)
        self.assertLess(order.index("moov"), order.index("mdat"))

    def test_ftyp_still_leads(self):
        self.assertEqual(self.whole()[4:8], b"ftyp")

    def test_chunk_offsets_still_address_their_own_bytes(self):
        """The invariant: every corrected offset lands on the original bytes."""
        original = self.raw
        rearranged = self.whole()
        old = [
            struct.unpack_from(">I", original, self._table_at(original) + 4 * i)[0]
            for i in range(4)
        ]
        new = [
            struct.unpack_from(">I", rearranged, self._table_at(rearranged) + 4 * i)[0]
            for i in range(4)
        ]
        self.assertNotEqual(old, new, "offsets should have moved")
        for before, after in zip(old, new):
            self.assertEqual(
                original[before : before + 64],
                rearranged[after : after + 64],
                f"offset {before} -> {after} lost its bytes",
            )

    def test_media_payload_is_intact(self):
        self.assertIn(self.media, self.whole())

    def _table_at(self, data: bytes) -> int:
        """Offset of the first stco entry within a serialised file."""
        marker = data.index(b"stco")
        return marker + 4 + 4 + 4  # type, version/flags, entry count

    # -- range reads ----------------------------------------------------

    def test_every_single_byte_range_matches_the_whole(self):
        whole = self.whole()
        for start in range(0, len(whole), 97):
            piece = b"".join(self.source.chunks(start, start, 512))
            self.assertEqual(piece, whole[start : start + 1], f"at {start}")

    def test_ranges_spanning_the_header_boundary(self):
        whole = self.whole()
        header = len(FTYP) + len(moov_with(self.chunk_at(0)))
        for start, end in [
            (0, header + 10),
            (header - 10, header + 10),
            (header - 1, header),
            (header, header + 50),
            (10, len(whole) - 1),
        ]:
            piece = b"".join(self.source.chunks(start, end, 64))
            self.assertEqual(piece, whole[start : end + 1], f"{start}-{end}")

    def test_tail_range(self):
        whole = self.whole()
        start = len(whole) - 100
        self.assertEqual(
            b"".join(self.source.chunks(start, len(whole) - 1, 512)), whole[start:]
        )

    def test_block_size_does_not_change_the_bytes(self):
        reference = self.whole()
        for block in (1, 7, 64, 4096, 1 << 20):
            joined = b"".join(self.source.chunks(0, self.source.size - 1, block))
            self.assertEqual(joined, reference, f"block={block}")


class Co64Tests(unittest.TestCase):
    def test_64_bit_offsets_are_shifted(self):
        tmp = tempfile.TemporaryDirectory()
        media = bytes(2048)
        raw = build(media, lambda base: co64([base, base + 1024]))
        path = Path(tmp.name) / "clip.mp4"
        path.write_bytes(raw)
        source = open_video(path)
        self.assertTrue(source.rearranged)
        out = b"".join(source.chunks(0, source.size - 1, 256))
        at = out.index(b"co64") + 12
        moov_size = len(moov_with(co64([0, 0])))
        base = len(FTYP) + 8
        self.assertEqual(struct.unpack_from(">Q", out, at)[0], base + moov_size)
        tmp.cleanup()


class ShiftTests(unittest.TestCase):
    def test_offsets_outside_the_window_are_left_alone(self):
        table = bytearray(moov_with(stco([10, 5000, 90_000])))
        moved = shift_chunk_offsets(table, 1000, (4000, 100_000))
        self.assertEqual(moved, 2)  # 10 is before the window
        at = table.index(b"stco") + 12
        self.assertEqual(struct.unpack_from(">I", table, at)[0], 10)
        self.assertEqual(struct.unpack_from(">I", table, at + 4)[0], 6000)
        self.assertEqual(struct.unpack_from(">I", table, at + 8)[0], 91_000)

    def test_32_bit_overflow_is_refused_rather_than_wrapped(self):
        table = bytearray(moov_with(stco([0xFFFFFF00])))
        with self.assertRaises(Mp4Error):
            shift_chunk_offsets(table, 0x200, (0, 0xFFFFFFFF))


class FallbackTests(unittest.TestCase):
    """Anything not understood is served untouched rather than guessed at."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name: str, data: bytes) -> Path:
        path = Path(self.tmp.name) / name
        path.write_bytes(data)
        return path

    def test_already_faststart_is_untouched(self):
        raw = build(bytes(1024), lambda base: stco([base]), faststart=True)
        source = open_video(self.write("fast.mp4", raw))
        self.assertFalse(source.rearranged)
        self.assertEqual(b"".join(source.chunks(0, len(raw) - 1, 256)), raw)

    def test_file_without_moov_is_untouched(self):
        raw = FTYP + box(b"mdat", bytes(256))
        source = open_video(self.write("nomoov.mp4", raw))
        self.assertFalse(source.rearranged)
        self.assertEqual(b"".join(source.chunks(0, len(raw) - 1, 256)), raw)

    def test_file_without_mdat_is_untouched(self):
        raw = FTYP + moov_with(stco([0]))
        self.assertFalse(open_video(self.write("nomdat.mp4", raw)).rearranged)

    def test_garbage_is_served_verbatim(self):
        raw = b"this is not an mp4 at all, not even close" * 4
        source = open_video(self.write("junk.bin", raw))
        self.assertFalse(source.rearranged)
        self.assertEqual(b"".join(source.chunks(0, len(raw) - 1, 16)), raw)

    def test_plain_source_reads_ranges(self):
        raw = bytes(range(256))
        source = VideoSource(self.write("plain.bin", raw))
        self.assertEqual(source.size, 256)
        self.assertEqual(b"".join(source.chunks(10, 19, 4)), raw[10:20])


if __name__ == "__main__":
    unittest.main()
