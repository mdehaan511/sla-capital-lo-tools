/**
 * loan-review-guidelines-delete.mjs — POST /api/loan-review-guidelines-delete
 * Body: { investor }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isSuperAdmin,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });
  const body = await readJsonBody(req);
  if (!body || !body.investor) return json(400, { error: 'investor required' });
  const store = getStore({ name: 'loan-review-guidelines', consistency: 'strong' });
  await store.delete(String(body.investor).toLowerCase().trim());
  return json(200, { ok: true });
}
