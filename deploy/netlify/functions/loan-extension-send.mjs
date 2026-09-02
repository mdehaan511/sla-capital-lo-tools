/**
 * loan-extension-send.mjs — POST /api/loan-extension-send
 *
 * Deploy 236.843 — one-button Loan Extension Agreement from the Closed
 * Loans servicing view (Mike). Fills the extension-agreement template
 * from the loan record, creates a native eSign envelope with TWO
 * SEQUENTIAL signers — the LENDER first (Mike, so he verifies the filled
 * agreement before the borrower ever sees it), then the BORROWER — and
 * sends the first invitation. envelope-sign invites the borrower
 * automatically the moment the lender signs (envelope.sequential).
 *
 * Body: {
 *   clientId, loanId, owner?,
 *   newMaturityDate,            // YYYY-MM-DD (UI defaults maturity+90d)
 *   extensionDays?,             // 90 default — only feeds the wording
 *   extensionFee?,              // $ (default 1% of original loan amount)
 *   currentUpb?,                // $ (default loan.upb, else loan amount)
 *   feeHandling?,               // 'at_signing' (default) | 'add_to_principal'
 *   borrowerName?, borrowerEmail?,   // default entity/client name + client email
 *   lenderName?, lenderEmail?,       // default Mike DeHaan / mike@slacapital.com
 * }
 * Auth: processor tier (includes senior LOs + admins).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { hashPdf } from './_shared/native-esign.mjs';
import { buildExtensionAgreementPdf } from './_shared/extension-agreement-pdf.mjs';

const DEFAULT_LENDER = { firstName: 'Mike', lastName: 'DeHaan', email: 'mike@slacapital.com' };

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-send error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : 0;
}
function _splitName(full, fallbackFirst) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: fallbackFirst || 'Borrower', lastName: '—' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '—' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor, senior LO, or admin required' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId || !body.loanId) return json(400, { error: 'clientId and loanId required' });

  const selfEmail = normalizeEmail(user.email);
  let ownerKey = keySafe(selfEmail);
  if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(body.clientId), { type: 'json' }).catch(() => null);
  if (!client) return json(404, { error: 'Client not found' });
  const loan = (client.loans || []).find((l) => l && l.id === body.loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });

  // ── Fill values (body overrides > loan record defaults) ───────────
  const loanAmount = _num(loan.finalLoanAmount) || _num(loan.loanAmt);
  const values = {
    todaysDate:      new Date().toISOString().slice(0, 10),
    borrowerName:    String(body.borrowerName || client.entityName ||
                       ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || 'Borrower').slice(0, 160),
    originationDate: loan.fundingDate || '',
    loanAmount:      loanAmount,
    propertyAddress: loan.address || '',
    currentUpb:      _num(body.currentUpb) || _num(loan.upb) || loanAmount,
    newMaturityDate: String(body.newMaturityDate || '').slice(0, 10),
    extensionDays:   parseInt(body.extensionDays, 10) || 90,
    extensionFee:    _num(body.extensionFee) || Math.round(loanAmount * 0.01 * 100) / 100,
    feeHandling:     body.feeHandling === 'add_to_principal' ? 'add_to_principal' : 'at_signing',
    lenderName:      String(body.lenderName || (DEFAULT_LENDER.firstName + ' ' + DEFAULT_LENDER.lastName)).slice(0, 120),
  };
  if (!values.newMaturityDate) return json(400, { error: 'newMaturityDate required' });
  if (!values.originationDate) return json(400, { error: 'The loan has no funding date on file — set the Close Date first.' });
  if (!(loanAmount > 0)) return json(400, { error: 'The loan has no loan amount on file.' });

  const borrowerEmail = normalizeEmail(body.borrowerEmail || client.email || '');
  if (!borrowerEmail || !borrowerEmail.includes('@')) {
    return json(400, { error: 'No borrower email on file — enter one in the modal.' });
  }
  const lenderEmail = normalizeEmail(body.lenderEmail || DEFAULT_LENDER.email);
  if (lenderEmail === borrowerEmail) return json(400, { error: 'Lender and borrower emails must differ.' });

  // ── Render the agreement PDF ──────────────────────────────────────
  let pdfBytes;
  try { pdfBytes = await buildExtensionAgreementPdf(values); }
  catch (e) { return json(500, { error: 'PDF generation failed: ' + (e.message || 'unknown') }); }
  const pdfBase64 = pdfBytes.toString('base64');

  // ── Create the envelope (same record shape as envelopes.mjs) ──────
  const now = new Date().toISOString();
  const envelopeId = 'env_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const lender = _splitName(values.lenderName, DEFAULT_LENDER.firstName);
  const borrower = _splitName(values.borrowerName, client.firstName);
  const record = {
    id: envelopeId,
    ownerKey,
    ownerEmail: ownerKey,
    requesterEmail: selfEmail,
    clientId: String(body.clientId),
    loanId: String(body.loanId),
    docs: [{
      kind: 'loan_extension',
      name: 'Loan Extension Agreement - ' + String(loan.address || '').split(',')[0].trim(),
      hadPdf: true,
      pdfHash: hashPdf(pdfBase64),
      pdfSize: pdfBytes.length,
      sigCoords: null,
    }],
    signers: [
      { firstName: lender.firstName, lastName: lender.lastName, email: lenderEmail,
        role: 'lender', signingOrder: 1, token: null, tokenExpiresAt: null, audit: null, signedAt: null, invitedAt: null, resendCount: 0 },
      { firstName: borrower.firstName, lastName: borrower.lastName, email: borrowerEmail,
        role: 'borrower', signingOrder: 2, token: null, tokenExpiresAt: null, audit: null, signedAt: null, invitedAt: null, resendCount: 0 },
    ],
    message: 'Loan Extension Agreement for ' + (loan.address || 'your loan') +
      ' — new maturity date ' + values.newMaturityDate + '.',
    // Deploy 236.843 — SEQUENTIAL send: only the first unsigned signer is
    // invited; envelope-sign invites the next one when they complete.
    sequential: true,
    envelopeKind: 'loan_extension',
    propertyAddress: loan.address || '',
    extensionTerms: {
      newMaturityDate: values.newMaturityDate, extensionDays: values.extensionDays,
      extensionFee: values.extensionFee, feeHandling: values.feeHandling,
      currentUpb: values.currentUpb, priorMaturityDate: loan.maturityDate || '',
    },
    status: 'queued',
    statusUpdatedAt: now,
    envelopeMode: 'native',
    sendError: null,
    createdAt: now,
    history: [{ ts: now, status: 'queued', note: 'Extension agreement generated — sequential send (lender first, then borrower).' }],
  };
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  await envStore.setJSON(ownerKey + '/' + envelopeId, record);
  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  await pdfStore.set(ownerKey + '/' + envelopeId + '/0', pdfBase64);

  // ── Kick off the send (tokens + lender-only invitation) ───────────
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
  const authHdr = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('authorization') || '') : '';
  let sendResp = null;
  try {
    const r = await fetch(base + '/.netlify/functions/envelopes-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHdr },
      body: JSON.stringify({ envelopeId, owner: ownerKey }),
    });
    sendResp = await r.json().catch(() => ({}));
    if (!r.ok) return json(502, { error: 'Envelope created but send failed: ' + ((sendResp && sendResp.error) || ('HTTP ' + r.status)), envelopeId });
  } catch (e) {
    return json(502, { error: 'Envelope created but send failed: ' + (e.message || 'network'), envelopeId });
  }

  // ── Audit note on the loan (best-effort) ──────────────────────────
  try {
    const meta = (user && user.user_metadata) || {};
    appendNoteEntry(loan, {
      kind: 'status',
      text: 'Loan Extension Agreement sent for signature — new maturity ' + values.newMaturityDate +
        ', fee $' + Number(values.extensionFee).toLocaleString() +
        ' (' + (values.feeHandling === 'add_to_principal' ? 'added to principal' : 'paid at signing') + '). ' +
        'Lender (' + lenderEmail + ') signs first, then borrower (' + borrowerEmail + ').',
      author: meta.full_name || meta.fullName || user.email || '',
      authorEmail: selfEmail,
      meta: { via: 'loan_extension_send', envelopeId },
    });
    loan.updatedAt = new Date().toISOString();
    await writeClient(ownerKey, client, { clientsStore });
  } catch (e) { console.warn('loan-extension-send: note append failed (non-fatal):', e && e.message); }

  return json(200, { ok: true, envelopeId, values, firstSigner: lenderEmail, secondSigner: borrowerEmail });
}
