/**
 * resend-webhook.mjs — POST /api/resend-webhook
 *
 * Deploy 236.684 — receives Resend webhook events and, on a HARD delivery
 * failure (`email.bounced`) of a borrower-facing loan application / rate sheet,
 * emails the loan officer so they know the borrower never got it (usually a
 * typo'd address). Resend's send API returns success once the email is QUEUED,
 * so a bounce is the only reliable "didn't get delivered" signal — and it
 * arrives asynchronously, hence this webhook.
 *
 * How the LO is found: envelopes-send / envelopes-resend-signer log every
 * borrower send keyed by the Resend email id (`resend_send_log` store, via
 * _shared/email.mjs logBorrowerSend). This handler looks the bounced id up and
 * notifies the stored LO — once (markBorrowerSendNotified guards duplicates).
 *
 * Security: Resend signs webhooks with Svix. We verify the signature against
 * RESEND_WEBHOOK_SECRET. If that env var isn't set yet (initial setup), we
 * process UNVERIFIED and log a warning so it can be tested before the secret is
 * wired up — set the secret to lock it down.
 *
 * SETUP (Mike, one-time):
 *   1. Resend dashboard → Webhooks → Add endpoint:
 *        https://portal.slacapital.ai/api/resend-webhook
 *      Subscribe to at least `email.bounced` (add `email.delivery_delayed` /
 *      `email.complained` too if you want those later).
 *   2. Copy the endpoint's Signing Secret (starts with `whsec_`).
 *   3. Netlify → Site settings → Environment variables → add
 *        RESEND_WEBHOOK_SECRET = whsec_...
 *      then redeploy (or clear cache) so functions pick it up.
 */
import crypto from 'node:crypto';
import { json, handleOptions } from './_shared/auth.mjs';
import { getBorrowerSend, markBorrowerSendNotified, resolveOwnerEmail } from './_shared/email.mjs';

// Event types we treat as a delivery failure worth alerting the LO about.
const FAILURE_EVENTS = { 'email.bounced': 1, 'email.failed': 1 };

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  try {
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    // Raw body is required for signature verification — read it ourselves.
    const raw = await req.text();

    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (secret) {
      if (!verifySvixSignature(req.headers, raw, secret)) {
        console.warn('resend-webhook: signature verification FAILED — rejecting');
        return json(401, { error: 'invalid signature' });
      }
    } else {
      console.warn('resend-webhook: RESEND_WEBHOOK_SECRET not set — processing UNVERIFIED. Set it in Netlify env to secure this endpoint.');
    }

    let event;
    try { event = JSON.parse(raw); } catch (_) { return json(400, { error: 'invalid JSON' }); }
    const type = event && event.type;
    const data = (event && event.data) || {};

    if (!FAILURE_EVENTS[type]) {
      // Delivered / delayed / opened / etc. — nothing to alert on.
      return json(200, { ok: true, ignored: type || 'unknown' });
    }

    const emailId = data.email_id || data.id || (data.email && data.email.id) || '';
    if (!emailId) return json(200, { ok: true, note: 'no email_id on event' });

    const rec = await getBorrowerSend(emailId);
    if (!rec) return json(200, { ok: true, note: 'not a tracked borrower send' });
    if (rec.loNotifiedAt) return json(200, { ok: true, note: 'LO already notified' });
    // Resolve the LO email: prefer the one logged at send time, else derive it
    // from the ownerKey (sites that only pass ownerKey).
    if (!rec.loEmail && rec.ownerKey) {
      try { rec.loEmail = await resolveOwnerEmail({ ownerKey: rec.ownerKey }); } catch (_) {}
    }
    if (!rec.loEmail) return json(200, { ok: true, note: 'no LO email on record' });

    const sent = await notifyLoOfFailure(rec, data);
    if (sent) await markBorrowerSendNotified(emailId);
    return json(200, { ok: true, notified: sent ? rec.loEmail : null });
  } catch (e) {
    console.error('resend-webhook error:', e);
    // 200 so Resend doesn't spin on retries for our own bug — it's logged.
    return json(200, { ok: false, error: (e && e.message) || 'error' });
  }
};

