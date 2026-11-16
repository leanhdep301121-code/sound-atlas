'use strict';

const byId = id => document.getElementById(id);
const nodes = TABLES;
const initialLiveSource = SoundAtlasLive.selectPeriod(null);
const state = { ...initialLiveSource, demo: false, mode: 'live', layer: 'heatmap', table: 'A', highlighted: true };
const colors = name => getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
const mapButtons = new Map();
const pointReadings = new Map();
let playback = null;
let timelinePosition = null;
let miniChartKey = null;
let trendFocused = false;
let summaryKey = null;
let summarySignature = null;
const trendButtons = new Map();
const trendColor = id => colors('trend-' + OBSERVATION_NODES.findIndex(node => node.id === id));
const timelineRender = SoundAtlasMotion.createFrameQueue(() => render());
let readGeneration = 0;
let liveSnapshot = null;
let liveRequestFailed = false;
let followLive = true;
let livePoller = null;
const liveNodeLabels = new Map();
const syncTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

for (const node of OBSERVATION_NODES) {
  const item = document.createElement('span');
  item.className = 'live-node';
  const name = document.createElement('strong');
  name.textContent = node.name;
  const health = document.createElement('span');
  item.append(name, health);
  byId('live-nodes').append(item);
  liveNodeLabels.set(node.id, { item, health });
}

for (const node of nodes) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-point';
  const marker = document.createElement('span');
  marker.className = 'point-name';
  marker.textContent = node.marker;
  const pointValue = document.createElement('span');
  pointValue.className = 'point-value';
  pointReadings.set(node.id, pointValue);
  button.append(marker, pointValue);
  button.dataset.node = node.id;
  button.style.left = (node.x / FLOOR_PLAN.width * 100) + '%';
  button.style.top = (node.y / FLOOR_PLAN.height * 100) + '%';
  button.addEventListener('click', () => { selectNode(node.id); announce(); });
  byId('map-points').append(button);
  mapButtons.set(node.id, button);
}

function fillOptions(select, options) {
  select.replaceChildren(...options.map(([label, value]) => new Option(label, value)));
}
for (const node of OBSERVATION_NODES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'trend-node';
  const swatch = document.createElement('i'); swatch.setAttribute('aria-hidden', 'true');
  swatch.style.background = 'var(--trend-' + OBSERVATION_NODES.indexOf(node) + ')';
  const label = document.createElement('span'); label.textContent = node.device || node.marker;
  button.append(swatch, label);
  button.setAttribute('aria-label', '查看 ' + (node.device || node.marker) + ' 趋势');
  button.addEventListener('click', () => { selectNode(node.id); announce(); });
  byId('trend-legend').append(button); trendButtons.set(node.id, button);
}

const comparisonButtons = new Map();
for (const node of nodes) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'comparison-row';
  const name = document.createElement('span');
  const reading = document.createElement('span');
  name.textContent = node.name;
  button.append(name, reading);
  button.addEventListener('click', () => { selectNode(node.id); announce(); });
  byId('comparison-list').append(button);
  comparisonButtons.set(node.id, { button, reading });
}

function selectNode(id) {
  if (!OBSERVATION_NODES.some(node => node.id === id)) return;
  state.table = id;
  state.highlighted = true;
  render();
}

