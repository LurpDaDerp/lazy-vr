"""Integration tests: boot the real server and exercise every route."""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.control import ControlConfig, ControlOutput, GazeController
from gaze360.library import VideoLibrary
from gaze360.server import GazeServer, SharedState

BODY = bytes(range(256)) * 40  # 10240 bytes, every byte value, easy to verify
CLIP = "clip"  # the id gaze360.library.slug gives "clip.mp4"


def steering(yaw_rate=0.0, pitch_rate=0.0, state="steering"):
    """A committed turn request, as the controller would emit one."""
    return ControlOutput(
        yaw_rate=yaw_rate,
        pitch_rate=pitch_rate,
        state=state,
        yaw_error=12.0,
        pitch_error=-3.0,
        centre=(0.0, 0.0),
        confidence=1.0,
        committed=True,
    )


def finished(path, body=BODY):
    """Write a clip that looks like a completed download, not a live one.

    The library withholds a file whose mtime is a moment old, on the grounds
    that something is probably still writing it.  A test fixture is written a
    moment before it is read, so it has to be backdated to be playable.
    """
    path.write_bytes(body)
    old = time.time() - 3600
    os.utime(path, (old, old))
    return path


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.web = root / "web"
        cls.web.mkdir()
        (cls.web / "index.html").write_text("<h1>hello</h1>", encoding="utf-8")
        (cls.web / "app.js").write_text("// script", encoding="utf-8")
        cls.videos = root / "videos"
        cls.videos.mkdir()
        cls.video = finished(cls.videos / "clip.mp4")
        cls.library = VideoLibrary(cls.videos, root / "thumbs")

        cls.recentred = []
        cls.state = SharedState(GazeController(ControlConfig()))
        cls.server = GazeServer(
            ("127.0.0.1", 0),
            cls.state,
            cls.web,
            cls.library,
            {"recenter": lambda payload: cls.recentred.append(True)},
        )
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def get(self, path, headers=None):
        request = urllib.request.Request(self.base + path, headers=headers or {})
        return urllib.request.urlopen(request, timeout=5)

    # -- static ---------------------------------------------------------

    def test_root_serves_the_index(self):
        response = self.get("/")
        self.assertEqual(response.status, 200)
        self.assertIn(b"hello", response.read())

    def test_named_asset(self):
        self.assertEqual(self.get("/app.js").status, 200)

    def test_javascript_content_type(self):
        self.assertIn("javascript", self.get("/app.js").headers["Content-Type"])

    def test_missing_asset_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/nope.js")
        self.assertEqual(caught.exception.code, 404)

    def test_directory_traversal_is_refused(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/../clip.mp4")
        self.assertIn(caught.exception.code, (400, 404))

    # -- video ----------------------------------------------------------

    def test_whole_video(self):
        response = self.get(f"/video/{CLIP}")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), BODY)

    def test_advertises_range_support(self):
        self.assertEqual(self.get(f"/video/{CLIP}").headers["Accept-Ranges"], "bytes")

    def test_range_returns_206_with_exact_bytes(self):
        response = self.get(f"/video/{CLIP}", {"Range": "bytes=100-199"})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.read(), BODY[100:200])

    def test_range_content_range_header(self):
        response = self.get(f"/video/{CLIP}", {"Range": "bytes=100-199"})
        self.assertEqual(
            response.headers["Content-Range"], f"bytes 100-199/{len(BODY)}"
        )

    def test_range_content_length(self):
        response = self.get(f"/video/{CLIP}", {"Range": "bytes=100-199"})
        self.assertEqual(response.headers["Content-Length"], "100")

    def test_open_ended_range_runs_to_the_end(self):
        response = self.get(f"/video/{CLIP}", {"Range": "bytes=10000-"})
        self.assertEqual(response.read(), BODY[10000:])

    def test_suffix_range(self):
        response = self.get(f"/video/{CLIP}", {"Range": "bytes=-64"})
        self.assertEqual(response.read(), BODY[-64:])

    def test_seek_to_the_final_byte(self):
        response = self.get(f"/video/{CLIP}", {"Range": f"bytes={len(BODY) - 1}-"})
        self.assertEqual(response.read(), BODY[-1:])

    def test_unsatisfiable_range_is_416(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get(f"/video/{CLIP}", {"Range": "bytes=99999-"})
        self.assertEqual(caught.exception.code, 416)
        self.assertEqual(caught.exception.headers["Content-Range"], f"bytes */{len(BODY)}")

    def test_declined_range_falls_back_to_200(self):
        response = self.get(f"/video/{CLIP}", {"Range": "bytes=0-99,200-299"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), BODY)

    def test_unknown_clip_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/video/nosuchclip")
        self.assertEqual(caught.exception.code, 404)

    def test_clip_id_may_not_climb_out_of_the_library(self):
        for attempt in ("/video/..", "/video/%2e%2e%2fclip", "/video/a/b"):
            with self.subTest(attempt=attempt):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.get(attempt)
                self.assertEqual(caught.exception.code, 404)

    # -- library --------------------------------------------------------

    def test_library_lists_the_clip(self):
        payload = json.loads(self.get("/library").read())
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["clips"][0]["id"], CLIP)
        self.assertEqual(payload["clips"][0]["size"], len(BODY))

    def test_library_titles_come_from_the_filename(self):
        payload = json.loads(self.get("/library").read())
        self.assertEqual(payload["clips"][0]["title"], "clip")

    def test_a_clip_added_later_turns_up_without_a_restart(self):
        finished(self.videos / "second one.mp4")
        try:
            self.library.scan()
            payload = json.loads(self.get("/library").read())
            self.assertEqual(payload["total"], 2)
            self.assertEqual(self.get("/video/second-one").read(), BODY)
        finally:
            (self.videos / "second one.mp4").unlink()
            self.library.scan()

    def test_partial_downloads_are_not_listed(self):
        half = self.videos / "downloading.mp4.part"
        stream = self.videos / "downloading.f313.mp4"
        finished(half)
        finished(stream)
        try:
            self.library.scan()
            payload = json.loads(self.get("/library").read())
            self.assertEqual(payload["total"], 1, payload["clips"])
        finally:
            half.unlink()
            stream.unlink()
            self.library.scan()

    def test_missing_thumbnail_is_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get(f"/thumb/{CLIP}")
        self.assertEqual(caught.exception.code, 404)

    # -- commands -------------------------------------------------------

    def test_recenter_command_reaches_the_controller(self):
        before = len(self.recentred)
        request = urllib.request.Request(
            self.base + "/cmd",
            data=json.dumps({"action": "recenter"}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(request, timeout=5)
        self.assertEqual(response.status, 200)
        self.assertEqual(len(self.recentred), before + 1)

    def test_unknown_command_is_404(self):
        request = urllib.request.Request(
            self.base + "/cmd",
            data=json.dumps({"action": "launch"}).encode(),
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 404)

    def test_malformed_command_is_400(self):
        request = urllib.request.Request(
            self.base + "/cmd", data=b"{not json", method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 400)

    # -- gaze stream ----------------------------------------------------

    def test_gaze_stream_emits_sse_packets(self):
        self.state.publish(
            steering(yaw_rate=42.0, pitch_rate=-7.0),
            calibration=1.0,
            generation=1,
            gaze_fps=30.0,
            latency_ms=5.0,
            eye_visibility=(1.0, 1.0),
        )
        response = self.get("/gaze")
        self.assertIn("text/event-stream", response.headers["Content-Type"])
        line = response.readline().decode()
        self.assertTrue(line.startswith("data: "), line)
        packet = json.loads(line[len("data: "):])
        response.close()
        self.assertEqual(packet["yaw_rate"], 42.0)
        self.assertEqual(packet["state"], "steering")
        self.assertEqual(packet["deadzone_yaw"], ControlConfig().deadzone_yaw)

    def test_a_stale_tracker_is_read_as_stop_not_as_carry_on(self):
        """A rate held forever would spin the viewer round and round.

        An angle could safely be repeated while the tracker was quiet -- the
        view would just sit there.  A turn speed cannot.
        """
        state = SharedState(GazeController(ControlConfig()))
        state.publish(
            steering(yaw_rate=90.0),
            calibration=1.0,
            generation=1,
            gaze_fps=30.0,
            latency_ms=5.0,
            eye_visibility=(1.0, 1.0),
        )
        state._updated -= 10.0  # pretend the last reading was 10 s ago
        snapshot = state.snapshot()
        self.assertEqual(snapshot["state"], "stalled")
        self.assertEqual(snapshot["yaw_rate"], 0.0)
        self.assertEqual(snapshot["pitch_rate"], 0.0)

    def test_a_fresh_tracker_keeps_its_rate_and_label(self):
        state = SharedState(GazeController(ControlConfig()))
        state.publish(
            steering(yaw_rate=90.0),
            calibration=1.0,
            generation=1,
            gaze_fps=30.0,
            latency_ms=5.0,
            eye_visibility=(1.0, 1.0),
        )
        snapshot = state.snapshot()
        self.assertEqual(snapshot["yaw_rate"], 90.0)
        self.assertEqual(snapshot["state"], "steering")

    def test_state_before_any_reading_is_inert(self):
        snapshot = SharedState(GazeController(ControlConfig())).snapshot()
        self.assertEqual(snapshot["yaw_rate"], 0.0)
        self.assertEqual(snapshot["pitch_rate"], 0.0)

    def test_widget_spans_are_derived_from_rate_and_limit(self):
        """The HUD box must show where the axis actually saturates."""
        config = ControlConfig(rate_pitch=16.0, deadzone_pitch=3.375,
                               max_rate_pitch=90.0)
        snapshot = SharedState(GazeController(config)).snapshot()
        self.assertAlmostEqual(snapshot["span_pitch"], 3.375 + 90.0 / 16.0,
                               places=6)

    def test_the_rate_limits_reach_the_page(self):
        """The browser needs them: neck strain lowers the ceiling."""
        snapshot = SharedState(GazeController(ControlConfig())).snapshot()
        self.assertEqual(snapshot["max_rate_yaw"], ControlConfig().max_rate_yaw)
        self.assertEqual(snapshot["max_rate_pitch"], ControlConfig().max_rate_pitch)

    def test_calibration_restarts_reach_the_page(self):
        state = SharedState(GazeController(ControlConfig()))
        state.publish(
            steering(), calibration=0.0, generation=1, gaze_fps=30.0,
            latency_ms=5.0, eye_visibility=(1.0, 1.0), calibration_resets=3,
        )
        self.assertEqual(state.snapshot()["calibration_resets"], 3)


if __name__ == "__main__":
    unittest.main()
