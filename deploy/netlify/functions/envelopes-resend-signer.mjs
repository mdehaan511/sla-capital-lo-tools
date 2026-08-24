/**
 * envelopes-resend-signer.mjs — POST /api/envelopes-resend-signer
 *
 * NATIVE eSIGN \u2014 Deploy 185. Rotates a single signer\u2019s token and
 * re-sends their invitation email. Useful when:
 *   - A signer lost the original email
 *   - Their token expired (we still allow LO to rotate; resets to 30d)
 *   - They want a fresh link delivered
 *
 * Body: { envelopeId, signerIndex, owner? }
 * Auth: requester or admin.
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
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const body = await readJsonBody(req);
    if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });
    const signerIndex = parseInt(body.signerIndex, 10);
    if (!Number.isInteger(signerIndex) || signerIndex < 0) {
      return json(400, { error: 'signerIndex required (integer >= 0)' });
    }

    const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
    const store = getStore({ name: 'envelopes', consistency: 'strong' });
    const key = `${ownerKey}/${body.envelopeId}`;

    let env;
    try { env = await store.get(key, { type: 'json' }); }
    catch (_) { env = null; }
    if (!env) return json(404, { error: 'Envelope not found' });
    if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
      return json(403, { error: 'Not authorized' });
    }
    if (env.envelopeMode === 'pandadoc-legacy') {
      return json(400, { error: 'This is a legacy PandaDoc envelope. Resend is not supported.' });
    }
    if (env.status === 'voided' || env.status === 'completed') {
      return json(400, { error: 'Envelope is ' + env.status });
    }
    const signer = env.signers && env.signers[signerIndex];
    if (!signer) return json(404, { error: 'Signer not found at that index' });
    if (signer.audit && signer.audit.signedAt) {
      return json(409, { error: 'This signer has already signed.' });
    }

    // Rotate the token
    const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
    const oldToken = signer.token;
    const newToken = generateSignerToken();
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    env.signers[signerIndex] = {
      ...signer,
      token: newToken,
      tokenExpiresAt,
      invitedAt: now,
      resendCount: (signer.resendCount || 0) + 1,
    };

    try { await idx.setJSON(newToken, { envelopeKey: key, signerIndex, expiresAt: tokenExpiresAt }); }
    catch (e) { console.warn('idx write failed:', e && e.message); }
    if (oldToken) {
      try { await idx.delete(oldToken); } catch (_) {}
    }

    env.history.push({
      ts: now,
      status: env.status,
      note: `Resent signing link to ${signer.firstName} ${signer.lastName} <${signer.email}> (resend #${env.signers[signerIndex].resendCount}).`,
    });
    try { await store.setJSON(key, env); }
    catch (e) { console.error('resend write failed:', e); return json(500, { error: 'Failed to save' }); }

    // Send the email
    const apiKey = process.env.RESEND_API_KEY;
    let emailedAt = null;
    if (apiKey) {
      const proto = (req.headers.get ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto']) || 'https';
      const host  = (req.headers.get ? req.headers.get('host') : req.headers.host) || '';
      const base  = host ? `${proto}://${host}` : (process.env.URL || 'https://slaloantools.netlify.app');
      const link  = `${base}/term-sheet-sign.html?t=${encodeURIComponent(newToken)}`;

      let loName = env.requesterEmail;
      try {
        const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });
        const p = await profilesStore.get(keySafe(env.requesterEmail), { type: 'json' });
        if (p) {
          const n = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
          if (n) loName = n;
        }
      } catch (_) {}

      const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const docList = (env.docs || []).map((d) => d.name).join(', ');

      const text = [
        `Hi ${signer.firstName},`,
        '',
        `This is a fresh signing link from ${loName} at SLA Capital for the document(s) below.`,
        '',
        `Documents: ${docList}`,
        '',
        link,
        '',
        'This link expires in 30 days. The previous link no longer works.',
        '',
        'Sir Lends A Lot LLC dba SLA Capital',
      ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

      const html =
        '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
        '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
          '<div style="background:#261A36;padding:24px">' +
            '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital \u2014 New Signing Link</h1>' +
          '</div>' +
          '<div style="padding:24px;color:#1A1520">' +
            `<p style="font-size:14px;line-height:1.6">Hi ${escH(signer.firstName)},</p>` +
            `<p style="font-size:14px;line-height:1.6">This is a fresh signing link from <strong>${escH(loName)}</strong> at SLA Capital.</p>` +
            `<p style="font-size:14px"><strong>Documents:</strong> ${escH(docList)}</p>` +
            `<p style="margin:24px 0;text-align:center"><a href="${escH(link)}" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Review and Sign \u2192</a></p>` +
            `<p style="font-size:12px;color:#7A7488">Or copy and paste this link: <a href="${escH(link)}">${escH(link)}</a></p>` +
            '<p style="font-size:12px;color:#7A7488">This link expires in 30 days. The previous link no longer works.</p>' +
          '</div>' +
        '</div>' +
        '</body></html>';

      const replyTo = await getOwnerReplyTo(ownerKey);
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'SLA Capital <noreply@leads.slacapital.com>',
            to: [signer.email],
            subject: 'New signing link \u2014 ' + docList,
            text, html,
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
        });
        if (resp.ok) {
          emailedAt = new Date().toISOString();
          // Deploy 236.684 — log the send so the webhook can alert the LO on a bounce.
          try {
            const data = await resp.json().catch(() => null);
            const emailId = data && data.id;
            if (emailId) {
              const kinds = (env.docs || []).map((d) => String((d && d.kind) || 'document'));
              const loEmail = await resolveOwnerEmail({ ownerKey });
              await logBorrowerSend(emailId, {
                kind: 'envelope', docKinds: kinds, docNames: docList,
                to: signer.email,
                signerName: [signer.firstName, signer.lastName].filter(Boolean).join(' '),
                loEmail, ownerKey, loName,
                address: env.propertyAddress || '',
                envelopeId: env.id || '', clientId: env.clientId || '', loanId: env.loanId || '',
              });
            }
          } catch (e) { console.warn('envelopes-resend-signer: send-log write failed:', e && e.message); }
        }
      } catch (e) {
        console.warn('resend email threw:', e && e.message);
      }
    }

    return json(200, {
      ok: true, emailedAt,
      expiresAt: tokenExpiresAt,
      resendCount: env.signers[signerIndex].resendCount,
    });
  } catch (e) {
    console.error('envelopes-resend-signer error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};