function prepareCanvas(canvas, width, height) {
  const scale = Math.min(devicePixelRatio || 1, 2.5, 4096 / Math.max(1, canvas.clientWidth), 4096 / Math.max(1, canvas.clientHeight));
  const dimensions = [Math.max(1, Math.round(canvas.clientWidth * scale)), Math.max(1, Math.round(canvas.clientHeight * scale))];
  if (canvas.width !== dimensions[0]) canvas.width = dimensions[0];
  if (canvas.height !== dimensions[1]) canvas.height = dimensions[1];
  const ctx = canvas.getContext('2d');
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function labelValue(node, frame) {
  const value = frame.sound[node.id];
  return value == null ? '无记录' : value.toFixed(1) + ' dB(A)';
}

function announce() {
  const node = OBSERVATION_NODES.find(point => point.id === state.table);
  byId('change-announcement').textContent = state.days[state.day].label + ' ' + clockLabel(state.slot) + '，' +
    node.name + '，' + labelValue(node, state.days[state.day].frames[state.slot]);
}

function renderSourceStatus() {
  const liveMode = state.mode === 'live';
  const connection = SoundAtlasLive.connectionState(liveSnapshot, liveRequestFailed);
  byId('live-connection').dataset.status = liveMode ? connection.status : state.mode;
  byId('live-state').textContent = liveMode ? connection.label : state.mode === 'demo' ? '演示数据' : '本地 CSV';
  byId('live-detail').textContent = liveMode ? connection.detail : state.mode === 'demo'
    ? '用于查看界面效果，不代表现场观测。' : '当前显示导入文件，未写入采集端。';
  byId('live-updated').textContent = liveMode
    ? liveSnapshot?.receivedAt ? '最近同步 ' + syncTime.format(new Date(liveSnapshot.receivedAt)) : '尚未同步'
    : '';
  if(liveMode&&liveSnapshot?.correctionApplied)byId('live-detail').textContent+=' · 记录按生效时间使用相对校正';
  byId('return-live').hidden = liveMode && followLive;
  byId('refresh-live').hidden = !liveMode;
  byId('live-nodes').hidden = !liveMode;
  for (const node of OBSERVATION_NODES) {
    const record = liveSnapshot?.nodes.find(item => item.id === node.id);
    const health = connection.fresh ? record?.status ?? 'unknown' : 'unknown';
    const elements = liveNodeLabels.get(node.id);
    elements.item.dataset.status = health;
    elements.health.textContent = health === 'online' ? '在线' : health === 'offline' ? '离线' : record?.lastSeen ? '未更新' : '待连接';
    elements.item.title = record?.lastSeen ? node.name + ' 最近通信 ' + syncTime.format(new Date(record.lastSeen)) : node.name + ' 尚无通信记录';
  }
  byId('data-badge').textContent = liveMode
    ? !liveSnapshot ? '等待实测' : followLive ? connection.fresh ? '实时观测' : '实测记录' : '历史回放'
    : state.mode === 'demo' ? '演示数据' : 'CSV 数据';
  return connection;
}

function applyLiveSnapshot(snapshot) {
  if (state.mode !== 'live') return;
  const source = SoundAtlasLive.selectPeriod(snapshot, {
    label: state.days[state.day]?.label, slot: state.slot, follow: followLive, id: state.table,
  });
  Object.assign(state, { days: source.days, day: source.day, slot: source.slot });
  if(followLive)timelinePosition=null;
  fillOptions(byId('day'), state.days.map(({ label }, index) => [label, index]));
  render();
}

function stopFollowingLive() {
  if (state.mode === 'live') followLive = false;
}

function returnToLive() {
  readGeneration += 1;
  setPlayback(false);
  state.mode = 'live'; state.demo = false;
  followLive = true;
  liveRequestFailed = false;
  applyLiveSnapshot(liveSnapshot);
  livePoller.start();
  if (dialog.open) dialog.close();
}

function updateTimelineDisplay(){
  const cursor=SoundAtlasMotion.timelineAt(timelinePosition??state.slot);
  byId('time-slider').value=String(cursor.position);
  byId('time-slider').setAttribute('aria-valuetext',cursor.label+'，显示 '+clockLabel(state.slot)+' 开始的观测');
  byId('time-output').textContent=cursor.label;
}

function render() {
  const date = state.days[state.day];
  const frame = date.frames[state.slot];
  const selected = OBSERVATION_NODES.find(node => node.id === state.table);
  const sound = frame.sound[selected.id];
  const connection = renderSourceStatus();
  byId('day').value = String(state.day);
  updateTimelineDisplay();

  const periodMinutes = frame.periodMinutes || 1;
  const periodStart = Math.floor(state.slot / periodMinutes) * periodMinutes;
  byId('period-label').textContent = clockLabel(periodStart) + ' 至 ' + clockLabel(periodStart + periodMinutes);
  byId('inspection-heading').textContent = selected.name;
  byId('node-marker').textContent = selected.marker;
  byId('node-location').textContent = selected.location;
  byId('node-id').textContent = '当前设备 ' + (selected.device || selected.id) + ' · 历史读数按当时位置回放';
  byId('node-value').textContent = sound?.toFixed(1) ?? '-';
  byId('node-unit').textContent = 'dB(A)';
  byId('node-metric').textContent = (periodMinutes === 30 ? '半小时' : '1 分钟') + (state.mode === 'live' && followLive ? '累计等效 A 计权声级' : '等效 A 计权声级');
  const selectedHealth = liveSnapshot?.nodes.find(node => node.id === selected.id);
  byId('node-detail').textContent = sound == null ? '这一时段暂无有效观测。'
    : state.mode === 'live' && followLive && (!connection.fresh || selectedHealth?.status !== 'online')
      ? '当前显示已保存观测，测点暂未在线。'
      : state.mode === 'live' && frame.counts?.[selected.id] ? frame.counts[selected.id].toLocaleString('zh-CN') + ' 个有效样本' : '';
  byId('comparison-heading').textContent = '同一时段的测点';
  const measured = TABLES.filter(node => node.kind !== 'personal' && frame.sound[node.id] != null);
  const lowest = measured.reduce((quietest, node) =>
    !quietest || frame.sound[node.id] < frame.sound[quietest.id] ? node : quietest, null);
  byId('inspection-foot').textContent = measured.length > 1
    ? '当前时段 ' + lowest.name + ' 的声级最低，选位前请确认现场有无空位。' : '可比较的公桌读数不足。';
  for (const node of nodes) {
    const mapButton = mapButtons.get(node.id);
    const value = labelValue(node, frame);
    mapButton.setAttribute('aria-label', node.name + '，' + value);
    mapButton.title = node.name + ' / ' + value;
    mapButton.setAttribute('aria-pressed', state.highlighted && node.id === selected.id);
    pointReadings.get(node.id).textContent = value.replace(' dB(A)', '');
    const row = comparisonButtons.get(node.id);
    row.button.setAttribute('aria-pressed', state.highlighted && node.id === selected.id);
    row.reading.textContent = value;
  }
  byId('chart-table-name').textContent = OBSERVATION_NODES.find(node => node.id === state.table).name;
  drawHeatmap(frame);
  updateSpatialView(frame, selected.id);
  drawCharts(date.frames);
  drawMiniCharts(date.frames, selected);
  renderDailySummary(date);
}

function drawMiniCharts(frames, selected) {
  const spark = byId('node-spark');
  const wave = byId('timeline-wave');
  const width = spark.clientWidth;
  const height = spark.clientHeight;
  const waveWidth = wave.clientWidth;
  const key = [frames, selected.id, width, height, waveWidth, colors('accent'), colors('strong-line')];
  if (miniChartKey && key.every((value, index) => value === miniChartKey[index])) return;
  miniChartKey = key;
  const values = frames.map(frame => frame.sound[selected.id]);
  const present = values.filter(value => value != null);
  const low = present.length ? Math.min(...present) : 0;
  const high = present.length ? Math.max(low + 1, ...present) : 1;

  // The inspection sparkline is hidden in fullscreen; the timeline must still redraw.
  if (waveWidth > 0) {
    const waveCtx = prepareCanvas(wave, waveWidth, 40);
    waveCtx.fillStyle = colors('strong-line');
    values.forEach((value, slot) => {
      if (value == null) return;
      const barHeight = 3 + (value - low) / (high - low) * 30;
      waveCtx.fillRect(slot / SLOTS * waveWidth, 37 - barHeight, Math.max(.5, waveWidth / SLOTS), barHeight);
    });
  }
  spark.setAttribute('aria-label', selected.name + '当日变化，' + present.length + '个时段有记录');
  if (width < 1 || height < 1) return;
  const ctx = prepareCanvas(spark, width, height);
  ctx.strokeStyle = colors('accent');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let connected = false;
  values.forEach((value, slot) => {
    if (value == null) { connected = false; return; }
    const x = slot / (SLOTS - 1) * (width - 4) + 2;
    const y = height - 4 - (value - low) / (high - low) * (height - 8);
    if (connected) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    connected = true;
  });
  ctx.stroke();
}

function chartArea(canvas) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  return { width, height, left: 39, right: width - 18, top: 9, bottom: height - 25 };
}

