'use strict';
const SoundAtlasTrends = (() => {
  function series(frames, nodes, selectedId, focused = false) {
    return nodes.filter(node => !focused || node.id === selectedId).map(node => ({
      node, selected: node.id === selectedId,
      values: frames.map(frame => Number.isFinite(frame.sound[node.id]) ? frame.sound[node.id] : null),
    }));
  }
  function segments(values) {
    const result = []; let current = null;
    values.forEach((value, slot) => {
      if (value == null) { current = null; return; }
      if (!current) { current = []; result.push(current); }
      current.push({slot, value});
    });
    return result;
  }
  function domain(frames, nodes, fullDay = false) {
    if (fullDay) return {start:0,end:1439};
    const slots=frames.flatMap((frame,slot)=>nodes.some(node=>Number.isFinite(frame.sound[node.id]))?[slot]:[]);
    if (!slots.length) return {start:0,end:1439};
    const start=Math.floor(slots[0]/30)*30;
    const end=Math.min(1439,Math.max(start+29,Math.ceil((slots[slots.length-1]+1)/30)*30));
    return {start,end};
  }
  function slotAt(fraction, window) {
    return Math.round(window.start + Math.max(0,Math.min(1,fraction))*(window.end-window.start));
  }
  function ticks(window) {
    const span=window.end-window.start;
    const step=[5,10,15,30,60,120,180,360].find(step=>span/step<=6)||360;
    const points=[window.start];
    for(let minute=Math.ceil(window.start/step)*step;minute<window.end;minute+=step){
      if(minute-window.start>=step*.5 && window.end-minute>=step*.5)points.push(minute);
    }
    points.push(window.end);return points;
  }
  return {series, segments, domain, slotAt, ticks};
})();
