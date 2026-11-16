import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../dist/summary.js',import.meta.url),'utf8')+';globalThis.summary=SoundAtlasSummary;',context);
const {analyze}=context.summary;const nodes=[{id:'A'},{id:'B'}];
const blank=()=>Array.from({length:1440},()=>({sound:{},counts:{}}));
test('ranking uses the same complete minutes and logarithmic energy averaging',()=>{
 const frames=blank();frames[1200]={sound:{A:40,B:50},counts:{A:60,B:60}};frames[1201]={sound:{A:60,B:50},counts:{A:60,B:60}};
 frames[1202]={sound:{A:100,B:30},counts:{A:60,B:2}};
 const result=analyze(frames,nodes);
 assert.deepEqual(Array.from(result.common),[1200,1201]);assert.equal(result.ranking[0].node.id,'B');
 assert.ok(Math.abs(result.ranking[1].value-57.032913781186615)<1e-9);
 assert.equal(result.coverage[1].sampleSeconds,122);
});
test('no samples and partial minutes cannot masquerade as quiet recordings or daily peaks',()=>{
 const frames=blank();frames[10]={sound:{A:120},counts:{A:1}};
 const result=analyze(frames,nodes);assert.equal(result.ranking.length,0);assert.equal(result.peaks.length,0);
 assert.equal(result.coverage[1].minutes,0);assert.equal(result.coverage[1].sampleSeconds,null);
 assert.equal(result.coverage[0].partialMinutes,1);
 const empty=analyze(blank(),nodes);assert.equal(empty.scope,null);assert.equal(empty.coverage[0].coverage,null);
});
test('coverage gaps stay within the observed window and retain exact jump timestamps',()=>{
 const frames=blank();for(const slot of [1200,1202])frames[slot]={sound:{A:45,B:46},counts:{A:60,B:60}};
 const result=analyze(frames,nodes);
 assert.equal(result.scope.start,1200);assert.equal(result.scope.end,1203);
 assert.equal(result.coverage[0].gaps.length,1);assert.equal(result.coverage[0].gaps[0].start,1201);assert.equal(result.coverage[0].gaps[0].end,1202);
 assert.deepEqual(Array.from(result.peaks,p=>p.slot),[1200,1202]);
});
test('legacy repeated half-hour summaries are not counted as minute observations',()=>{
 const frames=blank();frames[10]={sound:{A:45,B:46},counts:{A:60,B:60},periodMinutes:30};
 assert.equal(analyze(frames,nodes).scope,null);
});
