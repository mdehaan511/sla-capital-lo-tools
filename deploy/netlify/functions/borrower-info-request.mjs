/**
 * borrower-info-request.mjs — POST /api/borrower-info-request
 *
 * Authed (LO). Body:
 *   { clientId, loanId, sendEmail? (default false) }
 *
 * Creates or rotates a borrower-info token tied to a SPECIFIC LOAN
 * on the client (since Deploy 168 — was per-client before that).
 * Returns the full token URL that the LO can copy. If sendEmail=true,
 * also emails the borrower with the link.
 *
 * Records live in the `borrower_info` blob store keyed
 * `<owner>/<clientId>/<loanId>`. If a record already exists for that
 * loan, the token is rotated (old link stops working) and any existing
 * collected data is preserved so the borrower can pick up where they
 * left off. Each loan has its own independent record — DSCR and RTL
 * loans on the same client do NOT share data, even if for the same
 * property.
 *
 * Legacy fallback (Deploy 168 migration): if no record exists at the
 * per-loan key but one exists at the old per-client key AND that
 * legacy record's inferred loanId matches the requested loanId, lift
 * it forward as the starting point. See _shared/borrower-info-keys.mjs.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { generateToken } from './_shared/crypto.mjs';
import { newRecordKey, loadRecord } from './_shared/borrower-info-keys.mjs';
import { writeTokenIndex, deleteTokenIndex } from './_shared/borrower-info-token-index.mjs';
// Deploy 236.455 — the byOwner materialized index (Deploy 236.343). The
// admin all-scope borrower-info-list reads from this index, so a SEND must
// write through to it or admins never see the new 'pending' record.
import { borrowerInfoIndex } from './_shared/borrower-info-index.mjs';
// Deploy 223 — reply_to header set to the LO who owns the lead so
// borrower replies go to the right inbox (not noreply@).
import { getOwnerReplyTo, logBorrowerSendFromResponse } from './_shared/email.mjs';
// Deploy 226 — audit log entry on the loan when the long app is sent.
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

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

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanId)             return json(400, { error: 'loanId required' });

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

  // Find the matching loan (now required)
  let loan = null;
  if (Array.isArray(client.loans)) {
    loan = client.loans.find((l) => l.id === body.loanId) || null;
  }
  if (!loan) return json(404, { error: 'Loan not found on client' });

  // Validate we have SOMEONE to send to. Priority order:
  //   1. body.email     — the LO explicitly typed it in the modal
  //   2. client.email   — normal case, borrower is the client
  //   3. loan.brokerEmail — broker deals where client is a broker
  //                       shell with no email on the client row
  // Only refuse if we can't resolve any recipient anywhere.
  const bodyEmail = String(body.email || '').trim();
  const brokerEmail = String(loan.brokerEmail || '').trim();
  if (!bodyEmail && !client.email && !brokerEmail) {
    return json(400, {
      error: 'No email available. Add a borrower or broker email to the loan, or type a recipient in the modal.',
    });
  }

  // Look up LO profile for email "from" name
  let loProfile = null;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
    loProfile = await profilesStore.get(ownerKey, { type: 'json' });
  } catch (e) { /* non-fatal */ }
  const loName = (loProfile && loProfile.fullName) || (user.user_metadata && user.user_metadata.full_name) || user.email || 'Your loan officer';

  // Build/rotate the record at the per-loan key (Deploy 168). loadRecord
  // also handles the migration fallback: if there's a legacy per-client
  // record whose inferred loanId matches body.loanId, it gets lifted to
  // the new key as the starting point.
  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const recordKey = newRecordKey(ownerKey, body.clientId, body.loanId);
  const existing = await loadRecord(store, ownerKey, body.clientId, body.loanId, client);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 86400000).toISOString();
  // Deploy 236.414 — REUSE the existing token on resend instead of
  // rotating. Rotation silently killed every previously sent email and
  // open tab, which created a vicious cycle: borrower hits an error →
  // LO resends → borrower retries from the OLDER email → dead token →
  // (pre-236.414) full-store walk → 504 → LO resends again. Now every
  // email ever sent for this application keeps working; the expiry
  // window slides forward with each resend. A fresh token is only
  // minted when there's no live one (first send, or expired).
  const tokenReusable = !!(existing && existing.token &&
    (!existing.expiresAt || new Date(existing.expiresAt) > new Date()));
  const token = tokenReusable ? existing.token : generateToken();

  // Pre-fill from what we already know about the client + loan
  const prefill = buildPrefill(client, loan, { loName, loEmail: owner });

  const record = {
    clientId: body.clientId,
    loanId: body.loanId,                    // required since Deploy 168
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

  // Deploy 236.455 — write through the byOwner borrower-info index so the
  // admin all-scope pipeline reflects the newly-sent 'pending' app right
  // away. borrower-info-list serves admins from this index (Deploy 236.343),
  // and until now ONLY borrower-info-save upserted it — so a SENT app never
  // entered the index until the BORROWER opened the link and saved. Symptom
  // (Mike, super_admin on all-scope): send the long app from Loan Details
  // ACTIONS, then open the Pipeline — the card stayed on "Send Loan App"
  // (never flipped to "Loan App Pending"/"In Progress") because the index
  // the pipeline reads never learned about the send. Self-scope LOs read a
  // live store walk, so they saw it — that was the asymmetry. Awaited (not
  // fire-and-forget) so the index is current before we return; the Lambda
  // can freeze right after the response, dropping a detached promise.
  try {
    await borrowerInfoIndex.upsertRecord(record.ownerKey, record);
  } catch (e) {
    console.warn('borrower-info-request: index upsert failed (non-fatal):', e && e.message);
  }

  // Deploy 172: write the token→recordKey index entry so subsequent
  // public load/save calls can resolve the token in O(1) instead of
  // walking the entire borrower_info store. If we're rotating a token
  // (existing record had a different token), invalidate the old index
  // entry so the previous link stops resolving via the index path.
  if (existing && existing.token && existing.token !== token) {
    await deleteTokenIndex(existing.token);
  }
  await writeTokenIndex(token, recordKey, {
    ownerKey, clientId: body.clientId, loanId: body.loanId,
  });

  // Build the borrower-facing URL
  const siteUrl = (process.env.URL || '').replace(/\/$/, '');
  const link = `${siteUrl}/borrower-info.html?t=${encodeURIComponent(token)}`;

  // Optional email — use the body.email override if provided (LO can edit
  // the recipient in the modal), otherwise default to the client's email,
  // then fall back to the loan's broker email (broker deals where the
  // client shell has no email of its own).
  let emailed = false;
  const recipientEmail = bodyEmail || client.email || brokerEmail;
  if (body.sendEmail) {
    try {
      emailed = await sendBorrowerEmail({
        toEmail: recipientEmail,
        toName: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || recipientEmail,
        loName,
        loEmail: owner,
        link,
        ownerKey,
        propertyAddress: (loan && loan.address) || (client.loans && client.loans[0] && client.loans[0].address) || '',
      });
    } catch (e) {
      console.warn('borrower-info-request: email failed:', e);
    }
  }

  // Deploy 226 — when the LO sent the long-app email (sendEmail=true),
  // append an "app_sent" entry to the loan's audit log. We only fire on
  // explicit sends so that LOs regenerating the link without emailing
  // (e.g., to copy/paste it) don't pollute the log. Best-effort.
  if (body.sendEmail) {
    try {
      const matchIdx = (client.loans || []).findIndex((l) => l && l.id === body.loanId);
      if (matchIdx >= 0) {
        const umeta = (user && user.user_metadata) || {};
        const authorName = umeta.full_name || umeta.fullName || user.email || '';
        appendNoteEntry(client.loans[matchIdx], {
          kind:        'app_sent',
          text:        'Sent long-form loan application to ' + recipientEmail + (emailed ? '' : ' (email failed — link generated)'),
          author:      authorName,
          authorEmail: user.email || '',
          meta:        { borrowerEmail: recipientEmail, emailed: !!emailed },
        });
        client.loans[matchIdx].updatedAt = new Date().toISOString();
        // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
        await writeClient(ownerKey, client, { clientsStore });
      }
    } catch (e) {
      console.warn('borrower-info-request: audit log write failed (non-fatal):', e && e.message);
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

  // Broker loans store the BROKER's contact info on the client record —
  // the borrower is a separate person captured (if at all) on the loan's
  // formData. Copying client.* into pf.borrower would put broker info
  // into the borrower form's contact section AND, worse, cascade into
  // the Guarantor #1 mirror in borrower-info.html (line 459+). The
  // borrower would open the form pre-filled with the broker as their
  // own guarantor. Fix: for broker loans, source borrower fields from
  // loan.formData if captured; leave blank otherwise so the borrower
  // fills in their own info + guarantor from scratch.
  const isBrokerLoan = !!(loan && (loan._isBrokerLoan || loan.brokerId));
  const fd = (loan && loan.formData) || {};
  let borrowerSrc;
  if (isBrokerLoan) {
    // Split the broker-named borrower into first/last if present.
    // Deploy 236.636 — include loan.borrowerName (stamped by prospects-save when a
    // broker names the borrower on the short app), so the loan application prefills
    // with the BORROWER, not the broker. Email already reads loan.borrowerEmail.
    const borrowerName = String(fd.borrower || fd.borrowerName || loan.borrower || loan.borrowerName || '').trim();
    const nameParts = borrowerName.split(/\s+/);
    borrowerSrc = {
      firstName: nameParts.slice(0, -1).join(' ') || nameParts[0] || '',
      lastName:  nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
      email:     fd.borrowerEmail || loan.borrowerEmail || '',
      phone:     fd.borrowerPhone || loan.borrowerPhone || '',
      usCitizen: '',
      dob:       '',
      maritalStatus: '',
      homeAddress: null,
      fico:      '',
      flips:     '',
      rentals:   '',
    };
  } else {
    borrowerSrc = {
      firstName: client.firstName || '',
      lastName:  client.lastName || '',
      email:     client.email || '',
      phone:     client.phone || '',
      usCitizen: client.usCitizen || '',
      dob:       client.dob || '',
      maritalStatus: client.maritalStatus || '',
      homeAddress: client.homeAddress || null,
      fico:      client.fico || '',
      flips:     client.flips || '',
      rentals:   client.rentals || '',
    };
  }

  const pf = {
    // Item #9: who this borrower is working with (auto-selected + locked on form)
    lo: {
      name: loInfo.loName || '',
      email: loInfo.loEmail || '',
    },
    borrower: borrowerSrc,
    property: {},
    loan: {
      // Surface isBrokerLoan so borrower-info.html's Guarantor #1 mirror
      // (and any other form logic) can be broker-aware.
      isBrokerLoan,
    },
    // Item #8: borrower's saved companies/entities for the entity selector.
    // Broker loans: the client's companies belong to the BROKER, not the
    // borrower — don't leak them into the borrower's entity picker.
    companies: (isBrokerLoan
      ? []
      : (Array.isArray(client.companies) ? client.companies : [])),
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
    pf.loan.loanAmtLocked   = !!loan.loanAmtLocked;
    pf.loan.maxLoan         = loan.maxLoan || '';
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
    pf.loan.projectDescription = loan.projectDescription || '';
    pf.loan.fico            = loan.fico || pf.borrower.fico || '';
    // Item #5: annualize monthly expenses for the long-app fields
    pf.loan.annualTaxes     = annualize(loan.taxes);
    pf.loan.annualInsurance = annualize(loan.insurance);
    pf.loan.annualHOA       = annualize(loan.hoa);
  }
  return pf;
}

async function sendBorrowerEmail({ toEmail, toName, loName, loEmail, link, propertyAddress, ownerKey }) {
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

  // Deploy 223 — reply_to set to the LO so borrower replies route
  // back to them instead of the unmonitored noreply@ from-address.
  const replyTo = await getOwnerReplyTo(ownerKey);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
  // Deploy 236.685 — track delivery so the LO is alerted if the long-app link bounces.
  await logBorrowerSendFromResponse(resp, { kind: 'long_app_link', to: toEmail, ownerKey, loEmail, loName, address: propertyAddress });
  return true;
}
