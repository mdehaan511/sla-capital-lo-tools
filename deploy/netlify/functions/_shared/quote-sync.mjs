/**
 * quote-sync.mjs — helper that keeps the QuoteStore's formData in
 * sync with the loan record after inline edits on Loan Details.
 *
 * Deploy 236.222 — Phase 5 of Mike's "Loan Details is the point of
 * truth" refactor. The Sizer's Save writes to both the loan record
 * (via loan-update-from-sizer) and the quotes blob store (via
 * quotes-save). But Loan Details' inline edits only touch the loan
 * record — the quote entry keeps its stale formData.
 *
 * That drift makes the Saved Quotes panel + any downstream reader
 * (rate sheet regen path, quote-based PDFs) show pre-edit values.
 *
 * This helper finds any quote entries matching (ownerKey, loanId)
 * and mirrors the loan's editable fields into their formData. Called
 * from loan-financials-edit.mjs and loan-financials-restore.mjs
 * after a successful write.
 *
 * Failure is non-fatal — a stale quote is a minor UX issue, not a
 * loan-data-integrity issue. Callers catch + log.
 */
import { getStore } from '@netlify/blobs';
import { quotesIndex } from './quotes-index.mjs'; // Deploy 236.343

// Fields that mirror onto the quote's formData. Match the sizer's
// buildLoanFromSizer + loan-financials-edit mirror pass. formData
// key names on the LEFT, loan-record key names on the RIGHT.
const FORMDATA_FROM_LOAN = {
  loanAmt:         'loanAmt',
  propValue:       'propValue',
  rate:            'rate',
  points:          'points',
  purchasePrice:   'purchasePrice',
  rehabBudget:     'rehabBudget',
  arv:             'arv',
  fico:            'fico',
  loanType:        'loanType',
  experience:      'experience',
  brokerFee:       'brokerFee',
  appraisedValue:  'appraisedValue',
  monthlyRent:     'monthlyRent',
  monthlyTaxes:    'monthlyTaxes',
  monthlyInsurance: 'monthlyInsurance',
  monthlyHoa:      'monthlyHoa',
  // Sizer-side legacy short names — kept in sync with the mirror pass
  // in loan-financials-edit.mjs.
  rent:            'rent',
  taxes:           'taxes',
  insurance:       'insurance',
  hoa:             'hoa',
};

// Rate/points display strings that the sizer's load path reads.
// Kept in sync so downstream consumers see the same numbers.
function _formatRateDisplay(rate) {
  if (rate == null || rate === '') return '';
  const n = Number(rate);
  if (!isFinite(n) || n <= 0) return '';
  return n.toFixed(3);
}
function _formatPointsDisplay(points) {
  if (points == null || points === '') return '';
  const n = parseFloat(String(points).replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || n < 0) return '';
  return n.toFixed(2) + ' pts';
}
function _rateOverrideFromRate(rate) {
  if (rate == null || rate === '') return '';
  const n = Number(rate);
  if (!isFinite(n) || n <= 0) return '';
  // Loan record stores rate as percent (8.625). Override is decimal.
  return String(n > 1 ? n / 100 : n);
}

/**
 * Sync loan-level values into any QuoteStore entry that references
 * this loan. Matches on (ownerKey, loanId) — the deterministic id
 * link. If no matching quote exists, no-op (the loan wasn't saved
 * through the sizer's Save Quote flow).
 *
 * @param {string} ownerKey   keySafe(loEmail)
 * @param {object} loan       fresh loan record
 * @returns {Promise<{updated: number}>}
 */
export async function syncLoanToQuoteStore(ownerKey, loan) {
  try {
    return await _syncLoanToQuoteStoreInternal(ownerKey, loan);
  } catch (e) {
    console.warn(`syncLoanToQuoteStore failed for ${ownerKey}/${loan && loan.id}:`, e && e.message);
    return { updated: 0 };
  }
}

/**
 * Strict variant — throws on any quote store write / list failure.
 * Use from mutation endpoints so a broken quote sync surfaces as a
 * 500 to the caller instead of leaving Pipeline showing stale
 * pricing on the quote card indefinitely. Same discipline as
 * pgMirror.upsertClientWithLoansStrict and upsertClientStrict.
 */
export async function syncLoanToQuoteStoreStrict(ownerKey, loan) {
  return _syncLoanToQuoteStoreInternal(ownerKey, loan);
}

async function _syncLoanToQuoteStoreInternal(ownerKey, loan) {
  if (!ownerKey || !loan || !loan.id) return { updated: 0 };
  const store = getStore({ name: 'quotes', consistency: 'strong' });
  const blobs = (await store.list({ prefix: ownerKey + '/' })).blobs || [];
  if (!blobs.length) return { updated: 0 };

  let updated = 0;
  const now = new Date().toISOString();
  for (const { key } of blobs) {
    const q = await store.get(key, { type: 'json' });
    if (!q) continue;
    if (q.loanId !== loan.id) continue;
    q.formData = q.formData || {};
    let changed = false;
    for (const [fdKey, loanKey] of Object.entries(FORMDATA_FROM_LOAN)) {
      const v = loan[loanKey];
      if (v === undefined || v === null || v === '') continue;
      if (String(q.formData[fdKey]) !== String(v)) {
        q.formData[fdKey] = v;
        changed = true;
      }
    }
    // Mirror the sizer display strings + override flags. These are
    // written by loan-financials-edit's _mirrorForSizer pass; when a
    // consumer bypasses that path (rare) this catch-up keeps the
    // quote in sync.
    const disp = _formatRateDisplay(loan.rate);
    if (disp && q.formData._finalRate !== disp) { q.formData._finalRate = disp; changed = true; }
    const ovr = _rateOverrideFromRate(loan.rate);
    if (ovr && q.formData._rateOverride !== ovr) { q.formData._rateOverride = ovr; changed = true; }
    const pdisp = _formatPointsDisplay(loan.points);
    if (pdisp && q.formData._points !== pdisp) { q.formData._points = pdisp; changed = true; }
    if (loan.points !== undefined && loan.points !== null && loan.points !== '') {
      const pOvr = String(parseFloat(String(loan.points).replace(/[^0-9.]/g, '')));
      if (pOvr && pOvr !== 'NaN' && q.formData._pointsOverride !== pOvr) {
        q.formData._pointsOverride = pOvr;
        changed = true;
      }
    }
    // Address changes on the loan record propagate to the quote too
    // (the sizer's search uses formData.address).
    if (loan.address && q.formData.address !== loan.address) {
      q.formData.address = loan.address;
      changed = true;
    }
    if (!changed) continue;
    q.updatedAt = now;
    q._loanSyncedAt = now;
    await store.setJSON(key, q);
    quotesIndex.upsertRecord(ownerKey, q).catch(() => {});
    updated++;
  }
  return { updated };
}
