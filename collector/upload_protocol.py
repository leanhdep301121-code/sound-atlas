"""Bounded ESP32 upload parsing; incomplete requests are never acknowledged."""
import json
import math
import re

MAX_UPLOAD_BYTES = 256 * 1024

class UploadError(ValueError):
    def __init__(self, kind, message, *, body=b'', expected=None, status=400, position=None):
        super().__init__(message)
        self.kind, self.body, self.expected, self.status, self.position = kind, body, expected, status, position


def read_upload(stream, headers):
    raw_length = headers.get('Content-Length')
    raw_length = str(raw_length).strip() if raw_length is not None else None
    if headers.get('Transfer-Encoding', '').lower() not in ('', 'identity'):
        raise UploadError('framing', 'unsupported transfer encoding')
    if raw_length is None or not str(raw_length).isdigit():
        raise UploadError('framing', 'missing or invalid Content-Length')
    expected = int(raw_length)
    if expected == 0:
        raise UploadError('empty', 'empty upload', expected=0)
    if expected > MAX_UPLOAD_BYTES:
        raise UploadError('oversized', 'upload exceeds size limit', expected=expected, status=413)
    parts, received = [], 0
    read = getattr(stream, 'read1', stream.read)
    while received < expected:
        try:
            block = read(min(16384, expected - received))
        except (TimeoutError, OSError) as error:
            raise UploadError('interrupted', 'connection interrupted while reading', body=b''.join(parts), expected=expected, status=408) from error
        if not block:
            raise UploadError('incomplete', 'connection ended before body completed', body=b''.join(parts), expected=expected)
        parts.append(block); received += len(block)
    return b''.join(parts)


def node_hint(body):
    match = re.search(rb'"node"\s*:\s*"([A-Za-z0-9_-]{1,16})"', body[:256])
    return match.group(1).decode('ascii') if match else None


def decode_upload(body, value_count=10):
    if not body:
        raise UploadError('empty', 'empty upload', body=body)
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise UploadError('json', str(error), body=body, position=getattr(error, 'pos', None)) from error
    if not isinstance(payload, dict) or not isinstance(payload.get('node'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,16}', payload['node']):
        raise UploadError('schema', 'invalid node identifier', body=body)
    incoming = payload.get('rows')
    if not isinstance(incoming, list) or len(incoming) > 2048:
        raise UploadError('schema', 'invalid rows', body=body)
    node, rows = payload['node'], []
    for item in incoming:
        if not isinstance(item, list) or not 3 <= len(item) <= value_count + 1:
            raise UploadError('schema', 'invalid observation row', body=body)
        if isinstance(item[0], bool) or not isinstance(item[0], int) or item[0] <= 0:
            raise UploadError('schema', 'invalid timestamp', body=body)
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in item[1:]):
            raise UploadError('schema', 'invalid observation value', body=body)
        values = [v / 100.0 for v in item[1:]]
        values += [None] * (value_count - len(values))
        rows.append((node, item[0], *values))
    return payload, node, rows
