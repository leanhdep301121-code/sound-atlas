'use strict';

// Interior wall/window coordinates traced from the supplied 2F DWG.
// The lower work area includes its two open lounge recesses. Enclosed rooms
// and the exterior balcony beneath the work area are outside this mask.
const HEATMAP_AREAS = [
  [
    [84855.14, 151589.26], [102855.14, 151589.26],
    [102855.14, 145985.49], [84855.14, 145985.49],
  ],
  [
    [84779.67, 145985.49], [104930.61, 145985.49],
    [104930.61, 143891.15], [84779.67, 143891.15],
  ],
  [
    [83157.02, 143891.15], [106543.81, 143891.15],
    [106543.81, 135589.26], [106949.48, 135589.26],
    [106949.48, 133589.26], [102949.48, 133589.26],
    [102949.48, 135589.26], [102751.36, 135589.26],
    [102751.36, 135089.26], [94949.48, 135089.26],
    [94949.48, 135589.26], [94751.36, 135589.26],
    [94751.36, 133589.26], [90751.36, 133589.26],
    [90751.36, 135589.26], [90553.25, 135589.26],
    [90553.25, 135089.26], [83157.02, 135089.26],
  ],
].map(vertices => {
  const points = vertices.map(([x, y]) => [(x - 66000) / 65, (160000 - y) / 65]);
  return {
    points,
    left: Math.min(...points.map(point => point[0])),
    right: Math.max(...points.map(point => point[0])),
    top: Math.min(...points.map(point => point[1])),
    bottom: Math.max(...points.map(point => point[1])),
  };
});

// A fixed 30-70 dB(A) scale keeps colors comparable across dates and times.
const HEATMAP_STOPS = [
  [30, [53, 119, 184]],
  [40, [77, 173, 171]],
  [50, [234, 211, 113]],
  [60, [235, 137, 73]],
  [70, [193, 62, 64]],
];

function heatmapSamples(frame) {
  return TABLES.filter(node => Number.isFinite(frame.sound[node.id])).map(node => ({
    x: node.x,
    y: node.y,
    level: frame.sound[node.id],
    energy: Math.pow(10, frame.sound[node.id] / 10),
  }));
}

function heatmapLevel(x, y, samples) {
  if (samples.length < 2) return null;
  let weightedEnergy = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const distanceSquared = (x - sample.x) ** 2 + (y - sample.y) ** 2;
    if (distanceSquared < 1e-10) return sample.level;
    const weight = 1 / distanceSquared;
    weightedEnergy += weight * sample.energy;
    totalWeight += weight;
  }
  return 10 * Math.log10(weightedEnergy / totalWeight);
}

function heatmapColor(level) {
  const clamped = Math.max(30, Math.min(70, level));
  const index = Math.min(3, Math.floor((clamped - 30) / 10));
  const [low, lowColor] = HEATMAP_STOPS[index];
  const [high, highColor] = HEATMAP_STOPS[index + 1];
  const mix = (clamped - low) / (high - low);
  return lowColor.map((channel, component) => Math.round(channel + (highColor[component] - channel) * mix));
}

