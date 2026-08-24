/**
 * borrower2-auth-resend.mjs — POST /api/borrower2-auth-resend
 *
 * Deploy 182. LO-authed endpoint to regenerate borrower-2\u2019s signing
 * token and resend the auth email. Used when the original email has
 * expired, was lost, or the LO needs to nudge the co-borrower.
 *
 * Body: { clientId, loanId, owner? }
 *
 * Returns: { ok, expiresAt, emailedAt }
 *
 * Side effects:
 *   - generates a NEW borrower2 token (rotates the old one)
 *   - extends tokenExpiresAt by 30 days from now
 *   - removes the OLD token from borrower2_token_idx (replay protection)
 *   - writes the NEW token into borrower2_token_idx
 *   - emails the co-borrower a fresh signing link
 *
 * Only valid when the signed_applications record exists AND
 * status === 'awaiting_borrower2'. If borrower 2 already signed,
 * returns 409.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, readJsonBody,
  requireAuth, normalizeEmail, isAdmin, keySafe,
} from './_shared/auth.mjs';
import { generateBorrower2Token } from './_shared/esign.mjs';
// Deploy 223 — reply_to = LO who owns the lead.
import { getOwnerReplyTo, logBorrowerSendFromResponse } from './_shared/email.mjs';

const B2_TOKEN_TTL_DAYS = 30;

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower2-auth-resend error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null)   return json(400, { error: 'Invalid JSON' });
  if (!body.clientId)  return json(400, { error: 'clientId required' });
  if (!body.loanId)    return json(400, { error: 'loanId required' });
  // Deploy 236.83 — pos defaults to 2 for back-compat with existing
  // UI / API callers that don't yet know about borrower 3 / 4.
  const pos = body.borrowerPos && [2, 3, 4].includes(body.borrowerPos) ? body.borrowerPos : 2;

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  const key = `${ownerKey}/${keySafe(body.clientId)}/${keySafe(body.loanId)}`;
  let rec = null;
  try { rec = await store.get(key, { type: 'json' }); } catch (_) {}
  if (!rec) return json(404, { error: 'No signed application on file for this loan.' });

  // The status name 'awaiting_borrower2' is kept for legacy reasons —
  // it now means "awaiting any secondary signature". Block resends
  // when the overall application is already complete.
  if (rec.status === 'complete') {
    return json(409, { error: 'Application already fully signed — no resend needed.' });
  }
  const bField = rec['borrower' + pos];
  if (!bField) return json(409, { error: 'No borrower ' + pos + ' on this application.' });
  if (bField.audit && bField.audit.signedAt) {
    return json(409, { error: 'Borrower ' + pos + ' has already signed this authorization.' });
  }

  // ── Rotate the token ───────────────────────────────────────────
  const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
  const oldToken = bField.token;
  const newToken = generateBorrower2Token();
  const newExpiresAt = new Date(Date.now() + B2_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  bField.token = newToken;
  bField.tokenExpiresAt = newExpiresAt;
  bField.invitedAt = new Date().toISOString();
  bField.resendCount = (bField.resendCount || 0) + 1;
  bField.lastResentBy = user.email || '';
  rec['borrower' + pos] = bField;
  rec.updatedAt = new Date().toISOString();

  try { await store.setJSON(key, rec); }
  catch (e) {
    console.error('borrower2-auth-resend: setJSON failed:', e);
    return json(500, { error: 'Failed to save updated record' });
  }

  try { await idx.setJSON(newToken, { signedKey: key, pos, expiresAt: newExpiresAt }); }
  catch (e) { console.warn('b2 idx write failed (lookup will walk):', e); }
  // Best-effort: drop the old token. If this fails the old token is
  // still valid against the lookup index but will fail the
  // token-match check in the sign endpoint (since the borrower's
  // token has been rotated), so replay is still prevented.
  if (oldToken) {
    try { await idx.delete(oldToken); }
    catch (e) { console.warn('b2 idx delete old token failed:', e); }
  }

  // ── Email the new link ─────────────────────────────────────────
  const apiKey = process.env.RESEND_API_KEY;
  let emailedAt = null;
  if (apiKey && bField.email) {
    // Build link with the request host so preview deploys stay self-
    // contained. Same pattern used in borrower-info-sign.mjs.
    const proto = (req.headers.get ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto']) || 'https';
    const host  = (req.headers.get ? req.headers.get('host') : req.headers.host) || '';
    const base  = host ? `${proto}://${host}` : (process.env.URL || 'https://slaloantools.netlify.app');
    const link  = `${base}/borrower2-auth.html?t=${encodeURIComponent(newToken)}`;

    const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const subject = 'Reminder: Sign your SLA Capital co-borrower authorization';
    const b1Name = (rec.borrower1 && rec.borrower1.name) || 'your co-borrower';
    const propertyAddress = rec.propertyAddress || '';

    const text = [
      `Hi ${bField.name},`,
      '',
      `This is a reminder that ${b1Name} is waiting on your authorization to move forward with their loan application at SLA Capital.`,
      '',
      'Federal law (Fair Credit Reporting Act) requires your own authorization for the credit pull and background check — your co-borrower can\u2019t do it for you.',
      '',
      propertyAddress ? `Property: ${propertyAddress}` : '',
      '',
      'Sign here:',
      link,
      '',
      'This link expires in 30 days.',
      '',
      'If you have any questions, just reply to this email.',
      '',
      'Sir Lends A Lot LLC dba SLA Capital',
    ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

    const html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
      '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
        '<div style="background:#261A36;padding:24px">' +
          '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital \u2014 Reminder: Co-Borrower Authorization</h1>' +
        '</div>' +
        '<div style="padding:24px;color:#1A1520">' +
          `<p style="font-size:14px;line-height:1.6">Hi ${escH(bField.name)},</p>` +
          `<p style="font-size:14px;line-height:1.6">This is a reminder that <strong>${escH(b1Name)}</strong> is waiting on your authorization to move forward with their loan application at SLA Capital.</p>` +
          '<p style="font-size:14px;line-height:1.6">Federal law (Fair Credit Reporting Act) requires your own authorization for the credit pull and background check \u2014 your co-borrower can\u2019t do it for you.</p>' +
          (propertyAddress
            ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
            : '') +
          `<p style="margin:24px 0;text-align:center"><a href="${escH(link)}" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Sign your authorization \u2192</a></p>` +
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
          to: [bField.email],
          subject, text, html,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
      if (resp.ok) {
        emailedAt = new Date().toISOString();
        // Deploy 236.685 — track delivery so the LO is alerted if the co-signer link bounces.
        await logBorrowerSendFromResponse(resp, { kind: 'cosigner_resend', to: bField.email, ownerKey: rec.ownerKey });
      } else {
        const t = await resp.text().catch(() => '');
        console.warn('borrower2-auth-resend: email failed', resp.status, t.slice(0, 200));
      }
    } catch (e) {
      console.warn('borrower2-auth-resend: email threw', e && e.message);
    }
  }

  return json(200, {
    ok: true,
    expiresAt: newExpiresAt,
    emailedAt,
    b2Email: bField.email,
    pos,
    resendCount: bField.resendCount,
  });
}
