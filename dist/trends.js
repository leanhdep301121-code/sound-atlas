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
  return {series, segments};
})();
