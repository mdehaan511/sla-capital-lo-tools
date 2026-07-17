/**
 * _shared/pg-projections.mjs — blob shape → Postgres row shape.
 *
 * Phase 1 of the data migration lifted projections into
 * admin-backfill-loans-pg.mjs. Phase 2 needs the SAME projections
 * from every mutation endpoint's dual-write path, so they moved
 * here to be the single source of truth. If a field appears on
 * a blob record but isn't promoted to a proper column, it lands
 * in the `extra` JSONB.
 *
 * These functions are pure — no side effects, no async, no I/O.
 * All they do is transform one JS object to another.
 */

export function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function boolOrDefault(v, d = false) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return d;
}

export function tsOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function dateOrNull(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Fields with dedicated columns on the `clients` table. Everything
// else on a client blob rides in the `extra` JSONB so nothing is
// silently dropped. Keep this list in sync with the SQL schema.
export const CLIENT_PROMOTED_KEYS = new Set([
  'id','firstName','lastName','email','phone','entityName','displayName',
  'companies','homeAddress','mailingAddress','ssn_enc','ssnLast4','fico',
  'dob','_isBroker','_isBrokerPlaceholder','notes','notesLog',
  'createdAt','updatedAt','createdBy','loans',
]);

export const LOAN_PROMOTED_KEYS = new Set([
  'id','address','status','processingStage','toolType','loanType','loanAmt',
  'loanAmtLocked','rate','points','purchasePrice','propValue','rehabBudget',
  'arv','propType','fico','prepay','dscr','brokerId','_isBrokerLoan',
  'fromApplication','prospectId','fundingDate','maturityDate','servicerName',
  'servicerUrl','slaDisplayId','guarantorClientIds','guarantorOwnership',
  'vestingLLCs','formData','notes','notesLog','createdAt','updatedAt','savedAt',
]);

/** blob client record → Postgres public.clients row */
export function projectClient(rec, ownerEmail) {
  if (!rec || !rec.id) return null;
  const extra = {};
  for (const k of Object.keys(rec)) {
    if (!CLIENT_PROMOTED_KEYS.has(k)) extra[k] = rec[k];
  }
  return {
    id:                    String(rec.id),
    owner_email:           ownerEmail,
    first_name:            rec.firstName  || null,
    last_name:             rec.lastName   || null,
    email:                 rec.email      || null,
    phone:                 rec.phone      || null,
    entity_name:           rec.entityName || null,
    display_name:          rec.displayName || null,
    companies:             Array.isArray(rec.companies) ? rec.companies : [],
    home_address:          rec.homeAddress    || null,
    mailing_address:       rec.mailingAddress || null,
    ssn_enc:               rec.ssn_enc  || null,
    ssn_last4:             rec.ssnLast4 || null,
    fico:                  rec.fico     || null,
    dob:                   rec.dob      || null,
    is_broker:             boolOrDefault(rec._isBroker),
    is_broker_placeholder: boolOrDefault(rec._isBrokerPlaceholder),
    notes:                 rec.notes    || null,
    notes_log:             Array.isArray(rec.notesLog) ? rec.notesLog : [],
    created_at:            tsOrNull(rec.createdAt) || new Date().toISOString(),
    updated_at:            tsOrNull(rec.updatedAt) || new Date().toISOString(),
    created_by:            rec.createdBy || null,
    extra,
  };
}

/** blob loan record → Postgres public.loans row */
export function projectLoan(loan, clientId, ownerEmail) {
  if (!loan || !loan.id) return null;
  const extra = {};
  for (const k of Object.keys(loan)) {
    if (!LOAN_PROMOTED_KEYS.has(k)) extra[k] = loan[k];
  }
  return {
    id:                   String(loan.id),
    client_id:            clientId,
    owner_email:          ownerEmail,
    address:              loan.address           || null,
    status:               loan.status            || null,
    processing_stage:     loan.processingStage   || null,
    tool_type:            loan.toolType          || null,
    loan_type:            loan.loanType          || null,
    loan_amt:             numOrNull(loan.loanAmt),
    loan_amt_locked:      boolOrDefault(loan.loanAmtLocked),
    rate:                 numOrNull(loan.rate),
    points:               loan.points || null,
    purchase_price:       numOrNull(loan.purchasePrice),
    prop_value:           numOrNull(loan.propValue),
    rehab_budget:         numOrNull(loan.rehabBudget),
    arv:                  numOrNull(loan.arv),
    prop_type:            loan.propType || null,
    fico:                 loan.fico     || null,
    prepay:               loan.prepay   || null,
    dscr:                 numOrNull(loan.dscr),
    broker_id:            loan.brokerId || null,
    is_broker_loan:       boolOrDefault(loan._isBrokerLoan),
    from_application:     boolOrDefault(loan.fromApplication),
    prospect_id:          loan.prospectId || null,
    funding_date:         dateOrNull(loan.fundingDate),
    maturity_date:        dateOrNull(loan.maturityDate),
    servicer_name:        loan.servicerName || null,
    servicer_url:         loan.servicerUrl  || null,
    sla_display_id:       loan.slaDisplayId || null,
    guarantor_client_ids: Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [],
    guarantor_ownership:  (loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object')
                            ? loan.guarantorOwnership : {},
    vesting_llcs:         Array.isArray(loan.vestingLLCs) ? loan.vestingLLCs : [],
    form_data:            (loan.formData && typeof loan.formData === 'object') ? loan.formData : {},
    notes:                loan.notes || null,
    notes_log:            Array.isArray(loan.notesLog) ? loan.notesLog : [],
    extra,
    created_at:           tsOrNull(loan.createdAt) || new Date().toISOString(),
    updated_at:           tsOrNull(loan.updatedAt) || new Date().toISOString(),
    saved_at:             tsOrNull(loan.savedAt),
  };
}