function drawChart(canvas, series) {
  const {width, height, left, right, top, bottom} = chartArea(canvas);
  if (width < 80 || height < 40) return;
  const ctx = prepareCanvas(canvas, width, height);
  const observations = series.flatMap(line => line.values.filter(value => value != null));
  const min = observations.length ? Math.min(30, Math.floor(Math.min(...observations) / 10) * 10) : 30;
  const max = observations.length ? Math.max(60, Math.ceil(Math.max(...observations) / 10) * 10) : 60;
  const x = slot => left + slot * (right - left) / (SLOTS - 1);
  const y = value => bottom - (value - min) * (bottom - top) / (max - min);
  ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let index = 0; index <= 3; index++) {
    const value = min + (max - min) * index / 3;
    ctx.strokeStyle = colors('line'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    ctx.fillStyle = colors('muted'); ctx.fillText(Math.round(value), left - 8, y(value));
  }
  if (!observations.length) {
    ctx.textAlign = 'center'; ctx.font = '12px system-ui';
    ctx.fillText('当天暂无记录', width / 2, (top + bottom) / 2);
  }
  ctx.textAlign = 'center'; ctx.fillStyle = colors('muted');
  for (const slot of [0, 360, 720, 1080, 1439]) ctx.fillText(clockLabel(slot), x(slot), bottom + 13);
  // Draw the selected series last so it remains readable where curves overlap.
  for (const line of [...series].sort((a, b) => Number(a.selected) - Number(b.selected))) {
    ctx.strokeStyle = trendColor(line.node.id); ctx.fillStyle = trendColor(line.node.id);
    ctx.lineWidth = line.selected ? 2.2 : 1.2; ctx.globalAlpha = line.selected ? 1 : .65;
    for (const segment of SoundAtlasTrends.segments(line.values)) {
      ctx.beginPath();
      segment.forEach(({slot, value}, index) => index ? ctx.lineTo(x(slot), y(value)) : ctx.moveTo(x(slot), y(value)));
      ctx.stroke();
      if (segment.length === 1) { ctx.beginPath(); ctx.arc(x(segment[0].slot), y(segment[0].value), 2, 0, Math.PI * 2); ctx.fill(); }
    }
    const current = line.values[state.slot];
    if (current != null) { ctx.beginPath(); ctx.arc(x(state.slot), y(current), line.selected ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalAlpha = 1; ctx.strokeStyle = colors('muted'); ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x(state.slot), top); ctx.lineTo(x(state.slot), bottom); ctx.stroke(); ctx.setLineDash([]);
}

function trendReadout(slot = state.slot) {
  const frame = state.days[state.day].frames[slot];
  byId('trend-readout').textContent = clockLabel(slot) + ' · ' + OBSERVATION_NODES
    .filter(node => !trendFocused || node.id === state.table)
    .map(node => (node.device || node.marker) + ' ' + (frame.sound[node.id]?.toFixed(1) ?? '—')).join(' / ') + ' dB(A)';
}
function drawCharts(frames) {
  const series = SoundAtlasTrends.series(frames, OBSERVATION_NODES, state.table, trendFocused);
  const selected = OBSERVATION_NODES.find(node => node.id === state.table);
  const chart = byId('sound-chart');
  chart.setAttribute('aria-label', (trendFocused ? selected.name : '六个测点') + '当日声级趋势，当前时间 ' + clockLabel(state.slot));
  byId('chart-table-name').textContent = '当前测点 ' + selected.name;
  byId('trend-date').textContent = state.days[state.day].label;
  for (const [id, button] of trendButtons) {
    button.setAttribute('aria-pressed', id === state.table);
    button.classList.toggle('is-muted', trendFocused && id !== state.table);
  }
  trendReadout(); drawChart(chart, series);
}

function renderDailySummary(date) {
  if (summaryKey?.frames === date.frames && summaryKey.mode === state.mode && summaryKey.label === date.label) return;
  summaryKey = {frames:date.frames, mode:state.mode, label:date.label};
  const demo = state.mode === 'demo';
  const result = SoundAtlasSummary.analyze(date.frames, OBSERVATION_NODES, {demo});
  const signature = JSON.stringify([date.label, state.mode, result]);
  if (signature === summarySignature) return;
  summarySignature = signature;
  const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if(className) element.className = className; return element; };
  const device = node => node.device || node.marker;
  const duration = seconds => {
    if (seconds == null) return '样本时长未知';
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
    return (hours ? hours + '小时' : '') + (minutes ? minutes + '分' : '') + (rest || !hours && !minutes ? rest + '秒' : '');
  };
  const range = interval => clockLabel(interval.start) + '–' + clockLabel(interval.end);
  const jump = (slot, id, label) => {
    const button = text('button', label); button.type = 'button';
    button.addEventListener('click', () => {
      stopFollowingLive(); setPlayback(false); timelineRender.cancel(); timelinePosition = null;
      state.slot = slot; selectNode(id); announce();
      byId('observatory').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
      byId('map-viewport').focus({preventScroll:true});
    });
    return button;
  };
  byId('summary-date').textContent = date.label;
  byId('summary-source').textContent = demo ? '演示数据 · 非现场观测' : state.mode === 'csv' ? '本地 CSV · 当前载入范围' : '实测摘要 · 当前载入范围';
  byId('summary-common').textContent = demo ? result.common.length + ' 个共同演示分钟，仅作界面预览。' : result.common.length + ' 个共同完整分钟；点击测点查看最近共同分钟。';
  if (result.ranking.length) {
    const first = result.ranking[0], last = result.ranking[result.ranking.length-1];
    const tied = result.ranking.filter(row => Math.abs(row.value-first.value)<.05).map(row=>device(row.node));
    byId('summary-insight').textContent = (demo ? '演示结果：' : '') + '在 ' + result.common.length + ' 个共同' + (demo?'':'完整') + '分钟内，' + tied.join('、') + ' 的等效声级最低（' + first.value.toFixed(1) + ' dB(A)），与最高测点相差 ' + (last.value-first.value).toFixed(1) + ' dB。';
  } else {
    byId('summary-insight').textContent = result.scope ? '暂不做声级排名：还没有六个测点共同完整记录的分钟。可先查看下方各点的记录覆盖情况。' : '这一天暂未载入有效记录，声级排行和较吵时段保持空白。';
  }
  const ranking = byId('summary-ranking'); ranking.replaceChildren();
  result.ranking.forEach((row, index) => {
    const li = document.createElement('li');
    const button = jump(result.common[result.common.length-1], row.node.id, '');
    button.setAttribute('aria-label','查看 '+device(row.node)+' 的共同观测时段');
    button.append(text('span',String(index+1),'summary-rank'),text('strong',device(row.node)),text('span',row.node.kind==='personal'?'个人工位':'公桌','summary-node-kind'),text('span',row.value.toFixed(1),'summary-level'),text('small','dB(A)'));
    li.append(button); ranking.append(li);
  });
  if(!result.ranking.length)ranking.append(text('li','等待共同完整分钟，缺测不会被算作低声级。','summary-empty'));
  const peaks=byId('summary-peaks');peaks.replaceChildren();
  result.peaks.forEach(row=>{
    const li=document.createElement('li'),button=jump(row.slot,row.node.id,'');
    button.setAttribute('aria-label','回放 '+clockLabel(row.slot)+' '+device(row.node));
    button.append(text('strong',clockLabel(row.slot)+'–'+clockLabel(row.slot+1)),text('span',device(row.node),'summary-peak-node'),text('span',row.value.toFixed(1),'summary-level'),text('small','dB(A)'),text('span','↗','summary-jump'));
    li.append(button);peaks.append(li);
  });
  if(!result.peaks.length)peaks.append(text('li','暂无完整一分钟记录，暂不列出较吵时段。','summary-empty'));
  byId('summary-window').textContent = result.scope ? '记录窗口 '+range(result.scope) : '暂无观测窗口';
  const coverage=byId('summary-coverage');
  const expandedNodes = new Set([...coverage.querySelectorAll('details[open]')].map(details => details.dataset.node));
  coverage.replaceChildren();
  result.coverage.forEach(row=>{
    const container=document.createElement('div');container.className='coverage-row';
    const identity=document.createElement('div');identity.className='coverage-identity';
    identity.append(text('strong',device(row.node)),text('small',demo?'演示分钟':row.sampleSeconds==null?(row.minutes?'有记录 '+row.minutes+' 分钟 · 样本数未知':'尚无记录'):'有效样本 '+duration(row.sampleSeconds)));
    const plot=document.createElement('div');plot.className='coverage-plot';
    const bar=document.createElement('div');bar.className='coverage-track';bar.setAttribute('role','img');
    bar.setAttribute('aria-label',device(row.node)+'：'+row.completeMinutes+' 个完整分钟，'+row.partialMinutes+' 个不完整分钟，窗口内 '+row.gaps.length+' 段无记录');
    const addRange=(interval,className)=>{const span=document.createElement('span');span.className=className;span.style.left=(interval.start/1440*100)+'%';span.style.width=((interval.end-interval.start)/1440*100)+'%';span.title=range(interval);bar.append(span);};
    if(result.scope)addRange(result.scope,'coverage-gap');
    row.fullRuns.forEach(interval=>addRange(interval,'coverage-full'));
    row.partialRuns.forEach(interval=>addRange(interval,'coverage-partial'));
    const ticks=document.createElement('div');ticks.className='coverage-ticks';['00:00','06:00','12:00','18:00','24:00'].forEach(t=>ticks.append(text('span',t)));
    plot.append(bar,ticks);
    const stats=document.createElement('div');stats.className='coverage-stats';
    stats.append(text('strong',row.coverage==null?'—':(row.coverage*100).toFixed(1)+'%'),text('small','分钟覆盖率'));
    container.append(identity,plot,stats);
    if(row.gaps.length || row.partialMinutes){
      const details=document.createElement('details');details.className='coverage-details';details.dataset.node=row.node.id;details.open=expandedNodes.has(row.node.id);
      details.append(text('summary','窗口内 '+row.gaps.length+' 段无记录 · '+row.partialMinutes+' 个不完整分钟'));
      const list=document.createElement('div');list.className='coverage-gap-list';
      row.gaps.forEach(interval=>list.append(jump(interval.start,row.node.id,range(interval)+' 无记录')));
      row.partialRuns.forEach(interval=>list.append(jump(interval.start,row.node.id,range(interval)+' 不完整')));
      details.append(list);container.append(details);
    }
    coverage.append(container);
  });
}

function setPlayback(playing) {
  if(playback!==null)cancelAnimationFrame(playback);
  playback=null;
  if(playing){
    let last=null,position=timelinePosition??state.slot;
    const tick=now=>{
      if(playback===null)return;
      if(document.hidden){setPlayback(false);return;}
      if(last!==null)position+=Math.min(100,now-last)/240;
      last=now;
      let dayChanged=false;
      if(position>=SLOTS){
        if(state.day>=state.days.length-1){timelinePosition=SLOTS-1;setPlayback(false);render();return;}
        state.day++;position=0;dayChanged=true;
      }
      const cursor=SoundAtlasMotion.timelineAt(position),changed=cursor.slot!==state.slot;
      timelinePosition=cursor.position;state.slot=cursor.slot;
      if(changed||dayChanged)render();else updateTimelineDisplay();
      playback=requestAnimationFrame(tick);
    };
    playback=requestAnimationFrame(tick);
  }
  byId('play-text').textContent=playing?'暂停':'播放';
  byId('play-symbol').textContent=playing?'Ⅱ':'▶';
  byId('play').setAttribute('aria-label',playing?'暂停时间回放':'播放时间回放');
}

function setSource(source, mode) {
  setPlayback(false);timelinePosition=null;timelineRender.cancel();
  if (mode !== 'live') livePoller?.stop();
  Object.assign(state, { days: source.days, day: source.day, slot: source.slot, mode, demo: mode === 'demo' });
  fillOptions(byId('day'), state.days.map(({ label }, index) => [label, index]));
  selectNode(source.id);
  announce();
}

byId('heatmap-opacity').addEventListener('input', event => {
  byId('heatmap-opacity-value').textContent = event.target.value + '%';
  drawHeatmap(state.days[state.day].frames[state.slot]);
  updateSpatialView(state.days[state.day].frames[state.slot], state.table);
});
byId('trend-focus').addEventListener('click', () => {
  trendFocused = !trendFocused;
  byId('trend-focus').setAttribute('aria-pressed', trendFocused);
  byId('trend-focus').textContent = trendFocused ? '显示全部测点' : '只看所选';
  drawCharts(state.days[state.day].frames);
});
byId('trends').addEventListener('toggle', () => { if (byId('trends').open) timelineRender.request(); });
byId('day').addEventListener('change', event => {
  stopFollowingLive(); setPlayback(false); state.day = Number(event.target.value); timelinePosition=null;timelineRender.cancel();render(); announce();
});
byId('time-slider').addEventListener('input', event => {
  const wasFollowing=followLive;stopFollowingLive();setPlayback(false);
  const cursor=SoundAtlasMotion.timelineAt(Number(event.target.value));
  timelinePosition=cursor.position;
  const changed=state.slot!==cursor.slot;state.slot=cursor.slot;updateTimelineDisplay();
  if(changed||wasFollowing)timelineRender.request();
});
byId('time-slider').addEventListener('change',()=>{timelineRender.flush();announce();});
byId('time-slider').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();stopFollowingLive();setPlayback(false);
  const next=event.key==='Home'?0:event.key==='End'?SLOTS-1:state.slot+(['ArrowRight','ArrowUp'].includes(event.key)?1:-1);
  const cursor=SoundAtlasMotion.timelineAt(next);state.slot=cursor.slot;timelinePosition=cursor.position;updateTimelineDisplay();timelineRender.request();
});
byId('time-slider').addEventListener('keyup',()=>{timelineRender.flush();announce();});
byId('play').addEventListener('click', () => {
  if (playback) { setPlayback(false); announce(); return; }
  stopFollowingLive();
  if (state.day === state.days.length - 1 && state.slot === SLOTS - 1) { state.day = 0; state.slot = 0; timelinePosition=null; render(); }
  setPlayback(true);
});
{
  const chart = byId('sound-chart');
  chart.addEventListener('pointermove', event => {
    const {left, right} = chartArea(chart);
    const offset = event.clientX - chart.getBoundingClientRect().left;
    trendReadout(Math.max(0, Math.min(SLOTS - 1, Math.round((offset - left) * (SLOTS - 1) / (right - left)))));
  });
  chart.addEventListener('pointerleave', () => trendReadout());
  chart.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); stopFollowingLive(); setPlayback(false); timelineRender.cancel(); timelinePosition = null;
    state.slot = event.key === 'Home' ? 0 : event.key === 'End' ? SLOTS - 1 : Math.max(0, Math.min(SLOTS - 1, state.slot + (event.key === 'ArrowRight' ? 1 : -1)));
    render(); announce();
  });
  chart.addEventListener('click', event => {
    stopFollowingLive();
    const { left, right } = chartArea(chart);
    const offset = event.clientX - chart.getBoundingClientRect().left;
    state.slot = Math.max(0, Math.min(SLOTS - 1, Math.round((offset - left) * (SLOTS - 1) / (right - left))));
    setPlayback(false); timelinePosition=null;timelineRender.cancel();render(); announce();
  });
}

