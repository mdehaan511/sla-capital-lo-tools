/**
 * prospects-delete.js — POST /api/prospects-delete
 * Body: { slug, prospectId }
 * Non-admins may only delete prospects under their own slug.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, keySafe,
} from './_shared/auth.mjs';

function slugForUser(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  if (meta.slug) return keySafe(String(meta.slug).toLowerCase());
  if (user.email) return keySafe(user.email.split('@')[0].toLowerCase());
  return '';
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.slug || !body.prospectId) return json(400, { error: 'slug and prospectId required' });

  const slug = keySafe(String(body.slug).toLowerCase());
  if (!isAdmin(user) && slug !== slugForUser(user)) {
    return json(403, { error: 'Not authorized' });
  }

  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const key = `${slug}/${keySafe(body.prospectId)}`;
  try {
    await store.delete(key);
    return json(200, { ok: true });
  } catch (e) {
    console.error('prospects-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
