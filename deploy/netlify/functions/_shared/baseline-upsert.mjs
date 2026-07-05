/**
 * baseline-upsert.mjs — Deploy 236.177 (Baseline Migration Stage 1)
 *
 * Shared upsert helper. Takes a Baseline detail record + upserts it
 * into the SLA `clients` store as a client+loan pair under the
 * pseudo-owner `baseline-migration@sla-import.local`.
 *
 * Same code path serves BOTH:
 *   - One-shot migration endpoint (baseline-migrate.mjs)
 *   - Scheduled ongoing sync (Stage 3)
 *
 * Idempotency: keyed by Baseline external Id
 * (SLA-YYYYMMDD-NNNN). Re-running the migration on an already-
 * imported loan updates the Baseline-authored fields in place;
 * SLA-authored fields (processingStage, processor notes, doc-
 * review data, guarantors added via SLA, tasks, etc.) are never
 * touched. Cutover happens by flipping a flag later that turns
 * off the "Baseline-authored" overwrite path.
 *
 * Storage keys:
 *   clients/<IMPORT_OWNER_KEY>/c_baseline_<externalId>
 * The client record carries a single loan (l_baseline_<externalId>)
 * so admin views + Processing Pipeline pick them up like any
 * other SLA loan.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

// Pseudo-owner all imported loans land under. Admins can reassign
// in bulk via the existing users-reassign flow when the processing
// team is added to SLA.
export const IMPORT_OWNER_EMAIL = 'baseline-migration@sla-import.local';
export const IMPORT_OWNER_KEY   = keySafe(normalizeEmail(IMPORT_OWNER_EMAIL));

// Baseline-authored fields on a loan record. These get overwritten
// on every sync (Baseline stays authoritative until cutover). Any
// field NOT listed here is SLA-authored and preserved verbatim.
const BASELINE_AUTHORED_FIELDS = [
  'address', 'loanAmt', 'loanType', 'loanTypeLabel', 'status',
  'rate', 'points', 'fundingDate', 'propValue',
  'baselineStatus', 'baselineSubstatus', 'baselineOwnerName',
  'baselineArchivedAt', '_baselineRaw', '_baselineMirroredAt',
  'slaDisplayId', 'updatedAt',
];

/**
 * Upsert a single Baseline loan into the clients store.
 *
 * @param {object} baselineRecord Full Baseline detail JSON
 * @param {object} opts
 * @param {boolean} [opts.dryRun] Skip the actual write
 * @returns {Promise<{
 *   action: 'created' | 'updated' | 'no_change' | 'skipped',
 *   reason?: string,
 *   externalId: string,
 *   clientId: string,
 *   loanId: string,
 *   status: string,
 *   processingStage: string,
 *   changes?: Array<{ field: string, from: any, to: any }>,
 * }>}
 */
