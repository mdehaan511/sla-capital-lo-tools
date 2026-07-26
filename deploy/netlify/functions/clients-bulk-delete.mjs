/**
 * clients-bulk-delete.mjs — POST /api/clients-bulk-delete
 *
 * Deploy 236.230 — bulk delete for the Clients page. Body:
 *   { clientIds: [id1, id2, ...], owner? }
 *
 * Each client under the owner is deleted, plus its associated
 * borrower_info + signed_applications entries. Loans in the client
 * record die with it (they're nested inside the client).
 *
 * Deploy 236.234 — also sweeps the `quotes` store for any saved
 * quote whose stamped loanId matches a loan on a deleted client
 * OR whose street address matches a deleted loan's street. Without
 * this sweep, deleting a client left PHANTOM cards in the Pipeline
 * (the pipeline reads BOTH clients + quotes; a client-delete didn't
 * touch quotes). Prod incident: Randy Dargan / 335 Trevor St dupe
 * cleanup on 2026-07-07 left the wrong loan's quote as a phantom.
 *
 * loan_reviews / loan_access grants tied by loanId are still left
 * in place — they'd be orphaned but harmless, and cleaning them up
 * would slow a bulk delete considerably. A future sweep endpoint
 * can prune them.
 *
 * Response: { ok, deleted: [{clientId, ok, quotesSwept, error?}, ...] }
 * Auth: LO owns the clients (or admin owner-override).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write

function _normAddr(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function _streetPart(s) {
  return _normAddr(s).split(',')[0].trim();
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('clients-bulk-delete error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  const ids = Array.isArray(body.clientIds) ? body.clientIds.filter(Boolean) : [];
  if (!ids.length) return json(400, { error: 'clientIds required' });
  if (ids.length > 200) return json(413, { error: 'Max 200 per call' });

  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const biStore      = getStore({ name: 'borrower_info', consistency: 'strong' });
  const appStore     = getStore({ name: 'signed_applications', consistency: 'strong' });
  const quotesStore  = getStore({ name: 'quotes', consistency: 'strong' });

  // Deploy 236.234 — pre-load every saved quote for this owner so
  // we can sweep them per client without re-listing on each iteration.
  // Quote keys are ownerKey/quoteId; store owner is inferred from the
  // key prefix.
  const ownerQuotes = []; // [{ key, quote }]
  try {
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' }).catch(() => null);
      if (q) ownerQuotes.push({ key, quote: q });
    }
  } catch (_) { /* non-fatal — quote sweep is best-effort */ }

  const deleted = [];
  for (const id of ids) {
    const cid = String(id).trim();
    const key = ownerKey + '/' + keySafe(cid);
    try {
      const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!client) { deleted.push({ clientId: cid, ok: false, error: 'not_found' }); continue; }

      // Collect (loanId, streetKey) tuples for every loan on this
      // client so the quote sweep can match by either.
      const loanIds  = new Set();
      const streets  = new Set();
      if (Array.isArray(client.loans)) {
        for (const l of client.loans) {
          if (!l) continue;
          if (l.id) loanIds.add(l.id);
          const st = _streetPart(l.address);
          if (st) streets.add(st);
          // Clean up per-loan borrower_info + signed_applications.
          if (l.id) {
            try { await biStore.delete(ownerKey + '/' + keySafe(cid) + '/' + keySafe(l.id)); } catch (_) {}
            try { await biStore.delete(ownerKey + '/' + keySafe(cid)); } catch (_) {}
            try { await appStore.delete(ownerKey + '/' + keySafe(cid) + '/' + keySafe(l.id)); } catch (_) {}
          }
        }
      }

      // Sweep quotes matching any of this client's loans. Prefer loanId
      // (stamped on quotes saved after Deploy 236.7) over address match
      // to avoid nuking a legit unrelated quote at the same street.
      let quotesSwept = 0;
      for (const oq of ownerQuotes) {
        const q = oq.quote || {};
        const qLoanId = q.loanId || (q.formData && q.formData._editingLoanId);
        const qClientId = q.clientId || (q.formData && q.formData._editingClientId);
        const matchByLoanId   = qLoanId && loanIds.has(qLoanId);
        const matchByClientId = qClientId && qClientId === cid;
        const qStreet = _streetPart(q.address);
        // Address-only match ONLY when there's no loanId stamped on the
        // quote — that's the legacy case; a quote with a loanId that
        // doesn't match one of this client's loans is left alone.
        const matchByAddr = !qLoanId && qStreet && streets.has(qStreet);
        if (matchByLoanId || matchByClientId || matchByAddr) {
          try { await quotesStore.delete(oq.key); quotesSwept++; } catch (_) {}
        }
      }

      await clientsStore.delete(key);
      await pgMirror.deleteClientStrict(cid);
      deleted.push({
        clientId: cid,
        ok: true,
        loanCount: (client.loans || []).length,
        quotesSwept,
      });
    } catch (e) {
      deleted.push({ clientId: cid, ok: false, error: (e && e.message) || 'unknown' });
    }
  }

  return json(200, { ok: true, deleted });
}
