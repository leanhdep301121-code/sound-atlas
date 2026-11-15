import importlib.util
import math
import os
from pathlib import Path
import tempfile
import time
import unittest
from calibration import Calibration, NODES, profiles, correction


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.old=os.environ.get('SOUND_ATLAS_DB')
        os.environ['SOUND_ATLAS_DB']=str(Path(self.temp.name)/'test.db')
        spec=importlib.util.spec_from_file_location('calibration_receiver',Path(__file__).with_name('receiver.py'))
        self.receiver=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.receiver)
        self.now=time.time()
        self.receiver.set_plan(int((self.now-3600)*1000),int((self.now+86400)*1000))
        self.original=self.receiver.get_plan()
        for node in NODES:
            self.receiver.conn.execute('INSERT INTO nodes(node,last_seen,cfg_ver,mic,synced) VALUES(?,?,?,?,?)',(node,self.now,self.original[0],0,1))
        self.receiver.conn.commit()
        self.cal=Calibration(self.receiver,clock=lambda:self.now)

    def tearDown(self):
        self.receiver.conn.close()
        if self.old is None:os.environ.pop('SOUND_ATLAS_DB',None)
        else:os.environ['SOUND_ATLAS_DB']=self.old
        self.temp.cleanup()

    def populate(self, missing=0):
        run=self.cal.start(self.original[0])['run']
        for index,node in enumerate(NODES):
            for second in range(300-(missing if node=='D2' else 0)):
                level=50+index+math.sin(second/15)
                self.receiver.conn.execute('INSERT INTO readings(node,ts_ms,laeq,lafmax) VALUES(?,?,?,?)',(node,run['startMs']+second*1000,level,level+1))
        self.receiver.conn.commit();self.now=run['endMs']/1000+50
        return run

    def test_common_median_offsets_and_versioned_future_only_correction(self):
        run=self.populate();report=self.cal.analyze(run['id'])
        self.assertEqual(report['commonSeconds'],300)
        self.assertEqual([row['offset'] for row in report['results']],[3,2,1,0,-1,-2,-3])
        self.assertTrue(all(row['afterRmse']==0 for row in report['results']))
        before=list(self.receiver.conn.execute('SELECT node,ts_ms,laeq FROM readings ORDER BY node,ts_ms'))
        self.cal.apply(run['id'],report['fingerprint']);items=profiles(self.receiver.conn)
        self.assertEqual(correction(items,'N1',run['startMs'])[0],0)
        self.assertEqual(correction(items,'N1',int(self.now*1000))[0],3)
        self.now+=20;self.cal.disable();items=profiles(self.receiver.conn)
        self.assertEqual(correction(items,'N1',int((self.now-10)*1000))[0],3)
        self.assertEqual(correction(items,'N1',int(self.now*1000))[0],0)
        self.assertEqual(before,list(self.receiver.conn.execute('SELECT node,ts_ms,laeq FROM readings ORDER BY node,ts_ms')))
        self.cal.restore(run['id']);self.assertEqual(self.receiver.get_plan()[1:],self.original[1:])

    def test_missing_common_seconds_and_changed_approval_are_rejected(self):
        run=self.populate(missing=70);report=self.cal.analyze(run['id'])
        self.assertEqual(report['commonSeconds'],230);self.assertFalse(report['canApply'])
        with self.assertRaisesRegex(ValueError,'不足'):self.cal.apply(run['id'],report['fingerprint'])
        with self.assertRaisesRegex(ValueError,'变化'):self.cal.apply(run['id'],'0'*64)

    def test_wait_upload_and_offline_start_checks(self):
        self.receiver.conn.execute("UPDATE nodes SET last_seen=0 WHERE node='D2'");self.receiver.conn.commit()
        with self.assertRaisesRegex(ValueError,'D2'):self.cal.start(self.original[0])
        self.receiver.conn.execute("UPDATE nodes SET last_seen=? WHERE node='D2'",(self.now,));self.receiver.conn.commit()
        run=self.cal.start(self.original[0])['run']
        with self.assertRaisesRegex(ValueError,'上传'):self.cal.analyze(run['id'])
        self.assertEqual(self.receiver.conn.execute('SELECT COUNT(*) FROM exclusions').fetchone()[0],7)
        self.cal.restore(run['id'],cancel=True)
        self.assertEqual(self.receiver.get_plan()[1:],self.original[1:])
        self.assertEqual(self.receiver.conn.execute('SELECT COUNT(*) FROM exclusions').fetchone()[0],0)

if __name__=='__main__':unittest.main()
