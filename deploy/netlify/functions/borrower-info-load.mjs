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
import { handleOptions, json } from './_shared/auth.mjs';
import { decryptField, maskSSN } from './_shared/crypto.mjs';

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

  return json(200, {
    ok: true,
    status: record.status || 'pending',
    expiresAt: record.expiresAt,
    prefill: record.prefill || {},
    data,
    loName: record.requestedBy || record.ownerEmail || '',
    propertyAddress: (record.prefill && record.prefill.property && record.prefill.property.address) || '',
  });
}

// Walk the entire `borrower_info` store to find a record by token. With low
// cardinality this is fine; if it grows large we can keep a token→key index.
async function findByToken(token) {
  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const { blobs } = await store.list();
  for (const { key } of blobs) {
    const r = await store.get(key, { type: 'json' });
    if (r && r.token === token) return r;
  }
  return null;
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
