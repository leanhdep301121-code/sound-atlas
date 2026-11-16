import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const draw=source.slice(source.indexOf('function drawMiniCharts('),source.indexOf('\nfunction chartArea('));
function fixture(){
 const spark={clientWidth:280,clientHeight:27,setAttribute(){}};
 const wave={clientWidth:1440,bars:[],paints:0};
 const context=vm.createContext({SLOTS:1440,miniChartKey:null,colors:name=>name,byId:id=>id==='node-spark'?spark:wave,prepareCanvas(canvas){canvas.paints=(canvas.paints||0)+1;canvas.bars=[];return {beginPath(){},moveTo(){},lineTo(){},stroke(){},fillRect(x,y,w,h){canvas.bars.push({x,y,w,h});}};}});
 return {spark,wave,draw:vm.runInContext(draw+';drawMiniCharts',context)};
}
const frames=(minute,id='A')=>Array.from({length:1440},(_,i)=>({sound:i===minute?{[id]:50}:{}}));
test('switching dates in fullscreen replaces morning bars with the selected evening data',()=>{
 const f=fixture();f.draw(frames(420),{id:'A',name:'N3'});assert.equal(f.wave.bars[0].x,420);
 f.spark.clientWidth=0;f.spark.clientHeight=0; // inspection panel is hidden in fullscreen
 f.draw(frames(1200),{id:'A',name:'N3'});
 assert.deepEqual(f.wave.bars.map(bar=>bar.x),[1200]);
});
test('fullscreen clears an empty date and updates when selecting another device',()=>{
 const f=fixture();f.draw(frames(420),{id:'A',name:'N3'});f.spark.clientWidth=0;
 f.draw(frames(1200,'B'),{id:'A',name:'N3'});assert.equal(f.wave.bars.length,0);
 f.draw(frames(1200,'B'),{id:'B',name:'N2'});assert.equal(f.wave.bars[0].x,1200);
});
