/**
 * borrower-info-load.mjs — GET /api/borrower-info-load?t=TOKEN
 *
 * Public endpoint (no auth). Token-only. Returns the borrower's saved data
 * for resumption. SSN fields come back masked (last 4 only) so even if the
 * link leaks the full SSN doesn't.
 *
 * Returns: { ok, prefill, data, status, expiresAt, propertyAddress, loName }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, keySafe } from './_shared/auth.mjs';
import { decryptField, maskSSN } from './_shared/crypto.mjs';
import { resolveByToken } from './_shared/borrower-info-token-index.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';
// Deploy 236.741 — re-derive the loan/property prefill from the LIVE loan on
// every load. The invite-time snapshot missed prefill improvements shipped
// after the link was sent (e.g. GUC ownLand, 236.740) and any LO edits to
// the loan made while the application was in flight.
import { applyLoanPrefill } from './_shared/borrower-prefill.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-load error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, null, { bucket: 'binfo-load', max: 200, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token) return json(400, { error: 'Missing token' });

  const record = await findByToken(token);
  if (!record) return json(404, { error: 'Link not found or expired' });
  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    return json(410, { error: 'This link has expired. Please contact your loan officer for a new link.' });
  }

  // Mask SSN fields in the returned data so even the borrower form only
  // shows a masked version when resuming. They can re-enter the full SSN
  // to update.
  const data = record.data ? maskGuarantorSSNs(record.data) : {};

  // Deploy 236.741 — refresh the loan/property half of the prefill from the
  // live loan record (best-effort; the stored snapshot is the fallback).
  let prefill = record.prefill || {};
  try {
    if (record.ownerKey && record.clientId && record.loanId) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const client = await clientsStore.get(record.ownerKey + '/' + keySafe(record.clientId), { type: 'json' });
      const loan = (client && Array.isArray(client.loans))
        ? client.loans.find((l) => l && l.id === record.loanId)
        : null;
      if (loan) {
        prefill = JSON.parse(JSON.stringify(prefill));
        applyLoanPrefill(prefill, loan);
      }
    }
  } catch (e) {
    console.warn('borrower-info-load prefill refresh failed:', e && e.message);
  }

  return json(200, {
    ok: true,
    status: record.status || 'pending',
    expiresAt: record.expiresAt,
    prefill,
    data,
    loName: record.requestedBy || record.ownerEmail || '',
    propertyAddress: (prefill && prefill.property && prefill.property.address) || '',
  });
}

// Resolve a record from its token. Deploy 172 added a token→recordKey
// index for O(1) lookup; if the token isn't indexed (legacy token from
// before the index existed) we fall back to walking the entire store
// and backfill the index so the next lookup is fast.
async function findByToken(token) {
  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  // Deploy 236.414 — shared bounded resolver (index fast path, budgeted
  // chunked walk, self-heal). Replaces the unbounded sequential walk
  // that could 504 on stale/rotated tokens.
  const resolved = await resolveByToken(store, token);
  return resolved.record;
}

// Mask SSNs in any guarantor records before returning to the browser
function maskGuarantorSSNs(data) {
  const out = JSON.parse(JSON.stringify(data));
  if (Array.isArray(out.guarantors)) {
    for (const g of out.guarantors) {
      if (g && g.ssn_enc) {
        // Replace stored encrypted blob with masked version for display
        const plain = decryptField(g.ssn_enc);
        g.ssn_masked = maskSSN(plain);
        delete g.ssn_enc;
      }
    }
  }
  return out;
}
