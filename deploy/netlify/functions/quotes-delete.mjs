/**
 * quotes-delete.mjs — POST /api/quotes-delete
 * Body: { quoteId, _owner? }
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
  if (!body || !body.quoteId) return json(400, { error: 'quoteId required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);

  const store = getStore({ name: 'quotes', consistency: 'strong' });
  const key = `${keySafe(owner)}/${keySafe(body.quoteId)}`;

  try {
    const existing = await store.get(key, { type: 'json' });
    if (!existing) return json(404, { error: 'Quote not found' });
    if (!isAdmin(user) && existing.createdBy && normalizeEmail(existing.createdBy) !== owner) {
      return json(403, { error: 'Not authorized' });
    }
    await store.delete(key);
    return json(200, { ok: true, deleted: body.quoteId });
  } catch (e) {
    console.error('quotes-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
