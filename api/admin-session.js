import { login, logout, requireAdmin, apiError, HttpError } from '../lib/admin-auth.mjs';
import { jsonResponse } from '../lib/live-store.mjs';

export async function GET(request) {
  try { const { csrf } = await requireAdmin(request); return jsonResponse({ authenticated: true, csrf }); }
  catch (error) { return error instanceof HttpError && error.status === 401 ? jsonResponse({ authenticated: false }, 401) : apiError(error); }
}
export async function POST(request) { try { return await login(request); } catch (error) { return apiError(error); } }
export async function DELETE(request) { try { return await logout(request); } catch (error) { return apiError(error); } }
