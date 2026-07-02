/**
 * envelopes.mjs — /api/envelopes
 *
 * GET  → list envelopes (filterable)
 * POST → create a new envelope (status \u2018queued\u2019, awaiting send)
 *
 * NATIVE eSIGN \u2014 Deploy 185. Replaces the PandaDoc-backed
 * implementation. PDFs uploaded by the LO are stashed in
 * `envelope-pdfs`; on /api/envelopes-send each signer gets a unique
 * token + invitation email. When signers click their link and sign,
 * /api/envelope-sign records the event. Once all signers have signed,
 * the original PDFs are stamped with an appended Signatures page and
 * emailed to everyone.
 *
 * Legacy PandaDoc envelopes (pre-Deploy 185) remain readable in the
 * list \u2014 they show with `envelopeMode: 'pandadoc-legacy'` and are
 * effectively read-only.
 *
 * Storage: blob store `envelopes`, key `{ownerKey}/{envelopeId}`.
 *
 * --- POST body ---
 * {
 *   clientId, loanId,
 *   docs:    [ { kind: 'rate_sheet'|'loan_app', name?, pdfBase64 } ],
 *   signers: [ { firstName, lastName, email } ],
 *   message?,
 *   _owner?  // admin: send on behalf of this LO
 * }
 */
import { getStore } from '@netlify/blobs';
// Deploy 236.169 — Access Refactor PR #1. The wantAll ('?all=1')
// path is now gated by canListAllClients() so cross-LO listing
// stays centralized. The ownerOverride cross-LO path still uses
// isAdmin directly (it's an admin-only escape hatch, unchanged).
import { canListAllClients } from './_shared/access.mjs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { hashPdf } from './_shared/native-esign.mjs';

const VALID_DOC_KINDS = new Set(['rate_sheet', 'loan_app']);

function isValidEmail(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(t);
}

function genId() {
  return 'env_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

// Deploy 186: validate + coerce the sigCoords object from the sizer.
// Returns null if the input is missing/malformed. The eSign backend
// stamper checks for null and falls back to "no on-page stamp" if so.
function sanitizeSigCoords(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const numeric = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const required = ['pageNumber', 'pageWidth', 'pageHeight', 'sigX', 'sigYFromTop', 'dateX', 'dateYFromTop'];
  const out = {};
  for (const k of required) {
    const n = numeric(raw[k]);
    if (n == null) return null;
    out[k] = n;
  }
  // Bounds sanity: page must be reasonable Letter/A4-ish
  if (out.pageWidth  < 200 || out.pageWidth  > 2000) return null;
  if (out.pageHeight < 200 || out.pageHeight > 3000) return null;
  if (out.pageNumber < 1   || out.pageNumber > 50)   return null;
  return out;
}

async function handleCreate(req, context, user) {
  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid request' });

  const url = new URL(req.url);
  const ownerOverride = url.searchParams.get('owner') || body._owner;
  const requesterEmail = normalizeEmail(user.email);
  let ownerEmail = requesterEmail;
  if (ownerOverride && normalizeEmail(ownerOverride) !== requesterEmail) {
    if (!isAdmin(user)) return json(403, { error: 'Only admins can send on behalf of another LO' });
    ownerEmail = normalizeEmail(ownerOverride);
  }
  const ownerKey = keySafe(ownerEmail);

  const docs = Array.isArray(body.docs) ? body.docs : [];
  if (docs.length === 0) return json(400, { error: 'At least one document is required' });
  if (docs.length > 5) return json(400, { error: 'Too many documents in one envelope' });
  for (const d of docs) {
    if (!d || !VALID_DOC_KINDS.has(d.kind)) {
      return json(400, { error: 'Invalid document kind: ' + (d && d.kind) });
    }
    if (!d.pdfBase64) {
      return json(400, { error: 'Each document must include pdfBase64 bytes' });
    }
  }

  const signers = Array.isArray(body.signers) ? body.signers : [];
  if (signers.length === 0) return json(400, { error: 'At least one signer is required' });
  if (signers.length > 6) return json(400, { error: 'Too many signers (max 6)' });
  for (const s of signers) {
    if (!s || !isValidEmail(s.email)) {
      return json(400, { error: 'Invalid signer email: ' + (s && s.email) });
    }
    if (!s.firstName || !s.lastName) {
      return json(400, { error: 'Signer first and last name required' });
    }
  }
  const emailSet = new Set();
  for (const s of signers) {
    const e = normalizeEmail(s.email);
    if (emailSet.has(e)) return json(400, { error: 'Duplicate signer email: ' + e });
    emailSet.add(e);
  }

  if (!body.clientId || !body.loanId) {
    return json(400, { error: 'clientId and loanId required' });
  }

  // Deploy 236.42 — status gate dropped per Mike. Rate sheets are now
  // sendable in any loan status (previously required 'approved' / In
  // Processing). The verification still loads the client + loan to
  // make sure the IDs are real; we just no longer reject on status.
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });
    const client = await clientsStore.get(`${ownerKey}/${body.clientId}`, { type: 'json' });
    if (!client) return json(404, { error: 'Client not found' });
    const loan = (client.loans || []).find((l) => l.id === body.loanId);
    if (!loan) return json(404, { error: 'Loan not found' });
  } catch (e) {
    console.error('envelopes-create loan lookup failed:', e);
    return json(500, { error: 'Could not load loan record' });
  }

  const now = new Date().toISOString();
  const envelopeId = genId();

  const pdfsByDoc = {};
  for (let i = 0; i < docs.length; i++) {
    pdfsByDoc[i] = docs[i].pdfBase64;
  }

  const record = {
    id: envelopeId,
    ownerKey,
    ownerEmail,
    requesterEmail,
    clientId: String(body.clientId),
    loanId: String(body.loanId),
    docs: docs.map((d, i) => ({
      kind: d.kind,
      name: String(d.name || (d.kind === 'rate_sheet' ? 'Rate Sheet' : 'Loan Application')).slice(0, 200),
      hadPdf: true,
      pdfHash: hashPdf(d.pdfBase64),
      pdfSize: Buffer.from(d.pdfBase64, 'base64').length,
      // Deploy 186: signature-line coordinates captured by the sizer
      // when the PDF was generated. The eSign backend uses these to
      // stamp the typed signature + signing date on the visible
      // "Borrower Signature: ___ Date: ___" line. Optional \u2014 if
      // absent, only the appended signature page shows the signature.
      sigCoords: sanitizeSigCoords(d.sigCoords),
    })),
    signers: signers.map((s, i) => ({
      firstName: String(s.firstName || '').slice(0, 80),
      lastName:  String(s.lastName  || '').slice(0, 80),
      email:     normalizeEmail(s.email),
      role: i === 0 ? 'borrower' : 'cosigner' + (i + 1),
      signingOrder: i + 1,
      token: null,
      tokenExpiresAt: null,
      audit: null,
      signedAt: null,
      invitedAt: null,
      resendCount: 0,
    })),
    message: String(body.message || '').slice(0, 2000),
    status: 'queued',
    statusUpdatedAt: now,
    envelopeMode: 'native',
    sendError: null,
    createdAt: now,
    history: [{
      ts: now, status: 'queued',
      note: 'Created \u2014 PDFs stashed, awaiting send call.',
    }],
  };

  const store = getStore({ name: 'envelopes', consistency: 'strong' });
  const blobKey = `${ownerKey}/${envelopeId}`;
  try {
    await store.setJSON(blobKey, record);
  } catch (e) {
    console.error('envelopes create write failed:', e);
    return json(500, { error: 'Failed to save envelope: ' + (e.message || 'unknown') });
  }

  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  await Promise.all(Object.entries(pdfsByDoc).map(async ([docIdx, b64]) => {
    const pdfKey = `${ownerKey}/${envelopeId}/${docIdx}`;
    try { await pdfStore.set(pdfKey, b64); }
    catch (e) { console.error('PDF stash failed for', pdfKey, e); }
  }));

  return json(200, { ok: true, envelope: record });
}

