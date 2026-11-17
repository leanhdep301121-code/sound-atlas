import test from 'node:test';
import assert from 'node:assert/strict';
import { GET as stateGET } from '../api/admin-state.js';
import { GET as sessionGET } from '../api/admin-session.js';
import { POST, GET } from '../api/admin-command.js';
import { controlStore } from '../lib/collector-control.mjs';

test('anonymous visitors can view state and query observations, but cannot enqueue any mutation', async () => {
  const original = { state:controlStore.state, enqueue:controlStore.enqueue, command:controlStore.command };
  const enqueued=[];
  const request=(input,origin='https://www.alecyin.icu')=>new Request('https://www.alecyin.icu/sound-atlas/api/admin-command', {
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input),
  });
  try {
    controlStore.state=async ({includeView})=>({connected:true,liveView:includeView?{nodes:['D2']}:null});
    controlStore.enqueue=async input=>{enqueued.push(input);return {id:'public-query-123',action:input.action,status:'done',result:{count:12}};};
    const session=await sessionGET(new Request('https://www.alecyin.icu/api/admin-session'));
    assert.equal(session.status,200);assert.equal((await session.json()).authenticated,false);
    const state=await stateGET(new Request('https://www.alecyin.icu/api/admin-state?view=manage'));
    assert.equal(state.status,200);assert.deepEqual((await state.json()).liveView,{nodes:['D2']});
    for(const action of ['overview','series','inspect','count','suspects','export']) {
      const response=await POST(request({action,payload:{},requestId:'public-read-123'}));
      assert.equal(response.status,200,action);
    }
    const count=enqueued.length;
    for(const action of ['plan','calibration','exclude','unexclude','purge','unknown-new-action']) {
      const response=await POST(request({action,payload:{dry:true},requestId:'public-write-123'}));
      assert.equal(response.status,401,action);
    }
    assert.equal(enqueued.length,count,'denied operations never reach collector queue');
    assert.equal((await POST(request({action:'inspect'},'https://other.invalid'))).status,403);
    controlStore.command=async()=>({id:'public-query-123',action:'inspect',status:'done',result:{count:12}});
    assert.equal((await GET(new Request('https://www.alecyin.icu/api/admin-command?id=public-query-123'))).status,200);
    controlStore.command=async()=>({id:'private-result-123',action:'purge',status:'done',result:{backup:'private'}});
    const denied=await GET(new Request('https://www.alecyin.icu/api/admin-command?id=private-result-123'));
    assert.equal(denied.status,401);assert.ok(!(await denied.text()).includes('backup'));
  } finally { Object.assign(controlStore,original); }
});
