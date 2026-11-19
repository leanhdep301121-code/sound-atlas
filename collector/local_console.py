"""Serve the shared website UI and its management contract without cloud access."""
import hashlib
import hmac
import json
import mimetypes
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import urlparse, unquote, parse_qs

from remote_control import RemoteControl, RemoteError, ALLOWED_ACTIONS, WRITE_ACTIONS, _iso


class LocalHttpError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class LocalConsole:
    COOKIE = 'sound-atlas-local-admin'

    def __init__(self, receiver, *, web_root=None, key_file=None):
        self.receiver = receiver
        root = Path(receiver.__file__).resolve().parent
        self.web_root = Path(web_root or (root / 'web' if (root / 'web').is_dir() else root.parent / 'dist')).resolve()
        self.key_file = Path(key_file or root / '管理登录口令.txt')
        self.worker = RemoteControl(receiver, journal_path=receiver.DB_PATH.with_name('local_commands.db'))
        with self.worker._lock:
            self.worker._journal.execute('CREATE TABLE IF NOT EXISTS local_requests(id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL)')
            self.worker._journal.commit()
        self.allowed_hosts = {'localhost', '127.0.0.1', '::1', *receiver.local_ips()}
        self.sessions, self.attempts = {}, {}
        self.lock = threading.RLock()

    def close(self):
        self.worker.stop()

    def _origin(self, handler):
        host = handler.headers.get('Host', '')
        origin = urlparse(handler.headers.get('Origin', ''))
        if origin.scheme not in ('http', 'https') or origin.netloc != host or handler.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise LocalHttpError(403, '请从本机采集页面提交操作。')

    def _body(self, handler):
        try:
            size = int(handler.headers.get('Content-Length', '0'))
            if not 0 < size <= 20000:
                raise ValueError()
            data = handler.rfile.read(size)
            value = json.loads(data)
            if len(data) != size or not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, TypeError):
            raise LocalHttpError(400, '请求格式有误。') from None

    def _session(self, handler, *, required=False, write=False):
        token = next((v.partition('=')[2] for v in handler.headers.get('Cookie', '').split(';') if v.strip().startswith(self.COOKIE + '=')), '')
        with self.lock:
            session = self.sessions.get(token)
            if session and session['expires'] <= time.time():
                self.sessions.pop(token, None)
                session = None
        if not session and required:
            raise LocalHttpError(401, '请先进入管理模式。')
        if session and write:
            self._origin(handler)
            if not hmac.compare_digest(handler.headers.get('X-CSRF-Token', ''), session['csrf']):
                raise LocalHttpError(403, '页面验证已失效，请刷新后重试。')
        return session, token

    def _json(self, handler, value, status=200, cookie=None):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        handler.send_response(status)
        handler.send_header('Content-Type', 'application/json; charset=utf-8')
        handler.send_header('Content-Length', str(len(data)))
        handler.send_header('Cache-Control', 'no-store')
        handler.send_header('X-Content-Type-Options', 'nosniff')
        if cookie is not None:
            handler.send_header('Set-Cookie', f'{self.COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age={28800 if cookie else 0}')
        handler.end_headers()
        handler.wfile.write(data)

    def _login(self, handler):
        self._origin(handler)
        body = self._body(handler)
        address, now = handler.client_address[0], time.time()
        with self.lock:
            self.attempts = {ip:entry for ip,entry in self.attempts.items() if now-entry[0] < 600}
            start, attempts = self.attempts.get(address, (now, 0))
            if attempts >= 8:
                raise LocalHttpError(429, '登录尝试较多，请十分钟后重试。')
            self.attempts[address] = (start, attempts+1)
        try:
            keys = [line.strip() for line in self.key_file.read_text(encoding='utf-8-sig').splitlines() if re.fullmatch(r'[A-Za-z0-9_-]{43}', line.strip())]
        except OSError:
            keys = []
        if len(keys) != 1:
            raise LocalHttpError(503, '本机管理口令文件不可用，请检查管理登录口令.txt。')
        supplied = body.get('key')
        if not isinstance(supplied, str) or not hmac.compare_digest(hashlib.sha256(supplied.strip().encode()).digest(), hashlib.sha256(keys[0].encode()).digest()):
            raise LocalHttpError(401, '管理口令不正确。')
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with self.lock:
            self.sessions = {t:s for t,s in self.sessions.items() if s['expires'] > now}
            self.sessions[token] = {'csrf':csrf, 'expires':now+28800}
            self.attempts.pop(address, None)
        self._json(handler, {'authenticated':True, 'csrf':csrf}, cookie=token)

    def _command(self, handler):
        self._origin(handler)
        body = self._body(handler)
        action, payload, request_id = body.get('action'), body.get('payload', {}), body.get('requestId')
        if action not in ALLOWED_ACTIONS or not isinstance(payload, dict) or not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_id):
            raise LocalHttpError(400, '操作或参数格式有误。')
        if action in WRITE_ACTIONS:
            self._session(handler, required=True, write=True)
            identifier = 'local-'+hashlib.sha256(request_id.encode()).hexdigest()
            # Reuse original command timestamps across retries and receiver restarts.
            with self.worker._lock:
                self.worker._journal.execute('INSERT OR IGNORE INTO local_requests VALUES(?,?)', (identifier, int(time.time()*1000)))
                now = self.worker._journal.execute('SELECT created_ms FROM local_requests WHERE id=?', (identifier,)).fetchone()[0] / 1000
                self.worker._journal.commit()
            result = self.worker.execute_command({'id':identifier, 'action':action, 'payload':payload,
                                                  'createdAt':_iso(now), 'expiresAt':_iso(now+90)})
        else:
            # Read-only operations do not need a persistent receipt or cloud queue.
            result = {'id':request_id, 'status':'done', 'result':self.worker._execute(action, payload)}
        self._json(handler, {**result, 'action':action})

    def handle(self, handler):
        path = urlparse(handler.path).path
        if handler.command == 'POST' and path in ('/plan', '/api/exclude', '/api/unexclude', '/api/purge'):
            try:
                self._session(handler, required=True, write=True)
            except LocalHttpError as error:
                self._json(handler, {'error':error.message}, error.status)
                return True
            return False
        aliases = {'/':'', '/status':'', '/manage':'#manage', '/control':'#plan', '/collect':'', '/collect/':''}
        if path not in aliases and not path.startswith('/sound-atlas/'):
            return False
        try:
            hostname = urlparse('http://' + handler.headers.get('Host', '')).hostname
            if hostname not in self.allowed_hosts:
                raise LocalHttpError(403, '请使用 localhost 或本机 IP 访问。')
            if path in aliases:
                if handler.command != 'GET':
                    raise LocalHttpError(405, '不支持此请求。')
                handler.redirect('/sound-atlas/collect/' + aliases[path])
            elif path.startswith('/sound-atlas/api/'):
                api = path.removeprefix('/sound-atlas/api/')
                if api == 'admin-session':
                    if handler.command == 'GET':
                        session, _ = self._session(handler)
                        self._json(handler, {'authenticated':bool(session), **({'csrf':session['csrf']} if session else {})})
                    elif handler.command == 'POST':
                        self._login(handler)
                    elif handler.command == 'DELETE':
                        _, token = self._session(handler, required=True, write=True)
                        with self.lock:
                            self.sessions.pop(token, None)
                        self._json(handler, {'authenticated':False}, cookie='')
                    else:
                        raise LocalHttpError(405, '不支持此请求。')
                elif api == 'admin-state' and handler.command == 'GET':
                    # Cloud failure is independent of local collector availability.
                    with self.lock:
                        state = dict(self.worker.management_state())
                    state.update(connected=True, receivedAt=_iso())
                    if parse_qs(urlparse(handler.path).query).get('view') != ['manage']:
                        state.pop('liveView', None)
                    self._json(handler, state)
                elif api == 'admin-command' and handler.command == 'POST':
                    self._command(handler)
                elif api == 'live' and handler.command == 'GET':
                    bridge = self.receiver.SYNC_BRIDGE
                    if not bridge:
                        raise LocalHttpError(503, '本机空间摘要尚未启动。')
                    data = dict(bridge.snapshot())
                    data.update(connected=True, receivedAt=_iso())
                    self._json(handler, data)
                else:
                    raise LocalHttpError(404, '接口不存在。')
            elif handler.command == 'GET':
                relative = unquote(path.removeprefix('/sound-atlas/'))
                target = (self.web_root / relative).resolve()
                if not target.is_relative_to(self.web_root):
                    raise LocalHttpError(404, '文件不存在。')
                if target.is_dir():
                    target = target / 'index.html'
                if not target.is_file():
                    raise LocalHttpError(404, '页面文件不存在，请同步网站文件。')
                data = target.read_bytes()
                mime = {'.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml'}.get(target.suffix, mimetypes.guess_type(target.name)[0] or 'application/octet-stream')
                handler.send_response(200)
                handler.send_header('Content-Type', mime + ('; charset=utf-8' if mime.startswith('text/') else ''))
                handler.send_header('Content-Length', str(len(data)))
                handler.send_header('Cache-Control', 'no-cache')
                handler.send_header('X-Content-Type-Options', 'nosniff')
                handler.send_header('X-Frame-Options', 'DENY')
                handler.end_headers()
                handler.wfile.write(data)
            else:
                raise LocalHttpError(405, '不支持此请求。')
        except LocalHttpError as error:
            self._json(handler, {'error':error.message}, error.status)
        except (RemoteError, ValueError, KeyError, TypeError) as error:
            self._json(handler, {'error':str(error)}, 400)
        return True
