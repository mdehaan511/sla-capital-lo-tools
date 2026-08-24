/**
 * _shared/email.mjs — Shared helpers for outbound transactional email.
 *
 * Deploy 223 — adds getOwnerReplyTo(ownerKey) so every borrower-facing
 * transactional email can set `reply_to` to the loan officer who owns
 * the lead. When a borrower hits "Reply" in their email client, their
 * composer addresses the LO directly instead of the unmonitored
 * noreply@leads.slacapital.com from-address.
 *
 * Returns a Resend-compatible string ("Full Name <email>" or just
 * "<email>" if name isn't set). Returns null if the profile is missing
 * or has no email — caller should OMIT the reply_to field in that
 * case (sending an empty string is worse than not sending the field
 * at all; some clients render literal "<>").
 *
 * Usage:
 *   import { getOwnerReplyTo } from './_shared/email.mjs';
 *
 *   const replyTo = await getOwnerReplyTo(ownerKey);
 *   const body = {
 *     from:    'SLA Capital <noreply@leads.slacapital.com>',
 *     to:      [borrowerEmail],
 *     subject: '...',
 *     text:    '...',
 *     html:    '...',
 *     ...(replyTo ? { reply_to: replyTo } : {}),
 *   };
 *
 * Profile lookup is `eventual` consistency — slight staleness on a name
 * change is acceptable for this use case (and avoids contending with
 * the profile write path).
 */
import { getStore } from '@netlify/blobs';

// Deploy 236.626 — robustly resolve the loan officer's email for LO-facing
// notifications (e.g. "borrower signed the application"). Records created via
// borrower-info-request carry requestedBy + ownerEmail, but older records,
// re-saved records, or records created through an alternate path may lack both —
// in which case the LO notification used to silently bail ("no LO email on
// record") and the LO never heard the app was signed.
//
// Resolution order:
//   1. record.requestedBy  (the LO who sent the application link)
//   2. record.ownerEmail   (the loan owner captured at creation)
//   3. the LO profile email (profiles store, keyed by ownerKey) — canonical
//   4. record.ownerKey itself — ownerKey is keySafe(normalizeEmail(loEmail)),
//      and keySafe is a no-op for ordinary emails, so it IS a valid address.
export async function resolveOwnerEmail(record) {
  if (!record) return '';
  const pick = (v) => { const s = String(v == null ? '' : v).trim().toLowerCase(); return s.includes('@') ? s : ''; };
  const direct = pick(record.requestedBy) || pick(record.ownerEmail);
  if (direct) return direct;
  try {
    const store = getStore({ name: 'profiles', consistency: 'eventual' });
    const profile = await store.get(record.ownerKey, { type: 'json' });
    const pe = pick(profile && profile.email);
    if (pe) return pe;
  } catch (e) {
    console.warn('resolveOwnerEmail: profile lookup failed:', e && e.message);
  }
  return pick(record.ownerKey);
}

// ── Deploy 236.684 — delivery-failure tracking ─────────────────────
// Resend's send API returns success once an email is QUEUED, not when it's
// delivered. A hard delivery failure (bad address → bounce) is reported later
// via a Resend webhook. To notify the loan officer when a borrower-facing loan
// application or rate sheet fails to deliver, we log every such send keyed by
// the Resend email id; the webhook (resend-webhook.mjs) looks that id up on an
// `email.bounced` event and emails the LO. Best-effort throughout — a log-write
// failure must never break the actual send.
const RESEND_LOG_STORE = 'resend_send_log';

export async function logBorrowerSend(emailId, meta) {
  if (!emailId) return;
  try {
    const store = getStore({ name: RESEND_LOG_STORE, consistency: 'eventual' });
    await store.setJSON(String(emailId), Object.assign({
      emailId: String(emailId),
      sentAt: new Date().toISOString(),
    }, meta || {}));
  } catch (e) {
    console.warn('logBorrowerSend failed:', e && e.message);
  }
}

// One-liner for a send site: pass the Resend fetch Response (on success) + the
// log meta; reads the email id off a CLONE (so it never consumes the caller's
// body) and logs it. Any borrower-facing send can add delivery-failure tracking
// with a single `await logBorrowerSendFromResponse(resp, {kind, to, ownerKey})`.
export async function logBorrowerSendFromResponse(resp, meta) {
  try {
    if (!resp || !resp.ok) return;
    const data = await resp.clone().json().catch(() => null);
    const emailId = data && data.id;
    if (emailId) await logBorrowerSend(emailId, meta || {});
  } catch (e) {
    console.warn('logBorrowerSendFromResponse failed:', e && e.message);
  }
}

