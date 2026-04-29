/**
 * borrower-info-load-auth.mjs — GET /api/borrower-info-load-auth
 *
 * LO-authed endpoint. Returns the borrower-info record by clientId so the
 * LO can review/edit submitted data before generating the loan application.
 *
 * Query params: clientId, owner? (admin override)
 *
 * Response includes the SSN as plaintext under guarantors[i].ssn so the LO
 * can reveal it on the review page. The token is omitted from the response.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { decryptField } from './_shared/crypto.mjs';

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
  if (!clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const recordKey = `${ownerKey}/${keySafe(clientId)}`;
  let record = null;
  try { record = await store.get(recordKey, { type: 'json' }); } catch (_) {}
  if (!record) return json(404, { error: 'No borrower info on file for this client' });

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
