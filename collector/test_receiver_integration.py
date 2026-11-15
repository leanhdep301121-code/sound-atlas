"""Receiver protocol, plans and data management against an isolated database."""
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import tempfile
import time
import unittest


class ReceiverIntegration(unittest.TestCase):
    def test_upload_summary_exclusion_export_and_plan(self):
        root = Path(__file__).parent
        with tempfile.TemporaryDirectory() as directory:
            previous = os.environ.get('SOUND_ATLAS_DB')
            os.environ['SOUND_ATLAS_DB'] = str(Path(directory) / 'test.db')
            spec = importlib.util.spec_from_file_location('isolated_sound_receiver', root / 'receiver.py')
            receiver = importlib.util.module_from_spec(spec)
            try:
                spec.loader.exec_module(receiver)
                now = int(time.time()*1000)
                plan = receiver.set_plan(now-60_000, now+3600_000)
                handler = receiver.Handler.__new__(receiver.Handler)
                handler.client_address = ('127.0.0.1', 1)
                responses = []
                handler.send_text = lambda code, value, *args: responses.append((code, value))
                payload = {'node':'N1','cfg':plan[0],'mic':0,'sync':1,'rows':[[now-2000,5000,5500],[now-1000,6000,6500]]}
                handler.read_body = lambda: json.dumps(payload).encode()
                handler.handle_upload()
                self.assertEqual(responses[-1][0],200)
                receiver.SYNC_BRIDGE = receiver.LiveBridge(receiver.DB_PATH,config_path=Path(directory)/'disabled.json')
                snapshot = receiver.SYNC_BRIDGE.snapshot()
                readings=[f['sound']['C'] for d in snapshot['days'] for f in d['frames'] if 'C' in f['sound']]
                self.assertEqual(len(readings),1)
                self.assertAlmostEqual(readings[0],10*math.log10((10**5+10**6)/2),places=3)
                handler.send_json=lambda value,*args:responses.append(value)
                handler.run_api(receiver.api_exclude,{'nodes':['N1'],'start':now-2000,'end':now-1000,'reason':'isolated test'})
                group=responses[-1]['grp']
                after=receiver.SYNC_BRIDGE.snapshot()
                values=[f['sound']['C'] for d in after['days'] for f in d['frames'] if 'C' in f['sound']]
                self.assertEqual(values,[60])
                handler.run_api(receiver.api_unexclude,{'grp':group})
                self.assertEqual(receiver.conn.execute('select count(*) from readings').fetchone()[0],2)
                handler.wfile=io.BytesIO();handler.send_response=lambda *args:None;handler.send_header=lambda *args:None;handler.end_headers=lambda:None
                handler.send_export({'clean':'1'})
                exported=handler.wfile.getvalue().decode('utf-8-sig')
                self.assertIn('node,time_beijing,ts_ms,laeq',exported)
                self.assertEqual(len(exported.splitlines()),3)
                preview=receiver.api_purge({'mode':'range','nodes':['N1'],'start':now-3000,'end':now,'dry':True})
                self.assertEqual(preview['count'],2)
                result=receiver.api_purge({'mode':'range','nodes':['N1'],'start':now-3000,'end':now})
                self.assertEqual(result['deleted'],2)
                self.assertTrue((receiver.BACKUP_DIR/result['backup']).is_file())
                self.assertEqual(receiver.get_plan(),plan)
                for page in [receiver.status_page(),receiver.control_page({}),receiver.manage_page()]:
                    self.assertIn('/static/collector.css',page)
                    self.assertIn('声场',page)
                self.assertEqual(receiver.EXPECTED_NODES,['N1','N2','N3','N4','N5','D1','D2'])
                payload['node']='D1'
                handler.read_body=lambda:json.dumps(payload).encode()
                handler.handle_upload()
                receiver.SYNC_BRIDGE.invalidate()
                d1=receiver.SYNC_BRIDGE.snapshot()
                d1_values=[f['sound']['E'] for d in d1['days'] for f in d['frames'] if 'E' in f['sound']]
                self.assertEqual(len(d1_values),1)
                self.assertAlmostEqual(d1_values[0],10*math.log10((10**5+10**6)/2),places=3)
                self.assertEqual(receiver.get_plan(),plan)
                self.assertIn('D1',receiver.status_page())
                receiver.SYNC_BRIDGE.stop()
                receiver.conn.close()
            finally:
                if previous is None: os.environ.pop('SOUND_ATLAS_DB',None)
                else: os.environ['SOUND_ATLAS_DB']=previous


if __name__=='__main__':unittest.main()