export async function getBorrowerSend(emailId) {
  if (!emailId) return null;
  try {
    const store = getStore({ name: RESEND_LOG_STORE, consistency: 'eventual' });
    return await store.get(String(emailId), { type: 'json' });
  } catch (e) {
    console.warn('getBorrowerSend failed:', e && e.message);
    return null;
  }
}

// Stamp the log so a duplicate webhook event (Resend can retry / send both a
// delay and a bounce) doesn't email the LO twice for the same failed send.
export async function markBorrowerSendNotified(emailId) {
  if (!emailId) return;
  try {
    const store = getStore({ name: RESEND_LOG_STORE, consistency: 'eventual' });
    const rec = await store.get(String(emailId), { type: 'json' });
    if (rec) { rec.loNotifiedAt = new Date().toISOString(); await store.setJSON(String(emailId), rec); }
  } catch (e) {
    console.warn('markBorrowerSendNotified failed:', e && e.message);
  }
}

// Deploy 236.694 — congratulate the loan officer (the loan's owner) when their
// loan closes. Called from the two close paths (loan-processing-stage → pp_closed,
// loan-advance-status → status 'closed') on the TRANSITION into closed only, so it
// fires once per close and never on a re-save of an already-closed loan.
// Best-effort — a failed email must never block the close.
export async function notifyLoLoanClosed({ ownerKey, loan }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('notifyLoLoanClosed: RESEND_API_KEY not configured'); return false; }
  const loEmail = await resolveOwnerEmail({ ownerKey });
  if (!loEmail) { console.warn('notifyLoLoanClosed: no LO email for', ownerKey); return false; }

  const address = String((loan && loan.address) || '').trim();
  const amtNum = Number((loan && (loan.finalLoanAmount || loan.loanAmt)) || 0);
  const amt = amtNum ? '$' + amtNum.toLocaleString('en-US') : '';
  const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const subject = '🎉 Congratulations — a loan just closed!' + (address ? ' (' + address + ')' : '');
  const text = [
    'Congratulations! 🎉',
    '',
    'Your loan' + (address ? ' at ' + address : '') + ' has officially closed.' + (amt ? '  (' + amt + ')' : ''),
    '',
    'Nice work getting this one across the finish line.',
    '',
    'SLA Capital',
  ].join('\n');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">🎉 Congratulations — Your Loan Closed!</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        '<p style="font-size:15px;line-height:1.6">Congratulations! Your loan' +
          (address ? ' at <strong>' + escH(address) + '</strong>' : '') +
          ' has officially <strong>closed</strong>' + (amt ? ' — ' + escH(amt) : '') + '.</p>' +
        '<p style="font-size:14px;line-height:1.6;color:#7A7488">Nice work getting this one across the finish line. 🏁</p>' +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  try {
    const replyTo = await getOwnerReplyTo(ownerKey);
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'SLA Capital <noreply@leads.slacapital.com>',
        to: [loEmail], subject, text, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.warn('notifyLoLoanClosed: Resend ' + resp.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('notifyLoLoanClosed: fetch threw:', e && e.message);
    return false;
  }
}

export async function getOwnerReplyTo(ownerKey) {
  if (!ownerKey) return null;
  try {
    const store = getStore({ name: 'profiles', consistency: 'eventual' });
    const profile = await store.get(ownerKey, { type: 'json' });
    if (!profile || !profile.email) return null;

    const email = String(profile.email).trim();
    if (!email) return null;

    const meta = profile.user_metadata || {};
    const name =
      meta.full_name ||
      meta.fullName ||
      profile.full_name ||
      profile.fullName ||
      '';

    // Sanitize the name — Resend / RFC 5322 require quoting if there's
    // anything weird in it. Strip < > " characters that would break
    // the header. Falls through to bare email if the name is empty.
    const safeName = String(name).replace(/[<>"]/g, '').trim();
    return safeName ? (safeName + ' <' + email + '>') : email;
  } catch (e) {
    console.warn('getOwnerReplyTo failed:', e && e.message);
    return null;
  }
}
