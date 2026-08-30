"""The library: what it finds on disk, what it names it, what it hides."""

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.library import Entry, VideoLibrary, display_title, slug


class TitleTests(unittest.TestCase):
    def test_a_plain_name_survives(self):
        self.assertEqual(display_title("Sunrise over the fjord"),
                         "Sunrise over the fjord")

    def test_the_downloaders_format_tag_is_dropped(self):
        self.assertEqual(display_title("A scenic drive.f571"), "A scenic drive")

    def test_only_a_trailing_format_tag_is_dropped(self):
        self.assertEqual(display_title("Route 66.f1 revisited"),
                         "Route 66.f1 revisited")

    def test_fullwidth_stand_ins_become_real_punctuation(self):
        self.assertEqual(display_title("Waterfall in 8K ｜ Oregon"),
                         "Waterfall in 8K | Oregon")

    def test_a_name_of_nothing_but_a_tag_keeps_the_stem(self):
        self.assertEqual(display_title(".f313"), ".f313")


class SlugTests(unittest.TestCase):
    def test_punctuation_and_case_collapse(self):
        self.assertEqual(slug(Path("8K VR: Mount Rainier — Part 3!.mp4")),
                         "8k-vr-mount-rainier-part-3")

    def test_a_name_with_no_usable_characters_still_gets_an_id(self):
        self.assertEqual(slug(Path("....mp4")), "clip")

    def test_ids_are_bounded(self):
        self.assertLessEqual(len(slug(Path("x" * 400 + ".mp4"))), 60)


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.videos = self.root / "videos"
        self.videos.mkdir()
        self.library = VideoLibrary(self.videos, self.root / "thumbs")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, body=b"0123456789"):
        path = self.videos / name
        path.write_bytes(body)
        return path

    def ids(self):
        return [entry.id for entry in self.library.scan()]

    def test_playable_files_are_found(self):
        self.write("a.mp4")
        self.write("b.webm")
        self.assertEqual(self.ids(), ["a", "b"])

    def test_other_files_are_ignored(self):
        self.write("notes.txt")
        self.write("cover.jpg")
        self.assertEqual(self.ids(), [])

    def test_part_files_are_ignored(self):
        self.write("clip.mp4.part")
        self.assertEqual(self.ids(), [])

    def test_unmerged_streams_are_ignored(self):
        """yt-dlp's per-format files would otherwise double every entry."""
        self.write("clip.mp4")
        self.write("clip.f313.mp4")
        self.write("clip.f251.webm")
        self.assertEqual(self.ids(), ["clip"])

    def test_names_that_slugify_alike_still_get_separate_ids(self):
        self.write("A Clip.mp4")
        self.write("a-clip.mp4")
        self.assertEqual(sorted(self.ids()), ["a-clip", "a-clip-2"])

    def test_entries_are_sorted_by_name(self):
        for name in ("zebra.mp4", "Alpha.mp4", "middle.mp4"):
            self.write(name)
        self.assertEqual(self.ids(), ["alpha", "middle", "zebra"])

    def test_a_missing_folder_is_an_empty_library_not_a_crash(self):
        library = VideoLibrary(self.root / "gone", self.root / "thumbs")
        self.assertEqual(library.scan(), [])
        self.assertEqual(library.describe()["total"], 0)

    def test_only_restricts_the_listing_to_one_file(self):
        self.write("one.mp4")
        self.write("two.mp4")
        library = VideoLibrary(self.videos, self.root / "thumbs", only="two.mp4")
        self.assertEqual([entry.id for entry in library.scan()], ["two"])

    def test_a_probed_entry_survives_a_rescan(self):
        self.write("clip.mp4")
        first = self.library.scan()[0]
        first.duration = 61.0
        first.probed = True
        self.assertEqual(self.library.scan()[0].duration, 61.0)

    def test_a_replaced_file_is_probed_again(self):
        path = self.write("clip.mp4")
        first = self.library.scan()[0]
        first.duration = 61.0
        first.probed = True
        path.write_bytes(b"a different, longer set of bytes entirely")
        self.assertFalse(self.library.scan()[0].probed)

    def test_a_removed_file_leaves_the_listing(self):
        path = self.write("clip.mp4")
        self.assertEqual(self.ids(), ["clip"])
        path.unlink()
        self.assertEqual(self.ids(), [])

    def test_source_is_cached_per_clip(self):
        self.write("clip.mp4")
        self.library.scan()
        self.assertIs(self.library.source("clip"), self.library.source("clip"))

    def test_source_for_an_unknown_id_is_none(self):
        self.assertIsNone(self.library.source("nope"))

    def test_only_a_bounded_number_of_sources_stay_open(self):
        from gaze360.library import SOURCES_CACHED

        for index in range(SOURCES_CACHED + 3):
            self.write(f"clip{index}.mp4")
        self.library.scan()
        for index in range(SOURCES_CACHED + 3):
            self.library.source(f"clip{index}")
        self.assertEqual(len(self.library._sources), SOURCES_CACHED)

    def test_describe_reports_what_the_start_screen_needs(self):
        self.write("clip.mp4")
        payload = self.library.describe()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["ready"], 0)  # no thumbnail built yet
        self.assertFalse(payload["clips"][0]["thumb"])


