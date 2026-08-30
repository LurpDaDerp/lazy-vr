"""Integration tests: boot the real server and exercise every route."""

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gaze360.control import ControlOutput
from gaze360.server import GazeServer, SharedState

BODY = bytes(range(256)) * 40  # 10240 bytes, every byte value, easy to verify


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.web = root / "web"
        cls.web.mkdir()
        (cls.web / "index.html").write_text("<h1>hello</h1>", encoding="utf-8")
        (cls.web / "app.js").write_text("// script", encoding="utf-8")
        cls.video = root / "clip.mp4"
        cls.video.write_bytes(BODY)

        cls.recentred = []
        cls.state = SharedState(deadzone=6.0, max_angle=26.0)
        cls.server = GazeServer(
            ("127.0.0.1", 0),
            cls.state,
            cls.web,
            cls.video,
            {"recenter": lambda: cls.recentred.append(True)},
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
        response = self.get("/video")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), BODY)

    def test_advertises_range_support(self):
        self.assertEqual(self.get("/video").headers["Accept-Ranges"], "bytes")

    def test_range_returns_206_with_exact_bytes(self):
        response = self.get("/video", {"Range": "bytes=100-199"})
        self.assertEqual(response.status, 206)
        self.assertEqual(response.read(), BODY[100:200])

    def test_range_content_range_header(self):
        response = self.get("/video", {"Range": "bytes=100-199"})
        self.assertEqual(
            response.headers["Content-Range"], f"bytes 100-199/{len(BODY)}"
        )

    def test_range_content_length(self):
        response = self.get("/video", {"Range": "bytes=100-199"})
        self.assertEqual(response.headers["Content-Length"], "100")

    def test_open_ended_range_runs_to_the_end(self):
        response = self.get("/video", {"Range": "bytes=10000-"})
        self.assertEqual(response.read(), BODY[10000:])

    def test_suffix_range(self):
        response = self.get("/video", {"Range": "bytes=-64"})
        self.assertEqual(response.read(), BODY[-64:])

    def test_seek_to_the_final_byte(self):
        response = self.get("/video", {"Range": f"bytes={len(BODY) - 1}-"})
        self.assertEqual(response.read(), BODY[-1:])

    def test_unsatisfiable_range_is_416(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/video", {"Range": "bytes=99999-"})
        self.assertEqual(caught.exception.code, 416)
        self.assertEqual(caught.exception.headers["Content-Range"], f"bytes */{len(BODY)}")

    def test_declined_range_falls_back_to_200(self):
        response = self.get("/video", {"Range": "bytes=0-99,200-299"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), BODY)

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
            ControlOutput(
                yaw_rate=42.0,
                pitch_rate=-7.0,
                state="panning",
                yaw_error=12.0,
                pitch_error=-3.0,
                centre=(0.0, 0.0),
                confidence=1.0,
            ),
            calibration=1.0,
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
        self.assertEqual(packet["state"], "panning")
        self.assertEqual(packet["deadzone"], 6.0)

    def test_stale_tracker_commands_a_stop(self):
        """A tracker that went quiet must not leave the browser panning."""
        state = SharedState(6.0, 26.0)
        state.publish(
            ControlOutput(90.0, 0.0, "panning", 20.0, 0.0, (0.0, 0.0), 1.0),
            calibration=1.0,
            gaze_fps=30.0,
            latency_ms=5.0,
            eye_visibility=(1.0, 1.0),
        )
        state._updated -= 10.0  # pretend the last reading was 10 s ago
        snapshot = state.snapshot()
        self.assertEqual(snapshot["yaw_rate"], 0.0)
        self.assertEqual(snapshot["state"], "stalled")

    def test_fresh_tracker_keeps_its_rate(self):
        state = SharedState(6.0, 26.0)
        state.publish(
            ControlOutput(90.0, 0.0, "panning", 20.0, 0.0, (0.0, 0.0), 1.0),
            calibration=1.0,
            gaze_fps=30.0,
            latency_ms=5.0,
            eye_visibility=(1.0, 1.0),
        )
        self.assertEqual(state.snapshot()["yaw_rate"], 90.0)

    def test_state_before_any_reading_is_inert(self):
        snapshot = SharedState(6.0, 26.0).snapshot()
        self.assertEqual(snapshot["yaw_rate"], 0.0)
        self.assertEqual(snapshot["pitch_rate"], 0.0)


if __name__ == "__main__":
    unittest.main()
