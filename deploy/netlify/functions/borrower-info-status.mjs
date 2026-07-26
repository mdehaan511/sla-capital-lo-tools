/**
 * borrower-info-status.mjs — GET or POST /api/borrower-info-status
 *
 * Authed (LO).
 *
 * GET ?clientId=...&loanId=... → returns status + summary + data (with SSN
 *                       MASKED for safety in browser; full SSN never sent
 *                       to frontend). Pass &full=1 to also return full
 *                       SSN — only allowed for admins, used by the doc
 *                       generator. loanId is required since Deploy 168
 *                       (per-loan records).
 * POST { clientId, loanId, data } → LO edits the borrower's submitted data.
 *
 * The "see + edit" UX requirement means the LO can correct typos before
 * generating the doc. SSN edits replace the encrypted blob.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { encryptField, decryptField, maskSSN } from './_shared/crypto.mjs';
import { loadRecord, saveRecord } from './_shared/borrower-info-keys.mjs';
// Deploy 236.169 — Access Refactor PR #1. Defensive check via
// canReadLoan on GET path. Existing LOs / admins pass through the
// short-circuit; the borrower path (loan_access grant) lights up
// once PR #3 issues borrower Identity accounts. No behavior
// change for current callers.
import { canReadLoan } from './_shared/access.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-status error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (req.method === 'GET') return await handleGet(req, user);
  if (req.method === 'POST') return await handlePost(req, user);
  return json(405, { error: 'Method not allowed' });
}

async function handleGet(req, user) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const loanId   = url.searchParams.get('loanId');  // Deploy 168
  const wantFull = url.searchParams.get('full') === '1';
  if (!clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  // Load client for loadRecord's loanId inference on legacy records
  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(`${ownerKey}/${keySafe(clientId)}`, { type: 'json' });
  } catch (_) {}

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(store, ownerKey, clientId, loanId, client);
  if (!record) return json(200, { exists: false });

  // Deploy 236.169 — layered access check. LOs / admins pass on
  // the ownerKey fast path; borrowers pass via a loan_access grant.
  // Fails closed for anyone else.
  const loan = client && Array.isArray(client.loans)
    ? client.loans.find((l) => l && l.id === loanId) || { id: loanId, ownerKey }
    : { id: loanId, ownerKey };
  const perm = await canReadLoan(user, loan, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  const data = record.data ? unmaskOrMask(record.data, wantFull && isAdmin(user)) : {};
  // Deploy 236.44 — surface the existing borrower-facing link so the
  // LO can copy it without having to regenerate (and invalidate) the
  // token. Caller is already LO-authed via requireAuth, so exposing
  // the token to them is no different from emailing it out in the
  // first place.
  const siteUrl = String(process.env.URL || '').replace(/\/$/, '');
  const link = (siteUrl && record.token)
    ? `${siteUrl}/borrower-info.html?t=${encodeURIComponent(record.token)}`
    : null;
  return json(200, {
    exists: true,
    status: record.status || 'pending',
    sentAt: record.sentAt,
    completedAt: record.completedAt,
    expiresAt: record.expiresAt,
    lastSavedAt: record.lastSavedAt,
    borrowerEmail: record.borrowerEmail,
    requestedBy: record.requestedBy,
    prefill: record.prefill || {},
    loanId: record.loanId,
    token: record.token || null,
    link,
    data,
  });
}

async function handlePost(req, user) {
  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });
  const loanId = body.loanId || null;

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(`${ownerKey}/${keySafe(body.clientId)}`, { type: 'json' });
  } catch (_) {}

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(store, ownerKey, body.clientId, loanId, client);
  if (!record) return json(404, { error: 'No borrower info on file' });

  // Same merge logic as the borrower save endpoint
  record.data = mergeData(record.data || {}, body.data || {});
  record.lastSavedAt = new Date().toISOString();
  record.lastEditedBy = user.email || '';
  record.updatedAt = record.lastSavedAt;

  const targetLoanId = loanId || record.loanId;
  if (!targetLoanId) {
    return json(400, { error: 'loanId required (cannot resolve from record)' });
  }
  await saveRecord(store, ownerKey, body.clientId, targetLoanId, record);
  return json(200, { ok: true, status: record.status });
}

function mergeData(existing, incoming) {
  const out = Object.assign({}, existing, incoming);
  if (Array.isArray(incoming.guarantors)) {
    const existingGs = Array.isArray(existing.guarantors) ? existing.guarantors : [];
    out.guarantors = incoming.guarantors.map((g, i) => {
      const exG = existingGs[i] || {};
      const merged = Object.assign({}, exG, g);
      const ssn = String(g.ssn || '').trim();
      const mask = /^\*{3}-?\*{2}-?\d{4}$/.test(ssn) || ssn.startsWith('***');
      if (ssn && !mask) merged.ssn_enc = encryptField(ssn);
      delete merged.ssn;
      return merged;
    });
  }
  return out;
}

function unmaskOrMask(data, returnFull) {
  const out = JSON.parse(JSON.stringify(data));
  if (Array.isArray(out.guarantors)) {
    for (const g of out.guarantors) {
      if (g && g.ssn_enc) {
        const plain = decryptField(g.ssn_enc);
        if (returnFull) g.ssn_full = plain;
        g.ssn_masked = maskSSN(plain);
        delete g.ssn_enc;
      }
    }
  }
  return out;
}
