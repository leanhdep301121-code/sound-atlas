export function secondsAgo(value, now = Date.now()) {
  const stamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(stamp) && stamp > 0 && stamp <= now + 5000 ? Math.max(0, (now - stamp) / 1000) : Infinity;
}
export function ageLabel(seconds) {
  if (!Number.isFinite(seconds)) return '尚无数据';
  if (seconds < 2) return '刚刚';
  if (seconds < 60) return Math.floor(seconds) + ' 秒前';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + Math.floor(seconds % 60) + ' 秒前';
  return Math.floor(seconds / 3600) + ' 小时前';
}
export function liveStation(state, node, now = Date.now()) {
  const ready = state?.readiness?.find(item => item.node === node) || {};
  const observation = state?.telemetry?.nodes?.find(item => item.node === node) || {};
  const sourceFresh = state?.connected === true && secondsAgo(state.receivedAt, now) <= 45;
  const telemetryFresh = secondsAgo(state?.telemetry?.generatedAt, now) <= 45;
  const online = sourceFresh && ready.online === true && secondsAgo(ready.lastSeen, now) <= 75;
  const age = secondsAgo(observation.timestamp, now);
  const valid = Number.isFinite(observation.laeq) && observation.laeq > 0 && observation.laeq <= 140;
  const fresh = online && telemetryFresh && valid && age <= 45 && ready.mic !== false;
  let status = '等待数据', tone = 'waiting';
  if (!sourceFresh) status = '采集端离线';
  else if (!online) status = ready.lastSeen ? '设备离线' : '等待连接';
  else if (ready.mic === false) { status = '麦克风异常'; tone = 'warning'; }
  else if (!telemetryFresh) { status = '同步延迟'; tone = 'warning'; }
  else if (fresh) { status = '数据正常'; tone = 'live'; }
  else if (valid) { status = '数据延迟'; tone = 'warning'; }
  else if (state.plan?.state !== 'recording') status = '等待采集';
  const history = (observation.history || []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && p[0] >= now - 300000 && p[0] <= now && Number.isFinite(p[1]) && p[1] > 0 && p[1] <= 140);
  return {ready,observation,sourceFresh,online,fresh,status,tone,age,history,value:fresh ? observation.laeq : null};
}
export function sparkPath(points, now = Date.now(), width = 400, height = 62) {
  let previous = null;
  return points.map(([stamp,level]) => {
    const x = Math.max(0, Math.min(width, (stamp - (now - 300000)) / 300000 * width));
    const y = height - Math.max(0, Math.min(1, (level - 30) / 60)) * height;
    const command = previous === null || stamp - previous > 10000 ? 'M' : 'L';
    previous = stamp;
    return command + x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
}
