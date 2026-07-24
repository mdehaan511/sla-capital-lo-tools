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
// Deploy 226 — log the admin decision on the loan's audit trail.
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';
// Deploy 236.382 — quotes-index write-through (same gap as quotes-close:
// decisions mutated the quote blob but the All-LOs index kept the old
// status until something else re-indexed the quote).
import { quotesIndex } from './_shared/quotes-index.mjs';
// Deploy 236.426 (D4) — loan-first decisions for synthetic q_ln_* ids.
import { db } from './_shared/supabase-db.mjs';

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

  // Deploy 236.426 (D4) — synthetic loan-backed row ids (q_ln_<loanId>).
  // Post-D2 the decisions board renders rows synthesized from LOANS;
  // deals without a legacy quote record decide LOAN-FIRST: the status
  // mapping + decision audit land on the loan, no quote store involved.
  if (String(quoteId).indexOf('q_ln_') === 0) {
    const loanId = String(quoteId).slice(5);
    const row = await db.first('loans', { select: 'id,client_id,owner_email', eq: { id: loanId } }).catch(() => null);
    if (!row) return json(404, { error: 'Loan not found for ' + quoteId });
    const loanOwnerKey = keySafe(normalizeEmail(row.owner_email || ''));
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const cKey = loanOwnerKey + '/' + keySafe(row.client_id);
    const client = await clientsStore.get(cKey, { type: 'json' }).catch(() => null);
    if (!client) return json(404, { error: 'Client record not found for loan ' + loanId });
    const loan = (client.loans || []).find((l) => l && l.id === loanId);
    if (!loan) return json(404, { error: 'Loan ' + loanId + ' not on client record' });

    const persisted = (status === 'approved') ? 'awaiting_app' : status;
    const now2 = new Date().toISOString();
    const prev = loan.status || '';
    loan.status = persisted;
    loan.updatedAt = now2;
    loan.decidedAt = now2;
    loan.decidedBy = user.email || '';
    if (reason != null && String(reason).trim()) loan.decisionNotes = String(reason).trim();
    appendNoteEntry(loan, {
      kind: 'status',
      text: 'Decision: ' + (prev || '—') + ' → ' + persisted + (reason ? ' — ' + String(reason).trim() : ''),
      author: user.email || '', authorEmail: user.email || '',
      meta: { from: prev, to: persisted, via: 'quotes-decide' },
    });
    client.updatedAt = now2;
    // allowDemotion: approve maps submitted → awaiting_app (terminal →
    // non-terminal) by DESIGN — the admin's explicit decision moves the
    // deal into the borrower-application stage. Same justification as
    // loan-advance-status admin moves (C4).
    await writeClient(loanOwnerKey, client, { clientsStore, allowDemotion: true });
    return json(200, {
      ok: true, loansUpdated: 1,
      quote: { id: quoteId, loanId, status: persisted, decidedAt: now2, decisionNotes: loan.decisionNotes || '' },
    });
  }

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
    await quotesIndex.upsertRecord(cleanOwner, quote); // Deploy 236.382
  } catch (e) {
    return json(500, { error: 'Failed to save decision' });
  }

  // Mirror the status into the client record's matching loan (best-effort).
  // Deploy 226 — pass status + reason + actor so syncToClientLoan can
  // append a "decision" entry to the loan's audit log.
  try {
    const adminMeta = (user && user.user_metadata) || {};
    const adminName = adminMeta.full_name || adminMeta.fullName || user.email || '';
    await syncToClientLoan(cleanOwner, quote, persistedStatus, {
      verb:        status,                  // 'approved' | 'denied' | 'on_hold'
      reason:      reason || '',
      adminEmail:  user.email || '',
      adminName,
    });
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

async function syncToClientLoan(ownerKey, quote, status, audit) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(quote.address);
  const targetLoanId = String(quote.loanId || '').trim();
  const targetClientId = String(quote.clientId || '').trim();
  // Deploy 236.13 — require targetLoanId. A quote without a loanId is
  // a legacy / orphan record; address-only propagation would walk into
  // OTHER loans at the same property. The LO can re-stamp loanId on
  // any orphan by opening it in the sizer and clicking Save Quote.
  if (!targetLoanId) {
    console.log('[quotes-decide] quote ' + quote.id + ' has no loanId — skipping loan-side sync (re-save in sizer to fix)');
    return;
  }

  // Deploy 236.12 — before mutating the loan, check whether OTHER quotes
  // still point at it. If yes, leave the loan record alone — the other
  // quote(s) need it intact. This is the same "last-quote-standing"
  // pattern that pipeline.bulkDelete uses on the client side.
  let otherQuotesForLoan = 0;
  if (targetLoanId) {
    try {
      const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
      const { blobs: qBlobs } = await quotesStore.list({ prefix: ownerKey + '/' });
      for (const { key: qk } of qBlobs) {
        const qq = await quotesStore.get(qk, { type: 'json' });
        if (!qq || qq.id === quote.id) continue;
        if (String(qq.loanId || '') === targetLoanId) otherQuotesForLoan += 1;
      }
    } catch (_) { /* best-effort — fall through to mutate if list fails */ }
  }

  const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
  for (const { key } of blobs) {
    const c = await clientsStore.get(key, { type: 'json' });
    if (!c || !c.loans) continue;
    // Deploy 236.12 — when targeting a specific clientId+loanId, skip
    // any client that doesn't match.
    if (targetClientId && c.id !== targetClientId) continue;
    let changed = false;
    for (const l of c.loans) {
      // Deploy 236.13 — STRICT loanId match. Address fallback only
      // fires when this quote ITSELF has no loanId (truly legacy
      // pre-Deploy-236.7 record). If the quote has a loanId, address
      // match is disabled — we don't want to walk into another loan
      // at the same property.
      const matchesLoanId = targetLoanId && l.id === targetLoanId;
      const matchesAddress = !targetLoanId && target && norm(l.address) === target;
      if (matchesLoanId || matchesAddress) {
        if (otherQuotesForLoan > 0) {
          // Other quotes still reference this loan — don't change its
          // status. Just write an audit entry so the LO can see that a
          // quote was decided but the loan record was preserved.
          if (audit) {
            const verbDisplay = audit.verb === 'approved' ? 'Approved' :
                                audit.verb === 'denied'   ? 'Denied' :
                                audit.verb === 'on_hold'  ? 'Placed on hold' :
                                'Decision: ' + audit.verb;
            const tail = audit.reason ? '\n\nAdmin notes: ' + audit.reason : '';
            appendNoteEntry(l, {
              kind:        'decision',
              text:        verbDisplay + ' (one of ' + (otherQuotesForLoan + 1) + ' quotes on this loan — loan status preserved)' + tail,
              author:      audit.adminName || 'Admin',
              authorEmail: audit.adminEmail || '',
              meta:        { decision: audit.verb, reason: audit.reason || '', loanStatusPreserved: true },
            });
            changed = true;
          }
        } else {
          const prevStatus = l.status || '';
          l.status = status;
          l.updatedAt = new Date().toISOString();
          if (audit) {
            const verbDisplay = audit.verb === 'approved'
              ? 'Approved — moved to Awaiting Application'
              : audit.verb === 'denied'
                ? 'Denied'
                : audit.verb === 'on_hold'
                  ? 'Placed on hold'
                  : 'Decision: ' + audit.verb;
            const tail = audit.reason ? '\n\nAdmin notes: ' + audit.reason : '';
            appendNoteEntry(l, {
              kind:        'decision',
              text:        verbDisplay + tail,
              author:      audit.adminName || 'Admin',
              authorEmail: audit.adminEmail || '',
              meta:        { from: prevStatus, to: status, decision: audit.verb, reason: audit.reason || '' },
            });
          }
          changed = true;
        }
      }
    }
    if (changed) {
      // Deploy 236.427 — allowDemotion, same justification as the
      // q_ln_ branch above: approve maps submitted → awaiting_app
      // (terminal → non-terminal) BY DESIGN. Without the flag the C4
      // trigger silently blocked this best-effort sync: the QUOTE
      // record updated but the LOAN (what the boards render since D2)
      // stayed 'submitted' — Mike's "approved it but it reappears in
      // the queue" report, caught on his logoff check.
      await writeClient(ownerKey, c, { clientsStore, allowDemotion: true });
    }
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
