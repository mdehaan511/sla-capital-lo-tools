/**
 * borrower-info-save-auth.mjs — POST /api/borrower-info-save-auth
 *
 * LO-authed counterpart to borrower-info-save. Lets the LO edit a completed
 * borrower-info record before generating the loan application document.
 *
 * Body: { clientId, loanId, owner?, data: {...full data...} }
 *
 * Same SSN encryption and same client/loan write-back as the borrower path.
 * Does NOT trigger the "loan-app received" notification or the awaiting_app
 * → approved transition (those already fired when the borrower submitted).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { encryptField } from './_shared/crypto.mjs';
import { loadRecord, saveRecord } from './_shared/borrower-info-keys.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-save-auth error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });
  // loanId required since Deploy 168 (per-loan records). Accepted as
  // optional for one transition deploy so any in-flight LO edits don't
  // break; loadRecord falls back to the legacy per-client record.
  const loanId = body.loanId || null;

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  // Load client for loanId inference on legacy records
  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(`${ownerKey}/${keySafe(body.clientId)}`, { type: 'json' });
  } catch (_) {}

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(store, ownerKey, body.clientId, loanId, client);
  if (!record) return json(404, { error: 'No borrower info found' });

  // Merge incoming data: keep SSN encryption logic identical to borrower path
  const incoming = body.data || {};
  record.data = mergeData(record.data || {}, incoming);
  record.lastSavedAt = new Date().toISOString();
  record.updatedAt = record.lastSavedAt;
  // Mark that an LO has reviewed/touched this record
  record.lastEditedBy = user.email || '';
  record.lastEditedAt = record.lastSavedAt;

  // Resolve the loanId for the write key: prefer explicit body.loanId,
  // fall back to record.loanId. With Option B records this is always set.
  const targetLoanId = loanId || record.loanId;
  if (!targetLoanId) {
    return json(400, { error: 'loanId required (cannot resolve from record either)' });
  }

  try {
    await saveRecord(store, ownerKey, body.clientId, targetLoanId, record);
  } catch (e) {
    return json(500, { error: 'Failed to save edits' });
  }

  // Mirror borrower-profile fields back to the client record (item #6 sync).
  // We re-use the helper from borrower-info-save by re-implementing inline
  // — keeping the dependency contained.
  try {
    await syncBorrowerFieldsToClient(record);
  } catch (e) {
    console.warn('borrower-info-save-auth: client sync failed:', e);
  }

  return json(200, { ok: true });
}

function mergeData(existing, incoming) {
  const out = Object.assign({}, existing, incoming);
  if (Array.isArray(incoming.guarantors)) {
    const existingGs = Array.isArray(existing.guarantors) ? existing.guarantors : [];
    out.guarantors = incoming.guarantors.map((g, i) => {
      const exG = existingGs[i] || {};
      const merged = Object.assign({}, exG, g);
      const incomingSSN = String(g.ssn || '').trim();
      const looksLikeMask = /^\*{3}-?\*{2}-?\d{4}$/.test(incomingSSN) || incomingSSN.startsWith('***');
      if (incomingSSN && !looksLikeMask) {
        merged.ssn_enc = encryptField(incomingSSN);
      } else if (exG.ssn_enc && !merged.ssn_enc) {
        // Preserve previously-encrypted SSN if no new value came in
        merged.ssn_enc = exG.ssn_enc;
      }
      delete merged.ssn;
      delete merged.ssn_masked;
      return merged;
    });
  }
  return out;
}

async function syncBorrowerFieldsToClient(record) {
  if (!record.ownerKey || !record.clientId) return;
  const data = record.data || {};
  const g0 = (Array.isArray(data.guarantors) && data.guarantors[0]) || {};
  const clientUpdates = {};
  if (data.borrowerFirstName) clientUpdates.firstName = String(data.borrowerFirstName);
  if (data.borrowerLastName)  clientUpdates.lastName  = String(data.borrowerLastName);
  if (data.borrowerEmail)     clientUpdates.email     = String(data.borrowerEmail).toLowerCase().trim();
  if (data.borrowerPhone)     clientUpdates.phone     = String(data.borrowerPhone);
  if (g0.dob)        clientUpdates.dob           = String(g0.dob);
  if (g0.fico)       clientUpdates.fico          = String(g0.fico);
  if (g0.marital)    clientUpdates.maritalStatus = String(g0.marital);
  if (g0.usCitizen)  clientUpdates.usCitizen     = String(g0.usCitizen);
  if (g0.address || g0.city || g0.state || g0.zip) {
    clientUpdates.homeAddress = {
      street: g0.address || '',
      city:   g0.city    || '',
      state:  g0.state   || '',
      zip:    g0.zip     || '',
    };
  }
  if (g0.flips !== undefined && g0.flips !== '')     clientUpdates.flips   = String(g0.flips);
  if (g0.rentals !== undefined && g0.rentals !== '') clientUpdates.rentals = String(g0.rentals);
  if (g0.ssn_enc) clientUpdates.ssn_enc = g0.ssn_enc;
  if (Object.keys(clientUpdates).length === 0) return;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${record.ownerKey}/${record.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client) return;
  let changed = false;
  Object.keys(clientUpdates).forEach((k) => {
    const incoming = clientUpdates[k];
    const existing = client[k];
    const same = (typeof incoming === 'object')
      ? (JSON.stringify(existing) === JSON.stringify(incoming))
      : (existing === incoming);
    if (!same) { client[k] = incoming; changed = true; }
  });
  if (changed) {
    client.updatedAt = new Date().toISOString();
    await clientsStore.setJSON(clientKey, client);
  }
}
