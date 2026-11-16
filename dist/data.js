'use strict';

// Coordinates use the same DWG crop and transform as floorplan-2f.svg.
const FLOOR_PLAN = { width: 1000, height: 446.1538461538462 };
// User confirmed that the original plan's upper edge (CAD +Y / model -Z) is north.
const FLOOR_ORIENTATION = { northBearingDegrees: 0 };
const TABLES = [
  {
    "id": "A",
    "device": "N3",
    "marker": "N3",
    "name": "N3",
    "location": "图纸下侧工位区，邻近未来城市实验室",
    "x": 320.848308,
    "y": 296.812462,
    "cadX": 86855.14,
    "cadY": 140707.19
  },
  {
    "id": "B",
    "device": "N2",
    "marker": "N2",
    "name": "N2",
    "location": "图纸下侧工位区，中部",
    "x": 443.925154,
    "y": 296.812462,
    "cadX": 94855.135,
    "cadY": 140707.19
  },
  {
    "id": "C",
    "device": "N1",
    "marker": "N1",
    "name": "N1",
    "location": "图纸下侧工位区，邻近原有网络机房",
    "x": 567.437538,
    "y": 296.812462,
    "cadX": 102883.44,
    "cadY": 140707.19
  },
  {
    "id": "D",
    "device": "N5",
    "marker": "N5",
    "name": "N5",
    "location": "图纸上侧工位区，邻近卫生间",
    "x": 382.386692,
    "y": 178.960615,
    "cadX": 90855.135,
    "cadY": 148367.56
  },
  {
    "id": "E",
    "device": "D1",
    "marker": "D1",
    "name": "D1",
    "location": "图纸上侧工位区，邻近小会议室",
    "x": 505.463615,
    "y": 178.960615,
    "cadX": 98855.135,
    "cadY": 148367.56
  },
  {
    "id": "D1",
    "device": "D2",
    "marker": "D2",
    "name": "个人工位",
    "location": "N1 右侧，东墙最南端单人工位，邻近右下休息区",
    "kind": "personal",
    "x": 617.582615,
    "y": 357.843,
    "cadX": 106142.87,
    "cadY": 136740.20500000002
  }
];
// Only the six active second-floor locations are displayed.
const OBSERVATION_NODES = TABLES;
const SLOTS = 1440;
const INITIAL_SLOT = 870;
const weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function clockLabel(slot) {
  return String(Math.floor(slot / 60)).padStart(2, '0') + ':' + String(slot % 60).padStart(2, '0');
}

function createDemo() {
  const rounded = value => Math.round(value * 10) / 10;
  const peak = (hour, center, spread) => Math.exp(-Math.pow((hour - center) / spread, 2));
  return weekday.map((label, day) => ({
    label,
    frames: Array.from({ length: SLOTS }, (_, slot) => {
      const hour = slot / 60;
      const activity = (day >= 5 ? .57 : 1) * (12 * peak(hour, 10.5, 3) + 18 * peak(hour, 15, 3) + 7 * peak(hour, 19, 2.4));
      const sound = Object.fromEntries(OBSERVATION_NODES.map(({ id }, index) => {
        const wave = Math.sin(slot / 30 * .7 + index * 1.3 + day) * 1.7;
        const discussion = (index === 0 ? 8 : index === 2 ? 7 : 2) * peak(hour, 14.8 + index * .65, 1.18);
        return [id, rounded(32.8 + index * .8 + activity * [1, .82, .92, .61, .73, .68, .55][index] + discussion + wave)];
      }));
      return { sound };
    }),
  }));
}

function csvRecords(csv) {
  const rows = [];
  let record = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  const finishCell = () => { record.push(cell.trim()); cell = ''; closed = false; };
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else cell += char;
    } else if (char === '"' && !cell && !closed) {
      quoted = true;
    } else if (char === ',') {
      finishCell();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[index + 1] === '\n') index += 1;
      finishCell();
      if (record.some(Boolean)) rows.push(record);
      record = [];
    } else if (closed && !/\s/.test(char) || char === '"') {
      throw new Error('CSV 引号格式有误。请参照下载的模板。');
    } else if (!closed) {
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV 中有一处引号未闭合。');
  finishCell();
  if (record.some(Boolean)) rows.push(record);
  return rows;
}

const observationTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function parseObservation(csv) {
  const [header, ...records] = csvRecords(csv.replace(/^\uFEFF/, ''));
  const required = ['timestamp', 'node', 'laeq'];
  if (!header || required.some(name => !header.includes(name)) || new Set(header).size !== header.length) {
    throw new Error('CSV 列名有误。请使用下载模板中的列名。');
  }
  const columns = Object.fromEntries(header.map((name, index) => [name, index]));
  const days = new Map();
  const tableIds = new Set(OBSERVATION_NODES.map(node => node.id));
  // Legacy CSV exports may still contain retired entrance sensors.
  const retiredIds = new Set(['W', 'EAST', 'D2']);
  const seen = new Set();
  let earliest;
  records.forEach((row, index) => {
    const get = name => row[columns[name]] ?? '';
    const bad = message => { throw new Error('记录 ' + (index + 1) + '：' + message); };
    if (row.length !== header.length) bad('列数与表头不一致。');
    const id = get('node').toUpperCase();
    if (retiredIds.has(id)) return;
    if (!tableIds.has(id)) bad('测点编号需为 A、B、C、D、E 或 D1。');
    const stamp = get('timestamp');
    const date = new Date(stamp);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(stamp) || !Number.isFinite(+date)) {
      bad('时间戳需使用带时区的 ISO 格式。');
    }
    const [label, time] = observationTime.format(date).split(' ');
    const [hour, minute] = time.split(':').map(Number);
    const slot = hour * 60 + minute;
    const duplicateKey = id + ':' + +date;
    if (seen.has(duplicateKey)) bad('同一测点的时间戳重复。');
    seen.add(duplicateKey);
    if (!days.has(label)) days.set(label, Array.from({ length: SLOTS }, () => ({ sound: {} })));
    const frame = days.get(label)[slot];
    const level = Number(get('laeq'));
    const duration = get('duration_s') ? Number(get('duration_s')) : 10;
    if (!get('laeq') || !Number.isFinite(level) || level < 0 || level > 160) bad('声级需为 0 至 160 的数值。');
    if (!Number.isFinite(duration) || duration <= 0 || duration > 60) bad('声级采样时长需大于 0，且最多 60 秒（分钟回放需使用一分钟以内的原始观测）。');
    frame.sound[id] ??= { energy: 0, duration: 0 };
    frame.sound[id].energy += Math.pow(10, level / 10) * duration;
    frame.sound[id].duration += duration;
    if (frame.sound[id].duration > 60) bad('该测点一分钟内的采样时长超过 60 秒。');
    if (!earliest || +date < earliest.stamp) earliest = { label, slot, stamp: +date, id };
  });
  if (!earliest) throw new Error('文件中没有声级记录。请加入 A 至 E 或 D1 测点的观测记录后重试。');
  const series = [...days.keys()].sort().map(label => ({
    label,
    frames: days.get(label).map(frame => ({
      sound: Object.fromEntries(Object.entries(frame.sound).map(([id, {energy, duration}]) => [id, 10 * Math.log10(energy / duration)])),
    })),
  }));
  return { days: series, day: 0, slot: earliest.slot, id: earliest.id };
}

const CSV_TEMPLATE = [
  'timestamp,node,laeq,duration_s',
  '2026-11-09T14:30:00+08:00,A,56.3,10',
  '2026-11-09T14:30:00+08:00,B,49.1,10',
  '2026-11-09T14:30:00+08:00,C,52.6,10',
  '2026-11-09T14:30:00+08:00,D,47.8,10',
  '2026-11-09T14:30:00+08:00,E,50.2,10',
  '2026-11-09T14:30:00+08:00,D1,48.6,10',
].join('\r\n') + '\r\n';
