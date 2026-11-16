'use strict';

// Public snapshots contain only acoustic measurement summaries. Device addresses and controls stay on the collector.
const SoundAtlasLive = (() => {
  const ids = ['A', 'B', 'C', 'D', 'E', 'D1'];
  const periodFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const blankFrames = () => Array.from({ length: 48 }, () => ({ sound: {}, counts: {} }));

  function periodAt(time = Date.now()) {
    const [label, clock] = periodFormatter.format(new Date(time)).split(' ');
    const [hour, minute] = clock.split(':').map(Number);
    return { label, slot: hour * 2 + Math.floor(minute / 30) };
  }

  function timestamp(value) {
    if (typeof value !== 'string' || !value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }

  function soundValues(values) {
    return Object.fromEntries(ids.filter(id => typeof values?.[id] === 'number'
      && Number.isFinite(values[id]) && values[id] > 0 && values[id] <= 160).map(id => [id, values[id]]));
  }

  function normalizeSnapshot(value) {
    if (!value || value.version !== 1 || typeof value.connected !== 'boolean' || !Array.isArray(value.days)) {
      throw new Error('实时数据格式暂时不可用。');
    }
    const days = new Map();
    for (const day of value.days.slice(-31)) {
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.label) || !Array.isArray(day.frames) || day.frames.length !== 48) {
        throw new Error('实时数据的观测日期或时段不完整。');
      }
      const validDate = new Date(day.label + 'T00:00:00Z');
      if (!Number.isFinite(+validDate) || validDate.toISOString().slice(0, 10) !== day.label || days.has(day.label)) {
        throw new Error('实时数据的观测日期有误。');
      }
      days.set(day.label, {
        label: day.label,
        frames: day.frames.map(frame => ({
          sound: soundValues(frame?.sound),
          counts: Object.fromEntries(ids.filter(id => Number.isInteger(frame?.counts?.[id]) && frame.counts[id] > 0)
            .map(id => [id, frame.counts[id]])),
        })),
      });
    }
    const nodes = ids.map(id => {
      const node = Array.isArray(value.nodes) ? value.nodes.find(item => item?.id === id) : null;
      return { id, status: ['online', 'offline'].includes(node?.status) ? node.status : 'unknown', lastSeen: timestamp(node?.lastSeen) };
    });
    return {
      connected: value.connected, correctionApplied:value.correctionApplied===true,
      generatedAt: timestamp(value.generatedAt),
      receivedAt: timestamp(value.receivedAt),
      latestAt: timestamp(value.latest?.timestamp),
      days: [...days.values()].sort((a, b) => a.label.localeCompare(b.label)),
      nodes,
      plan: { state: ['none', 'waiting', 'recording', 'finished'].includes(value.plan?.state) ? value.plan.state : 'none' },
    };
  }

  function selectPeriod(snapshot, selection = {}, now = Date.now()) {
    const current = periodAt(now);
    const label = selection.follow !== false ? current.label : selection.label || current.label;
    const slot = selection.follow !== false ? current.slot : Math.max(0, Math.min(47, selection.slot ?? current.slot));
    const days = new Map((snapshot?.days ?? []).map(day => [day.label, day]));
    if (!days.has(current.label)) days.set(current.label, { label: current.label, frames: blankFrames() });
    // Preserve the user's chosen date without retaining readings removed by a later collector snapshot.
    if (!days.has(label)) days.set(label, { label, frames: blankFrames() });
    const sorted = [...days.values()].sort((a, b) => a.label.localeCompare(b.label));
    return { days: sorted, day: sorted.findIndex(day => day.label === label), slot, id: selection.id || 'A' };
  }

  function connectionState(snapshot, requestFailed = false, now = Date.now()) {
    if (requestFailed) return { status: 'error', label: '连接中断', detail: '正在自动重连，历史记录仍可查看。', fresh: false };
    if (!snapshot) return { status: 'connecting', label: '连接采集端', detail: '正在读取公桌与个人工位的观测。', fresh: false };
    const age = Math.max(...[snapshot.generatedAt, snapshot.receivedAt].map(value => value ? now - Date.parse(value) : Infinity));
    if (!snapshot.connected || age > 120000) {
      return { status: 'offline', label: snapshot.receivedAt ? '采集端离线' : '等待采集端', detail: '暂未收到新的观测，历史记录可沿时间轴查看。', fresh: false };
    }
    const online = snapshot.nodes.filter(node => node.status === 'online').length;
    if (!online) return { status: 'waiting', label: '等待测点', detail: '采集端已连接，测点暂未在线。', fresh: true };
    if (snapshot.plan.state === 'waiting') return { status: 'waiting', label: '等待采集开始', detail: online + ' / ' + ids.length + ' 个测点在线 · 按计划统一开始', fresh: true };
    if (snapshot.plan.state === 'none') return { status: 'waiting', label: '等待采集计划', detail: online + ' / ' + ids.length + ' 个测点在线 · 暂未开始记录', fresh: true };
    if (snapshot.plan.state === 'finished') return { status: 'idle', label: '采集已结束', detail: '历史观测可沿时间轴回放。', fresh: true };
    return { status: 'online', label: '实时同步', detail: online + ' / ' + ids.length + ' 个测点在线 · 每 10 秒更新', fresh: true };
  }

  function createPoller({ url = 'api/live', onSnapshot, onError, fetcher = fetch,
    visibility = typeof document === 'undefined' ? null : document,
    schedule = setTimeout, cancel = clearTimeout, interval = 10000, timeout = 12000 }) {
    let active = false;
    let timer = null;
    let request = null;
    let generation = 0;
    let failures = 0;
    const suspended = () => visibility?.hidden === true;
    const stopPending = () => {
      generation += 1;
      cancel(timer); timer = null;
      request?.abort(); request = null;
    };
    async function poll() {
      if (!active || suspended()) return;
      const ticket = ++generation;
      const controller = new AbortController();
      request = controller;
      let timedOut = false;
      const deadline = schedule(() => { timedOut = true; controller.abort(); }, timeout);
      try {
        const response = await fetcher(url, { cache: 'no-store', signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error('实时服务暂时不可用。');
        const payload = await response.json();
        if (!active || ticket !== generation || suspended()) return;
        const snapshot = normalizeSnapshot(payload);
        failures = 0;
        onSnapshot(snapshot);
      } catch (error) {
        if (!active || ticket !== generation || suspended()) return;
        if (error.name === 'AbortError' && !timedOut) return;
        failures += 1;
        onError(error);
      } finally {
        cancel(deadline);
        if (ticket === generation) {
          request = null;
          if (active && !suspended()) timer = schedule(poll, Math.min(60000, interval * 2 ** failures));
        }
      }
    }
    const onVisibility = () => {
      if (!active) return;
      stopPending();
      if (!suspended()) poll();
    };
    visibility?.addEventListener('visibilitychange', onVisibility);
    return {
      start() { stopPending(); active = true; failures = 0; poll(); },
      stop() { active = false; stopPending(); },
      refresh() { if (active) { stopPending(); failures = 0; poll(); } },
      dispose() { active = false; stopPending(); visibility?.removeEventListener('visibilitychange', onVisibility); },
    };
  }

  return { periodAt, normalizeSnapshot, selectPeriod, connectionState, createPoller };
})();