export async function upsertBaselineLoan(baselineRecord, opts) {
  opts = opts || {};
  const externalId = baselineRecord && baselineRecord.Id ? String(baselineRecord.Id).trim() : '';
  if (!externalId) {
    return { action: 'skipped', reason: 'no external id', externalId: '', clientId: '', loanId: '', status: '', processingStage: '' };
  }

  const safeExt  = _keySafeExt(externalId);
  const clientId = 'c_baseline_' + safeExt;
  const loanId   = 'l_baseline_' + safeExt;
  const clientsKey = IMPORT_OWNER_KEY + '/' + clientId;
  const now = new Date().toISOString();

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const existing = await store.get(clientsKey, { type: 'json' }).catch(() => null);

  // Map Baseline → SLA fields.
  const status         = _statusForSla(baselineRecord);
  const processingStage = _processingStageForSla(baselineRecord, status);
  const loanFields = _mapBaselineToLoanFields(baselineRecord, now);
  loanFields.id             = loanId;
  loanFields.slaDisplayId   = externalId;
  loanFields.status         = status;
  loanFields.processingStage = processingStage;

  // Client-level info (Baseline doesn't have a well-defined client;
  // we synthesize one per loan).
  const clientFields = _mapBaselineToClientFields(baselineRecord, externalId, now);
  clientFields.id = clientId;

  let action = 'created';
  let changes = [];
  let mergedLoan;
  let mergedClient;

  if (existing) {
    // Merge: SLA-authored fields on the existing loan stay; Baseline-
    // authored fields get the fresh values. Everything else on the
    // client record stays (LO could have added a phone number, etc.).
    const priorLoan = (existing.loans || []).find((l) => l && l.id === loanId) || null;
    mergedLoan = priorLoan
      ? _mergeLoanPreservingSla(priorLoan, loanFields)
      : loanFields;
    changes = _fieldChanges(priorLoan || {}, mergedLoan, BASELINE_AUTHORED_FIELDS);

    mergedClient = Object.assign({}, existing, {
      // Refresh only the fields Baseline is authoritative over on the
      // client record. Contact fields (phone, email, name) — leave
      // alone unless we CREATED the client from Baseline data (no
      // prior SLA contribution).
      updatedAt: now,
      _baselineImport: true,
      _baselineImportedAt: existing._baselineImportedAt || now,
    });
    // Replace the loans[] entry (or add if missing).
    const loans = Array.isArray(existing.loans) ? existing.loans.slice() : [];
    const idx = loans.findIndex((l) => l && l.id === loanId);
    if (idx >= 0) loans[idx] = mergedLoan;
    else          loans.push(mergedLoan);
    mergedClient.loans = loans;

    if (!changes.length) action = 'no_change';
    else                 action = 'updated';
  } else {
    // Fresh client + loan.
    mergedClient = Object.assign({}, clientFields, {
      createdAt: now,
      updatedAt: now,
      _baselineImport: true,
      _baselineImportedAt: now,
      loans: [loanFields],
    });
    mergedLoan = loanFields;
    changes = Object.keys(loanFields).map((k) => ({ field: k, from: null, to: loanFields[k] }));
  }

  if (!opts.dryRun && action !== 'no_change') {
    await store.setJSON(clientsKey, mergedClient);
  }

  return {
    action,
    externalId,
    clientId,
    loanId,
    status,
    processingStage,
    changes: opts.includeChanges ? changes : undefined,
  };
}

// ─── Field mappers ──────────────────────────────────────────

function _mapBaselineToLoanFields(b, now) {
  // Baseline field names use PascalCase (Loan_Amount, Rate, etc.).
  // We map to SLA's camelCase and preserve the raw payload under
  // _baselineRaw so downstream UI can pull any field later without
  // schema changes.
  return {
    address:            _str(b.Name || b.Address_Full || b.Address_Line_1 || ''),
    loanAmt:            _num(b.Loan_Amount),
    loanType:           _inferLoanType(b),
    loanTypeLabel:      _inferLoanType(b) === 'rtl' ? 'RTL' : _inferLoanType(b) === 'dscr' ? 'DSCR' : (b.Substatus || ''),
    rate:               b.Rate === undefined || b.Rate === null ? '' : String(b.Rate),
    points:             b.Origination_Points === undefined ? '' : String(b.Origination_Points),
    fundingDate:        _str(b.Origination || b.Estimated_Close_Date || ''),
    propValue:          _num(b.As_Is_Value || b.After_Repair_Value || 0),
    baselineStatus:     _str(b.Status),
    baselineSubstatus:  _str(b.Substatus),
    baselineOwnerName:  _accountOwnersLabel(b),
    _baselineRaw:       b,
    _baselineMirroredAt: b._mirroredAt || now,
    updatedAt:          now,
  };
}

function _mapBaselineToClientFields(b, externalId, now) {
  // Synthesize a lightweight client. Prefer Guarantor_1 fields;
  // fall back to the Baseline loan Name (property address).
  const first = _str(b.Guarantor_1_First_Name);
  const last  = _str(b.Guarantor_1_Last_Name);
  const email = _str(b.Guarantor_1_Email);
  const phone = _str(b.Guarantor_1_Phone);
  const entityName = _str(b.Entity_Name || b.Borrower_Entity_Name);
  const displayName = (first || last)
    ? (first + ' ' + last).trim()
    : (entityName || ('Baseline Import ' + externalId));
  return {
    firstName:   first,
    lastName:    last,
    email:       email,
    phone:       phone,
    entityName:  entityName,
    displayName: displayName,
    createdBy:   IMPORT_OWNER_EMAIL,
    _baselineId: externalId,
  };
}

