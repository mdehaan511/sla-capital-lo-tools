/**
 * envelopes.mjs — /api/envelopes
 *
 * Single endpoint that dispatches by method:
 *   GET  → list envelopes (filterable)
 *   POST → create new envelope (Phase 1: stub, no PandaDoc call)
 *
 * Phase 1 is intent-only. No PandaDoc API calls. Envelopes get
 * status='queued' and sit there. Phase 2 will wire in real sends.
 *
 * Storage: blob store `envelopes`, key `{ownerKey}/{envelopeId}`.
 *
 * --- POST body ---
 * {
 *   clientId, loanId,
 *   docs:    [ { kind: 'rate_sheet'|'loan_app', name? } ],
 *   signers: [ { firstName, lastName, email } ],
 *   message?,
 *   _owner?  // admin: send on behalf of this LO
 * }
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

  const now = new Date().toISOString();
  const envelopeId = genId();
  const record = {
    id: envelopeId,
    ownerKey,
    ownerEmail,
    requesterEmail,
    clientId: String(body.clientId),
    loanId: String(body.loanId),
    docs: docs.map((d) => ({
      kind: d.kind,
      name: String(d.name || (d.kind === 'rate_sheet' ? 'Rate Sheet' : 'Loan Application')).slice(0, 200),
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
    pandadocEnvelopeId: null,
    createdAt: now,
    history: [{
      ts: now,
      status: 'queued',
      note: 'Created (Phase 1 stub — no API call sent).',
    }],
  };

  try {
    const store = getStore({ name: 'envelopes', consistency: 'strong' });
    await store.setJSON(`${ownerKey}/${envelopeId}`, record);
  } catch (e) {
    console.error('envelopes create write failed:', e);
    return json(500, { error: 'Failed to save envelope' });
  }

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
  const pre = handleOptions(req); if (pre) return pre;

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (req.method === 'GET')  return handleList(req, user);
  if (req.method === 'POST') return handleCreate(req, context, user);
  return json(405, { error: 'Method not allowed' });
};