async function handleList(req, user) {
  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const ownerOverride = url.searchParams.get('owner');
  const clientId = url.searchParams.get('clientId') || '';
  const loanId   = url.searchParams.get('loanId')   || '';
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));

  const store = getStore({ name: 'envelopes', consistency: 'eventual' });

  let prefix;
  if (wantAll) {
    const perm = canListAllClients(user);
    if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Admin only for ?all=1' });
    prefix = '';
  } else if (ownerOverride) {
    if (!isAdmin(user) && normalizeEmail(ownerOverride) !== normalizeEmail(user.email)) {
      return json(403, { error: "Cannot view another LO's envelopes" });
    }
    prefix = keySafe(normalizeEmail(ownerOverride)) + '/';
  } else {
    prefix = keySafe(normalizeEmail(user.email)) + '/';
  }

  let envelopes = [];
  try {
    const { blobs } = await store.list(prefix ? { prefix } : {});
    const keys = blobs.map((b) => b.key).slice(0, limit * 2);
    envelopes = await Promise.all(keys.map(async (k) => {
      try { return await store.get(k, { type: 'json' }); }
      catch (_) { return null; }
    }));
    envelopes = envelopes.filter(Boolean);
    if (clientId) envelopes = envelopes.filter((e) => e.clientId === clientId);
    if (loanId)   envelopes = envelopes.filter((e) => e.loanId === loanId);
    // Strip large fields for list view: full audit JSON is heavy, and
    // tokens shouldn\u2019t leak in a list response (they\u2019re for the
    // signer\u2019s email link only).
    envelopes = envelopes.map((e) => ({
      ...e,
      signers: (e.signers || []).map((s) => ({
        firstName: s.firstName, lastName: s.lastName, email: s.email,
        role: s.role, signingOrder: s.signingOrder,
        signedAt: s.signedAt || (s.audit && s.audit.signedAt) || null,
        invitedAt: s.invitedAt,
        resendCount: s.resendCount,
        hasSigned: !!(s.audit && s.audit.signedAt),
      })),
      // Legacy compat: surface the historical pandadocMode field as
      // envelopeMode so the UI can fan out on type. For pre-Deploy-185
      // records, envelopeMode is absent and we synthesize it.
      envelopeMode: e.envelopeMode || (e.pandadocMode ? 'pandadoc-legacy' : 'native'),
    }));
    envelopes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    envelopes = envelopes.slice(0, limit);
  } catch (e) {
    console.error('envelopes list error:', e);
    return json(500, { error: 'Failed to load envelopes' });
  }

  return json(200, { envelopes });
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (req.method === 'GET')  return await handleList(req, user);
    if (req.method === 'POST') return await handleCreate(req, context, user);
    return json(405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('envelopes top-level error:', e);
    return json(500, {
      error: 'Server error: ' + ((e && e.message) || 'unknown'),
      stack: String((e && e.stack) || '').split('\n').slice(0, 5).join(' | ').slice(0, 500),
    });
  }
};
