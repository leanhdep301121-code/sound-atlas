import { authorized, jsonResponse } from '../lib/live-store.mjs';
import { controlStore, ControlError, readControlJson } from '../lib/collector-control.mjs';
export async function POST(request) {
  const header=request.headers.get('authorization');
  if(!header?.startsWith('Bearer ')||!authorized(header,process.env.SOUND_ATLAS_INGEST_TOKEN)) return jsonResponse({error:'Unauthorized'},401);
  try { return jsonResponse(await controlStore.poll(await readControlJson(request))); }
  catch(error) { return jsonResponse({error:error instanceof ControlError?error.message:'远程采集服务暂时不可用。',serverTime:new Date().toISOString()},error instanceof ControlError?error.status:503); }
}
