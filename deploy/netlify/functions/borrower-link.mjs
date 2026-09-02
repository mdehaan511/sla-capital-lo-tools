/**
 * borrower-link.mjs — GET/POST /api/borrower-link
 *
 * Deploy 236.818 — durable 72-hour borrower portal links (Mike). Invite emails
 * now carry /api/borrower-link?t=<signed token> instead of a raw Supabase
 * magic link (whose OTP window is short). At click time this endpoint mints a
 * FRESH Supabase magic link for the token's email and 302-redirects to it, so
 * the Supabase link is always seconds old when the borrower uses it.
 *
 * GET  ?t=<token>            valid → 302 to a fresh magic link
 *                            expired → branded page with "Email me a new link"
 *                            invalid → branded error page
 * POST t=<token>&action=resend  (form) — signature must verify (expiry is
 *                            ignored: an expired token proves the holder got
 *                            the original email). Mints a NEW 72h link and
 *                            emails it to the token's OWN address — never to
 *                            an address the requester chooses.
 *
 * No auth — the signed token IS the credential, same trust model as the
 * magic-link email it replaces.
 */
import {
  getSb, borrowerMagicLink, sendBorrowerEmail, escHtml,
  mintDurablePortalLink, verifyDurablePortalToken, portalLinkExpiryText,
  PORTAL_LINK_TTL_HOURS,
} from './_shared/borrower-invite-core.mjs';

export default async (req) => {
  try { return await handle(req); }
  catch (e) {
    console.error('borrower-link error:', e);
    return _page('Something went wrong', '<p>We hit an unexpected error. Please try the link again, or sign in at the portal with Google.</p>' + _portalBtn(), 500);
  }
};

async function handle(req) {
  const url = new URL(req.url);
  const origin = url.origin;

  if (req.method === 'POST') {
    // Resend flow — form-encoded from the expired page.
    let token = '';
    try {
      const ct = String(req.headers.get('content-type') || '');
      if (ct.indexOf('application/json') >= 0) {
        const b = await req.json();
        token = (b && b.t) || '';
      } else {
        const body = await req.text();
        const params = new URLSearchParams(body);
        token = params.get('t') || '';
      }
    } catch (_) {}
    const v = verifyDurablePortalToken(token);
    if (!v) return _page('Invalid link', '<p>This link is not valid. Please ask your loan officer to send a new portal invitation.</p>', 400);

    const fresh = mintDurablePortalLink(v.email, origin);
    if (!fresh) return _page('Unavailable', '<p>Link service is not configured. Please contact your loan officer.</p>', 500);
    const mail = _newLinkEmail(fresh.url, fresh.expiresText);
    let sent = false;
    try { sent = await sendBorrowerEmail(v.email, mail.subject, mail.text, mail.html, '', { kind: 'portal_link_resend' }); }
    catch (e) { console.warn('borrower-link: resend failed:', e && e.message); }
    if (!sent) return _page('Could not send', '<p>We could not send the email just now. Please try again in a minute, or sign in at the portal with Google.</p>' + _portalBtn(), 500);
    return _page('New link sent ✓',
      '<p>A fresh sign-in link is on its way to <strong>' + escHtml(_maskEmail(v.email)) + '</strong>.</p>' +
      '<p style="color:#7a7488;font-size:13px">It will be valid for ' + PORTAL_LINK_TTL_HOURS + ' hours. You can close this page.</p>');
  }

  if (req.method !== 'GET') return _page('Not allowed', '<p>Unsupported request.</p>', 405);

  const token = url.searchParams.get('t') || '';
  const v = verifyDurablePortalToken(token);
  if (!v) return _page('Invalid link', '<p>This sign-in link is not valid. Please use the most recent email from SLA Capital, or ask your loan officer for a new invitation.</p>' + _portalBtn(), 400);

  if (v.expired) {
    return _page('This link has expired',
      '<p>For your security, sign-in links are only valid for ' + PORTAL_LINK_TTL_HOURS + ' hours. This one expired on <strong>' + escHtml(portalLinkExpiryText(v.expiresMs)) + '</strong>.</p>' +
      '<p>No problem — we can email a fresh link to <strong>' + escHtml(_maskEmail(v.email)) + '</strong>:</p>' +
      '<form method="POST" action="/api/borrower-link" style="text-align:center;margin:20px 0">' +
        '<input type="hidden" name="t" value="' + escHtml(token) + '">' +
        '<button type="submit" style="background:#b5712d;color:#fff;border:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;cursor:pointer">Email me a new link</button>' +
      '</form>' +
      '<p style="color:#7a7488;font-size:13px">You can also sign in any time with Google at the portal using this same email address.</p>' + _portalBtn());
  }

  // Valid — mint a fresh Supabase magic link and bounce the borrower to it.
  const sb = getSb();
  const actionLink = sb ? await borrowerMagicLink(sb, v.email, origin) : '';
  if (!actionLink) {
    return _page('Sign in', '<p>We could not create an automatic sign-in just now. Please sign in at the portal with <strong>Google</strong> using this same email address (' + escHtml(_maskEmail(v.email)) + ').</p>' + _portalBtn(), 200);
  }
  return new Response(null, { status: 302, headers: { 'Location': actionLink, 'Cache-Control': 'no-store' } });
}

function _maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 1) return s;
  return s[0] + '•••' + s.slice(at - 1);
}

function _portalBtn() {
  return '<p style="text-align:center;margin-top:18px"><a href="/borrower-portal.html" style="color:#b5712d;font-weight:600;text-decoration:none">Go to the borrower portal &rarr;</a></p>';
}

function _page(title, bodyHtml, status) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>' + escHtml(title) + ' — SLA Capital</title></head>' +
    '<body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">' +
    '<div style="max-width:520px;margin:0 auto;padding:44px 22px">' +
      '<div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:18px">SLA Capital</div>' +
      '<div style="background:#fff;border:1px solid #e4ded2;border-radius:14px;padding:26px 24px">' +
        '<h1 style="font-size:19px;margin:0 0 12px">' + escHtml(title) + '</h1>' +
        '<div style="font-size:15px;line-height:1.55">' + bodyHtml + '</div>' +
      '</div></div></body></html>';
  return new Response(html, { status: status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function _newLinkEmail(link, expiresText) {
  const text = [
    'Hi there,', '',
    'Here is your new SLA Capital borrower portal sign-in link:', link, '',
    'For your security this link expires in ' + PORTAL_LINK_TTL_HOURS + ' hours' + (expiresText ? ' — on ' + expiresText : '') + '. If it expires, just open it anyway and you can request another with one click.', '',
    'You can also sign in any time with Google using this same email address.', '',
    '— SLA Capital',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">Here is your new borrower portal sign-in link:</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(link)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Sign in to my portal &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">For your security this link expires in <strong>${PORTAL_LINK_TTL_HOURS} hours</strong>${expiresText ? ' — on <strong>' + escHtml(expiresText) + '</strong>' : ''}. If it expires, just open it anyway and you can request another with one click.</p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${escHtml(link)}</p>
    </div></body></html>`;
  return { subject: 'Your new SLA Capital sign-in link', text, html };
}
