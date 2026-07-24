/**
 * quotes-list.mjs — GET /api/quotes
 *
 * Deploy 236.423 (Phase D2) — QUOTES ARE NOW SERVED FROM LOANS.
 * Same endpoint, same response shapes ({ quotes } / { byOwner }),
 * same per-record fields as the v2 quotes-index projection — but the
 * rows are synthesized from Postgres loans (the single source of
 * truth since D1 folded every quote onto its loan). Consequences:
 *
 *   - Borrower name/status/amount come from the LOAN + CLIENT —
 *     always current. The "Olejnik tile" class (stale quote
 *     snapshots disagreeing with the profile) is structurally dead.
 *   - A loan can no longer be "missing from Leads because its quote
 *     record was lost" — if the loan exists, it appears.
 *   - Record ids stay stable: loan._quoteId (the folded original
 *     quote id) when present, else a synthetic 'q_ln_<loanId>'. All
 *     204 folded deals keep their original ids, so quotes-close /
 *     quotes-decide / row actions resolve exactly as before.
 *
 * Orphan drafts (quotes with no loan — sizer saves that never became
 * clients) still merge in from the quotes store so nothing vanishes
 * before Mike triages them: any stored quote whose loanId is empty
 * or unknown among the synthesized rows is appended as-is.
 *
 * Which loans count as "quotes": sized deals only — form_data
 * non-empty or a folded _quoteId. Baseline-imported loans that were
 * never sized stay off these boards (parity with the quote era).
 */
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.266
import { quotesIndex } from './_shared/quotes-index.mjs'; // orphan-draft merge
import { db } from './_shared/supabase-db.mjs';

const LOAN_SELECT = 'id,client_id,owner_email,address,status,tool_type,loan_amt,' +
  'created_at,updated_at,saved_at,form_data,extra,clients!client_id(first_name,last_name,email)';

async function _loansPG(selfEmail) {
  const PAGE = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const opts = { select: LOAN_SELECT, limit: PAGE, offset };
    if (selfEmail) opts.eq = { owner_email: selfEmail };
    const rows = await db.select('loans', opts);
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  return out;
}

// Synthesize the v2 quotes-index projection shape from a loan row.
// Returns null for never-sized loans (parity: they had no quote).
function loanToQuoteShape(l) {
  const fd = (l.form_data && typeof l.form_data === 'object') ? l.form_data : {};
  const ex = (l.extra && typeof l.extra === 'object') ? l.extra : {};
  const sized = Object.keys(fd).length > 0 || !!ex._quoteId;
  if (!sized) return null;
  const c = l.clients || {};
  const borrower = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  return {
    id:         ex._quoteId || ('q_ln_' + l.id),
    loanId:     l.id,
    clientId:   l.client_id || '',
    address:    l.address   || '',
    status:     l.status    || '',
    toolType:   l.tool_type || (ex.toolType || ''),
    loanAmt:    l.loan_amt != null ? l.loan_amt : '',
    borrower:   borrower,
    borrowerEmail: c.email || '',
    savedAt:    l.saved_at || l.created_at,
    updatedAt:  l.updated_at,
    borrowerInfoCompletedAt: ex.borrowerInfoCompletedAt || '',
    finalLoanAmount:  ex.finalLoanAmount  ?? null,
    originalLoanAmt:  ex.originalLoanAmt  || '',
    commissionRate:   ex.commissionRate   ?? null,
    commissionAmount: ex.commissionAmount ?? null,
    closedAt:         ex.closedAt         || '',
    closedBy:         ex.closedBy         || '',
    closeNotes:       ex.closeNotes       || '',
    decidedAt:        ex.decidedAt        || '',
    decidedBy:        ex.decidedBy        || '',
    decisionNotes:    ex.decisionNotes    || '',
    submittedAt:      ex.submittedAt      || '',
    formData: {
      propType:      fd.propType,
      _finalRate:    fd._finalRate,
      _points:       fd._points,
      loanAmt:       fd.loanAmt,
      purchasePrice: fd.purchasePrice,
      brokerName:    fd.brokerName,
      brokerCompany: fd.brokerCompany,
      brokerEmail:   fd.brokerEmail,
      _isBrokerLoan: fd._isBrokerLoan,
    },
    _fromLoan: true, // D2 marker (debugging; pages ignore it)
  };
}

function _sortRows(rows) {
  rows.sort((a, b) =>
    new Date(b.updatedAt || b.savedAt || 0) - new Date(a.updatedAt || a.savedAt || 0));
  return rows;
}

// Orphan drafts from the quotes index: any stored quote whose loanId
// is empty or not among the synthesized loan rows. (Folded quotes all
// carry a valid loanId since D1 healed linkage, so they dedupe away.)
async function _orphanDrafts(knownLoanIds) {
  try {
    const { index, exists } = await quotesIndex.readIndex();
    if (!exists || !index || !index.byOwner) return {};
    const out = {};
    for (const owner of Object.keys(index.byOwner)) {
      for (const q of (index.byOwner[owner] || [])) {
        if (!q) continue;
        if (q.loanId && knownLoanIds.has(q.loanId)) continue; // loan-backed → synthesized
        (out[owner] = out[owner] || []).push(q);
      }
    }
    return out;
  } catch (e) {
    console.warn('quotes-list: orphan-draft merge failed (non-fatal):', e && e.message);
    return {};
  }
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1' && canListAllClients(user).ok;
  const selfEmail = normalizeEmail(user.email);

  try {
    const loans = await _loansPG(wantAll ? null : selfEmail);
    const knownLoanIds = new Set(loans.map((l) => l.id));
    const orphansByOwner = await _orphanDrafts(knownLoanIds);

    if (wantAll) {
      const byOwner = {};
      for (const l of loans) {
        const row = loanToQuoteShape(l);
        if (!row) continue;
        const ow = normalizeEmail(l.owner_email || '');
        (byOwner[ow] = byOwner[ow] || []).push(row);
      }
      for (const ow of Object.keys(orphansByOwner)) {
        const owNorm = normalizeEmail(ow);
        (byOwner[owNorm] = byOwner[owNorm] || []).push(...orphansByOwner[ow]);
      }
      Object.keys(byOwner).forEach((o) => _sortRows(byOwner[o]));
      return json(200, { byOwner, _source: 'loans' });
    }

    const rows = [];
    for (const l of loans) {
      const row = loanToQuoteShape(l);
      if (row) rows.push(row);
    }
    const selfKey = keySafe(selfEmail);
    for (const ow of Object.keys(orphansByOwner)) {
      if (normalizeEmail(ow) === selfEmail || ow === selfKey) rows.push(...orphansByOwner[ow]);
    }
    return json(200, { quotes: _sortRows(rows), _source: 'loans' });
  } catch (e) {
    console.error('quotes-list error:', e);
    return json(500, { error: 'Failed to load quotes' });
  }
};
