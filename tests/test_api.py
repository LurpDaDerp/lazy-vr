"""The two deployments: api/index.py (Vercel) and server/app.py (aiohttp).

They answer the same endpoints from two files; these tests keep the answers
-- bodies and Cache-Control -- identical, check the Vercel routing against
the paths the rewrite delivers, and check that vercel.json's static headers
match source.py's rules.  No handler here ever reaches yt-dlp.
"""

import asyncio
import importlib.util
import json
import re
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

import source  # noqa: E402


def load(relative: str, name: str):
    """A deployment module by path (neither file is importable by name)."""
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_local(test):
    try:
        return load("server/app.py", "aiohttp_app")
    except ImportError as missing:  # aiohttp is not installed for the Vercel deploy
        test.skipTest(str(missing))


def fake_search(query, limit=source.SEARCH_LIMIT):
    return [{"id": f"{query[:3]}{index:08d}", "title": f"{query} {index}", "channel": "c",
             "duration": 300, "thumb": "t", "views": 1} for index in range(limit)]


class SearchStub:
    """Swaps source.search_360 for a function for the duration of a test."""

    def __init__(self, fn):
        self.fn = fn

    def __enter__(self):
        self.real, source.search_360 = source.search_360, self.fn
        return self

    def __exit__(self, *exc):
        source.search_360 = self.real


class ParityTests(unittest.TestCase):
    SHARED = ("HOME_LIMIT", "SEARCH_LIMIT", "CATEGORY_TTL", "SEARCH_TTL",
              "PAGE_CACHE", "CODE_CACHE", "ASSET_CACHE", "HOME_CACHE", "HOME_PARTIAL_CACHE",
              "SEARCH_CACHE", "EMPTY_CACHE", "NO_STORE", "SECURITY_HEADERS")

    def test_neither_deployment_keeps_its_own_copy(self):
        vercel = load("api/index.py", "vercel_index")
        local = load_local(self)
        for name in self.SHARED:
            self.assertTrue(hasattr(source, name), f"source.{name} is missing")
            self.assertFalse(hasattr(vercel, name), f"api/index.py defines its own {name}")
            self.assertFalse(hasattr(local, name), f"server/app.py defines its own {name}")

    def test_both_refuse_an_empty_query_the_same_way(self):
        vercel = load("api/index.py", "vercel_index")
        self.assertEqual(vercel.api_search({}), (400, {"error": "q is required"}, "no-store"))
        local = load_local(self)
        response = asyncio.run(local.api_search(types.SimpleNamespace(query={})))
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.text), {"error": "q is required"})
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_the_same_search_shapes_the_same_answers_and_headers(self):
        vercel = load("api/index.py", "vercel_index")
        local = load_local(self)
        vercel.CACHE, local.CACHE = source.TTLCache(), source.TTLCache()
        with SearchStub(fake_search):
            status, body, cache = vercel.api_home()
            response = asyncio.run(local.api_home(None))
            self.assertEqual(body, json.loads(response.text))
            self.assertEqual(cache, response.headers["Cache-Control"])
            self.assertEqual(cache, source.HOME_CACHE)

            status, body, cache = vercel.api_search({"q": ["aurora"]})
            response = asyncio.run(local.api_search(types.SimpleNamespace(query={"q": "aurora"})))
            self.assertEqual(body, json.loads(response.text))
            self.assertEqual(cache, response.headers["Cache-Control"])
            self.assertEqual(cache, source.SEARCH_CACHE)

    def test_a_failed_shelf_shortens_the_home_cache_in_both(self):
        def flaky(query, limit=source.SEARCH_LIMIT):
            if query == source.CATEGORIES[0]["query"]:
                raise RuntimeError("ERROR: [youtube:tab] x: Sign in to confirm")
            return fake_search(query, limit)

        vercel = load("api/index.py", "vercel_index")
        local = load_local(self)
        vercel.CACHE, local.CACHE = source.TTLCache(), source.TTLCache()
        with SearchStub(flaky):
            _, body, cache = vercel.api_home()
            response = asyncio.run(local.api_home(None))
        self.assertEqual(cache, source.HOME_PARTIAL_CACHE)
        self.assertEqual(response.headers["Cache-Control"], source.HOME_PARTIAL_CACHE)
        self.assertEqual(body["categories"][0]["error"], "Sign in to confirm")

    def test_total_failure_is_never_cached(self):
        def dead(query, limit=source.SEARCH_LIMIT):
            raise RuntimeError("down")

        vercel = load("api/index.py", "vercel_index")
        vercel.CACHE = source.TTLCache()
        with SearchStub(dead):
            _, _, cache = vercel.api_home()
            status, _, search = vercel.api_search({"q": ["x"]})
        self.assertEqual(cache, "no-store")
        self.assertEqual((status, search), (502, "no-store"))

    def test_the_aiohttp_locks_are_single_flight_and_bounded(self):
        local = load_local(self)
        local.CACHE = source.TTLCache()
        calls = []

        def producer():
            calls.append(1)
            return ["x"]

        async def run():
            await asyncio.gather(*(local.cached("same", producer, 60) for _ in range(5)))
            for i in range(50):
                await local.cached(f"q:{i}", producer, 60)

        asyncio.run(run())
        self.assertEqual(len(calls), 51)
        self.assertEqual(len(local.LOCKS), 0)


