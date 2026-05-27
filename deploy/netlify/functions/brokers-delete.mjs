/**
 * brokers-delete.mjs — POST /api/brokers-delete
 *
 * Deploy 236 (Brokers Phase 1). Hard-delete a broker record. Caller
 * passes { id, _owner? }.
 *
 * Loans that referenced this broker via brokerId will still have the
 * id string but lookups will return null. The frontend should still
 * render the inline broker fields stored on the loan record as a
 * fallback. Phase 2 wiring keeps both id + inline copies so this
 * delete doesn't orphan data.
 *
 * Returns: { ok: true }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.id) return json(400, { error: 'id required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'brokers', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(body.id);

  try {
    await store.delete(key);
  } catch (e) {
    console.error('brokers-delete error:', e);
    return json(500, { error: 'Failed to delete broker' });
  }

  return json(200, { ok: true });
};
