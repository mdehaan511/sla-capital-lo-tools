/**
 * fci-payoff.mjs — GET/POST /api/fci-payoff
 *
 * Deploy 236.803 (Mike) — payoffs through SLA instead of through FCI's portal
 * and an inbox.
 *
 * Three actions, one endpoint because they share the same loan lookup:
 *
 *   GET  ?loanId=&clientId=&owner=     → live payoff figure + demand history
 *                                        for one loan (Servicing tab).
 *   GET  ?demands=1                    → the portfolio-wide tracker: demands
 *                                        pending OUR approval + every issued,
 *                                        still-outstanding demand.
 *   POST { loanId, clientId, owner, payoffDate, req* }
 *                                      → FILES A REAL DEMAND WITH FCI.
 *
 * The POST is outward-facing: it creates a record on the servicer's system that
 * a borrower and a title company will act on. It is gated to staff who can
 * already edit the loan, requires an explicit payoffDate, and is never called
 * on page load — only from the Order Payoff button.
 *
 * Every path needs the loan's FCI account number (`servicerLoanNumber`), which
 * fci-portfolio-sync stamps. A loan FCI doesn't service has nothing to show, and
 * we say so rather than guessing an account.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe, isAdmin,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import {
  fciConfigured, fciPayoffValue, fciPayoffRequests, fciPendingPayoffDemands,
  fciPayoffDemandStatus, fciInsertPayoff, insertPayoffVerdict, fciConfirmPayoffFiled,
  payoffListHasDate, PAYOFF_REASONS, fciNum,
} from './_shared/fci-api.mjs';
import { recordLoanChanges } from './_shared/loan-change-log.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('fci-payoff error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function loadLoan(ownerParam, clientId, loanId, user) {
  const selfEmail = normalizeEmail(user.email);
  let ownerKey = keySafe(selfEmail);
  if (ownerParam && normalizeEmail(ownerParam) !== selfEmail) {
    if (!canOverrideOwner(user).ok) return { error: json(403, { error: 'Owner override requires admin or processor' }) };
    ownerKey = keySafe(normalizeEmail(ownerParam));
  }
  const store = getStore({ name: 'clients', consistency: 'strong' });
  const client = await store.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
  if (!client || !Array.isArray(client.loans)) return { error: json(404, { error: 'Client not found' }) };
  const loan = client.loans.find((l) => l && l.id === loanId);
  if (!loan) return { error: json(404, { error: 'Loan not found' }) };
  return { store, ownerKey, client, loan, selfEmail };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!fciConfigured()) return json(503, { error: 'FCI_API_TOKEN is not set on this site' });

  // ── Tracker: every open demand across the book ─────────────────────
  if (req.method === 'GET' && new URL(req.url).searchParams.get('demands') === '1') {
    if (!canOverrideOwner(user).ok && !isAdmin(user)) return json(403, { error: 'Processor or admin only' });

    // Both calls independently — a failure in one shouldn't blank the page.
    const [pending, issued] = await Promise.all([
      fciPendingPayoffDemands().catch((e) => ({ _err: (e && e.message) || 'failed' })),
      fciPayoffDemandStatus({ wasPaid: false }).catch((e) => ({ _err: (e && e.message) || 'failed' })),
    ]);

    // Attach our loan identity so the tracker can link straight to Loan Details.
    const linkByAccount = await buildAccountIndex();
    const decorate = (rows) => (Array.isArray(rows) ? rows : []).map((r) => {
      const link = linkByAccount.get(String(r.account || ''));
      return Object.assign({}, r, link ? { sla: link } : {});
    });

    return json(200, {
      ok: true,
      pending: Array.isArray(pending) ? decorate(pending) : [],
      pendingError: pending && pending._err ? pending._err : null,
      issued: Array.isArray(issued) ? decorate(issued) : [],
      issuedError: issued && issued._err ? issued._err : null,
    });
  }

  // ── Per-loan: live figure + demand history ─────────────────────────
  if (req.method === 'GET') {
    const q = new URL(req.url).searchParams;
    const found = await loadLoan(q.get('owner'), q.get('clientId'), q.get('loanId'), user);
    if (found.error) return found.error;

    const acct = String(found.loan.servicerLoanNumber || '').trim();
    if (!acct || String(found.loan.servicerName || '').toUpperCase() !== 'FCI') {
      return json(200, { ok: true, serviced: false, reason: 'This loan is not linked to an FCI account.' });
    }

    const [value, requests] = await Promise.all([
      fciPayoffValue(acct).catch((e) => ({ _err: (e && e.message) || 'failed' })),
      fciPayoffRequests(acct).catch((e) => ({ _err: (e && e.message) || 'failed' })),
    ]);

    // Deploy 237.179 (Mike) -- heal the record while we are here. FCI's list is
    // already in hand, so a demand they have since picked up gets stamped confirmed on
    // the loan the moment anyone opens it, rather than waiting on the 4-hourly cron.
    // Zero-throw and write-only-if-changed: this is a READ endpoint and must stay fast.
    if (requests && !requests._err && Array.isArray(found.loan.payoffRequests)) {
      let healed = 0;
      for (const p of found.loan.payoffRequests) {
        if (!p || p.confirmed === true) continue;
        if (!payoffListHasDate(requests, p.payoffDate)) continue;
        p.confirmed = true;
        p.confirmedAt = new Date().toISOString();
        p.confirmReason = '';
        p.confirmedBy = 'page-load';
        healed++;
      }
      if (healed) {
        try {
          const { writeClient } = await import('./_shared/client-write.mjs');
          found.loan.updatedAt = new Date().toISOString();
          await writeClient(found.ownerKey, found.client, { clientsStore: found.store });
          const { unwatchPayoff } = await import('./_shared/fci-payoff-watch.mjs');
          for (const p of found.loan.payoffRequests) {
            if (p && p.confirmedBy === 'page-load') {
              await unwatchPayoff({ ownerKey: found.ownerKey, clientId: found.client.id, loanId: found.loan.id, payoffDate: p.payoffDate });
            }
          }
        } catch (e) {
          console.warn('fci-payoff: confirm-heal write failed (non-fatal):', e && e.message);
        }
      }
    }
    return json(200, {
      ok: true, serviced: true, account: acct,
      // Deploy 237.144 (Mike: "I dont believe it went through") -- the demands WE
      // filed, so the page can show one the moment it is accepted instead of waiting
      // for FCI's tracker to list it.
      filed: Array.isArray(found.loan.payoffRequests) ? found.loan.payoffRequests.slice(0, 10) : [],
      value: value && value._err ? null : value,
      valueError: value && value._err ? value._err : null,
      requests: requests && requests._err ? null : requests,
      requestsError: requests && requests._err ? requests._err : null,
    });
  }

  // ── Order a demand — the real write ────────────────────────────────
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = (await readJsonBody(req)) || {};
  const found = await loadLoan(body.owner, body.clientId, body.loanId, user);
  if (found.error) return found.error;
  const { store, ownerKey, client, loan, selfEmail } = found;

  const acct = String(loan.servicerLoanNumber || '').trim();
  if (!acct) return json(400, { error: 'This loan has no FCI account number on file — run the FCI sync first.' });

  const payoffDate = String(body.payoffDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payoffDate)) return json(400, { error: 'payoffDate (YYYY-MM-DD) is required' });

  const reason = PAYOFF_REASONS[String(body.reason || 'payoff').toLowerCase()];
  const args = {
    loanNumber: acct,
    payoffDate,
    reason: reason == null ? 0 : reason,
    reqCompany: body.reqCompany || '',
    reqContact: body.reqContact || '',
    reqEmail: body.reqEmail || '',
    reqMailing: body.reqMailing || '',
    reqPhone: body.reqPhone || '',
    description: body.description || '',
    dateReceived: new Date().toISOString().slice(0, 10),
    requestedBy: body.requestedBy || 'Lender',
  };

  let fciResult;
  try {
    fciResult = await fciInsertPayoff(args);
  } catch (e) {
    return json(502, { error: 'FCI rejected the payoff request: ' + ((e && e.message) || 'unknown') });
  }
  // Deploy 237.171 (Mike: "I have yet to see anything on our FCI portal") -- a clean
  // HTTP 200 is NOT a receipt. insertPayoff can answer false / 0 / null without a
  // GraphQL error, and until now nothing looked.
  if (insertPayoffVerdict(fciResult) === 'no') {
    return json(502, {
      error: 'FCI declined the payoff request (it answered without creating one). ' +
             'Nothing was filed \u2014 order it in the FCI portal, or try again.',
      fci: fciResult,
    });
  }
  // Anything else is unproven until FCI's own records show it. This is the check whose
  // absence let 237.144 report a demand that never existed.
  const confirm = await fciConfirmPayoffFiled(acct, payoffDate);

  // Record it on the loan so the Servicing tab shows the request even before
  // FCI's tracker catches up, and so the audit log has the actor.
  const now = new Date().toISOString();
  const entry = {
    at: now, by: selfEmail, account: acct,
    payoffDate, reason: args.reason,
    company: args.reqCompany, contact: args.reqContact,
    email: args.reqEmail, phone: args.reqPhone,
    requestedBy: args.requestedBy,
    source: body.source || 'loan-details',
    // Deploy 237.144 -- insertPayoff's return type is undocumented and introspection
    // is off, so keep FCI's raw answer as the receipt for this filing.
    fciResponse: (function () { try { return JSON.stringify(fciResult).slice(0, 400); } catch (_) { return ''; } })(),
    // Deploy 237.171 -- did FCI's OWN records show it a moment later? The page says
    // "confirmed by FCI" or "not confirmed" off this, and never guesses.
    confirmed: !!confirm.confirmed,
    confirmChecked: !!confirm.checked,
    confirmReason: confirm.reason || '',
  };
  loan.payoffRequests = Array.isArray(loan.payoffRequests) ? loan.payoffRequests : [];
  loan.payoffRequests.unshift(entry);
  // Deploy 237.179 (Mike: "a way to check and confirm when it is picked up by FCI")
  // -- FCI's tracker can lag, so a demand it has not listed YET goes on a short waiting
  // list. fci-payoff-confirm-cron re-checks it every 4 hours, stamps the loan when it
  // lands and tells whoever ordered it. One confirmed on the spot needs no watching.
  if (!confirm.confirmed) {
    const { watchPayoff } = await import('./_shared/fci-payoff-watch.mjs');
    await watchPayoff({
      ownerKey, clientId: client.id, loanId: loan.id, account: acct,
      payoffDate, at: now, by: selfEmail, address: loan.address || '',
    });
  }
  if (loan.payoffRequests.length > 50) loan.payoffRequests.length = 50;
  loan.payoffRequestedAt = now;
  loan.payoffRequestedBy = selfEmail;
  loan.updatedAt = now;

  try {
    const { writeClient } = await import('./_shared/client-write.mjs');
    await writeClient(ownerKey, client, { clientsStore: store });
  } catch (e) {
    // FCI already has the demand; failing the response now would invite a
    // retry and a duplicate demand. Report success with a warning instead.
    console.error('fci-payoff: demand filed but local write failed:', e && e.message);
    return json(200, { ok: true, filed: true, localWriteFailed: true, fci: fciResult,
      confirmed: !!confirm.confirmed, confirmReason: confirm.reason || '' }); // Deploy 237.171
  }

  recordLoanChanges({
    ownerKey, clientId: client.id, loanId: loan.id,
    actor: selfEmail, actorName: selfEmail, source: 'fci-payoff',
    changes: [{ field: 'payoffRequests', label: 'Payoff demand ordered', from: '', to: payoffDate + ' — ' + (args.reqCompany || 'no company') }],
  }).catch(() => {});

  // Deploy 237.171 -- `filed` means we sent it; `confirmed` means FCI's own records
  // show it. The page must say which, because those are not the same thing.
  return json(200, { ok: true, filed: true, account: acct, entry, fci: fciResult,
    confirmed: !!confirm.confirmed, confirmChecked: !!confirm.checked, confirmReason: confirm.reason || '' });
}

/**
 * Map FCI account → our loan identity, so tracker rows link to Loan Details.
 * Reads the PG loans mirror rather than walking every client blob: the tracker
 * is a page load, not a nightly job.
 */
async function buildAccountIndex() {
  const map = new Map();
  try {
    const { db } = await import('./_shared/supabase-db.mjs');
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const rows = await db.select('loans', {
        select: 'id,client_id,owner_email,address,extra',
        limit: PAGE, offset,
      });
      for (const r of rows || []) {
        const ex = (r.extra && typeof r.extra === 'object') ? r.extra : {};
        const acct = String(ex.servicerLoanNumber || '').trim();
        if (acct) map.set(acct, { loanId: r.id, clientId: r.client_id, owner: r.owner_email, address: r.address || '' });
      }
      if (!rows || rows.length < PAGE) break;
    }
  } catch (e) {
    console.warn('fci-payoff: account index unavailable:', e && e.message);
  }
  return map;
}
