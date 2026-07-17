/**
 * loan-get-pg.mjs — GET /api/loan-get-pg?loanId=<id>
 *
 * Phase 1 of the data migration. Reads a single loan (and its parent
 * client) directly from Postgres by loan id. NO ownerKey or clientId
 * needed in the URL — the whole reason we're migrating.
 *
 * Response shape is designed to be a drop-in for client-get.mjs's
 * output so loan-details.js can wire it up with one line changed:
 *   { client: <client row projected to old blob shape>,
 *     loan:   <loan row projected to old blob shape>,
 *     ownerKey: <email> }
 *
 * Auth: any authenticated staff user (LO gets their own scope,
 * admin/processor get any loan). Row-level security IS relaxed for
 * the service-role key we use to query, so scope enforcement is in
 * this handler.
 */
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { db } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-get-pg error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

// Project a Postgres row back to the shape the frontend expects
// (matching what client-get.mjs's blob response looks like). Keeps
// the callsite change on loan-details.html trivial.
function _clientRowToBlobShape(c) {
  if (!c) return null;
  return {
    id:                    c.id,
    firstName:             c.first_name  || '',
    lastName:              c.last_name   || '',
    email:                 c.email       || '',
    phone:                 c.phone       || '',
    entityName:            c.entity_name || '',
    displayName:           c.display_name || '',
    companies:             c.companies || [],
    homeAddress:           c.home_address || null,
    mailingAddress:        c.mailing_address || null,
    hasSSN:                !!c.ssn_enc,
    ssnLast4:              c.ssn_last4 || '',
    fico:                  c.fico || '',
    dob:                   c.dob || '',
    _isBroker:             !!c.is_broker,
    _isBrokerPlaceholder:  !!c.is_broker_placeholder,
    notes:                 c.notes || '',
    notesLog:              c.notes_log || [],
    createdAt:             c.created_at,
    updatedAt:             c.updated_at,
    createdBy:             c.created_by || '',
    // extra JSONB gets merged onto the top level so anything we
    // haven't promoted to a column but the frontend expects
    // (e.g. rarely-used fields) still round-trips.
    ...(c.extra || {}),
  };
}

function _loanRowToBlobShape(l) {
  if (!l) return null;
  return {
    id:                   l.id,
    address:              l.address           || '',
    status:               l.status            || 'active',
    processingStage:      l.processing_stage  || '',
    toolType:             l.tool_type         || '',
    loanType:             l.loan_type         || '',
    loanAmt:              l.loan_amt          || '',
    loanAmtLocked:        !!l.loan_amt_locked,
    rate:                 l.rate              || '',
    points:               l.points            || '',
    purchasePrice:        l.purchase_price    || '',
    propValue:            l.prop_value        || '',
    rehabBudget:          l.rehab_budget      || '',
    arv:                  l.arv               || '',
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
    guarantorOwnership:   l.guarantor_ownership || {},
    vestingLLCs:          l.vesting_llcs || [],
    formData:             l.form_data || {},
    notes:                l.notes || '',
    notesLog:             l.notes_log || [],
    createdAt:            l.created_at,
    updatedAt:            l.updated_at,
    savedAt:              l.saved_at || l.updated_at,
    ...(l.extra || {}),
  };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId = String(url.searchParams.get('loanId') || '').trim();
  if (!loanId) return json(400, { error: 'loanId required' });

  const selfEmail = normalizeEmail(user.email);
  const isStaff   = canOverrideOwner(user).ok;

  const loanRow = await db.first('loans', { eq: { id: loanId } }).catch((e) => {
    console.warn('loan-get-pg: loans lookup failed:', e && e.message);
    return null;
  });
  if (!loanRow) return json(404, { error: 'Loan not found' });

  // Owner-scope enforcement. Admins/processors see any loan;
  // regular LOs only see their own.
  if (!isStaff) {
    if (normalizeEmail(loanRow.owner_email) !== selfEmail) {
      return json(404, { error: 'Loan not found' }); // 404 not 403 — don't leak existence
    }
  }

  const clientRow = await db.first('clients', { eq: { id: loanRow.client_id } }).catch(() => null);
  if (!clientRow) {
    // FK is set to on delete restrict so this shouldn't happen, but
    // during the dual-write window a race could theoretically show
    // a loan without a client. Report explicitly.
    return json(500, { error: 'Loan has no parent client (data integrity issue)' });
  }

  return json(200, {
    client:   _clientRowToBlobShape(clientRow),
    loan:     _loanRowToBlobShape(loanRow),
    ownerKey: keySafe(loanRow.owner_email),
    // Phase 1 marker so frontend can log source in diagnostics.
    _source: 'postgres',
  });
}