class SettleTests(unittest.TestCase):
    """A file still being written must not be offered as playable.

    The downloader's temporary names are easy to skip, but the mux step
    writes straight to the final .mp4, so a file with the right name and no
    .part suffix can still be growing.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.videos = self.root / "videos"
        self.videos.mkdir()
        self.library = VideoLibrary(self.videos, self.root / "thumbs")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, body=b"0123456789", age=None):
        path = self.videos / name
        path.write_bytes(body)
        if age is not None:
            when = time.time() - age
            os.utime(path, (when, when))
        return path

    def settled(self):
        return {entry.id: entry.settled for entry in self.library.scan()}

    def test_a_file_written_a_moment_ago_is_held_back(self):
        self.write("clip.mp4")
        self.assertFalse(self.settled()["clip"])

    def test_a_file_untouched_for_a_while_is_playable(self):
        self.write("clip.mp4", age=3600)
        self.assertTrue(self.settled()["clip"])

    def test_a_settled_file_stays_settled_across_repeated_scans(self):
        """Being looked at is not evidence that a file is changing."""
        self.write("clip.mp4", age=3600)
        for _ in range(5):
            self.assertTrue(self.settled()["clip"])

    def test_a_file_seen_to_grow_is_held_back_even_with_an_old_mtime(self):
        """Some filesystems are lazy about the mtime of an open file."""
        path = self.write("clip.mp4", age=3600)
        self.assertTrue(self.settled()["clip"])
        path.write_bytes(b"considerably more content than before")
        when = time.time() - 3600
        os.utime(path, (when, when))  # backdate again: only the size moved
        self.assertFalse(self.settled()["clip"])

    def test_an_unsettled_file_is_still_listed(self):
        """The grid should show what is coming, not hide it."""
        self.write("clip.mp4")
        self.assertEqual(self.library.describe()["total"], 1)
        self.assertEqual(self.library.describe()["downloading"], 1)

    def test_a_growing_file_is_not_probed_or_thumbnailed(self):
        self.write("clip.mp4")
        self.library._prepare_pass()
        self.assertFalse(self.library.scan()[0].probed)

    def test_forgetting_a_file_that_goes_away(self):
        path = self.write("clip.mp4", age=3600)
        self.library.scan()
        path.unlink()
        self.library.scan()
        self.assertEqual(self.library._seen, {})


class SeekTests(unittest.TestCase):
    """Where in a clip the thumbnail frame is taken from."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.library = VideoLibrary(root, root / "thumbs")

    def tearDown(self):
        self.tmp.cleanup()

    def seek(self, duration):
        entry = Entry(id="x", title="x", path=Path("x.mp4"), size=1, mtime=0.0,
                      duration=duration)
        return self.library._seek_to(entry)

    def test_a_fifth_of_the_way_into_a_short_clip(self):
        self.assertAlmostEqual(self.seek(60.0), 12.0)

    def test_a_long_clip_is_capped_rather_than_sampled_near_the_middle(self):
        self.assertAlmostEqual(self.seek(3600.0), 120.0)

    def test_a_very_short_clip_is_not_seeked_past_its_end(self):
        """A 3 s clip once got a 4 s seek, and produced no frame at all."""
        for duration in (0.5, 1.0, 3.0, 4.0):
            with self.subTest(duration=duration):
                self.assertLess(self.seek(duration), duration)

    def test_the_seek_is_never_negative(self):
        self.assertGreaterEqual(self.seek(0.2), 0.0)

    def test_an_unprobed_clip_gets_a_fixed_guess(self):
        self.assertEqual(self.seek(None), 20.0)


class QualityTests(unittest.TestCase):
    """360 clips are named by the width of the equirectangular frame."""

    def entry(self, width=None, height=None):
        return Entry(id="x", title="x", path=Path("x.mp4"), size=1, mtime=0.0,
                     width=width, height=height)

    def test_the_usual_360_resolutions(self):
        self.assertEqual(self.entry(7680, 3840).quality, "8K")
        self.assertEqual(self.entry(5760, 2880).quality, "6K")
        self.assertEqual(self.entry(5120, 2560).quality, "5K")
        self.assertEqual(self.entry(3840, 1920).quality, "4K")
        self.assertEqual(self.entry(1920, 960).quality, "2K")

    def test_a_frame_below_the_named_sizes_falls_back_to_its_height(self):
        self.assertEqual(self.entry(1280, 640).quality, "640p")

    def test_a_missing_width_is_inferred_from_the_2_to_1_frame(self):
        """An equirectangular frame is twice as wide as it is tall."""
        self.assertEqual(self.entry(height=3840).quality, "8K")

    def test_an_unprobed_clip_has_no_label(self):
        self.assertIsNone(self.entry().quality)

    def test_content_type_follows_the_extension(self):
        webm = Entry(id="x", title="x", path=Path("x.webm"), size=1, mtime=0.0)
        self.assertEqual(webm.content_type, "video/webm")


if __name__ == "__main__":
    unittest.main()
