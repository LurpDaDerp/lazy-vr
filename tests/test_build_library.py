"""The manifest builder: what it finds, what it names, what it leaves out."""

import json
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import build_library as bl  # noqa: E402


def finished(path, body=b"0123456789"):
    """A file that looks like a completed download: an old mtime."""
    path.write_bytes(body)
    old = time.time() - 3600
    os.utime(path, (old, old))
    return path


def atom(kind, payload=b""):
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


class TitleTests(unittest.TestCase):
    def test_a_plain_name_survives(self):
        self.assertEqual(bl.display_title("Sunrise over the fjord"), "Sunrise over the fjord")

    def test_the_downloaders_format_tag_is_dropped(self):
        self.assertEqual(bl.display_title("A scenic drive.f571"), "A scenic drive")

    def test_fullwidth_stand_ins_become_real_punctuation(self):
        self.assertEqual(bl.display_title("Waterfall in 8K ｜ Oregon"), "Waterfall in 8K | Oregon")


class SlugTests(unittest.TestCase):
    def test_punctuation_and_case_collapse(self):
        self.assertEqual(bl.slug(Path("8K VR: Mount Rainier — Part 3!.mp4")), "8k-vr-mount-rainier-part-3")

    def test_a_name_with_no_usable_characters_still_gets_an_id(self):
        self.assertEqual(bl.slug(Path("....mp4")), "clip")

    def test_ids_are_bounded(self):
        self.assertLessEqual(len(bl.slug(Path("x" * 400 + ".mp4"))), 60)


class QualityTests(unittest.TestCase):
    """360 clips are named by the width of the equirectangular frame."""

    def test_the_usual_360_resolutions(self):
        self.assertEqual(bl.quality(7680, 3840), "8K")
        self.assertEqual(bl.quality(3840, 1920), "4K")
        self.assertEqual(bl.quality(1920, 960), "2K")
        self.assertEqual(bl.quality(1280, 640), "640p")
        self.assertEqual(bl.quality(None, 3840), "8K")
        self.assertIsNone(bl.quality(None, None))


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.videos = Path(self.tmp.name) / "videos"
        self.videos.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def ids(self):
        return [clip.id for clip in bl.scan(self.videos)]

    def test_playable_files_are_found_and_sorted(self):
        for name in ("zebra.mp4", "Alpha.webm", "middle.mp4"):
            finished(self.videos / name)
        self.assertEqual(self.ids(), ["alpha", "middle", "zebra"])

    def test_other_files_and_downloader_leftovers_are_ignored(self):
        finished(self.videos / "notes.txt")
        finished(self.videos / "clip.mp4.part")
        finished(self.videos / "clip.f313.mp4")
        finished(self.videos / "clip.mp4")
        self.assertEqual(self.ids(), ["clip"])

    def test_names_that_slugify_alike_still_get_separate_ids(self):
        finished(self.videos / "A Clip.mp4")
        finished(self.videos / "a-clip.mp4")
        self.assertEqual(sorted(self.ids()), ["a-clip", "a-clip-2"])

    def test_a_file_written_a_moment_ago_is_not_settled(self):
        (self.videos / "clip.mp4").write_bytes(b"0123456789")
        clip = bl.scan(self.videos)[0]
        self.assertFalse(clip.settled)

    def test_a_missing_folder_is_an_empty_library(self):
        self.assertEqual(bl.scan(Path(self.tmp.name) / "gone"), [])


class FaststartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_index_before_media_is_faststart(self):
        path = self.root / "a.mp4"
        path.write_bytes(atom(b"ftyp", b"isom") + atom(b"moov", b"x" * 20) + atom(b"mdat", b"y" * 100))
        self.assertTrue(bl.is_faststart(path))

    def test_index_after_media_is_not(self):
        path = self.root / "b.mp4"
        path.write_bytes(atom(b"ftyp", b"isom") + atom(b"mdat", b"y" * 100) + atom(b"moov", b"x" * 20))
        self.assertFalse(bl.is_faststart(path))

    def test_webm_has_no_such_question(self):
        path = self.root / "c.webm"
        path.write_bytes(b"\x1a\x45\xdf\xa3" + b"\x00" * 50)
        self.assertIsNone(bl.is_faststart(path))

    def test_garbage_is_not_mistaken_for_either(self):
        path = self.root / "d.mp4"
        path.write_bytes(b"not an mp4 at all, just bytes")
        self.assertIsNone(bl.is_faststart(path))


class ManifestTests(unittest.TestCase):
    def test_the_entry_carries_an_encoded_url_under_the_base(self):
        clip = bl.Clip("a-clip", "A clip", Path("A clip & more.mp4"), 10, 0.0, 61.0, 3840, 1920, "vp9")
        entry = bl.manifest_entry(clip, "https://cdn.example.com/lazyvr/")
        self.assertEqual(entry["src"], "https://cdn.example.com/lazyvr/A%20clip%20%26%20more.mp4")
        self.assertEqual(entry["quality"], "4K")
        self.assertEqual(entry["duration"], 61.0)

    def test_seek_stays_inside_a_short_clip(self):
        short = bl.Clip("x", "x", Path("x.mp4"), 1, 0.0, duration=3.0)
        self.assertLess(bl.seek_for(short), 3.0)
        self.assertGreaterEqual(bl.seek_for(short), 0.0)
        long = bl.Clip("x", "x", Path("x.mp4"), 1, 0.0, duration=3600.0)
        self.assertEqual(bl.seek_for(long), 120.0)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class BuildTests(unittest.TestCase):
    """The whole tool over a real, tiny clip."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.videos = root / "videos"
        cls.videos.mkdir()
        cls.site = root / "site"
        clip = cls.videos / "Test Pattern 360.mp4"
        bl.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=640x320:rate=10:duration=2",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(clip)], 120)
        old = time.time() - 3600
        os.utime(clip, (old, old))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_build_writes_a_manifest_and_a_thumbnail(self):
        included, excluded = bl.build(self.videos, self.site, "videos/", False, False, log=lambda *_: None)
        self.assertEqual(len(included), 1)
        self.assertEqual(excluded, [])
        manifest = json.loads((self.site / "library.json").read_text(encoding="utf-8"))
        entry = manifest["clips"][0]
        self.assertEqual(entry["src"], "videos/Test%20Pattern%20360.mp4")
        self.assertEqual(entry["thumb"], "thumbs/test-pattern-360.jpg")
        self.assertTrue((self.site / "thumbs" / "test-pattern-360.jpg").is_file())
        self.assertAlmostEqual(entry["duration"], 2.0, places=1)
        self.assertEqual(entry["width"], 640)

    def test_check_writes_nothing(self):
        site = Path(self.tmp.name) / "site-check"
        bl.build(self.videos, site, "videos/", True, False, log=lambda *_: None)
        self.assertFalse((site / "library.json").exists())


if __name__ == "__main__":
    unittest.main()
