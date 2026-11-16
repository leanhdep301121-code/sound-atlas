import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const context=vm.createContext({});
vm.runInContext(readFileSync(new URL('../dist/trends.js',import.meta.url),'utf8')+';globalThis.trends=SoundAtlasTrends;',context);
const plain=value=>JSON.parse(JSON.stringify(value));
test('all sensors retain their own values and missing minutes remain gaps',()=>{
 const frames=[{sound:{A:40,B:50}},{sound:{B:51}},{sound:{A:42,B:52}}];
 const result=context.trends.series(frames,[{id:'A'},{id:'B'}],'A');
 assert.deepEqual(plain(result.map(s=>s.values)),[[40,null,42],[50,51,52]]);
 assert.deepEqual(plain(context.trends.segments(result[0].values)),[[{slot:0,value:40}],[{slot:2,value:42}]]);
 assert.equal(context.trends.segments(result[1].values).length,1);
});
test('focus mode filters the display without altering source data or time indices',()=>{
 const frames=[{sound:{}},{sound:{A:40,B:50}}];
 const result=context.trends.series(frames,[{id:'A'},{id:'B'}],'B',true);
 assert.equal(result.length,1);assert.equal(result[0].selected,true);
 assert.deepEqual(plain(context.trends.segments(result[0].values)),[[{slot:1,value:50}]]);
 assert.equal(frames[1].sound.A,40);
});

test('automatic plot range frames the actual recorded hours and leaves missing intervals empty',()=>{
 const frames=Array.from({length:1440},()=>({sound:{}}));frames[1200].sound.A=45;frames[1439].sound.A=50;
 const window=context.trends.domain(frames,[{id:'A'}]);assert.equal(window.start,1200);assert.equal(window.end,1439);
 assert.equal(context.trends.slotAt(.5,window),1320);
 assert.equal(context.trends.slotAt(-1,window),1200);assert.equal(context.trends.slotAt(2,window),1439);
 assert.deepEqual(plain(context.trends.domain(frames,[{id:'A'}],true)),{start:0,end:1439});
});
test('short and empty records have nonzero ranges and ticks remain inside the displayed range',()=>{
 const frames=Array.from({length:1440},()=>({sound:{}}));
 assert.deepEqual(plain(context.trends.domain(frames,[{id:'A'}])),{start:0,end:1439});
 frames[1439].sound.A=45;const window=context.trends.domain(frames,[{id:'A'}]);assert.ok(window.end>window.start);
 const ticks=context.trends.ticks(window);assert.equal(ticks[0],window.start);assert.equal(ticks.at(-1),window.end);
 assert.ok(ticks.every((tick,i)=>tick>=window.start&&tick<=window.end&&(!i||tick>ticks[i-1])));
});
