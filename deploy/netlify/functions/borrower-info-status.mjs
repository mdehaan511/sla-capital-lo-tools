/**
 * borrower-info-status.mjs — GET or POST /api/borrower-info-status
 *
 * Authed (LO).
 *
 * GET ?clientId=...  → returns status + summary + data (with SSN MASKED for
 *                       safety in browser; full SSN never sent to frontend).
 *                       Pass &full=1 to also return full SSN — only allowed
 *                       for admins, and only used by the doc generator.
 * POST { clientId, data } → LO edits the borrower's submitted data. Same
 *                       SSN mask handling as the borrower-save endpoint.
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
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (req.method === 'GET') return await handleGet(req, user);
  if (req.method === 'POST') return await handlePost(req, user);
  return json(405, { error: 'Method not allowed' });
}

async function handleGet(req, user) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const wantFull = url.searchParams.get('full') === '1';
  if (!clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const recordKey = `${ownerKey}/${keySafe(clientId)}`;
  let record = null;
  try { record = await store.get(recordKey, { type: 'json' }); } catch (_) {}
  if (!record) return json(200, { exists: false });

  const data = record.data ? unmaskOrMask(record.data, wantFull && isAdmin(user)) : {};
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
    data,
  });
}

async function handlePost(req, user) {
  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const recordKey = `${ownerKey}/${keySafe(body.clientId)}`;
  let record = null;
  try { record = await store.get(recordKey, { type: 'json' }); } catch (_) {}
  if (!record) return json(404, { error: 'No borrower info on file' });

  // Same merge logic as the borrower save endpoint
  record.data = mergeData(record.data || {}, body.data || {});
  record.lastSavedAt = new Date().toISOString();
  record.lastEditedBy = user.email || '';
  record.updatedAt = record.lastSavedAt;

  await store.setJSON(recordKey, record);
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