const dialog = byId('data-dialog');
const input = byId('file-input');
const status = byId('import-status');
byId('open-data').addEventListener('click', () => { setPlayback(false); dialog.showModal(); });
dialog.addEventListener('close', () => { readGeneration += 1; input.value = ''; });
input.addEventListener('change', async () => {
  const file = input.files[0];
  if (!file) return;
  const generation = ++readGeneration;
  status.dataset.error = 'false';
  status.textContent = '正在读取文件…';
  try {
    const csv = await file.text();
    if (generation !== readGeneration) return;
    const source = parseObservation(csv);
    setSource(source, 'csv');
    status.textContent = '已导入 ' + source.days.length + ' 天的观测记录。关闭窗口即可查看。';
  } catch (error) {
    if (generation !== readGeneration) return;
    status.dataset.error = 'true';
    status.textContent = error.message || '文件读取失败，请重新选择 CSV。';
  } finally {
    if (generation === readGeneration) input.value = '';
  }
});
byId('restore-demo').addEventListener('click', () => {
  readGeneration += 1;
  input.value = '';
  setSource({ days: createDemo(), day: 0, slot: INITIAL_SLOT, id: 'A' }, 'demo');
  status.dataset.error = 'false';
  status.textContent = '已切回演示数据。';
});
byId('return-live').addEventListener('click', returnToLive);
byId('use-live').addEventListener('click', returnToLive);
byId('refresh-live').addEventListener('click', () => { liveRequestFailed = false; render(); livePoller.refresh(); });
byId('download-template').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'sound-atlas-template.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const mapViewport = byId('map-viewport');
const planElement = byId('plan');
const mapPlacement = document.querySelector('.map-placement');
const workspace = byId('spatial-workspace');
let mapZoom = 1;
let mapView = 'spatial';
let followWorkArea = false;
let spatialViewer = null;
let spatialLoad = null;
let spatialNorthAngle = null;
setHeatmapPaintListener((canvas,version)=>{
  if(mapView==='spatial'&&state.layer==='heatmap')spatialViewer?.updateHeatmap(canvas,version,Number(byId('heatmap-opacity').value)/100);
});

