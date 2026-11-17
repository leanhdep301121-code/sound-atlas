import { apiError } from '../lib/admin-auth.mjs';
import { controlStore } from '../lib/collector-control.mjs';
import { jsonResponse } from '../lib/live-store.mjs';
export async function GET(request) {
  try {
    return jsonResponse(await controlStore.state({includeView:new URL(request.url).searchParams.get('view')==='manage'}));
  }catch(error){return apiError(error);}
}
