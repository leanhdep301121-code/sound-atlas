"""
二层噪声监测 · 电脑端接收程序
-------------------------------------------
功能：
  1. 接收 ESP32 节点上传的数据，存进 noise.db（SQLite 数据库）
  2. 给节点提供时间（对时）
  3. 浏览器打开 http://localhost:8000 查看各节点状态
  4. 浏览器打开 http://localhost:8000/manage 数据管理：
     看曲线、拖动选时段、把有问题的数据「标记排除」（可撤销）、自动检查可疑数据、导出 CSV
  5. 导出的「干净数据」自动去掉排除时段和无效读数；「彻底删除」前会自动备份数据库
  6. 浏览器打开 http://localhost:8000/control 设置「统一开始 / 结束」时间：
     所有节点按同一个开始时间、同一个整秒边界开始记录

网页上所有时间都按北京时间（UTC+8）显示和填写，与电脑的时区设置无关。

用法：在本文件所在文件夹打开命令行，运行  python receiver.py
只用 Python 自带的库，不需要安装任何东西。按 Ctrl+C 停止。
"""

import html
import json
import os
import sys
import socket
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from live_bridge import LiveBridge
from remote_control import RemoteControl
from upload_protocol import UploadError, read_upload, decode_upload, node_hint

PORT = int(os.environ.get("SOUND_ATLAS_PORT", "8000"))
DB_PATH = Path(os.environ.get("SOUND_ATLAS_DB", str(Path(__file__).with_name("noise.db")))).resolve()
BACKUP_DIR = DB_PATH.parent / "backups"
STATIC_DIR = Path(__file__).with_name("static")
SYNC_BRIDGE = None
REMOTE_CONTROL = None
BANDS = ["b63", "b125", "b250", "b500", "b1k", "b2k", "b4k", "b8k"]   # 倍频程频带（63 Hz–8 kHz）
COLUMNS = ["laeq", "lafmax"] + BANDS
# 节点上传每行的数值顺序（63 Hz、8 kHz 是后加的，放在最后；旧版节点只传前 8 个）
UPLOAD_ORDER = ["laeq", "lafmax", "b125", "b250", "b500", "b1k", "b2k", "b4k", "b63", "b8k"]
INVALID_SQL = "(laeq <= 0 OR laeq > 140)"      # 没有麦克风信号时 LAeq 约为 -80
VALID_SQL = "(laeq > 0 AND laeq <= 140)"
EXPECTED_NODES = ["N1", "N2", "N3", "N5", "D1", "D2"]   # 五张公桌与个人工位 D2
MIN_LEAD_S = 30          # 开始时间至少比现在晚 30 秒（节点每 10 秒查询一次计划，留足余量）
STOP_LEAD_S = 15         # "统一停止"设在 15 秒后，保证所有节点都能收到同一个结束时间
ONLINE_S = 75            # 节点每 30 秒上传一次，超过 75 秒没消息就算离线
NODE_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"]

db_lock = threading.RLock()
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.execute("PRAGMA journal_mode=WAL")
conn.execute(f"""
CREATE TABLE IF NOT EXISTS readings (
    node TEXT NOT NULL,
    ts_ms INTEGER NOT NULL,
    {", ".join(c + " REAL" for c in COLUMNS)},
    PRIMARY KEY (node, ts_ms)
)""")
conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts_ms)")
_rcols = {r[1] for r in conn.execute("PRAGMA table_info(readings)")}
for _c in COLUMNS:                               # 旧数据库自动补上新频带（旧数据这几列为空）
    if _c not in _rcols:
        conn.execute(f"ALTER TABLE readings ADD COLUMN {_c} REAL")
conn.execute("""
CREATE TABLE IF NOT EXISTS nodes (
    node TEXT PRIMARY KEY,
    last_seen REAL,
    ip TEXT,
    rssi INTEGER,
    uptime INTEGER,
    buffered INTEGER
)""")
conn.execute("""
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ver INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL
)""")
conn.execute("INSERT OR IGNORE INTO settings (id, ver, start_ms, end_ms) VALUES (1, 0, 0, 0)")
_cols = {r[1] for r in conn.execute("PRAGMA table_info(nodes)")}
for _c in ("cfg_ver", "mic", "synced"):          # 旧数据库自动补上新字段
    if _c not in _cols:
        conn.execute(f"ALTER TABLE nodes ADD COLUMN {_c} INTEGER")
conn.commit()


# ---------------- 采集计划 ----------------
def get_plan():
    """返回 (版本号, 开始毫秒, 结束毫秒)；开始为 0 表示没有计划，结束为 0 表示不设结束"""
    with db_lock:
        return conn.execute("SELECT ver, start_ms, end_ms FROM settings WHERE id = 1").fetchone()


def set_plan(start_ms, end_ms):
    with db_lock:
        conn.execute("UPDATE settings SET ver = ver + 1, start_ms = ?, end_ms = ? WHERE id = 1", (start_ms, end_ms))
        conn.commit()
    return get_plan()


def plan_state(now_ms=None):
    """返回 (状态代码, 中文说明)。状态：none / waiting / recording / finished"""
    ver, s, e = get_plan()
    now_ms = now_ms if now_ms is not None else time.time() * 1000
    if s == 0:
        return "none", "还没有设置采集计划，节点不会记录数据"
    end_txt = f"，结束于 {local_time(e / 1000)}" if e else "，不设结束（手动停止）"
    if now_ms < s:
        return "waiting", f"等待开始：{local_time(s / 1000)} 开始（还有 {fmt_dur((s - now_ms) / 1000)}）{end_txt}"
    if e and now_ms >= e:
        return "finished", f"已结束：{local_time(s / 1000)} 至 {local_time(e / 1000)}，共 {fmt_dur((e - s) / 1000)}"
    return "recording", f"正在记录：{local_time(s / 1000)} 开始，已记录 {fmt_dur((now_ms - s) / 1000)}{end_txt}"


def fmt_dur(sec):
    sec = int(max(0, sec))
    d, r = divmod(sec, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    if d:
        return f"{d} 天 {h} 小时 {m} 分"
    if h:
        return f"{h} 小时 {m} 分"
    if m:
        return f"{m} 分 {s} 秒"
    return f"{s} 秒"


def node_readiness(now=None):
    """返回每个节点的就绪情况列表：(节点, 在线, 已对时, 麦克风, 已收到最新计划, 说明)"""
    now = now if now is not None else time.time()
    ver, _, _ = get_plan()
    with db_lock:
        rows = {r[0]: r[1:] for r in conn.execute(
            "SELECT node, last_seen, cfg_ver, mic, synced FROM nodes")}
    out = []
    order = EXPECTED_NODES
    for node in order:
        if node not in rows:
            out.append((node, False, None, None, None, "还没连接过"))
            continue
        last_seen, cfg_ver, mic, synced = rows[node]
        online = now - last_seen < ONLINE_S
        if cfg_ver is None:
            out.append((node, online, None, None, None, "旧版程序，需要重新上传新版 noise_node"))
            continue
        problems = []
        if not online:
            problems.append(f"离线（{int(now - last_seen)} 秒没消息）")
        if not synced:
            problems.append("还没对时")
        if mic is None or mic < 0:
            problems.append("没有麦克风信号")
        if cfg_ver != ver:
            problems.append("还没收到最新计划（最多等 10 秒）")
        out.append((node, online, bool(synced), mic is not None and mic >= 0, cfg_ver == ver,
                    "就绪" if not problems else "；".join(problems)))
    return out


NODE_LABELS = {"N1": "公桌 3", "N2": "公桌 2", "N3": "公桌 1", "N4": "历史设备 N4", "N5": "公桌 A", "D1": "公桌 B", "D2": "个人工位"}
NODE_PLACES = {"N1": "右下工位区", "N2": "中下工位区", "N3": "左下工位区", "N4": "已停用，仅保留历史记录",
               "N5": "左上工位区", "D1": "右上工位区，邻近会议室", "D2": "公桌3右侧，东墙最南端单人工位"}


def short_time(ms):
    """毫秒时间戳 → 「11-16 00:00:00」"""
    return local_time(ms / 1000)[5:]


def state_card(back="/"):
    """页面最上面的状态卡片：现在是什么状态 + 一个主要按钮"""
    code, _ = plan_state()
    ver, s, e = get_plan()
    now_ms = time.time() * 1000
    hidden = f"<input type='hidden' name='back' value='{esc(back)}'>"

    def form(action, label, cls, confirm=""):
        onsubmit = f" onsubmit=\"return confirm('{confirm}')\"" if confirm else ""
        return (f"<form method='post' action='/plan'{onsubmit}>{hidden}"
                f"<input type='hidden' name='action' value='{action}'>"
                f"<button class='btn-big {cls}' type='submit'>{label}</button></form>")

    # 倒计时 / 已记录时长：页面上每秒自动更新（见 page() 里的脚本），倒计时到 0 自动刷新页面
    def until(ms):
        return f"<span data-until='{int(ms)}'>{fmt_dur((ms - now_ms) / 1000)}</span>"

    def since(ms):
        return f"<span data-since='{int(ms)}'>{fmt_dur((now_ms - ms) / 1000)}</span>"

    end_txt = f"计划 {short_time(e)} 结束" if e else "不设结束，手动停止"
    if code == "recording" and e and e - now_ms <= (STOP_LEAD_S + 5) * 1000:   # 刚点了停止
        dot, title = "#B42318", f"{until(e)}后停止"
        sub = esc(f"所有节点将在 {short_time(e)} 同时停止记录（本次共 {fmt_dur((e - s) / 1000)}）")
        btn = ""
    elif code == "recording":
        dot, title = "#1E7A46", "正在记录"
        sub = f"{esc(short_time(s))} 开始，已记录 {since(s)} · {esc(end_txt)}"
        btn = form("stop", "停止记录", "btn-stop", f"所有节点将在 {STOP_LEAD_S} 秒后的同一秒停止记录，确定吗？")
    elif code == "waiting":
        dot, title = "var(--accent)", f"{until(s)}后开始"
        sub = esc(f"{short_time(s)} 所有节点同时开始 · {end_txt}")
        btn = form("cancel", "取消", "")
    elif code == "finished":
        dot, title = "#8A9097", "已结束"
        sub = esc(f"上次记录：{short_time(s)} — {short_time(e)}，共 {fmt_dur((e - s) / 1000)}")
        btn = form("start_now", "开始新的记录", "btn-go")
    else:
        dot, title = "#8A9097", "未在记录"
        sub = esc(f"点「开始记录」后，约 {MIN_LEAD_S} 秒内所有节点在同一秒开始，一直记录到你点停止")
        btn = form("start_now", "开始记录", "btn-go")
    return (f"<section class='card state'><div class='txt'><p class='state-kicker'>采集状态</p>"
            f"<h2 class='state-heading'><span class='dot' style='background:{dot}'></span><span>{title}</span></h2>"
            f"<p class='sub'>{sub}</p></div>{btn}</section>")


def node_rec_state(cfg_ver, mic, synced, online, ver, code):
    """每个节点现在的状态：返回 (文字, 样式, 提示)"""
    if cfg_ver is None:
        return "旧版程序，不受页面控制", "bad", "用 Arduino IDE 上传新版 noise_node"
    if not online:
        return "离线", "bad", "检查电源和 WiFi，恢复后会自动补传"
    if not synced:
        return "等待对时", "warn", ""
    if mic is None or mic < 0:
        return "麦克风无信号", "bad", "检查麦克风接线和 3V3 / GND 跳线"
    if cfg_ver != ver:
        return "正在接收指令", "warn", "最多 10 秒"
    if code == "recording":
        return "记录中", "ok", ""
    if code == "waiting":
        return "等待开始", "muted", ""
    return "待命", "muted", ""


def msg_html(params):
    msg, err = params.get("msg", ""), params.get("err", "")
    return (f"<div class='msg'>{esc(msg)}</div>" if msg else "") + \
           (f"<div class='msg err'>{esc(err)}</div>" if err else "")


# ---------------- 时间：网页显示和填写一律用北京时间（UTC+8），与电脑的时区设置无关 ----------------
# 数据库里存的是 Unix 毫秒时间戳（全世界通用，不带时区），只在显示 / 输入时换算
BJ = timezone(timedelta(hours=8))


def local_time(ts):
    """秒时间戳 → 北京时间文字"""
    return datetime.fromtimestamp(ts, BJ).strftime("%Y-%m-%d %H:%M:%S")


def input_time(ts):
    """给 <input type=datetime-local> 用的北京时间格式"""
    return datetime.fromtimestamp(ts, BJ).strftime("%Y-%m-%dT%H:%M:%S")


def hm(ts):
    return datetime.fromtimestamp(ts, BJ).strftime("%H:%M")


def parse_input_time(s):
    """把网页上填的北京时间转成毫秒时间戳；留空返回 None"""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=BJ).timestamp() * 1000)
        except ValueError:
            pass
    raise ValueError(f"看不懂的时间格式：{s}")


