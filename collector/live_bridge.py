"""Read-only, privacy-minimal live summaries for Sound Atlas.

The receiver remains the sole owner of collection plans and raw SQLite data.
This module never imports receiver.py, writes its database, or sends device IPs.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


BJ = timezone(timedelta(hours=8))
SLOT_MS = 30 * 60 * 1000
DAY_MS = 24 * 60 * 60 * 1000
ONLINE_SECONDS = 75
# Confirmed by the user's physical device labels, not the ordering of TABLES.
NODE_MAP = {
    "N3": ("A", "公桌 1"),
    "N2": ("B", "公桌 2"),
    "N1": ("C", "公桌 3"),
    "N5": ("D", "公桌 A"),
    "N4": ("E", "公桌 B"),
    "D1": ("D1", "工位 D1"),
}


def iso_time(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    return datetime.fromtimestamp(seconds, BJ).isoformat(timespec="seconds")


def plan_status(start_ms: int, end_ms: int, now_ms: int) -> str:
    if not start_ms:
        return "none"
    if now_ms < start_ms:
        return "waiting"
    if end_ms and now_ms >= end_ms:
        return "finished"
    return "recording"


def _valid_level(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value) and 0 < value <= 140


class SnapshotBuilder:
    """Cache energy sums while reading an independent, read-only WAL connection.

    Rowid deltas include buffered, late-arriving records. Exclusion edits, plan
    changes, deletions and reused rowids rebuild the cache. A periodic rebuild
    also catches externally edited databases and previously future-dated rows.
    The receiver's minute_stats is deliberately unused: it stores dB sums,
    which cannot produce an energy-equivalent LAeq.
    """

    def __init__(self, db_path, *, online_seconds=ONLINE_SECONDS, rebuild_seconds=300):
        self.db_path = Path(db_path)
        self.online_seconds = online_seconds
        self.rebuild_seconds = rebuild_seconds
        self._lock = threading.RLock()
        self._conn = None
        self._identity = None
        self._row_count = 0
        self._last_rowid = 0
        self._last_rebuild = 0.0
        self._buckets = {}
        self._pending = []

    def _connect(self):
        if self._conn is None:
            self._conn = sqlite3.connect(
                self.db_path.resolve().as_uri() + "?mode=ro",
                uri=True, timeout=4, check_same_thread=False, isolation_level=None,
            )
            self._conn.execute("PRAGMA query_only=ON")
        return self._conn

    def close(self):
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def invalidate(self):
        with self._lock:
            self._identity = None

    @staticmethod
    def _excluded(node, stamp, exclusions):
        return any(start <= stamp < end for start, end in exclusions.get(node, ()))

    def _add(self, node, stamp, level):
        public_id = NODE_MAP[node][0]
        key = (stamp // SLOT_MS, public_id)
        energy, count = self._buckets.get(key, (0.0, 0))
        self._buckets[key] = (energy + 10 ** (level / 10), count + 1)

    def build(self, now=None):
        now = time.time() if now is None else float(now)
        now_ms = int(now * 1000)
        today = datetime.fromtimestamp(now, BJ).replace(hour=0, minute=0, second=0, microsecond=0)
        today_label = today.date().isoformat()
        calendar_start = int((today - timedelta(days=6)).timestamp() * 1000)
        with self._lock:
            db = self._connect()
            db.execute("BEGIN")
            try:
                plan_row = db.execute("SELECT ver, start_ms, end_ms FROM settings WHERE id=1").fetchone()
                version, start_ms, end_ms = plan_row or (0, 0, 0)
                version, start_ms, end_ms = int(version), int(start_ms), int(end_ms)
                lower = max(calendar_start, start_ms) if start_ms else calendar_start
                upper = min(now_ms + 1, end_ms) if end_ms else now_ms + 1
                exclusion_rows = db.execute(
                    "SELECT node,start_ms,end_ms FROM exclusions ORDER BY node,start_ms,end_ms"
                ).fetchall()
                exclusions = {}
                for node, begin, end in exclusion_rows:
                    if node in NODE_MAP:
                        exclusions.setdefault(node, []).append((int(begin), int(end)))
                scope = (lower, start_ms, end_ms, version, tuple(exclusion_rows))
                row_count = db.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
                last_rowid = db.execute("SELECT COALESCE(MAX(rowid),0) FROM readings").fetchone()[0]
                # With INSERT OR IGNORE, new committed rows advance rowid one by one.
                # A purge/reused rowid breaks this equality and requires recomputation.
                rebuild = (
                    self._identity != scope
                    or last_rowid < self._last_rowid
                    or row_count - self._row_count != last_rowid - self._last_rowid
                    or now - self._last_rebuild >= self.rebuild_seconds
                )
                if rebuild:
                    buckets_before, pending_before = self._buckets, self._pending
                    self._buckets, self._pending = {}, []
                    rows = db.execute(
                        f"SELECT node,ts_ms,laeq FROM readings WHERE node IN ({','.join('?' for _ in NODE_MAP)}) "
                        "AND ts_ms>=? AND ts_ms<? ORDER BY node,ts_ms",
                        (*NODE_MAP, lower, min(end_ms or now_ms + 60_001, now_ms + 60_001)),
                    )
                else:
                    # Copy only the tiny summary map so failure never leaves partial aggregates.
                    buckets_before, pending_before = self._buckets, self._pending
                    self._buckets, self._pending = self._buckets.copy(), list(self._pending)
                    rows = db.execute(
                        "SELECT node,ts_ms,laeq FROM readings WHERE rowid>? AND rowid<=? ORDER BY rowid",
                        (self._last_rowid, last_rowid),
                    )
                try:
                    still_pending = []
                    for node, stamp, level in self._pending:
                        if lower <= stamp < upper:
                            self._add(node, stamp, level)
                        elif stamp >= upper:
                            still_pending.append((node, stamp, level))
                    self._pending = still_pending
                    for node, stamp, level in rows:
                        if node not in NODE_MAP or not _valid_level(level):
                            continue
                        stamp = int(stamp)
                        if stamp < lower or end_ms and stamp >= end_ms:
                            continue
                        if self._excluded(node, stamp, exclusions):
                            continue
                        if stamp < upper:
                            self._add(node, stamp, level)
                        elif stamp <= now_ms + 60_000:
                            self._pending.append((node, stamp, level))
                    node_rows = {
                        row[0]: row[1]
                        for row in db.execute(f"SELECT node,last_seen FROM nodes WHERE node IN ({','.join('?' for _ in NODE_MAP)})", tuple(NODE_MAP))
                    }
                    live_values = {}
                    live_stamps = []
                    nodes = []
                    for raw_id, (public_id, label) in NODE_MAP.items():
                        last_seen = node_rows.get(raw_id)
                        good_seen = isinstance(last_seen, (int, float)) and math.isfinite(last_seen)
                        online = good_seen and -5 <= now - last_seen <= self.online_seconds
                        nodes.append({
                            "id": public_id, "label": label,
                            "status": "online" if online else "offline" if good_seen else "unknown",
                            "lastSeen": iso_time(last_seen) if good_seen else None,
                        })
                        if not online or upper <= lower:
                            continue
                        candidates = db.execute(
                            "SELECT ts_ms,laeq FROM readings WHERE node=? AND ts_ms>=? AND ts_ms<? "
                            "AND laeq>0 AND laeq<=140 ORDER BY ts_ms DESC LIMIT 1000",
                            (raw_id, max(lower, now_ms - self.online_seconds * 1000), upper),
                        )
                        for stamp, value in candidates:
                            if _valid_level(value) and not self._excluded(raw_id, stamp, exclusions):
                                live_values[public_id] = round(value, 3)
                                live_stamps.append(stamp)
                                break
                    db.execute("COMMIT")
                except BaseException:
                    self._buckets, self._pending = buckets_before, pending_before
                    raise
                self._identity = scope
                self._row_count = row_count
                self._last_rowid = last_rowid
                if rebuild:
                    self._last_rebuild = now
            except BaseException:
                if db.in_transaction:
                    db.execute("ROLLBACK")
                raise

            def blank_day(label):
                return {"label": label, "frames": [{"sound": {}, "counts": {}} for _ in range(48)]}

            days = {today_label: blank_day(today_label)}
            for (bucket, public_id), (energy, count) in self._buckets.items():
                if not count:
                    continue
                moment = datetime.fromtimestamp(bucket * SLOT_MS / 1000, BJ)
                label = moment.date().isoformat()
                day = days.setdefault(label, blank_day(label))
                frame = day["frames"][moment.hour * 2 + moment.minute // 30]
                frame["sound"][public_id] = round(10 * math.log10(energy / count), 3)
                frame["counts"][public_id] = count
            return {
                "version": 1,
                "generatedAt": iso_time(now),
                "plan": {"state": plan_status(start_ms, end_ms, now_ms), "startMs": start_ms, "endMs": end_ms},
                "nodes": nodes,
                "days": [days[label] for label in sorted(days)],
                "latest": {
                    "timestamp": iso_time(max(live_stamps) / 1000) if live_stamps else None,
                    "sound": live_values,
                },
            }


class BridgeError(Exception):
    """Errors safe to show in the local UI; never contains endpoint or token."""


def load_config(path):
    path = Path(path)
    if not path.exists():
        return {"enabled": False}
    try:
        config = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        raise BridgeError("同步配置无法读取，请检查本机配置文件。") from None
    if not isinstance(config, dict):
        raise BridgeError("同步配置格式有误。")
    if not config.get("enabled", True):
        return {"enabled": False}
    endpoint, token = config.get("endpoint"), config.get("token")
    if not isinstance(endpoint, str) or not isinstance(token, str) or len(token) < 24:
        raise BridgeError("同步地址或授权配置不完整。")
    parsed = urllib.parse.urlsplit(endpoint)
    loopback = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and loopback)) or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BridgeError("同步地址必须使用 HTTPS。")
    return {"enabled": True, "endpoint": endpoint, "token": token}


def post_snapshot(endpoint, token, snapshot):
    body = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Bearer " + token,
        "User-Agent": "SoundAtlasCollector/1",
    })
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            # Never forward the collector credential to a redirected origin.
            return None

    try:
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(request, timeout=8) as response:
            if not 200 <= response.status < 300:
                raise BridgeError("展示站暂未接收数据，请稍后重试。")
            response.read(65536)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise BridgeError("展示站授权校验失败，请检查同步配置。") from None
        raise BridgeError("展示站返回错误（HTTP %d），正在重试。" % error.code) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise BridgeError("暂时无法连接展示站，采集继续在本机保存。") from None


class LiveBridge:
    """Background publisher. Starting it never changes the collection plan."""

    def __init__(self, db_path, config_path=None, *, snapshot_seconds=10, publish_seconds=30, poster=post_snapshot):
        self.builder = SnapshotBuilder(db_path)
        self.config_path = Path(config_path) if config_path else Path(db_path).with_name("live_bridge_config.json")
        self.snapshot_seconds = snapshot_seconds
        self.publish_seconds = publish_seconds
        self._poster = poster
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.RLock()
        self._publish_lock = threading.Lock()
        self._last_payload = None
        self._last_success = None
        self._last_attempt = None
        self._next_attempt = 0.0
        self._failures = 0
        self._state = "disabled"
        self._message = "尚未启用展示站同步。"
        self._error = None
        self._config_signature = None

    def start(self):
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="sound-atlas-live-bridge", daemon=True)
            self._thread.start()
        return self

    def stop(self, timeout=10):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=timeout)
        if not self._thread or not self._thread.is_alive():
            self.builder.close()

    def status(self):
        with self._lock:
            return {
                "state": self._state, "message": self._message,
                "last_success": iso_time(self._last_success),
                "last_attempt": iso_time(self._last_attempt),
                "error": self._error,
            }

    def snapshot(self, now=None):
        return self.builder.build(now)

    def invalidate(self):
        """Call after local data-management mutations; raw data is untouched."""
        self.builder.invalidate()

    def _set_state(self, state, message, error=None):
        with self._lock:
            self._state, self._message, self._error = state, message, error

    def publish_once(self, *, now=None, force=False):
        now = time.time() if now is None else float(now)
        if not self._publish_lock.acquire(blocking=False):
            return False
        try:
            config = load_config(self.config_path)
            if not config["enabled"]:
                self._set_state("disabled", "尚未启用展示站同步。")
                return False
            signature = hashlib.sha256((config["endpoint"] + "\0" + config["token"]).encode()).hexdigest()
            if signature != self._config_signature:
                self._config_signature = signature
                self._next_attempt = 0.0
                self._failures = 0
            payload = self.builder.build(now)
            with self._lock:
                self._last_payload = payload
            if not force and now < self._next_attempt:
                return False
            with self._lock:
                self._last_attempt = now
            self._set_state("syncing", "正在同步公桌与 D1 工位的声级摘要。")
            self._poster(config["endpoint"], config["token"], payload)
            with self._lock:
                self._last_success = now
                self._failures = 0
                self._next_attempt = now + self.publish_seconds
            self._set_state("online", "已连接展示站，数据自动同步。")
            return True
        except Exception as error:
            message = str(error) if isinstance(error, BridgeError) else "同步暂时失败，采集继续在本机保存。"
            with self._lock:
                self._failures += 1
                self._next_attempt = now + min(300, 5 * 2 ** min(self._failures - 1, 6))
            self._set_state("retrying", message, message)
            return False
        finally:
            self._publish_lock.release()

    def _run(self):
        while not self._stop.is_set():
            self.publish_once()
            self._stop.wait(self.snapshot_seconds)

