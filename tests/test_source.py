"""The YouTube source: what counts as a clip, how yt-dlp is asked, and the
cache / single-flight rules both deployments share.

Pure over yt-dlp's dictionaries or the environment: nothing here touches
yt-dlp or the network.  The deployments themselves are tested in
test_api.py.
"""

import sys
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

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

    def test_a_cache_of_nothing_but_live_entries_is_still_bounded(self):
        # Search keys are whatever the visitor typed, so a script asking a
        # different nonsense question every second would otherwise grow the
        # dict without limit -- nothing in it has expired to sweep.
        cache = source.TTLCache(clock=lambda: 0.0)
        for i in range(source.TTLCache.SWEEP_AT * 3):
            cache.put(f"q:{i}", i, 900)
        self.assertLessEqual(len(cache._values), source.TTLCache.SWEEP_AT)
        self.assertEqual(cache.get(f"q:{source.TTLCache.SWEEP_AT * 3 - 1}"),
                         source.TTLCache.SWEEP_AT * 3 - 1)  # the newest survived

    def test_an_empty_answer_is_kept_only_briefly(self):
        # youtube answers a challenged request with a results page that has
        # no entries, not with an error, so an empty shelf must not be
        # cached for the six hours a full one is.
        self.assertEqual(source.cache_ttl([{"id": "x"}], source.CATEGORY_TTL), source.CATEGORY_TTL)
        self.assertEqual(source.cache_ttl([], source.CATEGORY_TTL), source.EMPTY_TTL)
        self.assertLess(source.EMPTY_TTL, source.SEARCH_TTL)


class CleanErrorTests(unittest.TestCase):
    """Whatever a viewer is told, it must not include how this server is
    configured: the page prints ``data.error`` straight onto the shelf."""

    def test_yt_dlps_log_prefixes_come_off(self):
        message = source.clean_error(Exception("ERROR: [youtube:tab] abc: Sign in to confirm"))
        self.assertEqual(message, "Sign in to confirm")

    def test_an_empty_message_still_says_something(self):
        self.assertEqual(source.clean_error(Exception("")), "unavailable")

    def test_the_proxy_and_the_cookie_jar_are_struck_out(self):
        env = {"LAZYVR_PROXY": "http://user:secret@proxy.example:9",
               "LAZYVR_COOKIES_FILE": "/run/secrets/cookies.txt"}
        message = source.clean_error(
            Exception("Unable to connect to http://user:secret@proxy.example:9 "
                      "using /run/secrets/cookies.txt"), env)
        self.assertNotIn("secret@proxy.example", message)
        self.assertNotIn("/run/secrets/cookies.txt", message)
        self.assertIn("<redacted>", message)

    def test_a_message_cannot_run_away_with_the_response(self):
        self.assertLessEqual(len(source.clean_error(Exception("x" * 5000))), 200)


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


class CacheRuleTests(unittest.TestCase):
    def test_static_paths(self):
        self.assertEqual(source.static_cache("/"), "no-cache")
        self.assertEqual(source.static_cache("/index.html"), "no-cache")
        self.assertEqual(source.static_cache("/index.html?v=1"), "no-cache")
        self.assertEqual(source.static_cache("/js/app.js"), "public, max-age=0, must-revalidate")
        self.assertEqual(source.static_cache("/css/base.css"), "public, max-age=0, must-revalidate")
        self.assertEqual(source.static_cache("/models/face_landmarker.task"),
                         "public, max-age=604800, stale-while-revalidate=86400")
        self.assertEqual(source.static_cache("/fonts/x.woff2"), source.ASSET_CACHE)
        self.assertEqual(source.static_cache("/models/sub/deep.bin"), source.ASSET_CACHE)
        self.assertEqual(source.static_cache("/modelsish.js"), source.CODE_CACHE)

    def test_home_is_cached_by_how_well_it_went(self):
        full = [{"id": "a", "clips": [1]}, {"id": "b", "clips": [2]}]
        failed = [{"id": "a", "clips": [1]}, {"id": "b", "clips": [], "error": "x"}]
        # An empty shelf is usually youtube challenging us: not a success.
        empty = [{"id": "a", "clips": [1]}, {"id": "b", "clips": []}]
        dead = [{"id": "a", "clips": [], "error": "x"}, {"id": "b", "clips": []}]
        self.assertEqual(source.home_cache(full), "public, s-maxage=21600, stale-while-revalidate=86400")
        self.assertEqual(source.home_cache(failed), "public, s-maxage=300")
        self.assertEqual(source.home_cache(empty), "public, s-maxage=300")
        self.assertEqual(source.home_cache(dead), "no-store")
        self.assertEqual(source.home_cache([]), "no-store")

    def test_search_is_cached_unless_empty(self):
        self.assertEqual(source.search_cache([{"id": "x"}]),
                         "public, s-maxage=900, stale-while-revalidate=3600")
        self.assertEqual(source.search_cache([]), source.EMPTY_CACHE)

    def test_no_header_ever_breaks_the_youtube_embed(self):
        names = {name.lower() for name in source.SECURITY_HEADERS}
        self.assertNotIn("cross-origin-opener-policy", names)
        self.assertNotIn("cross-origin-embedder-policy", names)
        self.assertEqual(source.SECURITY_HEADERS["Referrer-Policy"], "strict-origin-when-cross-origin")


class SingleFlightTests(unittest.TestCase):
    def test_concurrent_callers_share_one_producer_call(self):
        cache, locks = source.TTLCache(), source.KeyedLocks()
        calls = []
        gate = threading.Event()

        def producer():
            calls.append(1)
            gate.wait(2)
            return ["clip"]

        results = []
        threads = [threading.Thread(target=lambda: results.append(
            source.cached_call(cache, locks, "k", producer, 60))) for _ in range(8)]
        for thread in threads:
            thread.start()
        time.sleep(0.05)
        gate.set()
        for thread in threads:
            thread.join(5)
        self.assertEqual(len(calls), 1)
        self.assertEqual(results, [["clip"]] * 8)
        self.assertEqual(len(locks), 0, "a lock outlived its last user")

    def test_a_failure_is_not_cached_and_frees_the_lock(self):
        cache, locks = source.TTLCache(), source.KeyedLocks()

        def boom():
            raise RuntimeError("challenged")

        with self.assertRaises(RuntimeError):
            source.cached_call(cache, locks, "k", boom, 60)
        self.assertEqual(len(locks), 0)
        self.assertEqual(source.cached_call(cache, locks, "k", lambda: ["ok"], 60), ["ok"])

    def test_unique_keys_do_not_grow_the_lock_table(self):
        cache, locks = source.TTLCache(), source.KeyedLocks()
        for i in range(1000):
            source.cached_call(cache, locks, f"q:{i}", lambda: ["x"], 60)
        self.assertEqual(len(locks), 0)

    def test_an_empty_answer_is_cached_briefly(self):
        clock = [0.0]
        cache, locks = source.TTLCache(clock=lambda: clock[0]), source.KeyedLocks()
        calls = []
        source.cached_call(cache, locks, "k", lambda: calls.append(1) or [], 900)
        source.cached_call(cache, locks, "k", lambda: calls.append(1) or [], 900)
        self.assertEqual(len(calls), 1)
        clock[0] = source.EMPTY_TTL + 1
        source.cached_call(cache, locks, "k", lambda: calls.append(1) or [], 900)
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
