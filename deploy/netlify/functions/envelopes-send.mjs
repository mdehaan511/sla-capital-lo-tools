/**
 * envelopes-send.mjs — POST /api/envelopes-send
 *
 * NATIVE eSIGN \u2014 Deploy 185. Second phase of the e-sign flow. The
 * frontend calls /api/envelopes first (validates + saves record +
 * stashes PDF bytes), then this endpoint to:
 *
 *   1. Generate a unique signing token for each signer
 *   2. Index each token in `envelope-signer-idx` for O(1) lookup
 *   3. Email each signer an invitation with their personalized link
 *   4. Flip envelope status to 'sent'
 *
 * Body: { envelopeId, owner? }
 * Auth: requester or admin.
 *
 * On email failure the envelope still has tokens — the LO can
 * "Resend signing link" per-signer to retry just that signer.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { generateSignerToken } from './_shared/native-esign.mjs';
// Deploy 223 — reply_to = LO who owns the lead.
import { getOwnerReplyTo, resolveOwnerEmail, logBorrowerSend } from './_shared/email.mjs';

const TOKEN_TTL_DAYS = 30;

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('envelopes-send top-level error:', e);
    return json(500, {
      error: 'Server error: ' + ((e && e.message) || 'unknown'),
      stack: String((e && e.stack) || '').split('\n').slice(0, 5).join(' | ').slice(0, 500),
    });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });

  // Deploy 236.156 — skipEmail:true generates per-signer tokens
  // and indexes them, then returns the signing URLs WITHOUT
  // sending any invitation emails. Lets the LO copy the link
  // and text it to the borrower instead. Same envelope record
  // and same signing flow — only the delivery channel changes.
  const skipEmail = body.skipEmail === true;

  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const store = getStore({ name: 'envelopes', consistency: 'strong' });
  const key = `${ownerKey}/${body.envelopeId}`;

  let env;
  try { env = await store.get(key, { type: 'json' }); } catch (_) { env = null; }
  if (!env) return json(404, { error: 'Envelope not found' });
  if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
    return json(403, { error: 'Not authorized to send this envelope' });
  }
  if (env.status !== 'queued') {
    return json(200, { ok: true, envelope: env, note: 'Envelope already past queued state' });
  }
  if (env.envelopeMode === 'pandadoc-legacy') {
    return json(400, {
      error: 'This is a legacy PandaDoc envelope. PandaDoc is no longer integrated; create a new envelope to use the native e-sign flow.',
    });
  }

  const now = new Date().toISOString();
  const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Generate tokens + write to the signer-token index for O(1) lookup
  const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
  env.signers = await Promise.all(env.signers.map(async (s, i) => {
    const token = generateSignerToken();
    try {
      await idx.setJSON(token, {
        envelopeKey: key,
        signerIndex: i,
        expiresAt: tokenExpiresAt,
      });
    } catch (e) {
      console.warn('signer idx write failed (lookup will walk):', e && e.message);
    }
    return {
      ...s,
      token,
      tokenExpiresAt,
      invitedAt: now,
    };
  }));

  // Build the signing URL base — prefer the request host so preview
  // deploys self-resolve.
  const proto = (req.headers.get ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto']) || 'https';
  const host  = (req.headers.get ? req.headers.get('host') : req.headers.host) || '';
  const base  = host ? `${proto}://${host}` : (process.env.URL || 'https://slaloantools.netlify.app');

  // Look up LO profile for "from" display name in emails
  let loName = '';
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });
    const p = await profilesStore.get(keySafe(env.requesterEmail), { type: 'json' });
    if (p) loName = ((p.firstName || '') + ' ' + (p.lastName || '')).trim() || env.requesterEmail;
  } catch (_) {}
  if (!loName) loName = env.requesterEmail;

  // Look up property address from the loan for context in the email
  let propertyAddress = '';
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });
    const client = await clientsStore.get(`${env.ownerKey}/${env.clientId}`, { type: 'json' });
    const loan = client && (client.loans || []).find((l) => l.id === env.loanId);
    if (loan) propertyAddress = loan.propertyAddress || '';
  } catch (_) {}

  // Stamp the signing URL onto each signer in the response so
  // the frontend can display a copy-able link without having to
  // reassemble the URL itself. Used by both flows (email + link-
  // only) but only critical for the link-only path.
  const signingUrls = env.signers.map((s) =>
    `${base}/term-sheet-sign.html?t=${encodeURIComponent(s.token)}`
  );

  // Deploy 236.156 \u2014 link-only flow: skip the email sends entirely,
  // mark the envelope sent with a history note, and return the
  // signing URLs so the LO can copy + text them.
  if (skipEmail) {
    env.status = 'sent';
    env.statusUpdatedAt = now;
    env.sendError = null;
    env.history.push({
      ts: now,
      status: 'sent',
      note: `Generated ${env.signers.length} signing link(s); no invitation email sent (link-only flow).`,
    });
    try { await store.setJSON(key, env); }
    catch (e) { console.warn('envelope post-send (skipEmail) write failed:', e && e.message); }
    return json(200, {
      ok: true,
      envelope: env,
      signingUrls,
      emailResults: env.signers.map((s) => ({ email: s.email, ok: null, skipped: true })),
    });
  }

  // Send invitation emails
  const emailResults = [];
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    env.status = 'sent';
    env.statusUpdatedAt = now;
    env.sendError = 'RESEND_API_KEY not configured \u2014 tokens generated but no emails sent.';
    env.history.push({ ts: now, status: 'sent', note: env.sendError });
    try { await store.setJSON(key, env); } catch (_) {}
    return json(200, { ok: true, envelope: env, signingUrls, warning: env.sendError });
  }

  // Deploy 236.843 — SEQUENTIAL envelopes (loan extensions: lender reviews +
  // signs before the borrower is ever invited). Only the FIRST unsigned
  // signer gets the invitation now; envelope-sign invites the next signer
  // the moment the current one completes.
  const _firstUnsignedIdx = env.sequential
    ? env.signers.findIndex((s) => !s.audit || !s.audit.signedAt)
    : -1;
  for (let i = 0; i < env.signers.length; i++) {
    const s = env.signers[i];
    if (env.sequential && i !== _firstUnsignedIdx) {
      emailResults.push({ email: s.email, ok: null, deferred: true });
      continue;
    }
    const link = signingUrls[i];
    try {
      const r = await sendInvitationEmail({
        apiKey, signer: s, envelope: env, link, loName, propertyAddress,
        ownerKey: env.ownerKey,
      });
      if (r) s.invitedAt = now;
      emailResults.push({ email: s.email, ok: r });
    } catch (e) {
      console.warn('invitation email failed for', s.email, e && e.message);
      emailResults.push({ email: s.email, ok: false, error: (e && e.message) || 'unknown' });
    }
  }

  const allEmailsOk = emailResults.every((r) => r.ok || r.deferred); // deferred = sequential, invited later
  env.status = allEmailsOk ? 'sent' : 'partial_send_failure';
  env.statusUpdatedAt = now;
  env.sendError = allEmailsOk ? null : 'Some invitation emails failed to send';
  env.history.push({
    ts: now,
    status: env.status,
    note: allEmailsOk
      ? `Sent invitations to ${env.signers.length} signer(s).`
      : 'Send results: ' + JSON.stringify(emailResults).slice(0, 400),
  });

  try { await store.setJSON(key, env); }
  catch (e) { console.warn('envelope post-send write failed:', e && e.message); }

  return json(200, { ok: true, envelope: env, signingUrls, emailResults });
}

// Deploy 236.843 — exported so envelope-sign can invite the NEXT signer of a
// sequential envelope with the identical email the first signer received.
// Deploy 236.848 — optional `reminder` flag: same email + same link, but the
// subject/intro make clear it's a nudge (esign-reminder-cron re-sends daily).
export async function sendInvitationEmail({ apiKey, signer, envelope, link, loName, propertyAddress, ownerKey, reminder }) {
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const docList = (envelope.docs || []).map((d) => d.name).join(', ');
  const subject = (reminder ? 'Reminder — please review and sign: ' : 'Please review and sign: ') +
    (docList || 'SLA Capital documents');
  const intro = reminder
    ? `This is a friendly reminder — ${loName} at SLA Capital is still waiting on your electronic signature for the document${envelope.docs.length === 1 ? '' : 's'} below.`
    : `${loName} at SLA Capital has prepared ${envelope.docs.length} document${envelope.docs.length === 1 ? '' : 's'} for your review and electronic signature.`;

  const text = [
    `Hi ${signer.firstName},`,
    '',
    intro,
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    `Documents: ${docList}`,
    '',
    envelope.message ? 'Note from your loan officer:' : '',
    envelope.message ? envelope.message : '',
    '',
    'Click the link below to review and sign:',
    link,
    '',
    'This link is unique to you and expires in 30 days.',
    '',
    'Reply to this email if you have any questions.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital \u2014 Documents for Your Signature</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(signer.firstName)},</p>` +
        (reminder
          ? `<p style="font-size:14px;line-height:1.6">This is a friendly reminder — <strong>${escH(loName)}</strong> at SLA Capital is still waiting on your electronic signature for the document${envelope.docs.length === 1 ? '' : 's'} below.</p>`
          : `<p style="font-size:14px;line-height:1.6"><strong>${escH(loName)}</strong> at SLA Capital has prepared ` +
            `${envelope.docs.length} document${envelope.docs.length === 1 ? '' : 's'} for your review and electronic signature.</p>`) +
        (propertyAddress
          ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
          : '') +
        `<p style="font-size:14px;line-height:1.6"><strong>Documents:</strong> ${escH(docList)}</p>` +
        (envelope.message
          ? `<div style="background:#F5E9D8;padding:14px 16px;border-left:3px solid #C8813A;border-radius:4px;margin:16px 0">` +
              `<p style="font-size:13px;line-height:1.55;margin:0"><strong>Note from your loan officer:</strong></p>` +
              `<p style="font-size:13px;line-height:1.55;margin:6px 0 0;white-space:pre-wrap">${escH(envelope.message)}</p>` +
            `</div>`
          : '') +
        `<p style="margin:24px 0;text-align:center"><a href="${escH(link)}" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Review and Sign \u2192</a></p>` +
        `<p style="font-size:12px;color:#7A7488">Or copy and paste this link: <a href="${escH(link)}">${escH(link)}</a></p>` +
        '<p style="font-size:12px;color:#7A7488">This link is unique to you and expires in 30 days.</p>' +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital. For business-purpose, investment property loans only.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  const replyTo = await getOwnerReplyTo(ownerKey);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [signer.email],
      subject, text, html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
  // Deploy 236.684 — log this send keyed by the Resend email id so the webhook
  // can notify the LO if it later bounces. Best-effort; never blocks the send.
  try {
    const data = await resp.json().catch(() => null);
    const emailId = data && data.id;
    if (emailId) {
      const kinds = (envelope.docs || []).map((d) => String((d && d.kind) || 'document'));
      const loEmail = await resolveOwnerEmail({ ownerKey });
      await logBorrowerSend(emailId, {
        kind: 'envelope',
        docKinds: kinds,
        docNames: docList,
        to: signer.email,
        signerName: [signer.firstName, signer.lastName].filter(Boolean).join(' '),
        loEmail,
        ownerKey,
        loName,
        address: propertyAddress || '',
        envelopeId: envelope.id || '',
        clientId: envelope.clientId || '',
        loanId: envelope.loanId || '',
      });
    }
  } catch (e) {
    console.warn('envelopes-send: send-log write failed:', e && e.message);
  }
  return true;
}
