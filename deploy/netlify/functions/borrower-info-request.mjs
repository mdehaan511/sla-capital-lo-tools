/**
 * borrower-info-request.mjs — POST /api/borrower-info-request
 *
 * Authed (LO). Body:
 *   { clientId, loanId?, sendEmail? (default false) }
 *
 * Creates or rotates a borrower-info token tied to the client. Returns the
 * full token URL that the LO can copy. If sendEmail=true, also emails the
 * borrower with the link.
 *
 * Tokens live in the `borrower_info` blob store under the client's id.
 * If a non-completed record already exists, the token is rotated (so the
 * old link stops working). A completed record is preserved — if the LO
 * wants to re-request edits, they need to confirm it'll wipe the existing
 * data (handled client-side, server replaces unconditionally on this call).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { generateToken } from './_shared/crypto.mjs';

const TOKEN_EXPIRY_DAYS = 14;

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-request error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });

  // Owner: default to current user. Admins may override.
  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  // Look up the client to grab borrower email + name + property info for prefill
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client;
  try {
    client = await clientsStore.get(`${ownerKey}/${keySafe(body.clientId)}`, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load client' });
  }
  if (!client) return json(404, { error: 'Client not found' });
  if (!client.email) return json(400, { error: 'Client has no email — add one first' });

  // Find the matching loan if loanId given (for property pre-fill)
  let loan = null;
  if (body.loanId && Array.isArray(client.loans)) {
    loan = client.loans.find((l) => l.id === body.loanId) || null;
  }

  // Look up LO profile for email "from" name
  let loProfile = null;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
    loProfile = await profilesStore.get(ownerKey, { type: 'json' });
  } catch (e) { /* non-fatal */ }
  const loName = (loProfile && loProfile.fullName) || (user.user_metadata && user.user_metadata.full_name) || user.email || 'Your loan officer';

  // Build/rotate the record
  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const recordKey = `${ownerKey}/${keySafe(body.clientId)}`;
  let existing = null;
  try { existing = await store.get(recordKey, { type: 'json' }); } catch (_) {}

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 86400000).toISOString();
  const token = generateToken();

  // Pre-fill from what we already know about the client + loan
  const prefill = buildPrefill(client, loan, { loName, loEmail: owner });

  const record = {
    clientId: body.clientId,
    loanId: body.loanId || null,
    ownerKey,
    ownerEmail: owner,
    borrowerEmail: client.email,
    token,
    sentAt: now,
    expiresAt,
    status: 'pending',
    requestedBy: user.email || '',
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    completedAt: null,
    prefill,
    // Existing collected data is preserved if present (allows LO to re-send link
    // for edits without wiping borrower's previous answers)
    data: (existing && existing.data) || {},
  };

  try {
    await store.setJSON(recordKey, record);
  } catch (e) {
    return json(500, { error: 'Failed to save request' });
  }

  // Build the borrower-facing URL
  const siteUrl = (process.env.URL || '').replace(/\/$/, '');
  const link = `${siteUrl}/borrower-info.html?t=${encodeURIComponent(token)}`;

  // Optional email — use the body.email override if provided (LO can edit
  // the recipient in the modal), otherwise default to the client's email.
  let emailed = false;
  const recipientEmail = (body.email && String(body.email).trim()) || client.email;
  if (body.sendEmail) {
    try {
      emailed = await sendBorrowerEmail({
        toEmail: recipientEmail,
        toName: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || recipientEmail,
        loName,
        loEmail: owner,
        link,
        propertyAddress: (loan && loan.address) || (client.loans && client.loans[0] && client.loans[0].address) || '',
      });
    } catch (e) {
      console.warn('borrower-info-request: email failed:', e);
    }
  }

  return json(200, {
    ok: true,
    token,
    link,
    url: link,           // alias used by the LO-side UI
    expiresAt,
    emailed,
    borrowerEmail: recipientEmail,
  });
}

