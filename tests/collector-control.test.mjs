import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCommand, sanitizeState, normalizeReceipts, readControlJson, createControlStore } from '../lib/collector-control.mjs';
import { POST as collectorPost } from '../api/collector-control.js';
import { GET as adminStateGet } from '../api/admin-state.js';

const requestId='test-request-123456';
const range={start:1000,end:60000,nodes:['N1','N2']};

test('only supported commands and bounded selectors reach the queue',()=>{
  assert.throws(()=>normalizeCommand({action:'sql',requestId,payload:{sql:'DELETE FROM readings'}}));
  assert.throws(()=>normalizeCommand({action:'count',requestId,payload:{...range,nodes:['N1; DROP']}}));
  assert.throws(()=>normalizeCommand({action:'series',requestId,payload:{...range,w:3000}}));
  assert.deepEqual(normalizeCommand({action:'count',requestId,payload:{...range,sql:'ignored'}}).payload,range);
});
test('permanent deletion requires exact confirmed count and plan version',()=>{
  assert.throws(()=>normalizeCommand({action:'purge',requestId,payload:{...range,mode:'range',dry:false,planVersion:3}}));
  assert.throws(()=>normalizeCommand({action:'purge',requestId,payload:{...range,mode:'range',dry:false,planVersion:3,expectedCount:20,confirmation:'DELETE 21'}}));
  const confirmed=normalizeCommand({action:'purge',requestId,payload:{...range,mode:'range',dry:false,planVersion:3,expectedCount:20,confirmation:'DELETE 20'}});
  assert.equal(confirmed.mutating,true);
  assert.equal(normalizeCommand({action:'purge',requestId,payload:{mode:'outside_plan',dry:true,planVersion:3}}).mutating,false);
});
test('export pagination is bounded and its cursor remains bound to selected nodes',()=>{
  const payload={...range,limit:1000,cursor:{node:'N1',ts:3000,maxRowid:20,end:60000,signature:'a'.repeat(64)}};
  assert.deepEqual(normalizeCommand({action:'export',requestId,payload}).payload,{...payload,clean:true});
  assert.throws(()=>normalizeCommand({action:'export',requestId,payload:{...payload,limit:2000}}));
  assert.throws(()=>normalizeCommand({action:'export',requestId,payload:{...payload,cursor:{...payload.cursor,node:'N5'}}}));
});
test('management state strips addresses and credentials while keeping readiness',()=>{
  const state=sanitizeState({overview:{nodes:[{node:'N1',count:5,ip:'192.168.0.2'}],exclusions:[],colors:{N1:'#123456'},backups:[{name:'noise.db',mb:.2}]},readiness:[{node:'N1',online:true,ip:'192.168.0.2',token:'PRIVATE',synced:true,mic:true,planSynced:true}],plan:{version:1,startMs:10,endMs:20,state:'finished'},bridge:{state:'online',token:'PRIVATE'}},5000);
  assert.equal(state.receivedAtMs,5000);
  assert.equal(state.readiness[0].online,true);
  assert.ok(!JSON.stringify(state).includes('192.168'));
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
});
test('receipts reject unknown status and duplicate identifiers, and strip secrets',()=>{
  const receipt=normalizeReceipts([{id:requestId,status:'done',result:{ok:true,token:'private',nested:{ip:'192.168.0.3'}}}]);
  assert.deepEqual(JSON.parse(receipt[0].resultJson),{ok:true,nested:{}});
  assert.throws(()=>normalizeReceipts([{id:requestId,status:'queued'}]));
  assert.throws(()=>normalizeReceipts([{id:requestId,status:'done'},{id:requestId,status:'failed'}]));
});
test('collector request has its own bounded JSON body without changing public ingest',async()=>{
  await assert.rejects(readControlJson(new Request('https://example.test',{method:'POST',body:'x'.repeat(20)}),10),error=>error.status===413);
  await assert.rejects(readControlJson(new Request('https://example.test',{method:'POST',body:'not-json'})),error=>error.status===400);
  assert.deepEqual(await readControlJson(new Request('https://example.test',{method:'POST',body:'{"action":"poll"}'})),{action:'poll'});
});
test('unauthenticated public callers cannot read admin state or submit collector results',async()=>{
  const admin=await adminStateGet(new Request('https://example.test/api/admin-state'));
  assert.ok([401,503].includes(admin.status));
  const collector=await collectorPost(new Request('https://example.test/api/collector-control',{method:'POST',body:'{}'}));
  assert.equal(collector.status,401);
});
test('client-visible command fields never contain queue fingerprints or payloads',async()=>{
  const store=createControlStore({run:async()=>JSON.stringify({id:requestId,action:'plan',status:'done',payload:{secret:'private'},fingerprint:'internal',result:{ok:true}})});
  assert.deepEqual(await store.command(requestId),{id:requestId,action:'plan',status:'done',result:{ok:true}});
});
test('opaque JSON restores empty command objects and nested result shapes at the API boundary',async()=>{
  const pollStore=createControlStore({run:async()=>JSON.stringify({command:{id:requestId,action:'overview',payloadJson:'{}',createdAt:'2026-11-14T00:00:00Z',expiresAt:'2026-11-14T00:01:30Z'},acknowledged:[],rejected:[]})});
  const poll=await pollStore.poll({action:'poll',state:{overview:{},plan:{},readiness:[]},results:[]});
  assert.deepEqual(poll.command.payload,{});
  assert.equal('payloadJson' in poll.command,false);
  const result={series:{N1:[]},filters:{},nodes:[],exclusions:[],nested:{objects:[{}],arrays:[[]]}};
  const readStore=createControlStore({run:async()=>JSON.stringify({id:requestId,action:'series',status:'done',resultJson:JSON.stringify(result)})});
  assert.deepEqual((await readStore.command(requestId)).result,result);
});
test('previously queued overview with cjson empty-array payload remains compatible',async()=>{
  const store=createControlStore({run:async()=>JSON.stringify({command:{id:requestId,action:'overview',payload:[]},acknowledged:[],rejected:[]})});
  const result=await store.poll({action:'poll',state:{overview:{},plan:{}},results:[]});
  assert.deepEqual(result.command.payload,{});
});

test('continuous collection needs no date fields and remains version checked',()=>{
  const command=normalizeCommand({action:'plan',requestId,payload:{action:'continuous',planVersion:4}});
  assert.deepEqual(command.payload,{action:'continuous',planVersion:4});
  assert.equal(command.mutating,true);
  assert.throws(()=>normalizeCommand({action:'plan',requestId,payload:{action:'continuous',planVersion:-1}}));
});
