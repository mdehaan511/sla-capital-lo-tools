/**
 * borrower-info-list.mjs — GET /api/borrower-info-list
 *
 * Authed (LO). Returns all borrower-info records for the current user
 * (or all LOs if admin passes ?all=1).
 *
 * Returns: { records: [{clientId, ownerKey, status, sentAt, lastSavedAt, completedAt, expiresAt, token, url}, ...] }
 *
 * SSN_enc fields are stripped — never returned to client.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-list error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1' && isAdmin(user);
  const ownerKey = keySafe(normalizeEmail(user.email));
  const origin = url.origin;

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const { blobs } = await store.list();
  const out = [];

  await Promise.all(blobs.map(async ({ key }) => {
    const slashIdx = key.indexOf('/');
    if (slashIdx < 0) return;
    const recordOwner = key.slice(0, slashIdx);
    if (!wantAll && recordOwner !== ownerKey) return;

    const r = await store.get(key, { type: 'json' });
    if (!r) return;
    out.push({
      clientId: r.clientId,
      ownerKey: r.ownerKey,
      borrowerEmail: r.borrowerEmail || '',
      status: r.status,
      sentAt: r.sentAt,
      lastSavedAt: r.lastSavedAt,
      completedAt: r.completedAt,
      expiresAt: r.expiresAt,
      token: r.token, // The LO needs this to copy/share the link
      url: origin + '/borrower-info.html?t=' + encodeURIComponent(r.token || ''),
    });
  }));

  return json(200, { records: out });
}
