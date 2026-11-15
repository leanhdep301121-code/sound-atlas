"""Authenticated outbound management relay for the local Sound Atlas collector.

The cloud queues narrowly-scoped commands; this worker calls the existing local
receiver functions. The raw database is never exposed as an HTTP service. A
separate durable receipt journal gives write commands at-most-once execution:
an interrupted command is reported as uncertain after restart, never replayed.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from live_bridge import load_config

ALLOWED_ACTIONS = frozenset({"overview", "series", "count", "suspects", "plan", "exclude", "unexclude", "export", "purge"})
WRITE_ACTIONS = frozenset({"plan", "exclude", "unexclude", "purge"})
MAX_RESULT_BYTES = 180_000
MAX_CSV_BYTES = 90_000
RECEIPT_TTL_SECONDS = 7 * 24 * 60 * 60
JOURNAL_MAINTENANCE_SECONDS = 60 * 60


class RemoteError(Exception):
    """Safe user-visible validation or transport failure."""


def _iso(seconds=None):
    return datetime.fromtimestamp(time.time() if seconds is None else seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _millis(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return int(value)
    if isinstance(value, str):
        try:
            date = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if date.tzinfo is not None:
                return int(date.timestamp() * 1000)
        except ValueError:
            pass
    raise RemoteError("远程指令的时间格式有误。")


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def control_endpoint(config):
    parsed = urllib.parse.urlsplit(config["endpoint"])
    path = parsed.path.rstrip("/").rsplit("/", 1)[0] + "/collector-control"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def exchange(endpoint, token, payload):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    request = urllib.request.Request(endpoint, data=_json(payload).encode("utf-8"), method="POST", headers={
        "Content-Type": "application/json; charset=utf-8", "Authorization": "Bearer " + token,
        "User-Agent": "SoundAtlasCollectorControl/1",
    })
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=8) as response:
            raw = response.read(262_145)
            if len(raw) > 262_144:
                raise RemoteError("远程指令响应过大，已停止处理。")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise RemoteError("远程指令响应格式有误。")
            return result
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise RemoteError("远程管理授权校验失败，本机采集不受影响。") from None
        raise RemoteError("远程管理连接暂不可用，正在重试。") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise RemoteError("远程管理连接暂不可用，正在重试。") from None


class RemoteControl:
    def __init__(self, receiver, config_path=None, *, journal_path=None, interval=5, transport=exchange, clock=time.time):
        self.receiver = receiver
        self.config_path = Path(config_path) if config_path else Path(receiver.DB_PATH).with_name("live_bridge_config.json")
        self.journal_path = Path(journal_path) if journal_path else Path(receiver.DB_PATH).with_name("remote_commands.db")
        self.interval = interval
        self._transport = transport
        self._clock = clock
        self._stop = threading.Event()
        self._thread = None
        self._lock = threading.RLock()
        self._execution_lock = threading.Lock()
        self._poll_lock = threading.Lock()
        self._journal = sqlite3.connect(self.journal_path, check_same_thread=False)
        self._journal.execute("PRAGMA journal_mode=WAL")
        self._journal.execute("PRAGMA secure_delete=ON")
        self._journal.execute("PRAGMA journal_size_limit=1048576")
        self._journal.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, command_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, started REAL, finished REAL, acknowledged INTEGER NOT NULL DEFAULT 0)")
        uncertain = _json({"status": "uncertain", "error": "采集程序在执行期间重启，请先核对本机状态，再决定是否重新提交。"})
        self._journal.execute("UPDATE receipts SET status='uncertain',result_json=?,finished=? WHERE status='executing'", (uncertain, self._clock()))
        self._journal.commit()
        self._state = "connecting"
        self._message = "正在连接站内采集管理。"
        self._last_success = None
        self._last_error = None
        self._failures = 0
        self._active_until = 0.0
        self._state_cache = None
        self._state_cache_time = 0
        self._closed = False
        self._last_journal_maintenance = None
        self._maintain_journal(force=True)

    def start(self):
        if self._thread is None or not self._thread.is_alive():
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="sound-atlas-remote-control", daemon=True)
            self._thread.start()
        return self

    def stop(self, timeout=10):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)
        if not self._thread or not self._thread.is_alive():
            with self._lock:
                if not self._closed:
                    self._journal.close()
                    self._closed = True

    def status(self):
        with self._lock:
            return {"state": self._state, "message": self._message,
                    "last_success": _iso(self._last_success) if self._last_success else None,
                    "error": self._last_error}

    def live_telemetry(self, now):
        """Bounded five-minute, valid, non-excluded sound observations for six nodes."""
        receiver = self.receiver
        now_ms = int(now * 1000)
        start_ms = now_ms - 300_000
        result = []
        with receiver.db_lock:
            for node in receiver.EXPECTED_NODES:
                rows = receiver.conn.execute(
                    "SELECT r.ts_ms,r.laeq,r.lafmax FROM readings r "
                    "WHERE r.node=? AND r.ts_ms>=? AND r.ts_ms<=? "
                    "AND r.laeq>0 AND r.laeq<=140 "
                    "AND NOT EXISTS (SELECT 1 FROM exclusions e WHERE e.node=r.node "
                    "AND r.ts_ms>=e.start_ms AND r.ts_ms<e.end_ms) "
                    "ORDER BY r.ts_ms DESC LIMIT 600", (node, start_ms, now_ms)
                ).fetchall()
                rows = [row for row in reversed(rows) if math.isfinite(row[1])]
                buckets = {}
                for stamp, level, peak in rows:
                    slot = stamp // 5000
                    energy, count = buckets.get(slot, (0, 0))
                    buckets[slot] = (energy + 10 ** (level / 10), count + 1)
                latest = rows[-1] if rows else None
                result.append({"node": node,
                    "timestamp": latest[0] if latest else None,
                    "laeq": round(latest[1], 2) if latest else None,
                    "lafmax": round(latest[2], 2) if latest and isinstance(latest[2], (int, float)) and math.isfinite(latest[2]) and 0 < latest[2] <= 160 else None,
                    "samples": len(rows),
                    "windowLeq": round(10 * math.log10(sum(10 ** (r[1]/10) for r in rows)/len(rows)), 2) if rows else None,
                    "history": [[slot * 5000, round(10 * math.log10(energy/count), 2)] for slot, (energy, count) in sorted(buckets.items())]})
        return {"generatedAt": _iso(now), "windowSeconds": 300, "bucketSeconds": 5,
                "uploadIntervalSeconds": 30, "nodes": result}

    def management_state(self, *, force=False):
        now = self._clock()
        if not force and self._state_cache is not None and now - self._state_cache_time < 5:
            return self._state_cache
        receiver = self.receiver
        overview = receiver.api_overview()
        # Whitelist fields: receiver internals, network addresses and credentials never cross the relay.
        safe_overview = {key: overview[key] for key in ("nodes", "exclusions", "plan", "now", "reasons", "colors", "backups") if key in overview}
        with receiver.db_lock:
            seen = dict(receiver.conn.execute("SELECT node,last_seen FROM nodes"))
        readiness = []
        for node, online, synced, mic, plan_synced, message in receiver.node_readiness(now):
            if node not in receiver.EXPECTED_NODES:
                continue
            stamp = seen.get(node)
            readiness.append({"node": node, "label": getattr(receiver, "NODE_LABELS", {}).get(node, node),
                              "online": bool(online), "synced": synced, "mic": mic,
                              "planSynced": plan_synced, "message": message,
                              "lastSeen": _iso(stamp) if isinstance(stamp, (int, float)) and math.isfinite(stamp) else None})
        version, start, end = receiver.get_plan()
        bridge = getattr(receiver, "SYNC_BRIDGE", None)
        state = {"generatedAt": _iso(now), "overview": safe_overview, "readiness": readiness,
                 "telemetry": self.live_telemetry(now),
                 "plan": {"version": version, "startMs": start, "endMs": end, "state": receiver.plan_state(now * 1000)[0]},
                 "bridge": bridge.status() if bridge else {"state": "disabled", "message": "本机摘要同步尚未启动。"}}
        if len(_json(state).encode("utf-8")) > 150_000:
            # Large exclusion lists stay accessible from an explicit overview command.
            safe_overview["exclusionsMore"] = max(0, len(safe_overview.get("exclusions", [])) - 100)
            safe_overview["exclusions"] = safe_overview.get("exclusions", [])[-100:]
        self._state_cache, self._state_cache_time = state, now
        return state

    def _nodes(self, value):
        values = value if isinstance(value, list) else str(value or "").split(",")
        nodes = list(dict.fromkeys(str(node) for node in values if node))
        available = set(self.receiver.all_nodes()) | set(self.receiver.EXPECTED_NODES)
        if not nodes or len(nodes) > 32 or any(node not in available for node in nodes):
            raise RemoteError("请选择有效的采集节点。")
        return nodes

    @staticmethod
    def _range(payload):
        try:
            start, end = int(payload["start"]), int(payload["end"])
        except (KeyError, ValueError, TypeError):
            raise RemoteError("请选择完整的时间范围。") from None
        if start < 0 or end <= start or end > 9_000_000_000_000_000:
            raise RemoteError("时间范围有误。")
        return start, end

    def _check_plan_version(self, payload, *, required=False):
        expected = payload.get("planVersion")
        if required or expected is not None:
            if isinstance(expected, bool) or not isinstance(expected, int) or expected != self.receiver.get_plan()[0]:
                raise RemoteError("采集计划已经变化，请刷新后重新确认。")

    def _check_deadline(self, expires):
        if expires is not None and self._clock() * 1000 >= expires:
            raise RemoteError("远程指令已过期，未执行。")

    def _execute(self, action, payload, expires=None):
        receiver = self.receiver
        if action == "overview":
            return self.management_state(force=True)["overview"]
        if action in ("series", "count", "suspects"):
            start, end = self._range(payload)
            query = {"start": start, "end": end}
            if action == "count":
                query["nodes"] = self._nodes(payload.get("nodes"))
                return receiver.api_count(query)
            if action == "series":
                query["w"] = max(50, min(600, int(payload.get("w", 600))))
                result = receiver.api_series(query)
                if payload.get("nodes"):
                    nodes = self._nodes(payload["nodes"])
                    result["series"] = {key: value for key, value in result["series"].items() if key in nodes}
                return result
            result = receiver.api_suspects(query)
            if payload.get("nodes"):
                nodes = self._nodes(payload["nodes"])
                result["items"] = [item for item in result["items"] if item["node"] in nodes]
            return result
        if action == "plan":
            self._check_plan_version(payload)
            if payload.get("action") not in {"start_now", "quick", "set", "stop", "cancel"}:
                raise RemoteError("未知的采集计划操作。")
            form = {key: str(payload[key]) for key in ("action", "start", "end", "days") if payload.get(key) is not None}
            if form.get("action") == "quick" and int(form.get("days", "0") or 0) not in (0, 1, 7):
                raise RemoteError("快捷采集仅支持一天、七天或手动结束。")
            with receiver.db_lock:
                self._check_deadline(expires)
                self._check_plan_version(payload)
                message = receiver.handle_plan_form(form)
            self._changed()
            version, start, end = receiver.get_plan()
            return {"ok": True, "message": message, "plan": {"version": version, "startMs": start, "endMs": end, "state": receiver.plan_state()[0]}}
        if action == "exclude":
            start, end = self._range(payload)
            body = {"nodes": self._nodes(payload.get("nodes")), "start": start, "end": end,
                    "reason": str(payload.get("reason", ""))[:60], "note": str(payload.get("note", ""))[:200]}
            with receiver.db_lock:
                self._check_deadline(expires)
                result = receiver.api_exclude(body)
            self._changed()
            return result
        if action == "unexclude":
            group = payload.get("grp")
            if isinstance(group, bool) or not isinstance(group, int) or group <= 0:
                raise RemoteError("排除标记编号有误。")
            with receiver.db_lock:
                self._check_deadline(expires)
                result = receiver.api_unexclude({"grp": group})
            self._changed()
            return result
        if action == "export":
            return self.export_page(payload)
        if action == "purge":
            query = {"mode": payload.get("mode"), "dry": True}
            if query["mode"] == "range":
                query["start"], query["end"] = self._range(payload)
                query["nodes"] = self._nodes(payload.get("nodes"))
            elif query["mode"] != "outside_plan":
                raise RemoteError("未知的数据删除范围。")
            if payload.get("dry") is True:
                result = receiver.api_purge(query)
                result["planVersion"] = receiver.get_plan()[0]
                return result
            count = payload.get("expectedCount")
            if isinstance(count, bool) or not isinstance(count, int) or count <= 0 or payload.get("confirmation") != "DELETE " + str(count):
                raise RemoteError("请先预览删除数量，并输入对应确认文字。")
            with receiver.db_lock:
                self._check_deadline(expires)
                self._check_plan_version(payload, required=True)
                preview = receiver.api_purge(query)
                if preview["count"] != count:
                    raise RemoteError("待删除数据数量已经变化，请重新预览并确认。")
                query["dry"] = False
                result = receiver.api_purge(query)
            self._changed()
            return result
        raise RemoteError("此远程操作不受支持。")

    def _changed(self):
        self._state_cache = None
        bridge = getattr(self.receiver, "SYNC_BRIDGE", None)
        if bridge:
            bridge.invalidate()

    def export_page(self, payload):
        receiver = self.receiver
        nodes = sorted(self._nodes(payload.get("nodes") or receiver.all_nodes()))
        start, requested_end = self._range(payload)
        clean = payload.get("clean", True) not in (False, 0, "0")
        limit = max(1, min(1000, int(payload.get("limit", 1000))))
        cursor = payload.get("cursor")
        if cursor is not None and not isinstance(cursor, dict):
            raise RemoteError("导出游标有误，请重新导出。")
        with receiver.db_lock:
            exclusion_rows = receiver.conn.execute("SELECT node,start_ms,end_ms FROM exclusions ORDER BY node,start_ms,end_ms").fetchall()
            signature = hashlib.sha256(_json([nodes, start, requested_end, clean, exclusion_rows]).encode()).hexdigest()
            if cursor:
                if cursor.get("signature") != signature:
                    raise RemoteError("筛选或排除状态已变化，请重新导出。")
                try:
                    max_rowid, end = int(cursor["maxRowid"]), int(cursor["end"])
                    after_node, after_ts = str(cursor["node"]), int(cursor["ts"])
                except (KeyError, ValueError, TypeError):
                    raise RemoteError("导出游标有误，请重新导出。") from None
                if max_rowid < 0 or end > requested_end or end <= start or after_node not in nodes or after_ts < start or after_ts >= end:
                    raise RemoteError("导出游标与筛选范围不符。")
            else:
                max_rowid = receiver.conn.execute("SELECT COALESCE(MAX(rowid),0) FROM readings").fetchone()[0]
                end = min(requested_end, int(self._clock() * 1000) + 1)
                after_node, after_ts = "", -1
            merged = receiver.merged_exclusions()
            placeholders = ",".join("?" for _ in nodes)
            where = f"node IN ({placeholders}) AND ts_ms>=? AND ts_ms<? AND rowid<=? AND (node>? OR (node=? AND ts_ms>?))"
            args = [*nodes, start, end, max_rowid, after_node, after_node, after_ts]
            rows = receiver.conn.execute(f"SELECT node,ts_ms,{','.join(receiver.COLUMNS)},{receiver.INVALID_SQL} FROM readings WHERE {where} ORDER BY node,ts_ms LIMIT ?", [*args, limit * 4 + 1]).fetchall()
            output, byte_count, count = [], 0, 0
            last_node, last_ts = after_node, after_ts
            for row in rows:
                node, stamp = row[:2]
                excluded = any(a <= stamp < b for a, b in merged.get(node, []))
                invalid = bool(row[-1]) or row[2] is None
                if clean and (invalid or excluded):
                    last_node, last_ts = node, stamp
                    continue
                cells = [node, receiver.local_time(stamp / 1000), stamp] + ["" if v is None else f"{v:.2f}" for v in row[2:-1]]
                if not clean:
                    cells += [int(invalid), int(excluded)]
                line = io.StringIO(); csv.writer(line, lineterminator="\n").writerow(cells)
                encoded = line.getvalue()
                length = len(encoded.encode("utf-8"))
                if count >= limit or byte_count + length > MAX_CSV_BYTES:
                    break
                output.append(encoded); byte_count += length; count += 1
                last_node, last_ts = node, stamp
            more_args = [*nodes, start, end, max_rowid, last_node, last_node, last_ts]
            has_more = bool(receiver.conn.execute(f"SELECT 1 FROM readings WHERE {where} LIMIT 1", more_args).fetchone())
        next_cursor = {"node": last_node, "ts": last_ts, "maxRowid": max_rowid, "end": end, "signature": signature} if has_more else None
        header = "node,time_beijing,ts_ms," + ",".join(receiver.COLUMNS) + ("" if clean else ",invalid,excluded")
        return {"header": header, "csv": "".join(output), "filename": "sound-atlas-" + ("clean" if clean else "raw") + ".csv",
                "nextCursor": next_cursor, "done": not has_more}

    def execute_command(self, command):
        """Execute once, or return a durable existing receipt. No automatic write retries."""
        if not isinstance(command, dict) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", str(command.get("id", ""))):
            raise RemoteError("远程指令编号有误。")
        identifier = command["id"]
        action, payload = command.get("action"), command.get("payload", {})
        digest = hashlib.sha256(_json([action, payload, command.get("createdAt"), command.get("expiresAt")]).encode()).hexdigest()
        with self._execution_lock:
            with self._lock:
                existing = self._journal.execute("SELECT command_hash,status,result_json,acknowledged FROM receipts WHERE id=?", (identifier,)).fetchone()
                if existing:
                    if existing[0] != digest:
                        return {"id": identifier, "status": "failed", "error": "重复指令内容不一致，未执行。"}
                    result = json.loads(existing[2]) if existing[2] else {"status": "uncertain", "error": "此指令可能已执行，请先核对状态。"}
                    if existing[3] and existing[1] in ("done", "failed", "uncertain"):
                        # A redelivery receives the compact acknowledged outcome;
                        # it must never call the receiver operation again.
                        self._journal.execute("UPDATE receipts SET acknowledged=0 WHERE id=?", (identifier,))
                        self._journal.commit()
                    return {"id": identifier, **result}
                self._journal.execute("INSERT INTO receipts(id,command_hash,status,started) VALUES(?,?,'executing',?)", (identifier, digest, self._clock()))
                self._journal.commit()
            try:
                if action not in ALLOWED_ACTIONS or not isinstance(payload, dict) or len(_json(payload).encode()) > 16_384:
                    raise RemoteError("此远程操作不受支持或参数过大。")
                now = self._clock() * 1000
                created, expires = _millis(command.get("createdAt")), _millis(command.get("expiresAt"))
                if expires <= now:
                    raise RemoteError("远程指令已过期，未执行。")
                if created > now + 120_000 or expires <= created or expires - created > 180_000 or expires > now + 180_000:
                    raise RemoteError("远程指令时间异常，请检查采集电脑时钟。")
                if self._stop.is_set():
                    raise RemoteError("采集程序正在关闭，此指令未执行。")
                result = self._execute(action, payload, expires)
                if len(_json(result).encode("utf-8")) > MAX_RESULT_BYTES:
                    raise RemoteError("返回数据过大，请缩短筛选时段或减少节点。")
                receipt = {"status": "done", "result": result}
            except (RemoteError, ValueError, KeyError, TypeError) as error:
                text = str(error) if isinstance(error, (RemoteError, ValueError)) else "指令参数不完整，请刷新后重试。"
                receipt = {"status": "failed", "error": text[:240]}
            except Exception:
                receipt = {"status": "uncertain" if action in WRITE_ACTIONS else "failed", "error": "本机执行状态无法确认，请先核对采集程序中的结果。"}
            with self._lock:
                self._journal.execute("UPDATE receipts SET status=?,result_json=?,finished=? WHERE id=?", (receipt["status"], _json(receipt), self._clock(), identifier))
                self._journal.commit()
            return {"id": identifier, **receipt}

    def pending_results(self):
        with self._lock:
            rows = self._journal.execute("SELECT id,result_json FROM receipts WHERE acknowledged=0 AND status IN ('done','failed','uncertain') ORDER BY finished LIMIT 4").fetchall()
        results = []
        size = 0
        for identifier, raw in rows:
            result = {"id": identifier, **json.loads(raw)}
            length = len(_json(result).encode("utf-8"))
            if results and size + length > 180_000:
                break
            results.append(result); size += length
        return results

    @staticmethod
    def _acknowledged_receipt(status, raw):
        """Keep the outcome, not a second permanent copy of exported raw data."""
        if status == "done":
            return {"status": "done", "result": {"acknowledged": True}}
        try:
            previous = json.loads(raw or "{}")
            error = previous.get("error") if isinstance(previous, dict) else None
        except (ValueError, TypeError):
            error = None
        return {"status": status, "error": str(error or "此指令的结果已由云端确认。")[:240]}

    def _maintain_journal(self, *, force=False):
        """Compact acknowledged legacy payloads and expire only old tombstones."""
        now = self._clock()
        with self._lock:
            if not force and self._last_journal_maintenance is not None and now - self._last_journal_maintenance < JOURNAL_MAINTENANCE_SECONDS:
                return
            self._journal.execute(
                "DELETE FROM receipts WHERE acknowledged=1 AND status IN ('done','failed','uncertain') AND finished<?",
                (now - RECEIPT_TTL_SECONDS,),
            )
            tombstone = _json(self._acknowledged_receipt("done", None))
            self._journal.execute(
                "UPDATE receipts SET result_json=? WHERE acknowledged=1 AND status='done' AND (result_json IS NULL OR result_json<>?)",
                (tombstone, tombstone),
            )
            # Read one legacy failure body at a time rather than loading all CSV
            # payloads into memory when upgrading an existing large journal.
            identifiers = self._journal.execute(
                "SELECT id,status FROM receipts WHERE acknowledged=1 AND status IN ('failed','uncertain')"
            ).fetchall()
            for identifier, status in identifiers:
                raw = self._journal.execute("SELECT result_json FROM receipts WHERE id=?", (identifier,)).fetchone()[0]
                compact = _json(self._acknowledged_receipt(status, raw))
                if raw != compact:
                    self._journal.execute("UPDATE receipts SET result_json=? WHERE id=?", (compact, identifier))
            self._journal.commit()
            # Freed database pages are reused; bound the separate WAL file too.
            self._journal.execute("PRAGMA wal_checkpoint(PASSIVE)")
            self._last_journal_maintenance = now

    def poll_once(self):
        if not self._poll_lock.acquire(blocking=False):
            return False
        try:
            self._maintain_journal()
            config = load_config(self.config_path)
            if not config["enabled"]:
                with self._lock:
                    self._state, self._message = "disabled", "远程管理尚未启用。"
                return False
            results = self.pending_results()
            response = self._transport(control_endpoint(config), config["token"], {"action": "poll", "state": self.management_state(), "results": results})
            server_time = _millis(response.get("serverTime"))
            if abs(server_time - self._clock() * 1000) > 120_000:
                raise RemoteError("采集电脑与云端时间相差过大，远程操作已暂停。")
            acknowledged = response.get("acknowledged", [])
            submitted = {item["id"] for item in results}
            with self._lock:
                for identifier in acknowledged if isinstance(acknowledged, list) else []:
                    if isinstance(identifier, str) and identifier in submitted:
                        row = self._journal.execute("SELECT status,result_json FROM receipts WHERE id=?", (identifier,)).fetchone()
                        if row and row[0] in ("done", "failed", "uncertain"):
                            compact = _json(self._acknowledged_receipt(row[0], row[1]))
                            self._journal.execute("UPDATE receipts SET acknowledged=1,result_json=? WHERE id=?", (compact, identifier))
                self._journal.commit()
                self._last_success, self._last_error = self._clock(), None
                self._state, self._message = "online", "站内采集管理已连接。"
                self._failures = 0
            command = response.get("command")
            if command is not None:
                self.execute_command(command)
                self._active_until = self._clock() + 3
                return True
            if results:
                self._active_until = self._clock() + 3
            return bool(results)
        except Exception as error:
            message = str(error) if isinstance(error, RemoteError) else "远程管理暂时断开，本机采集继续运行。"
            with self._lock:
                self._failures += 1
                self._state, self._message, self._last_error = "retrying", message, message
            return False
        finally:
            self._poll_lock.release()

    def _run(self):
        while not self._stop.is_set():
            immediate = self.poll_once()
            # Keep a short activity window so paged exports need not wait ten
            # seconds between the browser receiving a page and queuing its next.
            delay = .25 if immediate else .5 if not self._failures and self._clock() < self._active_until else min(60, self.interval * 2 ** min(max(self._failures - 1, 0), 4))
            self._stop.wait(delay)
