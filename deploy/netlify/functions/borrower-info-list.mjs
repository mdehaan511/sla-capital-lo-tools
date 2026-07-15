/**
 * borrower-info-list.mjs — GET /api/borrower-info-list
 *
 * Authed (LO). Returns all borrower-info records for the current user
 * (or all LOs if admin passes ?all=1).
 *
 * Since Deploy 168, records are per-loan: one entry per (clientId,
 * loanId) combination. Records that pre-date the deploy without a
 * loanId still appear here with loanId=null; consumers fall back to
 * clientId-based lookup for those.
 *
 * Returns: { records: [{clientId, loanId, ownerKey, status, ...}, ...] }
 *
 * SSN_enc fields are stripped — never returned to client.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
// Deploy 236.170 — Access Refactor PR #2.
import { canListAllClients } from './_shared/access.mjs';
// Deploy 236.343 — index fast path so cross-owner reads are one
// blob fetch instead of walking the whole borrower_info store.
import { borrowerInfoIndex } from './_shared/borrower-info-index.mjs';

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
  const wantAll = url.searchParams.get('all') === '1' && canListAllClients(user).ok;
  const ownerKey = keySafe(normalizeEmail(user.email));
  const origin = url.origin;

  // Deploy 236.343 — admin (all-scope) reads from the index blob.
  // Non-admin still scans by owner prefix (fast enough for a single
  // LO's records).
  if (wantAll) {
    let byOwner = null;
    try {
      const { index, exists } = await borrowerInfoIndex.readIndex();
      if (exists && index && index.byOwner) {
        // Deploy 236.344 — no bg rebuild on stale (Lambda holds).
        byOwner = index.byOwner;
      } else {
        const stats = await borrowerInfoIndex.rebuildIndex();
        const fresh = await borrowerInfoIndex.readIndex();
        if (fresh && fresh.index && fresh.index.byOwner) byOwner = fresh.index.byOwner;
      }
    } catch (e) {
      console.warn('borrower-info-list: index read failed, falling to walk:', e && e.message);
    }
    if (byOwner) {
      const seen = new Set();
      const out = [];
      for (const o of Object.keys(byOwner)) {
        for (const r of byOwner[o]) {
          if (!r) continue;
          const dedupeKey = (r.ownerKey || o) + '|' + (r.clientId || '') + '|' + (r.loanId || '');
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          out.push({
            clientId: r.clientId,
            loanId:   r.loanId || null,
            ownerKey: r.ownerKey || o,
            borrowerEmail: r.borrowerEmail || '',
            status: r.status,
            sentAt: r.sentAt,
            lastSavedAt: r.lastSavedAt,
            completedAt: r.completedAt,
            expiresAt: r.expiresAt,
            token: r.token,
            url: origin + '/borrower-info.html?t=' + encodeURIComponent(r.token || ''),
          });
        }
      }
      return json(200, { records: out, _fromIndex: true });
    }
    // Fall through to walk if index unavailable.
  }

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const { blobs } = wantAll
    ? await store.list()
    : await store.list({ prefix: ownerKey + '/' });
  const out = [];
  const seen = new Set();
  await Promise.all(blobs.map(async ({ key }) => {
    const slashIdx = key.indexOf('/');
    if (slashIdx < 0) return;
    const recordOwner = key.slice(0, slashIdx);
    if (!wantAll && recordOwner !== ownerKey) return;

    const r = await store.get(key, { type: 'json' });
    if (!r) return;
    const dedupeKey = (r.ownerKey || '') + '|' + (r.clientId || '') + '|' + (r.loanId || '');
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    out.push({
      clientId: r.clientId,
      loanId:   r.loanId || null,
      ownerKey: r.ownerKey,
      borrowerEmail: r.borrowerEmail || '',
      status: r.status,
      sentAt: r.sentAt,
      lastSavedAt: r.lastSavedAt,
      completedAt: r.completedAt,
      expiresAt: r.expiresAt,
      token: r.token,
      url: origin + '/borrower-info.html?t=' + encodeURIComponent(r.token || ''),
    });
  }));

  return json(200, { records: out });
}
