import { SNAPSHOT_KEY, redis, publicSnapshot, jsonResponse } from '../lib/live-store.mjs';

export async function GET() {
  try {
    const stored = await redis(['GET', SNAPSHOT_KEY]);
    return jsonResponse(publicSnapshot(stored ? JSON.parse(stored) : null));
  } catch { return jsonResponse({ error: '实时数据暂时无法读取，请稍后重试。' }, 503); }
}
