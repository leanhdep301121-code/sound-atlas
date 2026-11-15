import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkOrigin, login, logout, requireAdmin, HttpError } from '../lib/admin-auth.mjs';

test('reject cross-site administration before reading any state', () => {
  assert.throws(() => checkOrigin(new Request('https://www.alecyin.icu/api/admin-command',{method:'POST',headers:{Origin:'https://evil.invalid'}})), error=>error.status===403);
});
test('owner-key login, HttpOnly session, CSRF, logout and expiry', async () => {
  const originalFetch=globalThis.fetch;
  const previous={...process.env};
  const store=new Map();
  const key='test-only-owner-key-with-48-characters-in-isolation';
  process.env.SOUND_ATLAS_ADMIN_KEY_HASH=createHash('sha256').update(key).digest('hex');
  process.env.KV_REST_API_URL='https://storage.invalid';process.env.KV_REST_API_TOKEN='test';
  globalThis.fetch=async(_url,options)=>{
    const [cmd,...args]=JSON.parse(options.body);let result;
    if(cmd==='EVAL')result=1;
    else if(cmd==='SET'){store.set(args[0],args[1]);result='OK';}
    else if(cmd==='GET')result=store.get(args[0])||null;
    else if(cmd==='DEL'){store.delete(args[0]);result=1;}
    else throw new Error('Unexpected command');
    return Response.json({result});
  };
  try {
    const request=(headers={},body)=>new Request('https://www.alecyin.icu/sound-atlas/api/admin-session',{method:body?'POST':'GET',headers:{Origin:'https://www.alecyin.icu',...headers},...(body?{body:JSON.stringify(body)}:{})});
    await assert.rejects(()=>requireAdmin(request()),e=>e instanceof HttpError&&e.status===401);
    const response=await login(request({}, {key}));
    const setCookie=response.headers.get('set-cookie');
    assert.match(setCookie,/HttpOnly; Secure; SameSite=Strict/);
    const cookie=setCookie.split(';')[0],{csrf}=await response.json();
    await requireAdmin(request({cookie}));
    await assert.rejects(()=>requireAdmin(request({cookie}),{write:true}),e=>e.status===403);
    await requireAdmin(request({cookie,'x-csrf-token':csrf}),{write:true});
    const [storedKey,storedValue]=[...store.entries()].find(([name])=>name.includes('admin-session:'));
    store.set(storedKey,JSON.stringify({...JSON.parse(storedValue),expiresAt:Date.now()-1}));
    await assert.rejects(()=>requireAdmin(request({cookie})),e=>e.status===401);
    store.set(storedKey,storedValue);
    process.env.SOUND_ATLAS_ADMIN_KEY_HASH=createHash('sha256').update('rotated-key').digest('hex');
    await assert.rejects(()=>requireAdmin(request({cookie})),e=>e.status===401);
    process.env.SOUND_ATLAS_ADMIN_KEY_HASH=createHash('sha256').update(key).digest('hex');
    await logout(request({cookie,'x-csrf-token':csrf}));
    await assert.rejects(()=>requireAdmin(request({cookie})),e=>e.status===401);
    assert.ok(!JSON.stringify([...store.values()]).includes(key));
  } finally {
    globalThis.fetch=originalFetch;
    for(const name of ['SOUND_ATLAS_ADMIN_KEY_HASH','KV_REST_API_URL','KV_REST_API_TOKEN']){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}
  }
});
