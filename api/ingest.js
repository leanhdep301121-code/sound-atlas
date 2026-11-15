import { authorized, normalizeSnapshot, readLimitedJson, storeSnapshot, jsonResponse } from '../lib/live-store.mjs';

export async function POST(request) {
  const secret = process.env.SOUND_ATLAS_INGEST_TOKEN;
  if (!secret) return jsonResponse({ error: '同步服务尚未配置。' }, 503);
  if (!authorized(request.headers.get('authorization'), secret)) return jsonResponse({ error: 'Unauthorized' }, 401);
  let snapshot;
  try { snapshot = normalizeSnapshot(await readLimitedJson(request)); }
  catch (error) { return jsonResponse({ error: error.message === 'Payload too large' ? '摘要过大。' : '数据摘要格式或时间有误。' }, 400); }
  try {
    const accepted = await storeSnapshot(snapshot);
    return jsonResponse({ ok: true, accepted: Boolean(accepted), receivedAt: snapshot.receivedAt });
  } catch { return jsonResponse({ error: '暂时无法保存摘要，请稍后重试。' }, 503); }
}
