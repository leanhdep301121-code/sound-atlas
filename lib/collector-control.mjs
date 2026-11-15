import { createHash, randomUUID } from 'node:crypto';
import { redis } from './live-store.mjs';

const PREFIX = 'sound-atlas:control:v1';
const DAY_SECONDS = 86400;
const COMMAND_MS = 90000;
const LEASE_MS = 120000;
const ONLINE_MS = 45000;
const NODE_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;
const ACTIONS = new Set(['overview','series','count','suspects','plan','exclude','unexclude','export','purge','calibration']);
const MODIFICATIONS = new Set(['plan','exclude','unexclude','calibration']);
const PRIVATE_KEYS = /^(ip|rssi|token|password|authorization|endpoint|secret|cookie|csrf)$/i;

export class ControlError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = message => { throw new ControlError(400, message); };
function object(value, name = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name + '格式有误。');
  return value;
}
function integer(value, name, min = 0, max = 9e15) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(name + '有误。');
  return value;
}
function text(value, name, max = 200, optional = false) {
  if (optional && value == null) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(name + '有误。');
  return value;
}
function nodes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some(n => typeof n !== 'string' || !NODE_PATTERN.test(n))) invalid('请选择有效节点。');
  return [...new Set(value)].sort();
}
function interval(payload) {
  const start = integer(payload.start, '开始时间');
  const end = integer(payload.end, '结束时间', 1);
  if (end <= start || end - start > 366 * 86400000) invalid('时间范围无效或超过一年。');
  return { start, end };
}
function optionalVersion(payload) {
  return payload.planVersion == null ? {} : { planVersion: integer(payload.planVersion, '计划版本') };
}
function localDateTime(value, allowEmpty = false) {
  if (allowEmpty && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) invalid('请填写北京时间。');
  const date = new Date(value + '+08:00');
  if (!Number.isFinite(+date)) invalid('时间格式无效。');
  return value;
}

export function normalizeCommand(input) {
  object(input);
  if (!ACTIONS.has(input.action)) invalid('不支持此管理操作。');
  const requestId = text(input.requestId, '请求编号', 80);
  if (!ID_PATTERN.test(requestId)) invalid('请求编号无效。');
  const source = object(input.payload ?? {});
  const action = input.action;
  let payload;
  if (action === 'overview') payload = {};
  if(action==='calibration') {
    if(!['start','analyze','apply','disable','restore','cancel'].includes(source.operation)) invalid('不支持此校准操作。');
    payload={operation:source.operation};
    if(source.operation==='start') payload.planVersion=integer(source.planVersion,'计划版本');
    if(['analyze','apply','restore','cancel'].includes(source.operation)) { if(!ID_PATTERN.test(source.runId??'')) invalid('校准任务编号无效。');payload.runId=source.runId; }
    if(source.operation==='apply'){if(!/^[a-f0-9]{64}$/.test(source.fingerprint??''))invalid('校准报告校验值无效。');payload.fingerprint=source.fingerprint;}
  }

  if (action === 'series') payload = { ...interval(source), w: integer(source.w ?? 600, '曲线宽度', 50, 900) };
  if (action === 'suspects') payload = interval(source);
  if (action === 'count') payload = { ...interval(source), nodes: nodes(source.nodes) };
  if (action === 'exclude') payload = { ...interval(source), nodes: nodes(source.nodes), reason: text(source.reason ?? '', '排除原因', 60), note: text(source.note ?? '', '备注', 200) };
  if (action === 'unexclude') payload = { grp: integer(source.grp, '排除组', 1) };
  if (action === 'plan') {
    const planAction = source.action;
    if (!['set','quick','start_now','stop','cancel'].includes(planAction)) invalid('采集计划操作无效。');
    payload = { action: planAction, ...optionalVersion(source) };
    if (planAction === 'set') Object.assign(payload, { start: localDateTime(source.start), end: localDateTime(source.end, true) });
    if (planAction === 'quick') payload.days = integer(source.days ?? 0, '采集天数', 0, 30);
  }
  if (action === 'export') {
    payload = { ...interval(source), nodes: nodes(source.nodes), clean: source.clean !== false, ...(source.corrected === true ? {corrected:true} : {}), limit: integer(source.limit ?? 1000, '导出分页大小', 1, 1000) };
    if (source.cursor != null) {
      const cursor = object(source.cursor, '导出游标');
      if (!NODE_PATTERN.test(cursor.node ?? '') || !payload.nodes.includes(cursor.node)) invalid('导出游标节点有误。');
      payload.cursor = { node: cursor.node, ts: integer(cursor.ts, '游标时间'), maxRowid: integer(cursor.maxRowid, '导出边界'), end: integer(cursor.end, '导出结束时间'), signature: text(cursor.signature, '导出签名', 128) };
      if (!/^[a-f0-9]{32,128}$/i.test(payload.cursor.signature)) invalid('导出游标签名有误。');
    }
  }
  if (action === 'purge') {
    if (!['range','outside_plan'].includes(source.mode) || typeof source.dry !== 'boolean') invalid('删除操作无效。');
    payload = { mode: source.mode, dry: source.dry, planVersion: integer(source.planVersion, '计划版本') };
    if (source.mode === 'range') Object.assign(payload, interval(source), { nodes: nodes(source.nodes) });
    if (!source.dry) {
      payload.expectedCount = integer(source.expectedCount, '确认记录数', 1);
      payload.confirmation = text(source.confirmation, '删除确认', 64);
      if (payload.confirmation !== 'DELETE ' + payload.expectedCount) invalid('删除确认文字与预览条数不一致。');
    }
  }
  return { action, payload, requestId, mutating: MODIFICATIONS.has(action) || action === 'purge' && !payload.dry };
}

function numberOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function short(value, length = 200) { return typeof value === 'string' ? value.slice(0, length) : ''; }
function nullableBoolean(value) { return typeof value === 'boolean' ? value : null; }
function safeNode(value) { return typeof value === 'string' && NODE_PATTERN.test(value) ? value : null; }

export function sanitizeTelemetry(input, now = Date.now()) {
  const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= now + 120000 ? value : null;
  const level = (value, max = 140) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
  const generated = Date.parse(input?.generatedAt);
  const allowed = ['N1','N2','N3','N4','N5','D1','D2'];
  return {
    generatedAt: Number.isFinite(generated) && generated <= now + 120000 ? new Date(generated).toISOString() : null,
    windowSeconds: 300, bucketSeconds: 5, uploadIntervalSeconds: 30,
    nodes: allowed.map(node => {
      const source = Array.isArray(input?.nodes) ? input.nodes.find(item => item?.node === node) : null;
      const stamp = timestamp(source?.timestamp);
      const history = Array.isArray(source?.history) ? source.history.slice(-61).filter(p => Array.isArray(p) && timestamp(p[0]) && p[0] >= now - 420000 && level(p[1]) !== null).map(p => [p[0],level(p[1])]).sort((a,b)=>a[0]-b[0]) : [];
      return {node,timestamp:stamp,laeq:stamp ? level(source?.laeq) : null,lafmax:stamp ? level(source?.lafmax,160) : null,
        windowLeq:level(source?.windowLeq),rawLaeq:level(source?.rawLaeq),correctionDb:Number.isFinite(source?.correctionDb)&&Math.abs(source.correctionDb)<=140?source.correctionDb:0,samples:Number.isInteger(source?.samples) && source.samples >= 0 && source.samples <= 600 ? source.samples : 0,history};
    }),
  };
}

