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
  generateBorrower2Token,
} from './_shared/esign.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';

// Which forms each signer signed in their single signing event.
// Borrower 1\u2019s session covers all three forms (their own); borrower 2\u2019s
// session covers only the prequal credit check (they don\u2019t re-sign
// the application acknowledgement — that\u2019s a joint borrower-1 event
// from a UETA perspective, similar to how a paper application is
// signed once at the bottom by the lead borrower).
const B1_SIGNED_AUTHS = ['app_acknowledgement', 'prequal_credit', 'info_release'];
const B2_SIGNED_AUTHS = ['prequal_credit'];

// Borrower-2 token expires in 30 days. Same window as the borrower-info
// link so a stalled deal doesn\u2019t leave an indefinite signing link out
// in the wild.
const B2_TOKEN_TTL_DAYS = 30;

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
  if (record.signedAt || record.b1SignedAt) {
    return json(409, { error: 'This application has already been signed.' });
  }

  // ── 2. Make sure there's actually data to sign ─────────────────
  if (!record.data || Object.keys(record.data).length === 0) {
    return json(400, { error: 'No application data found to sign. Please complete the form first.' });
  }

  // ── 3. Capture audit context for borrower 1 ────────────────────
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
    signedAuths: B1_SIGNED_AUTHS,
  };
  const seal = sealAudit(auditPre);
  if (!seal) {
    return json(500, {
      error: 'ESIGN_SEAL_SECRET is not configured on the server. ' +
             'Set the environment variable to enable signing.',
    });
  }
  const b1Audit = Object.assign({}, auditPre, { seal });

  // Look up the client for the PDF (entity name fallback, etc.)
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client = null;
  try {
    const ckey = `${record.ownerKey}/${(record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    client = await clientsStore.get(ckey, { type: 'json' });
  } catch (_) {}

  // ── 4. Determine if borrower 2 needs to sign ───────────────────
  // numGuarantors comes from the form data. If "2" and the second
  // guarantor has at least an email, we need to route to them after
  // borrower 1 signs.
  const data = record.data || {};
  const guarantors = Array.isArray(data.guarantors) ? data.guarantors : [];
  const g1 = guarantors[1] || null;
  const numGuarantors = String(data.numGuarantors || '1');
  const hasB2 = numGuarantors === '2' && g1 && (g1.email || '').trim().length > 0;

  let b2Block = null;
  let b2Token = null;
  if (hasB2) {
    b2Token = generateBorrower2Token();
    const tokenExpiresAt = new Date(Date.now() + B2_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    b2Block = {
      role: 'borrower2',
      name: ((g1.firstName || '') + ' ' + (g1.lastName || '')).trim() || 'Co-Borrower',
      email: (g1.email || '').toLowerCase().trim(),
      phone: g1.phone || '',
      token: b2Token,
      tokenExpiresAt,
      invitedAt: signedAt,
      audit: null,         // populated when they sign
      signedAuths: [],
    };
  }

  // ── 5. Build the signed PDF ────────────────────────────────────
  // The PDF rendered now is the INTERIM copy if borrower 2 is
  // expected to sign — it will be regenerated when borrower 2 signs
  // their auth. If single borrower, this is the final copy.
  const pdfStatus = hasB2 ? 'awaiting_borrower2' : 'complete';
  let pdfBuffer;
  try {
    pdfBuffer = await renderSignedApplicationPDF({
      record,
      client,
      status: pdfStatus,
      signers: [
        {
          role: 'borrower1',
          name: b1Audit.signerName,
          email: b1Audit.signerEmail,
          audit: b1Audit,
          signedAuths: B1_SIGNED_AUTHS,
        },
        ...(b2Block ? [{
          role: 'borrower2',
          name: b2Block.name,
          email: b2Block.email,
          audit: null,
          signedAuths: [],
        }] : []),
      ],
    });
  } catch (e) {
    console.error('borrower-info-sign: PDF render failed:', e);
    return json(500, { error: 'Failed to generate signed PDF: ' + (e.message || 'unknown') });
  }

  // ── 6. Store the signed record ─────────────────────────────────
  const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  const signedKey = `${record.ownerKey}/${(record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}/${(record.loanId || '_no_loan').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const signedRecord = {
    clientId: record.clientId,
    loanId: record.loanId,
    ownerKey: record.ownerKey,
    propertyAddress: (record.prefill && record.prefill.propertyAddress) || (record.data && record.data.propertyAddress) || '',
    status: pdfStatus,
    numBorrowers: hasB2 ? 2 : 1,
    borrower1: {
      role: 'borrower1',
      name: b1Audit.signerName,
      email: b1Audit.signerEmail,
      audit: b1Audit,
      signedAuths: B1_SIGNED_AUTHS,
    },
    borrower2: b2Block,
    pdfBase64: pdfBuffer.toString('base64'),
    pdfSize: pdfBuffer.length,
    createdAt: signedAt,
    updatedAt: signedAt,
  };
  try {
    await signedStore.setJSON(signedKey, signedRecord);
  } catch (e) {
    console.error('borrower-info-sign: failed to store signed PDF:', e);
    return json(500, { error: 'Failed to save signed application' });
  }

  // Index the borrower-2 token (if any) for O(1) lookups in the
  // borrower2-auth endpoints. Keyed by token → signedKey.
  if (b2Token) {
    try {
      const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
      await idx.setJSON(b2Token, { signedKey, expiresAt: b2Block.tokenExpiresAt });
    } catch (e) {
      console.warn('borrower-info-sign: b2 token index write failed (lookup will fall back to walk):', e);
    }
  }

  // ── 7. Update borrower-info record state ───────────────────────
  // If borrower 2 still needs to sign, DON\u2019T mark the borrower-info
  // record as complete yet — wait until borrower 2 signs. Use a new
  // status \u2018awaiting_b2_signature\u2019 to make the holdup visible.
  //
  // If single-borrower, mark complete as before.
  if (hasB2) {
    record.status = 'awaiting_b2_signature';
    record.b1SignedAt = signedAt;
    record.b1SignedBy = b1Audit.signerName;
    record.b2Token = b2Token;
    record.b2InvitedAt = signedAt;
  } else {
    record.status = 'complete';
    record.completedAt = signedAt;
    record.signedAt = signedAt;
    record.signedBy = b1Audit.signerName;
  }
  record.signedAuditKey = signedKey;
  record.updatedAt = signedAt;
  try {
    await biStore.setJSON(recordKey, record);
  } catch (e) {
    console.warn('borrower-info-sign: borrower-info record save failed (signed record already stored):', e);
    // The signed PDF is the canonical record. Continue.
  }

  // ── 8. Sync + advance (only if no B2 pending) ──────────────────
  // When borrower 2 is still pending, hold off on the property sync
  // and the auto-advance to In Processing until they sign. The LO
  // should not see the loan move to In Processing while one of the
  // required signatures is still missing.
  let advanceResult = null;
  if (!hasB2) {
    try { await syncPropertyFieldsToLoan(record); }
    catch (e) { console.warn('borrower-info-sign: property sync failed:', e); }
    try {
      advanceResult = await advanceQuoteToInProcessing(record);
      if (advanceResult && !advanceResult.ok) {
        console.warn('borrower-info-sign: auto-advance bailed:', advanceResult.reason);
      }
    } catch (e) {
      console.warn('borrower-info-sign: advance threw:', e);
      advanceResult = { ok: false, reason: 'exception: ' + (e.message || 'unknown') };
    }
  }

  // ── 9. Emails ──────────────────────────────────────────────────
  // Two cases:
  //   - Single borrower: email B1 the final signed PDF
  //   - Two borrowers: email B1 the interim signed PDF, AND email B2 a
  //     link to sign their own prequal credit auth
  let emailedB1 = false;
  let emailedB2 = false;
  try {
    if (hasB2) {
      emailedB1 = await emailSignedCopy({
        toEmail: b1Audit.signerEmail,
        toName: b1Audit.signerName,
        propertyAddress: signedRecord.propertyAddress,
        pdfBuffer,
        isInterim: true,
        coBorrowerName: b2Block.name,
      });
      emailedB2 = await emailBorrower2AuthLink({
        toEmail: b2Block.email,
        toName: b2Block.name,
        b1Name: b1Audit.signerName,
        propertyAddress: signedRecord.propertyAddress,
        token: b2Token,
        req,
      });
    } else {
      emailedB1 = await emailSignedCopy({
        toEmail: b1Audit.signerEmail,
        toName: b1Audit.signerName,
        propertyAddress: signedRecord.propertyAddress,
        pdfBuffer,
        isInterim: false,
      });
    }
  } catch (e) {
    console.warn('borrower-info-sign: email failed:', e && e.message);
  }

  // ── 10. Notify the LO ─────────────────────────────────────────
  try { await notifyLOOfSignedApp(record, b1Audit, { hasB2, b2Name: b2Block && b2Block.name }); }
  catch (e) { console.warn('borrower-info-sign: LO notify failed:', e && e.message); }

  return json(200, {
    ok: true,
    signedAt,
    status: pdfStatus,
    emailedBorrower: emailedB1,
    emailedCoBorrower: emailedB2,
    awaitingBorrower2: hasB2,
    advanceResult,
  });
}

async function emailSignedCopy({ toEmail, toName, propertyAddress, pdfBuffer, isInterim, coBorrowerName }) {
  if (!toEmail) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('emailSignedCopy: RESEND_API_KEY not set');
    return false;
  }

  const subject = isInterim
    ? 'Your SLA Capital Loan Application — signed (awaiting co-borrower)'
    : 'Your signed SLA Capital Loan Application';
  const filename = isInterim
    ? 'SLA_Loan_Application_Interim.pdf'
    : 'SLA_Loan_Application_Signed.pdf';
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const interimNote = isInterim
    ? `\n\nWe\u2019ve emailed ${coBorrowerName || 'your co-borrower'} a link to sign their own credit & background check authorization. Once they sign, you\u2019ll both receive the final fully-signed copy.`
    : '';

  const text = [
    `Hi ${toName},`,
    '',
    'Thank you for signing your loan application with SLA Capital. A copy of your signed application is attached for your records.',
    interimNote.trim(),
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    '',
    'Your loan officer has been notified and will be in touch shortly about next steps. If you have any questions, just reply to this email.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Application ' +
          (isInterim ? 'Signed (Interim)' : 'Signed') + '</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(toName)},</p>` +
        '<p style="font-size:14px;line-height:1.6">Thank you for signing your loan application with SLA Capital. A copy of your signed application is attached to this email for your records.</p>' +
        (isInterim
          ? `<p style="font-size:14px;line-height:1.6;background:#F5E9D8;padding:12px 14px;border-left:3px solid #C8813A;border-radius:4px">We\u2019ve emailed <strong>${escH(coBorrowerName || 'your co-borrower')}</strong> a separate link to sign their own credit &amp; background check authorization. Once they sign, you\u2019ll both receive the final fully-signed copy.</p>`
          : '') +
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

// Email borrower 2 a link to sign their own prequal credit auth.
async function emailBorrower2AuthLink({ toEmail, toName, b1Name, propertyAddress, token, req }) {
  if (!toEmail) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  // Build the signing URL. Prefer the site URL from headers if available
  // (more reliable across preview deploys); fall back to env var.
  const proto = (req && req.headers && (req.headers.get
    ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto'])) || 'https';
  const host = (req && req.headers && (req.headers.get
    ? req.headers.get('host') : req.headers.host)) || '';
  const base = host
    ? `${proto}://${host}`
    : (process.env.URL || 'https://silver-narwhal-0d9f84.netlify.app');
  const link = `${base}/borrower2-auth.html?t=${encodeURIComponent(token)}`;

  const subject = 'Action required: Co-borrower authorization for SLA Capital loan application';
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text = [
    `Hi ${toName},`,
    '',
    `${b1Name} has submitted a loan application with SLA Capital that lists you as a co-borrower or guarantor.`,
    '',
    'To move the application forward, we need you to electronically sign your own Authorization to Conduct Prequal Credit & Background Checks. This is required by federal law (Fair Credit Reporting Act) — your authorization must come directly from you, not from your co-borrower.',
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    '',
    'Sign here:',
    link,
    '',
    'This link expires in 30 days.',
    '',
    'If you have any questions, reply to this email and we\u2019ll get back to you.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Co-Borrower Authorization Needed</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(toName)},</p>` +
        `<p style="font-size:14px;line-height:1.6"><strong>${escH(b1Name)}</strong> has submitted a loan application with SLA Capital that lists you as a co-borrower or guarantor.</p>` +
        '<p style="font-size:14px;line-height:1.6">To move the application forward, we need you to electronically sign your own <strong>Authorization to Conduct Prequal Credit &amp; Background Checks</strong>. This is required by federal law (Fair Credit Reporting Act) — your authorization must come directly from you, not from your co-borrower.</p>' +
        (propertyAddress
          ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
          : '') +
        `<p style="margin:24px 0;text-align:center"><a href="${escH(link)}" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Sign your authorization \u2192</a></p>` +
        `<p style="font-size:12px;color:#7A7488">Or copy and paste this link: <a href="${escH(link)}">${escH(link)}</a></p>` +
        '<p style="font-size:12px;color:#7A7488">This link expires in 30 days.</p>' +
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
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
  return true;
}

async function notifyLOOfSignedApp(record, audit, opts) {
  opts = opts || {};
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  const loEmail = record.requestedBy || '';
  if (!loEmail) return false;

  const subject = opts.hasB2
    ? `Loan app signed by Borrower 1 — awaiting Borrower 2: ${record.data && record.data.propertyAddress || 'borrower'}`
    : `Loan application signed: ${record.data && record.data.propertyAddress || 'borrower'}`;
  const text = opts.hasB2
    ? [
        `Borrower 1 (${audit.signerName}) has signed the loan application.`,
        '',
        `We\u2019ve emailed Borrower 2 (${opts.b2Name || 'co-borrower'}) a link to sign their own prequal credit & background check authorization.`,
        '',
        `Signed at: ${new Date(audit.signedAt).toLocaleString('en-US')}`,
        `Property: ${record.data && record.data.propertyAddress || '(not provided)'}`,
        '',
        `The loan will move to "In Processing" once Borrower 2 signs.`,
        '',
        'SLA Capital',
      ].join('\n')
    : [
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
