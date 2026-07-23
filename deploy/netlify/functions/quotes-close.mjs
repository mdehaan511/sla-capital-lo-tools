/**
 * quotes-close.mjs — POST /api/quotes-close
 *
 * Admin-only. Marks a quote 'closed' with finalized financials.
 *
 * Body: {
 *   ownerKey:         storage prefix the quote lives under (LO email)
 *   quoteId:          the quote id
 *   finalLoanAmount:  number — admin can override the original loanAmt
 *   commissionRate:   number — basis points (e.g. 50 = 0.50%)
 *   notes?:           optional admin note
 * }
 *
 * The function computes commissionAmount = finalLoanAmount × commissionRate / 10000.
 * Mirrors the close into the matching loan in the client record so the
 * Loan Details page reflects it.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';
// Deploy 236.382 — quotes-index write-through. This endpoint mutated
// the quote blob but never touched the materialized quotes-index, so
// closed.html / pipeline.html in admin All-LOs scope (which read the
// index since 236.343) showed the PRE-close copy — blank financials,
// stale status — until something else happened to re-index the quote.
import { quotesIndex } from './_shared/quotes-index.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const { ownerKey, quoteId, finalLoanAmount, commissionRate, notes } = body || {};
  if (!ownerKey || !quoteId) return json(400, { error: 'ownerKey and quoteId required' });

  const finalAmt = Number(finalLoanAmount);
  const rateBps  = Number(commissionRate);
  if (!isFinite(finalAmt) || finalAmt <= 0) return json(400, { error: 'finalLoanAmount must be a positive number' });
  if (!isFinite(rateBps)  || rateBps  < 0)  return json(400, { error: 'commissionRate must be a non-negative number (basis points)' });

  const cleanOwner = keySafe(String(ownerKey).toLowerCase());
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

  const commissionAmount = Math.round(finalAmt * rateBps) / 10000;
  const now = new Date().toISOString();

  // Was this the first time the loan is being closed, or an edit
  // of an already-closed loan? We only email on the first close.
  const isFirstClose = !quote.closedAt;

  if (!quote.originalLoanAmt) {
    quote.originalLoanAmt = quote.loanAmt || (quote.formData && quote.formData.loanAmt) || '';
  }

  quote.status            = 'closed';
  quote.finalLoanAmount   = finalAmt;
  quote.commissionRate    = rateBps;
  quote.commissionAmount  = commissionAmount;
  quote.closedAt          = quote.closedAt || now;
  quote.closedBy          = quote.closedBy || (user.email || '');
  quote.lastEditedAt      = now;
  quote.lastEditedBy      = user.email || '';
  quote.updatedAt         = now;
  if (notes != null && String(notes).trim()) {
    quote.closeNotes = String(notes).trim();
  }

  try {
    await quotesStore.setJSON(key, quote);
    await quotesIndex.upsertRecord(cleanOwner, quote); // Deploy 236.382
  } catch (e) {
    return json(500, { error: 'Failed to save closed loan' });
  }

  // Mirror status into client record's matching loan. Deploy 236.377 —
  // the sync result now surfaces in the response so the frontend can
  // warn when the quote closed but NO loan record was found to flip
  // (previously a silent partial success — the card left the board but
  // Loan Details still showed the old status, and nobody knew why).
  let loanSync = { loansUpdated: 0, matchedBy: null };
  try {
    loanSync = await syncToClientLoan(cleanOwner, quote);
  } catch (e) {
    console.warn('quotes-close: client sync failed:', e);
    loanSync = { loansUpdated: 0, matchedBy: null, error: (e && e.message) || 'unknown' };
  }

  // Email the LO on the first close. Best-effort; never fail the close.
  let emailed = false;
  if (isFirstClose) {
    try {
      emailed = await notifyLO(quote, user.email || '');
    } catch (e) {
      console.warn('quotes-close: email failed:', e);
    }
  }

  return json(200, {
    ok: true, quote, emailed, firstClose: isFirstClose,
    loansUpdated: loanSync.loansUpdated,
    loanMatchedBy: loanSync.matchedBy,
    loanSyncError: loanSync.error || null,
  });
};

async function syncToClientLoan(ownerKey, quote) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  // Deploy 236.377 — aggressive address normalization (same helper the
  // loan-cancel / loan-decline quote sweeps use). Baseline-imported
  // loans routinely differ from the quote's address by ", USA" suffix
  // or St/Street spelling, which the simple normalizer treats as a
  // mismatch.
  const aggrNorm = (s) => {
    let x = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    x = x.replace(/,\s*(usa|us|united states)\.?$/i, '');
    x = x.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
         .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
         .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
         .replace(/\bcourt\b/g, 'ct').replace(/\bcircle\b/g, 'cir')
         .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
         .replace(/\btrail\b/g, 'trl').replace(/\bterrace\b/g, 'ter');
    x = x.replace(/[.,]/g, '');
    return x.trim();
  };
  const target = norm(quote.address);
  const targetAggr = aggrNorm(quote.address);
  const targetLoanId = String(quote.loanId || '').trim();

  // Deploy 236.371 (hotfix): STRICT loanId match when the quote has one.
  // This function previously matched on ADDRESS ALONE, so closing a single
  // quote stamped status='closed' onto EVERY loan at that address across
  // EVERY client in the owner's namespace. 'closed' is filtered out of the
  // pipeline entirely (pipeline.html bucket map), so unrelated loans
  // silently vanished from the board — the two-loans-at-one-property and
  // two-borrowers-same-address cases were the blast radius.
  //
  // Deploy 236.377 — STALE-loanId fallback (mirrors 236.21/236.41 in
  // loan-cancel / loan-advance-status, reverse direction). Baseline-
  // imported loans and older re-keyed records often carry a quote whose
  // loanId points at a loan that no longer exists anywhere in the
  // owner's namespace. The strict match then finds nothing and the
  // close never reaches the loan record — the exact "marked closed in
  // the pipeline but Loan Details still shows the old status" bug.
  // When the quote's loanId doesn't exist on ANY client, fall back to
  // aggressive-normalized address matching, but cap it at the FIRST
  // matching loan (no multi-loan blast radius).
  if (!targetLoanId && !target) return { loansUpdated: 0, matchedBy: null };

  const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
  // First pass: read everything + build the set of valid loan ids.
  const records = [];
  const validLoanIds = new Set();
  for (const { key } of blobs) {
    const c = await clientsStore.get(key, { type: 'json' });
    if (!c || !c.loans) continue;
    records.push({ key, c });
    for (const l of c.loans) if (l && l.id) validLoanIds.add(l.id);
  }
  const loanIdIsStale = targetLoanId && !validLoanIds.has(targetLoanId);
  // Address fallback fires when the quote has NO loanId (legacy) OR
  // its loanId is provably stale.
  const useAddressFallback = (!targetLoanId || loanIdIsStale) && !!targetAggr;

  let loansUpdated = 0;
  let matchedBy = null;
  for (const { key, c } of records) {
    let changed = false;
    for (const l of c.loans) {
      const matchesLoanId  = targetLoanId && l.id === targetLoanId;
      const matchesAddress = useAddressFallback && loansUpdated === 0 && !changed
        && aggrNorm(l.address) === targetAggr;
      if (matchesLoanId || matchesAddress) {
        l.status            = 'closed';
        l.finalLoanAmount   = quote.finalLoanAmount;
        l.commissionRate    = quote.commissionRate;
        l.commissionAmount  = quote.commissionAmount;
        l.closedAt          = quote.closedAt;
        l.closedBy          = quote.closedBy;
        l.updatedAt         = new Date().toISOString();
        changed = true;
        loansUpdated++;
        matchedBy = matchesLoanId ? 'loanId' : 'address';
      }
    }
    if (changed) {
      // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
      await writeClient(ownerKey, c, { clientsStore });
    }
  }
  if (loansUpdated === 0) {
    console.warn('[quotes-close] quote ' + quote.id + ' closed but NO loan record matched'
      + ' (loanId=' + (targetLoanId || 'none') + (loanIdIsStale ? ' STALE' : '') + ', addr="' + (quote.address || '') + '")');
  }
  return { loansUpdated, matchedBy };
}

// ── LO notification email ──────────────────────────────────────
async function notifyLO(quote, closedByEmail) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping close-loan LO notification');
    return false;
  }

  // The LO who owns the quote — saved by quotes-save as createdBy.
  const toEmail = quote.createdBy || '';
  if (!toEmail) {
    console.warn('quotes-close: no LO email on quote — cannot notify');
    return false;
  }

  const fmtMoney = (v) => {
    const n = Number(v);
    if (!isFinite(n) || n === 0) return '$0';
    // Deploy 236.279 — preserve cents when present. Commission
    // amounts like $528.75 no longer round to $529 in the LO
    // notification email; whole-dollar values still display
    // without a trailing .00.
    const hasCents = Math.abs(n - Math.round(n)) > 0.005;
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: 2,
    });
  };
  const fd = quote.formData || {};
  const borrower = quote.borrower || fd.borrower || '';
  const address  = quote.address  || fd.address  || '';
  const finalAmt = fmtMoney(quote.finalLoanAmount);
  const rateBps  = Number(quote.commissionRate) || 0;
  const commission = fmtMoney(quote.commissionAmount);

  const subject = `Loan CLOSED: ${address || borrower || 'Submission'} — ${commission} commission`;
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text = [
    `Your loan has closed.`,
    '',
    `Borrower:        ${borrower || '—'}`,
    `Address:         ${address || '—'}`,
    `Final amount:    ${finalAmt}`,
    `Commission rate: ${rateBps} bps`,
    `Commission:      ${commission}`,
    '',
    `Closed by: ${closedByEmail || quote.closedBy || ''}`,
    quote.closeNotes ? `Notes: ${quote.closeNotes}` : '',
    '',
    'View your full closed loans on the Closed page.',
  ].filter(Boolean).join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Closed</h1>' +
    `<p style="color:rgba(255,255,255,.55);font-size:12px;margin:4px 0 0">${esc(new Date().toLocaleString('en-US'))}</p></div>` +
    '<div style="padding:24px">' +
      '<div style="display:inline-block;padding:6px 14px;border-radius:24px;background:#256940;color:#fff;font-size:12px;font-weight:700;letter-spacing:.06em;margin-bottom:18px">CLOSED</div>' +
      `<h2 style="font-size:15px;margin:0 0 12px">${esc(borrower || address || 'Loan')}</h2>` +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        row('Borrower', esc(borrower)) +
        row('Address', esc(address)) +
        row('Final Loan Amount', finalAmt) +
        row('Commission Rate', rateBps + ' bps') +
        row('Commission Earned', `<span style="color:#256940;font-weight:700">${commission}</span>`) +
        row('Closed By', esc(closedByEmail || quote.closedBy || '')) +
        (quote.closeNotes ? row('Notes', esc(quote.closeNotes)) : '') +
      '</table>' +
      '<p style="margin-top:20px;font-size:12px;color:#666">Track your earnings on the Closed Loans page.</p>' +
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
  return `<tr><td style="padding:6px 0;color:#666;width:160px">${label}</td><td style="padding:6px 0;color:#1a1520;font-weight:600">${value || '—'}</td></tr>`;
}
