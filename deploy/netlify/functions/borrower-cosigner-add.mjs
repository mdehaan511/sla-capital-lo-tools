/**
 * borrower-cosigner-add.mjs — POST /api/borrower-cosigner-add
 *
 * Deploy 236.629 — send a signing link to a guarantor who was added to the loan
 * AFTER Borrower 1 already signed the application. When B1 signs, the secondary
 * (co-borrower / guarantor) auth links are generated only for the guarantors that
 * were in the application data at that moment. A guarantor added later (via
 * "+ Add Guarantor") has a client record + a loan link, but no signing block on
 * the signed_applications record — so there was no way to send them their FCRA
 * prequal-credit/background authorization. This endpoint creates that block and
 * emails them their link, putting the record into the normal awaiting-secondary
 * state (borrower2-auth-sign completes it exactly as for an original co-borrower).
 *
 * Body: { clientId (primary), loanId, guarantorClientId, owner?,
 *         sendEmail? (default true), email? (override the address to send to) }
 * Returns: { ok, pos, emailedAt, email, resent, link }
 * Deploy 236.630 — returns the signing `link` (so the LO can copy/send it directly)
 * and honors sendEmail:false to just generate the link without emailing.
 *
 * Requires the primary borrower to have signed (a signed_applications record must
 * exist). Idempotent-ish: if the guarantor is already a pending secondary, it just
 * rotates + resends their token.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, readJsonBody,
  requireAuth, normalizeEmail, isAdmin, keySafe,
} from './_shared/auth.mjs';
import { generateBorrower2Token } from './_shared/esign.mjs';
import { getOwnerReplyTo, logBorrowerSendFromResponse } from './_shared/email.mjs';

const B2_TOKEN_TTL_DAYS = 30;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-cosigner-add error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null)           return json(400, { error: 'Invalid JSON' });
  if (!body.clientId)          return json(400, { error: 'clientId required' });
  if (!body.loanId)            return json(400, { error: 'loanId required' });
  if (!body.guarantorClientId) return json(400, { error: 'guarantorClientId required' });

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  // ── Load the signed application (B1 must have signed) ──────────────
  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  const key = `${ownerKey}/${keySafe(body.clientId)}/${keySafe(body.loanId)}`;
  let rec = null;
  try { rec = await store.get(key, { type: 'json' }); } catch (_) {}
  if (!rec) {
    return json(409, {
      error: 'Borrower 1 has not signed the application yet. Send the full loan ' +
             'application to the primary borrower first — a co-signer can only sign ' +
             'their own authorization after the primary borrower completes the application.',
    });
  }

  // ── Resolve the guarantor client (name / email / phone) ────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let g = null;
  try { g = await clientsStore.get(`${ownerKey}/${keySafe(body.guarantorClientId)}`, { type: 'json' }); } catch (_) {}
  if (!g) return json(404, { error: 'Guarantor client not found for this owner.' });
  const gEmail = String(g.email || '').trim().toLowerCase();
  // Deploy 236.630 — sendEmail defaults on; `email` overrides the send/record
  // address. When sendEmail is off we still create the token + return the link.
  const wantEmail = body.sendEmail !== false;
  const overrideEmail = String(body.email || '').trim().toLowerCase();
  const targetEmail = overrideEmail || gEmail;
  const gName = ((g.firstName || '') + ' ' + (g.lastName || '')).trim() || targetEmail || 'Co-Borrower';
  if (wantEmail && (!targetEmail || targetEmail.indexOf('@') < 0)) {
    return json(400, { error: 'A valid email is required to send the link. Add one for the guarantor, type one in, or turn off the email option to just get the link.' });
  }

  // Don't offer to "co-sign" the primary borrower back to themselves.
  const b1Email = String((rec.borrower1 && rec.borrower1.email) || '').trim().toLowerCase();
  if (targetEmail && targetEmail === b1Email) {
    return json(409, { error: 'This is the primary borrower — they already signed the application.' });
  }

  const now = new Date().toISOString();
  const newExpiresAt = new Date(Date.now() + B2_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ── Find this guarantor's existing secondary block, or the next free slot ──
  let pos = null, resent = false;
  for (const p of [2, 3, 4]) {
    const bf = rec['borrower' + p];
    if (!bf) continue;
    const bfEmail = String(bf.email || '').trim().toLowerCase();
    const same = (bf.guarantorClientId && bf.guarantorClientId === body.guarantorClientId)
      || (gEmail && bfEmail === gEmail)
      || (targetEmail && bfEmail === targetEmail);
    if (same) {
      if (bf.audit && bf.audit.signedAt) {
        return json(409, { error: gName + ' has already signed their authorization.' });
      }
      pos = p; resent = true; break; // pending — rotate + resend below
    }
  }
  if (pos == null) {
    for (const p of [2, 3, 4]) { if (!rec['borrower' + p]) { pos = p; break; } }
  }
  if (pos == null) {
    return json(409, { error: 'This application already has the maximum of 4 signers.' });
  }

  // ── Create / rotate the secondary block ────────────────────────────
  const newToken = generateBorrower2Token();
  const existing = rec['borrower' + pos] || {};
  rec['borrower' + pos] = {
    role: 'borrower' + pos,
    name: existing.name || gName,
    email: targetEmail || gEmail || '',
    phone: g.phone || existing.phone || '',
    token: newToken,
    tokenExpiresAt: newExpiresAt,
    invitedAt: now,
    audit: null,
    signedAuths: [],
    resendCount: resent ? ((existing.resendCount || 0) + 1) : 0,
    addedAfterSigning: !resent,        // marks a guarantor added post-B1-signature
    addedBy: user.email || '',
    guarantorClientId: body.guarantorClientId,
  };
  // The status name 'awaiting_borrower2' is legacy for "awaiting any secondary".
  if (rec.status === 'complete') rec.status = 'awaiting_borrower2';
  rec.numBorrowers = 1 + [2, 3, 4].filter((p) => !!rec['borrower' + p]).length;
  rec.updatedAt = now;

  try { await store.setJSON(key, rec); }
  catch (e) { return json(500, { error: 'Failed to save signed application: ' + (e.message || 'unknown') }); }

  // ── Index the token (borrower2_token_idx: token -> { signedKey, pos }) ──
  const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
  const oldToken = resent ? existing.token : null;
  try { await idx.setJSON(newToken, { signedKey: key, pos, expiresAt: newExpiresAt }); }
  catch (e) { console.warn('borrower-cosigner-add: idx write failed (lookup will walk):', e && e.message); }
  if (oldToken) { try { await idx.delete(oldToken); } catch (_) {} }

  // ── Build the link; email it only when requested ───────────────────
  const link = buildAuthLink(req, newToken);
  let emailedAt = null;
  if (wantEmail && targetEmail) {
    emailedAt = await emailCosignerLink({ rec, toEmail: targetEmail, toName: gName, link });
  }

  return json(200, { ok: true, pos, emailedAt, email: targetEmail, resent, link });
}

function buildAuthLink(req, token) {
  const proto = (req.headers.get ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto']) || 'https';
  const host  = (req.headers.get ? req.headers.get('host') : req.headers.host) || '';
  const base  = host ? `${proto}://${host}` : (process.env.URL || 'https://slaloantools.netlify.app');
  return `${base}/borrower2-auth.html?t=${encodeURIComponent(token)}`;
}

async function emailCosignerLink({ rec, toEmail, toName, link }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !toEmail) return null;

  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const b1Name = (rec.borrower1 && rec.borrower1.name) || 'your co-borrower';
  const propertyAddress = rec.propertyAddress || '';
  const subject = 'Action required: Co-borrower authorization for SLA Capital loan application';

  const text = [
    `Hi ${toName},`,
    '',
    `${b1Name} has a loan application with SLA Capital that lists you as a co-borrower or guarantor.`,
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
    'If you have any questions, reply to this email and we’ll get back to you.',
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
        `<p style="font-size:14px;line-height:1.6"><strong>${escH(b1Name)}</strong> has a loan application with SLA Capital that lists you as a co-borrower or guarantor.</p>` +
        '<p style="font-size:14px;line-height:1.6">To move the application forward, we need you to electronically sign your own <strong>Authorization to Conduct Prequal Credit &amp; Background Checks</strong>. This is required by federal law (Fair Credit Reporting Act) — your authorization must come directly from you, not from your co-borrower.</p>' +
        (propertyAddress ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>` : '') +
        `<p style="margin:24px 0;text-align:center"><a href="${escH(link)}" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Sign your authorization →</a></p>` +
        `<p style="font-size:12px;color:#7A7488">Or copy and paste this link: <a href="${escH(link)}">${escH(link)}</a></p>` +
        '<p style="font-size:12px;color:#7A7488">This link expires in 30 days.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  const replyTo = await getOwnerReplyTo(rec.ownerKey);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'SLA Capital <noreply@leads.slacapital.com>',
        to: [toEmail], subject, text, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (resp.ok) {
      // Deploy 236.685 — track delivery so the LO is alerted if the co-signer invite bounces.
      await logBorrowerSendFromResponse(resp, { kind: 'cosigner_invite', to: toEmail, ownerKey: rec.ownerKey });
      return new Date().toISOString();
    }
    const t = await resp.text().catch(() => '');
    console.warn('borrower-cosigner-add: email failed', resp.status, t.slice(0, 200));
    return null;
  } catch (e) {
    console.warn('borrower-cosigner-add: email threw', e && e.message);
    return null;
  }
}