// ─── Status mapping ────────────────────────────────────────

// Deploy 236.179 — normalize input by lowercasing + collapsing
// spaces / underscores so Baseline's "In Servicing", "in_servicing",
// "In  Servicing" all match the same bucket. Previously only the
// snake_case form was recognized; loans with the display form
// ("In Servicing") fell through to the "approved" catch-all and
// landed in the Processing Pipeline.
function _norm(s) {
  return String(s || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

// Baseline Status → SLA loan status.
function _statusForSla(b) {
  const s   = _norm(b && b.Status);
  const sub = _norm(b && b.Substatus);
  const combined = (s + ' ' + sub).trim();

  // Denied / lost tier — record-keeping.
  const deniedSet = ['archived', 'lost', 'declined', 'denied', 'withdrawn', 'cancelled'];
  if (deniedSet.includes(s)) return 'denied';
  if (b && (b.Archived === true || b.Is_Archived === true)) return 'denied';

  // Closed tier: fully-done loans that should NOT appear in the
  // Processing Pipeline. Includes Sold / In Servicing / Liquidated
  // / Funded per Mike. loans.html gets Sold + In Servicing filter
  // chips so admins can find them.
  const closedSet = ['closed', 'sold', 'funded', 'in servicing', 'servicing', 'liquidated'];
  if (closedSet.includes(s))    return 'closed';
  if (closedSet.includes(sub))  return 'closed';
  // Combined-string fallback for values like "in-servicing" or
  // multi-token substatuses.
  if (/\b(sold|in servicing|liquidated|funded)\b/.test(combined)) return 'closed';

  // Hold.
  if (s.includes('hold') || sub.includes('hold')) return 'on_hold';

  // Lead → the LO's main pipeline (Quoted column).
  if (s === 'lead' || sub === 'lead') return 'active';

  // Everything else in the loan lifecycle → SLA 'approved' so it
  // shows in the Processing Pipeline. The column within the
  // pipeline is decided by _processingStageForSla below.
  return 'approved';
}

// Deploy 236.180 — explicit Baseline-substatus → SLA processing
// column table, per Mike's mapping. Checked against normalized
// Substatus (and Status, for safety) BEFORE the keyword fallback.
// Anything not in this table falls through to the 236.179 regex
// chain, then to 'new_loan' as the ultimate default. Adding a
// new Baseline substatus later is a one-line edit here.
const STAGE_LOOKUP = {
  // New Loan
  'dscr':                                    'new_loan',
  'rtl':                                     'new_loan',
  // Processing
  'kick off email sent':                     'processing',
  'appraisal paid':                          'processing',
  'inspection scheduled':                    'processing',
  'appraisal complete':                      'processing',
  // Underwriting
  'file review/underwriting':                'underwriting',
  'file review underwriting':                'underwriting', // slash-stripped variant
  'file submitted to investor':              'underwriting',
  'conditions request':                      'underwriting',
  'conditions cleared':                      'underwriting',
  // Approved (pp_approved)
  'final due diligence':                     'pp_approved',
  'loan document prep':                      'pp_approved',
  'loan docs sent':                          'pp_approved',
  'clear to close':                          'pp_approved',
  'funds wired':                             'pp_approved',
  // Closed (pp_closed — last column IN the Processing Pipeline,
  // not the SLA 'closed' status which is fully off-pipeline)
  'post close review':                       'pp_closed',
  'final doc verification':                  'pp_closed',
  'submitted to investor awaiting approval': 'pp_closed',
  'ready to board to servicer':              'pp_closed',
  'boarded to servicer/awaiting close out':  'pp_closed',
  'boarded to servicer awaiting close out':  'pp_closed', // slash-stripped variant
};

// Deploy 236.179/180 — pick the Processing Pipeline column that
// best matches the Baseline Status / Substatus. Priority:
//   1. Explicit table (Mike's mapping — deterministic).
//   2. Keyword regex chain (permissive fallback).
//   3. 'new_loan' default.
function _processingStageForSla(b, slaStatus) {
  if (slaStatus !== 'approved') return '';
  const s   = _norm(b && b.Status);
  const sub = _norm(b && b.Substatus);

  // 1. Exact lookup — check Substatus first (Mike stamps stage
  //    names there), then Status as a safety net.
  if (STAGE_LOOKUP[sub]) return STAGE_LOOKUP[sub];
  if (STAGE_LOOKUP[s])   return STAGE_LOOKUP[s];

  // 2. Keyword fallback for anything not in the table.
  const combined = (s + ' ' + sub).trim();
  if (/\bunderwrit/.test(combined))                       return 'underwriting';
  if (/\b(clear to close|cleared|closing|final review|ready to fund|ready to close|final doc|post close|boarded)\b/.test(combined)) return 'pp_closed';
  if (/\b(post uw|uw approved|approved|clear to close|due diligence|doc prep|docs sent|funds wired)\b/.test(combined)) return 'pp_approved';
  if (/\bprocess|appraisal|inspection|kick off/.test(combined)) return 'processing';
  if (/\b(new|intake|received|new loan|dscr|rtl)\b/.test(combined)) return 'new_loan';

  return 'new_loan';
}

function _inferLoanType(b) {
  const s   = String((b && b.Substatus) || '').toLowerCase();
  const nm  = String((b && b.Name) || '').toLowerCase();
  if (s.includes('rtl'))  return 'rtl';
  if (s.includes('dscr')) return 'dscr';
  // Rate as a heuristic — RTL rates are usually 9-12%, DSCR 6-8%.
  const r = Number(b && b.Rate);
  if (isFinite(r) && r > 0) {
    if (r >= 9)  return 'rtl';
    if (r <= 8)  return 'dscr';
  }
  return '';
}

function _accountOwnersLabel(b) {
  const raw = b && (b.Account_Owners || b.Account_Owner || b.Loan_Officer);
  if (!raw) return '';
  if (Array.isArray(raw)) {
    return raw.map((x) => (x && (x.Name || x.name || x.email || x)) || '').filter(Boolean).join(', ');
  }
  if (typeof raw === 'object') return String(raw.Name || raw.name || raw.email || '');
  return String(raw);
}

// ─── Merge helpers ─────────────────────────────────────────

// Only overwrite Baseline-authored fields; everything else stays.
function _mergeLoanPreservingSla(priorLoan, freshBaselineFields) {
  const out = Object.assign({}, priorLoan);
  for (const k of BASELINE_AUTHORED_FIELDS) {
    if (freshBaselineFields[k] !== undefined) out[k] = freshBaselineFields[k];
  }
  // Preserve prior status if SLA advanced it beyond what Baseline
  // says. Rare but possible: Baseline still shows 'in processing'
  // while an SLA admin marked it 'closed'. That said, since Mike
  // isn't dual-working yet, this is defensive only.
  //
  // Also preserve processingStage when the SLA processor already
  // advanced it beyond 'new_loan'. Sync should NEVER walk a
  // processor's kanban card backwards.
  if (priorLoan.processingStage && priorLoan.processingStage !== 'new_loan') {
    out.processingStage = priorLoan.processingStage;
  }
  return out;
}

function _fieldChanges(prior, next, fields) {
  const out = [];
  for (const k of fields) {
    const a = prior ? prior[k] : undefined;
    const b = next  ? next[k]  : undefined;
    if (_ne(a, b)) out.push({ field: k, from: a === undefined ? null : a, to: b === undefined ? null : b });
  }
  return out;
}
function _ne(a, b) {
  if (a === b) return false;
  if (a === null && b === '') return false;
  if (a === '' && b === null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) !== JSON.stringify(b); } catch (_) { return true; }
  }
  return String(a === undefined ? '' : a) !== String(b === undefined ? '' : b);
}

// ─── Primitives ────────────────────────────────────────────

function _str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function _num(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : '';
}
function _keySafeExt(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96);
}
