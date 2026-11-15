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
let heatmapFrame = null;

function drawHeatmap(frame) {
  const canvas = byId('heatmap');
  const active = state.layer === 'heatmap';
  canvas.hidden = !active;
  byId('heatmap-controls').hidden = !active;
  if (!active) return;

  const samples = heatmapSamples(frame);
  const enough = samples.length >= 2;
  byId('heatmap-count').textContent = samples.length + ' / 5 个测点';
  byId('heatmap-note').textContent = enough
    ? '监测工位与内走廊的插值估计，未模拟墙体传播。'
    : '这一时段不足两个有效声级测点，热力分布暂空。';
  canvas.setAttribute('aria-label', enough
    ? clockLabel(state.slot) + ' 噪声热力分布，由 ' + samples.length + ' 个测点进行声能距离加权插值，色标 30 至 70 dB(A)。'
    : clockLabel(state.slot) + ' 热力图无足够数据。');

  if (heatmapFrame !== frame) {
    const raster = heatmapRaster.getContext('2d');
    const pixels = raster.createImageData(heatmapRaster.width, heatmapRaster.height);
    if (enough) {
      for (let row = 0; row < heatmapRaster.height; row += 1) {
        for (let col = 0; col < heatmapRaster.width; col += 1) {
          if (!heatmapCoverage[row * heatmapRaster.width + col]) continue;
          const x = (col + .5) / heatmapRaster.width * FLOOR_PLAN.width;
          const y = (row + .5) / heatmapRaster.height * FLOOR_PLAN.height;
          const color = heatmapColor(heatmapLevel(x, y, samples));
          const offset = (row * heatmapRaster.width + col) * 4;
          pixels.data.set([...color, 255], offset);
        }
      }
    }
    raster.putImageData(pixels, 0, 0);
    heatmapFrame = frame;
  }

  const ctx = prepareCanvas(canvas, FLOOR_PLAN.width, FLOOR_PLAN.height);
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = Number(byId('heatmap-opacity').value) / 100;
  ctx.drawImage(heatmapRaster, 0, 0, FLOOR_PLAN.width, FLOOR_PLAN.height);
  ctx.globalAlpha = 1;
}
