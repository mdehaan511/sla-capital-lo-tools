/**
 * borrower-message.mjs — POST /api/borrower-message
 *
 * Borrower sends a message to their loan officer from the /my-loans/
 * portal. We persist the message under a `borrower_messages` blob and
 * fire an email to the LO via Resend. LO can reply either by hitting
 * "reply" on the email (goes back to the borrower directly) or by
 * responding from the app when we build the message inbox — same
 * message stream either way.
 *
 * Body: { loanId, clientId, ownerEmail, address, message }
 *
 * Auth: required. The sender's email always comes from the JWT — the
 * message record can't be spoofed to look like it came from someone
 * else.
 *
 * Deploy 236.308 — borrower portal Phase 2 (messaging MVP).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_LEN = 5000;

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const cl = req.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return json(413, { error: 'Payload too large' });
  }

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const senderEmail = normalizeEmail(user.email || '');
  if (!senderEmail) return json(401, { error: 'No email on auth token' });

  let body = null;
  try { body = await req.json(); } catch (_) {}
  if (!body) return json(400, { error: 'Invalid JSON' });

  const loanId      = String(body.loanId    || '').trim().slice(0, 64);
  const clientId    = String(body.clientId  || '').trim().slice(0, 64);
  const ownerEmail  = normalizeEmail(body.ownerEmail || '');
  const address     = String(body.address   || '').trim().slice(0, 200);
  const messageText = String(body.message   || '').trim().slice(0, MAX_MESSAGE_LEN);

  if (!loanId)      return json(400, { error: 'loanId required' });
  if (!ownerEmail || !ownerEmail.includes('@'))
                    return json(400, { error: 'ownerEmail required' });
  if (!messageText) return json(400, { error: 'Message required' });

  const now = new Date().toISOString();
  const messageId = 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const record = {
    id:         messageId,
    at:         now,
    from:       senderEmail,
    fromRole:   'borrower',
    to:         ownerEmail,
    loanId:     loanId,
    clientId:   clientId,
    address:    address,
    text:       messageText,
  };

  // Persist under the loan — one blob per loan, JSON array of messages.
  // Keyed by loanId so a single GET fetches the whole thread when we
  // build the LO inbox view later.
  try {
    const store = getStore({ name: 'borrower_messages', consistency: 'strong' });
    let thread = null;
    try { thread = await store.get(loanId, { type: 'json' }); } catch (_) {}
    if (!thread || !Array.isArray(thread.messages)) {
      thread = { loanId, clientId, address, messages: [] };
    }
    thread.messages.push(record);
    thread.updatedAt = now;
    await store.setJSON(loanId, thread);
  } catch (e) {
    console.error('borrower-message: setJSON failed:', e && e.message);
    return json(500, { error: 'Failed to save message' });
  }

  // Email the LO via Resend (best-effort — persist wins over notify).
  try {
    await notifyLo({ ownerEmail, senderEmail, address, messageText, loanId });
  } catch (e) {
    console.warn('borrower-message: LO notify failed:', e && e.message);
  }

  console.log(`[borrower-message] loan=${loanId} from=${senderEmail} to=${ownerEmail} len=${messageText.length}`);

  return json(200, { ok: true, id: messageId });
};

async function notifyLo({ ownerEmail, senderEmail, address, messageText, loanId }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[borrower-message] no RESEND_API_KEY — skipping notify'); return; }
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const detailsLink = `https://portal.slacapital.ai/loan-details/${encodeURIComponent(loanId)}?owner=${encodeURIComponent(ownerEmail)}&fresh=1`;
  const subject = `Borrower message${address ? ` — ${address}` : ''}`;
  const text = [
    `${senderEmail} sent you a message from the borrower portal.`,
    ...(address ? [`Property: ${address}`] : []),
    '',
    messageText,
    '',
    `Open the loan: ${detailsLink}`,
    '',
    `Reply directly — your reply goes to the borrower.`,
  ].join('\n');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Borrower Message</h1></div>' +
    '<div style="padding:24px">' +
    `<p style="font-size:13px;color:#7a7488;margin:0 0 10px">From <strong style="color:#1a1520">${esc(senderEmail)}</strong>${address ? ` · <em>${esc(address)}</em>` : ''}</p>` +
    `<div style="background:#f8f5ef;border-left:3px solid #C8813A;padding:14px 18px;font-size:14px;color:#1a1520;white-space:pre-wrap;line-height:1.55;margin:12px 0 20px">${esc(messageText)}</div>` +
    `<p style="margin:16px 0"><a href="${detailsLink}" style="display:inline-block;background:#DA7238;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:13px;font-family:Arial,sans-serif">Open Loan Details</a></p>` +
    `<p style="font-size:12px;color:#666;margin-top:22px">Reply directly to this email — your reply goes back to the borrower at ${esc(senderEmail)}.</p>` +
    '</div></div></body></html>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [ownerEmail],
      subject, text, html,
      reply_to: senderEmail,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
}
