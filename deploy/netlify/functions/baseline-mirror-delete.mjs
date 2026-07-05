/**
 * baseline-mirror-delete.mjs — POST /api/baseline-mirror-delete
 *
 * Deploy 236.176 — remove a single loan from the mirror. Called
 * when the Baseline diagnostic shows the loan no longer exists in
 * Baseline (HTTP 404 on GET /loan/{Id}) — the mirror row is a
 * fossil from a prior sync that Baseline has since deleted or
 * renamed. Cleans up the dashboard so ghost LEADs stop showing.
 *
 * Body: { id }
 * Auth: admin only.
 */
import { handleOptions, json, requireAuth, isAdmin, readJsonBody } from './_shared/auth.mjs';
import { deleteMirroredLoan } from './_shared/baseline-mirror.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-mirror-delete error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req);
  if (!body || !body.id) return json(400, { error: 'id required' });

  const ok = await deleteMirroredLoan(String(body.id).trim());
  return json(200, { ok, id: body.id });
}