# ---------------- 小工具 ----------------
def local_ips():
    ips = set()
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def esc(x):
    return html.escape(str(x))


def all_nodes():
    """公桌节点优先显示，其余历史节点和数据仍保留。"""
    with db_lock:
        a = {r[0] for r in conn.execute("SELECT DISTINCT node FROM readings")}
        b = {r[0] for r in conn.execute("SELECT node FROM nodes")}
    found = a | b
    return [n for n in EXPECTED_NODES if n in found] + sorted(found - set(EXPECTED_NODES))


def node_color(node, nodes=None):
    if node in EXPECTED_NODES:
        return NODE_COLORS[EXPECTED_NODES.index(node)]
    return NODE_COLORS[-1]


def backup_db():
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now(BJ).strftime('%Y%m%d_%H%M%S')
    path = BACKUP_DIR / f"noise_{stamp}.db"
    k = 2
    while path.exists():
        path = BACKUP_DIR / f"noise_{stamp}_{k}.db"
        k += 1
    dest = sqlite3.connect(path)
    with db_lock:
        conn.backup(dest)
    dest.close()
    return path


# ---------------- 排除标记（不删除原始数据，只标记"分析时不用"，可随时撤销） ----------------
conn.execute("""
CREATE TABLE IF NOT EXISTS exclusions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grp INTEGER NOT NULL,          -- 同一次操作标记的多个节点属于同一组，撤销时一起撤销
    node TEXT NOT NULL,
    start_ms INTEGER NOT NULL,     -- 区间左闭右开 [start, end)
    end_ms INTEGER NOT NULL,
    reason TEXT,
    note TEXT,
    created REAL
)""")
conn.commit()


# ---------------- 每分钟统计（看长时段曲线、自动检查时用，避免每次扫描几百万条原始数据） ----------------
conn.execute("""
CREATE TABLE IF NOT EXISTS minute_stats (
    node TEXT NOT NULL,
    m INTEGER NOT NULL,            -- 分钟编号 = ts_ms // 60000
    cnt INTEGER, bad INTEGER,      -- 总条数、无效条数
    vcnt INTEGER, vsum REAL,       -- 有效条数、有效 LAeq 之和
    vmin REAL, vmax REAL,          -- 有效 LAeq 最小、最大
    PRIMARY KEY (node, m)
)""")
conn.commit()

MINUTE_AGG = (f"SELECT node, ts_ms / 60000, COUNT(*), SUM(CASE WHEN {INVALID_SQL} THEN 1 ELSE 0 END), "
              f"SUM(CASE WHEN {VALID_SQL} THEN 1 ELSE 0 END), SUM(CASE WHEN {VALID_SQL} THEN laeq END), "
              f"MIN(CASE WHEN {VALID_SQL} THEN laeq END), MAX(CASE WHEN {VALID_SQL} THEN laeq END) FROM readings")


def refresh_minutes(node, t_lo, t_hi):
    """重新统计某节点 [t_lo, t_hi] 毫秒范围涉及的那些分钟"""
    m_lo, m_hi = t_lo // 60000, t_hi // 60000
    with db_lock:
        conn.execute("DELETE FROM minute_stats WHERE node = ? AND m >= ? AND m <= ?", (node, m_lo, m_hi))
        conn.execute(f"INSERT INTO minute_stats {MINUTE_AGG} WHERE node = ? AND ts_ms >= ? AND ts_ms < ? "
                     "GROUP BY ts_ms / 60000", (node, m_lo * 60000, (m_hi + 1) * 60000))


def rebuild_minutes():
    with db_lock:
        conn.execute("DELETE FROM minute_stats")
        conn.execute(f"INSERT INTO minute_stats {MINUTE_AGG} GROUP BY node, ts_ms / 60000")
        conn.commit()


with db_lock:
    if (conn.execute("SELECT COUNT(*) FROM minute_stats").fetchone()[0] == 0
            and conn.execute("SELECT 1 FROM readings LIMIT 1").fetchone()):
        print("首次运行新版：正在建立每分钟统计（数据多时需要几秒到一分钟）……", flush=True)
        rebuild_minutes()


def merged_exclusions():
    """{节点: [(开始, 结束), ...]}，同一节点重叠的区间已合并"""
    with db_lock:
        rows = conn.execute("SELECT node, start_ms, end_ms FROM exclusions ORDER BY node, start_ms").fetchall()
    out = {}
    for node, s, e in rows:
        lst = out.setdefault(node, [])
        if lst and s <= lst[-1][1]:
            lst[-1] = (lst[-1][0], max(lst[-1][1], e))
        else:
            lst.append((s, e))
    return out


def count_rows(node, s, e, extra=""):
    with db_lock:
        return conn.execute(f"SELECT COUNT(*) FROM readings WHERE node = ? AND ts_ms >= ? AND ts_ms < ?{extra}",
                            (node, s, e)).fetchone()[0]


def excluded_count(node, s, e, merged):
    total = 0
    for a, b in merged.get(node, []):
        lo, hi = max(a, s), min(b, e)
        if lo < hi:
            total += count_rows(node, lo, hi)
    return total


def fully_excluded(node, s, e, merged):
    return any(a <= s and b >= e for a, b in merged.get(node, []))


# ---------------- 网页：公共样式与页框 ----------------
# Shared styling lives in static/collector.css.
NAV = [("/", "总览"), ("/control", "采集计划"), ("/manage", "数据管理")]


