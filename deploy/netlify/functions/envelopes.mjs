/**
 * envelopes.mjs — /api/envelopes
 *
 * Single endpoint that dispatches by method:
 *   GET  → list envelopes (filterable)
 *   POST → create new envelope; calls PandaDoc if configured.
 *
 * Behavior depends on PandaDoc config (see _shared/pandadoc.mjs):
 *   - PANDADOC_API_KEY unset → status stays 'queued' (Phase 1 stub)
 *   - PANDADOC_DRY_RUN!=false → 'queued' + send-log entry, no real call
 *   - Live mode → real PandaDoc envelope, status flips to 'sent'
 *
 * For Phase 2 we only send the rate sheet PDF. Loan-app docs in the request
 * are tracked but not sent through PandaDoc — the DOCX template lacks
 * embedded signature anchor tags, so it would fall through as a borrower-
 * adds-own-fields experience. Once anchor tags are added to the template,
 * this restriction can be lifted.
 *
 * Storage: blob store `envelopes`, key `{ownerKey}/{envelopeId}`.
 *
 * --- POST body ---
 * {
 *   clientId, loanId,
 *   docs:    [ { kind: 'rate_sheet'|'loan_app', name?, pdfBase64? } ],
 *   signers: [ { firstName, lastName, email } ],
 *   message?,
 *   _owner?  // admin: send on behalf of this LO
 * }
 *
 * pdfBase64 is required for rate_sheet kind in non-stub mode.
 *
 * --- GET query ---
 *   ?clientId=...&loanId=...   filter to one loan
 *   ?owner=...                 admin: scope to one LO
 *   ?all=1                     admin: every envelope
 *   ?limit=N                   default 200, max 1000
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { sendEnvelope, pandadocStatus, mapStatus } from './_shared/pandadoc.mjs';

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

  // Validate docs
  const docs = Array.isArray(body.docs) ? body.docs : [];
  if (docs.length === 0) return json(400, { error: 'At least one document is required' });
  if (docs.length > 5) return json(400, { error: 'Too many documents in one envelope' });
  for (const d of docs) {
    if (!d || !VALID_DOC_KINDS.has(d.kind)) {
      return json(400, { error: 'Invalid document kind: ' + (d && d.kind) });
    }
  }

  // Validate signers
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

  // Refuse exact duplicate emails — that confuses PandaDoc later
  const emailSet = new Set();
  for (const s of signers) {
    const e = normalizeEmail(s.email);
    if (emailSet.has(e)) return json(400, { error: 'Duplicate signer email: ' + e });
    emailSet.add(e);
  }

  if (!body.clientId || !body.loanId) {
    return json(400, { error: 'clientId and loanId required' });
  }

  // Defense-in-depth: enforce the same "In Processing only" gate the UI
  // shows. Without this an LO could craft a request to send a rate sheet
  // for a loan still in Active or already Closed.
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });
    const client = await clientsStore.get(`${ownerKey}/${body.clientId}`, { type: 'json' });
    if (!client) return json(404, { error: 'Client not found' });
    const loan = (client.loans || []).find((l) => l.id === body.loanId);
    if (!loan) return json(404, { error: 'Loan not found' });
    if (loan.status !== 'approved') {
      return json(400, {
        error: 'Loan must be in In Processing status to send for signature. Current status: ' + (loan.status || 'unknown'),
      });
    }
  } catch (e) {
    console.error('envelopes-create status check failed:', e);
    return json(500, { error: 'Could not verify loan status' });
  }

  const now = new Date().toISOString();
  const envelopeId = genId();
  const pdStatus = pandadocStatus();

  // Extract PDF base64s before building the persisted record. The PDFs
  // are stashed in a side blob store so the envelope JSON stays small
  // and the frontend can call the slower /api/envelopes-send next.
  // This pattern keeps create() under 1 second, well clear of any
  // Netlify function timeout — the actual PandaDoc upload happens in
  // the follow-up send call.
  const pdfsByDoc = {}; // index → base64
  for (let i = 0; i < docs.length; i++) {
    if (docs[i].pdfBase64) {
      pdfsByDoc[i] = docs[i].pdfBase64;
    }
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
      // hadPdf: true tells the LO this doc actually had bytes; useful for
      // distinguishing dry-run/stub envelopes from live ones at a glance.
      hadPdf: !!pdfsByDoc[i],
    })),
    signers: signers.map((s, i) => ({
      firstName: String(s.firstName || '').slice(0, 80),
      lastName:  String(s.lastName  || '').slice(0, 80),
      email:     normalizeEmail(s.email),
      role: 'borrower',
      signingOrder: i + 1,
    })),
    message: String(body.message || '').slice(0, 2000),
    status: 'queued',
    statusUpdatedAt: now,
    pandadocMode: pdStatus.mode,
    pandadocDocumentId: null, // populated after the send call runs
    sendError: null,
    createdAt: now,
    history: [{
      ts: now,
      status: 'queued',
      note: pdStatus.mode === 'disabled'
        ? 'Created (Phase 1 stub — PandaDoc not configured).'
        : pdStatus.mode === 'dry-run'
        ? 'Created (dry-run mode — send pending).'
        : 'Created — PDF stashed, awaiting send call.',
    }],
  };

  // Persist the envelope record (no PDFs in JSON — those are in a side store).
  const store = getStore({ name: 'envelopes', consistency: 'strong' });
  const blobKey = `${ownerKey}/${envelopeId}`;
  try {
    await store.setJSON(blobKey, record);
  } catch (e) {
    console.error('envelopes create write failed:', e);
    return json(500, { error: 'Failed to save envelope: ' + (e.message || 'unknown') });
  }

  // Stash each doc's PDF bytes in a separate blob store so envelopes-send
  // can retrieve them. Keys: pdfs/{ownerKey}/{envelopeId}/{docIndex}
  // We don't fail the whole request if a stash fails — log and let the
  // user retry via the (forthcoming) send call.
  if (Object.keys(pdfsByDoc).length > 0) {
    const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
    await Promise.all(Object.entries(pdfsByDoc).map(async ([docIdx, b64]) => {
      const pdfKey = `${ownerKey}/${envelopeId}/${docIdx}`;
      try {
        await pdfStore.set(pdfKey, b64);
      } catch (e) {
        console.error('PDF stash failed for', pdfKey, e);
      }
    }));
  }

  // Return immediately. The frontend will call /api/envelopes-send next
  // to actually trigger the PandaDoc upload+send. This split keeps each
  // call short and well under any Netlify timeout.
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
    if (!isAdmin(user)) return json(403, { error: 'Admin only for ?all=1' });
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
    envelopes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    envelopes = envelopes.slice(0, limit);
  } catch (e) {
    console.error('envelopes list error:', e);
    return json(500, { error: 'Failed to load envelopes' });
  }

  return json(200, { envelopes });
}

export default async (req, context) => {
  // Wrap the entire handler so an uncaught exception still returns JSON
  // rather than letting Netlify render an HTML error page. The frontend
  // surfaces 'Bad response' for non-JSON, which is unhelpful for debugging
  // — we'd rather see the actual stack-trace fragment in the toast.
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
