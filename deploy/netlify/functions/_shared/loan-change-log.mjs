/**
 * _shared/loan-change-log.mjs — Deploy 236.771 (Mike).
 *
 * A REAL audit log: every field-level change made to a loan from Loan Details
 * or a sizer, with who made it and when. Distinct from the Notes & Activity
 * feed (which is human notes + milestone events) — this one records the small
 * stuff: a number edited, a dropdown flipped, a date corrected.
 *
 * Stored in its OWN blob store (`loan_change_log`), keyed
 * `<ownerKey>/<clientId>/<loanId>`, NOT on the loan record — the log grows for
 * the life of the loan and must never bloat the client blob that every list
 * endpoint reads.
 *
 * Entry shape:
 *   { at, by, byName, source, changes: [ { field, label, from, to } ] }
 *
 * Call `recordLoanChanges()` AFTER the loan write succeeds — logging is
 * best-effort and must never fail or slow down the save itself.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';

const STORE_NAME  = 'loan_change_log';
const MAX_ENTRIES = 4000;   // ~ the life of a loan; oldest trimmed first

// Never log these: bookkeeping stamps, transient sizer vars, and the big
// nested objects that carry their own audit trail (uwAudit / lightningAudit).
const SKIP_FIELDS = {
  updatedAt: 1, savedAt: 1, createdAt: 1, _owner: 1,
  _editingLoanId: 1, _editingClientId: 1, _originalAddress: 1,
  uwData: 1, uwAudit: 1, lightningData: 1, lightningAudit: 1,
  notes: 1, noteLog: 1, activity: 1, drawMeta: 1,
  pricingSnapshot: 1, _pricingSnapshot: 1, formData: 1,
  aiExtractedFields: 1, aiExtractedEntities: 1,
};

// Human labels for the fields an LO actually recognizes. Anything not listed
// falls back to a prettified version of the key (arvBpo → "Arv Bpo" reads
// poorly, so the common ones are spelled out here).
const FIELD_LABELS = {
  loanAmt: 'Loan Amount', finalLoanAmount: 'Final Loan Amount',
  rate: 'Interest Rate', points: 'Points', loanType: 'Loan Type',
  toolType: 'Product', loanPurpose: 'Loan Purpose', status: 'Status',
  processingStage: 'Processing Stage', disposition: 'Disposition',
  purchasePrice: 'Purchase Price', rehabBudget: 'Rehab Budget',
  arv: 'ARV (borrower)', propValue: 'As-Is Value (borrower)',
  aivBpo: 'AIV BPO', arvBpo: 'ARV BPO', currentLoanAmt: 'Existing Debt',
  fico: 'FICO', experience: 'Experience', propType: 'Property Type',
  rentalType: 'Rental Type', dscr: 'DSCR', address: 'Property Address',
  fundingDate: 'Funding Date', maturityDate: 'Maturity Date',
  closingDate: 'Closing Date', expectedCloseDate: 'Expected Close Date',
  taxes: 'Taxes', insurance: 'Insurance', hoa: 'HOA',
  bedrooms: 'Bedrooms', bathrooms: 'Bathrooms', sqft: 'Square Footage',
  numUnits: 'Units', brokerFee: 'Broker Fee', brokerName: 'Broker',
  servicerName: 'Servicer', servicerLoanNumber: 'Servicer Loan #',
  investorName: 'Investor', investorId: 'Investor (Funding Plan)',
  buyRate: 'Buy Rate', soldRate: 'Sold Rate', soldDate: 'Sold Date',
  paymentAmount: 'Payment Amount', payoffAmount: 'Payoff Amount',
  payoffDate: 'Payoff Date', upb: 'UPB', fundingSource: 'Funding Source',
  tpo: 'TPO', dutchInterest: 'Interest Structure', prepay: 'Prepay',
  projectDescription: 'Project Description', ref: 'Referral Source',
  // Deploy 236.774 — labels for the rest of the surfaces now feeding the log
  // (servicing / status / terms / property), so entries read like the UI does.
  servicerUrl: 'Servicer Portal URL', activelyTrading: 'Actively Trading',
  tpoSpread: 'TPO Spread', closingFees: 'Closing Fees',
  loanTerm: 'Loan Term', isIO: 'Interest Only', lienPosition: 'Lien Position',
  originationDate: 'Origination Date', firstPaymentDate: 'First Payment Date',
  holdback: 'Rehab Holdback', initialAdvance: 'Initial Advance',
  downPayment: 'Down Payment', tpoPremium: 'TPO Premium',
  lotSize: 'Lot Size', yearBuilt: 'Year Built', stories: 'Stories',
  propertyCounty: 'County', floodZone: 'Flood Zone', purchaseDate: 'Purchase Date',
  monthlyTaxes: 'Taxes (monthly)', monthlyInsurance: 'Insurance (monthly)',
  monthlyHoa: 'HOA (monthly)', isPortfolio: 'Portfolio Loan',
  propertyCount: 'Property Count', rent: 'Total Monthly Rent',
  unitsOccupied: 'Units Occupied', vacancyPct: 'Vacancy %',
  assignedProcessor: 'Assigned Processor', assignedLo: 'Assigned LO',
  guarantors: 'Guarantors', rateLockStart: 'Rate Lock Start',
  // Deploy 236.777 — felony hard-stop fields (background checks + the exception).
  felonyEntity: 'Felony — Entity Background Check',
  felonyEntityDetail: 'Felony detail (entity)',
  felonyGuarantor: 'Felony — Guarantor Background Check',
  felonyGuarantorDetail: 'Felony detail (guarantor)',
  felonyAckAt: 'Felony exception recorded',
  // Deploy 236.849 — owner-occupancy critical flag.
  occupancyIntent: 'Owner-occupancy intent declared',
  occupancyIntentBy: 'Owner-occupancy declared by',
  occupancyAckAt: 'Owner-occupancy alert resolved',
  // Deploy 236.852 — broker-mode flag (phantom-mode clears).
  _isBrokerLoan: 'Broker mode',
};

function labelFor(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

// Normalize for comparison so "5" vs 5 vs " 5 " isn't logged as a change.
function norm(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return ''; } }
  return String(v).trim();
}

/**
 * Field-level diff of a loan record. Returns [] when nothing meaningful moved.
 * Only scalars are compared — nested objects are skipped (SKIP_FIELDS covers
 * the ones that matter; anything else object-shaped is compared as JSON).
 */
