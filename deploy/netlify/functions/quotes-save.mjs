/**
 * quotes-save.mjs — POST /api/quotes-save
 * Body: the full quote object (must include `id`).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs'; // Deploy 236.343

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.id) return json(400, { error: 'quote id required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);

  const record = { ...body };
  delete record._owner;

  const now = new Date().toISOString();
  if (!record.savedAt) record.savedAt = now;
  record.updatedAt = now;
  if (!record.createdBy) record.createdBy = owner;

  const ownerKey = keySafe(owner);
  const quoteKey = keySafe(record.id);
  if (!ownerKey || !quoteKey) return json(400, { error: 'Invalid owner or id' });

  const store = getStore({ name: 'quotes', consistency: 'strong' });
  const key = `${ownerKey}/${quoteKey}`;

  try {
    const existing = await store.get(key, { type: 'json' });
    if (existing && !isAdmin(user) && existing.createdBy && normalizeEmail(existing.createdBy) !== owner) {
      return json(403, { error: 'Not authorized' });
    }
    await store.setJSON(key, record);
    quotesIndex.upsertRecord(ownerKey, record).catch(() => {});
    return json(200, { ok: true, quote: record });
  } catch (e) {
    console.error('quotes-save error:', e);
    return json(500, { error: 'Failed to save quote' });
  }
};
