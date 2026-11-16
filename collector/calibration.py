"""Versioned relative LAeq calibration; original observations are never rewritten."""
import hashlib
import json
import math
import statistics
import time
import uuid

LEGACY_NODES = ['N1', 'N2', 'N3', 'N4', 'N5', 'D1', 'D2']
NODES = ['N1', 'N2', 'N3', 'N5', 'D1', 'D2']


def initialize(db):
    db.executescript('''
      CREATE TABLE IF NOT EXISTS calibration_runs (
        id TEXT PRIMARY KEY, start_ms INTEGER, end_ms INTEGER, previous_plan TEXT,
        plan_version INTEGER, exclusion_group INTEGER, cancelled INTEGER DEFAULT 0,
        restored INTEGER DEFAULT 0, report TEXT);
      CREATE TABLE IF NOT EXISTS calibration_profiles (
        id TEXT PRIMARY KEY, run_id TEXT, effective_ms INTEGER, end_ms INTEGER,
        offsets TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calibration_participants (run_id TEXT PRIMARY KEY,nodes_json TEXT NOT NULL);
    ''')
    db.commit()


def profiles(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='calibration_profiles'").fetchone():
        return []
    return [{'id': row[0], 'start': row[1], 'end': row[2], 'offsets': json.loads(row[3])}
            for row in db.execute('SELECT id,effective_ms,end_ms,offsets FROM calibration_profiles ORDER BY effective_ms,id')]


def correction(items, node, stamp):
    for item in reversed(items):
        if item['start'] <= stamp and (item['end'] is None or stamp < item['end']):
            return float(item['offsets'].get(node, 0)), item['id']
    return 0.0, ''


def corrected(items, node, stamp, level):
    return level + correction(items, node, stamp)[0]


class Calibration:
    def __init__(self, receiver, clock=time.time):
        self.receiver, self.clock = receiver, clock
        with receiver.db_lock:
            initialize(receiver.conn)

    def run(self, identifier=None):
        db = self.receiver.conn
        row = db.execute('SELECT * FROM calibration_runs WHERE id=?', (identifier,)).fetchone() if identifier else db.execute('SELECT * FROM calibration_runs ORDER BY start_ms DESC LIMIT 1').fetchone()
        if not row:
            return None
        keys = ['id','startMs','endMs','previousPlan','planVersion','exclusionGroup','cancelled','restored','report']
        result = dict(zip(keys,row))
        participants=db.execute('SELECT nodes_json FROM calibration_participants WHERE run_id=?',(identifier or row[0],)).fetchone()
        result['nodes']=json.loads(participants[0]) if participants else list(LEGACY_NODES)
        result['previousPlan'] = json.loads(result['previousPlan'])
        result['report'] = json.loads(result['report']) if result['report'] else None
        return result

    def samples(self, run):
        data = {}
        for node in run['nodes']:
            buckets = {}
            rows = self.receiver.conn.execute('SELECT ts_ms,laeq FROM readings WHERE node=? AND ts_ms>=? AND ts_ms<? ORDER BY ts_ms', (node,run['startMs'],run['endMs']))
            for stamp, value in rows:
                if not isinstance(value,(int,float)) or not math.isfinite(value) or not 0 < value <= 140:
                    continue
                second = stamp // 1000
                buckets.setdefault(second,[]).append(value)
            data[node] = {second:10*math.log10(sum(10**(v/10) for v in values)/len(values)) for second,values in buckets.items()}
        return data

    def state(self):
        now = int(self.clock()*1000)
        with self.receiver.db_lock:
            run = self.run()
            active = next((p for p in reversed(profiles(self.receiver.conn)) if p['start'] <= now and (p['end'] is None or now < p['end'])), None)
            public = None
            if run:
                data = self.samples(run)
                public = {k:run[k] for k in ['id','startMs','endMs','planVersion','cancelled','restored','report','nodes']}
                public['applied'] = bool(self.receiver.conn.execute('SELECT 1 FROM calibration_profiles WHERE run_id=?',(run['id'],)).fetchone())
                public['phase'] = 'cancelled' if run['cancelled'] else 'waiting' if now < run['startMs'] else 'recording' if now < run['endMs'] else 'uploading' if now < run['endMs']+45000 else 'finished'
                public['counts'] = {node:len(data[node]) for node in run['nodes']}
                public['rawLevels'] = {node:round(data[node][max(data[node])],2) if data[node] else None for node in run['nodes']}
                public['commonSeconds'] = len(set.intersection(*(set(data[node]) for node in run['nodes'])))
            return {'run':public,'active':active,'nodes':NODES,'method':'simultaneous-median-relative','minimumCommonSeconds':240}

    def start(self, plan_version):
        receiver = self.receiver
        now = self.clock()
        with receiver.db_lock:
            if receiver.get_plan()[0] != plan_version:
                raise ValueError('采集计划已变化，请刷新后重新开始。')
            previous = self.run()
            if previous and not previous['cancelled'] and now*1000 < previous['endMs']+45000:
                raise ValueError('已有五分钟校准正在进行。')
            ready = {r[0]:r for r in receiver.node_readiness(now)}
            missing = [node for node in NODES if node not in ready or not all(ready[node][1:5])]
            if missing:
                raise ValueError('请先让全部六块板子在线、对时并检测到麦克风：'+', '.join(missing))
            start = math.ceil(now+45)*1000
            end = start+300000
            identifier = str(uuid.uuid4())
            db = receiver.conn
            plan = receiver.get_plan()
            with db:
                group = db.execute('SELECT COALESCE(MAX(grp),0)+1 FROM exclusions').fetchone()[0]
                db.execute('UPDATE settings SET ver=ver+1,start_ms=?,end_ms=? WHERE id=1',(start,end))
                version = receiver.get_plan()[0]
                db.executemany('INSERT INTO exclusions(grp,node,start_ms,end_ms,reason,note,created) VALUES(?,?,?,?,?,?,?)',
                    [(group,node,start,end,'并排校准','校准 '+identifier+'；保留原始数据',now) for node in NODES])
                db.execute('INSERT INTO calibration_runs(id,start_ms,end_ms,previous_plan,plan_version,exclusion_group) VALUES(?,?,?,?,?,?)',(identifier,start,end,json.dumps(list(plan)),version,group))
                db.execute('INSERT INTO calibration_participants VALUES(?,?)',(identifier,json.dumps(NODES)))
            return self.state()

    def analyze(self, identifier, save=True):
        with self.receiver.db_lock:
            run = self.run(identifier)
            now = int(self.clock()*1000)
            if not run or run['cancelled']:
                raise ValueError('找不到有效的校准任务。')
            if now < run['endMs']+45000:
                raise ValueError('请等五分钟采集结束并等待45秒，让最后一批数据上传。')
            participants=run['nodes']
            data = self.samples(run)
            seconds = sorted(set.intersection(*(set(data[node]) for node in participants)))
            reference = {second:statistics.median(data[node][second] for node in participants) for second in seconds}
            results = []
            for node in participants:
                differences = [reference[second]-data[node][second] for second in seconds]
                offset = statistics.median(differences) if differences else None
                residual = [d-offset for d in differences] if differences else []
                results.append({'node':node,'samples':len(data[node]),'offset':round(offset,3) if offset is not None else None,
                    'beforeRmse':round(math.sqrt(statistics.mean(d*d for d in differences)),3) if differences else None,
                    'afterRmse':round(math.sqrt(statistics.mean(d*d for d in residual)),3) if residual else None,
                    'mad':round(statistics.median(abs(d) for d in residual),3) if residual else None})
            warnings = []
            if len(seconds)<240:
                warnings.append(('七块' if len(participants)==7 else '六块')+'板子共同有效秒数不足240/300；此为本工具的完整性门槛，请补齐设备后重新采集。')
            if any(row['offset'] is not None and abs(row['offset'])>12 for row in results):
                warnings.append('存在超过12 dB的偏移，请优先检查硬件、麦克风朝向和程序参数。')
            if any(row['mad'] is not None and row['mad']>2 for row in results):
                warnings.append('部分板子的相对偏差不稳定，单一常数可能无法充分修正。')
            report={'runId':identifier,'startMs':run['startMs'],'endMs':run['endMs'],'commonSeconds':len(seconds),'expectedSeconds':300,
                'canApply':len(seconds)>=240,'method':'共同秒级中位数 / 相对LAeq修正','results':results,'warnings':warnings,
                'note':'同一次五分钟记录回算，不是独立验证或绝对声级校准。修正仅用于LAeq，不修正倍频程频带。'}
            # Include the exact common observations so late data invalidates old approvals.
            digest=json.dumps([report,[[second,[data[n][second] for n in participants]] for second in seconds]],sort_keys=True,separators=(',',':'))
            report['fingerprint']=hashlib.sha256(digest.encode()).hexdigest()
            if save:
                self.receiver.conn.execute('UPDATE calibration_runs SET report=? WHERE id=?',(json.dumps(report,ensure_ascii=False),identifier))
                self.receiver.conn.commit()
            return report

    def apply(self, identifier, fingerprint):
        with self.receiver.db_lock:
            report=self.analyze(identifier,save=False)
            if report['fingerprint']!=fingerprint:
                raise ValueError('校准数据已变化，请重新计算并核对结果。')
            if not report['canApply']:
                raise ValueError('共同有效记录不足，不能应用修正。')
            db=self.receiver.conn
            if db.execute('SELECT 1 FROM calibration_profiles WHERE run_id=?',(identifier,)).fetchone():
                raise ValueError('本次校准已经应用，请勿重复应用。')
            now=int(self.clock()*1000)
            with db:
                db.execute('UPDATE calibration_profiles SET end_ms=? WHERE end_ms IS NULL',(now,))
                db.execute('INSERT INTO calibration_profiles VALUES(?,?,?,?,?)',(str(uuid.uuid4()),identifier,now,None,json.dumps({r['node']:r['offset'] for r in report['results']})))
            return self.state()

    def disable(self):
        with self.receiver.db_lock:
            self.receiver.conn.execute('UPDATE calibration_profiles SET end_ms=? WHERE end_ms IS NULL',(int(self.clock()*1000),))
            self.receiver.conn.commit()
            return self.state()

    def restore(self, identifier, cancel=False):
        receiver=self.receiver
        with receiver.db_lock:
            run=self.run(identifier)
            if not run or run['restored']:
                raise ValueError('原采集计划已恢复或任务不存在。')
            now=int(self.clock()*1000)
            if cancel and now >= run['endMs']+45000:
                raise ValueError('校准已结束，请使用恢复原计划。')
            if not cancel and now < run['endMs']:
                raise ValueError('校准采集尚未结束。')
            if receiver.get_plan()[0]!=run['planVersion']:
                raise ValueError('采集计划已被另行修改，不能自动覆盖，请到采集计划页设置。')
            _,start,end=run['previousPlan']
            with receiver.conn:
                receiver.conn.execute('UPDATE settings SET ver=ver+1,start_ms=?,end_ms=? WHERE id=1',(start,end))
                receiver.conn.execute('UPDATE calibration_runs SET restored=1,cancelled=? WHERE id=?',(int(cancel),identifier))
                if cancel:
                    if now<=run['startMs']:
                        receiver.conn.execute('DELETE FROM exclusions WHERE grp=?',(run['exclusionGroup'],))
                    else:
                        receiver.conn.execute('UPDATE exclusions SET end_ms=? WHERE grp=?',(min(now,run['endMs']),run['exclusionGroup']))
            return self.state()