function insideHeatmap(x, y) {
  return HEATMAP_AREAS.some(area => {
    if (x < area.left || x > area.right || y < area.top || y > area.bottom) return false;
    let inside = false;
    for (let i = 0, previous = area.points.length - 1; i < area.points.length; previous = i, i += 1) {
      const [ax, ay] = area.points[previous];
      const [bx, by] = area.points[i];
      // All source boundaries are axis-aligned; keep their edges inclusive.
      if (ax === bx && x === ax && y >= Math.min(ay, by) && y <= Math.max(ay, by)) return true;
      if (ay === by && y === ay && x >= Math.min(ax, bx) && x <= Math.max(ax, bx)) return true;
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  });
}

const heatmapRaster = document.createElement('canvas');
heatmapRaster.width = 600;
heatmapRaster.height = Math.ceil(600 * FLOOR_PLAN.height / FLOOR_PLAN.width);
// The floor geometry stays fixed throughout playback, so evaluate it once.
const heatmapCoverage = new Uint8Array(heatmapRaster.width * heatmapRaster.height);
for (let row = 0; row < heatmapRaster.height; row += 1) {
  for (let col = 0; col < heatmapRaster.width; col += 1) {
    const x = (col + .5) / heatmapRaster.width * FLOOR_PLAN.width;
    const y = (row + .5) / heatmapRaster.height * FLOOR_PLAN.height;
    heatmapCoverage[row * heatmapRaster.width + col] = insideHeatmap(x, y) ? 1 : 0;
  }
}
// Precompute geometry weights once. Cache finished fields by values, not object identity.
const heatmapFieldCache = new Map();
let heatmapKernel = null;
let heatmapRevision = 0;
let heatmapTargetKey = null;
let heatmapHasData = false;
let heatmapTransition = null;
let heatmapAnimation = null;
let heatmapPaintListener = () => {};
const heatmapBlendSource = document.createElement('canvas');
heatmapBlendSource.width = heatmapRaster.width;
heatmapBlendSource.height = heatmapRaster.height;

function heatmapField(frame) {
  const {min:mathMin,max:mathMax,floor:mathFloor,log10:mathLog10,round:mathRound}=Math;
  const values = TABLES.map(node => Number.isFinite(frame.sound[node.id]) ? frame.sound[node.id] : null);
  const key = JSON.stringify(values);
  if (heatmapFieldCache.has(key)) {
    const field=heatmapFieldCache.get(key);heatmapFieldCache.delete(key);heatmapFieldCache.set(key,field);return field;
  }
  if (!heatmapKernel) {
    const covered=[];
    for(let index=0;index<heatmapCoverage.length;index++)if(heatmapCoverage[index])covered.push(index);
    const weights=new Float64Array(covered.length*TABLES.length);
    covered.forEach((index,pixel)=>{
      const x=(index%heatmapRaster.width+.5)/heatmapRaster.width*FLOOR_PLAN.width;
      const y=(mathFloor(index/heatmapRaster.width)+.5)/heatmapRaster.height*FLOOR_PLAN.height;
      TABLES.forEach((node,n)=>{weights[pixel*TABLES.length+n]=1/mathMax(1e-12,(x-node.x)**2+(y-node.y)**2);});
    });
    heatmapKernel={covered,weights};
  }
  const samples=values.flatMap((level,index)=>level===null?[]:[{index,energy:10**(level/10)}]);
  const canvas=document.createElement('canvas');canvas.width=heatmapRaster.width;canvas.height=heatmapRaster.height;
  const ctx=canvas.getContext('2d');const image=ctx.createImageData(canvas.width,canvas.height);
  if(samples.length>=2){
    const {covered,weights}=heatmapKernel;
    for(let pixel=0;pixel<covered.length;pixel++){
      let energy=0,total=0;
      for(const sample of samples){const weight=weights[pixel*TABLES.length+sample.index];energy+=weight*sample.energy;total+=weight;}
      const level=mathMax(30,mathMin(70,10*mathLog10(energy/total)));
      const stop=mathMin(3,mathFloor((level-30)/10)),mix=(level-HEATMAP_STOPS[stop][0])/10;
      const low=HEATMAP_STOPS[stop][1],high=HEATMAP_STOPS[stop+1][1],offset=covered[pixel]*4;
      for(let channel=0;channel<3;channel++)image.data[offset+channel]=mathRound(low[channel]+(high[channel]-low[channel])*mix);
      image.data[offset+3]=255;
    }
  }
  ctx.putImageData(image,0,0);
  const field={key,canvas,count:samples.length,hasData:samples.length>=2};heatmapFieldCache.set(key,field);
  if(heatmapFieldCache.size>24)heatmapFieldCache.delete(heatmapFieldCache.keys().next().value);
  return field;
}
function setHeatmapPaintListener(listener){heatmapPaintListener=listener;}
function paintHeatmapPlan(){
  const canvas=byId('heatmap');
  if(canvas.width!==heatmapRaster.width)canvas.width=heatmapRaster.width;
  if(canvas.height!==heatmapRaster.height)canvas.height=heatmapRaster.height;
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.globalAlpha=Number(byId('heatmap-opacity').value)/100;ctx.drawImage(heatmapRaster,0,0);ctx.globalAlpha=1;
}
function publishHeatmapPaint(){
  heatmapRevision++;
  if(typeof mapView==='undefined'||mapView==='plan')paintHeatmapPlan();
  heatmapPaintListener(heatmapRaster,heatmapRevision);
}
function heatmapAnimate(now){
  heatmapAnimation=null;
  if(!heatmapTransition)return;
  const progress=Math.min(1,Math.max(0,(now-heatmapTransition.start)/180));
  const ease=progress*progress*(3-2*progress);
  const ctx=heatmapRaster.getContext('2d');ctx.clearRect(0,0,heatmapRaster.width,heatmapRaster.height);
  ctx.globalAlpha=1;ctx.drawImage(heatmapBlendSource,0,0);
  ctx.globalAlpha=ease;ctx.drawImage(heatmapTransition.target,0,0);ctx.globalAlpha=1;
  publishHeatmapPaint();
  if(progress<1)heatmapAnimation=requestAnimationFrame(heatmapAnimate);else heatmapTransition=null;
}
function stopHeatmapAnimation(){
  if(heatmapAnimation!==null)cancelAnimationFrame(heatmapAnimation);
  heatmapAnimation=null;heatmapTransition=null;
}
function drawHeatmap(frame) {
  const canvas=byId('heatmap'),active=state.layer==='heatmap';
  canvas.hidden=!active;byId('heatmap-controls').hidden=!active;
  if(!active){stopHeatmapAnimation();heatmapTargetKey=null;heatmapHasData=false;return;}
  const field=heatmapField(frame);
  byId('heatmap-count').textContent=field.count+' / '+TABLES.length+' 个测点';
  byId('heatmap-note').textContent=field.hasData?'监测工位与内走廊的插值估计，未模拟墙体传播。颜色渐变仅用于切换效果，读数仍为所选时段的实测统计。':'这一时段不足两个有效声级测点，热力分布暂空。';
  canvas.setAttribute('aria-label',field.hasData?clockLabel(state.slot)+' 噪声热力分布，由 '+field.count+' 个测点进行声能距离加权插值。':clockLabel(state.slot)+' 热力图无足够数据。');
  if(field.key!==heatmapTargetKey){
    const animate=heatmapHasData&&field.hasData&&!document.hidden&&!(typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches);
    stopHeatmapAnimation();
    if(animate){
      const from=heatmapBlendSource.getContext('2d');from.clearRect(0,0,heatmapBlendSource.width,heatmapBlendSource.height);from.drawImage(heatmapRaster,0,0);
      heatmapTransition={start:performance.now(),target:field.canvas};heatmapAnimation=requestAnimationFrame(heatmapAnimate);
    }else{
      const ctx=heatmapRaster.getContext('2d');ctx.clearRect(0,0,heatmapRaster.width,heatmapRaster.height);ctx.drawImage(field.canvas,0,0);publishHeatmapPaint();
    }
    heatmapTargetKey=field.key;heatmapHasData=field.hasData;
  }
  if(typeof mapView==='undefined'||mapView==='plan')paintHeatmapPlan();
}
