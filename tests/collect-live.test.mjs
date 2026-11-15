import test from 'node:test';
import assert from 'node:assert/strict';
import { liveStation, sparkPath, ageLabel } from '../dist/collect/collect-live.mjs';
import { sanitizeState, createControlStore } from '../lib/collector-control.mjs';
const now=Date.parse('2026-11-15T10:00:00Z');
const stamp=ms=>new Date(ms).toISOString();
function state(){return {connected:true,receivedAt:stamp(now),plan:{state:'recording'},readiness:[{node:'D1',online:true,mic:true,lastSeen:stamp(now-1000)}],telemetry:{generatedAt:stamp(now),nodes:[{node:'D1',timestamp:now-2000,laeq:52.3,history:[[now-5000,52.3]]}]}};}
test('new samples display actual one-second sound, not rolling or fabricated values',()=>{
  assert.equal(liveStation(state(),'D1',now).value,52.3);
  assert.equal(liveStation(state(),'N1',now).value,null);
  assert.equal(liveStation(state(),'D1',now).status,'数据正常');
});
test('stored telemetry reaches the management response and ages offline',async()=>{
  const stored=sanitizeState(state(),now);
  const store=createControlStore({run:async()=>JSON.stringify(stored),now:()=>now});
  const response=await store.state();
  assert.equal(liveStation(response,'D1',now).value,52.3);
  const staleStore=createControlStore({run:async()=>JSON.stringify(stored),now:()=>now+46000});
  const stale=await staleStore.state();
  assert.equal(liveStation(stale,'D1',now+46000).value,null);
  assert.equal(stale.telemetry.nodes.find(n=>n.node==='D1').laeq,52.3);
});
test('stale sample, stale collector and stale telemetry each stop being called live',()=>{
  const sample=state();sample.telemetry.nodes[0].timestamp=now-46000;
  assert.equal(liveStation(sample,'D1',now).status,'数据延迟');
  assert.equal(liveStation(sample,'D1',now).value,null);
  const source=state();source.receivedAt=stamp(now-46000);
  assert.equal(liveStation(source,'D1',now).status,'采集端离线');
  const cached=state();cached.telemetry.generatedAt=stamp(now-46000);
  assert.equal(liveStation(cached,'D1',now).status,'同步延迟');
  const mic=state();mic.readiness[0].mic=false;
  assert.equal(liveStation(mic,'D1',now).value,null);
  assert.equal(liveStation(mic,'D1',now).status,'麦克风异常');
});
test('short curves leave missing intervals disconnected and expire old samples',()=>{
  const data=state();data.telemetry.nodes[0].history=[[now-400000,80],[now-20000,50],[now-15000,51],[now-1000,52]];
  const points=liveStation(data,'D1',now).history;
  assert.equal(points.length,3);
  assert.equal((sparkPath(points,now).match(/M/g)||[]).length,2);
  assert.equal(ageLabel(125),'2 分 5 秒前');
});
test('cloud only publishes bounded acoustic telemetry with no private fields',()=>{
  const source=state();source.telemetry.nodes[0].ip='private-host';source.telemetry.nodes[0].token='private-key';
  source.telemetry.nodes[0].samples=2;source.telemetry.nodes[0].windowLeq=51.5;
  const result=sanitizeState(source,now);
  assert.equal(result.telemetry.nodes.length,7);
  const d1=result.telemetry.nodes.find(n=>n.node==='D1');
  assert.equal(d1.laeq,52.3);assert.equal(d1.windowLeq,51.5);
  assert.ok(!JSON.stringify(result).includes('private-'));
  source.telemetry.nodes[0].laeq=Infinity;source.telemetry.nodes[0].history=[[now,NaN],[now,250],[now+300000,50]];
  const invalid=sanitizeState(source,now).telemetry.nodes.find(n=>n.node==='D1');
  assert.equal(invalid.laeq,null);assert.deepEqual(invalid.history,[]);
});
