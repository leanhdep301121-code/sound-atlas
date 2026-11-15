"""Remote commands are verified against temporary databases, never the live collector."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

from remote_control import RemoteControl, RemoteError, _iso


class RemoteControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.old_db = os.environ.get('SOUND_ATLAS_DB')
        os.environ['SOUND_ATLAS_DB'] = str(self.root/'noise.db')
        spec = importlib.util.spec_from_file_location('test_remote_receiver', Path(__file__).with_name('receiver.py'))
        self.receiver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.receiver)
        self.now = time.time()
        self.config = self.root/'config.json'
        self.secret = 'test-secret-only-do-not-publish-12345'
        self.config.write_text(json.dumps({'enabled':True,'endpoint':'https://example.test/sound-atlas/api/ingest','token':self.secret}),encoding='utf-8')
        self.worker = RemoteControl(self.receiver,self.config)

    def tearDown(self):
        self.worker.stop()
        self.receiver.conn.close()
        if self.old_db is None: os.environ.pop('SOUND_ATLAS_DB',None)
        else: os.environ['SOUND_ATLAS_DB'] = self.old_db
        self.temp.cleanup()

    def command(self, action, payload=None, identifier='command-001', **times):
        return {'id':identifier,'action':action,'payload':payload or {},'createdAt':times.get('createdAt',_iso()),'expiresAt':times.get('expiresAt',_iso(time.time()+90))}

    def add_rows(self, node='N1', levels=(50,60,70), start=None):
        start = int(self.now*1000)-20_000 if start is None else start
        with self.receiver.db_lock:
            for index,level in enumerate(levels):
                self.receiver.conn.execute('INSERT INTO readings(node,ts_ms,laeq,lafmax) VALUES(?,?,?,?)',(node,start+index*1000,level,level+1))
            self.receiver.refresh_minutes(node,start,start+len(levels)*1000)
            self.receiver.conn.commit()
        return start

    def test_continuous_plan_starts_without_dates_and_is_repeat_safe(self):
        before=int(time.time()*1000)
        result=self.worker.execute_command(self.command('plan',{'action':'continuous','planVersion':0},identifier='continuous-first'))
        self.assertEqual(result['status'],'done')
        version,start,end=self.receiver.get_plan()
        self.assertEqual(end,0)
        self.assertGreaterEqual(start,before+29000)
        self.assertLessEqual(start,before+41000)
        self.receiver.set_plan(before-60000,before+60000)
        version,original_start,_=self.receiver.get_plan()
        result=self.worker.execute_command(self.command('plan',{'action':'continuous','planVersion':version},identifier='continuous-running'))
        self.assertEqual(result['status'],'done')
        current=self.receiver.get_plan()
        self.assertEqual(current[1:],(original_start,0))
        repeated=self.worker.execute_command(self.command('plan',{'action':'continuous','planVersion':current[0]},identifier='continuous-repeat'))
        self.assertEqual(repeated['status'],'done')
        self.assertEqual(self.receiver.get_plan(),current)
        stopped=self.worker.execute_command(self.command('plan',{'action':'stop','planVersion':current[0]},identifier='continuous-stop'))
        self.assertEqual(stopped['status'],'done')
        self.assertGreater(self.receiver.get_plan()[2],int(time.time()*1000))

    def test_read_state_contains_no_ip_and_correct_mapping(self):
        self.receiver.conn.execute('INSERT INTO nodes(node,last_seen,ip,cfg_ver,mic,synced) VALUES(?,?,?,?,?,?)',('N1',time.time(),'192.168.1.99',0,0,1))
        self.receiver.conn.commit()
        result = self.worker.management_state()
        n1=next(row for row in result['readiness'] if row['node']=='N1')
        self.assertEqual(n1['label'],'公桌 3')
        self.assertTrue(n1['online'])
        self.assertNotIn('192.168',json.dumps(result))
        self.assertNotIn(self.secret,json.dumps(result))

    def test_plan_command_executes_once_even_after_restart(self):
        command=self.command('plan',{'action':'quick','days':7,'planVersion':0})
        first=self.worker.execute_command(command)
        self.assertEqual(first['status'],'done')
        self.assertEqual(self.receiver.get_plan()[0],1)
        self.assertEqual(self.worker.execute_command(command),first)
        self.worker.stop()
        self.worker=RemoteControl(self.receiver,self.config)
        self.assertEqual(self.worker.execute_command(command),first)
        self.assertEqual(self.receiver.get_plan()[0],1)

    def test_expired_and_unlisted_commands_never_change_plan(self):
        result=self.worker.execute_command(self.command('plan',{'action':'quick','days':7},createdAt=_iso(self.now-120),expiresAt=_iso(self.now-1)))
        self.assertEqual(result['status'],'failed')
        self.assertIn('过期',result['error'])
        bad=self.worker.execute_command(self.command('python',{'code':'print(1)'},identifier='command-002'))
        self.assertEqual(bad['status'],'failed')
        self.assertEqual(self.receiver.get_plan()[0],0)

    def test_inflight_receipt_after_crash_is_uncertain_not_replayed(self):
        command=self.command('plan',{'action':'quick','days':7})
        import hashlib
        from remote_control import _json
        digest=hashlib.sha256(_json([command['action'],command['payload'],command['createdAt'],command['expiresAt']]).encode()).hexdigest()
        self.worker._journal.execute("INSERT INTO receipts(id,command_hash,status,started) VALUES(?,?,'executing',?)",(command['id'],digest,time.time()))
        self.worker._journal.commit();self.worker.stop()
        self.worker=RemoteControl(self.receiver,self.config)
        result=self.worker.execute_command(command)
        self.assertEqual(result['status'],'uncertain')
        self.assertEqual(self.receiver.get_plan()[0],0)

    def test_exclude_and_undo_use_existing_receiver_functions(self):
        start=self.add_rows()
        result=self.worker.execute_command(self.command('exclude',{'nodes':['N1'],'start':start,'end':start+1000,'reason':'test'}))
        self.assertEqual(result['status'],'done')
        group=result['result']['grp']
        self.assertEqual(self.receiver.api_count({'nodes':['N1'],'start':start,'end':start+3000})['excluded'],1)
        undone=self.worker.execute_command(self.command('unexclude',{'grp':group},identifier='command-002'))
        self.assertEqual(undone['status'],'done')
        self.assertEqual(self.receiver.conn.execute('select count(*) from readings').fetchone()[0],3)

    def test_purge_requires_count_confirmation_and_current_plan_then_backs_up(self):
        start=self.add_rows()
        payload={'mode':'range','nodes':['N1'],'start':start,'end':start+3000,'dry':True}
        preview=self.worker.execute_command(self.command('purge',payload))
        self.assertEqual(preview['result']['count'],3)
        bad={**payload,'dry':False,'expectedCount':3,'confirmation':'DELETE 2','planVersion':0}
        self.assertEqual(self.worker.execute_command(self.command('purge',bad,identifier='command-002'))['status'],'failed')
        bad['confirmation']='DELETE 3';bad['planVersion']=99
        self.assertEqual(self.worker.execute_command(self.command('purge',bad,identifier='command-003'))['status'],'failed')
        bad['planVersion']=0;bad['expectedCount']=2;bad['confirmation']='DELETE 2'
        self.assertEqual(self.worker.execute_command(self.command('purge',bad,identifier='command-004'))['status'],'failed')
        self.assertEqual(self.receiver.conn.execute('select count(*) from readings').fetchone()[0],3)
        good={**bad,'expectedCount':3,'confirmation':'DELETE 3'}
        result=self.worker.execute_command(self.command('purge',good,identifier='command-005'))
        self.assertEqual(result['status'],'done')
        self.assertEqual(result['result']['deleted'],3)
        self.assertTrue((self.receiver.BACKUP_DIR/result['result']['backup']).exists())
        self.assertEqual(self.receiver.get_plan()[0],0)

    def test_export_pages_freeze_rowid_and_preserve_filters(self):
        start=self.add_rows(levels=(50,-80,60,70,80))
        self.receiver.api_exclude({'nodes':['N1'],'start':start,'end':start+1000,'reason':'test'})
        payload={'nodes':['N1'],'start':start,'end':start+10000,'clean':True,'limit':1}
        first=self.worker.export_page(payload)
        self.assertIn('60.00',first['csv'])
        self.assertFalse(first['done'])
        self.add_rows(levels=(90,),start=start+5000)
        data=first['csv'];cursor=first['nextCursor'];pages=1
        while cursor:
            part=self.worker.export_page({**payload,'cursor':cursor})
            data+=part['csv'];cursor=part['nextCursor'];pages+=1
            self.assertLess(pages,10)
        self.assertEqual(len(data.splitlines()),3)
        self.assertNotIn('90.00',data)
        self.assertNotIn('-80.00',data)
        self.assertTrue(first['header'].startswith('node,time_beijing,ts_ms'))

    def test_export_rejects_changed_exclusions_and_advances_through_invalid_rows(self):
        start=self.add_rows(levels=(-80,)*10+(60,70))
        payload={'nodes':['N1'],'start':start,'end':start+15000,'limit':1}
        first=self.worker.export_page(payload)
        self.assertEqual(first['csv'],'')
        self.assertFalse(first['done'])
        self.receiver.api_exclude({'nodes':['N1'],'start':start+10000,'end':start+11000,'reason':'changed'})
        with self.assertRaises(RemoteError):self.worker.export_page({**payload,'cursor':first['nextCursor']})

    def test_poll_results_are_durable_until_ack_and_only_known_ids_are_acked(self):
        command=self.command('overview')
        calls=[]
        def transport(endpoint,token,body):
            calls.append(body)
            return {'serverTime':_iso(),'acknowledged':[r['id'] for r in body['results']]+['unknown-id'], 'command':command if len(calls)==1 else None}
        self.worker._transport=transport
        self.assertTrue(self.worker.poll_once())
        self.assertEqual(len(self.worker.pending_results()),1)
        self.worker.poll_once()
        self.assertEqual(self.worker.pending_results(),[])
        self.assertIn('/sound-atlas/api/ingest',self.config.read_text())
        self.assertNotIn(self.secret,json.dumps(self.worker.status()))

    def test_network_and_clock_failures_do_not_execute_commands(self):
        original=self.receiver.get_plan()
        self.worker._transport=lambda *args: (_ for _ in ()).throw(OSError('contains secret '+self.secret))
        self.assertFalse(self.worker.poll_once())
        self.assertNotIn(self.secret,json.dumps(self.worker.status()))
        self.worker._transport=lambda *args:{'serverTime':_iso(time.time()+180),'command':self.command('plan',{'action':'quick','days':7})}
        self.assertFalse(self.worker.poll_once())
        self.assertEqual(self.receiver.get_plan(),original)
        self.assertIn('时间',self.worker.status()['message'])

    def test_acknowledgement_discards_csv_body_but_preserves_replay_tombstone(self):
        start=self.add_rows(levels=tuple(50+i/10 for i in range(100)))
        command=self.command('export',{'nodes':['N1'],'start':start,'end':start+100_000,'clean':True})
        first=self.worker.execute_command(command)
        self.assertEqual(first['status'],'done')
        self.assertGreater(len(first['result']['csv']),500)
        raw=self.worker._journal.execute('SELECT result_json FROM receipts WHERE id=?',(command['id'],)).fetchone()[0]
        self.assertIn('csv',raw)
        self.worker._transport=lambda endpoint,token,body:{'serverTime':_iso(),'acknowledged':[item['id'] for item in body['results']],'command':None}
        self.worker.poll_once()
        row=self.worker._journal.execute('SELECT command_hash,status,result_json,acknowledged FROM receipts WHERE id=?',(command['id'],)).fetchone()
        self.assertTrue(row[0]);self.assertEqual(row[1],'done');self.assertEqual(row[3],1)
        self.assertEqual(json.loads(row[2]),{'status':'done','result':{'acknowledged':True}})
        self.assertNotIn('csv',row[2])
        self.worker._execute=lambda *args: self.fail('acknowledged command must not execute again')
        self.assertEqual(self.worker.execute_command(command),{'id':command['id'],'status':'done','result':{'acknowledged':True}})
        self.assertEqual(self.worker.pending_results(),[{'id':command['id'],'status':'done','result':{'acknowledged':True}}])

    def test_live_telemetry_energy_exclusions_and_fresh_timestamps(self):
        import math
        now=self.now
        start=int(now*1000)-10000
        self.add_rows(node='D1',levels=(50,60,70),start=start)
        with self.receiver.db_lock:
            self.receiver.conn.execute("INSERT INTO readings(node,ts_ms,laeq,lafmax) VALUES(?,?,?,?)",('D1',int(now*1000)+30000,99,100))
            self.receiver.conn.commit()
        self.receiver.api_exclude({'nodes':['D1'],'start':start+2000,'end':start+3000,'reason':'test'})
        telemetry=self.worker.live_telemetry(now)
        node=next(n for n in telemetry['nodes'] if n['node']=='D1')
        self.assertEqual(node['laeq'],60)
        self.assertEqual(node['timestamp'],start+1000)
        self.assertEqual(node['samples'],2)
        self.assertAlmostEqual(node['windowLeq'],10*math.log10((10**5+10**6)/2),places=2)
        self.assertTrue(all(p[0]<=now*1000 for p in node['history']))
        empty=next(n for n in telemetry['nodes'] if n['node']=='N1')
        self.assertIsNone(empty['laeq'])
        self.assertEqual(empty['history'],[])
        self.assertEqual(len(telemetry['nodes']),7)

    def test_corrected_export_keeps_original_and_versions_columns(self):
        import csv,io
        start=self.add_rows(node='D2',levels=(50,60,70))
        self.receiver.conn.execute('INSERT INTO calibration_profiles VALUES(?,?,?,?,?)',('profile-test','run-test',start+1000,None,json.dumps({'D2':3})))
        self.receiver.conn.commit()
        result=self.worker.export_page({'start':start-1,'end':start+10000,'nodes':['D2'],'clean':True,'corrected':True,'limit':100})
        rows=list(csv.DictReader(io.StringIO(result['header']+'\n'+result['csv'])))
        self.assertEqual([float(r['laeq']) for r in rows],[50,60,70])
        self.assertEqual([float(r['laeq_corrected']) for r in rows],[50,63,73])
        self.assertEqual(rows[0]['calibration_id'],'')
        self.assertEqual(rows[1]['calibration_id'],'profile-test')
        raw=self.worker.export_page({'start':start-1,'end':start+10000,'nodes':['D2'],'clean':False,'limit':100})
        self.assertNotIn('laeq_corrected',raw['header'])
        point=next(n for n in self.worker.live_telemetry(self.now)['nodes'] if n['node']=='D2')
        self.assertEqual(point['laeq'],73)
        self.assertEqual(point['rawLaeq'],70)
        self.assertEqual(point['correctionDb'],3)

    def test_d1_readiness_and_export_use_acoustic_records(self):
        start=self.add_rows(node='D1')
        state=self.worker.management_state(force=True)
        self.assertIn('D1',[node['node'] for node in state['readiness']])
        receipt=self.worker.execute_command(self.command('export',{'start':start-1,'end':start+10000,'nodes':['D1'],'clean':True,'limit':100}))
        self.assertEqual(receipt['status'],'done')
        self.assertIn('D1,',receipt['result']['csv'])

    def test_journal_maintenance_keeps_unacked_and_executing_and_runs_hourly(self):
        from remote_control import RECEIPT_TTL_SECONDS
        now=self.now
        self.worker._clock=lambda:now
        old=now-RECEIPT_TTL_SECONDS-1
        rows=[
            ('old-acked','done',1,old),
            ('old-unacked','done',0,old),
            ('old-executing','executing',1,old),
            ('recent-acked','done',1,now-10),
            ('recent-failed','failed',1,now-10),
        ]
        raw=json.dumps({'status':'failed','result':{'csv':'private rows '*1000},'error':'validation failed'})
        self.worker._journal.executemany('INSERT INTO receipts(id,command_hash,status,result_json,started,finished,acknowledged) VALUES(?,?,?,?,?,?,?)',[(identifier,'hash',status,raw,finished-1,finished,ack) for identifier,status,ack,finished in rows])
        self.worker._journal.commit()
        self.worker._maintain_journal(force=True)
        kept={r[0]:r[1] for r in self.worker._journal.execute('SELECT id,result_json FROM receipts')}
        self.assertNotIn('old-acked',kept)
        self.assertEqual(kept['old-unacked'],raw)
        self.assertEqual(kept['old-executing'],raw)
        self.assertNotIn('private rows',kept['recent-acked'])
        self.assertEqual(json.loads(kept['recent-failed']),{'status':'failed','error':'validation failed'})
        self.worker._journal.execute("INSERT INTO receipts VALUES('hourly-expired','hash','done',?,0,?,1)",(raw,old))
        self.worker._journal.commit()
        self.worker._maintain_journal()
        self.assertIsNotNone(self.worker._journal.execute("SELECT 1 FROM receipts WHERE id='hourly-expired'").fetchone())
        now+=3601
        self.worker._maintain_journal()
        self.assertIsNone(self.worker._journal.execute("SELECT 1 FROM receipts WHERE id='hourly-expired'").fetchone())


if __name__=='__main__':unittest.main()
