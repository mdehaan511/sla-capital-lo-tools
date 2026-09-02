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
import { prospectsIndex } from './_shared/prospects-index.mjs'; // Deploy 236.796

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
  if (!body || !body.slug || !body.prospectId) return json(400, { error: 'slug and prospectId required' });

  const slug = keySafe(String(body.slug).toLowerCase());
  if (!isAdmin(user)) {
    const okKeys = new Set();
    okKeys.add(ownerKeyForUser(user));
    if (user.email) okKeys.add(keySafe(user.email.split('@')[0].toLowerCase()));
    const fullName = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || '';
    if (fullName) okKeys.add(keySafe(String(fullName).toLowerCase()));
    if (user.user_metadata && user.user_metadata.slug) {
      okKeys.add(keySafe(String(user.user_metadata.slug).toLowerCase()));
    }
    if (!okKeys.has(slug)) return json(403, { error: 'Not authorized' });
  }

  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const key = `${slug}/${keySafe(body.prospectId)}`;
  try {
    // Deploy 236.796 (Mike) — was the blob delete ONLY. prospects-list serves
    // the admin all-LOs view straight off the materialized prospects-index and
    // does NOT rebuild on stale (236.344 removed the background rebuild to
    // avoid holding the Lambda), so a record that stayed in the index was
    // rendered forever: the New Application card came right back on reload and
    // the delete looked broken. quotes-delete got this exact fix in 236.428;
    // the prospect endpoints never did.
    const existed = !!(await store.get(key, { type: 'json' }).catch(() => null));
    await store.delete(key);
    await prospectsIndex.removeRecord(slug, body.prospectId);
    // Report whether a blob was actually there. Netlify Blobs' delete is
    // idempotent — it resolves happily on a key that never existed — so a
    // wrong slug used to look identical to a real delete. The index cleanup
    // above runs either way, so retrying on a ghost now clears it for good.
    return json(200, { ok: true, deleted: body.prospectId, alreadyGone: !existed });
  } catch (e) {
    console.error('prospects-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
