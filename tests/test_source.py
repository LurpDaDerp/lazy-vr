"""The YouTube source: what counts as a clip, and how yt-dlp is asked.

Every function under test is pure over yt-dlp's dictionaries or the
environment, so nothing here touches yt-dlp or the network.
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


class YdlOptionTests(unittest.TestCase):
    def test_no_player_client_is_ever_named(self):
        # Reading a results page never asks youtube for a stream, so there
        # is no player client to choose and nothing to tell the extractor:
        # what makes the request work is the fingerprint and the cookies.
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
