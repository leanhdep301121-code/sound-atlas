import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeKey,operationScope,chartReadings} from '../dist/collect/collect-manage.mjs';
const applied={start:1000,end:10000,nodes:['N1','D1']};
test('export and exclusion use the applied query, not pending form edits',()=>{
  const key=scopeKey(applied,applied.nodes);
  assert.deepEqual(operationScope(applied,null,key),applied);
  assert.throws(()=>operationScope(applied,null,scopeKey({start:2000,end:10000},applied.nodes)),/应用筛选/);
  assert.throws(()=>operationScope(applied,null,scopeKey(applied,['D1'])),/应用筛选/);
  assert.throws(()=>operationScope(null,null,''),/应用筛选/);
  assert.equal(scopeKey(applied,[]),'');
});
test('precise selection must stay inside the displayed query and clear restores it',()=>{
  const key=scopeKey(applied,applied.nodes);
  assert.deepEqual(operationScope(applied,{start:3000,end:5000},key),{start:3000,end:5000,nodes:['N1','D1']});
  assert.deepEqual(operationScope(applied,null,key),applied);
  for(const selection of [{start:0,end:5000},{start:3000,end:11000},{start:5000,end:4000},{start:NaN,end:6000}])assert.throws(()=>operationScope(applied,selection,key),/选区/);
  assert.equal(scopeKey(applied,['D1','N1']),key);
});
test('curve inspection shows actual data and leaves missing buckets blank',()=>{
  const series={start:1000,end:10000,bucket:1000,series:{D1:[[0,50,49,52],[2,55,54,56]]}};
  assert.equal(chartReadings(series,'D1',1500),50);
  assert.equal(chartReadings(series,'D1',2500),null);
  assert.equal(chartReadings(series,'D1',3500),55);
  assert.equal(chartReadings(series,'N1',3500),null);
});
