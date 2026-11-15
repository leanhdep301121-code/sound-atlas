import { requireAdmin, apiError } from '../lib/admin-auth.mjs';
import { controlStore, ControlError, readControlJson } from '../lib/collector-control.mjs';
import { jsonResponse } from '../lib/live-store.mjs';

const fail = error => error instanceof ControlError ? jsonResponse({error:error.message},error.status) : apiError(error);
export async function POST(request) {
  try {
    const { session }=await requireAdmin(request,{write:true});
    return jsonResponse(await controlStore.enqueue(await readControlJson(request,20000),session.id),202);
  }catch(error){return fail(error);}
}
export async function GET(request) {
  try {
    await requireAdmin(request,{write:false});
    return jsonResponse(await controlStore.command(new URL(request.url).searchParams.get('id')));
  }catch(error){return fail(error);}
}
