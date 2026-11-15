import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {normalizeCommand,sanitizeState,createControlStore} from '../lib/collector-control.mjs';
import {normalizeSnapshot} from '../lib/live-store.mjs';
const requestId='calibration-request-123456';
test('calibration commands require exact operation, version and report fingerprint',()=>{
  const cmd=payload=>normalizeCommand({requestId,action:'calibration',payload});
  assert.throws(()=>cmd({operation:'start'}));
  assert.deepEqual(cmd({operation:'start',planVersion:2,secret:'ignore'}).payload,{operation:'start',planVersion:2});
  assert.throws(()=>cmd({operation:'apply',runId:'abcdef123456'}));
  assert.equal(cmd({operation:'apply',runId:'abcdef123456',fingerprint:'a'.repeat(64)}).mutating,true);
  assert.throws(()=>cmd({operation:'arbitrary'}));
});
test('dormitory stays outside the heatmap after the device swap',()=>{
  const context=vm.createContext({Intl,Date,document:{createElement:()=>({})}});
  for(const path of ['data.js','heatmap.js'])vm.runInContext(readFileSync(new URL('../dist/'+path,import.meta.url),'utf8'),context);
  assert.equal(vm.runInContext("OBSERVATION_NODES.some(n=>n.id==='D2')",context),true);
  assert.equal(vm.runInContext("TABLES.some(n=>n.id==='D2')",context),false);
  assert.equal(vm.runInContext("OBSERVATION_NODES.find(n=>n.kind==='remote').device",context),'N4');
  assert.equal(vm.runInContext("TABLES.find(n=>n.kind==='personal').device",context),'D2');
  assert.equal(vm.runInContext('heatmapSamples({sound:{A:50,D2:80}}).length',context),1);
  assert.equal(vm.runInContext('createDemo().every(d=>d.frames.every(f=>Number.isFinite(f.sound.D2)))',context),true);
  const now=Date.now(),frames=Array.from({length:48},()=>({sound:{},counts:{}}));frames[0]={sound:{D2:49},counts:{D2:5}};
  const payload={version:1,generatedAt:new Date(now).toISOString(),nodes:['A','B','C','D','E','D1','D2'].map(id=>({id,lastSeen:null})),days:[{label:'2026-11-15',frames}]};
  assert.equal(normalizeSnapshot(payload,now).days[0].frames[0].sound.D2,49);
});
test('calibration management state keeps report and strips unknown fields',async()=>{
  const raw=sanitizeState({calibration:{run:{id:'test-run-123456',phase:'finished',counts:{D2:299},rawLevels:{D2:48},commonSeconds:299,privateKey:'secret',report:{fingerprint:'a'.repeat(64),results:[{node:'D2',offset:1.2,secret:'hide'}],warnings:[]}},active:{id:'profile',start:1,offsets:{D2:1.2,SECRET:99},token:'hide'}}});
  assert.ok(!JSON.stringify(raw).includes('hide'));assert.ok(!JSON.stringify(raw).includes('secret'));
  const state=await createControlStore({run:async()=>JSON.stringify(raw)}).state();
  assert.equal(state.calibration.run.counts.D2,299);
  assert.deepEqual(state.calibration.active.offsets,{D2:1.2});
});
