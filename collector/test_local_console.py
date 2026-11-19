import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from local_console import LocalConsole


class LocalConsoleTests(unittest.TestCase):
    def test_local_ui_state_queries_and_protected_management_without_cloud(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.dict(os.environ, {'SOUND_ATLAS_DB':str(root/'test.db')}):
                spec = importlib.util.spec_from_file_location('local_test_receiver', Path(__file__).with_name('receiver.py'))
                receiver = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(receiver)
            web = root/'web'
            (web/'collect').mkdir(parents=True)
            (web/'collect/index.html').write_text('<h1>Shared collection UI</h1>')
            (web/'collect/collect-core.mjs').write_text('export const local = true;')
            key = 'T'*43
            (root/'key.txt').write_text(key)
            console = receiver.LOCAL_CONSOLE = LocalConsole(receiver, web_root=web, key_file=root/'key.txt')
            server = receiver.CollectorHTTPServer(('127.0.0.1', 0), receiver.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            now = int(time.time()*1000)
            receiver.conn.execute('INSERT INTO readings(node,ts_ms,laeq,lafmax) VALUES(?,?,?,?)', ('D2',now-1000,50,55))
            receiver.conn.execute('INSERT INTO nodes(node,last_seen,ip,synced,mic) VALUES(?,?,?,?,?)',('D2',time.time(),'127.0.0.1',1,1))
            receiver.conn.commit()
            origin = 'http://127.0.0.1:'+str(server.server_port)

            def request(path, method='GET', body=None, headers=None):
                connection = http.client.HTTPConnection(*server.server_address, timeout=10)
                connection.request(method,path,body=None if body is None else json.dumps(body),headers={'Origin':origin, **(headers or {})})
                response = connection.getresponse()
                result = response.status, dict(response.getheaders()), response.read()
                connection.close()
                return result

            try:
                # Any accidental attempt to contact cloud infrastructure fails this test.
                with patch('urllib.request.OpenerDirector.open',side_effect=AssertionError('cloud access forbidden')):
                    status,headers,_=request('/')
                    self.assertEqual(status,303);self.assertEqual(headers['Location'],'/sound-atlas/collect/')
                    self.assertEqual(request('/sound-atlas/collect/')[0],200)
                    self.assertIn('text/javascript',request('/sound-atlas/collect/collect-core.mjs')[1]['Content-Type'])
                    self.assertEqual(request('/sound-atlas/%2e%2e/key.txt')[0],404)
                    self.assertEqual(request('/sound-atlas/api/admin-state',headers={'Host':'evil.invalid'})[0],403)
                    status,_,body=request('/sound-atlas/api/admin-state?view=manage')
                    state=json.loads(body);self.assertEqual(status,200);self.assertTrue(state['connected'])
                    self.assertEqual(next(r for r in state['telemetry']['nodes'] if r['node']=='D2')['laeq'],50)
                    query={'action':'inspect','requestId':'read-query-123','payload':{'nodes':['D2'],'start':now-60000,'end':now,'w':50}}
                    status,_,body=request('/sound-atlas/api/admin-command','POST',query)
                    self.assertEqual(status,200);self.assertEqual(json.loads(body)['status'],'done')
                    for action in ['plan','calibration','exclude','unexclude','purge']:
                        self.assertEqual(request('/sound-atlas/api/admin-command','POST',{'action':action,'requestId':'denied-123','payload':{}})[0],401)
                    self.assertEqual(request('/api/purge','POST',{})[0],401)
                    self.assertEqual(request('/sound-atlas/api/admin-command','POST',query,{'Origin':'https://evil.invalid'})[0],403)
                    status,headers,body=request('/sound-atlas/api/admin-session','POST',{'key':key})
                    self.assertEqual(status,200)
                    auth={'Cookie':headers['Set-Cookie'].split(';')[0],'X-CSRF-Token':json.loads(body)['csrf']}
                    self.assertTrue(json.loads(request('/sound-atlas/api/admin-session',headers=auth)[2])['authenticated'])
                    version=receiver.get_plan()[0]
                    change={'action':'plan','requestId':'local-plan-123','payload':{'action':'continuous','planVersion':version}}
                    self.assertEqual(request('/sound-atlas/api/admin-command','POST',change,{'Cookie':auth['Cookie']})[0],403)
                    result=json.loads(request('/sound-atlas/api/admin-command','POST',change,auth)[2])
                    self.assertEqual(result['status'],'done',result)
                    updated=receiver.get_plan()
                    self.assertGreater(updated[0],version)
                    result=json.loads(request('/sound-atlas/api/admin-command','POST',change,auth)[2])
                    self.assertEqual(result['status'],'done');self.assertEqual(receiver.get_plan(),updated)
                    self.assertEqual(request('/sound-atlas/api/admin-session','DELETE',headers=auth)[0],200)
                    self.assertEqual(request('/sound-atlas/api/admin-command','POST',change,auth)[0],401)
                    self.assertEqual(request('/sound-atlas/api/admin-state')[0],200)
                    self.assertEqual(request('/time')[0],200);self.assertEqual(request('/config')[0],200)
            finally:
                server.shutdown();server.server_close();thread.join()
                console.close();receiver.conn.close()


if __name__ == '__main__':
    unittest.main()
