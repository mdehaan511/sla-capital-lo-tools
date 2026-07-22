/**
 * admin-nuke-client-address.mjs — POST /api/admin-nuke-client-address
 *
 * One-off cleanup tool. Given a client + a property address, removes
 * EVERY loan on that client whose address matches, plus every quote
 * in the same owner's namespace whose address matches. Writes through
 * to blob + PG + clients-index + quotes-index so nothing lingers.
 *
 * Used to clean up test contamination — repeated Save Quote clicks
 * in a broken flow can accumulate dozens of duplicate loans at the
 * same address on a broker's client. This wipes them so the flow
 * can be tested from a clean baseline.
 *
 * Body: { clientId, owner, addressContains }
 *   - addressContains matches case-insensitively as a substring of
 *     the loan/quote address. e.g. '430 School St' matches
 *     '430 School St, Barrackville, WV, 26559, USA'.
 *
 * Response: {
 *   ok, ownerKey, clientId,
 *   deletedLoanIds: [...],     // loan ids removed from client.loans[]
 *   deletedQuoteIds: [...],    // quote blob keys removed
 *   pgLoansDeleted: N,         // rows removed from Postgres loans table
 *   remainingLoanIds: [...],   // what's left on the client
 * }
 *
 * Admin only. Fatal errors return 500; partial (e.g. some quote
 * deletes failed) still returns 200 with the partial totals so the
 * caller can retry.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { upsertClient as indexUpsertClient } from './_shared/clients-index.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-nuke-client-address error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const clientId = String(body.clientId || '').trim();
  const ownerParam = String(body.owner || '').trim();
  const needle = String(body.addressContains || '').trim().toLowerCase();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!needle)   return json(400, { error: 'addressContains required' });

  const ownerKey = ownerParam ? keySafe(normalizeEmail(ownerParam)) : keySafe(normalizeEmail(user.email));

  // ── 1. Read + prune client's loans[] ───────────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const blobKey = ownerKey + '/' + keySafe(clientId);
  const rec = await clientsStore.get(blobKey, { type: 'json' }).catch(() => null);
  if (!rec) return json(404, { error: 'Client not found at ' + blobKey });
  const before = Array.isArray(rec.loans) ? rec.loans : [];
  const matchLoan = (l) => l && String(l.address || '').toLowerCase().includes(needle);
  const deletedLoans = before.filter(matchLoan);
  const remainingLoans = before.filter((l) => !matchLoan(l));
  const deletedLoanIds = deletedLoans.map((l) => l.id).filter(Boolean);

  rec.loans = remainingLoans;
  rec.updatedAt = new Date().toISOString();
  try {
    await clientsStore.setJSON(blobKey, rec);
    // Also upsert the client to PG so its updatedAt reconciles + the
    // strict PG reconciler drops any loans no longer in loans[] via
    // the standard cascade. Belt-and-suspenders with the explicit
    // db.del below.
    await pgMirror.upsertClientWithLoansStrict(ownerKey, rec);
  } catch (e) {
    return json(500, { error: 'Blob/PG write failed: ' + (e && e.message) });
  }
  indexUpsertClient(ownerKey, rec).catch(() => {});

  // ── 2. Delete matching loans from Postgres (belt-and-suspenders) ─
  let pgLoansDeleted = 0;
  for (const lid of deletedLoanIds) {
    try {
      await db.del('loans', { id: lid });
      pgLoansDeleted++;
    } catch (e) {
      console.warn('admin-nuke: PG loan delete failed', lid, e && e.message);
    }
  }

  // ── 3. Sweep matching quotes in this owner's namespace ─────────
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const deletedQuoteIds = [];
  try {
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' }).catch(() => null);
      if (!q) continue;
      const qAddr = String(q.address || (q.formData && q.formData.address) || '').toLowerCase();
      if (!qAddr.includes(needle)) continue;
      try {
        await quotesStore.delete(key);
        deletedQuoteIds.push(key);
      } catch (e) {
        console.warn('admin-nuke: quote delete failed', key, e && e.message);
      }
    }
  } catch (e) {
    console.warn('admin-nuke: quote sweep failed:', e && e.message);
  }

  return json(200, {
    ok: true,
    ownerKey,
    clientId,
    deletedLoanIds,
    deletedQuoteIds,
    pgLoansDeleted,
    remainingLoanIds: remainingLoans.map((l) => l.id).filter(Boolean),
  });
}
