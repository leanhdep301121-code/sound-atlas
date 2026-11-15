import { requireAdmin, apiError } from '../lib/admin-auth.mjs';
import { controlStore } from '../lib/collector-control.mjs';
import { jsonResponse } from '../lib/live-store.mjs';
export async function GET(request) {
  try {
    await requireAdmin(request,{write:false});
    return jsonResponse(await controlStore.state());
  }catch(error){return apiError(error);}
}
