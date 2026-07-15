/**
 * client-get.mjs — GET /api/client-get?clientId=&owner=
 *
 * Deploy 236.345 — single-record fetch. Was: loan-details.js and
 * the sizers called /api/clients?all=1 (a full cross-owner blob
 * walk, ~2,852 gets at Mike's scale) to find ONE (clientId, loanId)
 * pair. This endpoint reads the single `<ownerKey>/<clientId>` blob
 * directly — O(1) regardless of dataset size.
 *
 * Returns the FULL client record (loans[], notesLog, formData
 * snapshots, everything) — the pages that use this need the full
 * shape. SSN_enc is replaced with hasSSN=true (same sanitize
 * pattern as clients-list).
 *
 * Cross-namespace recovery for admin/processor whose payload drops
 * the owner param (matches Deploy 236.317 pattern used across the
 * loan-* endpoints).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('client-get error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get('clientId') || '').trim();
  const ownerParam = String(url.searchParams.get('owner') || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (ownerParam && ownerParam !== selfEmail && ownerParam !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(ownerParam));
  }

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(clientId);
  let record = await store.get(key, { type: 'json' }).catch(() => null);

  // Cross-namespace recovery — admin/processor whose owner param
  // was wrong / dropped still finds the client under whichever
  // namespace holds it.
  if (!record && canOverrideOwner(user).ok) {
    try {
      const { blobs } = await store.list();
      const wantSuffix = '/' + keySafe(clientId);
      for (const { key: blobKey } of blobs) {
        if (!blobKey.endsWith(wantSuffix)) continue;
        const rec = await store.get(blobKey, { type: 'json' }).catch(() => null);
        if (rec && rec.id === clientId) {
          record = rec;
          const slash = blobKey.indexOf('/');
          if (slash > 0) ownerKey = blobKey.slice(0, slash);
          break;
        }
      }
    } catch (_) { /* fall through to 404 */ }
  }

  if (!record) return json(404, { error: 'Client not found' });

  // Sanitize SSN_enc → hasSSN. Match clients-list sanitize().
  const out = Object.assign({}, record);
  if (out.ssn_enc) { out.hasSSN = true; delete out.ssn_enc; }
  else             { out.hasSSN = false; }

  return json(200, { client: out, ownerKey });
}
