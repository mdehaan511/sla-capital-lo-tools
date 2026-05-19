/**
 * borrower2-auth-sign.mjs — POST /api/borrower2-auth-sign
 *
 * Deploy 180. Public endpoint (token-based). Borrower 2 signs their
 * Authorization to Conduct Prequal Credit & Background Checks. We
 * regenerate the signed PDF with BOTH signatures, update the
 * signed_applications record (status → complete), advance the loan
 * to In Processing, and email the final fully-signed PDF to BOTH
 * borrowers.
 *
 * Body: {
 *   t: TOKEN,
 *   signerName: string,
 *   consentAccepted: true,
 *   consentVersion: number,
 *   geolocation?: string,
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody } from './_shared/auth.mjs';
import {
  ESIGN_CONSENT_VERSION, hashFormData, sealAudit, getClientIp, getUserAgent,
} from './_shared/esign.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';
import { syncPropertyFieldsToLoan, advanceQuoteToInProcessing } from './_shared/borrower-info-sync.mjs';

const B2_SIGNED_AUTHS = ['prequal_credit'];

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower2-auth-sign error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (body === null)               return json(400, { error: 'Invalid JSON' });
  if (!body.t)                     return json(400, { error: 'Missing token' });
  if (!body.signerName || !body.signerName.trim())
                                   return json(400, { error: 'Signer name is required' });
  if (!body.consentAccepted)       return json(400, { error: 'You must accept the consent to sign.' });
  if (body.consentVersion !== ESIGN_CONSENT_VERSION) {
    return json(409, {
      error: 'Consent text has been updated. Please refresh and review the latest version.',
      currentVersion: ESIGN_CONSENT_VERSION,
    });
  }

  // ── 1. Look up the signed_applications record by token ─────────
  const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  let signedKey = null;
  let rec = null;
  try {
    const idxRec = await idx.get(body.t, { type: 'json' });
    if (idxRec && idxRec.signedKey) {
      signedKey = idxRec.signedKey;
      rec = await store.get(signedKey, { type: 'json' });
      if (rec && rec.borrower2 && rec.borrower2.token !== body.t) {
        // Token was rotated or doesn't match — fall through to walk
        rec = null;
      }
    }
  } catch (_) {}
  if (!rec) {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const r = await store.get(key, { type: 'json' });
      if (r && r.borrower2 && r.borrower2.token === body.t) {
        rec = r; signedKey = key; break;
      }
    }
  }
  if (!rec || !rec.borrower2) return json(404, { error: 'Link not found' });

  if (rec.borrower2.tokenExpiresAt && new Date(rec.borrower2.tokenExpiresAt) < new Date()) {
    return json(410, { error: 'This signing link has expired. Ask your loan officer to send a new one.' });
  }
  if (rec.borrower2.audit && rec.borrower2.audit.signedAt) {
    return json(409, { error: 'This authorization has already been signed.' });
  }

  // ── 2. Look up the borrower-info record (we need its data for the
  //       data hash + the PDF render).
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const biKey = `${rec.ownerKey}/${(rec.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}/${(rec.loanId || '_no_loan').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let biRecord = null;
  try { biRecord = await biStore.get(biKey, { type: 'json' }); } catch (_) {}
  if (!biRecord) {
    return json(404, { error: 'Underlying application record not found. Please contact your loan officer.' });
  }

  // Look up the client for the PDF
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client = null;
  try {
    const ckey = `${rec.ownerKey}/${(rec.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    client = await clientsStore.get(ckey, { type: 'json' });
  } catch (_) {}

  // ── 3. Build borrower-2 audit ──────────────────────────────────
  const signedAt = new Date().toISOString();
  const dataHash = hashFormData(biRecord.data);
  const auditPre = {
    recordId: `${rec.ownerKey}/${rec.clientId}/${rec.loanId || ''}#b2`,
    signerName: body.signerName.trim().slice(0, 200),
    signerEmail: rec.borrower2.email,
    dataHash,
    signedAt,
    consentVersion: ESIGN_CONSENT_VERSION,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req).slice(0, 500),
    geolocation: typeof body.geolocation === 'string' ? body.geolocation.slice(0, 200) : '',
    signedAuths: B2_SIGNED_AUTHS,
  };
  const seal = sealAudit(auditPre);
  if (!seal) {
    return json(500, {
      error: 'ESIGN_SEAL_SECRET is not configured on the server.',
    });
  }
  const b2Audit = Object.assign({}, auditPre, { seal });

  // ── 4. Regenerate the final PDF with both signatures ───────────
  let pdfBuffer;
  try {
    pdfBuffer = await renderSignedApplicationPDF({
      record: biRecord,
      client,
      status: 'complete',
      signers: [
        rec.borrower1,
        {
          role: 'borrower2',
          name: b2Audit.signerName,
          email: b2Audit.signerEmail,
          audit: b2Audit,
          signedAuths: B2_SIGNED_AUTHS,
        },
      ],
    });
  } catch (e) {
    console.error('borrower2-auth-sign: PDF render failed:', e);
    return json(500, { error: 'Failed to generate signed PDF: ' + (e.message || 'unknown') });
  }

  // ── 5. Update signed_applications record ───────────────────────
  rec.status = 'complete';
  rec.borrower2.audit = b2Audit;
  rec.borrower2.name = b2Audit.signerName;          // they may have entered a slightly different legal name
  rec.borrower2.signedAuths = B2_SIGNED_AUTHS;
  // Clear the token so it can't be replayed
  rec.borrower2.token = null;
  rec.pdfBase64 = pdfBuffer.toString('base64');
  rec.pdfSize = pdfBuffer.length;
  rec.updatedAt = signedAt;
  try {
    await store.setJSON(signedKey, rec);
  } catch (e) {
    console.error('borrower2-auth-sign: failed to update signed record:', e);
    return json(500, { error: 'Failed to save signed application' });
  }

  // Drop the token index entry — it's spent
  try { await idx.delete(body.t); } catch (_) {}

  // ── 6. Mark borrower-info as complete ──────────────────────────
  biRecord.status = 'complete';
  biRecord.completedAt = signedAt;
  biRecord.signedAt = signedAt;            // the full-app "signed" timestamp = when B2 finished
  biRecord.b2SignedAt = signedAt;
  biRecord.b2SignedBy = b2Audit.signerName;
  biRecord.b2Token = null;
  biRecord.updatedAt = signedAt;
  try {
    await biStore.setJSON(biKey, biRecord);
  } catch (e) {
    console.warn('borrower2-auth-sign: borrower-info update failed:', e);
  }

  // ── 7. Sync + auto-advance ─────────────────────────────────────
  try { await syncPropertyFieldsToLoan(biRecord); }
  catch (e) { console.warn('borrower2-auth-sign: property sync failed:', e); }
  let advanceResult = null;
  try {
    advanceResult = await advanceQuoteToInProcessing(biRecord);
  } catch (e) {
    console.warn('borrower2-auth-sign: advance threw:', e);
    advanceResult = { ok: false, reason: 'exception' };
  }

  // ── 8. Email both borrowers the final signed PDF ───────────────
  let emailedB1 = false;
  let emailedB2 = false;
  try {
    emailedB1 = await emailFinalSignedCopy({
      toEmail: rec.borrower1.email,
      toName: rec.borrower1.name,
      propertyAddress: rec.propertyAddress,
      pdfBuffer,
    });
    emailedB2 = await emailFinalSignedCopy({
      toEmail: rec.borrower2.email,
      toName: rec.borrower2.name,
      propertyAddress: rec.propertyAddress,
      pdfBuffer,
    });
  } catch (e) {
    console.warn('borrower2-auth-sign: email failed:', e && e.message);
  }

  // ── 9. Notify the LO ──────────────────────────────────────────
  let loNotified = false;
  try {
    loNotified = await notifyLOOfB2Signed(biRecord, rec, b2Audit, { pdfBuffer });
  } catch (e) {
    console.warn('borrower2-auth-sign: LO notify failed:', e && e.message);
  }

  return json(200, {
    ok: true,
    signedAt,
    emailedBorrower1: emailedB1,
    emailedBorrower2: emailedB2,
    emailedLO: loNotified,
    advanceResult,
  });
}

async function emailFinalSignedCopy({ toEmail, toName, propertyAddress, pdfBuffer }) {
  if (!toEmail) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  const subject = 'Your fully-signed SLA Capital Loan Application';
  const filename = 'SLA_Loan_Application_Signed.pdf';
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text = [
    `Hi ${toName},`,
    '',
    'Both borrowers have now signed the loan application. A copy of the fully-signed application is attached for your records.',
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    '',
    'Your loan officer will be in touch with next steps. If you have any questions, just reply to this email.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Application Fully Signed</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(toName)},</p>` +
        '<p style="font-size:14px;line-height:1.6">Both borrowers have now signed the loan application. A copy of the fully-signed application is attached for your records.</p>' +
        (propertyAddress
          ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
          : '') +
        '<p style="font-size:14px;line-height:1.6">Your loan officer will be in touch with next steps. If you have any questions, just reply to this email.</p>' +
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

async function notifyLOOfB2Signed(biRecord, signedRec, b2Audit, opts) {
  opts = opts || {};
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('notifyLOOfB2Signed: RESEND_API_KEY not configured');
    return false;
  }
  // Fallback to ownerEmail if requestedBy is missing.
  const loEmail = biRecord.requestedBy || biRecord.ownerEmail || '';
  if (!loEmail) {
    console.warn('notifyLOOfB2Signed: no LO email on record', biRecord.ownerKey);
    return false;
  }
  const propertyAddress = (biRecord.data && biRecord.data.propertyAddress) || '';
  const subject = `Loan application fully signed: ${propertyAddress || 'borrower'}`;
  const text = [
    `Both borrowers have now signed the loan application. The fully-signed PDF is attached.`,
    '',
    `Borrower 1: ${signedRec.borrower1.name} <${signedRec.borrower1.email}>`,
    `Borrower 2: ${b2Audit.signerName} <${b2Audit.signerEmail}>`,
    `B2 signed at: ${new Date(b2Audit.signedAt).toLocaleString('en-US')}`,
    `Property: ${propertyAddress || '(not provided)'}`,
    `B2 IP: ${b2Audit.ipAddress || 'unavailable'}`,
    '',
    `The loan has been moved to "In Processing" in your pipeline.`,
    '',
    'SLA Capital',
  ].join('\n');

  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital \u2014 Loan Application Fully Signed</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Both borrowers have now signed the loan application. The fully-signed PDF is attached.</p>` +
        '<table style="font-size:13px;line-height:1.7;margin:14px 0">' +
          `<tr><td style="color:#7A7488;padding-right:12px">Borrower 1</td><td><strong>${escH(signedRec.borrower1.name)}</strong> &lt;${escH(signedRec.borrower1.email)}&gt;</td></tr>` +
          `<tr><td style="color:#7A7488;padding-right:12px">Borrower 2</td><td><strong>${escH(b2Audit.signerName)}</strong> &lt;${escH(b2Audit.signerEmail)}&gt;</td></tr>` +
          `<tr><td style="color:#7A7488;padding-right:12px">B2 signed at</td><td>${escH(new Date(b2Audit.signedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</td></tr>` +
          `<tr><td style="color:#7A7488;padding-right:12px">Property</td><td>${escH(propertyAddress || '(not provided)')}</td></tr>` +
        '</table>' +
        `<p style="font-size:13px;color:#7A7488">The loan has been moved to "In Processing" in your pipeline.</p>` +
      '</div>' +
    '</div>' +
    '</body></html>';

  const attachments = [];
  if (opts.pdfBuffer) {
    const pdfB64 = Buffer.isBuffer(opts.pdfBuffer)
      ? opts.pdfBuffer.toString('base64')
      : Buffer.from(opts.pdfBuffer).toString('base64');
    const filenameSafe = (propertyAddress || 'SLA_Loan_Application')
      .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60);
    attachments.push({ filename: `${filenameSafe}_FullySigned.pdf`, content: pdfB64 });
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'SLA Capital <noreply@leads.slacapital.com>',
        to: [loEmail],
        subject, text, html, attachments,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.warn(`notifyLOOfB2Signed: Resend ${resp.status}`, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('notifyLOOfB2Signed: fetch threw:', e && e.message);
    return false;
  }
}
