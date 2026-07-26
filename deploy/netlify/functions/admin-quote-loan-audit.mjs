/**
 * admin-quote-loan-audit.mjs — GET /api/admin-quote-loan-audit
 * Phase D reconnaissance (Deploy 236.420). READ-ONLY.
 *
 * Maps the entire quotes store against Postgres loans and reports the
 * landscape the D1 migration has to handle:
 *
 *   matchedByLoanId    — quote.loanId points at a real PG loan
 *   matchedByAddress   — no/stale loanId but a same-owner loan shares
 *                        the (aggressively normalized) address
 *   orphans            — no loan anywhere (sizer saves without a
 *                        borrower email, abandoned drafts)
 *   divergences        — matched quotes whose snapshot disagrees with
 *                        the loan/client: borrowerName, status, loanAmt
 *                        (the "Olejnik tile" class)
 *
 * Response: counts + up to 15 samples per bucket. Admin only.
 */
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs';
import { db } from './_shared/supabase-db.mjs';

const SAMPLES = 15;

function aggrNorm(s) {
  let x = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  x = x.replace(/,\s*(usa|us|united states)\.?$/i, '');
  x = x.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
       .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
       .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
       .replace(/\bcourt\b/g, 'ct').replace(/\bcircle\b/g, 'cir')
       .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
       .replace(/\btrail\b/g, 'trl').replace(/\bterrace\b/g, 'ter');
  return x.replace(/[.,]/g, '').trim();
}

async function _allLoansPG() {
  const PAGE = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await db.select('loans', {
      select: 'id,client_id,owner_email,address,status,loan_amt,clients!client_id(first_name,last_name)',
      limit: PAGE, offset,
    });
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  return out;
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    // Quotes via the materialized index (fast). Index carries the v2
    // projection incl. loanId, address, status, loanAmt, borrowerName,
    // close/decision fields.
    const { index, exists } = await quotesIndex.readIndex();
    if (!exists || !index || !index.byOwner) {
      return json(500, { error: 'quotes-index missing — run /api/admin-store-indexes-rebuild first' });
    }

    const loans = await _allLoansPG();
    const loanById = new Map();
    const loansByOwnerAddr = new Map(); // ownerEmail -> Map(normAddr -> loan)
    for (const l of loans) {
      loanById.set(l.id, l);
      const ow = normalizeEmail(l.owner_email || '');
      if (!loansByOwnerAddr.has(ow)) loansByOwnerAddr.set(ow, new Map());
      const na = aggrNorm(l.address);
      if (na) loansByOwnerAddr.get(ow).set(na, l);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      totals: { quotes: 0, loansPG: loans.length },
      matchedByLoanId: 0,
      matchedByAddress: 0,
      orphans: 0,
      divergences: { borrowerName: 0, status: 0, loanAmt: 0 },
      samples: { matchedByAddress: [], orphans: [], nameDivergence: [], statusDivergence: [], amountDivergence: [] },
      byOwnerOrphans: {},
    };

    for (const owner of Object.keys(index.byOwner)) {
      const ow = normalizeEmail(owner);
      for (const q of (index.byOwner[owner] || [])) {
        if (!q) continue;
        report.totals.quotes++;
        let loan = q.loanId ? loanById.get(q.loanId) : null;
        let how = loan ? 'loanId' : null;
        if (!loan) {
          const na = aggrNorm(q.address);
          const ownerMap = loansByOwnerAddr.get(ow);
          if (na && ownerMap && ownerMap.has(na)) { loan = ownerMap.get(na); how = 'address'; }
        }
        if (!loan) {
          report.orphans++;
          report.byOwnerOrphans[ow] = (report.byOwnerOrphans[ow] || 0) + 1;
          if (report.samples.orphans.length < SAMPLES) {
            report.samples.orphans.push({ owner: ow, quoteId: q.id, address: q.address || '', status: q.status || '', updatedAt: q.updatedAt || '' });
          }
          continue;
        }
        if (how === 'loanId') report.matchedByLoanId++;
        else {
          report.matchedByAddress++;
          if (report.samples.matchedByAddress.length < SAMPLES) {
            report.samples.matchedByAddress.push({ owner: ow, quoteId: q.id, staleLoanId: q.loanId || null, loanId: loan.id, address: q.address || '' });
          }
        }
        // Divergences — the snapshot-staleness the migration must resolve
        // (loan/client side wins; quotes are the denormalized copy).
        const clientName = loan.clients
          ? ((loan.clients.first_name || '') + ' ' + (loan.clients.last_name || '')).trim()
          : '';
        const qName = String(q.borrowerName || '').trim();
        if (qName && clientName && qName.toLowerCase() !== clientName.toLowerCase()) {
          report.divergences.borrowerName++;
          if (report.samples.nameDivergence.length < SAMPLES) {
            report.samples.nameDivergence.push({ owner: ow, quoteId: q.id, loanId: loan.id, quoteName: qName, clientName, address: q.address || '' });
          }
        }
        const qStatus = String(q.status || '');
        if (qStatus && loan.status && qStatus !== loan.status) {
          report.divergences.status++;
          if (report.samples.statusDivergence.length < SAMPLES) {
            report.samples.statusDivergence.push({ owner: ow, quoteId: q.id, loanId: loan.id, quoteStatus: qStatus, loanStatus: loan.status, address: q.address || '' });
          }
        }
        const qAmt = parseFloat(q.loanAmt);
        const lAmt = parseFloat(loan.loan_amt);
        if (isFinite(qAmt) && isFinite(lAmt) && Math.abs(qAmt - lAmt) > 0.5) {
          report.divergences.loanAmt++;
          if (report.samples.amountDivergence.length < SAMPLES) {
            report.samples.amountDivergence.push({ owner: ow, quoteId: q.id, loanId: loan.id, quoteAmt: qAmt, loanAmt: lAmt, address: q.address || '' });
          }
        }
      }
    }

    return json(200, report);
  } catch (e) {
    console.error('admin-quote-loan-audit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