function updateCompass(angle = spatialNorthAngle) {
  const compass = byId('map-compass');
  const bearing = FLOOR_ORIENTATION.northBearingDegrees;
  const resolved = mapView === 'plan' ? bearing : angle;
  compass.hidden = !Number.isFinite(bearing) || !Number.isFinite(resolved);
  if (compass.hidden) return;
  compass.style.setProperty('--north-angle', resolved + 'deg');
  compass.setAttribute('aria-label', mapView === 'spatial' ? '指北针，随当前空间视角同步指示北向' : '指北针，北向相对图纸上方顺时针 ' + bearing + ' 度');
}

function updateSpatialView(frame, selectedId) {
  if (!spatialViewer || mapView !== 'spatial') return;
  spatialViewer.update({
    frame,
    selectedId: state.highlighted ? selectedId : null,
    layer: state.layer,
    heatmapCanvas: heatmapRaster,
    heatmapVersion: heatmapRevision,
    heatmapOpacity: Number(byId('heatmap-opacity').value) / 100,
  });
}

function loadSpatialView() {
  if (spatialViewer) return spatialLoad;
  if (spatialLoad) {
    byId('spatial-loading').hidden = mapView !== 'spatial';
    return spatialLoad;
  }
  byId('spatial-loading').hidden = false;
  byId('spatial-error').hidden = true;
  spatialLoad = import('./spatial-view.js?v=mesh-binary')
    .then(module => module.createSpatialView({
      container: byId('spatial-scene'),
      nodes: nodes.map(node => ({ ...node, isGate: false })),
      onSelect: id => { selectNode(id); announce(); },
      onStatus: message => { if (mapView === 'spatial') byId('map-feedback').textContent = message; },
      northBearingDegrees: FLOOR_ORIENTATION.northBearingDegrees,
      onCompassChange: angle => { spatialNorthAngle = angle; updateCompass(); },
    }))
    .then(viewer => {
      spatialViewer = viewer;
      viewer.setVisible(mapView === 'spatial');
      render();
    })
    .catch(error => {
      spatialLoad = null;
      byId('spatial-error-text').textContent = error.message || '三维空间加载失败，请重试。';
      byId('spatial-error').hidden = mapView !== 'spatial';
    })
    .finally(() => { byId('spatial-loading').hidden = true; });
  return spatialLoad;
}
byId('spatial-retry').addEventListener('click', loadSpatialView);

