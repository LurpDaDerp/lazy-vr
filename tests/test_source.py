"""The YouTube source: what counts as a clip, and which format wins.

Every function under test is pure over yt-dlp's dictionaries, so nothing
here touches yt-dlp or the network.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import source  # noqa: E402


def entry(**overrides):
    base = {"id": "abcdefghijk", "title": "A field in spring", "channel": "Someone",
            "duration": 300, "url": "https://www.youtube.com/watch?v=abcdefghijk",
            "view_count": 1234}
    base.update(overrides)
    return base


def video_fmt(**overrides):
    base = {"url": "https://example.test/v", "protocol": "https", "vcodec": "vp9",
            "acodec": "none", "height": 2160, "width": 3840, "fps": 30, "tbr": 20000,
            "ext": "webm", "format_id": "313"}
    base.update(overrides)
    return base


def audio_fmt(**overrides):
    base = {"url": "https://example.test/a", "protocol": "https", "vcodec": "none",
            "acodec": "opus", "abr": 160, "language_preference": 10, "ext": "webm",
            "format_id": "251"}
    base.update(overrides)
    return base


class SearchUrlTests(unittest.TestCase):
    def test_the_360_filter_rides_along(self):
        url = source.search_url("northern lights")
        self.assertIn("search_query=northern+lights", url)
        self.assertIn("sp=EgJ4AQ%3D%3D", url)


class ToClipTests(unittest.TestCase):
    def test_a_plain_entry_becomes_a_card(self):
        clip = source.to_clip(entry())
        self.assertEqual(clip["id"], "abcdefghijk")
        self.assertEqual(clip["title"], "A field in spring")
        self.assertEqual(clip["channel"], "Someone")
        self.assertEqual(clip["duration"], 300)
        self.assertIn("abcdefghijk/mqdefault.jpg", clip["thumb"])

    def test_uploader_stands_in_for_channel(self):
        clip = source.to_clip(entry(channel=None, uploader="Backup Name"))
        self.assertEqual(clip["channel"], "Backup Name")

    def test_unknown_duration_is_kept(self):
        self.assertIsNotNone(source.to_clip(entry(duration=None)))

    def test_the_unusable_are_skipped(self):
        self.assertIsNone(source.to_clip(entry(id=None)))
        self.assertIsNone(source.to_clip(entry(title="  ")))
        self.assertIsNone(source.to_clip(entry(title="[Private video]")))
        self.assertIsNone(source.to_clip(entry(live_status="is_live")))
        self.assertIsNone(source.to_clip(entry(duration=12)))
        self.assertIsNone(source.to_clip(entry(url="https://www.youtube.com/shorts/abcdefghijk")))


class CodecFamilyTests(unittest.TestCase):
    def test_the_three_families(self):
        self.assertEqual(source.codec_family("vp09.00.50.08"), "vp9")
        self.assertEqual(source.codec_family("vp9"), "vp9")
        self.assertEqual(source.codec_family("av01.0.16M.08"), "av01")
        self.assertEqual(source.codec_family("avc1.640033"), "avc1")


class PickVideoTests(unittest.TestCase):
    def test_the_tallest_wins(self):
        formats = [video_fmt(height=1080, format_id="a"),
                   video_fmt(height=4320, format_id="b"),
                   video_fmt(height=2160, format_id="c")]
        self.assertEqual(source.pick_video(formats)["format_id"], "b")

    def test_the_cap_is_respected(self):
        formats = [video_fmt(height=4320, format_id="a"), video_fmt(height=2160, format_id="b")]
        self.assertEqual(source.pick_video(formats, max_height=2160)["format_id"], "b")

    def test_the_browsers_codec_order_breaks_height_ties(self):
        formats = [video_fmt(vcodec="av01.0.16M.08", format_id="av"),
                   video_fmt(vcodec="vp09.00.50.08", format_id="vp")]
        self.assertEqual(source.pick_video(formats, codecs=("vp9", "av01"))["format_id"], "vp")
        self.assertEqual(source.pick_video(formats, codecs=("av01", "vp9"))["format_id"], "av")

    def test_unsupported_codecs_are_never_picked(self):
        formats = [video_fmt(vcodec="av01.0.16M.08", height=4320)]
        self.assertIsNone(source.pick_video(formats, codecs=("avc1",)))

    def test_video_only_beats_muxed(self):
        formats = [video_fmt(height=720, acodec="mp4a.40.2", format_id="muxed"),
                   video_fmt(height=720, format_id="clean")]
        self.assertEqual(source.pick_video(formats)["format_id"], "clean")

    def test_higher_fps_breaks_full_ties(self):
        formats = [video_fmt(fps=30, format_id="slow"), video_fmt(fps=60, format_id="fast")]
        self.assertEqual(source.pick_video(formats)["format_id"], "fast")

    def test_playlists_storyboards_and_manifests_are_ignored(self):
        formats = [video_fmt(protocol="m3u8_native"),
                   video_fmt(url=None),
                   video_fmt(vcodec="none"),
                   video_fmt(height=None)]
        self.assertIsNone(source.pick_video(formats))


class PickAudioTests(unittest.TestCase):
    def test_the_original_language_wins_over_bitrate(self):
        formats = [audio_fmt(language_preference=-1, abr=999, format_id="dub"),
                   audio_fmt(language_preference=10, abr=128, format_id="orig")]
        self.assertEqual(source.pick_audio(formats)["format_id"], "orig")

    def test_safari_gets_mp4a(self):
        formats = [audio_fmt(acodec="opus", format_id="op"),
                   audio_fmt(acodec="mp4a.40.2", ext="m4a", format_id="aac")]
        self.assertEqual(source.pick_audio(formats, prefer_mp4a=True)["format_id"], "aac")
        self.assertEqual(source.pick_audio(formats, prefer_mp4a=False)["format_id"], "op")

    def test_video_tracks_are_not_audio(self):
        self.assertIsNone(source.pick_audio([video_fmt(acodec="mp4a.40.2")
                                             | {"vcodec": "vp9"}]))


class PickStreamsTests(unittest.TestCase):
    def test_separate_tracks_come_back_as_a_pair(self):
        picked = source.pick_streams({"formats": [video_fmt(), audio_fmt()]})
        self.assertEqual(picked["video"]["format_id"], "313")
        self.assertEqual(picked["audio"]["format_id"], "251")
        self.assertFalse(picked["combined"])

    def test_a_muxed_pick_carries_its_own_sound(self):
        picked = source.pick_streams({"formats": [video_fmt(acodec="mp4a.40.2")]})
        self.assertTrue(picked["combined"])
        self.assertIsNone(picked["audio"])

    def test_a_silent_clip_is_video_and_nothing(self):
        picked = source.pick_streams({"formats": [video_fmt()]})
        self.assertFalse(picked["combined"])
        self.assertIsNone(picked["audio"])

    def test_nothing_playable_is_an_error(self):
        with self.assertRaises(LookupError):
            source.pick_streams({"formats": []})


class ExpiryTests(unittest.TestCase):
    def test_the_url_says_when_it_dies(self):
        self.assertEqual(source.stream_expiry("https://r1.googlevideo.com/x?expire=1700000000&y=1", now=0), 1700000000.0)

    def test_without_a_stamp_assume_four_hours(self):
        self.assertEqual(source.stream_expiry("https://r1.googlevideo.com/x", now=1000.0), 1000.0 + 4 * 3600)


class TTLCacheTests(unittest.TestCase):
    def test_a_value_lives_for_its_ttl_and_no_longer(self):
        clock = [0.0]
        cache = source.TTLCache(clock=lambda: clock[0])
        cache.put("k", "v", 10)
        self.assertEqual(cache.get("k"), "v")
        clock[0] = 9.9
        self.assertEqual(cache.get("k"), "v")
        clock[0] = 10.0
        self.assertIsNone(cache.get("k"))

    def test_drop_forgets(self):
        cache = source.TTLCache(clock=lambda: 0.0)
        cache.put("k", "v", 10)
        cache.drop("k")
        self.assertIsNone(cache.get("k"))


class CookieTests(unittest.TestCase):
    """yt-dlp authentication comes from the server's environment -- a site
    can never read a visitor's own youtube cookies, and must not try."""

    def test_no_configuration_asks_for_nothing(self):
        self.assertEqual(source.cookie_options({}), {})

    def test_a_cookie_file_path(self):
        self.assertEqual(source.cookie_options({"LAZYVR_COOKIES_FILE": "/x/c.txt"}),
                         {"cookiefile": "/x/c.txt"})

    def test_a_browser_with_and_without_a_profile(self):
        self.assertEqual(source.cookie_options({"LAZYVR_COOKIES_FROM_BROWSER": "chrome"}),
                         {"cookiesfrombrowser": ("chrome",)})
        self.assertEqual(source.cookie_options({"LAZYVR_COOKIES_FROM_BROWSER": "chrome:Profile 1"}),
                         {"cookiesfrombrowser": ("chrome", "Profile 1")})

    def test_cookies_by_value_become_one_real_file(self):
        source._cookie_path = None
        try:
            options = source.cookie_options({"LAZYVR_COOKIES": "# Netscape HTTP Cookie File\n"})
            path = Path(options["cookiefile"])
            self.assertTrue(path.is_file())
            self.assertIn("Netscape", path.read_text(encoding="utf-8"))
            again = source.cookie_options({"LAZYVR_COOKIES": "ignored the second time"})
            self.assertEqual(Path(again["cookiefile"]), path)
        finally:
            if source._cookie_path:
                Path(source._cookie_path).unlink(missing_ok=True)
            source._cookie_path = None

    def test_by_value_wins_over_a_path_wins_over_a_browser(self):
        env = {"LAZYVR_COOKIES_FILE": "/x/c.txt", "LAZYVR_COOKIES_FROM_BROWSER": "chrome"}
        self.assertEqual(source.cookie_options(env), {"cookiefile": "/x/c.txt"})

    def test_blank_content_is_no_configuration(self):
        self.assertEqual(source.cookie_options({"LAZYVR_COOKIES": "  \n"}), {})

    def test_the_options_ride_into_every_ydl_call(self):
        options = source.ydl_options(noplaylist=True)
        self.assertTrue(options["quiet"])
        self.assertTrue(options["noplaylist"])


class CategoryTests(unittest.TestCase):
    def test_shelves_are_distinct_and_complete(self):
        ids = [c["id"] for c in source.CATEGORIES]
        self.assertEqual(len(ids), len(set(ids)))
        for category in source.CATEGORIES:
            self.assertTrue(category["title"])
            self.assertTrue(category["query"])


if __name__ == "__main__":
    unittest.main()
