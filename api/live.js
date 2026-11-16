import { SNAPSHOT_KEY, redis, publicSnapshot, jsonResponse } from '../lib/live-store.mjs';

export async function GET(request) {
  try {
    const stored = await redis(['GET', SNAPSHOT_KEY]);
    const snapshot = publicSnapshot(stored ? JSON.parse(stored) : null);
    const since = request?.url ? new URL(request.url).searchParams.get('history') : null;
    if (since && since === snapshot.historyRevision) {
      const {days, ...head} = snapshot;
      return jsonResponse({...head, historyUnchanged: true});
    }
    return jsonResponse(snapshot);
  } catch { return jsonResponse({ error: '实时数据暂时无法读取，请稍后重试。' }, 503); }
}