function mapBaseWidth() {
  const width = Math.max(120, mapViewport.clientWidth - 40);
  const height = Math.max(120, mapViewport.clientHeight - 40);
  return Math.min(width, height * FLOOR_PLAN.width / FLOOR_PLAN.height);
}

function mapCenter() {
  return {
    x: (mapViewport.scrollLeft + mapViewport.clientWidth / 2 - planElement.offsetLeft) / planElement.clientWidth,
    y: (mapViewport.scrollTop + mapViewport.clientHeight / 2 - planElement.offsetTop) / planElement.clientHeight,
  };
}

function layoutMap(center = { x: .5, y: .5 }) {
  const width = mapBaseWidth() * mapZoom;
  const height = width * FLOOR_PLAN.height / FLOOR_PLAN.width;
  planElement.style.width = width + 'px';
  mapPlacement.style.width = Math.max(mapViewport.clientWidth, width + 40) + 'px';
  mapPlacement.style.height = Math.max(mapViewport.clientHeight, height + 40) + 'px';
  mapViewport.scrollLeft = planElement.offsetLeft + center.x * width - mapViewport.clientWidth / 2;
  mapViewport.scrollTop = planElement.offsetTop + center.y * height - mapViewport.clientHeight / 2;
  mapViewport.classList.toggle('is-zoomed', mapZoom > 1 && mapView === 'plan');
  byId('zoom-out').disabled = mapZoom <= 1;
  byId('zoom-in').disabled = mapZoom >= 4;
  byId('zoom-level').textContent = Math.round(mapZoom * 100) + '%';
}

