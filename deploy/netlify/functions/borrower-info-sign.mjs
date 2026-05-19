/**
 * borrower-info-sign.mjs — POST /api/borrower-info-sign
 *
 * Deploy 179. Final step of the borrower-side loan application flow.
 * Public endpoint (token-based, no LO auth required — the borrower is
 * signing on their own behalf via the token link they received).
 *
 * Body: {
 *   t: TOKEN,                 // the borrower-info access token
 *   signerName: string,       // their typed full legal name
 *   signerEmail?: string,     // optional — they may have updated it
 *   consentAccepted: true,    // explicit acceptance of ESIGN/UETA consent
 *   consentVersion: number,   // must match server's current version
 *   geolocation?: string,     // optional, captured client-side if permitted
 * }
 *
 * Flow:
 *   1. Validate token + look up the borrower-info record
 *   2. Validate consent + signer name + record is complete enough to sign
 *   3. Mark the record `status: complete` (same as existing submitFinal path)
 *   4. Build audit trail: server timestamp, IP, UA, data hash, HMAC seal
 *   5. Render signed PDF
 *   6. Store signed record (PDF binary base64 + audit) in `signed_applications`
 *   7. Email a copy to the borrower (best-effort)
 *   8. Fire the auto-advance to APPROVED (loan moves to In Processing)
 *   9. Return success — frontend shows the "thank you, signed" page
 *
 * If any step fails before step 6 (the signed record store) the
 * borrower's form data is still saved (we only flip status to complete
 * after the signed PDF lands). They'd see an error and could re-sign.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, readJsonBody,
} from './_shared/auth.mjs';
import { lookupTokenKey } from './_shared/borrower-info-token-index.mjs';
import { syncPropertyFieldsToLoan, advanceQuoteToInProcessing } from './_shared/borrower-info-sync.mjs';
import {
  ESIGN_CONSENT_VERSION, hashFormData, sealAudit, getClientIp, getUserAgent,
} from './_shared/esign.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-sign error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body.t)               return json(400, { error: 'Missing token' });
  if (!body.signerName || !body.signerName.trim())
                             return json(400, { error: 'Signer name is required' });
  if (!body.consentAccepted) return json(400, { error: 'ESIGN/UETA consent must be accepted' });
  if (body.consentVersion !== ESIGN_CONSENT_VERSION) {
    return json(409, {
      error: 'Consent text has been updated. Please review and accept the latest version.',
      currentVersion: ESIGN_CONSENT_VERSION,
    });
  }

  // ── 1. Look up the record by token ─────────────────────────────
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  let record = null;
  let recordKey = null;

  // Fast path via token index. Falls back to a walk if the index miss.
  const fastKey = await lookupTokenKey(body.t);
  if (fastKey) {
    try {
      const r = await biStore.get(fastKey, { type: 'json' });
      if (r && r.token === body.t) { record = r; recordKey = fastKey; }
    } catch (_) { /* fall through */ }
  }
  if (!record) {
    const { blobs } = await biStore.list();
    for (const { key } of blobs) {
      const r = await biStore.get(key, { type: 'json' });
      if (r && r.token === body.t) { record = r; recordKey = key; break; }
    }
  }
  if (!record) return json(404, { error: 'Link not found or expired' });

  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    return json(410, { error: 'This link has expired' });
  }
  if (record.signedAt) {
    return json(409, { error: 'This application has already been signed.' });
  }

  // ── 2. Make sure there's actually data to sign ─────────────────
  if (!record.data || Object.keys(record.data).length === 0) {
    return json(400, { error: 'No application data found to sign. Please complete the form first.' });
  }

  // ── 3. Capture audit context ───────────────────────────────────
  const signedAt = new Date().toISOString();
  const dataHash = hashFormData(record.data);
  const auditPre = {
    recordId: `${record.ownerKey}/${record.clientId}/${record.loanId || ''}`,
    signerName: body.signerName.trim().slice(0, 200),
    signerEmail: (body.signerEmail || record.borrowerEmail || '').toLowerCase().trim(),
    dataHash,
    signedAt,
    consentVersion: ESIGN_CONSENT_VERSION,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req).slice(0, 500),
    geolocation: typeof body.geolocation === 'string' ? body.geolocation.slice(0, 200) : '',
  };
  const seal = sealAudit(auditPre);
  if (!seal) {
    return json(500, {
      error: 'ESIGN_SEAL_SECRET is not configured on the server. ' +
             'Set the environment variable to enable signing.',
    });
  }
  const audit = Object.assign({}, auditPre, { seal });

  // Look up the client for the PDF (entity name fallback, etc.)
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client = null;
  try {
    const ckey = `${record.ownerKey}/${(record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    client = await clientsStore.get(ckey, { type: 'json' });
  } catch (_) {}

  // ── 4. Build the signed PDF ────────────────────────────────────
  let pdfBuffer;
  try {
    pdfBuffer = await renderSignedApplicationPDF({
      record, client, audit,
      signature: { signerName: audit.signerName, signerEmail: audit.signerEmail },
    });
  } catch (e) {
    console.error('borrower-info-sign: PDF render failed:', e);
    return json(500, { error: 'Failed to generate signed PDF: ' + (e.message || 'unknown') });
  }

  // ── 5. Store the signed record ─────────────────────────────────
  // Keyed `<owner>/<clientId>/<loanId>` so each loan has its own
  // signed application. Stored as JSON with the PDF as base64; loan-
  // details fetches the JSON and the LO downloads the PDF on demand.
  const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  const signedKey = `${record.ownerKey}/${(record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}/${(record.loanId || '_no_loan').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const signedRecord = {
    clientId: record.clientId,
    loanId: record.loanId,
    ownerKey: record.ownerKey,
    borrowerEmail: audit.signerEmail,
    propertyAddress: (record.prefill && record.prefill.propertyAddress) || record.data && record.data.propertyAddress || '',
    audit,
    pdfBase64: pdfBuffer.toString('base64'),
    pdfSize: pdfBuffer.length,
    createdAt: signedAt,
  };
  try {
    await signedStore.setJSON(signedKey, signedRecord);
  } catch (e) {
    console.error('borrower-info-sign: failed to store signed PDF:', e);
    return json(500, { error: 'Failed to save signed application' });
  }

  // ── 6. Mark borrower-info record as signed + complete ──────────
  record.status = 'complete';
  record.completedAt = signedAt;
  record.signedAt = signedAt;
  record.signedBy = audit.signerName;
  record.signedAuditKey = signedKey;
  record.updatedAt = signedAt;
  try {
    await biStore.setJSON(recordKey, record);
  } catch (e) {
    console.warn('borrower-info-sign: borrower-info record save failed (signed record already stored):', e);
    // The signed PDF is the canonical record. Continue.
  }

  // ── 7. Fire sync + auto-advance (same as the legacy submit path) ─
  try { await syncPropertyFieldsToLoan(record); }
  catch (e) { console.warn('borrower-info-sign: property sync failed:', e); }
  let advanceResult = null;
  try {
    advanceResult = await advanceQuoteToInProcessing(record);
    if (advanceResult && !advanceResult.ok) {
      console.warn('borrower-info-sign: auto-advance bailed:', advanceResult.reason);
    }
  } catch (e) {
    console.warn('borrower-info-sign: advance threw:', e);
    advanceResult = { ok: false, reason: 'exception: ' + (e.message || 'unknown') };
  }

  // ── 8. Email the borrower a copy of their signed PDF ───────────
  let emailed = false;
  try {
    emailed = await emailSignedCopy({
      toEmail: audit.signerEmail,
      toName: audit.signerName,
      propertyAddress: signedRecord.propertyAddress,
      pdfBuffer,
    });
  } catch (e) {
    console.warn('borrower-info-sign: email failed:', e && e.message);
  }

  // ── 9. Notify the LO that the signed app is in ────────────────
  // Reuse the existing LO notification pattern. Best-effort; doesn't
  // fail the signing if the email pipe is down.
  try { await notifyLOOfSignedApp(record, audit); }
  catch (e) { console.warn('borrower-info-sign: LO notify failed:', e && e.message); }

  return json(200, {
    ok: true,
    signedAt,
    emailedBorrower: emailed,
    advanceResult,
  });
}

async function emailSignedCopy({ toEmail, toName, propertyAddress, pdfBuffer }) {
  if (!toEmail) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('emailSignedCopy: RESEND_API_KEY not set');
    return false;
  }

  const subject = 'Your signed SLA Capital Loan Application';
  const filename = 'SLA_Loan_Application_Signed.pdf';
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text = [
    `Hi ${toName},`,
    '',
    'Thank you for signing your loan application with SLA Capital. A copy of your signed application is attached for your records.',
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    '',
    'Your loan officer has been notified and will be in touch shortly about next steps. If you have any questions, just reply to this email.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined).join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Application Signed</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(toName)},</p>` +
        '<p style="font-size:14px;line-height:1.6">Thank you for signing your loan application with SLA Capital. A copy of your signed application is attached to this email for your records.</p>' +
        (propertyAddress
          ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
          : '') +
        '<p style="font-size:14px;line-height:1.6">Your loan officer has been notified and will be in touch shortly about next steps. If you have any questions, just reply to this email.</p>' +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital. For business-purpose, investment property loans only.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject,
      text,
      html,
      attachments: [
        { filename, content: pdfBuffer.toString('base64') },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
  return true;
}

async function notifyLOOfSignedApp(record, audit) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  // Look up the LO's email via profile + ownerKey reverse map. Easiest
  // path: the profiles store is keyed by keySafe(email), so we'd need
  // the email. We can get it from the borrower-info record's
  // requestedBy field (set when the LO created the link).
  const loEmail = record.requestedBy || '';
  if (!loEmail) return false;

  const subject = `Loan application signed: ${record.data && record.data.propertyAddress || 'borrower'}`;
  const text = [
    `Good news — your borrower just signed their loan application.`,
    '',
    `Borrower: ${audit.signerName} <${audit.signerEmail}>`,
    `Signed at: ${new Date(audit.signedAt).toLocaleString('en-US')}`,
    `Property: ${record.data && record.data.propertyAddress || '(not provided)'}`,
    '',
    `The loan has been moved to "In Processing" in your pipeline. The signed PDF is available on the Loan Details page.`,
    '',
    'SLA Capital',
  ].join('\n');

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [loEmail],
      subject,
      text,
    }),
  });
  return resp.ok;
}
