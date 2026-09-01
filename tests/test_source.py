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

    def test_a_crowded_cache_sweeps_its_dead_on_put(self):
        clock = [0.0]
        cache = source.TTLCache(clock=lambda: clock[0])
        for i in range(source.TTLCache.SWEEP_AT):
            cache.put(f"old{i}", i, 5)
        clock[0] = 10.0  # everything above is now expired
        cache.put("fresh", "v", 5)
        self.assertEqual(len(cache._values), 1)
        self.assertEqual(cache.get("fresh"), "v")


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


class PlayableTests(unittest.TestCase):
    """What "youtube gave us something we can use" means, before any codec
    preference gets a say: at least one plain-https video track."""

    def test_a_real_format_list_is_playable(self):
        self.assertTrue(source.has_playable({"formats": [video_fmt(), audio_fmt()]}))

    def test_storyboards_and_manifests_are_not(self):
        self.assertFalse(source.has_playable({"formats": [
            video_fmt(protocol="m3u8_native"),
            video_fmt(vcodec="none", acodec="none", format_id="sb0"),
            audio_fmt(),
        ]}))

    def test_nothing_at_all_is_not(self):
        self.assertFalse(source.has_playable({}))
        self.assertFalse(source.has_playable({"formats": []}))


class TotalSizeTests(unittest.TestCase):
    def test_the_total_after_the_slash(self):
        self.assertEqual(source.total_size("bytes 0-1023/44459615"), 44459615)
        self.assertEqual(source.total_size("bytes 100-200/201"), 201)

    def test_an_unknown_total_is_no_total(self):
        for header in (None, "", "bytes 0-1023/*", "bytes 0-1023", "nonsense"):
            self.assertIsNone(source.total_size(header), header)


class ParseRangeTests(unittest.TestCase):
    def test_absent_means_the_whole_thing_from_the_start(self):
        self.assertEqual(source.parse_range(None), (0, None))
        self.assertEqual(source.parse_range(""), (0, None))
        self.assertEqual(source.parse_range("   "), (0, None))

    def test_the_two_forms_a_media_element_sends(self):
        self.assertEqual(source.parse_range("bytes=0-"), (0, None))
        self.assertEqual(source.parse_range("bytes=1000-"), (1000, None))
        self.assertEqual(source.parse_range("bytes=100-200"), (100, 200))

    def test_whitespace_and_case_do_not_matter(self):
        self.assertEqual(source.parse_range(" BYTES = 5 - 9 "), (5, 9))

    def test_what_we_decline_to_understand(self):
        # A suffix range means the *last* N bytes; multipart is several at
        # once.  Neither is worth guessing at, and no media element sends
        # them -- None says "pass this through as it came".
        for header in ("bytes=-500", "bytes=0-10,20-30", "items=0-5", "nonsense", "bytes=x-y", "bytes="):
            self.assertIsNone(source.parse_range(header), header)


class RangeTests(unittest.TestCase):
    """googlevideo answers a bounded range and refuses an open-ended one
    with a flat 403 on some clients' URLs -- and an open-ended range is
    exactly what a <video> element asks for first."""

    W = source.UPSTREAM_WINDOW

    def test_no_range_at_all_still_asks_for_a_window(self):
        self.assertEqual(source.bounded_range(None), f"bytes=0-{self.W - 1}")
        self.assertEqual(source.bounded_range(""), f"bytes=0-{self.W - 1}")

    def test_the_open_ended_form_a_video_element_sends_gets_an_end(self):
        self.assertEqual(source.bounded_range("bytes=0-"), f"bytes=0-{self.W - 1}")
        self.assertEqual(source.bounded_range("bytes=1000-"), f"bytes=1000-{1000 + self.W - 1}")

    def test_a_range_smaller_than_the_window_is_left_alone(self):
        self.assertEqual(source.bounded_range("bytes=0-99"), "bytes=0-99")
        self.assertEqual(source.bounded_range("bytes=500-1500"), "bytes=500-1500")

    def test_a_range_larger_than_the_window_is_cut_down(self):
        self.assertEqual(source.bounded_range("bytes=0-999999999"), f"bytes=0-{self.W - 1}")

    def test_the_window_is_configurable(self):
        self.assertEqual(source.bounded_range("bytes=0-", window=1024), "bytes=0-1023")

    def test_whitespace_and_case_do_not_matter(self):
        self.assertEqual(source.bounded_range(" BYTES = 10 - "), f"bytes=10-{10 + self.W - 1}")

    def test_forms_we_do_not_understand_pass_through_untouched(self):
        # A suffix range means the *last* N bytes; rewriting it would hand
        # back the wrong part of the file, so it goes as it came.
        for header in ("bytes=-500", "bytes=0-10,20-30", "items=0-5", "nonsense"):
            self.assertEqual(source.bounded_range(header), header)