function focusWorkArea() {
  if (mapView !== 'plan') setMapView('plan');
  followWorkArea = true;
  const baseWidth = mapBaseWidth();
  // The envelope includes both work areas, the corridor and the rest alcoves.
  mapZoom = Math.max(1, Math.min(4,
    (mapViewport.clientWidth - 40) / (.410 * baseWidth),
    (mapViewport.clientHeight - 40) / (.315 * baseWidth)));
  layoutMap({ x: .445, y: 267.5 / FLOOR_PLAN.height });
  render();
}

function zoomMap(nextZoom) {
  if (mapView === 'spatial') setMapView('plan');
  const center = mapCenter();
  followWorkArea = false;
  mapZoom = Math.max(1, Math.min(4, nextZoom));
  layoutMap(mapZoom === 1 ? { x: .5, y: .5 } : center);
  render();
}
byId('zoom-in').addEventListener('click', () => mapView === 'spatial' ? spatialViewer?.zoomBy(1.2) : zoomMap(mapZoom + .25));
byId('zoom-out').addEventListener('click', () => mapView === 'spatial' ? spatialViewer?.zoomBy(1 / 1.2) : zoomMap(mapZoom - .25));
byId('zoom-reset').addEventListener('click', () => mapView === 'spatial' ? spatialViewer?.reset() : zoomMap(1));
byId('zoom-focus').addEventListener('click', () => mapView === 'spatial' ? spatialViewer?.focusWorkArea() : focusWorkArea());

function setMapView(view) {
  mapView = view;
  updateCompass();
  workspace.dataset.view = view;
  byId('view-spatial').setAttribute('aria-pressed', view === 'spatial');
  byId('view-plan').setAttribute('aria-pressed', view === 'plan');
  byId('spatial-scene').hidden = view !== 'spatial';
  byId('spatial-assumptions').hidden = view !== 'spatial';
  byId('spatial-error').hidden = true;
  byId('spatial-loading').hidden = true;
  byId('map-caption-title').textContent = view === 'spatial' ? '2F / 三维空间' : '2F / 平面图';
  mapViewport.setAttribute('aria-label', view === 'spatial'
    ? '二层三维空间，可旋转、缩放和平移'
    : '二层原始平面，可放大、拖动或点选测点');
  mapZoom = 1;
  followWorkArea = false;
  if (view === 'spatial') {
    byId('zoom-out').disabled = false;
    byId('zoom-in').disabled = false;
    byId('map-feedback').textContent = '拖动旋转，滚轮缩放，右键平移';
    if (spatialViewer) { spatialViewer.setVisible(true); spatialViewer.resize(); }
    else loadSpatialView();
  } else {
    spatialViewer?.setVisible(false);
    byId('map-feedback').textContent = '放大后可拖动平面';
    layoutMap();
  }
  render();
}
byId('view-spatial').addEventListener('click', () => setMapView('spatial'));
byId('view-plan').addEventListener('click', () => setMapView('plan'));

