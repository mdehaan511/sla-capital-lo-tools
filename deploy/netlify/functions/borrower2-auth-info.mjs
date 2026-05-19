/**
 * borrower2-auth-info.mjs — GET /api/borrower2-auth-info
 *
 * Deploy 180. Public endpoint (token-based). Returns the borrower-2
 * portion of a signed_applications record so the borrower2-auth.html
 * signing page can render their info, the prequal auth text, and the
 * consent checkbox.
 *
 * Query: ?t=TOKEN
 *
 * Returns: {
 *   propertyAddress, b1Name, b2Name, b2Email,
 *   alreadySigned: boolean,    // true if b2 already signed (locked out)
 *   expired: boolean,
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json } from './_shared/auth.mjs';

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error('borrower2-auth-info error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token) return json(400, { error: 'Missing token' });

  // Fast path: token → signedKey via index
  const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
  let signedKey = null;
  try {
    const idxRec = await idx.get(token, { type: 'json' });
    if (idxRec && idxRec.signedKey) signedKey = idxRec.signedKey;
  } catch (_) {}

  // Fallback: walk the signed_applications store. Slow but works for
  // legacy/lost-index tokens.
  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  let rec = null;
  if (signedKey) {
    try { rec = await store.get(signedKey, { type: 'json' }); } catch (_) {}
    if (rec && rec.borrower2 && rec.borrower2.token !== token) rec = null;
  }
  if (!rec) {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const r = await store.get(key, { type: 'json' });
      if (r && r.borrower2 && r.borrower2.token === token) {
        rec = r; signedKey = key;
        // Backfill the index for next time
        try { await idx.setJSON(token, { signedKey, expiresAt: r.borrower2.tokenExpiresAt }); } catch (_) {}
        break;
      }
    }
  }

  if (!rec || !rec.borrower2) return json(404, { error: 'Link not found' });

  const expired = rec.borrower2.tokenExpiresAt && new Date(rec.borrower2.tokenExpiresAt) < new Date();
  const alreadySigned = !!(rec.borrower2.audit && rec.borrower2.audit.signedAt);

  return json(200, {
    propertyAddress: rec.propertyAddress || '',
    b1Name: (rec.borrower1 && rec.borrower1.name) || '',
    b2Name: rec.borrower2.name || '',
    b2Email: rec.borrower2.email || '',
    alreadySigned,
    expired,
  });
}