function sanitizeCalibration(value) {
  if(!value||typeof value!=='object')return null;
  const allowed=['N1','N2','N3','N4','N5','D1','D2'];
  const offsets=map=>Object.fromEntries(allowed.filter(n=>Number.isFinite(map?.[n])&&Math.abs(map[n])<=140).map(n=>[n,map[n]]));
  const r=value.run,a=value.active;
  const report=r?.report;
  return {minimumCommonSeconds:240,nodes:allowed,
    active:a?{id:short(a.id,100),start:numberOrNull(a.start),end:numberOrNull(a.end),offsets:offsets(a.offsets)}:null,
    run:r?{id:short(r.id,100),startMs:numberOrNull(r.startMs),endMs:numberOrNull(r.endMs),planVersion:numberOrNull(r.planVersion),cancelled:Boolean(r.cancelled),applied:Boolean(r.applied),restored:Boolean(r.restored),phase:short(r.phase,20),counts:Object.fromEntries(allowed.map(n=>[n,Number.isInteger(r.counts?.[n])?Math.max(0,Math.min(300,r.counts[n])):0])),commonSeconds:numberOrNull(r.commonSeconds),rawLevels:Object.fromEntries(allowed.map(n=>[n,numberOrNull(r.rawLevels?.[n])])),
      report:report?{runId:short(report.runId,100),startMs:numberOrNull(report.startMs),endMs:numberOrNull(report.endMs),commonSeconds:numberOrNull(report.commonSeconds),expectedSeconds:300,canApply:report.canApply===true,fingerprint:short(report.fingerprint,64),method:short(report.method,100),note:short(report.note,300),warnings:Array.isArray(report.warnings)?report.warnings.slice(0,10).map(w=>short(w,300)):[],results:Array.isArray(report.results)?report.results.filter(n=>allowed.includes(n.node)).slice(0,7).map(n=>({node:n.node,samples:numberOrNull(n.samples),offset:numberOrNull(n.offset),beforeRmse:numberOrNull(n.beforeRmse),afterRmse:numberOrNull(n.afterRmse),mad:numberOrNull(n.mad)})):[]}:null}:null};
}

export function sanitizeState(input, now = Date.now()) {
  object(input, '采集端状态');
  const overview = object(input.overview ?? {});
  const plan = object(input.plan ?? {});
  const summaryNodes = Array.isArray(overview.nodes) ? overview.nodes.slice(0, 16).filter(n => safeNode(n.node)).map(n => ({
    node: n.node, color: /^#[\da-f]{6}$/i.test(n.color) ? n.color : '#69707e',
    first: numberOrNull(n.first), last: numberOrNull(n.last), count: numberOrNull(n.count), invalid: numberOrNull(n.invalid), excluded: numberOrNull(n.excluded), usable: numberOrNull(n.usable),
  })) : [];
  const exclusions = Array.isArray(overview.exclusions) ? overview.exclusions.slice(0, 120).filter(e => Number.isSafeInteger(e.grp)).map(e => ({
    grp: e.grp, nodes: Array.isArray(e.nodes) ? e.nodes.filter(safeNode).slice(0,16) : [], start: numberOrNull(e.start), end: numberOrNull(e.end), reason: short(e.reason,60), note: short(e.note,200), rows: numberOrNull(e.rows),
  })) : [];
  const colors = Object.fromEntries(Object.entries(overview.colors ?? {}).filter(([key, value]) => safeNode(key) && /^#[\da-f]{6}$/i.test(value)).slice(0,16));
  const readiness = Array.isArray(input.readiness) ? input.readiness.slice(0,16).filter(r => safeNode(r.node)).map(r => ({
    node: r.node, label: short(r.label,30), online: r.online === true, synced: nullableBoolean(r.synced), mic: nullableBoolean(r.mic), planSynced: nullableBoolean(r.planSynced), message: short(r.message), lastSeen: typeof r.lastSeen === 'string' ? short(r.lastSeen,40) : numberOrNull(r.lastSeen), latest: numberOrNull(r.latest),
  })) : [];
  const rawPlan = { version: numberOrNull(plan.version) ?? 0, startMs: numberOrNull(plan.startMs) ?? 0, endMs: numberOrNull(plan.endMs) ?? 0, state: ['none','waiting','recording','finished'].includes(plan.state) ? plan.state : 'none' };
  const state = {
    receivedAt: new Date(now).toISOString(), receivedAtMs: now,
    overview: { nodes: summaryNodes, exclusions, plan: { start: rawPlan.startMs, end: rawPlan.endMs }, now: numberOrNull(overview.now) ?? now, reasons: Array.isArray(overview.reasons) ? overview.reasons.slice(0,20).map(r => short(r,100)) : [], colors, backups: Array.isArray(overview.backups) ? overview.backups.slice(0,10).map(b => ({name:short(b.name,80).replace(/[\\/]/g,''),mb:numberOrNull(b.mb)})) : [], exclusionsTruncated: Boolean(overview.exclusionsMore) || (overview.exclusions?.length ?? 0) > 120 },
    readiness, plan: rawPlan, telemetry: sanitizeTelemetry(input.telemetry, now), calibration: sanitizeCalibration(input.calibration),
    bridge: { state: short(input.bridge?.state,24), message: short(input.bridge?.message), last_success: short(input.bridge?.last_success,40) || null },
  };
  if (Buffer.byteLength(JSON.stringify(state)) > 160000) invalid('采集状态过大。');
  return state;
}

function cleanResult(value, depth = 0) {
  if (depth > 12) invalid('执行结果层级过深。');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid('执行结果含无效数值。'); return value; }
  if (Array.isArray(value)) { if (value.length > 10000) invalid('执行结果过大。'); return value.map(v => cleanResult(v,depth+1)); }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.test(key) && !['__proto__','constructor','prototype'].includes(key)).map(([key,v]) => [key,cleanResult(v,depth+1)]));
  invalid('执行结果格式无效。');
}

