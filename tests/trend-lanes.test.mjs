import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const app=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const chartCode=app.slice(app.indexOf('function chartArea('),app.indexOf('function drawChart('));
function harness(){
 const strokes=[];let path=[];
 const ctx={beginPath(){path=[];},moveTo(x,y){path.push([x,y]);},lineTo(x,y){path.push([x,y]);},closePath(){},stroke(){strokes.push({color:this.strokeStyle,points:[...path]});},fill(){},arc(){},fillText(){},setLineDash(){}};
 const c=vm.createContext({Math,state:{slot:9},trendWindow:{start:0,end:9},trendPresentation:'lanes',colors:n=>n,byId:()=>({textContent:''}),trendColor:id=>id,clockLabel:String,prepareCanvas:()=>ctx});
 vm.runInContext(readFileSync(new URL('../dist/trends.js',import.meta.url),'utf8'),c);
 const draw=vm.runInContext(chartCode+';drawRidgeChart',c);
 return {draw:series=>draw({clientWidth:900,clientHeight:240},series),strokes};
}
test('lane rendering leaves missing observations disconnected and uses one level scale',()=>{
 const h=harness();h.draw([{node:{id:'A',device:'N3'},selected:true,values:[40,50,null,45]},{node:{id:'B',device:'N2'},selected:false,values:[50,60,null,55]}]);
 const a=h.strokes.filter(s=>s.color==='A'),b=h.strokes.filter(s=>s.color==='B');
 assert.equal(a.length,2);assert.equal(b.length,2);assert.equal(a[0].points.length,2);assert.equal(a[1].points.length,1);
 // Each lane is 93 px high with 78 px for the shared 30–60 dB scale.
 assert.ok(Math.abs((b[0].points[0][1]-a[0].points[0][1])-(93-26))<1e-9);
 assert.equal(a[0].points[0][0],58);assert.equal(b[0].points[0][0],58);
});
