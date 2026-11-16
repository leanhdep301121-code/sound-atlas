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
