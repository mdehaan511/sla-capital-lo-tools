/**
 * quotes-decide.mjs — POST /api/quotes-decide
 *
 * Admin-only. Updates a submitted quote's status to 'approved', 'denied',
 * or 'on_hold', then emails the LO to notify them of the decision.
 * Also mirrors the status into the client record's matching loan.
 *
 * Body: { ownerKey, quoteId, status, reason? }
 *   - ownerKey: storage prefix the quote lives under (typically the LO's email)
 *   - quoteId:  the quote's id
 *   - status:   'approved' | 'denied' | 'on_hold'
 *   - reason:   optional free-text note from the admin (shown in email + saved on quote)
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

const ALLOWED = new Set(['approved', 'denied', 'on_hold']);

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const { ownerKey, quoteId, status, reason } = body || {};
  if (!ownerKey || !quoteId) return json(400, { error: 'ownerKey and quoteId required' });
  if (!ALLOWED.has(status)) return json(400, { error: 'Invalid status' });

  const cleanOwner = keySafe(String(ownerKey).toLowerCase());
  // LOs can decide their OWN quotes (lets them clear duplicates / mark
  // dropped leads as Declined themselves). Admins can decide anyone's.
  // Without this gate, exposing the multi-select bulk-decline button to
  // non-admins would just produce 403s.
  const userKey = keySafe(normalizeEmail(user.email || ''));
  if (!isAdmin(user) && cleanOwner !== userKey) {
    return json(403, { error: 'Cannot decide another LO\'s quote' });
  }
  const cleanId    = keySafe(String(quoteId));
  const key = `${cleanOwner}/${cleanId}`;

  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  let quote;
  try {
    quote = await quotesStore.get(key, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load quote' });
  }
  if (!quote) return json(404, { error: 'Quote not found' });

  // The admin clicks "Approve" but the persisted status is `awaiting_app`
  // (loan moves to the "Awaiting Application" pipeline column). When the
  // borrower completes the loan-application form, borrower-info-save bumps
  // it to `approved` (which the UI displays as "In Processing").
  //
  // Denied and on_hold pass through unchanged.
  const persistedStatus = (status === 'approved') ? 'awaiting_app' : status;

  quote.status = persistedStatus;
  quote.updatedAt = new Date().toISOString();
  quote.decidedAt = quote.updatedAt;
  quote.decidedBy = user.email || '';
  if (reason && String(reason).trim()) {
    quote.decisionNotes = String(reason).trim();
  }

  try {
    await quotesStore.setJSON(key, quote);
  } catch (e) {
    return json(500, { error: 'Failed to save decision' });
  }

  // Mirror the status into the client record's matching loan (best-effort)
  try {
    await syncToClientLoan(cleanOwner, quote, persistedStatus);
  } catch (e) {
    console.warn('quotes-decide: client sync failed:', e);
  }

  // Email the LO. Best-effort.
  let emailed = false;
  try {
    emailed = await notifyLO(quote, status, reason || '', user.email || '');
  } catch (e) {
    console.warn('quotes-decide: email failed:', e);
  }

  return json(200, { ok: true, status, emailed });
};

// ── Helpers ──────────────────────────────────────────────────

async function syncToClientLoan(ownerKey, quote, status) {
  if (!quote.address) return;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(quote.address);

  const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
  for (const { key } of blobs) {
    const c = await clientsStore.get(key, { type: 'json' });
    if (!c || !c.loans) continue;
    let changed = false;
    for (const l of c.loans) {
      if (norm(l.address) === target) {
        l.status = status;
        l.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await clientsStore.setJSON(key, c);
  }
}

async function notifyLO(quote, status, reason, decidedBy) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping admin-decision LO notification');
    return false;
  }

  // Find the LO email — quote.createdBy is set when the quote was saved.
  let toEmail = quote.createdBy || '';
  if (!toEmail) {
    console.warn('No LO email on quote — cannot notify');
    return false;
  }

  const fmtMoney = (v) => v ? '$' + Number(String(v).replace(/[^0-9.]/g, '')).toLocaleString() : '—';
  const fd = quote.formData || {};
  const borrower = quote.borrower || fd.borrower || '';
  const address = quote.address || fd.address || '';
  const loanAmt = fmtMoney(fd.loanAmt || fd.purchasePrice || quote.loanAmt);
  const rate    = fd._finalRate ? fd._finalRate + '%' : '—';
  const points  = fd._points || fd.buydown || '—';

  const verb = status === 'approved' ? 'APPROVED' : status === 'denied' ? 'DENIED' : 'ON HOLD';
  const verbColor = status === 'approved' ? '#256940' : status === 'denied' ? '#7c1f1f' : '#7a5218';
  const subject = `Loan ${verb}: ${address || borrower || 'Submission'}`;

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text = [
    `Your submitted loan has been ${verb.toLowerCase()}.`,
    '',
    `Borrower:  ${borrower || '—'}`,
    `Address:   ${address || '—'}`,
    `Amount:    ${loanAmt}`,
    `Rate:      ${rate}`,
    `Points:    ${points}`,
    '',
    `Decided by: ${decidedBy}`,
    reason ? `Notes: ${reason}` : '',
    '',
    'View this loan in your Saved Quotes page.',
  ].filter(Boolean).join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Decision</h1>' +
    `<p style="color:rgba(255,255,255,.55);font-size:12px;margin:4px 0 0">${esc(new Date().toLocaleString('en-US'))}</p></div>` +
    `<div style="padding:24px"><div style="display:inline-block;padding:6px 14px;border-radius:24px;background:${verbColor};color:#fff;font-size:12px;font-weight:700;letter-spacing:.06em;margin-bottom:18px">${verb}</div>` +
    `<h2 style="font-size:15px;margin:0 0 12px">${esc(borrower || address || 'Submission')}</h2>` +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    row('Borrower', esc(borrower)) +
    row('Address', esc(address)) +
    row('Loan Amount', loanAmt) +
    row('Rate', rate) +
    row('Points', points) +
    row('Decided By', esc(decidedBy)) +
    (reason ? row('Notes', esc(reason)) : '') +
    '</table>' +
    '<p style="margin-top:20px;font-size:12px;color:#666">View in your Saved Quotes page for full details.</p>' +
    '</div></div></body></html>';

  const payload = JSON.stringify({
    from: 'SLA Capital <noreply@leads.slacapital.com>',
    to: [toEmail],
    subject,
    text,
    html,
  });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: payload,
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return true;
}

function row(label, value) {
  return `<tr><td style="padding:6px 0;color:#666;width:140px">${label}</td><td style="padding:6px 0;color:#1a1520;font-weight:600">${value || '—'}</td></tr>`;
}
