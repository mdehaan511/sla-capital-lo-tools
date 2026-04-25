/**
 * prospects-delete.mjs — POST /api/prospects-delete
 * Body: { slug, prospectId }   (slug is the storage prefix as returned by prospects-list)
 *
 * Non-admins may only delete prospects whose key matches either their email-keyed
 * prefix (new) or their legacy slug.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

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

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.slug || !body.prospectId) return json(400, { error: 'slug and prospectId required' });

  const slug = keySafe(String(body.slug).toLowerCase());
  if (!isAdmin(user)) {
    const ok = slug === ownerKeyForUser(user) || slug === legacySlugForUser(user);
    if (!ok) return json(403, { error: 'Not authorized' });
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
