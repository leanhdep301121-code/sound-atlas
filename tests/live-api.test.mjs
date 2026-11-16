import test from 'node:test';
import assert from 'node:assert/strict';
import { authorized, normalizeSnapshot, publicSnapshot } from '../lib/live-store.mjs';
import { POST } from '../api/ingest.js';

const now = Date.parse('2026-11-14T12:00:00Z');
function fixture() {
  const frames = Array.from({ length: 48 }, () => ({ sound: {}, counts: {} }));
  frames[40] = { sound: { C: 52.1 }, counts: { C: 30 } };
  return { version: 1, generatedAt: new Date(now).toISOString(), plan: { startMs: now - 60000, endMs: now + 3600000 }, nodes: ['A','B','C','D','E'].map(id => ({ id, lastSeen: id === 'C' ? new Date(now).toISOString() : null })), days: [{ label: '2026-11-14', frames }], latest: { timestamp: new Date(now).toISOString(), sound: { C: 52.1 } } };
}

test('publish only acoustic summary fields and preserve confirmed N1→C mapping', () => {
  const input = fixture(); input.token='private'; input.ip='192.168.0.1'; input.nodes[2].ip='192.168.0.2';
  const result = normalizeSnapshot(input, now);
  assert.equal(result.days[0].frames[40].sound.C, 52.1);
  assert.equal(result.nodes[2].label, '公桌3');
  assert.equal(result.nodes[2].status, 'online');
  assert.equal(result.plan.state, 'recording');
  assert.ok(!JSON.stringify(result).includes('192.168'));
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('missing source and stale collector never become live data', () => {
  assert.equal(publicSnapshot(null, now).connected, false);
  const snapshot = normalizeSnapshot(fixture(), now);
  const stale = publicSnapshot(snapshot, now + 91_000);
  assert.equal(stale.connected, false);
  assert.equal(stale.nodes[2].status, 'offline');
  assert.deepEqual(stale.latest.sound, {});
  assert.equal(stale.days[0].frames[40].sound.C, 52.1);
});
test('reject impossible levels, clock drift and duplicate mappings', () => {
  const bad = fixture(); bad.days[0].frames[40].sound.C = -80;
  assert.throws(() => normalizeSnapshot(bad, now), /sound/);
  const future=fixture();future.generatedAt=new Date(now+600_000).toISOString();
  assert.throws(() => normalizeSnapshot(future,now), /clock/);
  const duplicate=fixture();duplicate.nodes[0].id='C';
  assert.throws(() => normalizeSnapshot(duplicate,now), /mapping/);
});
test('unauthorized ingestion cannot reach storage', async () => {
  const previous=process.env.SOUND_ATLAS_INGEST_TOKEN;
  process.env.SOUND_ATLAS_INGEST_TOKEN='test-only-secret';
  try {
    assert.equal(authorized('Bearer wrong','test-only-secret'),false);
    const response=await POST(new Request('https://example.test/api/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fixture())}));
    assert.equal(response.status,401);
  } finally { if(previous===undefined)delete process.env.SOUND_ATLAS_INGEST_TOKEN;else process.env.SOUND_ATLAS_INGEST_TOKEN=previous; }
});

test('history revision ignores latest sample updates but changes when stored minute observations change',()=>{
 const input=fixture();input.latest.samplePeriodSeconds=1;input.latest.timestamps={C:new Date(now-2000).toISOString()};
 const first=normalizeSnapshot(input,now);input.latest.sound.C=70;
 const second=normalizeSnapshot(input,now);assert.equal(first.historyRevision,second.historyRevision);
 assert.equal(second.latest.timestamps.C,input.latest.timestamps.C);assert.equal(second.latest.samplePeriodSeconds,1);
 input.days[0].frames[40].counts.C++;
 assert.notEqual(normalizeSnapshot(input,now).historyRevision,first.historyRevision);
});
