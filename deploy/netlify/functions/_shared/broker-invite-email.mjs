/**
 * _shared/broker-invite-email.mjs -- the Preferred Partner portal invite email.
 *
 * Deploy 237.236 (Mike: "For brokers instead of invite to borrower portal it should be
 * invite to broker portal"). Lifted out of broker-partner-save.mjs (237.234) so the desk's
 * "Email it to the partner" and the LO's "Invite Broker" on a loan send the SAME email.
 *
 * Two modes, one template:
 *   claim   -- no login yet: the link is a one-time broker-signup claim (choose a password)
 *   signin  -- a login already exists (they were a borrower-portal user, or signed in with
 *              Google before): the link is a 72h durable sign-in link
 *
 * Plain and short: who invited them, what the portal is for, the one link. Never throws;
 * the caller reports `emailed: false` and shows the link so the LO can send it by hand.
 */

const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function partnerInviteCopy({ mode, url, rec, expiry, forAddress }) {
  const first = String((rec && rec.firstName) || '').trim();
  const signin = mode === 'signin';
  const subject = signin ? 'Your SLA Capital Preferred Partner portal' : 'Your SLA Capital Preferred Partner login';
  const what = 'the SLA Capital Preferred Partner portal: see the loans you have with us, the terms being negotiated, and upload documents for your borrowers' +
    (forAddress ? ' (starting with ' + forAddress + ')' : '') + '.';
  const linkLine = signin
    ? 'Sign in here:\n' + url + '\n\n' + ((expiry && expiry.text) ? expiry.text + '\n\n' : '') +
      'You can also sign in any time at https://portal.slacapital.ai with this same email address.'
    : 'Set up your login here (the link is yours alone and works once):\n' + url;
  const text = (first ? 'Hi ' + first + ',\n\n' : '') +
    'You have been invited to ' + what + '\n\n' + linkLine + '\n\n' +
    'Questions? Just reply to this email.\n\nSLA Capital';
  const html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ece5;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px">' +
      '<div style="background:#fff;border:1px solid #ddd8d0;border-radius:12px;padding:28px">' +
        '<p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#C8813A;margin:0 0 6px">SLA Capital &middot; Preferred Partners</p>' +
        '<h1 style="font-size:20px;margin:0 0 14px;color:#261a36">' + (signin ? 'Your partner portal' : 'Your partner login') + '</h1>' +
        (first ? '<p style="font-size:14px;line-height:1.6;color:#1a1520">Hi ' + escH(first) + ',</p>' : '') +
        '<p style="font-size:14px;line-height:1.6;color:#1a1520">You have been invited to ' + escH(what) + '</p>' +
        '<p style="margin:22px 0"><a href="' + escH(url) + '" style="display:inline-block;background:#261a36;color:#f2ede6;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:8px">' + (signin ? 'Open my partner portal' : 'Set up my login') + '</a></p>' +
        (signin
          ? ((expiry && expiry.html) || '') + '<p style="font-size:12px;line-height:1.6;color:#7a7488">You can also sign in any time at <a href="https://portal.slacapital.ai" style="color:#b5712d">portal.slacapital.ai</a> with this same email address. If the button does not open, copy this address:<br>' + escH(url) + '</p>'
          : '<p style="font-size:12px;line-height:1.6;color:#7a7488">The link is yours alone and works once. If the button does not open, copy this address:<br>' + escH(url) + '</p>') +
        '<p style="font-size:12px;color:#7a7488;margin-top:24px">Questions? Just reply to this email.<br>Sir Lends A Lot LLC dba SLA Capital.</p>' +
      '</div></div></body></html>';
  return { subject, text, html };
}

/**
 * @param {object} a
 * @param {string} a.toEmail
 * @param {string} a.url         claim link or durable sign-in link
 * @param {object} a.rec         partner record (firstName is all it reads)
 * @param {string} [a.actor]     inviting staff email -> reply-to
 * @param {'claim'|'signin'} [a.mode]
 * @param {{text:string,html:string}} [a.expiry]   linkExpiryCopy() for a signin link
 * @param {string} [a.forAddress]                  the loan the invite was sent from
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function sendPartnerInviteEmail(a) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  const { subject, text, html } = partnerInviteCopy({ mode: a.mode || 'claim', url: a.url, rec: a.rec || {}, expiry: a.expiry, forAddress: a.forAddress });
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'SLA Capital <noreply@leads.slacapital.com>', to: [a.toEmail], subject, text, html, ...(a.actor ? { reply_to: a.actor } : {}) }),
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); return { ok: false, error: 'Resend ' + resp.status + ' ' + t.slice(0, 160) }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || 'send failed' }; }
}
