import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient, beijingInput, parseBeijing, exportChunk } from '../dist/collect/collect-core.mjs';

test('unauthenticated session is normal and the manager key is never retained', async()=>{
  const requests=[];let logged=false;
  const client=createAdminClient({fetcher:async(url,options)=>{
    requests.push({url,options});
    if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{key:'private-test-key'});logged=true;return Response.json({authenticated:true,csrf:'csrf-test'});}
    if(options.method==='DELETE'){assert.equal(options.headers['X-CSRF-Token'],'csrf-test');logged=false;return Response.json({ok:true});}
    return logged?Response.json({authenticated:true,csrf:'csrf-test'}):Response.json({authenticated:false},{status:401});
  }});
  assert.deepEqual(await client.session(),{authenticated:false});
  assert.equal((await client.login('private-test-key')).authenticated,true);
  await client.logout();
  assert.equal(requests.filter(request=>request.options.body?.includes('private-test-key')).length,1);
});
test('queued and running are not reported as success until collector acknowledgement',async()=>{
  let time=0,index=0;const progress=[];const states=[{id:'op',status:'running'},{id:'op',status:'done',result:{ok:true,message:'saved'}}];
  const client=createAdminClient({now:()=>time,wait:async ms=>{time+=ms;},onProgress:value=>progress.push(value.status),fetcher:async(url,options)=>Response.json(options.method==='POST'?{id:'op',status:'queued'}:states[index++])});
  assert.deepEqual(await client.command('plan',{action:'stop'},{requestId:'stable-id'}),{ok:true,message:'saved'});
  assert.deepEqual(progress,['queued','running','done']);
});
test('uncertain mutation is never re-enqueued automatically',async()=>{
  let writes=0;
  const client=createAdminClient({wait:async()=>{},fetcher:async(url,options)=>{if(options.method==='POST'){writes++;return Response.json({id:'op',status:'queued'});}return Response.json({id:'op',status:'uncertain'});}});
  await assert.rejects(client.command('exclude',{},{requestId:'one-write'}),error=>error.commandId==='op'&&/勿重复/.test(error.message));
  assert.equal(writes,1);
});
test('cancelling a read stops polling without a second enqueue',async()=>{
  const abort=new AbortController();let writes=0,reads=0;
  const client=createAdminClient({wait:async()=>abort.abort(),fetcher:async(url,options)=>{if(options.method==='POST')writes++;else reads++;return Response.json({id:'op',status:'queued'});}});
  await assert.rejects(client.command('series',{},{signal:abort.signal,requestId:'read-only'}),{name:'AbortError'});
  assert.equal(writes,1);assert.equal(reads,0);
});
test('expired or failed commands produce an explicit error, not a success state',async()=>{
  for(const status of ['expired','failed']){
    const client=createAdminClient({wait:async()=>{},fetcher:async(url,options)=>Response.json(options.method==='POST'?{id:'op',status:'queued'}:{id:'op',status,error:'not executed'})});
    await assert.rejects(client.command('plan',{}, {requestId:'request'}),/not executed/);
  }
});
test('unconfirmed command waits are bounded and keep command ID for recovery',async()=>{
  let time=0;
  const client=createAdminClient({now:()=>time,wait:async ms=>{time+=ms;},pollMs:10,maxWaitMs:20,fetcher:async()=>Response.json({id:'op',status:'queued'})});
  await assert.rejects(client.command('series',{}, {requestId:'request'}),error=>error.commandId==='op'&&/未收到/.test(error.message));
});
test('Beijing date fields are independent of browser timezone and reject impossible dates',()=>{
  assert.equal(parseBeijing('2026-11-14T17:30'),Date.parse('2026-11-14T09:30:00Z'));
  assert.equal(beijingInput(Date.parse('2026-11-14T09:30:00Z')),'2026-11-14T17:30:00');
  assert.equal(parseBeijing('2026-02-30T12:00'),null);
});
test('export pages keep headers separate and carry opaque cursor without assumptions',()=>{
  const cursor={node:'N1',ts:123,maxRowid:50,signature:'signature'};
  assert.deepEqual(exportChunk({header:'node,time',csv:'N1,123\n',nextCursor:cursor,done:false,filename:'data.csv'}),{header:'node,time',csv:'N1,123\n',nextCursor:cursor,done:false,filename:'data.csv'});
  assert.throws(()=>exportChunk({csv:'partial'}),/不完整/);
});