export function normalizeReceipts(value) {
  if (!Array.isArray(value) || value.length > 4) invalid('执行回执格式有误。');
  const seen = new Set();
  return value.map(item => {
    object(item);
    if (!ID_PATTERN.test(item.id ?? '') || seen.has(item.id) || !['done','failed','uncertain'].includes(item.status)) invalid('执行回执编号或状态有误。');
    seen.add(item.id);
    const receipt = { id: item.id, status: item.status };
    // Keep structured data as a JSON string inside Lua. Redis cjson cannot
    // reliably distinguish empty objects from empty arrays after a round trip.
    if (item.status === 'done') receipt.resultJson = JSON.stringify(cleanResult(item.result ?? null));
    else receipt.error = short(item.error,300) || '采集端未完成此操作。';
    if (Buffer.byteLength(JSON.stringify(receipt)) > 230000) invalid('执行结果过大，请缩小时间范围或导出分页。');
    return receipt;
  });
}

export async function readControlJson(request, maximum = 500000) {
  if (Number(request.headers.get('content-length')) > maximum) throw new ControlError(413,'管理数据过大。');
  const reader=request.body?.getReader();
  if(!reader) invalid('请求正文为空。');
  let size=0;const chunks=[];
  while(true){
    const {done,value}=await reader.read();if(done)break;
    size+=value.length;if(size>maximum){await reader.cancel();throw new ControlError(413,'管理数据过大。');}
    chunks.push(value);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{invalid('请求正文不是有效JSON。');}
}

const ENQUEUE = `
local oldid=redis.call('GET',KEYS[3]);
if oldid then
 local old=redis.call('GET',ARGV[1]..':command:'..oldid);
 if old then local c=cjson.decode(old); if c.fingerprint~=ARGV[2] then return cjson.encode({error='conflict'}) end; return old end
end
local s=redis.call('GET',KEYS[2]);
if not s or tonumber(ARGV[3])-tonumber(cjson.decode(s).receivedAtMs)>45000 then return cjson.encode({error='offline'}) end
if redis.call('LLEN',KEYS[1])>=20 then return cjson.encode({error='busy'}) end
local c=cjson.decode(ARGV[4]);
redis.call('SET',ARGV[1]..':command:'..c.id,ARGV[4],'EX',ARGV[5]);
redis.call('SET',KEYS[3],c.id,'EX',ARGV[5]);
redis.call('RPUSH',KEYS[1],c.id); redis.call('EXPIRE',KEYS[1],ARGV[5]);
return ARGV[4]`;

const POLL = `
local prefix=ARGV[1]; local now=tonumber(ARGV[2]); local ttl=tonumber(ARGV[3]);
local acknowledged={}; local rejected={};
local receipts=cjson.decode(ARGV[5]);
for _,r in ipairs(receipts) do
 local key=prefix..':command:'..r.id; local raw=redis.call('GET',key);
 if raw then
  local c=cjson.decode(raw);
  if c.status=='done' or c.status=='failed' or c.status=='expired' or c.status=='uncertain' then table.insert(acknowledged,r.id)
  elseif c.status=='running' and redis.call('GET',KEYS[3])==c.id then
   if now>tonumber(c.leaseUntilMs)+30000 then c.status='uncertain'; c.error='执行回执超时，请核对本机状态。'
   else
    c.status=r.status; c.error=r.error;
    if r.status=='done' then
     local resultTtl=ttl; if c.action=='export' then resultTtl=120 end;
     redis.call('SET',prefix..':result:'..c.id,r.resultJson,'EX',resultTtl);
     c.resultExpiresAtMs=now+resultTtl*1000;
    end
   end
   c.completedAt=ARGV[7]; redis.call('SET',key,cjson.encode(c),'EX',ttl);redis.call('DEL',KEYS[3]);table.insert(acknowledged,r.id)
  else table.insert(rejected,r.id) end
 else table.insert(acknowledged,r.id) end
end
redis.call('SET',KEYS[2],ARGV[4],'EX',ttl);
local active=redis.call('GET',KEYS[3]);
if active then
 local key=prefix..':command:'..active;local raw=redis.call('GET',key);
 if not raw then redis.call('DEL',KEYS[3])
 else local c=cjson.decode(raw);
  if c.status~='running' then redis.call('DEL',KEYS[3])
  elseif tonumber(c.leaseUntilMs)<=now then c.status='uncertain';c.error='采集端执行超时，未自动重试，请核对本机状态。';c.completedAt=ARGV[7];redis.call('SET',key,cjson.encode(c),'EX',ttl);redis.call('DEL',KEYS[3])
  else return cjson.encode({command=cjson.null,acknowledged=acknowledged,rejected=rejected}) end
 end
end
for i=1,25 do
 local id=redis.call('LPOP',KEYS[1]);if not id then break end;
 local key=prefix..':command:'..id;local raw=redis.call('GET',key);
 if raw then local c=cjson.decode(raw);
  if c.status=='queued' then
   if tonumber(c.expiresAtMs)<=now then c.status='expired';c.error='等待采集端超时，操作未执行。';redis.call('SET',key,cjson.encode(c),'EX',ttl)
   else c.status='running';c.claimedAt=ARGV[7];c.leaseUntilMs=now+tonumber(ARGV[6]);redis.call('SET',key,cjson.encode(c),'EX',ttl);redis.call('SET',KEYS[3],id,'EX',ttl);return cjson.encode({command=c,acknowledged=acknowledged,rejected=rejected}) end
  end
 end
end
return cjson.encode({command=cjson.null,acknowledged=acknowledged,rejected=rejected})`;

const READ_COMMAND = `
local raw=redis.call('GET',KEYS[1]);if not raw then return false end;
local c=cjson.decode(raw);local now=tonumber(ARGV[1]);
if c.status=='queued' and tonumber(c.expiresAtMs)<=now then c.status='expired';c.error='等待采集端超时，操作未执行。';redis.call('SET',KEYS[1],cjson.encode(c),'KEEPTTL') end
if c.status=='running' and tonumber(c.leaseUntilMs)<=now then c.status='uncertain';c.error='执行结果暂无法确认，未自动重试，请核对本机状态。';redis.call('SET',KEYS[1],cjson.encode(c),'KEEPTTL');if redis.call('GET',KEYS[3])==c.id then redis.call('DEL',KEYS[3]) end end
if c.status=='done' then local result=redis.call('GET',KEYS[2]); if result then c.resultJson=result else c.status='expired';c.error='执行结果已过期，请重新查询或导出。' end end
return cjson.encode(c)`;

function decode(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
function exposedCommand(command, forCollector = false) {
  if (!command) return null;
  const fields = forCollector ? ['id','action','createdAt','expiresAt'] : ['id','action','status','createdAt','expiresAt','claimedAt','completedAt','error'];
  const output = Object.fromEntries(fields.filter(key => Object.hasOwn(command,key)).map(key => [key,command[key]]));
  if (forCollector) {
    let payload = typeof command.payloadJson === 'string' ? JSON.parse(command.payloadJson) : command.payload;
    // Compatibility for an overview already queued by the previous release.
    if (command.action === 'overview' && Array.isArray(payload) && payload.length === 0) payload = {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ControlError(503,'管理命令参数无法读取，请重新提交。');
    output.payload = payload;
  } else if (typeof command.resultJson === 'string') output.result = JSON.parse(command.resultJson);
  else if (Object.hasOwn(command,'result')) output.result = command.result;
  return output;
}

export function createControlStore({ run = redis, prefix = PREFIX, now = Date.now, uuid = randomUUID, ttlSeconds = DAY_SECONDS } = {}) {
  const keys = { queue:prefix+':queue',state:prefix+':state',active:prefix+':active' };
  return {
    async enqueue(input, ownerId) {
      const normalized = normalizeCommand(input);
      const time = now();
      const fingerprint = createHash('sha256').update(JSON.stringify({action:normalized.action,payload:normalized.payload})).digest('hex');
      const requestKey = prefix+':request:'+createHash('sha256').update(String(ownerId)+'\0'+normalized.requestId).digest('hex');
      const command = { id:uuid(), action:normalized.action,payloadJson:JSON.stringify(normalized.payload),mutating:normalized.mutating,fingerprint,status:'queued',createdAt:new Date(time).toISOString(),expiresAt:new Date(time+COMMAND_MS).toISOString(),createdAtMs:time,expiresAtMs:time+COMMAND_MS };
      const response=decode(await run(['EVAL',ENQUEUE,'3',keys.queue,keys.state,requestKey,prefix,fingerprint,String(time),JSON.stringify(command),String(ttlSeconds)]));
      if (response?.error==='offline') throw new ControlError(409,'采集端离线，请先启动本机采集程序。');
      if (response?.error==='conflict') throw new ControlError(409,'同一请求编号不能用于不同操作。');
      if (response?.error==='busy') throw new ControlError(429,'待执行操作较多，请稍后重试。');
      return exposedCommand(response);
    },
    async command(id) {
      if (!ID_PATTERN.test(id??'')) invalid('操作编号无效。');
      const result=decode(await run(['EVAL',READ_COMMAND,'3',prefix+':command:'+id,prefix+':result:'+id,keys.active,String(now())]));
      if (!result) throw new ControlError(404,'操作不存在或已过期。');
      return exposedCommand(result);
    },
    async state() {
      const value=decode(await run(['GET',keys.state]));
      if (!value) return {connected:false,receivedAt:null,overview:null,readiness:[],plan:null,bridge:null};
      const connected=now()-value.receivedAtMs<=ONLINE_MS;
      return {connected,receivedAt:value.receivedAt,overview:value.overview,readiness:value.readiness.map(n=>({...n,online:connected&&n.online})),plan:value.plan,bridge:value.bridge,telemetry:value.telemetry??null,calibration:value.calibration??null};
    },
    async poll(input) {
      object(input);
      if(input.action!=='poll') invalid('采集端请求无效。');
      const time=now();
      const state=sanitizeState(input.state,time);
      const receipts=normalizeReceipts(input.results??[]);
      const response=decode(await run(['EVAL',POLL,'3',keys.queue,keys.state,keys.active,prefix,String(time),String(ttlSeconds),JSON.stringify(state),JSON.stringify(receipts),String(LEASE_MS),new Date(time).toISOString()]));
      return {serverTime:new Date(time).toISOString(),command:exposedCommand(response.command,true),acknowledged:Array.isArray(response.acknowledged)?response.acknowledged:[],rejected:Array.isArray(response.rejected)?response.rejected:[]};
    },
  };
}

export const controlStore = createControlStore();
