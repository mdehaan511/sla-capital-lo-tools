/**
 * brokers-save.mjs — POST /api/brokers-save
 *
 * Deploy 236 (Brokers Phase 1). Upsert a broker record. Body shape:
 *   {
 *     id?,            // existing broker id; omit / null to create
 *     name,           // required
 *     company?,
 *     email?,         // optional but recommended (used for legacy
 *                     // loan matching in Phase 5 migration)
 *     phone?,
 *     notes?,
 *     _owner?,        // admin-only override to save under another LO
 *   }
 *
 * Owner-scoped: LOs own their broker book the same way they own their
 * client book. Admins can save on behalf via _owner.
 *
 * Returns: { ok: true, broker: <full saved record> }
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
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !String(body.name || '').trim()) {
    return json(400, { error: 'name required' });
  }

  // Owner resolution
  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const now = new Date().toISOString();
  const id = String(body.id || '').trim() ||
             ('b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));

  const store = getStore({ name: 'brokers', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(id);

  // Read existing for createdAt preservation
  let existing = null;
  try { existing = await store.get(key, { type: 'json' }); } catch (_) {}

  const record = {
    id,
    name:      String(body.name      || '').trim(),
    company:   String(body.company   || '').trim(),
    email:     String(body.email     || '').toLowerCase().trim(),
    phone:     String(body.phone     || '').trim(),
    notes:     String(body.notes     || '').trim(),
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
    createdBy: (existing && existing.createdBy) || owner,
  };

  try {
    await store.setJSON(key, record);
  } catch (e) {
    console.error('brokers-save error:', e);
    return json(500, { error: 'Failed to save broker' });
  }

  return json(200, { ok: true, broker: record });
};
