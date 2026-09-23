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
// Deploy 237.259 -- the record / token / index work lives in _shared/borrower-info-issue.mjs
// now, so the e-sign packet can hand out the same application link (Mike: "sign the rate
// sheet and complete the loan application from the same link"). This endpoint keeps what is
// LO-facing: the recipient rules, the email, the loan note.
import { issueApplicationLink } from './_shared/borrower-info-issue.mjs';
// Deploy 223 — reply_to header set to the LO who owns the lead so
// borrower replies go to the right inbox (not noreply@).
import { getOwnerReplyTo, logBorrowerSendFromResponse } from './_shared/email.mjs';
// Deploy 226 — audit log entry on the loan when the long app is sent.
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

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

  // Deploy 237.259 -- the record, its token (reused while live: 236.414), the SSN seed
  // (236.853), the byOwner index (236.455) and the token index (172) are one shared step now
  // (_shared/borrower-info-issue.mjs); the e-sign packet issues the same link. Nothing about
  // the record changed.
  let issued;
  try {
    issued = await issueApplicationLink({
      ownerKey, ownerEmail: owner, client, loan, loName,
      recipientEmail: bodyEmail || client.email || brokerEmail || '',
      requestedBy: user.email || '',
      clientsStore, store: getStore({ name: 'borrower_info', consistency: 'strong' }),
    });
  } catch (e) {
    console.error('borrower-info-request: issue failed:', e && e.message);
    return json(500, { error: 'Failed to save request' });
  }
  const { token, expiresAt, existing } = issued;

  const link = issued.link; // the borrower-facing URL

  // Optional email — use the body.email override if provided (LO can edit
  // the recipient in the modal), otherwise default to the client's email,
  // then fall back to the loan's broker email (broker deals where the
  // client shell has no email of its own).
  let emailed = false;
  const recipientEmail = bodyEmail || client.email || brokerEmail;
  // Deploy 237.190 — a reminder is the same send with nudge copy. It only
  // counts as one when there was already a record to nudge about; asking for
  // a reminder on a first send just sends the normal invitation.
  const isReminder = !!body.reminder && !!existing;
  const hasStarted = !!(existing && existing.data && Object.keys(existing.data).length > 0);
  if (body.sendEmail) {
    try {
      emailed = await sendBorrowerEmail({
        toEmail: recipientEmail,
        toName: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || recipientEmail,
        loName,
        loEmail: owner,
        link,
        ownerKey,
        reminder: isReminder,
        started: hasStarted,
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
  // Deploy 237.190 — handed back so the Notes & Activity feed can show the
  // entry immediately after a one-click reminder, the way loan-note-add does.
  let noteEntry = null;
  if (body.sendEmail) {
    try {
      const matchIdx = (client.loans || []).findIndex((l) => l && l.id === body.loanId);
      if (matchIdx >= 0) {
        const umeta = (user && user.user_metadata) || {};
        const authorName = umeta.full_name || umeta.fullName || user.email || '';
        noteEntry = appendNoteEntry(client.loans[matchIdx], {
          kind:        'app_sent',
          text:        (isReminder ? 'Sent a reminder about the long-form loan application to ' : 'Sent long-form loan application to ') +
                       recipientEmail + (emailed ? '' : ' (email failed — link generated)'),
          author:      authorName,
          authorEmail: user.email || '',
          meta:        { borrowerEmail: recipientEmail, emailed: !!emailed, reminder: isReminder },
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
    reminder: isReminder,
    entry: noteEntry,        // 237.190 — for the feed's optimistic append
  });
}

// Deploy 237.190 (Chance: "is there anyway we can get a 'resend' or reminder
// button for the loan app as well?"). `reminder` swaps the first-contact copy
// for a nudge — same link, same record, softer subject line — and `started`
// says whether the borrower has already answered something, so the nudge can
// say "pick up where you left off" instead of "please get started".
async function sendBorrowerEmail({ toEmail, toName, loName, loEmail, link, propertyAddress, ownerKey, reminder, started }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — cannot send borrower-info email');
    return false;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const forProp = propertyAddress ? ` for ${propertyAddress}` : '';
  const subject = reminder
    ? (propertyAddress
        ? `Reminder: your loan application for ${propertyAddress} is still open`
        : 'Reminder: your SLA Capital loan application is still open')
    : (propertyAddress
        ? `Action needed: complete your loan application for ${propertyAddress}`
        : 'Action needed: complete your SLA Capital loan application');

  // The one paragraph that differs between a first send and a nudge.
  const leadText = reminder
    ? (started
        ? `A quick reminder from ${loName} at SLA Capital — your loan application${forProp} is still open. You've already started it, and everything you entered is saved.`
        : `A quick reminder from ${loName} at SLA Capital — we still need your borrower information before we can finalize your loan application${forProp}.`)
    : `${loName} at SLA Capital has requested that you complete your borrower information so we can finalize your loan application${forProp}.`;
  const leadHtml = reminder
    ? (started
        ? `A quick reminder from <strong>${esc(loName)}</strong> at SLA Capital — your loan application${propertyAddress ? ' for <strong>' + esc(propertyAddress) + '</strong>' : ''} is still open. You've already started it, and everything you entered is saved.`
        : `A quick reminder from <strong>${esc(loName)}</strong> at SLA Capital — we still need your borrower information before we can finalize your loan application${propertyAddress ? ' for <strong>' + esc(propertyAddress) + '</strong>' : ''}.`)
    : `<strong>${esc(loName)}</strong> at SLA Capital has requested that you complete your borrower information so we can finalize your loan application${propertyAddress ? ' for <strong>' + esc(propertyAddress) + '</strong>' : ''}.`;
  const ctaLabel = (reminder && started) ? 'Pick Up Where You Left Off' : 'Complete Borrower Information';
  const bannerLabel = reminder
    ? 'SLA Capital — Loan Application Reminder'
    : 'SLA Capital — Borrower Information Request';

  const text = [
    `Hi ${toName},`,
    '',
    leadText,
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
      `<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">${bannerLabel}</h1></div>` +
      '<div style="padding:24px">' +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520">Hi ${esc(toName)},</p>` +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520">${leadHtml}</p>` +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520">Click the button below to securely fill in the remaining details. Your progress saves automatically — you can close the page and come back any time within the next <strong>14 days</strong>.</p>` +
        `<div style="text-align:center;margin:28px 0"><a href="${link}" style="display:inline-block;padding:14px 28px;background:#C8813A;color:#fff;font-family:'DM Sans',sans-serif;font-weight:600;font-size:14px;border-radius:24px;text-decoration:none">${ctaLabel}</a></div>` +
        `<p style="font-size:12px;color:#7a7488;line-height:1.5">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#1a1520">${link}</span></p>` +
        `<p style="font-size:13px;color:#7a7488;margin-top:24px">Questions? Reply to this email or contact ${esc(loName)} at <a href="mailto:${esc(loEmail)}" style="color:#C8813A">${esc(loEmail)}</a>.</p>` +
      '</div>' +
    '</div>' +
    '</body></html>';

  // Deploy 223 — reply_to set to the LO so borrower replies route
  // back to them instead of the unmonitored noreply@ from-address.
  const replyTo = await getOwnerReplyTo(ownerKey);
  const resp = await fetch('https://api.resend.com/emails', {
    signal: AbortSignal.timeout(15000), // Deploy 237.003
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