// Pull what we already know about the borrower + property into a prefill
// object the borrower form will use to skip redundant questions.
function buildPrefill(client, loan, loInfo) {
  loInfo = loInfo || {};
  // Fallback: when no specific loan was passed, use the client's first loan
  if (!loan && client && Array.isArray(client.loans) && client.loans.length > 0) {
    loan = client.loans[0];
  }
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  };
  const annualize = (m) => { const n = num(m); return n != null ? Math.round(n * 12) : ''; };

  const pf = {
    // Item #9: who this borrower is working with (auto-selected + locked on form)
    lo: {
      name: loInfo.loName || '',
      email: loInfo.loEmail || '',
    },
    borrower: {
      firstName: client.firstName || '',
      lastName: client.lastName || '',
      email: client.email || '',
      phone: client.phone || '',
      usCitizen: client.usCitizen || '',
      // Profile-level fields the LO may have entered on the contact page or
      // that came from a previous application. Future-proof for #6.
      dob: client.dob || '',
      maritalStatus: client.maritalStatus || '',
      homeAddress: client.homeAddress || null,
      fico: client.fico || '',
    },
    property: {},
    loan: {},
  };
  if (loan) {
    pf.property.address   = loan.address || '';
    pf.property.propType  = loan.propType || '';
    pf.property.bedrooms  = loan.bedrooms || '';
    pf.property.bathrooms = loan.bathrooms || '';
    pf.property.sqft      = loan.sqft || '';

    pf.loan.toolType        = loan.toolType || '';
    pf.loan.loanType        = loan.loanType || '';
    pf.loan.loanPurpose     = loan.loanPurpose || '';
    pf.loan.loanAmt         = loan.loanAmt || loan.purchasePrice || '';
    pf.loan.purchasePrice   = loan.purchasePrice || '';
    pf.loan.propValue       = loan.propValue || loan.arv || '';
    pf.loan.arv             = loan.arv || loan.estimatedARV || '';
    pf.loan.rehabBudget     = loan.rehabBudget || '';
    // Existing/current loan amount for refinances (item #4)
    pf.loan.currentLoanAmt  = loan.currentLoanAmt || loan.existingLoanAmt || '';
    pf.loan.rent            = loan.rent || '';
    pf.loan.rentalType      = loan.rentalType || '';
    pf.loan.fundingDate     = loan.fundingDate || '';
    pf.loan.experience      = loan.experience || '';
    pf.loan.fico            = loan.fico || pf.borrower.fico || '';
    // Item #5: annualize monthly expenses for the long-app fields
    pf.loan.annualTaxes     = annualize(loan.taxes);
    pf.loan.annualInsurance = annualize(loan.insurance);
    pf.loan.annualHOA       = annualize(loan.hoa);
  }
  return pf;
}

async function sendBorrowerEmail({ toEmail, toName, loName, loEmail, link, propertyAddress }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — cannot send borrower-info email');
    return false;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = propertyAddress
    ? `Action needed: complete your loan application for ${propertyAddress}`
    : 'Action needed: complete your SLA Capital loan application';

  const text = [
    `Hi ${toName},`,
    '',
    `${loName} at SLA Capital has requested that you complete your borrower information so we can finalize your loan application${propertyAddress ? ' for ' + propertyAddress : ''}.`,
    '',
    `Click the link below to securely fill in the remaining details. Your progress saves automatically — you can close the page and come back any time within the next 14 days.`,
    '',
    link,
    '',
    `If you have any questions, reply to this email or contact ${loName} at ${loEmail}.`,
    '',
    'SLA Capital',
  ].join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Borrower Information Request</h1></div>' +
      '<div style="padding:24px">' +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520">Hi ${esc(toName)},</p>` +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520"><strong>${esc(loName)}</strong> at SLA Capital has requested that you complete your borrower information so we can finalize your loan application${propertyAddress ? ' for <strong>' + esc(propertyAddress) + '</strong>' : ''}.</p>` +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520">Click the button below to securely fill in the remaining details. Your progress saves automatically — you can close the page and come back any time within the next <strong>14 days</strong>.</p>` +
        `<div style="text-align:center;margin:28px 0"><a href="${link}" style="display:inline-block;padding:14px 28px;background:#C8813A;color:#fff;font-family:'DM Sans',sans-serif;font-weight:600;font-size:14px;border-radius:24px;text-decoration:none">Complete Borrower Information</a></div>` +
        `<p style="font-size:12px;color:#7a7488;line-height:1.5">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#1a1520">${link}</span></p>` +
        `<p style="font-size:13px;color:#7a7488;margin-top:24px">Questions? Reply to this email or contact ${esc(loName)} at <a href="mailto:${esc(loEmail)}" style="color:#C8813A">${esc(loEmail)}</a>.</p>` +
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
