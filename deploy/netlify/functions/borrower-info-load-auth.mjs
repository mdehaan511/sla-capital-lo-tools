/**
 * borrower-info-load-auth.mjs — GET /api/borrower-info-load-auth
 *
 * LO-authed endpoint. Returns the borrower-info record for a specific
 * loan (Deploy 168 — was per-client before; loanId is now required).
 * Used by the LO when reviewing/editing submitted data before
 * generating the loan application.
 *
 * Query params: clientId, loanId, owner? (admin override)
 *
 * Response includes the SSN as plaintext under guarantors[i].ssn so the LO
 * can reveal it on the review page. The token is omitted from the response.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { decryptField } from './_shared/crypto.mjs';
import { loadRecord } from './_shared/borrower-info-keys.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-load-auth error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const loanId   = url.searchParams.get('loanId');
  if (!clientId) return json(400, { error: 'clientId required' });
  // loanId is required since Deploy 168 (per-loan records). For
  // backward compatibility with any callers that haven't been updated
  // yet, we accept the call but the response will rely on loadRecord's
  // legacy fallback to find the right per-client record.
  // TODO: tighten to a hard requirement once all callers are updated.

  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  // Load the client so loadRecord can infer loanId for legacy records
  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(`${ownerKey}/${keySafe(clientId)}`, { type: 'json' });
  } catch (_) {}

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(store, ownerKey, clientId, loanId, client);
  if (!record) return json(404, { error: 'No borrower info on file for this loan' });

  const data = record.data ? unmaskGuarantorSSNs(record.data) : {};

  // Strip the token from the response — LO doesn't need it
  return json(200, {
    ok: true,
    clientId: record.clientId,
    loanId: record.loanId,
    ownerKey: record.ownerKey,
    status: record.status || 'pending',
    sentAt: record.sentAt,
    completedAt: record.completedAt,
    lastSavedAt: record.lastSavedAt,
    expiresAt: record.expiresAt,
    prefill: record.prefill || {},
    data,
  });
}

// For LO-authed access we DECRYPT the SSN so the LO can reveal it on the
// review page. (Borrower-side load uses a separate function that masks.)
function unmaskGuarantorSSNs(data) {
  const out = JSON.parse(JSON.stringify(data));
  if (Array.isArray(out.guarantors)) {
    for (const g of out.guarantors) {
      if (g && g.ssn_enc) {
        try {
          g.ssn = decryptField(g.ssn_enc);
        } catch (e) {
          g.ssn = '';
        }
        // Also include the masked version for default display
        g.ssn_masked = maskSSN(g.ssn);
        delete g.ssn_enc;
      }
    }
  }
  return out;
}

function maskSSN(ssn) {
  if (!ssn) return '';
  const last4 = ssn.replace(/\D/g, '').slice(-4);
  return last4 ? '***-**-' + last4 : '';
}