def page(title, body, active="/", refresh=False):
    """声场采集台共用页框，保留原计划与数据管理操作。"""
    cur = ' aria-current="page"'
    nav = "".join(f"<a href='{h}' class='{'on' if h == active else ''}'{cur if h == active else ''}>{t}</a>"
                  for h, t in NAV)
    now_ms = int(time.time() * 1000)
    headings = {
        "/": ("采集总览", "从公桌到个人工位，听见空间的变化。查看设备状态与最新读数。"),
        "/control": ("采集计划", "让六个节点按同一时钟开始与结束，保留完整的观测过程。"),
        "/manage": ("数据管理", "沿时间轴检查观测，排除异常片段，保留可以追溯的原始数据。"),
    }
    heading, lead = headings.get(active, (title, "二层开放工位的声环境观测。"))
    # 每秒走一次的时钟（以电脑时间为准，换算成北京时间）；
    # 需要时每 10 秒刷新页面，正在填写表单时不刷新
    script = f"""<script>
const T0={now_ms},P0=Date.now();
function tick(){{const d=new Date(T0+(Date.now()-P0)+8*3600e3),p=n=>String(n).padStart(2,'0');
document.getElementById('clock').textContent=`${{d.getUTCFullYear()}}-${{p(d.getUTCMonth()+1)}}-${{p(d.getUTCDate())}} ${{p(d.getUTCHours())}}:${{p(d.getUTCMinutes())}}:${{p(d.getUTCSeconds())}}`}}
function durTxt(x){{x=Math.max(0,Math.floor(x));const d=Math.floor(x/86400),h=Math.floor(x%86400/3600),m=Math.floor(x%3600/60),s=x%60;
return d?`${{d}} 天 ${{h}} 小时 ${{m}} 分`:h?`${{h}} 小时 ${{m}} 分`:m?`${{m}} 分 ${{s}} 秒`:`${{s}} 秒`}}
function live(){{const now=T0+(Date.now()-P0);
document.querySelectorAll('[data-until]').forEach(e=>{{const left=(+e.dataset.until-now)/1000;e.textContent=durTxt(left);
if(left<=0&&!window._rl){{window._rl=1;setTimeout(()=>location.replace(location.pathname),1500)}}}});
document.querySelectorAll('[data-since]').forEach(e=>e.textContent=durTxt((now-e.dataset.since)/1000))}}
tick();live();setInterval(()=>{{tick();live()}},1000);
{"let typing=false;addEventListener('input',()=>typing=true);setInterval(()=>{const a=document.activeElement;if(!typing&&!(a&&/INPUT|SELECT/.test(a.tagName)))location.replace(location.pathname)},10000);" if refresh else ""}
</script>"""
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>{esc(title)} · 声场采集台</title>
<script>try{{document.documentElement.dataset.theme=localStorage.getItem('sound-atlas-theme')==='dark'?'dark':'light'}}catch{{document.documentElement.dataset.theme='light'}}</script>
<link rel="stylesheet" href="/static/collector.css"><script src="/static/collector.js" defer></script></head><body>
<header class="top"><div class="in"><a class="brand" href="/" aria-label="声场采集台首页"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>声场<small>SOUND ATLAS</small><span class="collector-label">采集台</span></a>
<nav class="main" aria-label="主导航">{nav}</nav>
<div class="nav-actions"><button type="button" class="theme-button" id="collector-theme" aria-label="切换明暗主题">明暗</button><a class="btn btn-dark show-site" href="https://www.alecyin.icu/sound-atlas/" target="_blank" rel="noopener">打开声场 ↗</a></div>
<div class="clock">北京时间 <span class="mono" id="clock">{local_time(now_ms / 1000)}</span></div></div></header>
<main><div class="page-heading"><div><p class="eyebrow">2F / SOUND OBSERVATION</p><h1>{esc(heading)}</h1><p class="lead">{esc(lead)}</p></div><span class="section-tag">5 张公桌 · 本地采集</span></div>
<div class="sync-panel" id="collector-sync" data-state="syncing" role="status"><span class="sync-signal" id="sync-status">正在检查同步</span><span class="sync-detail" id="sync-detail">连接展示站，自动更新观测数据。</span><a href="https://www.alecyin.icu/sound-atlas/" target="_blank" rel="noopener">查看实时声场 ↗</a></div>
{body}</main><footer class="collector-footer"><span>声场 SOUND ATLAS · 数据采集</span><span>观测时间统一按北京时间显示</span></footer>{script}</body></html>"""


# ---------------- 网页：总览 ----------------
def status_page(params=None):
    params = params or {}
    now = time.time()
    ver = get_plan()[0]
    code = plan_state()[0]
    with db_lock:
        info = {r[0]: r[1:] for r in conn.execute(
            "SELECT node, last_seen, cfg_ver, mic, synced FROM nodes").fetchall()}
        latest = {}
        for node in info:
            row = conn.execute("SELECT ts_ms, laeq FROM readings WHERE node=? ORDER BY ts_ms DESC LIMIT 1",
                               (node,)).fetchone()
            if row:
                latest[node] = row
    order = EXPECTED_NODES
    trs, n_ok = [], 0
    for node in order:
        place = NODE_PLACES.get(node, "")
        label = NODE_LABELS.get(node, node)
        marker = label.removeprefix("公桌 ")
        name_html = (f"<div class='station-name'><span class='station-badge'>{esc(marker)}</span>"
                     f"<div>{esc(label)}<span class='station-id'>{esc(node)}</span></div></div>")
        if node not in info:
            trs.append(f"<tr><td>{name_html}</td><td class='station-location'>{esc(place)}</td>"
                       f"<td class='muted'>还没连接</td><td class='num mono muted'>—</td><td class='num muted'>—</td></tr>")
            continue
        last_seen, cfg_ver, mic, synced = info[node]
        online = now - last_seen < ONLINE_S
        text, cls, hint = node_rec_state(cfg_ver, mic, synced, online, ver, code)
        if cls in ("ok", "muted") or (cls == "warn" and online):
            n_ok += 1
        lt = latest.get(node)
        fresh = cls == "ok" and lt and 0 <= now * 1000 - lt[0] < 120000 and lt[1] > 0
        val = f"{lt[1]:.1f}" if fresh else "—"
        ago = now - last_seen
        ago_txt = f"{int(ago)} 秒前" if ago < 120 else f"{int(ago // 60)} 分钟前" if ago < 7200 else f"{int(ago // 3600)} 小时前"
        hint_html = f"<div class='small muted' style='margin-top:2px;font-weight:400'>{esc(hint)}</div>" if hint else ""
        trs.append(f"<tr><td>{name_html}</td><td class='station-location'>{esc(place)}</td>"
                   f"<td><div class='{cls}'>{esc(text)}</div>{hint_html}</td>"
                   f"<td class='num reading'>{val}</td>"
                   f"<td class='num muted' style='white-space:nowrap'>{ago_txt}</td></tr>")
    body = f"""{msg_html(params)}
{state_card("/")}
<section class="card" style="padding-bottom:12px">
<div class="section-heading"><h2>五张公桌、个人工位 D2</h2>
<span class="small muted">{n_ok} / {len(order)} 正常 · 每 10 秒刷新</span></div>
<div class="scroll"><table class="t status-table" style="min-width:600px;margin-top:8px">
<tr><th>测点 / 设备</th><th>位置</th><th>状态</th><th class="num">当前 dB(A)</th><th class="num">最后上传</th></tr>
{"".join(trs)}</table></div>
</section>"""
    return page("总览", body, "/", refresh=True)


# ---------------- 网页：数据管理（页面在浏览器里运行，数据通过 /api/... 读取） ----------------
MANAGE_BODY = r'''
<div id="toast" class="msg" style="display:none;position:fixed;top:16px;right:16px;max-width:440px;z-index:9"></div>
<div class="manage-heading">
<p>原始记录始终可追溯，排除标记可以撤销。</p>
<div class="row"><a class="btn btn-dark" href="/export.csv?clean=1">导出干净数据</a>
<a class="btn" href="/export.csv?clean=0">导出原始数据</a></div>
</div>
<div id="usable" class="small muted" style="margin-top:-12px;line-height:1.7"></div>
<div class="table-mapping" aria-label="设备与公桌对应关系"><span><b>公桌 1</b>N3</span><span><b>公桌 2</b>N2</span><span><b>公桌 3</b>N1</span><span><b>公桌 A</b>N5</span><span><b>公桌 B</b>D1</span><span><b>个人工位</b>D2</span></div>

<section class="card" style="padding:20px 24px">
<div class="row">
<h2 style="margin:0 8px 0 0">曲线</h2>
<div class="row" role="group" aria-label="显示范围" style="gap:2px" id="ranges">
<button class="btn-sm btn-ghost" data-q="plan">计划时段</button><button class="btn-sm btn-ghost" data-q="all">全部</button>
<button class="btn-sm btn-ghost" data-q="today">今天</button><button class="btn-sm btn-ghost" data-q="hour">1 小时</button>
<button class="btn-sm btn-ghost" data-q="out">缩小</button><button class="btn-sm btn-ghost" data-q="back">返回</button>
</div>
<span class="small muted" style="margin-left:auto">在曲线上左右拖动来选时段</span>
</div>
<div id="chart" style="margin-top:12px;user-select:none"></div>
<div class="row small muted" style="margin-top:10px;gap:6px 18px;justify-content:space-between">
<span class="row" style="gap:6px 18px">
<span class="row" style="gap:6px"><span style="width:16px;height:10px;background:repeating-linear-gradient(45deg,var(--strong-line) 0 3px,var(--paper) 3px 7px)"></span>已排除</span>
<span class="row" style="gap:6px"><span style="width:4px;height:10px;background:var(--danger)"></span>无效读数</span>
<span class="row" style="gap:6px"><span style="width:16px;height:10px;background:var(--accent-soft);border:1.5px solid var(--accent)"></span>选区</span>
</span>
<span id="viewinfo" class="mono"></span>
</div>
<div id="hover" class="small" style="min-height:20px;margin-top:6px;color:var(--ink)"></div>
</section>

<section class="card" id="selcard" style="display:none;border:2px solid var(--accent);padding:20px 24px">
<h2 style="margin:0 0 12px">选区：<span class="mono" id="selrange" style="font-weight:600"></span></h2>
<div class="row" id="seltoggles" role="group" aria-label="选择节点"></div>
<div id="selcount" class="small muted" style="margin:10px 0 12px"></div>
<div class="row">
<label class="row" style="gap:8px">原因 <select id="reason"></select></label>
<input id="note" placeholder="备注（可不填）" style="flex:1 1 180px;min-width:0">
</div>
<div class="row" style="margin-top:12px">
<button class="btn-blue" id="btnEx">排除</button>
<button id="btnZoom">放大查看</button>
<button class="btn-ghost" id="btnClear">取消</button>
</div>
</section>

<section class="card" style="padding-bottom:12px">
<h2>可疑数据<small>自动找出，确认后再排除 · 已排除的不再列出</small></h2>
<div class="list" id="sus"><div class="muted">检查中…</div></div>
</section>

<section class="card" style="padding-bottom:12px">
<h2>已排除<small>撤销后数据立即恢复为可用</small></h2>
<div class="list" id="excl"></div>
</section>

<details class="card danger-zone" style="padding:16px 24px">
<summary class="small" style="cursor:pointer;color:var(--ink)">彻底删除（不可撤销，一般用不到）</summary>
<p class="small muted" style="line-height:1.7">删除前会自动把整个数据库备份到 backups 文件夹（采集一周后每份约 450 MB，不需要的可以手动删掉）。</p>
<div class="row"><button class="btn-line-red" id="btnPurgeSel">删除选区内的数据</button>
<button class="btn-line-red" id="btnPurgePlan">删除采集计划以外的全部数据</button></div>
<p class="small muted" style="margin-bottom:0">最近备份：<span id="backups">无</span></p>
</details>
'''

MANAGE_JS = r'''<script>
const BJ = 8 * 3600e3, $ = s => document.querySelector(s), pad = n => String(n).padStart(2, '0');
const TABLE_NAMES = {N1:'公桌 3',N2:'公桌 2',N3:'公桌 1',N4:'历史设备 N4',N5:'公桌 A',D1:'公桌 B',D2:'个人工位'};
function fmt(ms) { const d = new Date(ms + BJ);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; }
const fmtS = ms => fmt(ms).slice(5, 16);
function dur(ms) { let s = Math.round(ms / 1000); const d = Math.floor(s / 86400); s %= 86400; const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60; const p = []; if (d) p.push(d + ' 天'); if (h) p.push(h + ' 小时'); if (m) p.push(m + ' 分');
  if (s && !d && !h) p.push(s + ' 秒'); return p.join(' ') || '0 秒'; }
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const num = n => Number(n).toLocaleString('en-US');
async function api(path, body) {
  const r = await fetch(path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
  const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
let tt; function toast(t, err) { const e = $('#toast'); e.textContent = t; e.className = 'msg' + (err ? ' err' : ''); e.style.display = 'block';
  clearTimeout(tt); tt = setTimeout(() => e.style.display = 'none', err ? 9000 : 5000); }

let OV, VIEW, SER, SEL = null, SELN = new Set(), HIST = [], NODES = [], IDX = {}, RANGE = 'plan';
const LANE = 48, GAP = 8, TOP = 24, LEFT = 44, RIGHT = 4;

async function loadOverview() {
  OV = await api('/api/overview');
  NODES = OV.nodes.map(n => n.node);
  $('#usable').innerHTML = OV.nodes.length ? '可用于分析：' + OV.nodes.map(n =>
    `<b>${esc(n.node)}</b> ${(100 * n.usable / n.count).toFixed(1)}%`).join('　') : '数据库是空的';
  $('#reason').innerHTML = OV.reasons.map(r => `<option>${esc(r)}</option>`).join('');
  $('#backups').textContent = OV.backups.length ? OV.backups.slice(0, 3).map(b => `${b.name}（${b.mb} MB）`).join('，') : '无';
  renderExcl();
}
function renderExcl() {
  $('#excl').innerHTML = OV.exclusions.map(x => `<div data-grp="${x.grp}"><b style="min-width:32px">${x.nodes.length === NODES.length && NODES.length > 1 ? '全部' : x.nodes.map(esc).join('、')}</b>
    <span class="mono small" style="color:var(--ink)">${fmtS(x.start)} — ${fmtS(x.end)}</span><span class="muted">${esc(x.reason)}${x.note ? '：' + esc(x.note) : ''} · ${num(x.rows)} 条</span>
    <span class="grow"><button class="btn-sm" data-a="go">查看</button><button class="btn-sm" data-a="undo">撤销</button></span></div>`).join('')
    || '<div class="muted">还没有排除任何时段</div>';
  $('#excl').querySelectorAll('button').forEach(b => b.onclick = async () => {
    const grp = +b.closest('[data-grp]').dataset.grp, x = OV.exclusions.find(e => e.grp === grp);
    if (b.dataset.a === 'go') return locate(x.start, x.end, x.nodes);
    await api('/api/unexclude', {grp}); toast(`已撤销 ${x.nodes.join('、')} ${fmtS(x.start)} — ${fmtS(x.end)}`); refresh();
  });
}

// ---------- 视图 ----------
function dataRange() { if (!OV.nodes.length) return null;
  return [Math.min(...OV.nodes.map(n => n.first)), Math.max(...OV.nodes.map(n => n.last)) + 1000]; }
function markRange(q) { RANGE = q; document.querySelectorAll('#ranges button').forEach(b => {
  const on = b.dataset.q === q; b.className = 'btn-sm ' + (on ? 'btn-dark' : 'btn-ghost'); b.setAttribute('aria-pressed', on); }); }
async function setView(v, push = true) {
  if (push && VIEW) HIST.push(VIEW.slice());
  if (v[1] - v[0] < 60e3) { const c = (v[0] + v[1]) / 2; v = [c - 30e3, c + 30e3]; }
  VIEW = [Math.floor(v[0] / 1000) * 1000, Math.ceil(v[1] / 1000) * 1000];
  await loadSeries(); checkSuspects();
}
function quick(q) {
  const now = Date.now(), dr = dataRange();
  if (q === 'back') { if (HIST.length) { markRange(''); setView(HIST.pop(), false); } return; }
  if (q === 'out') { const c = (VIEW[0] + VIEW[1]) / 2, w = (VIEW[1] - VIEW[0]) * 1.5; markRange(''); setView([c - w, c + w]); return; }
  if (q === 'all') { if (dr) { markRange(q); setView(dr); } return; }
  if (q === 'hour') { markRange(q); setView([now - 3600e3, now]); return; }
  if (q === 'today') { const d0 = Math.floor((now + BJ) / 86400e3) * 86400e3 - BJ; markRange(q); setView([d0, d0 + 86400e3]); return; }
  if (q === 'plan') { const p = OV.plan; if (!p.start) return toast('还没有设置采集计划', true);
    markRange(q); setView([p.start, p.end || Math.max(now, dr ? dr[1] : now, p.start + 3600e3)]); }
}
document.querySelectorAll('#ranges button').forEach(b => b.onclick = () => quick(b.dataset.q));

async function loadSeries() {
  const W = $('#chart').clientWidth;
  SER = await api(`/api/series?start=${VIEW[0]}&end=${VIEW[1]}&w=${Math.max(100, Math.floor((W - LEFT - RIGHT) / 2))}`);
  IDX = {}; for (const n in SER.series) IDX[n] = new Map(SER.series[n].map(p => [p[0], p]));
  $('#viewinfo').textContent = `${fmtS(VIEW[0])} — ${fmtS(VIEW[1])} · 每点 ${dur(SER.bucket)}`;
  draw();
}
let X, T, W;
function draw() {
  const el = $('#chart'); W = el.clientWidth;
  if (!NODES.length) { el.innerHTML = '<div class="muted" style="padding:24px 0">还没有数据</div>'; return; }
  const H = TOP + NODES.length * (LANE + GAP), [t0, t1] = VIEW;
  X = t => LEFT + (W - LEFT - RIGHT) * (t - t0) / (t1 - t0); T = x => t0 + (x - LEFT) / (W - LEFT - RIGHT) * (t1 - t0);
  let lo = Infinity, hi = -Infinity;
  for (const n in SER.series) for (const p of SER.series[n]) if (p[2] != null) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[3]); }
  if (!isFinite(lo)) { lo = 30; hi = 80; } lo = Math.floor(lo / 5) * 5; hi = Math.ceil(hi / 5) * 5; if (hi - lo < 10) hi = lo + 10;
  const p = [`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--paper)"/><rect width="2.5" height="6" fill="var(--strong-line)"/></pattern>
    <clipPath id="plot"><rect x="${LEFT}" y="0" width="${W - LEFT - RIGHT}" height="${H}"/></clipPath></defs>`];
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800].map(s => s * 1000);
  const step = steps.find(s => (t1 - t0) / s <= (W - LEFT - RIGHT) / 90) || 172800e3;
  for (let t = Math.ceil((t0 + BJ) / step) * step - BJ; t <= t1; t += step) {
    const x = X(t), s = fmt(t), lab = step < 60e3 ? s.slice(11) : step < 86400e3 ? (s.slice(11, 16) === '00:00' ? s.slice(5, 10) : s.slice(11, 16)) : s.slice(5, 10);
    p.push(`<line x1="${x}" x2="${x}" y1="${TOP - 4}" y2="${H}" stroke="var(--line)"/><text x="${x}" y="${TOP - 9}" font-size="12" text-anchor="middle" fill="var(--muted)">${lab}</text>`);
  }
  NODES.forEach((n, i) => {
    const y0 = TOP + i * (LANE + GAP), Y = v => y0 + LANE - Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * LANE;
    p.push(`<rect x="${LEFT}" y="${y0}" width="${W - LEFT - RIGHT}" height="${LANE}" rx="6" fill="var(--paper)"/>`,
           `<text x="0" y="${y0 + LANE / 2 + 5}" font-size="12" font-weight="600" fill="var(--ink)"><title>${esc(n)}</title>${esc(TABLE_NAMES[n] || n)}</text><g clip-path="url(#plot)">`);
    for (const x of OV.exclusions) if (x.nodes.includes(n) && x.end > t0 && x.start < t1) {
      const a = Math.max(X(x.start), LEFT), b = Math.min(X(x.end), W - RIGHT);
      p.push(`<rect class="ex" data-grp="${x.grp}" x="${a}" y="${y0}" width="${Math.max(2, b - a)}" height="${LANE}" fill="url(#hatch)" style="cursor:pointer"><title>已排除：${esc(x.reason)}</title></rect>`);
    }
    const pts = SER.series[n] || [], bw = SER.bucket, xb = b => X(t0 + (b + 0.5) * bw), pxw = Math.max(1, (W - LEFT - RIGHT) * bw / (t1 - t0));
    let band = '', line = '', prev = null, bad = '';
    for (const q of pts) {
      if (q[5] > 0) bad += `M${xb(q[0])} ${y0}v${LANE}`;
      if (q[1] == null) { prev = null; continue; }
      const x = xb(q[0]); band += `M${x} ${Y(q[3])}V${Y(q[2]) + 0.5}`;
      line += (prev !== null && q[0] - prev <= 1 ? 'L' : 'M') + x.toFixed(1) + ' ' + Y(q[1]).toFixed(1); prev = q[0];
    }
    p.push(`<path d="${band}" stroke="var(--ink)" stroke-opacity=".12" stroke-width="${pxw}"/><path d="${line}" fill="none" stroke="var(--ink)" stroke-width="1.3"/>`,
           `<path d="${bad}" stroke="var(--danger)" stroke-width="${Math.max(2, pxw)}"/></g>`);
  });
  p.push('<g id="selg"></g><line id="hl" y1="0" y2="0" stroke="var(--ink)" stroke-dasharray="3 3"/>');
  el.innerHTML = `<svg width="${W}" height="${H}" style="display:block;cursor:crosshair">${p.join('')}</svg>`;
  bindChart(el.querySelector('svg'), H); drawSel();
}
function laneAt(y) { if (y < TOP) return -1; const i = Math.floor((y - TOP) / (LANE + GAP));
  return i < NODES.length && (y - TOP) - i * (LANE + GAP) <= LANE ? i : -2; }
let drag = null;
function bindChart(svg, H) {
  const pt = e => { const r = svg.getBoundingClientRect(); return {x: Math.max(LEFT, Math.min(W - RIGHT, e.clientX - r.left)), y: e.clientY - r.top, rx: e.clientX - r.left}; };
  svg.onpointerdown = e => { const q = pt(e), lane = laneAt(q.y); if (q.rx < LEFT - 2 || lane === -2) return;
    drag = {x0: q.x, x1: q.x, lane, shift: e.shiftKey, target: e.target}; svg.setPointerCapture(e.pointerId); };
  svg.onpointermove = e => { const q = pt(e); hover(q, svg, H); if (drag) { drag.x1 = q.x; drawSel(); } };
  svg.onpointerleave = () => { $('#hover').textContent = ''; svg.querySelector('#hl').setAttribute('y2', 0); };
  svg.onpointerup = () => { if (!drag) return; const d = drag; drag = null;
    if (Math.abs(d.x1 - d.x0) < 4) {
      if (d.target.classList && d.target.classList.contains('ex')) { const row = document.querySelector(`#excl [data-grp="${d.target.dataset.grp}"]`);
        if (row) { row.scrollIntoView({behavior: 'smooth', block: 'center'}); row.style.background = 'var(--accent-soft)'; setTimeout(() => row.style.background = '', 1600); } }
      drawSel(); return; }
    SEL = [Math.round(T(Math.min(d.x0, d.x1)) / 1000) * 1000, Math.round(T(Math.max(d.x0, d.x1)) / 1000) * 1000];
    if (!d.shift) SELN.clear(); if (d.lane >= 0) SELN.add(NODES[d.lane]); else NODES.forEach(n => SELN.add(n));
    updateSel(); };
}
function hover(q, svg, H) {
  const hl = svg.querySelector('#hl'); hl.setAttribute('x1', q.x); hl.setAttribute('x2', q.x); hl.setAttribute('y2', H);
  const t = T(q.x), lane = laneAt(q.y), b = Math.floor((t - VIEW[0]) / SER.bucket);
  let s = `北京时间 <span class="mono">${fmt(t)}</span>`;
  for (const n of (lane >= 0 ? [NODES[lane]] : NODES)) { const p = IDX[n] && IDX[n].get(b);
    s += `　<b>${n}</b> ` + (!p ? '无数据' : p[1] == null ? '无效' : (SER.bucket > 1000 ? `平均 ${p[1]} dB` : `${p[1]} dB`)); }
  $('#hover').innerHTML = s;
}
function drawSel() {
  const g = document.querySelector('#selg'); if (!g) return; let a, b, lanes;
  if (drag && Math.abs(drag.x1 - drag.x0) >= 4) { a = Math.min(drag.x0, drag.x1); b = Math.max(drag.x0, drag.x1);
    lanes = new Set(drag.shift ? SELN : []); if (drag.lane >= 0) lanes.add(NODES[drag.lane]); else NODES.forEach(n => lanes.add(n));
  } else if (SEL) { a = Math.max(LEFT, X(SEL[0])); b = Math.min(W - RIGHT, X(SEL[1])); lanes = SELN; if (b < LEFT || a > W - RIGHT) { g.innerHTML = ''; return; }
  } else { g.innerHTML = ''; return; }
  g.innerHTML = NODES.map((n, i) => lanes.has(n) ? `<rect x="${a}" y="${TOP + i * (LANE + GAP)}" width="${Math.max(1, b - a)}" height="${LANE}" fill="var(--accent)" fill-opacity=".16" stroke="var(--accent)" stroke-width="1.5" pointer-events="none"/>` : '').join('');
}

// ---------- 选区 ----------
let ct;
function updateSel() {
  $('#selcard').style.display = SEL ? 'block' : 'none'; drawSel(); if (!SEL) return;
  $('#selrange').textContent = `${fmtS(SEL[0])} — ${fmtS(SEL[1])}（${dur(SEL[1] - SEL[0])}）`;
  $('#seltoggles').innerHTML = NODES.map(n => `<button class="btn-sm pill ${SELN.has(n) ? 'btn-blue' : ''}" aria-pressed="${SELN.has(n)}" data-n="${esc(n)}" style="min-width:52px">${esc(n)}</button>`).join('')
    + '<button class="btn-sm btn-ghost" id="selall" style="color:var(--accent)">全选</button>';
  $('#seltoggles').querySelectorAll('[data-n]').forEach(b => b.onclick = () => { const n = b.dataset.n; SELN.has(n) ? SELN.delete(n) : SELN.add(n); updateSel(); });
  $('#selall').onclick = () => { NODES.forEach(n => SELN.add(n)); updateSel(); };
  clearTimeout(ct);
  if (!SELN.size) { $('#selcount').textContent = '请至少选一个节点'; $('#btnEx').textContent = '排除'; return; }
  ct = setTimeout(async () => { const c = await api(`/api/count?nodes=${encodeURIComponent([...SELN].join(','))}&start=${SEL[0]}&end=${SEL[1]}`);
    $('#selcount').textContent = `共 ${num(c.total)} 条（其中无效 ${num(c.invalid)}，已排除 ${num(c.excluded)}）`; $('#btnEx').textContent = `排除这 ${num(c.total)} 条`; }, 150);
}
$('#btnClear').onclick = () => { SEL = null; SELN.clear(); updateSel(); };
$('#btnZoom').onclick = () => { const w = (SEL[1] - SEL[0]) * 0.1; markRange(''); setView([SEL[0] - w, SEL[1] + w]); };
$('#btnEx').onclick = async () => {
  if (!SELN.size) return toast('请至少选一个节点', true);
  try { await api('/api/exclude', {nodes: [...SELN], start: SEL[0], end: SEL[1], reason: $('#reason').value, note: $('#note').value});
    toast(`已排除 ${[...SELN].join('、')} ${fmtS(SEL[0])} — ${fmtS(SEL[1])}，可在「已排除」里撤销`); $('#note').value = ''; SEL = null; SELN.clear(); refresh();
  } catch (e) { toast(e.message, true); } };
function locate(s, e, nodes) { const w = Math.max(e - s, 60e3), p = Math.max(w * 0.25, 30e3); SEL = [s, e]; SELN = new Set(nodes); markRange('');
  setView([s - p, e + p]).then(() => { updateSel(); $('#chart').scrollIntoView({behavior: 'smooth', block: 'start'}); }); }

// ---------- 可疑数据（每次换视图自动检查） ----------
async function checkSuspects() {
  try { const r = await api(`/api/suspects?start=${VIEW[0]}&end=${VIEW[1]}`), color = {invalid: 'bad', flat: 'bad', loud: 'warn'};
    const tag = {invalid: '无效读数（麦克风没信号）', flat: '读数几乎不变（麦克风可能故障）', loud: '持续 ≥ 85 dB（可能有人在测试，也可能是真实事件）'};
    $('#sus').innerHTML = r.items.map((g, i) => `<div data-i="${i}"><b style="min-width:32px">${esc(g.node)}</b>
      <span class="mono small" style="color:var(--ink)">${fmtS(g.start)} — ${fmtS(g.end)}</span><span class="${color[g.type]}">${tag[g.type]}</span>
      <span class="grow"><button class="btn-sm" data-a="go">查看</button><button class="btn-sm btn-line-blue" data-a="ex">排除</button></span></div>`).join('')
      || '<div class="muted">当前范围内没有发现可疑数据</div>';
    $('#sus').querySelectorAll('button').forEach(b => b.onclick = async () => { const g = r.items[+b.closest('[data-i]').dataset.i];
      if (b.dataset.a === 'go') return locate(g.start, g.end, [g.node]);
      await api('/api/exclude', {nodes: [g.node], start: g.start, end: g.end, reason: g.reason, note: '自动检查：' + g.name});
      toast(`已排除 ${g.node} ${fmtS(g.start)} — ${fmtS(g.end)}`); refresh(); });
  } catch (e) { $('#sus').innerHTML = `<div class="bad">${esc(e.message)}</div>`; }
}

// ---------- 彻底删除 ----------
async function purge(body) {
  try { const d = await api('/api/purge', {...body, dry: true}); if (!d.count) return toast('没有符合条件的数据', true);
    if (!confirm(`将彻底删除 ${num(d.count)} 条记录：\n${d.desc}\n\n删除前会自动备份整个数据库。确定吗？`)) return;
    const r = await api('/api/purge', body); toast(`已删除 ${num(r.deleted)} 条，删除前已备份为 backups\\${r.backup}`); SEL = null; SELN.clear(); refresh(true);
  } catch (e) { toast(e.message, true); } }
$('#btnPurgeSel').onclick = () => { if (!SEL || !SELN.size) return toast('先在曲线上拖出一个选区', true);
  purge({mode: 'range', nodes: [...SELN], start: SEL[0], end: SEL[1]}); };
$('#btnPurgePlan').onclick = () => purge({mode: 'outside_plan'});

async function refresh(reset) { await loadOverview(); if (reset || !VIEW) { const dr = dataRange(); if (dr) { markRange('all'); await setView(dr, false); } else draw(); }
  else { await loadSeries(); checkSuspects(); } updateSel(); }
window.onresize = () => { clearTimeout(window._rz); window._rz = setTimeout(() => SER && loadSeries(), 200); };
(async () => { await loadOverview(); const dr = dataRange(), p = OV.plan;
  if (!dr) { draw(); $('#sus').innerHTML = '<div class="muted">还没有数据</div>'; renderExcl(); return; }
  if (p.start && p.start < dr[1]) { markRange('plan'); await setView([p.start, Math.min(p.end || Infinity, dr[1])], false); }
  else { markRange('all'); await setView(dr, false); }
})().catch(e => toast(e.message, true));
</script>'''


def manage_page():
    return page("数据管理", MANAGE_BODY, "/manage").replace("</body>", MANAGE_JS + "</body>")


# ---------------- 数据管理：后台接口（网页里的 JavaScript 调用） ----------------
REASONS = ["调试 / 安装期间", "麦克风或接线故障", "人为测试（对着麦克风说话、敲击）", "非日常使用（布展、搬家具、打扫等）", "其他"]
SUSPECT_TYPES = {
    "invalid": ("无效读数", "麦克风没有信号（LAeq ≤ 0），通常是接线松了或断电重启", REASONS[1]),
    "flat": ("读数几乎不变", "1 分钟内波动不到 0.5 dB 且高于 45 dB，正常环境不会这样，麦克风可能故障", REASONS[1]),
    "loud": ("持续很响", "1 分钟平均 ≥ 85 dB，可能有人对着麦克风说话或测试；也可能是真实事件，请自行判断", REASONS[2]),
}
SUSPECT_FLAT_DB = 0.5
SUSPECT_FLAT_MIN_DB = 45
SUSPECT_LOUD_DB = 85


def api_overview():
    nodes = all_nodes()
    merged = merged_exclusions()
    with db_lock:
        summ = {}
        for node, cnt, bad in conn.execute("SELECT node, SUM(cnt), SUM(bad) FROM minute_stats GROUP BY node"):
            first, last = conn.execute("SELECT MIN(ts_ms), MAX(ts_ms) FROM readings WHERE node = ?", (node,)).fetchone()
            if first is not None:
                summ[node] = (first, last, cnt, bad)
        groups = conn.execute(
            "SELECT grp, GROUP_CONCAT(node, ','), MIN(start_ms), MAX(end_ms), MAX(reason), MAX(note), MIN(created) "
            "FROM exclusions GROUP BY grp ORDER BY MIN(start_ms)").fetchall()
    lst = []
    for n in nodes:
        if n in summ:
            first, last, count, bad = summ[n]
            exc = excluded_count(n, first, last + 1, merged)
            bad_in_exc = sum(count_rows(n, a, b, f" AND {INVALID_SQL}") for a, b in merged.get(n, []))
            usable = count - exc - ((bad or 0) - bad_in_exc)      # 去掉排除的，再去掉排除区之外的无效读数
            lst.append({"node": n, "color": node_color(n), "first": first, "last": last, "count": count,
                        "invalid": bad or 0, "excluded": exc, "usable": usable})
    excl = []
    for grp, ns, s, e, reason, note, created in groups:
        nl = [n for n in EXPECTED_NODES if n in ns.split(",")] + sorted(set(ns.split(",")) - set(EXPECTED_NODES))
        excl.append({"grp": grp, "nodes": nl, "start": s, "end": e, "reason": reason, "note": note or "",
                     "rows": sum(count_rows(n, s, e) for n in nl)})
    ver, ps, pe = get_plan()
    backups = sorted(BACKUP_DIR.glob("noise_*.db"), reverse=True) if BACKUP_DIR.exists() else []
    return {"nodes": lst, "exclusions": excl, "plan": {"start": ps, "end": pe}, "now": int(time.time() * 1000),
            "reasons": REASONS, "colors": {n: node_color(n) for n in nodes},
            "backups": [{"name": p.name, "mb": round(p.stat().st_size / 1e6, 1)} for p in backups[:10]]}


def api_series(q):
    """把 [start, end) 分成大约 w 段，每段给出各节点的 LAeq 平均、最小、最大、条数、无效条数"""
    s, e = int(q["start"]), int(q["end"])
    w = max(50, min(3000, int(q.get("w", 900))))
    if e <= s:
        raise ValueError("时间范围不对")
    per = -(-(e - s) // w)
    bucket = max(1000, -(-per // 1000) * 1000)          # 每段至少 1 秒，取整到秒
    if bucket >= 60000:                                   # 长时段：用每分钟统计
        bucket = -(-bucket // 60000) * 60000
        with db_lock:
            rows = conn.execute(
                "SELECT node, (m * 60000 - ?) / ? AS b, SUM(vsum) / SUM(vcnt), MIN(vmin), MAX(vmax), SUM(cnt), SUM(bad) "
                "FROM minute_stats WHERE m >= ? AND m < ? GROUP BY node, b ORDER BY node, b",
                (s, bucket, s // 60000, -(-e // 60000))).fetchall()
    else:                                                 # 短时段：直接用逐秒数据
        with db_lock:
            rows = conn.execute(
                f"SELECT node, (ts_ms - ?) / ? AS b, AVG(CASE WHEN {VALID_SQL} THEN laeq END), "
                f"MIN(CASE WHEN {VALID_SQL} THEN laeq END), MAX(CASE WHEN {VALID_SQL} THEN laeq END), "
                f"COUNT(*), SUM(CASE WHEN {INVALID_SQL} THEN 1 ELSE 0 END) "
                "FROM readings WHERE ts_ms >= ? AND ts_ms < ? GROUP BY node, b ORDER BY node, b",
                (s, bucket, s, e)).fetchall()
    series = {}
    r1 = lambda v: None if v is None else round(v, 1)
    for node, b, avg, mn, mx, cnt, bad in rows:
        series.setdefault(node, []).append([b, r1(avg), r1(mn), r1(mx), cnt, bad])
    return {"start": s, "end": e, "bucket": bucket, "series": series}


def parse_nodes(v):
    nodes = [n for n in (v if isinstance(v, list) else str(v or "").split(",")) if n]
    if not nodes:
        raise ValueError("请至少选一个节点")
    return nodes


def api_count(q):
    nodes = parse_nodes(q.get("nodes"))
    s, e = int(q["start"]), int(q["end"])
    merged = merged_exclusions()
    total = invalid = excluded = 0
    for n in nodes:
        total += count_rows(n, s, e)
        invalid += count_rows(n, s, e, f" AND {INVALID_SQL}")
        excluded += excluded_count(n, s, e, merged)
    return {"total": total, "invalid": invalid, "excluded": excluded}


def api_suspects(q):
    """自动找可疑数据段（已经排除的不再列出）"""
    s, e = int(q["start"]), int(q["end"])
    merged = merged_exclusions()
    segs = []

    def add(node, kind, t0, t1, n, info):
        last = segs[-1] if segs else None
        if last and last["node"] == node and last["type"] == kind and t0 - last["end"] <= 120000:
            last["end"] = max(last["end"], t1)
            last["rows"] += n
            last["peak"] = max(last["peak"], info)
        else:
            segs.append({"node": node, "type": kind, "start": t0, "end": t1, "rows": n, "peak": info})

    m_lo, m_hi = s // 60000, -(-e // 60000)
    with db_lock:
        mins = conn.execute("SELECT node, m, cnt, bad, vcnt, vsum, vmin, vmax FROM minute_stats "
                            "WHERE m >= ? AND m < ? ORDER BY node, m", (m_lo, m_hi)).fetchall()
    # 1) 无效读数：先用分钟统计找到有无效读数的分钟，再逐条找，连续的合并成一段（精确到秒）
    for node, m, cnt, bad, vcnt, vsum, vmin, vmax in mins:
        if bad:
            with db_lock:
                ts = conn.execute(f"SELECT ts_ms FROM readings WHERE node = ? AND ts_ms >= ? AND ts_ms < ? "
                                  f"AND {INVALID_SQL} ORDER BY ts_ms",
                                  (node, max(s, m * 60000), min(e, (m + 1) * 60000))).fetchall()
            for (t,) in ts:
                add(node, "invalid", t, t + 1000, 1, 0)
    # 2) 读数几乎不变 / 持续很响：按分钟判断，同一分钟只归一类
    for kind in ("flat", "loud"):
        for node, m, cnt, bad, vcnt, vsum, vmin, vmax in mins:
            if not vcnt:
                continue
            avg = vsum / vcnt
            flat = vcnt >= 30 and vmax - vmin < SUSPECT_FLAT_DB and avg > SUSPECT_FLAT_MIN_DB
            if kind == "flat" and flat:
                add(node, "flat", m * 60000, (m + 1) * 60000, vcnt, round(avg, 1))
            elif kind == "loud" and not flat and avg >= SUSPECT_LOUD_DB:
                add(node, "loud", m * 60000, (m + 1) * 60000, vcnt, round(avg, 1))
    out = []
    for g in segs:
        if fully_excluded(g["node"], g["start"], g["end"], merged):
            continue
        name, desc, reason = SUSPECT_TYPES[g["type"]]
        g.update(name=name, desc=desc, reason=reason)
        out.append(g)
    out.sort(key=lambda g: (g["start"], g["node"]))
    return {"items": out[:300], "more": max(0, len(out) - 300)}


def api_exclude(body):
    nodes = parse_nodes(body.get("nodes"))
    s, e = int(body["start"]), int(body["end"])
    if e <= s:
        raise ValueError("结束时间要晚于开始时间")
    reason = str(body.get("reason") or REASONS[-1])[:60]
    note = str(body.get("note") or "")[:200]
    with db_lock:
        grp = (conn.execute("SELECT MAX(grp) FROM exclusions").fetchone()[0] or 0) + 1
        conn.executemany("INSERT INTO exclusions (grp, node, start_ms, end_ms, reason, note, created) "
                         "VALUES (?,?,?,?,?,?,?)", [(grp, n, s, e, reason, note, time.time()) for n in nodes])
        conn.commit()
    print(f"{local_time(time.time())}  标记排除：{','.join(nodes)}  {local_time(s / 1000)} 至 {local_time(e / 1000)}"
          f"  原因：{reason}", flush=True)
    return {"ok": True, "grp": grp}


def api_unexclude(body):
    grp = int(body["grp"])
    with db_lock:
        n = conn.execute("DELETE FROM exclusions WHERE grp = ?", (grp,)).rowcount
        conn.commit()
    print(f"{local_time(time.time())}  撤销排除标记（第 {grp} 组，{n} 个节点）", flush=True)
    return {"ok": True}


def api_purge(body):
    """彻底删除（先自动备份）。dry=true 时只返回将要删除的条数"""
    mode = body.get("mode")
    if mode == "range":
        nodes = parse_nodes(body.get("nodes"))
        s, e = int(body["start"]), int(body["end"])
        where = f"node IN ({','.join('?' * len(nodes))}) AND ts_ms >= ? AND ts_ms < ?"
        args = nodes + [s, e]
        desc = f"{','.join(nodes)} 在 {local_time(s / 1000)} 至 {local_time(e / 1000)} 的数据"
    elif mode == "outside_plan":
        _, ps, pe = get_plan()
        if not ps:
            raise ValueError("还没有设置采集计划，无法判断哪些是计划外的数据")
        where, args = ("ts_ms < ? OR ts_ms >= ?", [ps, pe]) if pe else ("ts_ms < ?", [ps])
        desc = "采集计划时段以外的全部数据"
    else:
        raise ValueError("未知操作")
    with db_lock:
        n = conn.execute(f"SELECT COUNT(*) FROM readings WHERE {where}", args).fetchone()[0]
    if body.get("dry"):
        return {"count": n, "desc": desc}
    if n == 0:
        return {"deleted": 0, "backup": None}
    bpath = backup_db()
    with db_lock:
        deleted = conn.execute(f"DELETE FROM readings WHERE {where}", args).rowcount
        if mode == "range":
            for n in nodes:
                refresh_minutes(n, s, e - 1)
            conn.commit()
        else:
            conn.commit()
            rebuild_minutes()
    print(f"{local_time(time.time())}  彻底删除 {deleted} 条（{desc}），删除前已备份为 backups\\{bpath.name}", flush=True)
    return {"deleted": deleted, "backup": bpath.name}


def next_minute_after(sec_from_now):
    """现在起至少 sec_from_now 秒之后的下一个整分钟（毫秒）"""
    t = int(time.time() + sec_from_now)
    return ((t + 59) // 60) * 60 * 1000


def control_page(params):
    now = time.time()
    ver, s, e = get_plan()
    code, _ = plan_state()
    ready = node_readiness(now)
    n_ready = sum(1 for r in ready if r[5] == "就绪")
    q2 = next_minute_after(120)
    start_val = esc(params.get("start", "")) or (
        input_time(s / 1000) if s and code in ("waiting", "recording") else input_time(q2 / 1000))
    end_val = esc(params.get("end", "")) or (input_time(e / 1000) if e and code in ("waiting", "recording") else "")

    chips = "".join(f"<span class='chip {'y' if r[5] == '就绪' else 'n'}'>{'✓' if r[5] == '就绪' else '✕'} {esc(NODE_LABELS.get(r[0], r[0]))} · {esc(r[0])}</span>"
                    for r in ready)
    problems = "".join(f"<div class='bad' style='font-weight:400'><b>{esc(NODE_LABELS.get(r[0], r[0]))} · {esc(r[0])}</b>：{esc(r[5])}</div>"
                       for r in ready if r[5] != "就绪")
    comp = ""
    if s and now * 1000 > s:                   # 记录开始后显示各节点完整率
        hi = min(now * 1000, e) if e else now * 1000
        with db_lock:
            counts = dict(conn.execute("SELECT node, COUNT(*) FROM readings WHERE ts_ms >= ? AND ts_ms < ? GROUP BY node",
                                       (s, hi)).fetchall())
        expect = max(1, int((hi - s) / 1000))
        comp = ("<div class='small muted' style='margin-top:12px;line-height:1.8'>本次完整率：" +
                "　".join(f"<b>{esc(r[0])}</b> {100 * counts.get(r[0], 0) / expect:.1f}%" for r in ready) + "</div>")
        export = {"clean": 1, "s": s}
        if e:
            export["e"] = e
        comp += f"<div class='small' style='margin-top:6px'><a href='/export.csv?{urlencode(export)}'>导出本次记录的干净数据（CSV）</a></div>"

    body = f"""{msg_html(params)}
{state_card("/control")}
<section class="card">
<h2>设定时间<small>北京时间</small></h2>
<div class="row">
<form method="post" action="/plan"><input type="hidden" name="action" value="continuous"><input type="hidden" name="back" value="/control">
<button class="pill" type="submit">持续采集（不设结束时间）</button></form>
<form method="post" action="/plan"><input type="hidden" name="action" value="quick"><input type="hidden" name="days" value="7">
<button class="pill" type="submit">{hm(q2 / 1000)} 开始 · 持续 7 天</button></form>
</div>
<form method="post" action="/plan" class="row" style="align-items:flex-end;gap:16px;margin-top:18px">
<input type="hidden" name="action" value="set">
<label style="display:flex;flex-direction:column;gap:6px;flex:1 1 220px;color:var(--ink)">开始
<input type="datetime-local" step="1" name="start" value="{start_val}" class="mono" required></label>
<label style="display:flex;flex-direction:column;gap:6px;flex:1 1 220px;color:var(--ink)">结束（留空 = 手动停止）
<input type="datetime-local" step="1" name="end" value="{end_val}" class="mono"></label>
<button class="btn-dark" type="submit" style="padding:10px 28px">保存</button>
</form>
<p class="small muted" style="margin:14px 0 0">开始时间至少比现在晚 {MIN_LEAD_S} 秒。正在记录时，开始时间不动、只改结束时间即可。</p>
</section>
<section class="card">
<h2>节点就绪 <span class="mono">{n_ready} / {len(ready)}</span></h2>
<div class="row" style="gap:8px">{chips}</div>
<div style="margin-top:12px;display:flex;flex-direction:column;gap:4px">{problems}</div>
{"<p class='small muted' style='margin:10px 0 0'>没就绪的节点会在就绪后才开始记录，最好全部就绪再开始。</p>" if problems else ""}
{comp}
</section>"""
    return page("采集计划", body, "/control", refresh=True)


def handle_plan_form(form):
    """处理计划表单；返回提示文字，出错时抛 ValueError"""
    action = form.get("action", "")
    now_ms = time.time() * 1000
    ver, s, e = get_plan()
    code, _ = plan_state(now_ms)
    if action == "continuous":
        if code == "recording" and e == 0:
            return "已经处于持续采集，直到手动停止。"
        start = s if code == "recording" else -(-int(now_ms + MIN_LEAD_S * 1000) // 10000) * 10000
        end = 0
    elif action == "start_now":
        if code == "recording":
            raise ValueError("已经在记录了")
        start = -(-int(now_ms + MIN_LEAD_S * 1000) // 10000) * 10000     # 约 30 秒后，取整到 10 秒
        end = 0
    elif action == "quick":
        start = next_minute_after(120)
        days = int(form.get("days", "0") or 0)
        end = start + days * 86400 * 1000 if days else 0
    elif action == "set":
        start = parse_input_time(form.get("start"))
        end = parse_input_time(form.get("end")) or 0
        if start is None:
            raise ValueError("请填写开始时间")
        start = start // 1000 * 1000
        end = end // 1000 * 1000
        keep_running = code == "recording" and start == s     # 正在记录，只改结束时间
        if not keep_running and start < now_ms + MIN_LEAD_S * 1000:
            raise ValueError(f"开始时间至少要比现在晚 {MIN_LEAD_S} 秒（节点需要时间收到计划）")
        if end and end <= start:
            raise ValueError("结束时间要晚于开始时间")
        if keep_running and end and end < now_ms + STOP_LEAD_S * 1000:
            raise ValueError(f"结束时间至少要比现在晚 {STOP_LEAD_S} 秒；想马上停请用「统一停止」")
    elif action == "stop":
        if code != "recording":
            raise ValueError("现在没有在记录")
        start = s
        end = (int(now_ms / 1000) + STOP_LEAD_S) * 1000
    elif action == "cancel":
        start, end = 0, 0
        if code == "recording":     # 正在记录时「取消」等同于统一停止，保证所有节点同一秒停下
            start, end = s, (int(now_ms / 1000) + STOP_LEAD_S) * 1000
    else:
        raise ValueError("未知操作")
    ver, s, e = set_plan(start, end)
    if s == 0:
        text = "已取消，节点不会开始记录"
    elif action in ("start_now", "continuous"):
        text = f"好的，所有节点将在 {local_time(s / 1000)} 同时开始记录（不设结束）"
    elif action in ("stop", "cancel"):
        text = f"好的，所有节点将在 {local_time(e / 1000)} 同时停止记录（本次共 {fmt_dur((e - s) / 1000)}）"
    else:
        text = f"已保存（版本 {ver}）：{local_time(s / 1000)} 开始，" + (
            f"{local_time(e / 1000)} 结束（共 {fmt_dur((e - s) / 1000)}）" if e else "不设结束")
    print(f"{local_time(time.time())}  采集计划：{text}", flush=True)
    return text


# ---------------- 请求处理 ----------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 关掉默认的每条请求日志

    def send_text(self, code, text, ctype="text/plain; charset=utf-8"):
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200):
        self.send_text(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def redirect(self, location):
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query, keep_blank_values=True).items()}

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length)

    def run_api(self, fn, arg):
        try:
            result = fn(arg) if arg is not None else fn()
            if SYNC_BRIDGE and fn in (api_exclude, api_unexclude, api_purge):
                SYNC_BRIDGE.builder.invalidate()
            self.send_json(result)
        except (ValueError, KeyError, TypeError) as e:
            self.send_json({"error": f"参数有误：{e}"}, 400)
        except Exception as e:
            self.send_json({"error": f"出错了：{e}"}, 500)

    def do_GET(self):
        path = urlparse(self.path).path
        static_types = {"collector.css": "text/css; charset=utf-8", "collector.js": "text/javascript; charset=utf-8", "instrument-sans.ttf": "font/ttf"}
        asset = path.removeprefix("/static/")
        if path.startswith("/static/") and asset in static_types:
            data = (STATIC_DIR / asset).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", static_types[asset])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
        elif path == "/api/sync-status":
            status = SYNC_BRIDGE.status() if SYNC_BRIDGE else {"state": "disabled", "message": "尚未启用展示站同步。", "last_success": None}
            status["state"] = {"online": "live", "disabled": "unconfigured", "retrying": "error"}.get(status["state"], status["state"])
            status["remote_control"] = REMOTE_CONTROL.status() if REMOTE_CONTROL else None
            self.send_json(status)
        elif path == "/api/live":
            if SYNC_BRIDGE:
                self.run_api(SYNC_BRIDGE.snapshot, None)
            else:
                self.send_json({"error": "同步服务尚未启动。"}, 503)
        elif path == "/time":
            self.send_text(200, str(int(time.time() * 1000)))
        elif path == "/config":
            ver, s, e = get_plan()
            self.send_text(200, f"{ver} {s} {e}")
        elif path in ("/", "/status"):
            self.send_text(200, status_page(self.query()), "text/html; charset=utf-8")
        elif path == "/manage":
            self.send_text(200, manage_page(), "text/html; charset=utf-8")
        elif path == "/control":
            self.send_text(200, control_page(self.query()), "text/html; charset=utf-8")
        elif path == "/export.csv":
            self.send_export(self.query())
        elif path == "/api/overview":
            self.run_api(api_overview, None)
        elif path == "/api/series":
            self.run_api(api_series, self.query())
        elif path == "/api/count":
            self.run_api(api_count, self.query())
        elif path == "/api/suspects":
            self.run_api(api_suspects, self.query())
        else:
            self.send_text(404, "not found")

    def do_POST(self):
        path = urlparse(self.path).path
        if path in ("/plan", "/api/exclude", "/api/unexclude", "/api/purge"):
            origin = self.headers.get("Origin")
            if (origin and urlparse(origin).netloc != self.headers.get("Host")) or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_json({"error": "请从本机采集页面提交操作。"}, 403)
                return
        if path == "/upload":
            self.handle_upload()
        elif path == "/plan":
            form = {k: v[0] for k, v in parse_qs(self.read_body().decode("utf-8"), keep_blank_values=True).items()}
            back = "/" if form.get("back") == "/" else "/control"
            try:
                self.redirect(back + "?" + urlencode({"msg": handle_plan_form(form)}))
            except ValueError as e:
                self.redirect(back + "?" + urlencode({"err": str(e), "start": form.get("start", ""),
                                                      "end": form.get("end", "")}))
        elif path in ("/api/exclude", "/api/unexclude", "/api/purge"):
            try:
                body = json.loads(self.read_body() or b"{}")
            except ValueError:
                self.send_json({"error": "数据格式不对"}, 400)
                return
            fn = {"/api/exclude": api_exclude, "/api/unexclude": api_unexclude, "/api/purge": api_purge}[path]
            self.run_api(fn, body)
        else:
            self.send_text(404, "not found")

    def handle_upload(self):
        try:
            body = self.read_upload_body()
            payload, node, rows = decode_upload(body, len(UPLOAD_ORDER))
        except UploadError as error:
            self.record_upload_error(error)
            self.upload_reply(error.status, "upload rejected; retain batch and retry")
            return
        try:
            # The whole batch and its aggregates commit together, or roll back together.
            with db_lock, conn:
                before = conn.total_changes
                conn.executemany(
                    f"INSERT OR IGNORE INTO readings (node, ts_ms, {', '.join(UPLOAD_ORDER)}) "
                    f"VALUES ({', '.join(['?'] * (2 + len(UPLOAD_ORDER)))})", rows)
                added = conn.total_changes - before
                if rows:
                    ts = [r[1] for r in rows]
                    refresh_minutes(node, min(ts), max(ts))
                conn.execute(
                    "INSERT INTO nodes (node, last_seen, ip, rssi, uptime, buffered, cfg_ver, mic, synced) "
                    "VALUES (?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(node) DO UPDATE SET last_seen=excluded.last_seen, ip=excluded.ip, "
                    "rssi=excluded.rssi, uptime=excluded.uptime, buffered=excluded.buffered, "
                    "cfg_ver=excluded.cfg_ver, mic=excluded.mic, synced=excluded.synced",
                    (node, time.time(), self.client_address[0], payload.get("rssi"),
                     payload.get("up"), payload.get("buf"), payload.get("cfg"), payload.get("mic"),
                     payload.get("sync")))
            if rows:
                print(f"{local_time(time.time())}  {node:<3}  收到 {len(rows):>3} 条（新增 {added:>3}）"
                      f"  最新 LAeq {rows[-1][2]:5.1f} dB  信号 {payload.get('rssi')} dBm", flush=True)
            else:
                print(f"{local_time(time.time())}  {node:<3}  心跳（未在记录）  信号 {payload.get('rssi')} dBm", flush=True)
        except Exception as error:
            print(f"{local_time(time.time())}  {node} 上传未保存：{error}；等待重传", flush=True)
            self.upload_reply(500, "save failed; retain batch and retry")
            return
        self.upload_reply(200, "OK", node)

    def read_upload_body(self):
        previous_timeout = self.connection.gettimeout()
        self.connection.settimeout(10)
        try:
            return read_upload(self.rfile, self.headers)
        finally:
            self.connection.settimeout(previous_timeout)

    def upload_reply(self, status, text, node=None):
        try:
            self.send_text(status, text)
        except OSError:
            self.close_connection = True
            if status == 200:
                print(f"{local_time(time.time())}  {node} 已保存，确认未送达；重传会自动去重", flush=True)

    def record_upload_error(self, error):
        node = node_hint(error.body)
        if node is None:
            with db_lock:
                match = conn.execute("SELECT node FROM nodes WHERE ip=? ORDER BY last_seen DESC LIMIT 1",
                                     (self.client_address[0],)).fetchone()
            node = match[0] if match else "unknown"
        expected = error.expected
        if expected is None:
            expected = self.headers.get("Content-Length")
        record = {"time_beijing": local_time(time.time()), "node": node,
                  "ip": self.client_address[0], "kind": error.kind,
                  "expected_bytes": expected, "received_bytes": len(error.body),
                  "json_position": error.position, "message": str(error)}
        label = {"incomplete": "连接提前结束", "interrupted": "连接中断或超时",
                 "json": "完整接收但 JSON 格式异常", "empty": "空上传"}.get(error.kind, "上传格式异常")
        print(f"{record['time_beijing']}  {node} {label}：应收 {expected} 字节，"
              f"实收 {len(error.body)} 字节，位置 {error.position}；未确认成功，等待重传", flush=True)
        # Retain at most one bounded sample per known device, locally only.
        key = node if node in EXPECTED_NODES else "unknown"
        try:
            folder = DB_PATH.parent / "logs" / "upload_diagnostics"
            folder.mkdir(parents=True, exist_ok=True)
            with db_lock:
                (folder / f"{key}.body.bin").write_bytes(error.body)
                (folder / f"{key}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as log_error:
            print(f"上传诊断文件写入失败：{log_error}", flush=True)

    def send_export(self, q):
        """导出 CSV。clean=1（默认）：去掉排除时段和无效读数；clean=0：全部原始数据并加两列标记。
        可选参数：s / e（毫秒时间戳）限定时段，node 限定节点"""
        clean = q.get("clean", "1") != "0"
        try:
            s = int(q["s"]) if q.get("s") else None
            e = int(q["e"]) if q.get("e") else None
        except ValueError:
            self.send_text(400, "时间参数有误")
            return
        nodes = [q["node"]] if q.get("node") else all_nodes()
        merged = merged_exclusions()
        stamp = datetime.now(BJ).strftime("%Y%m%d_%H%M")
        name = f"noise_{'clean' if clean else 'raw'}_{stamp}.csv"
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        self.wfile.write("﻿".encode("utf-8"))  # 让 Excel 正确识别中文和 UTF-8
        head = "node,time_beijing,ts_ms," + ",".join(COLUMNS) + ("" if clean else ",invalid,excluded")
        self.wfile.write((head + "\n").encode("utf-8"))
        CHUNK = 6 * 3600 * 1000
        for node in nodes:
            with db_lock:
                lo, hi = conn.execute("SELECT MIN(ts_ms), MAX(ts_ms) FROM readings WHERE node = ?", (node,)).fetchone()
            if lo is None:
                continue
            lo = max(lo, s) if s is not None else lo
            hi = min(hi + 1, e) if e is not None else hi + 1
            ivs, k = merged.get(node, []), 0
            t = lo
            while t < hi:
                with db_lock:
                    rows = conn.execute(
                        f"SELECT ts_ms, {', '.join(COLUMNS)}, {INVALID_SQL} FROM readings "
                        "WHERE node = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms",
                        (node, t, min(t + CHUNK, hi))).fetchall()
                out = []
                for r in rows:
                    ts = r[0]
                    while k < len(ivs) and ivs[k][1] <= ts:
                        k += 1
                    exc = k < len(ivs) and ivs[k][0] <= ts
                    bad = bool(r[-1])
                    if clean and (exc or bad):
                        continue
                    line = f"{node},{local_time(ts / 1000)},{ts}," + ",".join("" if v is None else f"{v:.2f}" for v in r[1:-1])
                    if not clean:
                        line += f",{int(bad)},{int(exc)}"
                    out.append(line)
                if out:
                    self.wfile.write(("\n".join(out) + "\n").encode("utf-8"))
                t += CHUNK


class CollectorHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        # One receiver must own the device port; Windows SO_REUSEADDR permits duplicates.
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == "__main__":
    print("=" * 60, flush=True)
    print(" 噪声监测接收程序已启动")
    print(f" 数据库：{DB_PATH}")
    print(f" 现在的北京时间：{local_time(time.time())}")
    print("   ↑ 如果和手机上的北京时间对不上，说明电脑时钟不准，请先在 Windows 设置里「立即同步」时间")
    print(" 本机 IP（把连着腾达路由器的那个填进 ESP32 程序的 SERVER_IP）：")
    for ip in local_ips():
        print(f"     {ip}")
    print(f" 浏览器查看状态：http://localhost:{PORT}")
    print(f" 数据管理（曲线 / 排除 / 导出）：http://localhost:{PORT}/manage")
    print(f" 采集计划（统一开始 / 结束）：http://localhost:{PORT}/control")
    print(f" 当前计划：{plan_state()[1]}")
    print(" 按 Ctrl+C 停止")
    print("=" * 60, flush=True)
    try:
        server = CollectorHTTPServer((os.environ.get("SOUND_ATLAS_BIND", "0.0.0.0"), PORT), Handler)
    except OSError:
        print(f"\n端口 {PORT} 已被占用：可能已经有一个接收程序窗口在运行，先把它关掉再试。")
        try:
            input("按回车键退出")
        except EOFError:
            pass
        raise SystemExit(1)
    sync_config = os.environ.get("SOUND_ATLAS_SYNC_CONFIG", str(Path(__file__).with_name("live_bridge_config.json")))
    SYNC_BRIDGE = LiveBridge(DB_PATH, config_path=sync_config).start()
    REMOTE_CONTROL = RemoteControl(sys.modules[__name__], config_path=sync_config).start()
    print(" 声场展示站同步已启动，采集数据仍保存在本机。", flush=True)
    print(" 站内采集管理：https://www.alecyin.icu/sound-atlas/collect/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        REMOTE_CONTROL.stop()
        SYNC_BRIDGE.stop()
        server.server_close()
        conn.close()
