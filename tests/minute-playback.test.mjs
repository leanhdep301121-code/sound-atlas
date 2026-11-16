import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {normalizeSnapshot} from '../lib/live-store.mjs';
const context=vm.createContext({Intl,Date});
vm.runInContext(readFileSync(new URL('../dist/live.js',import.meta.url),'utf8')+';globalThis.live=SoundAtlasLive;',context);
test('minute snapshots survive ingest and selection without spreading observations into gaps',()=>{
 const now=Date.parse('2026-11-16T00:54:00Z');
 const frames=Array.from({length:1440},()=>({sound:{},counts:{}}));
 frames[533]={sound:{A:50},counts:{A:60}};frames[534]={sound:{A:65},counts:{A:1}};
 const input={version:1,slotMinutes:1,generatedAt:new Date(now).toISOString(),nodes:['A','B','C','D','E','D1'].map(id=>({id,lastSeen:null})),days:[{label:'2026-11-16',frames}]};
 const stored=normalizeSnapshot(input,now);
 const source=context.live.selectPeriod(context.live.normalizeSnapshot({...stored,connected:true}),{},now);
 assert.equal(source.slot,534);assert.equal(source.days[0].frames[533].sound.A,50);
 assert.equal(source.days[0].frames[534].sound.A,65);assert.equal(source.days[0].frames[535].sound.A,undefined);
 assert.throws(()=>normalizeSnapshot({...input,slotMinutes:5},now),/interval/);
 assert.throws(()=>normalizeSnapshot({...input,slotMinutes:30},now),/frame/);
});
test('legacy data stays labelled as half-hour statistics until receiver upgrade',()=>{
 const frames=Array.from({length:48},()=>({sound:{},counts:{}}));frames[17]={sound:{A:50},counts:{A:900}};
 const snapshot=context.live.normalizeSnapshot({version:1,connected:false,days:[{label:'2026-11-16',frames}]});
 const source=context.live.selectPeriod(snapshot,{follow:false,label:'2026-11-16',slot:534});
 assert.equal(source.days[source.day].frames[534].periodMinutes,30);
 assert.equal(source.days[source.day].frames[540].sound.A,undefined);
});