export function diffLoan(before, after) {
  const a = before || {};
  const b = after  || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes = [];
  for (const k of keys) {
    if (SKIP_FIELDS[k]) continue;
    if (k.charAt(0) === '_') continue;          // internal/transient
    const from = norm(a[k]);
    const to   = norm(b[k]);
    if (from === to) continue;
    if (from === '' && to === '') continue;
    changes.push({
      field: k,
      label: labelFor(k),
      from: from.length > 200 ? from.slice(0, 200) + '…' : from,
      to:   to.length   > 200 ? to.slice(0, 200) + '…'   : to,
    });
  }
  changes.sort((x, y) => x.label.localeCompare(y.label));
  return changes;
}

function keyFor(ownerKey, clientId, loanId) {
  return keySafe(ownerKey) + '/' + keySafe(clientId) + '/' + keySafe(loanId);
}
// Deploy 236.861 — canonical key is the LOAN id alone. Loan ids are unique and
// immutable, while ownerKey/clientId change on reassign / make-primary / LO
// moves — the triple key STRANDED history at every hop (the Locust Ave loan
// showed one entry after a month of changes). New writes land here; reads
// merge this with every legacy triple-key record for the loan.
function loanKey(loanId) {
  return 'byloan/' + keySafe(loanId);
}

/**
 * Append one entry. Best-effort: never throws into the caller's save path.
 * `source` is where the edit came from — 'Loan Details', 'RTL Sizer', etc.
 */
export async function recordLoanChanges(opts) {
  try {
    const o = opts || {};
    const changes = Array.isArray(o.changes) ? o.changes : [];
    if (!changes.length) return 0;
    if (!o.ownerKey || !o.clientId || !o.loanId) return 0;

    const store = getStore({ name: STORE_NAME, consistency: 'strong' });
    const key = loanKey(o.loanId); // 236.861 — was keyFor(owner, client, loan)
    let rec = null;
    try { rec = await store.get(key, { type: 'json' }); } catch (e) { rec = null; }
    if (!rec || !Array.isArray(rec.entries)) rec = { entries: [] };

    rec.entries.push({
      at: new Date().toISOString(),
      by: String(o.actor || ''),
      byName: String(o.actorName || o.actor || ''),
      source: String(o.source || ''),
      changes,
    });
    if (rec.entries.length > MAX_ENTRIES) {
      rec.entries = rec.entries.slice(rec.entries.length - MAX_ENTRIES);
    }
    rec.updatedAt = new Date().toISOString();
    await store.setJSON(key, rec);
    return changes.length;
  } catch (e) {
    console.warn('[loan-change-log] record failed (non-fatal):', e && e.message);
    return 0;
  }
}

/** Read the full log for one loan, newest entry first.
 * 236.861 — merges the canonical loan-keyed record with EVERY legacy
 * triple-keyed record for this loan id, regardless of which owner/client the
 * loan lived under when the entry was written. The store only holds loans
 * edited since the 236.771 rollout, so the full listing stays cheap. */
export async function readLoanChangeLog(ownerKey, clientId, loanId) {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const entries = [];
  const tryRead = async (key) => {
    try {
      const rec = await store.get(key, { type: 'json' });
      if (rec && Array.isArray(rec.entries)) entries.push(...rec.entries);
    } catch (_) {}
  };
  await tryRead(loanKey(loanId));
  try {
    const { blobs } = await store.list();
    const suffix = '/' + keySafe(loanId);
    for (const b of blobs || []) {
      if (!b || !b.key || b.key === loanKey(loanId)) continue;
      if (b.key.endsWith(suffix)) await tryRead(b.key);
    }
  } catch (e) {
    console.warn('[loan-change-log] legacy sweep failed (non-fatal):', e && e.message);
  }
  entries.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  entries.reverse();
  return entries;
}