// ── Svix signature verification (Resend's webhook signer) ──────────────
// signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with
// the base64 secret (after the `whsec_` prefix), base64-encoded. The
// svix-signature header may carry several space-separated `v1,<sig>` values.
function verifySvixSignature(headers, payload, secret) {
  try {
    const id = headers.get('svix-id');
    const ts = headers.get('svix-timestamp');
    const sigHeader = headers.get('svix-signature');
    if (!id || !ts || !sigHeader) return false;
    const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const signed = id + '.' + ts + '.' + payload;
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    const expBuf = Buffer.from(expected);
    return sigHeader.split(' ').some((part) => {
      const comma = part.indexOf(',');
      const sig = comma >= 0 ? part.slice(comma + 1) : part;
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    });
  } catch (e) {
    console.warn('verifySvixSignature threw:', e && e.message);
    return false;
  }
}

// Human phrase for the failed email, by its `kind`. The eSign envelope resolves
// from its document kinds; everything else maps its kind directly.
const KIND_LABELS = {
  long_app_link:      'loan application',
  prequal:            'prequalification',
  portal_invite:      'borrower portal invitation',
  cosigner_invite:    'co-signer invitation',
  cosigner_resend:    'co-signer signing link',
  cosigner_info:      'co-signer information request',
  lo_message:         'message',
  signed_app_copy:    'signed loan application copy',
  apply_confirmation: 'application confirmation',
  payoff:             'payoff request',
  quote:              'quote',
};

function docLabel(rec) {
  if (rec.kind === 'envelope') {
    const kinds = Array.isArray(rec.docKinds) ? rec.docKinds : [];
    const hasRate = kinds.some((k) => String(k) === 'rate_sheet');
    const hasApp = kinds.some((k) => String(k) !== 'rate_sheet');
    if (hasRate && hasApp) return 'loan application and rate sheet';
    if (hasRate) return 'rate sheet';
    if (hasApp) return 'loan application';
  }
  return KIND_LABELS[rec.kind] || rec.docNames || 'email';
}

async function notifyLoOfFailure(rec, data) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('resend-webhook: RESEND_API_KEY not set — cannot notify LO'); return false; }

  const label = docLabel(rec);
  const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bounce = (data && data.bounce) || {};
  const reason = bounce.message || bounce.subType || bounce.type || 'The email could not be delivered.';
  const borrowerLine = rec.signerName ? (rec.signerName + ' <' + rec.to + '>') : rec.to;

  const subject = '⚠ Delivery failed: ' + rec.to + ' did not receive the ' + label;

  const text = [
    'Heads up — an email to your borrower could not be delivered.',
    '',
    'Document(s): ' + (rec.docNames || label),
    'Borrower: ' + borrowerLine,
    rec.address ? ('Property: ' + rec.address) : '',
    'Reason: ' + reason,
    '',
    'This usually means the borrower’s email address is wrong or their inbox rejected it. Please confirm the address and re-send the ' + label + ' from the loan.',
    '',
    'SLA Capital',
  ].filter(function (l) { return l !== ''; }).join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Email Delivery Failed</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        '<p style="font-size:14px;line-height:1.6">Heads up — the <strong>' + escH(label) + '</strong> you sent could not be delivered to your borrower.</p>' +
        '<table style="font-size:13px;line-height:1.7;margin:14px 0">' +
          '<tr><td style="color:#7A7488;padding-right:12px">Document(s)</td><td>' + escH(rec.docNames || label) + '</td></tr>' +
          '<tr><td style="color:#7A7488;padding-right:12px">Borrower</td><td><strong>' + escH(borrowerLine) + '</strong></td></tr>' +
          (rec.address ? ('<tr><td style="color:#7A7488;padding-right:12px">Property</td><td>' + escH(rec.address) + '</td></tr>') : '') +
          '<tr><td style="color:#7A7488;padding-right:12px">Reason</td><td>' + escH(reason) + '</td></tr>' +
        '</table>' +
        '<p style="font-size:13px;color:#7A7488;line-height:1.55">This usually means the address is wrong or the inbox rejected it. Confirm the borrower’s email address and re-send the ' + escH(label) + ' from the loan.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'SLA Capital <noreply@leads.slacapital.com>',
        to: [rec.loEmail],
        subject, text, html,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.warn('resend-webhook: LO notify Resend ' + resp.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('resend-webhook: LO notify fetch threw:', e && e.message);
    return false;
  }
}
