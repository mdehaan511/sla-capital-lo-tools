/**
 * prospects-bulk-delete.mjs — POST /api/prospects-bulk-delete
 *
 * Body: { items: [{ slug, prospectId }, ...] }
 *
 * Removes multiple prospects in one request. Same auth model as the
 * single-delete endpoint: non-admins can only delete prospects under
 * their own slug (or legacy slug variants); admins can delete any.
 *
 * Returns: { ok, deleted, errors: [{slug,prospectId,reason}] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

const MAX_ITEMS = 100;

function ownerKeyForUser(user) {
  if (!user) return '';
  return keySafe(normalizeEmail(user.email));
}

function legacySlugForUser(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  if (meta.slug) return keySafe(String(meta.slug).toLowerCase());
  if (user.email) return keySafe(user.email.split('@')[0].toLowerCase());
  return '';
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const items = Array.isArray(body && body.items) ? body.items : [];
  if (!items.length)         return json(400, { error: 'items array required' });
  if (items.length > MAX_ITEMS) return json(400, { error: `Too many items (max ${MAX_ITEMS})` });

  const fullNameSlug = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || '';
  const okKeys = new Set([
    ownerKeyForUser(user),
    legacySlugForUser(user),
    fullNameSlug ? keySafe(String(fullNameSlug).toLowerCase()) : '',
  ].filter(Boolean));

  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const errors = [];
  let deleted = 0;

  for (const it of items) {
    if (!it || !it.slug || !it.prospectId) {
      errors.push({ slug: it && it.slug, prospectId: it && it.prospectId, reason: 'invalid item' });
      continue;
    }
    const slug = keySafe(String(it.slug).toLowerCase());
    if (!isAdmin(user) && !okKeys.has(slug)) {
      errors.push({ slug, prospectId: it.prospectId, reason: 'not authorized' });
      continue;
    }
    const key = `${slug}/${keySafe(it.prospectId)}`;
    try {
      await store.delete(key);
      deleted++;
    } catch (e) {
      errors.push({ slug, prospectId: it.prospectId, reason: e.message || 'delete failed' });
    }
  }

  return json(200, { ok: true, deleted, errors });
};
