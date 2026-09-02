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
import { prospectsIndex } from './_shared/prospects-index.mjs'; // Deploy 236.796

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
  const indexPairs = [];
  let deleted = 0;
  let alreadyGone = 0;

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
      // Netlify Blobs' delete resolves on a key that never existed, so the old
      // `deleted++` counted a wrong slug as a success. Check first so the
      // caller can tell "removed it" from "nothing was there".
      const existed = !!(await store.get(key, { type: 'json' }).catch(() => null));
      await store.delete(key);
      if (existed) deleted++; else alreadyGone++;
      indexPairs.push({ ownerKey: slug, id: it.prospectId });
    } catch (e) {
      errors.push({ slug, prospectId: it.prospectId, reason: e.message || 'delete failed' });
    }
  }

  // Deploy 236.796 (Mike) — the missing half. prospects-list serves the admin
  // all-LOs view from the materialized prospects-index and does NOT rebuild on
  // stale (236.344), so every record left in the index kept rendering as a New
  // Application card: Mike selected four, got "Bulk delete complete", and all
  // four were back on the next load. One batched read-modify-write for the
  // whole selection rather than 2 blob ops per item.
  let indexRemoved = 0;
  if (indexPairs.length) {
    const r = await prospectsIndex.removeRecords(indexPairs);
    indexRemoved = r.removed;
    if (r.error) errors.push({ reason: 'index cleanup failed: ' + r.error });
  }

  return json(200, { ok: true, deleted, alreadyGone, indexRemoved, errors });
};
