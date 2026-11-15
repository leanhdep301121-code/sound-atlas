import test from 'node:test';
import assert from 'node:assert/strict';
import {followRange,selectLiveView,scopeKey,operationScope,viewFitsPlan} from '../dist/collect/collect-manage.mjs';
import {sanitizeLiveView,sanitizeState,normalizeCommand,createControlStore} from '../lib/collector-control.mjs';
import {waitForInspection} from '../lib/read-query.mjs';
import {GET as adminState} from '../api/admin-state.js';
const now=Date.parse('2026-11-15T12:35:00Z');
const nodes=['N1','D2'];
const overview={nodes:nodes.map(node=>({node,first:now-3600000,last:now-2000}))};
const plan={startMs:now-2100000,endMs:now+3600000};
function view(){return {revision:'a'.repeat(64),preset:'plan',generatedAt:new Date(now).toISOString(),series:{start:plan.startMs,end:now-1000,bucket:10000,series:{N1:[[0,50,49,51,10,0]],D2:[[0,60,59,61,8,1]]}},counts:{N1:{total:10,invalid:0,excluded:1},D2:{total:8,invalid:1,excluded:2}}};}
test('following a current plan extends the range, while a completed plan stays bounded',()=>{
  const before=followRange('plan',{plan,overview,nodes,now});
  const later=followRange('plan',{plan,overview:{nodes:overview.nodes.map(n=>({...n,last:now+28000}))},nodes,now:now+30000});
  assert.equal(later.start,before.start);assert.equal(later.end-before.end,30000);
  assert.equal(followRange('plan',{plan:{...plan,endMs:now-10000},overview,nodes,now}).end,now-10000);
  assert.equal(followRange('plan',{plan:{startMs:now+1000},overview,nodes,now}),null);
  const frozen={...before,nodes};assert.deepEqual(operationScope(frozen,null,scopeKey(before,nodes)),frozen);
});
test('cached plan curves and counts can be selected locally without a remote command',()=>{
  const result=selectLiveView(view(),['D2']);
  assert.deepEqual(Object.keys(result.series.series),['D2']);
  assert.equal(result.count.total,8);assert.equal(result.count.excluded,2);
  assert.equal(selectLiveView(view(),['UNKNOWN']),null);
  assert.equal(viewFitsPlan(view(),'plan',plan),true);
  assert.equal(viewFitsPlan(view(),'plan',{...plan,startMs:plan.startMs+1000}),false);
  assert.equal(viewFitsPlan(view(),'plan',{...plan,endMs:plan.startMs+1000}),false);
});
test('large live view travels separately and remains protected',async()=>{
  const raw=view();raw.secret='private';raw.series.series.N1[0].push('not-a-record');
  const safe=sanitizeLiveView(raw);assert.deepEqual(safe.series.series.N1,[]);assert.ok(!JSON.stringify(safe).includes('private'));
  const state=sanitizeState({liveViewRevision:raw.revision,readiness:[]},now);
  const calls=[];const store=createControlStore({run:async command=>{calls.push(command);return command[0]==='MGET'?[JSON.stringify(state),JSON.stringify(view())]:JSON.stringify(state);},now:()=>now});
  assert.equal((await store.state()).liveView,undefined);
  assert.equal((await store.state({includeView:true})).liveView.revision,raw.revision);
  assert.equal(calls[1][0],'MGET');
});
test('inspection is read-only and only its result is awaited',async()=>{
  const command=normalizeCommand({action:'inspect',requestId:'readonly-query-12345',payload:{start:1000,end:60000,nodes,w:200}});
  assert.equal(command.mutating,false);
  let time=0,calls=0;
  const queued={id:'query',action:'inspect',status:'queued'};
  const result=await waitForInspection(queued,async()=>({id:'query',status:++calls===2?'done':'running',result:{ok:true}}),{now:()=>time,wait:async ms=>{time+=ms;},budgetMs:1000});
  assert.equal(result.status,'done');assert.equal(calls,2);
  const mutation={id:'plan',action:'plan',status:'queued'};
  assert.equal(await waitForInspection(mutation,()=>assert.fail('must not poll mutations')),mutation);
});
test('parallel state reading never returns data to an invalid session',async()=>{
  const oldFetch=globalThis.fetch,oldUrl=process.env.KV_REST_API_URL,oldToken=process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL='https://store.invalid';process.env.KV_REST_API_TOKEN='test';
  globalThis.fetch=async(_url,options)=>{const command=JSON.parse(options.body);return Response.json({result:command[1].includes('admin-session')?null:JSON.stringify({receivedAtMs:now,readiness:[],overview:{secret:'private'}})});};
  try{const response=await adminState(new Request('https://www.alecyin.icu/api/admin-state',{headers:{cookie:'__Host-sound-atlas-admin='+'a'.repeat(43)}}));assert.equal(response.status,401);assert.ok(!(await response.text()).includes('private'));}
  finally{globalThis.fetch=oldFetch;if(oldUrl===undefined)delete process.env.KV_REST_API_URL;else process.env.KV_REST_API_URL=oldUrl;if(oldToken===undefined)delete process.env.KV_REST_API_TOKEN;else process.env.KV_REST_API_TOKEN=oldToken;}
});
