"""Unit tests for the HTTP Range parser.

A 2 GB video needs Range both to begin playback and to seek, and
``SimpleHTTPRequestHandler`` implements none of it.  These are the cases that
are easy to get subtly wrong.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.server import RangeNotSatisfiable, parse_range


SIZE = 1000
TESTVID = 2_078_188_644


class IgnoredHeaderTests(unittest.TestCase):
    """A header we cannot honour means a plain 200 with the whole body."""

    def test_absent_header(self):
        self.assertIsNone(parse_range(None, SIZE))

    def test_empty_header(self):
        self.assertIsNone(parse_range("", SIZE))

    def test_unsupported_unit(self):
        self.assertIsNone(parse_range("items=0-499", SIZE))

    def test_multi_range_is_declined(self):
        self.assertIsNone(parse_range("bytes=0-499,600-799", SIZE))

    def test_garbage(self):
        for header in ("bytes=abc", "bytes=", "bytes=-", "nonsense", "bytes=1-2-3"):
            self.assertIsNone(parse_range(header, SIZE), header)

    def test_reversed_range_is_declined(self):
        self.assertIsNone(parse_range("bytes=500-499", SIZE))


class ClosedRangeTests(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(parse_range("bytes=0-499", SIZE), (0, 499))

    def test_interior(self):
        self.assertEqual(parse_range("bytes=200-299", SIZE), (200, 299))

    def test_single_byte(self):
        self.assertEqual(parse_range("bytes=7-7", SIZE), (7, 7))

    def test_end_is_clamped_to_the_last_byte(self):
        self.assertEqual(parse_range("bytes=0-1500", SIZE), (0, SIZE - 1))

    def test_final_byte(self):
        self.assertEqual(parse_range("bytes=999-999", SIZE), (999, 999))

    def test_surrounding_whitespace_is_tolerated(self):
        self.assertEqual(parse_range("  bytes=0-499  ", SIZE), (0, 499))


class OpenRangeTests(unittest.TestCase):
    def test_open_ended_runs_to_the_last_byte(self):
        self.assertEqual(parse_range("bytes=500-", SIZE), (500, SIZE - 1))

    def test_whole_file(self):
        self.assertEqual(parse_range("bytes=0-", SIZE), (0, SIZE - 1))

    def test_last_byte_only(self):
        self.assertEqual(parse_range("bytes=999-", SIZE), (999, 999))


class SuffixRangeTests(unittest.TestCase):
    def test_last_n_bytes(self):
        self.assertEqual(parse_range("bytes=-500", SIZE), (500, SIZE - 1))

    def test_suffix_longer_than_the_file_yields_the_whole_file(self):
        self.assertEqual(parse_range("bytes=-1500", SIZE), (0, SIZE - 1))

    def test_zero_length_suffix_is_unsatisfiable(self):
        with self.assertRaises(RangeNotSatisfiable):
            parse_range("bytes=-0", SIZE)


class UnsatisfiableTests(unittest.TestCase):
    def test_start_at_the_length(self):
        with self.assertRaises(RangeNotSatisfiable):
            parse_range("bytes=1000-", SIZE)

    def test_start_beyond_the_length(self):
        with self.assertRaises(RangeNotSatisfiable):
            parse_range("bytes=5000-6000", SIZE)

    def test_any_range_on_an_empty_file(self):
        with self.assertRaises(RangeNotSatisfiable):
            parse_range("bytes=0-", 0)


class LargeFileTests(unittest.TestCase):
    """The real video is past 2^31; nothing may overflow or truncate."""

    def test_seek_near_the_end(self):
        self.assertEqual(
            parse_range("bytes=2000000000-", TESTVID), (2_000_000_000, TESTVID - 1)
        )

    def test_opening_chunk(self):
        self.assertEqual(parse_range("bytes=0-1048575", TESTVID), (0, 1_048_575))

    def test_suffix_of_a_large_file(self):
        self.assertEqual(
            parse_range("bytes=-65536", TESTVID), (TESTVID - 65_536, TESTVID - 1)
        )

    def test_length_is_exact(self):
        start, end = parse_range("bytes=1234567890-1234567899", TESTVID)
        self.assertEqual(end - start + 1, 10)


if __name__ == "__main__":
    unittest.main()
