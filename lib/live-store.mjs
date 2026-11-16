import { createHash, timingSafeEqual } from 'node:crypto';

export const SNAPSHOT_KEY = 'sound-atlas:live:v1';
export const TABLE_IDS = ['A', 'B', 'C', 'D', 'E', 'D1'];
const ACCEPTED_IDS = [...TABLE_IDS, 'D2']; // Accept retired dormitory payloads during rollout.
const LABELS = ['公桌1', '公桌2', '公桌3', '公桌A', '公桌B', '个人工位'];
const MAX_BODY = 300_000;

export function authorized(header, secret) {
  if (!secret) return false;
  const token = (header || '').replace(/^Bearer /, '');
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(token), hash(secret));
}

function iso(value, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid timestamp');
  return new Date(value).toISOString();
}

function readings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid readings');
  const out = {};
  for (const id of TABLE_IDS) {
    if (value[id] == null) continue;
    if (!Number.isFinite(value[id]) || value[id] <= 0 || value[id] > 140) throw new Error('Invalid sound level');
    out[id] = Math.round(value[id] * 100) / 100;
  }
  return out;
}

export function normalizeSnapshot(input, now = Date.now()) {
  if (!input || input.version !== 1) throw new Error('Invalid snapshot version');
  const generatedAt = iso(input.generatedAt);
  const age = now - Date.parse(generatedAt);
  if (age < -120_000 || age > 600_000) throw new Error('Collector clock or snapshot time is out of range');
  if (!Array.isArray(input.days) || input.days.length > 8) throw new Error('Invalid history window');
  const labels = new Set();
  const days = input.days.map(day => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.label) || iso(day.label + 'T00:00:00Z').slice(0, 10) !== day.label || labels.has(day.label)) throw new Error('Invalid history date');
    labels.add(day.label);
    if (!Array.isArray(day.frames) || day.frames.length !== 48) throw new Error('Expected 48 half-hour frames');
    const frames = day.frames.map(frame => {
      const sound = readings(frame.sound);
      const counts = {};
      for (const id of Object.keys(sound)) {
        const count = frame.counts?.[id];
        if (!Number.isInteger(count) || count < 1 || count > 3600) throw new Error('Invalid observation count');
        counts[id] = count;
      }
      return { sound, counts };
    });
    return { label: day.label, frames };
  }).sort((a, b) => a.label.localeCompare(b.label));
  // Accept legacy payload sizes during rollout; publish only active spatial locations.
  if (!Array.isArray(input.nodes) || ![5, 6, 7].includes(input.nodes.length)) throw new Error('Expected five to seven acoustic nodes');
  if (new Set(input.nodes.map(node => node.id)).size !== input.nodes.length || input.nodes.some(node => !ACCEPTED_IDS.includes(node.id)) || TABLE_IDS.slice(0, 5).some(id => !input.nodes.some(node => node.id === id))) throw new Error('Invalid acoustic node mapping');
  const nodes = TABLE_IDS.map((id, index) => {
    const node = input.nodes.find(item => item.id === id);
    const lastSeen = iso(node?.lastSeen, true);
    return { id, label: LABELS[index], lastSeen, status: lastSeen == null ? 'unknown' : now - Date.parse(lastSeen) <= 75_000 && Date.parse(lastSeen) <= now + 120_000 ? 'online' : 'offline' };
  });
  const plan = input.plan || {};
  const startMs = Number.isSafeInteger(plan.startMs) && plan.startMs >= 0 ? plan.startMs : 0;
  const endMs = Number.isSafeInteger(plan.endMs) && plan.endMs >= 0 ? plan.endMs : 0;
  if (endMs && endMs < startMs) throw new Error('Invalid collection plan');
  const state = !startMs ? 'none' : now < startMs ? 'waiting' : endMs && now >= endMs ? 'finished' : 'recording';
  return {
    version: 1, generatedAt, receivedAt: new Date(now).toISOString(),
    plan: { state, startMs, endMs }, nodes, days, correctionApplied: input.correctionApplied === true,
    latest: { timestamp: iso(input.latest?.timestamp, true), sound: readings(input.latest?.sound) },
  };
}

export async function readLimitedJson(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new Error('Payload too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('Payload too large'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function redis(command, env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Storage unavailable');
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Storage unavailable');
  const result = await response.json();
  if (result.error) throw new Error('Storage unavailable');
  return result.result;
}

// Atomic replacement prevents a delayed older upload from overwriting a newer snapshot.
export async function storeSnapshot(snapshot) {
  const script = `local old=redis.call('GET',KEYS[1]); if old then local decoded=cjson.decode(old); if decoded.generatedAt>ARGV[1] then return 0 end end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;
  return redis(['EVAL', script, '1', SNAPSHOT_KEY, snapshot.generatedAt, JSON.stringify(snapshot)]);
}

export function publicSnapshot(snapshot, now = Date.now()) {
  if (!snapshot) return { version: 1, connected: false, generatedAt: null, receivedAt: null, plan: { state: 'none', startMs: 0, endMs: 0 }, days: [], nodes: TABLE_IDS.map((id, index) => ({ id, label: LABELS[index], status: 'unknown', lastSeen: null })), latest: { timestamp: null, sound: {} } };
  const connected = now - Date.parse(snapshot.receivedAt) <= 90_000 && now - Date.parse(snapshot.generatedAt) <= 120_000;
  const nodes = snapshot.nodes.map(node => ({ ...node, status: node.lastSeen == null ? 'unknown' : connected && now - Date.parse(node.lastSeen) <= 75_000 ? 'online' : 'offline' }));
  const latest = connected && now - Date.parse(snapshot.latest.timestamp) <= 75_000 ? snapshot.latest : { timestamp: snapshot.latest.timestamp, sound: {} };
  return { ...snapshot, connected, nodes, latest };
}

export function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
