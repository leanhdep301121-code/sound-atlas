import { requireAdmin, hasAdminSession, apiError } from '../lib/admin-auth.mjs';
import { controlStore } from '../lib/collector-control.mjs';
import { jsonResponse } from '../lib/live-store.mjs';
export async function GET(request) {
  try {
    if(!hasAdminSession(request))await requireAdmin(request,{write:false});
    const [auth,state]=await Promise.allSettled([
      requireAdmin(request,{write:false}),
      controlStore.state({includeView:new URL(request.url).searchParams.get('view')==='manage'}),
    ]);
    if(auth.status==='rejected')throw auth.reason;
    if(state.status==='rejected')throw state.reason;
    return jsonResponse(state.value);
  }catch(error){return apiError(error);}
}
