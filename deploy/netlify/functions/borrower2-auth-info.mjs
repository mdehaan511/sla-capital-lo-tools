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

  // Deploy 236.83 — generalized from "borrower 2 only" to any
  // secondary borrower (2/3/4). The token index now carries `pos`
  // alongside `signedKey` so we know which borrowerN field on the
  // record this token belongs to. Tokens written before 236.83 don't
  // have `pos` — we default those to 2 (the only position that
  // existed at the time).
  const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
  let signedKey = null;
  let pos = 2;
  try {
    const idxRec = await idx.get(token, { type: 'json' });
    if (idxRec && idxRec.signedKey) {
      signedKey = idxRec.signedKey;
      if (idxRec.pos && [2, 3, 4].includes(idxRec.pos)) pos = idxRec.pos;
    }
  } catch (_) {}

  // Fallback: walk the signed_applications store. Slow but works for
  // legacy/lost-index tokens. Checks borrower2/3/4 fields.
  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  let rec = null;
  if (signedKey) {
    try { rec = await store.get(signedKey, { type: 'json' }); } catch (_) {}
    const bField = rec && rec['borrower' + pos];
    if (rec && (!bField || bField.token !== token)) rec = null;
  }
  if (!rec) {
    const { blobs } = await store.list();
    outer: for (const { key } of blobs) {
      const r = await store.get(key, { type: 'json' });
      if (!r) continue;
      for (const tryPos of [2, 3, 4]) {
        const b = r['borrower' + tryPos];
        if (b && b.token === token) {
          rec = r; signedKey = key; pos = tryPos;
          try { await idx.setJSON(token, { signedKey, pos, expiresAt: b.tokenExpiresAt }); } catch (_) {}
          break outer;
        }
      }
    }
  }

  const bField = rec && rec['borrower' + pos];
  if (!rec || !bField) return json(404, { error: 'Link not found' });

  const expired = bField.tokenExpiresAt && new Date(bField.tokenExpiresAt) < new Date();
  const alreadySigned = !!(bField.audit && bField.audit.signedAt);

  return json(200, {
    propertyAddress: rec.propertyAddress || '',
    b1Name: (rec.borrower1 && rec.borrower1.name) || '',
    // Borrower-pos-aware fields. b2Name / b2Email kept for back-compat
    // with the existing borrower2-auth.html page; new code can read
    // borrowerPos + name/email directly.
    b2Name: bField.name || '',
    b2Email: bField.email || '',
    name: bField.name || '',
    email: bField.email || '',
    borrowerPos: pos,
    alreadySigned,
    expired,
  });
}
