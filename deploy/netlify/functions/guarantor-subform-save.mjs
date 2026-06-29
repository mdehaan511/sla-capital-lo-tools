/**
 * guarantor-subform-save.mjs — POST /api/guarantor-subform-save
 *
 * Deploy 236.128 — public token-keyed save endpoint for the
 * additional-guarantor sub-form. Token resolves to a guarantor
 * client record (via guarantor-subform-token-idx); we merge the
 * incoming fields into that record, update the per-loan sub-form
 * status, and bump timestamps. No authentication — token IS auth.
 *
 * Body: {
 *   t: <token>,
 *   fields: {
 *     firstName?, lastName?, email?, phone?,
 *     dob?, fico?, ssn_enc? (server-encrypted by the sub-form),
 *     homeAddress?, twoYearAddress?, prevAddress?,
 *     mailingSameAsHome?, mailingAddress?,
 *     maritalStatus?, usCitizen?, flips?, rentals?,
 *     declarations?: { bankruptcy7yr, foreclosure7yr, partyToLawsuit, ... }
 *   },
 *   markComplete?: boolean   // true on the final submit step
 * }
 *
 * Response: { ok: true, guarantor, status }
 *
 * Note: SSN encryption is currently a placeholder (server stores
 * whatever the sub-form posts). Credit Auth e-sign + actual
 * SSN_ENCRYPTION_KEY round-trip lands in 236.129 along with the
 * loan-application bundle regeneration.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody } from './_shared/auth.mjs';

const ALLOWED_TOP = [
  'firstName', 'lastName', 'email', 'phone',
  'dob', 'fico', 'ssn_enc',
  'twoYearAddress', 'mailingSameAsHome',
  'maritalStatus', 'usCitizen', 'flips', 'rentals',
];
const ALLOWED_ADDR_BLOCKS = ['homeAddress', 'prevAddress', 'mailingAddress'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('guarantor-subform-save top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const token = String(body.t || '').trim();
  if (!token) return json(400, { error: 'Missing token' });
  const fields = (body.fields && typeof body.fields === 'object') ? body.fields : {};

  const idxStore = getStore({ name: 'guarantor-subform-token-idx', consistency: 'strong' });
  let idx;
  try { idx = await idxStore.get(token, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read token index' }); }
  if (!idx) return json(404, { error: 'Invalid or expired link' });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = idx.ownerKey + '/' + idx.clientId.replace(/[^a-zA-Z0-9_-]/g, '_');
  let guarantor;
  try { guarantor = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read guarantor record' }); }
  if (!guarantor) return json(404, { error: 'Guarantor record not found' });

  const now = new Date().toISOString();
  let changed = false;

  ALLOWED_TOP.forEach((k) => {
    if (fields[k] !== undefined && fields[k] !== null) {
      const v = String(fields[k]).trim();
      if (guarantor[k] !== v) {
        guarantor[k] = v;
        changed = true;
      }
    }
  });

  ALLOWED_ADDR_BLOCKS.forEach((k) => {
    const incoming = fields[k];
    if (!incoming || typeof incoming !== 'object') return;
    const cleaned = {
      street: String(incoming.street || '').trim(),
      city:   String(incoming.city   || '').trim(),
      state:  String(incoming.state  || '').trim(),
      zip:    String(incoming.zip    || '').trim(),
    };
    if (JSON.stringify(guarantor[k] || null) !== JSON.stringify(cleaned)) {
      guarantor[k] = cleaned;
      changed = true;
    }
  });

  if (fields.declarations && typeof fields.declarations === 'object') {
    const cleanedDecl = {};
    ['bankruptcy7yr','foreclosure7yr','partyToLawsuit','delinquentFederalDebt',
     'obligatedToForeclosed','outstandingJudgments','intendToOccupy']
      .forEach((d) => {
        if (fields.declarations[d] === 'yes' || fields.declarations[d] === 'no') {
          cleanedDecl[d] = fields.declarations[d];
        }
      });
    if (JSON.stringify(guarantor.declarations || null) !== JSON.stringify(cleanedDecl)) {
      guarantor.declarations = cleanedDecl;
      changed = true;
    }
  }

  // Per-loan sub-form state bookkeeping.
  guarantor._subFormTokensByLoan = guarantor._subFormTokensByLoan || {};
  const state = guarantor._subFormTokensByLoan[idx.loanId] || { token, createdAt: now };
  state.lastSavedAt = now;
  if (body.markComplete === true) {
    state.status = 'completed';
    state.completedAt = now;
  } else if (state.status !== 'completed') {
    state.status = 'in_progress';
  }
  guarantor._subFormTokensByLoan[idx.loanId] = state;
  guarantor.updatedAt = now;
  changed = true; // status bump alone counts

  try { await clientsStore.setJSON(clientKey, guarantor); }
  catch (e) { return json(500, { error: 'Failed to save guarantor: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, guarantor, status: state.status });
}
