import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ Intl, Date, AbortController, setTimeout, clearTimeout });
vm.runInContext(readFileSync(new URL('../dist/live.js', import.meta.url), 'utf8'), context);
const live = vm.runInContext('SoundAtlasLive', context);
const now = Date.parse('2026-11-14T06:36:00Z');
const frames = () => Array.from({ length: 48 }, () => ({ sound: {}, counts: {} }));
function payload() {
  const values = frames();
  values[29] = { sound: { A: 52.3, C: 48.2 }, counts: { A: 33, C: 21 } };
  return { version: 1, connected: true, generatedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(),
    nodes: [{ id: 'A', status: 'online', lastSeen: new Date(now).toISOString() }],
    days: [{ label: '2026-11-14', frames: values }], latest: { timestamp: new Date(now).toISOString(), sound: { A: 70 } }, plan: { state: 'recording' } };
}
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test('current period is always Beijing time and no-data startup is empty', () => {
  assert.deepEqual(plain(live.periodAt(now)), { label: '2026-11-14', slot: 876 });
  const source = live.selectPeriod(null, {}, now);
  assert.equal(source.slot, 876);
  assert.equal(source.days.length, 1);
  assert.equal(source.days[0].frames.length, 1440);
  assert.deepEqual(plain(source.days[0].frames[29].sound), {});
});

test('historical data never becomes the current live half-hour', () => {
  const old = payload(); old.days[0].label = '2026-11-12';
  const source = live.selectPeriod(live.normalizeSnapshot(old), {}, now);
  assert.equal(source.days[source.day].label, '2026-11-14');
  assert.deepEqual(plain(source.days[source.day].frames[source.slot].sound), {});
  assert.equal(source.days[0].frames[870].sound.A, 52.3);
});

test('poll refresh preserves a historical selection and clears removed readings', () => {
  const snapshot = live.normalizeSnapshot(payload());
  const selected = live.selectPeriod(snapshot, { follow: false, label: '2026-11-13', slot: 12, id: 'C' }, now);
  assert.equal(selected.days[selected.day].label, '2026-11-13');
  assert.equal(selected.slot, 12);
  assert.equal(selected.id, 'C');
  assert.deepEqual(plain(selected.days[selected.day].frames[12].sound), {});
});

test('instant readings do not overwrite half-hour LAeq and unknown fields are not used', () => {
  const input = payload(); input.days[0].frames[29].sound.UNKNOWN = 98;
  input.days[0].frames[29].sound.B = null;
  const snapshot = live.normalizeSnapshot(input);
  assert.deepEqual(plain(snapshot.days[0].frames[29].sound), { A: 52.3, C: 48.2 });
  assert.equal(snapshot.nodes.length, 6);
});

test('malformed API dates/frames and unsupported schemas fail clearly', () => {
  assert.throws(() => live.normalizeSnapshot({ version: 1, connected: true, days: [{ label: '2026-02-31', frames: frames() }] }));
  assert.throws(() => live.normalizeSnapshot({ version: 1, connected: true, days: [{ label: '2026-11-14', frames: [] }] }));
  assert.throws(() => live.normalizeSnapshot({ version: 2, connected: true, days: [] }));
});

test('stale snapshots and offline collectors are not called live', () => {
  const snapshot = live.normalizeSnapshot(payload());
  assert.equal(live.connectionState(snapshot, false, now).status, 'online');
  assert.equal(live.connectionState(snapshot, false, now + 121000).status, 'offline');
  assert.equal(live.connectionState({ ...snapshot, connected: false }, false, now).fresh, false);
  assert.equal(live.connectionState(snapshot, true, now).status, 'error');
});

