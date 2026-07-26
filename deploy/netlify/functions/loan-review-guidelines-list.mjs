/**
 * loan-review-guidelines-list.mjs — GET /api/loan-review-guidelines
 *
 * Super-admin only. Returns the metadata for every investor-guideline
 * PDF currently in the loan-review-guidelines blob store. Used by
 * the admin page to show "what's currently active for the AI".
 *
 * Response: { guidelines: [{ investor, filename, sizeBytes, uploadedAt, uploadedBy }] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isSuperAdmin,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-review-guidelines-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const store = getStore({ name: 'loan-review-guidelines', consistency: 'strong' });
  const { blobs } = await store.list();

  const guidelines = [];
  for (const { key } of blobs) {
    const r = await store.getWithMetadata(key, { type: 'arrayBuffer' }).catch(function () { return null; });
    if (!r) continue;
    const meta = r.metadata || {};
    guidelines.push({
      investor:   meta.investor || key,
      filename:   meta.filename || '',
      sizeBytes:  (r.data && r.data.byteLength) || 0,
      uploadedAt: meta.uploadedAt || '',
      uploadedBy: meta.uploadedBy || '',
    });
  }

  guidelines.sort((a, b) => String(a.investor).localeCompare(String(b.investor)));
  return json(200, { guidelines });
}
