import { requireAdmin, checkOrigin } from './admin-auth.mjs';

// Only these observation queries are public. Every other action remains protected,
// including purge previews and calibration analysis (which writes a report).
export const isPublicObservation = action =>
  ['overview', 'series', 'inspect', 'count', 'suspects', 'export'].includes(action);

export async function authorizeCollectorCommand(request, action) {
  if (!isPublicObservation(action)) return requireAdmin(request, { write: true });
  checkOrigin(request);
  return { session: { id: 'public-observation' } };
}
