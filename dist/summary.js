'use strict';
const SoundAtlasSummary = (() => {
  const valid = value => Number.isFinite(value) && value >= 0 && value <= 160;
  const countAt = (frame, id) => Number.isInteger(frame?.counts?.[id]) && frame.counts[id] >= 1 && frame.counts[id] <= 60 ? frame.counts[id] : null;
  function runs(slots) {
    const result = [];
    for (const slot of slots) {
      const last = result[result.length - 1];
      if (last && last.end === slot) last.end++;
      else result.push({start: slot, end: slot + 1});
    }
    return result;
  }
  function energyMean(levels) {
    if (!levels.length) return null;
    return 10 * Math.log10(levels.reduce((sum, value) => sum + 10 ** (value / 10), 0) / levels.length);
  }
  function analyze(frames, nodes, {demo = false} = {}) {
    const minuteFrames = frames.map(frame => frame.periodMinutes && frame.periodMinutes !== 1 ? {sound:{}} : frame);
    const available = (slot, id) => valid(minuteFrames[slot]?.sound?.[id]);
    const complete = (slot, id) => available(slot, id) && (demo || countAt(minuteFrames[slot], id) === 60);
    const activeSlots = minuteFrames.flatMap((_, slot) => nodes.some(node => available(slot, node.id)) ? [slot] : []);
    const scope = activeSlots.length ? {start:activeSlots[0], end:activeSlots[activeSlots.length-1]+1} : null;
    const common = minuteFrames.flatMap((_, slot) => nodes.length && nodes.every(node => complete(slot, node.id)) ? [slot] : []);
    const ranking = common.length ? nodes.map(node => ({node, value:energyMean(common.map(slot => minuteFrames[slot].sound[node.id]))})).sort((a,b)=>a.value-b.value) : [];
    // Compare individual complete minutes; partial minute samples never become a daily peak.
    const peaks = minuteFrames.flatMap((frame, slot) => {
      const records=nodes.filter(node=>complete(slot,node.id)).map(node=>({node,slot,value:frame.sound[node.id]}));
      records.sort((a,b)=>b.value-a.value);return records.length?[records[0]]:[];
    }).sort((a,b)=>b.value-a.value || a.slot-b.slot).slice(0,3);
    const coverage=nodes.map(node=>{
      const present=minuteFrames.flatMap((_,slot)=>available(slot,node.id)?[slot]:[]);
      const full=present.filter(slot=>complete(slot,node.id));
      const partial=present.filter(slot=>!complete(slot,node.id));
      const counts=present.map(slot=>countAt(minuteFrames[slot],node.id));
      const sampleSeconds=!demo && counts.length && counts.every(count=>count!==null)?counts.reduce((a,b)=>a+b,0):null;
      const gaps=scope?runs(Array.from({length:scope.end-scope.start},(_,i)=>i+scope.start).filter(slot=>!available(slot,node.id))):[];
      return {node,minutes:present.length,completeMinutes:full.length,partialMinutes:partial.length,sampleSeconds,
        coverage:scope?present.filter(slot=>slot>=scope.start&&slot<scope.end).length/(scope.end-scope.start):null,
        runs:runs(present),fullRuns:runs(full),partialRuns:runs(partial),gaps};
    });
    return {scope,common,ranking,peaks,coverage};
  }
  return {analyze,energyMean,runs};
})();