// A blank tap clears the highlight. Panning, orbiting and pinch gestures do not.
let blankTap = null;
const interactiveMapTarget = target => target.closest('button,a,input,select,textarea,[role="button"]');
mapViewport.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0 || interactiveMapTarget(event.target)) { blankTap = null; return; }
  blankTap = { id:event.pointerId, x:event.clientX, y:event.clientY, moved:false };
}, true);
mapViewport.addEventListener('pointermove', event => {
  if (blankTap?.id === event.pointerId && Math.hypot(event.clientX-blankTap.x,event.clientY-blankTap.y)>6) blankTap.moved=true;
}, true);
mapViewport.addEventListener('pointerup', event => {
  const tap=blankTap;blankTap=null;
  if (!tap || tap.id!==event.pointerId || tap.moved || Math.hypot(event.clientX-tap.x,event.clientY-tap.y)>6 || interactiveMapTarget(event.target)) return;
  if (state.highlighted) {
    state.highlighted=false;
    render();
    byId('change-announcement').textContent='已取消测点高亮。再次点击测点可重新选中。';
  }
}, true);
mapViewport.addEventListener('pointercancel',()=>{blankTap=null;},true);
mapViewport.addEventListener('lostpointercapture',()=>{blankTap=null;},true);

let mapDrag = null;
mapViewport.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch' || event.button !== 0 || mapView !== 'plan' || mapZoom <= 1 || event.target.closest('button')) return;
  followWorkArea = false;
  mapDrag = { x: event.clientX, y: event.clientY, left: mapViewport.scrollLeft, top: mapViewport.scrollTop };
  mapViewport.setPointerCapture(event.pointerId);
  mapViewport.classList.add('is-dragging');
  event.preventDefault();
});
mapViewport.addEventListener('pointermove', event => {
  if (!mapDrag) return;
  mapViewport.scrollLeft = mapDrag.left - (event.clientX - mapDrag.x);
  mapViewport.scrollTop = mapDrag.top - (event.clientY - mapDrag.y);
});
function stopMapDrag() {
  mapDrag = null;
  mapViewport.classList.remove('is-dragging');
}
mapViewport.addEventListener('pointerup', stopMapDrag);
mapViewport.addEventListener('pointercancel', stopMapDrag);
mapViewport.addEventListener('lostpointercapture', stopMapDrag);

const workspaceAnchor = document.createComment('Sound Atlas workspace');
workspace.before(workspaceAnchor);
const largeMapDialog = document.createElement('dialog');
largeMapDialog.className = 'map-large-dialog';
largeMapDialog.setAttribute('aria-label', '二层声环境大图');
document.body.append(largeMapDialog);
byId('map-fullscreen').addEventListener('click', () => {
  if (largeMapDialog.open) {
    largeMapDialog.close();
    return;
  }
  largeMapDialog.append(workspace);
  workspace.classList.add('is-expanded');
  byId('map-fullscreen').textContent = '退出大图';
  byId('map-fullscreen').setAttribute('aria-pressed', 'true');
  largeMapDialog.showModal();
});
largeMapDialog.addEventListener('close', () => {
  workspaceAnchor.after(workspace);
  workspace.classList.remove('is-expanded');
  byId('map-fullscreen').textContent = '全屏';
  byId('map-fullscreen').setAttribute('aria-pressed', 'false');
  byId('map-fullscreen').focus({ preventScroll: true });
});
byId('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sound-atlas-theme', next); } catch { /* Theme remains available in memory. */ }
  render();
});
setSource(initialLiveSource, 'live');
setMapView('spatial');
livePoller = SoundAtlasLive.createPoller({
  url: new URL('api/live', document.baseURI).href,
  onSnapshot(snapshot) {
    if (state.mode !== 'live') return;
    liveSnapshot = snapshot;
    liveRequestFailed = false;
    applyLiveSnapshot(snapshot);
  },
  onError() {
    if (state.mode !== 'live') return;
    liveRequestFailed = true;
    applyLiveSnapshot(liveSnapshot);
  },
});
livePoller.start();
window.addEventListener('pagehide', () => {livePoller.stop();setPlayback(false);timelineRender.cancel();stopHeatmapAnimation();});
window.addEventListener('pageshow', event => { if (event.persisted && state.mode === 'live') livePoller.start(); });
const mapResizeObserver = new ResizeObserver(() => {
  if (mapView === 'spatial') spatialViewer?.resize();
  else if (followWorkArea) focusWorkArea();
  else { layoutMap(mapZoom === 1 ? { x: .5, y: .5 } : mapCenter()); render(); }
});
mapResizeObserver.observe(mapViewport);
const chartResizeObserver = new ResizeObserver(() => render());
chartResizeObserver.observe(byId('sound-chart'));
chartResizeObserver.observe(byId('timeline-wave'));
