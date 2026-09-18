/**
 * financial-audit-list.mjs — GET /api/financial-audit-list (admin + processor)
 *
 * Deploy 237.135 (Mike) — the Financial Audit ledger: every expected money
 * movement from loan activity (closing wires, points + fees, broker fees, KAF
 * assignments, draws, grouped trade proceeds, payoffs) plus manual entries, in
 * date order, with verification status. Rows are rebuilt on every read from
 * Postgres + the Sitewire draw cache + the audit state (_shared/financial-audit.mjs).
 *
 * Query: from=YYYY-MM-DD (default settings.trackFrom), to=YYYY-MM-DD (optional).
 */
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';
import { pgGet } from './_shared/mail-match.mjs';
import {
  buildLedger, readState, canUseFinancialAudit, loadLedgerLoans, loadDrawCache, ymd,
  ENTITIES, ROLES, FUNDING_TYPES, KIND_LABELS,
} from './_shared/financial-audit.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!canUseFinancialAudit(user)) return json(403, { error: 'Admins and processors only' });

    const url = new URL(req.url);
    const [state, loans, draws] = await Promise.all([readState(), loadLedgerLoans(pgGet), loadDrawCache()]);
    const from = ymd(url.searchParams.get('from')) || state.settings.trackFrom || '';
    const to = ymd(url.searchParams.get('to')) || '';
    const built = buildLedger(loans, draws.byLoanNumber, state);
    const rows = built.rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
    // Deploy 237.141 (Mike) -- the Closings tab: one row per closing, same window.
    const closings = (built.closings || []).filter((c) => (!from || c.closeDate >= from) && (!to || c.closeDate <= to));

    const loanOptions = loans
      .filter((l) => l.fundingDate && (!from || String(l.fundingDate) >= addDays(from, -120)))
      .map((l) => ({ loanId: l.id, label: (l.address || '(no address)') + (l._borrower ? ' — ' + l._borrower : ''), slaId: l.slaDisplayId || '' }));

    return json(200, {
      ok: true, from, to, today: built.today,
      rows, closings,
      earlierUnverified: built.rows.filter((r) => from && r.date < from && r.status !== 'verified' && r.status !== 'changed').length,
      undated: built.undated,
      accounts: state.accounts,
      settings: state.settings,
      drawsFetchedAt: draws.fetchedAt,
      loanOptions,
      labels: { entities: ENTITIES, roles: ROLES, fundingTypes: FUNDING_TYPES, kinds: KIND_LABELS },
    });
  } catch (e) {
    console.error('financial-audit-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function addDays(d, n) {
  const t = Date.parse(d + 'T12:00:00Z');
  return isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : '';
}
