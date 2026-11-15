import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(reduced=false){
  let time=0,sequence=0;const pending=new Map(),elements=new Map();
  function canvas(){
    const result={width:0,height:0};
    const ctx={globalAlpha:1,draws:[],createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(image){result.pixels=image.data;},clearRect(){this.draws=[];},drawImage(source){this.draws.push({source,alpha:this.globalAlpha});}};
    result.getContext=()=>ctx;return result;
  }
  const context=vm.createContext({Intl,Date,Uint8Array,Uint8ClampedArray,Float64Array,performance:{now:()=>time},document:{hidden:false,createElement:canvas},matchMedia:()=>({matches:reduced}),requestAnimationFrame:fn=>{pending.set(++sequence,fn);return sequence;},cancelAnimationFrame:id=>pending.delete(id),state:{layer:'heatmap',slot:0},byId:id=>{if(!elements.has(id))elements.set(id,{...canvas(),value:'75',setAttribute(){}});return elements.get(id);}});
  for(const file of ['data.js','motion.js','heatmap.js'])vm.runInContext(readFileSync(new URL('../dist/'+file,import.meta.url),'utf8'),context);
  return {run:code=>vm.runInContext(code,context),pending,tick:now=>{time=now;const jobs=[...pending.values()];pending.clear();jobs.forEach(fn=>fn(now));}};
}

test('continuous cursor keeps statistics in the actual half-hour window',()=>{
  const {run}=fixture();
  assert.equal(run('SoundAtlasMotion.timelineAt(29.75).slot'),29);
  assert.equal(run('SoundAtlasMotion.timelineAt(29.75).label'),'14:52');
  assert.equal(run('SoundAtlasMotion.timelineAt(99).position'),47);
  assert.equal(run('SoundAtlasMotion.timelineAt(-1).slot'),0);
});
test('many input events render only the newest state once per animation frame',()=>{
  const f=fixture();f.run('var value=0,renders=[];var queue=SoundAtlasMotion.createFrameQueue(()=>renders.push(value));for(let i=0;i<100;i++){value=i;queue.request();}');
  assert.equal(f.pending.size,1);f.tick(16);
  assert.equal(f.run('renders.length'),1);assert.equal(f.run('renders[0]'),99);
  f.run('queue.request();queue.cancel();');assert.equal(f.pending.size,0);
  f.run('value=101;queue.request();queue.flush();');assert.equal(f.run('renders[1]'),101);assert.equal(f.pending.size,0);
});
test('cached pixels agree with the sound-energy field and new objects reuse identical data',()=>{
  const f=fixture();
  f.run('var frame={sound:{A:52,B:60,C:46,D:55,E:48,D1:51}};var field=heatmapField(frame);');
  assert.equal(f.run('heatmapField({sound:{...frame.sound}})===field'),true);
  assert.equal(f.run(`(()=>{const p=heatmapKernel.covered[Math.floor(heatmapKernel.covered.length/2)];const x=(p%heatmapRaster.width+.5)/heatmapRaster.width*FLOOR_PLAN.width;const y=(Math.floor(p/heatmapRaster.width)+.5)/heatmapRaster.height*FLOOR_PLAN.height;const expected=heatmapColor(heatmapLevel(x,y,heatmapSamples(frame)));return expected.every((v,i)=>Math.abs(field.canvas.pixels[p*4+i]-v)<=1)&&field.canvas.pixels[p*4+3]===255;})()`),true);
  f.run('for(let i=0;i<40;i++)heatmapField({sound:{A:40+i,B:50}});');assert.equal(f.run('heatmapFieldCache.size'),24);
});
test('valid fields crossfade but an empty period clears immediately without fabricated readings',()=>{
  const f=fixture();f.run('var a={sound:{A:40,B:45}},b={sound:{A:60,B:65}};drawHeatmap(a);drawHeatmap(b);');
  assert.equal(f.pending.size,1);f.tick(90);
  assert.equal(f.run('heatmapRaster.getContext("2d").draws[1].alpha'),.5);
  assert.equal(f.run('b.sound.A'),60);
  f.run('drawHeatmap({sound:{}});');assert.equal(f.pending.size,0);
  assert.equal(f.run('heatmapTransition'),null);assert.equal(f.run('heatmapHasData'),false);
  assert.equal(f.run('heatmapRaster.getContext("2d").draws.at(-1).source.pixels.some(v=>v!==0)'),false);
});
test('reduced-motion setting disables crossfades',()=>{
  const f=fixture(true);f.run('drawHeatmap({sound:{A:40,B:45}});drawHeatmap({sound:{A:60,B:65}});');
  assert.equal(f.pending.size,0);assert.equal(f.run('heatmapTransition'),null);
});
