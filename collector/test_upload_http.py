"""Real HTTP uploads against an isolated SQLite database, never the live receiver."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch


class UploadHTTPTests(unittest.TestCase):
    def test_rejected_body_retry_duplicate_and_failed_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {'SOUND_ATLAS_DB': str(Path(directory) / 'test.db')}):
                spec = importlib.util.spec_from_file_location('upload_test_receiver', Path(__file__).with_name('receiver.py'))
                receiver = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(receiver)
            server = receiver.CollectorHTTPServer(('127.0.0.1', 0), receiver.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def send(body, extra=0):
                with socket.create_connection(server.server_address, timeout=5) as client:
                    client.sendall(f'POST /upload HTTP/1.0\r\nContent-Length: {len(body)+extra}\r\n\r\n'.encode()+body)
                    client.shutdown(socket.SHUT_WR)
                    response = b''
                    while True:
                        block = client.recv(4096)
                        if not block:
                            break
                        response += block
                    return int(response.split(b' ')[1])

            def count():
                return receiver.conn.execute('SELECT COUNT(*) FROM readings').fetchone()[0]

            def diagnostic():
                return json.loads((Path(directory)/'logs/upload_diagnostics/N5.json').read_text(encoding='utf-8'))

            try:
                broken = b'{"node":"N5","rows":[[1794829058000,5000'
                self.assertEqual(send(broken, 10), 400)
                self.assertEqual(diagnostic()['kind'], 'incomplete')
                self.assertEqual(diagnostic()['received_bytes'], len(broken))
                self.assertEqual(count(), 0)
                self.assertEqual(send(broken), 400)
                self.assertEqual(diagnostic()['kind'], 'json')
                good = json.dumps({'node':'N5','rows':[[1794829058000,5000,5500]]}).encode()
                self.assertEqual(send(good), 200)
                self.assertEqual(send(good), 200)
                self.assertEqual(count(), 1)
                bad_second = json.dumps({'node':'N5','rows':[[1794829059000,5000,5500],[1794829060000,'bad',5500]]}).encode()
                self.assertEqual(send(bad_second), 400)
                self.assertEqual(count(), 1)

                handler = receiver.Handler.__new__(receiver.Handler)
                handler.client_address = ('127.0.0.1', 1)
                handler.read_upload_body = lambda: good
                handler.send_text = lambda *args: (_ for _ in ()).throw(BrokenPipeError())
                handler.handle_upload()
                self.assertTrue(handler.close_connection)
                self.assertEqual(count(), 1)

                # Aggregate failure must roll back newly inserted raw rows too.
                handler.read_upload_body = lambda: good.replace(b'1794829058000', b'1794829059000')
                responses = []
                handler.send_text = lambda status, *args: responses.append(status)
                with patch.object(receiver, 'refresh_minutes', side_effect=RuntimeError('test database failure')):
                    handler.handle_upload()
                self.assertEqual(responses, [500])
                self.assertEqual(count(), 1)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
                receiver.conn.close()


if __name__ == '__main__':
    unittest.main()
