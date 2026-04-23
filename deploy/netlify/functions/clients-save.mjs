/**
 * clients-save.js — POST /api/clients-save
 *
 * Upsert a single client record. Body: the full client object.
 * Owner is inferred from the authenticated user's email; admins may set
 * `_owner` in the body to save on behalf of another LO.
 *
 * Client shape (unchanged from current frontend code):
 *   { id, email, firstName, lastName, phone, createdAt, createdBy, loans: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.id) return json(400, { error: 'client id required' });

  // Owner: default to current user. Admins may override via _owner.
  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) {
    owner = normalizeEmail(body._owner);
  }

  const record = { ...body };
  delete record._owner; // never persist

  const now = new Date().toISOString();
  if (!record.createdAt) record.createdAt = now;
  record.updatedAt = now;
  if (!record.createdBy) record.createdBy = owner;

  const ownerKey = keySafe(owner);
  const clientKey = keySafe(record.id);
  if (!ownerKey || !clientKey) return json(400, { error: 'Invalid owner or client id' });

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const key = `${ownerKey}/${clientKey}`;

  try {
    // If an existing record exists under this key owned by someone else,
    // only an admin may overwrite it.
    const existing = await store.get(key, { type: 'json' });
    if (existing && !isAdmin(user) && (existing.createdBy && normalizeEmail(existing.createdBy) !== owner)) {
      return json(403, { error: 'Not authorized to modify this client' });
    }
    await store.setJSON(key, record);
    return json(200, { ok: true, client: record });
  } catch (e) {
    console.error('clients-save error:', e);
    return json(500, { error: 'Failed to save client' });
  }
};