class VercelRoutingTests(unittest.TestCase):
    """The rewrite /api/(.*) -> /api/index.py keeps the original request path."""

    def setUp(self):
        self.module = load("api/index.py", "vercel_index")
        self.module.CACHE = source.TTLCache()

    def request(self, path, query="", method="GET"):
        seen = {}

        def start_response(status, headers):
            seen["status"] = status
            seen["headers"] = dict(headers)

        with SearchStub(fake_search):
            body = b"".join(self.module.app(
                {"PATH_INFO": path, "QUERY_STRING": query, "REQUEST_METHOD": method}, start_response))
        return seen["status"], seen["headers"], body

    def test_the_real_paths(self):
        status, headers, body = self.request("/api/home")
        self.assertTrue(status.startswith("200"), status)
        self.assertEqual(headers["Cache-Control"], source.HOME_CACHE)
        self.assertEqual(len(json.loads(body)["categories"]), len(source.CATEGORIES))

        status, headers, body = self.request("/api/search", "q=northern+lights")
        self.assertTrue(status.startswith("200"), status)
        self.assertEqual(json.loads(body)["query"], "northern lights")
        self.assertEqual(headers["Cache-Control"], source.SEARCH_CACHE)
        self.assertEqual(headers["Content-Type"], "application/json")

    def test_a_trailing_slash_is_the_same_endpoint(self):
        status, _, _ = self.request("/api/home/")
        self.assertTrue(status.startswith("200"), status)

    def test_the_rewritten_path_falls_back_to_a_path_hint(self):
        for path in ("/api/index.py", "/api/index"):
            status, _, body = self.request(path, "path=search&q=x")
            self.assertTrue(status.startswith("200"), f"{path}: {status}")
            self.assertEqual(json.loads(body)["query"], "x")
        status, _, _ = self.request("/api/index.py", "vkind=api&vpath=home")
        self.assertTrue(status.startswith("200"))

    def test_unknown_endpoints_and_the_page_are_json_404s(self):
        for path in ("/api/nope", "/api", "/api/home/extra", "/", "/index.html", "/api/index.py"):
            status, headers, body = self.request(path)
            self.assertTrue(status.startswith("404"), f"{path}: {status}")
            self.assertEqual(headers["Content-Type"], "application/json")
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("error", json.loads(body))

    def test_only_get_and_head(self):
        status, headers, _ = self.request("/api/home", method="POST")
        self.assertTrue(status.startswith("405"))
        self.assertEqual(headers["Cache-Control"], "no-store")
        status, headers, body = self.request("/api/home", method="HEAD")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(body, b"")

    def test_an_unexpected_exception_is_a_fixed_json_500(self):
        original = self.module.api_home
        self.module.api_home = lambda: 1 / 0
        try:
            import contextlib
            import io
            with contextlib.redirect_stderr(io.StringIO()):
                status, headers, body = self.request("/api/home")
        finally:
            self.module.api_home = original
        self.assertTrue(status.startswith("500"))
        self.assertEqual(json.loads(body), {"error": "the server could not answer that"})
        self.assertEqual(headers["Cache-Control"], "no-store")


