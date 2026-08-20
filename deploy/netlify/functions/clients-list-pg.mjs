/**
 * clients-list-pg.mjs — GET /api/clients-list-pg
 *
 * Phase 4 of the data migration. Postgres-backed drop-in for
 * /api/clients — returns the same response shape so pipeline.html,
 * clients.html, and loans.html can consume it with minimal callsite
 * changes.
 *
 * Query params (all optional):
 *   all=1           — admin/processor: return every LO's clients
 *   nonEmptyOnly=1  — only clients that have at least one loan
 *   summary=1       — DEFAULT (compatibility with clients-list.mjs's
 *                     Deploy 236.346 flip). Full=1 returns the loans'
 *                     `form_data` + `notes_log` JSONB alongside. The
 *                     summary shape is what Pipeline / Clients / Loans
 *                     want; full is only for admin forensics.
 *
 * Response shapes (matching /api/clients exactly):
 *   Normal LO:           { clients: [...] }
 *   Admin ?all=1:        { byOwner: { 'alice@x.com': [...], ... } }
 *
 * Each client has a `loans` array of loan summary objects (same
 * projection as clients-list.mjs's LOAN_SUMMARY_FIELDS).
 *
 * SSN is sanitized: hasSSN boolean, no ssn_enc.
 *
 * Auth: any authenticated user. LO scope enforced by owner_email
 * filter. Admin ?all=1 bypasses that filter.
 */
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs';
import { db } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('clients-list-pg error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

// Reshape a Postgres client row + its embedded loans into the
// blob-compat shape the frontend expects. Same field mapping as
// loan-get-pg.mjs, adapted for the list case + summary vs full.
function _clientRowToApi(row, opts) {
  if (!row) return null;
  const summary = opts && opts.summary;
  const rawLoans = Array.isArray(row.loans) ? row.loans : [];
  const loans = rawLoans.map((l) => _loanRowToApi(l, summary));
  const out = {
    id:                    row.id,
    firstName:             row.first_name  || '',
    lastName:              row.last_name   || '',
    email:                 row.email       || '',
    phone:                 row.phone       || '',
    entityName:            row.entity_name || '',
    displayName:           row.display_name || '',
    companies:             row.companies || [],
    hasSSN:                !!row.ssn_enc,
    ssnLast4:              row.ssn_last4 || '',
    _isBroker:             !!row.is_broker,
    _isBrokerPlaceholder:  !!row.is_broker_placeholder,
    createdAt:             row.created_at,
    updatedAt:             row.updated_at,
    createdBy:             row.created_by || '',
    loans,
  };
  if (!summary) {
    // Full mode adds the bulky fields Pipeline etc. don't need.
    out.homeAddress    = row.home_address || null;
    out.mailingAddress = row.mailing_address || null;
    out.fico           = row.fico || '';
    out.dob            = row.dob || '';
    out.notes          = row.notes || '';
    out.notesLog       = row.notes_log || [];
    // Extra JSONB round-trips anything we haven't promoted.
    Object.assign(out, row.extra || {});
    // Deploy 236.461 — re-derive SSN read-fields AFTER the extra merge so a
    // stale `hasSSN` that leaked into extra (from a read-shape record saved
    // back to the blob) can't clobber the authoritative ssn_enc column.
    out.hasSSN   = !!row.ssn_enc;
    out.ssnLast4 = row.ssn_last4 || '';
  } else {
    // Deploy 236.404 (C3): summary parity with clients-list.mjs's
    // projectSummary — these legacy fields live in the extra JSONB
    // (never promoted to columns) but list consumers still read them.
    const ex = row.extra || {};
    if (ex.name !== undefined)          out.name          = ex.name;
    if (ex._importedAt !== undefined)   out._importedAt   = ex._importedAt;
    if (ex._importSource !== undefined) out._importSource = ex._importSource;
  }
  return out;
}

// Loan summary fields that live in the extra JSONB (unpromoted) but
// are part of clients-list.mjs's LOAN_SUMMARY_FIELDS contract —
// Pipeline/Loans render broker attribution from these.
const LOAN_SUMMARY_EXTRA_KEYS = [
  'brokerName', 'brokerCompany', 'brokerEmail', 'brokerPhone', 'brokerFee',
  // Deploy 236.573 — Processing Pipeline card needs these (all ride in extra):
  // the assignee picker (assignedProcessor), the funding/investor tile items,
  // and the open-conditions badge (236.564, which never showed because the
  // count was dropped from the summary projection).
  'assignedProcessor', 'fundingSource', 'fundingSourceOther', 'investorName',
  'openConditions', 'totalConditions',
  // Deploy 236.616 — servicing-tracking fields (Closed Loans page); all ride in
  // extra. Without these the PG summary dropped disposition + the servicing
  // scalars, so edits reverted on the next list fetch.
  'disposition', 'servicerLoanNumber', 'paymentAmount', 'upb',
  'payoffAmount', 'payoffDate', 'soldRate', 'soldDate',
  // Deploy 236.622/623 — collateral tracking fields (date + location + tracking #, all in extra).
  'signedOriginalsDate', 'signedOriginalsLocation', 'signedOriginalsTracking',
  'recordedDotDate', 'recordedDotLocation', 'recordedDotTracking',
  'titlePolicyDate', 'titlePolicyLocation', 'titlePolicyTracking',
];

function _loanRowToApi(l, summary) {
  if (!l) return null;
  const out = {
    id:                   l.id,
    address:              l.address           || '',
    status:               l.status            || 'active',
    processingStage:      l.processing_stage  || '',
    loanAmt:              l.loan_amt          || '',
    loanType:             l.loan_type         || '',
    toolType:             l.tool_type         || '',
    rate:                 l.rate              || '',
    points:               l.points            || '',
    purchasePrice:        l.purchase_price    || '',
    propValue:            l.prop_value        || '',
    propType:             l.prop_type         || '',
    fico:                 l.fico              || '',
    prepay:               l.prepay            || '',
    dscr:                 l.dscr              || '',
    brokerId:             l.broker_id         || '',
    _isBrokerLoan:        !!l.is_broker_loan,
    fromApplication:      !!l.from_application,
    prospectId:           l.prospect_id       || '',
    fundingDate:          l.funding_date      || '',
    maturityDate:         l.maturity_date     || '',
    servicerName:         l.servicer_name     || '',
    servicerUrl:          l.servicer_url      || '',
    slaDisplayId:         l.sla_display_id    || '',
    guarantorClientIds:   l.guarantor_client_ids || [],
    createdAt:            l.created_at,
    updatedAt:            l.updated_at,
    savedAt:              l.saved_at,
    _owner:               l.owner_email,
  };
  if (!summary) {
    out.loanAmtLocked      = !!l.loan_amt_locked;
    out.rehabBudget        = l.rehab_budget || '';
    out.arv                = l.arv || '';
    out.guarantorOwnership = l.guarantor_ownership || {};
    out.vestingLLCs        = l.vesting_llcs || [];
    out.formData           = l.form_data || {};
    out.notes              = l.notes || '';
    out.notesLog           = l.notes_log || [];
    Object.assign(out, l.extra || {});
  } else {
    // Pipeline still peeks at formData._finalRate + formData.propType
    // (loan-summary-clients-list uses these). Cheap to include a
    // trimmed formData; keep the rest for the full path.
    if (l.form_data && typeof l.form_data === 'object') {
      out.formData = {
        _finalRate: l.form_data._finalRate,
        propType:   l.form_data.propType,
      };
    }
    // Deploy 236.404 (C3): broker attribution fields ride in extra —
    // part of the summary contract (see LOAN_SUMMARY_EXTRA_KEYS).
    const ex = l.extra || {};
    for (const k of LOAN_SUMMARY_EXTRA_KEYS) {
      if (ex[k] !== undefined) out[k] = ex[k];
    }
  }
  return out;
}

// Deploy 236.404 (C3): exported so clients-list.mjs (/api/clients) can
// serve PG-first through this exact handler and fall back to its
// legacy index/walk path when this returns a 5xx.
export async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const wantSummary = url.searchParams.get('full') !== '1';
  const nonEmpty = url.searchParams.get('nonEmptyOnly') === '1';

  const selfEmail = normalizeEmail(user.email);

  // Filter shape:
  //   Admin ?all=1: no owner filter (cross-owner)
  //   LO: owner_email = self
  //   nonEmpty: PostgREST embedded-resource inner join drops clients
  //     with zero loans. `!inner` on the `loans` relation does that.
  //
  // FK disambiguation: `loans` has TWO foreign keys to `clients` —
  // `loans.client_id` (parent) AND `loans.broker_id` (broker). We
  // must name the hint explicitly so PostgREST picks the parent
  // relation, otherwise it errors with "more than one relationship
  // was found for clients and loans". `loans!client_id(*)` uses the
  // source column as the hint (PostgREST spec §embedded-disambiguation).
  const inner = nonEmpty ? '!inner' : '';
  const embed = 'loans!client_id' + inner + '(*)';
  const select = '*,' + embed;
  const opts = { select, limit: 5000 };
  if (!wantAll) {
    opts.eq = { owner_email: selfEmail };
  } else if (!canListAllClients(user).ok) {
    // Non-staff asking for all: silently downgrade to self-scope.
    opts.eq = { owner_email: selfEmail };
  }
  opts.order = { updated_at: 'desc' };

  let rows;
  try {
    rows = await db.select('clients', opts);
  } catch (e) {
    console.error('clients-list-pg select failed:', e && e.message);
    return json(500, { error: 'DB read failed: ' + (e && e.message) });
  }

  const projected = (rows || []).map((r) => _clientRowToApi(r, { summary: wantSummary }));

  if (wantAll && (opts.eq == null)) {
    // Admin cross-owner: bucket by owner_email.
    const byOwner = {};
    for (let i = 0; i < projected.length; i++) {
      const c = projected[i];
      const owner = (rows[i] && rows[i].owner_email) || '';
      if (!owner) continue;
      (byOwner[owner] = byOwner[owner] || []).push(c);
    }
    return json(200, { byOwner, _source: 'postgres' });
  }
  return json(200, { clients: projected, _source: 'postgres' });
}
