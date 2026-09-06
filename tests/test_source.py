"""The YouTube source: what counts as a clip, and how yt-dlp is asked.

Every function under test is pure over yt-dlp's dictionaries or the
environment, so nothing here touches yt-dlp or the network.

The last class is about the two deployments rather than the source: they
answer the same endpoints from two files, and these tests are what keeps
the two answers the same.  They import the deployment modules but never
call a handler that would search.
"""

import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

import source  # noqa: E402


def load(relative: str, name: str):
    """One deployment module, loaded from its path -- api/index.py is not
    importable by name from here, and neither file is a package."""
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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


class DeploymentParityTests(unittest.TestCase):
    """server/app.py and api/index.py answer /api/home and /api/search twice.

    The owner develops against the aiohttp server and deploys to Vercel, so
    anything the two files decide separately is a difference that only
    production ever shows.  Everything that shapes an answer lives in
    source.py instead; these fail the moment a copy comes back."""

    SHARED = ("HOME_LIMIT", "SEARCH_LIMIT", "CATEGORY_TTL", "SEARCH_TTL",
              "ASSET_CACHE", "PAGE_CACHE")

    def test_source_owns_every_number_that_shapes_an_answer(self):
        for name in self.SHARED:
            self.assertTrue(hasattr(source, name), f"source.{name} is missing")

    def test_the_vercel_function_keeps_no_copy_of_them(self):
        module = load("api/index.py", "vercel_index")
        for name in self.SHARED:
            self.assertFalse(hasattr(module, name),
                             f"api/index.py defines its own {name}; it must read source.{name}")

    def test_the_aiohttp_server_keeps_no_copy_of_them(self):
        try:
            module = load("server/app.py", "aiohttp_app")
        except ImportError as missing:  # aiohttp is not installed for the Vercel deploy
            self.skipTest(str(missing))
        for name in self.SHARED:
            self.assertFalse(hasattr(module, name),
                             f"server/app.py defines its own {name}; it must read source.{name}")

    def test_both_refuse_an_empty_query_the_same_way(self):
        # The page reads data.error out of the body and shows it, so an
        # aiohttp exception -- whose body is plain text -- would leave a
        # local viewer reading "the server said 400" while a Vercel viewer
        # is told what was actually wrong.
        vercel = load("api/index.py", "vercel_index")
        self.assertEqual(vercel.api_search({}), (400, {"error": "q is required"}))
        try:
            local = load("server/app.py", "aiohttp_app")
        except ImportError as missing:
            self.skipTest(str(missing))
        response = asyncio.run(local.api_search(types.SimpleNamespace(query={})))
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.text), {"error": "q is required"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_the_same_search_shapes_the_same_two_answers(self):
        """Given one identical search, the two files must emit one identical
        body -- same shelves, same number of clips, same keys."""
        vercel = load("api/index.py", "vercel_index")
        try:
            local = load("server/app.py", "aiohttp_app")
        except ImportError as missing:
            self.skipTest(str(missing))

        def fake_search(query, limit=source.SEARCH_LIMIT):
            return [source.to_clip(entry(id=f"{query[:3]}{index:08d}", title=f"{query} {index}"))
                    for index in range(limit)]

        real, source.search_360 = source.search_360, fake_search
        vercel.CACHE, local.CACHE = source.TTLCache(), source.TTLCache()
        try:
            self.assertEqual(vercel.api_home()[1],
                             json.loads(asyncio.run(local.api_home(None)).text))
            self.assertEqual(
                vercel.api_search({"q": ["aurora"]})[1],
                json.loads(asyncio.run(local.api_search(
                    types.SimpleNamespace(query={"q": "aurora"}))).text))
        finally:
            source.search_360 = real


class StaticFileTests(unittest.TestCase):
    """The Vercel function serves ../site itself, so it is the one place
    here that turns a visitor's path into a file to read."""

    def setUp(self):
        self.module = load("api/index.py", "vercel_index")

    def request(self, path):
        seen = {}

        def start_response(status, headers):
            seen["status"] = status
            seen["headers"] = dict(headers)

        body = b"".join(self.module.app(
            {"PATH_INFO": path, "QUERY_STRING": "", "REQUEST_METHOD": "GET"}, start_response))
        return seen["status"], seen["headers"], body

    def test_the_page_is_served(self):
        status, headers, body = self.request("/")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertIn(b"<html", body.lower())

    def test_climbing_out_of_the_site_directory_is_not_found(self):
        for path in ("/../server/source.py", "/../requirements.txt", "/js/../../vercel.json"):
            status, _, _ = self.request(path)
            self.assertTrue(status.startswith("404"), f"{path} was served")

    def test_a_sibling_that_merely_starts_with_site_is_not_inside_it(self):
        # "site" is a prefix of "site-backup", so comparing the resolved
        # path with startswith let a request climb one level and come back
        # down into a directory that is not the site at all.
        with tempfile.TemporaryDirectory() as tmp:
            site = Path(tmp) / "site"
            site.mkdir()
            sibling = Path(tmp) / "site-backup"
            sibling.mkdir()
            (sibling / "secret.txt").write_text("not for the web", encoding="utf-8")
            original, self.module.SITE = self.module.SITE, site
            try:
                status, _, body = self.request("/../site-backup/secret.txt")
            finally:
                self.module.SITE = original
        self.assertTrue(status.startswith("404"), "a sibling directory was served")
        self.assertNotIn(b"not for the web", body)

    def test_a_path_the_filesystem_cannot_name_is_not_a_500(self):
        # A 500 here would answer with an OSError quoting an absolute path
        # inside the deployment.
        status, _, body = self.request("/\x00")
        self.assertTrue(status.startswith("404"), status)
        self.assertNotIn(b"site", body)

    def test_models_are_cached_for_a_day_and_the_page_is_not(self):
        _, headers, _ = self.request("/models/mirror_permutation.json")
        self.assertEqual(headers["Cache-Control"], source.ASSET_CACHE)
        _, headers, _ = self.request("/js/library.js")
        self.assertEqual(headers["Cache-Control"], source.PAGE_CACHE)

    def test_an_unknown_endpoint_is_json_and_never_cached(self):
        status, headers, body = self.request("/api/nope")
        self.assertTrue(status.startswith("404"))
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn("error", json.loads(body))


if __name__ == "__main__":
    unittest.main()
