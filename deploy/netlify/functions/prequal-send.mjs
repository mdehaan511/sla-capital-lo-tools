/**
 * prequal-send.mjs — POST /api/prequal-send
 *
 * Authed (LO). Body: { clientId, owner? }
 *
 * Emails the client a link to the LO's public prequal form
 * (apply.html?lo=<lo-email>). The same link the LO can grab from
 * their Profile page — but with a personalized email so the borrower
 * gets a clean nudge rather than having to be sent a raw URL.
 *
 * apply.html is the short borrower-facing intake form. When the
 * borrower submits it, prospects-save.mjs upserts the client record
 * by email match — so this works whether the client is brand new or
 * already has a record on the LO's roster.
 *
 * Returns: { ok, link, emailed }
 */
import { getStore } from '@netlify/blobs';
// Deploy 223 — reply_to = LO who owns the lead.
import { getOwnerReplyTo } from './_shared/email.mjs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('prequal-send error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  // Look up the client to grab name + email for the message
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client;
  try {
    client = await clientsStore.get(`${ownerKey}/${keySafe(body.clientId)}`, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load client' });
  }
  if (!client) return json(404, { error: 'Client not found' });
  if (!client.email) return json(400, { error: 'Client has no email on file' });

  // Look up the LO's display name for the email signature
  let loName = user.email || 'Your loan officer';
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
    const lo = await profilesStore.get(ownerKey, { type: 'json' });
    if (lo && lo.fullName) loName = lo.fullName;
  } catch (_) { /* non-fatal */ }

  const origin = new URL(req.url).origin;
  const link = `${origin}/apply.html?lo=${encodeURIComponent(owner)}`;

  let emailed = false;
  try {
    emailed = await sendPrequalEmail({
      ownerKey,
      toEmail: client.email,
      toName: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || client.email,
      loName,
      loEmail: owner,
      link,
    });
  } catch (e) {
    console.warn('prequal-send: email failed:', e);
    return json(500, { error: 'Email failed: ' + (e.message || 'unknown') });
  }

  // Deploy 236.189 — stamp last-sent so client-details.html can show
  // "Last sent {date}" under the Send Loan Prequal button. Only mark
  // the send if the email actually went out — a Resend failure leaves
  // the prior timestamp intact so the button doesn't lie.
  let lastSentAt = client._prequalLastSentAt || null;
  if (emailed) {
    const now = new Date().toISOString();
    client._prequalLastSentAt = now;
    client._prequalLastSentBy = user.email || '';
    client.updatedAt = now;
    try {
      await clientsStore.setJSON(`${ownerKey}/${keySafe(body.clientId)}`, client);
      await pgMirror.upsertClientWithLoansStrict(ownerKey, client);
      lastSentAt = now;
    } catch (e) {
      console.warn('prequal-send: failed to persist lastSent stamp:', e && e.message);
    }
  }

  return json(200, { ok: true, link, emailed, lastSentAt });
}

async function sendPrequalEmail({ toEmail, toName, loName, loEmail, link, ownerKey }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — cannot send prequal email');
    return false;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = 'Quick prequalification — SLA Capital';

  const text = [
    `Hi ${toName},`,
    '',
    `${loName} at SLA Capital would like to get you prequalified. The form takes about 3 minutes — basic contact info, what kind of loan you're looking for, and a few property details.`,
    '',
    `Start here:`,
    link,
    '',
    `If you have any questions, reply to this email or reach out to ${loName} at ${loEmail}.`,
    '',
    'SLA Capital',
  ].join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Prequalification</h1></div>' +
      '<div style="padding:24px">' +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520">Hi ${esc(toName)},</p>` +
        `<p style="font-size:14px;line-height:1.6;color:#1a1520"><strong>${esc(loName)}</strong> at SLA Capital would like to get you prequalified. The form takes about 3 minutes — basic contact info, what kind of loan you're looking for, and a few property details.</p>` +
        `<div style="text-align:center;margin:28px 0"><a href="${link}" style="display:inline-block;padding:14px 28px;background:#C8813A;color:#fff;font-family:'DM Sans',sans-serif;font-weight:600;font-size:14px;border-radius:24px;text-decoration:none">Start Prequalification</a></div>` +
        `<p style="font-size:12px;color:#7a7488;line-height:1.5">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#1a1520">${link}</span></p>` +
        `<p style="font-size:13px;color:#7a7488;margin-top:24px">Questions? Reply to this email or contact ${esc(loName)} at <a href="mailto:${esc(loEmail)}" style="color:#C8813A">${esc(loEmail)}</a>.</p>` +
      '</div>' +
    '</div>' +
    '</body></html>';

  const replyTo = await getOwnerReplyTo(ownerKey);
  // Deploy 236.189 — CC the LO so they have a copy of the exact
  // message sent to the borrower. Reply-To keeps borrower replies
  // going to the LO's inbox; CC gives the LO the outbound too.
  // Guarded: skip if the LO email matches the To (would look weird
  // on the borrower's side).
  const ccList = [];
  if (loEmail && String(loEmail).toLowerCase() !== String(toEmail).toLowerCase()) {
    ccList.push(loEmail);
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      ...(ccList.length ? { cc: ccList } : {}),
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
  return true;
}