class PlayerClientTests(unittest.TestCase):
    """Which of youtube's player clients we ask, and in what order."""

    def test_the_first_rung_needs_no_token_and_no_cookie(self):
        ladder = source.client_ladder({})
        self.assertEqual(ladder[0], source.FREE_CLIENTS)
        self.assertIn("visionos", ladder[0])

    def test_the_client_whose_urls_never_serve_is_not_asked(self):
        # android_vr resolves from any IP and then 403s every byte request.
        # A client that resolves and cannot stream is worse than none:
        # pick_video would choose its track over an identical playable one.
        for rung in source.client_ladder({}):
            self.assertNotIn("android_vr", rung)

    def test_later_rungs_widen_rather_than_replace(self):
        ladder = source.client_ladder({})
        self.assertGreater(len(ladder), 1)
        for rung in ladder[1:]:
            self.assertTrue(set(source.FREE_CLIENTS) <= set(rung))
        # Every rung is strictly bigger than the one before it.
        for earlier, later in zip(ladder, ladder[1:]):
            self.assertLess(len(earlier), len(later))

    def test_the_environment_can_name_the_clients_itself(self):
        ladder = source.client_ladder({"LAZYVR_PLAYER_CLIENTS": "ios, tv , "})
        self.assertEqual(ladder, [("ios", "tv")])

    def test_a_blank_override_is_no_override(self):
        self.assertEqual(source.client_ladder({"LAZYVR_PLAYER_CLIENTS": "  "}),
                         source.client_ladder({}))


class YdlOptionTests(unittest.TestCase):
    def test_a_format_list_with_no_winner_is_not_an_error(self):
        # We want the formats, never yt-dlp's own pick; without this the
        # whole library falls back to the embed the moment youtube trims
        # the list.
        self.assertTrue(source.ydl_options()["ignore_no_formats_error"])

    def test_the_asked_clients_reach_the_extractor(self):
        args = source.ydl_options(clients=("android_vr", "visionos"))["extractor_args"]["youtube"]
        self.assertEqual(args["player_client"], ["android_vr", "visionos"])
        self.assertIn("missing_pot", args["formats"])

    def test_without_clients_the_extractor_is_left_alone(self):
        self.assertNotIn("extractor_args", source.ydl_options())

    def test_cookies_and_extras_still_ride_along(self):
        options = source.ydl_options(noplaylist=True)
        self.assertTrue(options["quiet"])
        self.assertTrue(options["noplaylist"])

    def test_a_proxy_when_the_environment_names_one(self):
        self.assertEqual(source.proxy_options({}), {})
        self.assertEqual(source.proxy_options({"LAZYVR_PROXY": "socks5://h:9"}),
                         {"proxy": "socks5://h:9"})
        self.assertEqual(source.proxy_options({"LAZYVR_PROXY": "  "}), {})

    def test_impersonation_is_asked_for_only_when_it_can_be_had(self):
        # An unavailable target is an error at request time, not a warning,
        # so this must never ask for one it cannot produce.
        options = source.impersonate_options()
        self.assertIsInstance(options, dict)
        self.assertLessEqual(set(options), {"impersonate"})
        self.assertEqual(options, source.impersonate_options())  # and it is cached

    def test_impersonation_can_be_switched_off(self):
        self.assertEqual(source.impersonate_options({"LAZYVR_IMPERSONATE": "off"}), {})


class CategoryTests(unittest.TestCase):
    def test_shelves_are_distinct_and_complete(self):
        ids = [c["id"] for c in source.CATEGORIES]
        self.assertEqual(len(ids), len(set(ids)))
        for category in source.CATEGORIES:
            self.assertTrue(category["title"])
            self.assertTrue(category["query"])


if __name__ == "__main__":
    unittest.main()
