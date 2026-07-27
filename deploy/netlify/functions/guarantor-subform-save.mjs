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
import {
  CREDIT_AUTH_CONSENT_VERSION,
  generateCreditAuthPdf,
  sealCreditAuthAudit,
} from './_shared/guarantor-credit-auth.mjs';
import { getClientIp, getUserAgent } from './_shared/native-esign.mjs';
import { encryptField } from './_shared/crypto.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';

// Deploy 236.146 — `ssn_enc` removed from the generic top-level
// whitelist. Frontend sends the raw SSN under `ssn_enc` (legacy
// name) or `ssn`; either way we route it through encryptField()
// below and store the AES-GCM ciphertext as ssn_enc on the client.
// Earlier deploys were storing whatever the frontend posted as-is,
// which meant plaintext SSNs sat on the client record.
const ALLOWED_TOP = [
  'firstName', 'lastName', 'email', 'phone',
  'dob', 'fico',
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
  const _rl = await checkRateLimit(req, null, { bucket: 'gsub-save', max: 120, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

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

  // Deploy 236.146 — SSN encryption. Frontend sends the raw SSN
  // under either `ssn` or the legacy `ssn_enc` key (the sub-form
  // page predates this fix and still uses ssn_enc). Strip the
  // mask formatting, encrypt with the SSN_ENCRYPTION_KEY-derived
  // key, store as ciphertext on guarantor.ssn_enc.
  // Deploy 236.247 — REMOVED the "explicit clear on empty" branch.
  // The old branch wiped any existing ssn_enc whenever fields.ssn
  // came in empty. Combined with the sub-form's SSN input having no
  // value= attr, every re-render (fired by twoYear / mailSame radio
  // clicks) cleared the visible SSN and the next save wiped it from
  // the client record — so LOs kept having to call guarantors to
  // re-collect it. Now: only WRITE a new SSN when 9 digits are
  // present; empty or partial input is ignored.
  const rawSsn = fields.ssn != null ? fields.ssn : fields.ssn_enc;
  if (rawSsn != null) {
    const digits = String(rawSsn).replace(/\D/g, '');
    if (digits.length === 9) {
      const enc = encryptField(digits);
      if (enc && guarantor.ssn_enc !== enc) {
        guarantor.ssn_enc = enc;
        guarantor.ssnLast4 = digits.slice(-4);
        changed = true;
      }
    }
    // Partial (<9) or empty digit count: silently ignore.
    // Never wipe a stored SSN from a sub-form submission.
  }

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

  // Deploy 236.129 — on final submit (markComplete), the guarantor
  // must also accept the Credit Authorization + type their signature.
  // We generate a signed Credit Auth PDF, store it in the new
  // guarantor-credit-auth-pdfs blob store keyed by token, and write
  // the audit record alongside the per-loan sub-form state.
  let creditAuthAudit = null;
  if (body.markComplete === true) {
    const signerName = String(body.signerName || '').trim();
    const consentAccepted = body.consentAccepted === true;
    const consentVersion = parseInt(body.consentVersion, 10);
    if (!signerName || signerName.length < 3) {
      return json(400, { error: 'Please type your full legal name to sign.' });
    }
    if (!consentAccepted) {
      return json(400, { error: 'You must accept the Credit Authorization to submit.' });
    }
    if (consentVersion !== CREDIT_AUTH_CONSENT_VERSION) {
      return json(400, { error: 'Consent version mismatch — please refresh and re-accept.' });
    }
    // Resolve primary client + loan for the PDF context.
    let primary = null, loan = null;
    try {
      const primaryKey = idx.ownerKey + '/' + idx.primaryClientId.replace(/[^a-zA-Z0-9_-]/g, '_');
      primary = await clientsStore.get(primaryKey, { type: 'json' });
      loan = primary && Array.isArray(primary.loans)
        ? primary.loans.find((l) => l && l.id === idx.loanId)
        : null;
    } catch (_) {}

    creditAuthAudit = {
      token,
      guarantorClientId: guarantor.id,
      loanId:            idx.loanId,
      signerName,
      signerEmail:       String(fields.email || guarantor.email || '').toLowerCase(),
      signedAt:          now,
      consentVersion:    CREDIT_AUTH_CONSENT_VERSION,
      ipAddress:         getClientIp(req),
      userAgent:         getUserAgent(req),
      geolocation:       String(body.geolocation || ''),
    };
    creditAuthAudit.seal = sealCreditAuthAudit(creditAuthAudit) || '';

    let pdfBytes;
    try {
      pdfBytes = await generateCreditAuthPdf({
        guarantor: Object.assign({}, guarantor, {
          firstName: fields.firstName || guarantor.firstName,
          lastName:  fields.lastName  || guarantor.lastName,
          email:     fields.email     || guarantor.email,
        }),
        primary,
        loan,
        audit: creditAuthAudit,
      });
    } catch (e) {
      console.error('guarantor-subform-save: credit auth PDF render failed:', e);
      return json(500, { error: 'Failed to render Credit Auth PDF: ' + (e.message || 'unknown') });
    }
    try {
      const pdfStore = getStore({ name: 'guarantor-credit-auth-pdfs', consistency: 'strong' });
      await pdfStore.set(token, pdfBytes, {
        metadata: {
          guarantorClientId: guarantor.id,
          ownerKey:          idx.ownerKey,
          loanId:             idx.loanId,
          signedAt:           now,
          signerName,
        },
      });
    } catch (e) {
      console.error('guarantor-subform-save: credit auth PDF store failed:', e);
      return json(500, { error: 'Failed to store Credit Auth PDF: ' + (e.message || 'unknown') });
    }
  }

  // Per-loan sub-form state bookkeeping.
  guarantor._subFormTokensByLoan = guarantor._subFormTokensByLoan || {};
  const state = guarantor._subFormTokensByLoan[idx.loanId] || { token, createdAt: now };
  state.lastSavedAt = now;
  if (body.markComplete === true) {
    state.status = 'completed';
    state.completedAt = now;
    state.creditAuthAudit = creditAuthAudit;
    state.creditAuthSignedAt = now;
  } else if (state.status !== 'completed') {
    state.status = 'in_progress';
  }
  guarantor._subFormTokensByLoan[idx.loanId] = state;
  guarantor.updatedAt = now;
  changed = true; // status bump alone counts

  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  try { await writeClient(idx.ownerKey, guarantor, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save guarantor: ' + (e.message || 'unknown') }); }

  // Deploy 236.129 — mark the loan as having freshly-arrived guarantor
  // docs so Loan Details can surface a "Re-generate loan app to
  // include updated guarantor info" banner. Failure is non-fatal.
  if (body.markComplete === true) {
    try {
      const primaryKey = idx.ownerKey + '/' + idx.primaryClientId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const primary = await clientsStore.get(primaryKey, { type: 'json' });
      if (primary && Array.isArray(primary.loans)) {
        const ln = primary.loans.find((l) => l && l.id === idx.loanId);
        if (ln) {
          ln._guarantorDocsUpdatedAt = now;
          ln._guarantorDocsUpdatedBy = guarantor.id;
          ln.updatedAt = now;
          primary.updatedAt = now;
          // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
          await writeClient(idx.ownerKey, primary, { clientsStore });
        }
      }
    } catch (e) {
      console.warn('guarantor-subform-save: loan marker write failed (non-fatal):', e && e.message);
    }
  }

  return json(200, { ok: true, guarantor, status: state.status });
}
