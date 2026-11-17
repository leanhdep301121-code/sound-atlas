import { requireAdmin, apiError } from '../lib/admin-auth.mjs';
import { controlStore, ControlError, readControlJson } from '../lib/collector-control.mjs';
import { jsonResponse } from '../lib/live-store.mjs';
import { waitForInspection } from '../lib/read-query.mjs';
import { authorizeCollectorCommand, isPublicObservation } from '../lib/collector-access.mjs';

const fail = error => error instanceof ControlError ? jsonResponse({error:error.message},error.status) : apiError(error);
export async function POST(request) {
  const started=Date.now();
  try {
    const input=await readControlJson(request,20000);
    const { session }=await authorizeCollectorCommand(request,input.action);
    const queued=await controlStore.enqueue(input,session.id);
    const result=await waitForInspection(queued,id=>controlStore.command(id),{budgetMs:Math.max(0,8000-(Date.now()-started))});
    return jsonResponse(result,result.status==='done'?200:202);
  }catch(error){return fail(error);}
}
export async function GET(request) {
  try {
    const result=await controlStore.command(new URL(request.url).searchParams.get('id'));
    if(!isPublicObservation(result.action))await requireAdmin(request,{write:false});
    return jsonResponse(result);
  }catch(error){return fail(error);}
}