function harness(fetcher) {
  let id = 0;
  const timers = new Map();
  const visibility = { hidden: false, listener: null,
    addEventListener(name, callback) { this.listener = callback; },
    removeEventListener() { this.listener = null; },
    set(hidden) { this.hidden = hidden; this.listener?.(); },
  };
  const data = [], errors = [];
  const poller = live.createPoller({ fetcher, visibility, clock:()=>0,
    onSnapshot: value => data.push(value), onError: error => errors.push(error),
    schedule(callback, delay) { const key = ++id; timers.set(key, { callback, delay }); return key; },
    cancel(key) { timers.delete(key); },
  });
  return { poller, visibility, data, errors, timers,
    async run(delay) { const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay); assert.ok(entry, `Missing ${delay}ms timer`); timers.delete(entry[0]); await entry[1].callback(); await settle(); },
  };
}

test('success polls every 2 seconds; failures back off and recovery restores cadence', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => payload() }; });
  h.poller.start(); await settle();
  assert.equal(h.errors.length, 1);
  await h.run(4000);
  assert.equal(h.errors.length, 2);
  fail = false; await h.run(8000);
  assert.equal(h.data.length, 1);
  assert.ok([...h.timers.values()].some(timer => timer.delay === 2000));
  h.poller.dispose(); assert.equal(h.timers.size, 0);
});

test('switching to CSV or demo stops pending network results from taking over', async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  h.poller.start(); h.poller.stop();
  resolve({ ok: true, json: async () => payload() }); await settle();
  assert.equal(h.data.length, 0); assert.equal(h.errors.length, 0); assert.equal(h.timers.size, 0);
});

test('a hidden page suspends requests and discards its stale in-flight response', async () => {
  const pending = [];
  const h = harness(() => new Promise(resolve => pending.push(resolve)));
  h.poller.start(); h.visibility.set(true); h.visibility.set(false);
  assert.equal(pending.length, 2);
  pending[1]({ ok: true, json: async () => payload() }); await settle();
  pending[0]({ ok: true, json: async () => ({ ...payload(), connected: false }) }); await settle();
  assert.equal(h.data.length, 1); assert.equal(h.data[0].connected, true);
  h.poller.dispose(); assert.equal(h.visibility.listener, null);
});

test('timeout becomes a retryable error rather than an endless loading state', async () => {
  const h = harness((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
  }));
  h.poller.start(); await h.run(12000);
  assert.equal(h.errors.length, 1);
  assert.ok([...h.timers.values()].some(timer => timer.delay === 4000));
  h.poller.dispose();
});

test('live map uses timestamped one-second samples and never modifies minute history',()=>{
 const input=payload();input.latest.samplePeriodSeconds=1;input.latest.timestamps={A:new Date(now-5000).toISOString(),C:new Date(now-80000).toISOString()};input.latest.sound={A:70,C:80};
 input.nodes.push({id:'C',status:'online',lastSeen:new Date(now).toISOString()});
 const snapshot=live.normalizeSnapshot(input),frame=live.currentFrame(snapshot,now);
 assert.deepEqual(plain(frame.sound),{A:70});assert.equal(snapshot.days[0].frames[29].sound.A,52.3);
 assert.deepEqual(plain(live.currentFrame(snapshot,now+76000).sound),{});
 assert.deepEqual(plain(live.currentFrame({...snapshot,connected:false},now).sound),{});
});
test('unchanged history responses reuse frames and lightweight polling keeps historical selection data',async()=>{
 const requests=[];let number=0;
 const first={...payload(),historyRevision:'history-a'};
 const h=harness(async url=>{requests.push(url);number++;return {ok:true,json:async()=>number===1?first:{...first,days:undefined,historyUnchanged:true,latest:{timestamp:new Date(now).toISOString(),samplePeriodSeconds:1,sound:{A:75},timestamps:{A:new Date(now).toISOString()}}}};});
 h.poller.start();await settle();await h.run(2000);
 assert.match(requests[1],/history=history-a/);assert.equal(h.data[0].days,h.data[1].days);assert.equal(h.data[1].latestSound.A,75);assert.equal(h.data[1].days[0].frames[29].sound.A,52.3);
 h.poller.dispose();
});
