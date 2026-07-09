/**
 * loan-docs-save.mjs — POST /api/loan-docs-save
 *
 * Deploy 236.119 — update metadata on an existing loan doc
 * (rename filename, change category, edit notes). Does NOT
 * replace the bytes; for that, delete + re-upload.
 *
 * Body: { id, owner?, filename?, category?, notes? }
 * Response: { ok: true, doc }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266

const VALID_CATEGORIES = ['borrower', 'property', 'title', 'insurance', 'loan-app', 'rate-sheet', 'closing', 'other'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const id = String(body.id || '').trim();
  if (!id) return json(400, { error: 'id required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const metaStore = getStore({ name: 'loan-docs', consistency: 'strong' });
  const metaKey = ownerKey + '/' + keySafe(id) + '.json';
  const doc = await metaStore.get(metaKey, { type: 'json' });
  if (!doc) return json(404, { error: 'Document not found' });

  if (body.filename !== undefined) doc.filename = String(body.filename || '').slice(0, 255);
  if (body.category !== undefined) {
    const c = String(body.category || '').toLowerCase().trim();
    if (VALID_CATEGORIES.indexOf(c) < 0) return json(400, { error: 'Invalid category: ' + c });
    doc.category = c;
  }
  if (body.notes !== undefined) doc.notes = String(body.notes || '').trim();
  doc.updatedAt = new Date().toISOString();
  doc.updatedBy = user.email || '';

  try { await metaStore.setJSON(metaKey, doc); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, doc });
}