class VercelConfigTests(unittest.TestCase):
    """vercel.json: CDN statics from site/, only /api to Python, headers that
    agree with source.py's rules and never break the YouTube embed."""

    def setUp(self):
        self.config = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))

    def header_for(self, path, name):
        """The value vercel.json's headers give `path` (last match wins)."""
        value = None
        for rule in self.config["headers"]:
            pattern = "^" + re.sub(r"\(\.\*\)", ".*", rule["source"]) + "$"
            if re.match(pattern, path):
                for header in rule["headers"]:
                    if header["key"].lower() == name.lower():
                        value = header["value"]
        return value

    def test_static_from_the_cdn_and_only_api_to_the_function(self):
        self.assertEqual(self.config["outputDirectory"], "site")
        self.assertIsNone(self.config["framework"])
        self.assertNotIn("builds", self.config)
        self.assertNotIn("routes", self.config)
        self.assertEqual(self.config["rewrites"], [{"source": "/api/(.*)", "destination": "/api/index.py"}])
        excluded = self.config["functions"]["api/index.py"]["excludeFiles"]
        for directory in ("site", "tests", "tools", "docs", ".impeccable", "videos"):
            self.assertIn(directory, excluded)

    def test_cache_headers_match_source(self):
        for path in ("/", "/index.html", "/js/app.js", "/css/base.css",
                     "/models/face_landmarker.task", "/fonts/a.woff2"):
            self.assertEqual(self.header_for(path, "Cache-Control"), source.static_cache(path), path)
        self.assertIsNone(self.header_for("/api/home", "Cache-Control"),
                          "the function sets the API's own Cache-Control")

    def test_security_headers_match_source_everywhere(self):
        for path in ("/", "/js/app.js", "/api/home"):
            for name, value in source.SECURITY_HEADERS.items():
                self.assertEqual(self.header_for(path, name), value, f"{name} on {path}")

    def test_nothing_that_breaks_the_youtube_embed(self):
        text = json.dumps(self.config).lower()
        self.assertNotIn("cross-origin-opener-policy", text)
        self.assertNotIn("cross-origin-embedder-policy", text)
        self.assertNotIn("no-referrer", text)
        self.assertNotIn('"same-origin"', text)

    def test_local_only_files_are_never_uploaded(self):
        ignored = set((ROOT / ".vercelignore").read_text(encoding="utf-8").split())
        for name in (".impeccable", "docs", "DESIGN.md", "PRODUCT.md", "CLAUDE.md", "tools",
                     ".pytest_cache", "tests", "__pycache__"):
            self.assertIn(name, ignored)
        for needed in ("site", "api", "server", "requirements.txt"):
            self.assertNotIn(needed, ignored)


class LocalServerTests(unittest.TestCase):
    """server/app.py serves site/ with the same headers the CDN sends."""

    def test_static_and_api_headers(self):
        local = load_local(self)
        try:
            from aiohttp.test_utils import TestClient, TestServer
        except ImportError as missing:
            self.skipTest(str(missing))

        async def run():
            local.CACHE = source.TTLCache()
            client = TestClient(TestServer(local.build_app()))
            await client.start_server()
            try:
                seen = {}
                for path in ("/", "/js/library.js", "/models/face_landmarker.task", "/nope.js"):
                    response = await client.get(path)
                    seen[path] = (response.status, dict(response.headers))
                with SearchStub(fake_search):
                    response = await client.get("/api/search?q=aurora")
                    seen["api"] = (response.status, dict(response.headers))
                return seen
            finally:
                await client.close()

        seen = asyncio.run(run())
        self.assertEqual(seen["/"][0], 200)
        self.assertEqual(seen["/"][1]["Cache-Control"], "no-cache")
        self.assertEqual(seen["/js/library.js"][1]["Cache-Control"], source.CODE_CACHE)
        self.assertIn("javascript", seen["/js/library.js"][1]["Content-Type"])
        if seen["/models/face_landmarker.task"][0] == 200:
            self.assertEqual(seen["/models/face_landmarker.task"][1]["Cache-Control"], source.ASSET_CACHE)
        self.assertEqual(seen["/nope.js"][0], 404)
        self.assertEqual(seen["api"][1]["Cache-Control"], source.SEARCH_CACHE)
        for path, (_, headers) in seen.items():
            for name, value in source.SECURITY_HEADERS.items():
                self.assertEqual(headers.get(name), value, f"{name} on {path}")


if __name__ == "__main__":
    unittest.main()
