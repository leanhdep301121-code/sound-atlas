import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeSnapshot } from '../lib/live-store.mjs';

const context = vm.createContext({ Intl, Date, AbortController, setTimeout, clearTimeout,
  document: { createElement: () => ({ width: 0, height: 0 }) } });
for (const file of ['data.js', 'live.js', 'heatmap.js']) {
  vm.runInContext(readFileSync(new URL('../dist/' + file, import.meta.url), 'utf8'), context);
}
const run = expression => vm.runInContext(expression, context);

test('personal workstation retains its CAD footprint after swapping device labels', () => {
  const node = run("TABLES.find(node => node.id === 'D1')");
  assert.ok(node.cadX > 105741.93 && node.cadX < 106543.81);
  assert.ok(node.cadY > 135938.32 && node.cadY < 137542.09);
  assert.ok(Math.abs(node.x - (node.cadX - 66000) / 65) < 1e-6);
  assert.ok(Math.abs(node.y - (160000 - node.cadY) / 65) < 1e-6);
  assert.equal(run('TABLES.length'), 6);
  assert.equal(node.device, 'N4');
  assert.equal(node.marker, 'N4');
  assert.equal(run("TABLES.find(node=>node.id==='E').device"), 'D1');
  assert.equal(run('insideHeatmap(TABLES[5].x, TABLES[5].y)'), true);
});

test('D1 remains empty when absent and contributes to energy interpolation when measured', () => {
  assert.equal(run('heatmapSamples({sound:{A:50}}).length'), 1);
  assert.equal(run('heatmapLevel(600,350,heatmapSamples({sound:{D1:48}}))'), null);
  assert.equal(run('heatmapLevel(TABLES[5].x,TABLES[5].y,heatmapSamples({sound:{A:60,D1:48}}))'), 48);
  assert.equal(run('createDemo().every(day=>day.frames.every(frame=>Number.isFinite(frame.sound.D1)))'), true);
  assert.equal(run('parseObservation(CSV_TEMPLATE).days[0].frames[29].sound.D1'), 48.6);
});

test('six-node ingest and public live parsing preserve D1 without changing table mappings', () => {
  const now = Date.parse('2026-11-15T08:00:00Z');
  const input = { version: 1, generatedAt: new Date(now).toISOString(),
    nodes: ['A','B','C','D','E','D1'].map(id=>({id,lastSeen:new Date(now).toISOString()})),
    days: [{label:'2026-11-15',frames:Array.from({length:48},(_,slot)=>slot===32
      ? {sound:{C:56,D1:48},counts:{C:30,D1:20}} : {sound:{},counts:{}})}],
    latest:{timestamp:new Date(now).toISOString(),sound:{D1:49}} };
  const normalized = normalizeSnapshot(input,now);
  assert.equal(normalized.nodes[5].label,'个人工位');
  assert.equal(normalized.nodes[2].label,'公桌3');
  context.payload = {...normalized,connected:true};
  assert.equal(run('SoundAtlasLive.normalizeSnapshot(payload).days[0].frames[32].sound.D1'),48);
  assert.equal(run('SoundAtlasLive.normalizeSnapshot(payload).days[0].frames[32].counts.D1'),20);
  input.nodes.pop();
  input.days[0].frames[32]={sound:{C:56},counts:{C:30}};
  input.latest.sound={};
  const legacy=normalizeSnapshot(input,now);
  assert.equal(legacy.nodes[5].status,'unknown');
  assert.equal(legacy.days[0].frames[32].sound.D1,undefined);
  input.nodes[0].id='D1';
  assert.throws(()=>normalizeSnapshot(input,now),/mapping/);
});
