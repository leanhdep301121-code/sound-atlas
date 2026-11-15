export function scopeKey(range, nodes) {
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start || !nodes.length) return '';
  return JSON.stringify([range.start, range.end, [...new Set(nodes)].sort()]);
}
export function operationScope(applied, selection, draftKey) {
  if (!applied || !draftKey || scopeKey(applied, applied.nodes) !== draftKey) throw new Error('筛选已修改，请先点击“应用筛选”。');
  const range=selection || applied;
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < applied.start || range.end > applied.end || range.end <= range.start) throw new Error('选区必须位于已查询的时间范围内。');
  return {start:range.start,end:range.end,nodes:[...applied.nodes]};
}
export function chartReadings(series,node,stamp) {
  const index=Math.floor((stamp-series.start)/series.bucket);
  const point=series.series?.[node]?.find(row=>row[0]===index);
  return point && Number.isFinite(point[1]) ? point[1] : null;
}
export function beginSelectionGesture(x,stamp,following){
  return {x,start:stamp,end:stamp,following,selecting:false};
}
export function moveSelectionGesture(gesture,x,stamp){
  return {...gesture,end:stamp,selecting:gesture.selecting||(Math.abs(x-gesture.x)>=6&&Math.abs(stamp-gesture.start)>=1000)};
}
export function selectionFromGesture(gesture){
  if(!gesture?.selecting||Math.abs(gesture.end-gesture.start)<1000)return null;
  return {start:Math.min(gesture.start,gesture.end),end:Math.max(gesture.start,gesture.end)};
}
export function selectLiveView(view,nodes){
  if(!view?.series||!nodes.length||nodes.some(node=>!Object.hasOwn(view.counts||{},node)))return null;
  const series={...view.series,series:Object.fromEntries(nodes.map(node=>[node,view.series.series?.[node]||[]]))};
  const count=nodes.reduce((sum,node)=>{for(const key of ['total','invalid','excluded'])sum[key]+=view.counts[node][key]||0;return sum;},{total:0,invalid:0,excluded:0});
  return {series,count,generatedAt:view.generatedAt,revision:view.revision};
}
export function viewFitsPlan(view,preset,plan={}){
  if(!view?.series||view.preset!==preset)return false;
  if(preset!=='plan')return true;
  return view.series.start===Math.ceil((plan.startMs||0)/1000)*1000&&(!plan.endMs||view.series.end<=plan.endMs);
}
export function followRange(preset,{plan={},overview={},nodes=[],previous=null,now=Date.now()}={}){
  const available=(overview.nodes||[]).filter(node=>nodes.includes(node.node)&&Number.isFinite(node.first)&&Number.isFinite(node.last));
  if(!available.length)return null;
  const first=Math.min(...available.map(node=>node.first)),last=Math.max(...available.map(node=>node.last))+1000;
  let start=first,end=Math.min(now,last);
  if(preset==='plan'){start=plan.startMs||first;end=Math.min(end,plan.endMs||end);}
  if(preset==='hour')start=now-3600000;
  if(preset==='today')start=Date.parse(new Date(now+8*3600000).toISOString().slice(0,10)+'T00:00:00+08:00');
  if(preset==='custom')start=previous?.start||first;
  return end>start?{start:Math.floor(start/1000)*1000,end:Math.ceil(end/1000)*1000}:null;
}
