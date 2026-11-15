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
