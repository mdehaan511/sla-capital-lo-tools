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
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
// Deploy 236.803 — file the demand with FCI instead of only emailing the inbox.
import { hasLoanGrant, listAccessibleLoans } from './_shared/loan-access-store.mjs';
import { fciInsertPayoff } from './_shared/fci-api.mjs';

const MAX_BODY_BYTES = 8 * 1024;
const PAYOFF_INBOX = 'payoffs@slacapital.com';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const cl = req.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return json(413, { error: 'Payload too large' });
  }

  const user = await requireAuth(context, req);
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

  // ── Deploy 236.803 — file the demand with FCI, not just an inbox ─────
  //
  // Until now this endpoint's whole job was emailing payoffs@slacapital.com,
  // where someone re-keyed it into FCI by hand. Now it files the real demand
  // when we can identify the loan's FCI account.
  //
  // The access check is NEW and load-bearing. Emailing an unverified loanId was
  // harmless; FILING A DEMAND AT THE SERVICER is not, so we confirm this
  // borrower actually holds a grant on this loan before touching FCI. A borrower
  // without a grant still gets the email path (no regression, no servicer write).
  let fciFiled = false, fciAccount = '', fciError = '';
  try {
    if (await hasLoanGrant(borrowerEmail, loanId)) {
      const found = await findLoanForGrant(borrowerEmail, loanId);
      const acct = found && String(found.loan.servicerLoanNumber || '').trim();
      if (acct && /^\d{4}-\d{2}-\d{2}$/.test(payoffDate)) {
        fciAccount = acct;
        await fciInsertPayoff({
          loanNumber: acct,
          payoffDate,
          reason: 0,                    // 0 = Payoff
          reqCompany: titleContactName, // portal collects a person, not a company
          reqContact: titleContactName,
          reqEmail: titleContactEmail,
          reqMailing: address,
          reqPhone: titleContactPhone,
          description: 'Requested by borrower via the SLA borrower portal',
          requestedBy: 'Borrower',
        });
        fciFiled = true;
        await stampPayoffRequest(found, {
          borrowerEmail, payoffDate, titleContactName, titleContactEmail, titleContactPhone, account: acct,
        });
      }
    }
  } catch (e) {
    // Never block the email on FCI. A failed filing that still reaches
    // payoffs@ is the old behavior; a silent drop is not.
    fciError = (e && e.message) || 'failed';
    console.error('borrower-payoff-request: FCI filing failed:', fciError);
  }

  try {
    await sendPayoffEmail({
      loanId, address, ownerEmail,
      borrowerEmail,
      payoffDate,
      titleContactName, titleContactEmail, titleContactPhone,
      fciFiled, fciAccount, fciError,
    });
  } catch (e) {
    console.error('borrower-payoff-request: send failed:', e && e.message);
    // If FCI already has the demand, the request DID go through — don't tell the
    // borrower it failed and invite a duplicate.
    if (fciFiled) return json(200, { ok: true, filedWithServicer: true, emailFailed: true });
    return json(500, { error: 'Failed to send payoff request' });
  }

  console.log(`[borrower-payoff-request] loan=${loanId} borrower=${borrowerEmail} payoffDate=${payoffDate} fciFiled=${fciFiled}${fciError ? ' fciError=' + fciError : ''}`);
  return json(200, { ok: true, filedWithServicer: fciFiled });
};

/** Resolve the borrower's grant → the client record + loan, for the FCI account. */
async function findLoanForGrant(email, loanId) {
  const grants = await listAccessibleLoans(email);
  const g = grants.find((x) => x && x.loanId === loanId);
  if (!g || !g.ownerKey || !g.primaryClientId) return null;
  const store = getStore({ name: 'clients', consistency: 'strong' });
  const client = await store.get(g.ownerKey + '/' + keySafe(g.primaryClientId), { type: 'json' }).catch(() => null);
  if (!client || !Array.isArray(client.loans)) return null;
  const loan = client.loans.find((l) => l && l.id === loanId);
  if (!loan) return null;
  return { store, ownerKey: g.ownerKey, client, loan };
}

/** Mirror the request onto the loan so staff see it on the Servicing tab. */
async function stampPayoffRequest(found, info) {
  try {
    const now = new Date().toISOString();
    found.loan.payoffRequests = Array.isArray(found.loan.payoffRequests) ? found.loan.payoffRequests : [];
    found.loan.payoffRequests.unshift({
      at: now, by: info.borrowerEmail, account: info.account,
      payoffDate: info.payoffDate, reason: 0,
      company: info.titleContactName, contact: info.titleContactName,
      email: info.titleContactEmail, phone: info.titleContactPhone,
      requestedBy: 'Borrower', source: 'borrower-portal',
    });
    if (found.loan.payoffRequests.length > 50) found.loan.payoffRequests.length = 50;
    found.loan.payoffRequestedAt = now;
    found.loan.payoffRequestedBy = info.borrowerEmail;
    found.loan.updatedAt = now;
    const { writeClient } = await import('./_shared/client-write.mjs');
    await writeClient(found.ownerKey, found.client, { clientsStore: found.store });
  } catch (e) {
    console.error('borrower-payoff-request: loan stamp failed:', e && e.message);
  }
}

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
    '',
    // Deploy 236.803 — tell the reader whether this still needs hand-keying.
    ctx.fciFiled
      ? `ALREADY FILED WITH FCI — demand submitted on account ${ctx.fciAccount}. No re-keying needed.`
      : (ctx.fciError
        ? `NOT filed with FCI (${ctx.fciError}) — file this demand manually.`
        : `Not filed with FCI (loan is not linked to an FCI account) — handle as usual.`),
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
    (ctx.fciFiled
      ? `<p style="margin-top:22px;padding:10px 12px;background:#eef7ee;border-left:3px solid #2f7d32;font-size:13px;color:#1a1520"><strong>Already filed with FCI</strong> — demand submitted on account ${esc(ctx.fciAccount)}. No re-keying needed.</p>`
      : (ctx.fciError
        ? `<p style="margin-top:22px;padding:10px 12px;background:#fdf0ee;border-left:3px solid #b3261e;font-size:13px;color:#1a1520"><strong>NOT filed with FCI</strong> (${esc(ctx.fciError)}) — this demand still needs to be filed manually.</p>`
        : '<p style="margin-top:22px;padding:10px 12px;background:#faf6ee;border-left:3px solid #C8813A;font-size:13px;color:#1a1520">Not filed with FCI — this loan is not linked to an FCI account. Handle as usual.</p>')) +
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
