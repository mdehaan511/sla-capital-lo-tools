/**
 * loan-docs-delete.mjs — POST /api/loan-docs-delete
 *
 * Deploy 236.119 — delete both the metadata + file bytes for a
 * loan doc. Permission: uploader or admin.
 *
 * Body: { id, owner? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

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
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const metaStore  = getStore({ name: 'loan-docs',       consistency: 'strong' });
  const bytesStore = getStore({ name: 'loan-docs-files', consistency: 'strong' });
  const baseKey = ownerKey + '/' + keySafe(id);

  const doc = await metaStore.get(baseKey + '.json', { type: 'json' });
  if (!doc) return json(404, { error: 'Document not found' });

  // Permission: uploader or admin.
  const isUploader = String(doc.uploadedBy || '').toLowerCase() === selfEmail;
  if (!isUploader && !isAdmin(user)) {
    return json(403, { error: 'Only the uploader or an admin can delete this document' });
  }

  try {
    await bytesStore.delete(baseKey);
    await metaStore.delete(baseKey + '.json');
  } catch (e) {
    return json(500, { error: 'Failed to delete: ' + (e.message || 'unknown') });
  }

  return json(200, { ok: true, deletedId: id });
}
