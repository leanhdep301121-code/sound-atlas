"""Isolated tests: no imports of receiver.py and no access to noise.db."""
import json
import math
import sqlite3
import tempfile
import threading
import unittest
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from live_bridge import BJ, BridgeError, LiveBridge, SnapshotBuilder, load_config, post_snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "isolated.db"
        self.db = sqlite3.connect(self.path)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE readings(node TEXT,ts_ms INTEGER,laeq REAL,PRIMARY KEY(node,ts_ms));
            CREATE TABLE nodes(node TEXT PRIMARY KEY,last_seen REAL,ip TEXT);
            CREATE TABLE settings(id INTEGER PRIMARY KEY,ver INTEGER,start_ms INTEGER,end_ms INTEGER);
            INSERT INTO settings VALUES(1,0,0,0);
            CREATE TABLE exclusions(id INTEGER PRIMARY KEY,node TEXT,start_ms INTEGER,end_ms INTEGER,reason TEXT);
        """)
        self.now = datetime(2026, 11, 14, 10, 15, tzinfo=BJ).timestamp()
        self.builder = SnapshotBuilder(self.path)

    def tearDown(self):
        self.builder.close()
        self.db.close()
        self.temp.cleanup()

    def add(self, node, seconds, level, online=False):
        self.db.execute("INSERT INTO readings VALUES(?,?,?)", (node, int(seconds * 1000), level))
        if online:
            self.db.execute("INSERT OR REPLACE INTO nodes VALUES(?,?,?)", (node, self.now, "private-address"))
        self.db.commit()

    def frame(self, snapshot, day="2026-11-14", slot=20):
        return next(d for d in snapshot["days"] if d["label"] == day)["frames"][slot]

    def test_confirmed_physical_mapping_and_minimal_payload(self):
        for index, node in enumerate(["N1", "N2", "N3", "N4", "N5"]):
            self.add(node, self.now - 1, 40 + index, online=True)
        self.add("D1", self.now - 1, 100, online=True)
        snapshot = self.builder.build(self.now)
        self.assertEqual(snapshot["latest"]["sound"], {"C": 40, "B": 41, "A": 42, "E": 43, "D": 44})
        self.assertEqual([n["id"] for n in snapshot["nodes"]], ["A", "B", "C", "D", "E"])
        payload = json.dumps(snapshot)
        self.assertNotIn("private-address", payload)
        self.assertNotIn("D1", payload)
        self.assertNotIn("reason", payload)

    def test_equal_one_second_readings_use_sound_energy(self):
        self.add("N3", self.now - 2, 50)
        self.add("N3", self.now - 1, 60)
        frame = self.frame(self.builder.build(self.now))
        self.assertAlmostEqual(frame["sound"]["A"], 10 * math.log10((10**5 + 10**6) / 2), places=3)
        self.assertEqual(frame["counts"]["A"], 2)
        self.assertNotAlmostEqual(frame["sound"]["A"], 55)

    def test_invalid_levels_and_interval_boundaries(self):
        for offset, level in enumerate([0, -80, 141, None, float("inf"), 140, 50, 60]):
            self.add("N1", self.now - 10 + offset, level)
        start = int((self.now - 4) * 1000)
        self.db.execute("INSERT INTO exclusions VALUES(1,'N1',?,?,?)", (start, start + 1000, "private note"))
        self.db.commit()
        frame = self.frame(self.builder.build(self.now))
        self.assertEqual(frame["counts"]["C"], 2)  # 140 and 60; 50 at [start,end) is excluded.

    def test_today_is_present_but_old_data_is_not_live(self):
        previous = self.now - 86400
        self.add("N1", previous, 52)
        snapshot = self.builder.build(self.now)
        self.assertEqual([d["label"] for d in snapshot["days"]], ["2026-11-13", "2026-11-14"])
        self.assertEqual(self.frame(snapshot)["sound"], {})
        self.assertEqual(snapshot["latest"], {"timestamp": None, "sound": {}})

    def test_online_heartbeat_does_not_make_stale_measurement_live(self):
        self.add("N1", self.now - 100, 51, online=True)
        snapshot = self.builder.build(self.now)
        self.assertEqual(next(n for n in snapshot["nodes"] if n["id"] == "C")["status"], "online")
        self.assertEqual(snapshot["latest"]["sound"], {})

    def test_backfilled_rows_are_included_and_reads_do_not_duplicate(self):
        self.add("N3", self.now - 1, 50)
        self.builder.build(self.now)
        self.add("N3", self.now - 3600, 60)
        snapshot = self.builder.build(self.now + 10)
        self.assertEqual(self.frame(snapshot, slot=18)["sound"]["A"], 60)
        self.assertEqual(self.frame(snapshot)["counts"]["A"], 1)
        self.assertEqual(self.builder.build(self.now + 20)["days"], snapshot["days"])

    def test_exclusion_and_undo_recompute_previous_summary(self):
        self.add("N3", self.now - 2, 50)
        self.add("N3", self.now - 1, 60)
        self.builder.build(self.now)
        stamp = int((self.now - 1) * 1000)
        self.db.execute("INSERT INTO exclusions VALUES(1,'N3',?,?,NULL)", (stamp, stamp + 1000))
        self.db.commit()
        self.assertEqual(self.frame(self.builder.build(self.now + 10))["sound"]["A"], 50)
        self.db.execute("DELETE FROM exclusions")
        self.db.commit()
        self.assertEqual(self.frame(self.builder.build(self.now + 20))["counts"]["A"], 2)

    def test_delete_and_explicit_invalidation_handle_rowid_reuse(self):
        self.add("N3", self.now - 2, 50)
        self.add("N3", self.now - 1, 60)
        self.builder.build(self.now)
        self.db.execute("DELETE FROM readings WHERE laeq=50")
        self.db.commit()
        self.assertEqual(self.frame(self.builder.build(self.now + 10))["sound"]["A"], 60)
        self.db.execute("DELETE FROM readings")
        self.db.commit()
        self.add("N1", self.now, 48)
        self.builder.invalidate()
        self.assertEqual(self.frame(self.builder.build(self.now + 20))["sound"], {"C": 48})

    def test_plan_scope_excludes_debug_data_and_end_is_exclusive(self):
        self.add("N3", self.now - 3, 40)
        self.add("N3", self.now - 2, 50)
        self.add("N3", self.now - 1, 60)
        self.db.execute("UPDATE settings SET ver=1,start_ms=?,end_ms=?", (int((self.now - 2)*1000),int((self.now - 1)*1000)))
        self.db.commit()
        snapshot = self.builder.build(self.now)
        self.assertEqual(snapshot["plan"]["state"], "finished")
        self.assertEqual(self.frame(snapshot)["sound"], {"A": 50})

    def test_future_plan_is_empty_and_future_readings_wait(self):
        self.add("N3", self.now - 10, 50)
        self.db.execute("UPDATE settings SET ver=1,start_ms=?,end_ms=0", (int((self.now+600)*1000),))
        self.db.commit()
        self.assertEqual(self.frame(self.builder.build(self.now))["sound"], {})
        self.db.execute("UPDATE settings SET ver=2,start_ms=0")
        self.db.commit()
        self.add("N1", self.now + 20, 55)
        self.assertNotIn("C", self.frame(self.builder.build(self.now))["sound"])
        self.assertEqual(self.frame(self.builder.build(self.now + 30))["sound"]["C"], 55)

    def test_read_only_connection_and_midnight_beijing(self):
        midnight = datetime(2026, 11, 14, 0, 0, tzinfo=BJ).timestamp()
        self.add("N1", midnight - 1, 51)
        self.add("N1", midnight, 52)
        snapshot = self.builder.build(self.now)
        self.assertEqual(self.frame(snapshot, "2026-11-13", 47)["sound"]["C"], 51)
        self.assertEqual(self.frame(snapshot, "2026-11-14", 0)["sound"]["C"], 52)
        with self.assertRaises(sqlite3.OperationalError):
            self.builder._conn.execute("DELETE FROM readings")

    def test_bridge_interval_retry_and_no_secret_in_status(self):
        config_path = Path(self.temp.name) / "live_bridge_config.json"
        secret = "test-only-secret-should-never-appear-in-status"
        config_path.write_text(json.dumps({"enabled": True, "endpoint": "https://example.invalid/api/ingest", "token": secret}))
        sent = []
        bridge = LiveBridge(self.path, config_path, poster=lambda endpoint, token, payload: sent.append(payload))
        try:
            self.assertTrue(bridge.publish_once(now=self.now))
            self.assertFalse(bridge.publish_once(now=self.now + 10))
            self.assertTrue(bridge.publish_once(now=self.now + 30))
            self.assertEqual(len(sent), 2)
            self.assertEqual(bridge.status()["state"], "online")
            bridge._poster = lambda *args: (_ for _ in ()).throw(RuntimeError(secret))
            self.assertFalse(bridge.publish_once(now=self.now + 60))
            self.assertEqual(bridge.status()["state"], "retrying")
            self.assertNotIn(secret, json.dumps(bridge.status()))
            self.assertFalse(bridge.publish_once(now=self.now + 61))
        finally:
            bridge.stop()


class TransportTests(unittest.TestCase):
    def test_real_http_request_contains_only_summary_and_bearer_header(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.headers.get("Authorization"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        try:
            snapshot = {"version":1,"days":[],"latest":{"timestamp":None,"sound":{}}}
            post_snapshot("http://127.0.0.1:%d/api/ingest" % server.server_port, "local-test-secret", snapshot)
            self.assertEqual(seen, [("Bearer local-test-secret", snapshot)])
        finally:
            server.shutdown();server.server_close();thread.join()

    def test_disabled_missing_and_unsafe_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/"config.json"
            self.assertFalse(load_config(path)["enabled"])
            path.write_text(json.dumps({"enabled": True,"endpoint":"http://example.com/api/ingest","token":"x"*32}))
            with self.assertRaises(BridgeError): load_config(path)
            path.write_text(json.dumps({"enabled": False}))
            self.assertFalse(load_config(path)["enabled"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
