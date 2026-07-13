/**
 * borrower-payoff-request.mjs — POST /api/borrower-payoff-request
 *
 * Borrower requests a payoff from the /my-loans/ portal for a closed
 * loan. We collect the expected payoff date + title/escrow contact
 * (name + email) and email payoffs@slacapital.com with the details.
 *
 * Body: { loanId, address, ownerEmail, payoffDate,
 *         titleContactName, titleContactEmail, titleContactPhone? }
 *
 * Auth: required. Borrower's email always comes from the JWT.
 *
 * Deploy 236.308 — borrower portal Phase 2 (payoff MVP).
 */
import {
  handleOptions, json, requireAuth, normalizeEmail,
} from './_shared/auth.mjs';

const MAX_BODY_BYTES = 8 * 1024;
const PAYOFF_INBOX = 'payoffs@slacapital.com';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const cl = req.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return json(413, { error: 'Payload too large' });
  }

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const borrowerEmail = normalizeEmail(user.email || '');
  if (!borrowerEmail) return json(401, { error: 'No email on auth token' });

  let body = null;
  try { body = await req.json(); } catch (_) {}
  if (!body) return json(400, { error: 'Invalid JSON' });

  const loanId            = String(body.loanId            || '').trim().slice(0, 64);
  const address           = String(body.address           || '').trim().slice(0, 200);
  const ownerEmail        = normalizeEmail(body.ownerEmail || '');
  const payoffDate        = String(body.payoffDate        || '').trim().slice(0, 40);
  const titleContactName  = String(body.titleContactName  || '').trim().slice(0, 120);
  const titleContactEmail = normalizeEmail(body.titleContactEmail || '');
  const titleContactPhone = String(body.titleContactPhone || '').trim().slice(0, 40);

  if (!loanId)           return json(400, { error: 'loanId required' });
  if (!payoffDate)       return json(400, { error: 'Expected payoff date required' });
  if (!titleContactName) return json(400, { error: 'Title/escrow contact name required' });
  if (!titleContactEmail || !titleContactEmail.includes('@'))
                         return json(400, { error: 'Title/escrow contact email required' });

  try {
    await sendPayoffEmail({
      loanId, address, ownerEmail,
      borrowerEmail,
      payoffDate,
      titleContactName, titleContactEmail, titleContactPhone,
    });
  } catch (e) {
    console.error('borrower-payoff-request: send failed:', e && e.message);
    return json(500, { error: 'Failed to send payoff request' });
  }

  console.log(`[borrower-payoff-request] loan=${loanId} borrower=${borrowerEmail} payoffDate=${payoffDate}`);
  return json(200, { ok: true });
};

async function sendPayoffEmail(ctx) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not set');
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtDate = (v) => {
    if (!v) return '';
    const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    return v;
  };

  const subject = `Payoff request${ctx.address ? ` — ${ctx.address}` : ''}`;
  const replyTo = [ctx.borrowerEmail, ctx.titleContactEmail].filter(Boolean);

  const lines = [
    `Borrower requested a payoff via the /my-loans/ portal.`,
    '',
    `Borrower Email:      ${ctx.borrowerEmail}`,
    ...(ctx.address ? [`Property:            ${ctx.address}`] : []),
    `Loan ID:             ${ctx.loanId}`,
    ...(ctx.ownerEmail ? [`Owning LO:           ${ctx.ownerEmail}`] : []),
    '',
    `Expected Payoff Date: ${fmtDate(ctx.payoffDate)}`,
    '',
    `Title / Escrow Contact:`,
    `  Name:  ${ctx.titleContactName}`,
    `  Email: ${ctx.titleContactEmail}`,
    ...(ctx.titleContactPhone ? [`  Phone: ${ctx.titleContactPhone}`] : []),
  ];

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Payoff Request</h1></div>' +
    '<div style="padding:24px">' +
    `<p style="font-size:13px;color:#7a7488;margin:0 0 6px">Submitted from the borrower portal by <strong style="color:#1a1520">${esc(ctx.borrowerEmail)}</strong></p>` +
    `${ctx.address ? `<p style="font-size:14px;color:#1a1520;margin:0 0 18px"><strong>Property:</strong> ${esc(ctx.address)}</p>` : ''}` +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      `<tr><td style="padding:6px 0;color:#666;width:210px">Expected Payoff Date</td><td style="padding:6px 0;color:#1a1520;font-weight:600">${esc(fmtDate(ctx.payoffDate))}</td></tr>` +
      `<tr><td style="padding:6px 0;color:#666">Loan ID</td><td style="padding:6px 0;color:#1a1520">${esc(ctx.loanId)}</td></tr>` +
      `${ctx.ownerEmail ? `<tr><td style="padding:6px 0;color:#666">Owning LO</td><td style="padding:6px 0;color:#1a1520">${esc(ctx.ownerEmail)}</td></tr>` : ''}` +
    '</table>' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:22px">Title / Escrow Contact</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      `<tr><td style="padding:6px 0;color:#666;width:120px">Name</td><td style="padding:6px 0;color:#1a1520">${esc(ctx.titleContactName)}</td></tr>` +
      `<tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0;color:#1a1520">${esc(ctx.titleContactEmail)}</td></tr>` +
      `${ctx.titleContactPhone ? `<tr><td style="padding:6px 0;color:#666">Phone</td><td style="padding:6px 0;color:#1a1520">${esc(ctx.titleContactPhone)}</td></tr>` : ''}` +
    '</table>' +
    '<p style="font-size:12px;color:#666;margin-top:22px">Reply-to includes the borrower and the title/escrow contact so you can loop both in at once.</p>' +
    '</div></div></body></html>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [PAYOFF_INBOX],
      subject,
      text: lines.join('\n'),
      html,
      reply_to: replyTo.length ? replyTo : undefined,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
}
