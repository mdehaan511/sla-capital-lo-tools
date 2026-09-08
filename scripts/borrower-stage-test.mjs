/**
 * scripts/borrower-stage-test.mjs — Deploy 236.896
 *
 * Gate for the borrower-facing stage label (_borrowerStage in
 * borrower-portal-loans.mjs).
 *
 * Mike: "The status isnt correct. It is showing clear to close when it is not."
 *
 * The bug: `status === 'approved'` was OR'd onto the Clear to Close line. In
 * this system approved means CREDIT-approved — the condition for a loan to
 * ENTER the processing board, not to finish it — so 42 live loans were telling
 * their borrowers they were clear to close while sitting in New Loan, Document
 * Collection or Underwriting.
 *
 * The invariant this file defends: **the borrower's label agrees with the
 * column the staff board puts the loan in.** `columnFor()` from
 * processing-pipeline.html is reproduced here, and every scenario is asserted
 * against BOTH, so the two can't drift apart again.
 *
 * Run: node scripts/borrower-stage-test.mjs
 */
import { readFileSync } from 'node:fs';

// _borrowerStage isn't exported (it's an internal of the endpoint), so pull it
// out of the source. That also means this gate fails loudly if it's renamed.
const SRC = readFileSync(new URL('../deploy/netlify/functions/borrower-portal-loans.mjs', import.meta.url), 'utf8');
const start = SRC.indexOf('const _STAGE_LABELS');
const end = SRC.indexOf('\n}', SRC.indexOf('function _borrowerStage'));
if (start < 0 || end < 0) {
  console.error('Could not find _STAGE_LABELS / _borrowerStage in borrower-portal-loans.mjs');
  process.exit(1);
}
const _borrowerStage = new Function(SRC.slice(start, end + 2) + '\nreturn _borrowerStage;')();

/**
 * columnFor() as it stands in deploy/processing-pipeline.html — the staff
 * board's own placement. Kept in sync by the "agrees with the board" checks
 * below; if the board changes, update this copy and the expectations together.
 */
function columnFor(loan) {
  const st0 = String(loan.status || '').toLowerCase().trim();
  if (st0 === 'on_hold' || st0 === 'denied' || st0 === 'cancelled') return null;
  if (st0 === 'closed') {
    const disp = String(loan.disposition || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    const bl = String(loan.baselineStatus || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
    const offloaded = (disp === 'sold' || disp === 'servicing' || disp === 'paid off' || disp === 'liquidated'
      || bl === 'sold' || bl === 'in servicing' || bl === 'servicing' || bl === 'liquidated' || bl === 'paid off');
    if (offloaded) return null;
    return 'pp_closed';
  }
  const stage = String(loan.processingStage || '').toLowerCase().trim();
  if (stage === 'processing')   return 'processing';
  if (stage === 'underwriting') return 'underwriting';
  if (stage === 'pp_approved')  return 'pp_approved';
  if (stage === 'pp_closed')    return 'pp_closed';
  if (stage === 'new_loan')     return 'new_loan';
  if (st0 === 'approved') return 'new_loan';
  return null;
}

/** What each board column should read as on the borrower's card. */
const COLUMN_LABEL = {
  new_loan:     'In Review',
  processing:   'Document Collection',
  underwriting: 'Underwriting',
  pp_approved:  'Clear to Close',
  pp_closed:    'Closed / Funded',
};

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('borrower stage gate\n');

// ── The reported bug ──────────────────────────────────────────────────────
{
  // 4220 Glendale Street — Maria's loan, exactly as it sits in production.
  const glendale = { processingStage: 'new_loan', status: 'approved' };
  check("Mike's example (stage new_loan + status approved) is NOT clear to close",
    _borrowerStage(glendale).label, 'In Review');

  check('approved + processing → Document Collection',
    _borrowerStage({ processingStage: 'processing', status: 'approved' }).label, 'Document Collection');
  check('approved + underwriting → Underwriting',
    _borrowerStage({ processingStage: 'underwriting', status: 'approved' }).label, 'Underwriting');
  check('approved with NO stage → In Review (it just entered the board)',
    _borrowerStage({ status: 'approved' }).label, 'In Review');

  // The one case that genuinely is clear to close.
  check('pp_approved IS clear to close',
    _borrowerStage({ processingStage: 'pp_approved', status: 'approved' }).label, 'Clear to Close');
}

// ── The invariant: never contradict the staff board ───────────────────────
{
  const stages = ['', 'new_loan', 'processing', 'underwriting', 'pp_approved', 'pp_closed'];
  const statuses = ['active', 'approved', 'submitted', 'closed'];
  let compared = 0, disagreements = [];
  for (const processingStage of stages) {
    for (const status of statuses) {
      const loan = { processingStage, status };
      const col = columnFor(loan);
      if (!col) continue;             // not on the board — nothing to agree with
      compared++;
      const label = _borrowerStage(loan).label;
      if (label !== COLUMN_LABEL[col]) {
        disagreements.push('stage=' + (processingStage || '(none)') + ' status=' + status +
          ' → board:' + col + ' (' + COLUMN_LABEL[col] + ') but borrower saw "' + label + '"');
      }
    }
  }
  check('every board-placed combination agrees with the board (' + compared + ' compared)', disagreements, []);
}

// ── Terminal + dead loans ─────────────────────────────────────────────────
{
  check('status closed → Closed / Funded', _borrowerStage({ status: 'closed' }).label, 'Closed / Funded');
  check('pp_closed → Closed / Funded', _borrowerStage({ processingStage: 'pp_closed', status: 'approved' }).label, 'Closed / Funded');

  check('a denied loan is not "In Review"', _borrowerStage({ status: 'denied' }).label, 'Not Approved');
  check('a cancelled loan is not shown as progressing',
    _borrowerStage({ status: 'cancelled', processingStage: 'processing' }).label, 'Cancelled');

  // Legacy rot: a denied loan carrying disposition 'sold' (4 such records live).
  // Reading disposition here would tell that borrower their loan funded.
  check('denied + disposition sold is never "Closed / Funded"',
    _borrowerStage({ status: 'denied', disposition: 'sold' }).label, 'Not Approved');
}

// ── Legacy Baseline fallbacks (no processingStage) ────────────────────────
{
  check('baseline underwriting', _borrowerStage({ baselineStatus: 'Underwriting' }).label, 'Underwriting');
  check('baseline processing', _borrowerStage({ baselineStatus: 'Processing' }).label, 'Document Collection');
  check('baseline in servicing → Closed / Funded', _borrowerStage({ baselineStatus: 'In Servicing' }).label, 'Closed / Funded');
  check('baseline paid_off underscores normalise', _borrowerStage({ baselineStatus: 'paid_off' }).label, 'Closed / Funded');
  // Baseline "Approved" meant credit-approved too — same trap, same answer.
  check('baseline approved is NOT clear to close', _borrowerStage({ baselineStatus: 'Approved' }).label, 'In Review');
}

// ── Shape ─────────────────────────────────────────────────────────────────
{
  const keys = ['review', 'processing', 'underwriting', 'cleartoclose', 'closed', 'denied'];
  const seen = [
    _borrowerStage({ status: 'active' }),
    _borrowerStage({ processingStage: 'processing' }),
    _borrowerStage({ processingStage: 'underwriting' }),
    _borrowerStage({ processingStage: 'pp_approved' }),
    _borrowerStage({ status: 'closed' }),
    _borrowerStage({ status: 'denied' }),
  ];
  check('every stage returns a known key', seen.every((x) => keys.indexOf(x.key) >= 0), true);
  check('every stage returns a label', seen.every((x) => !!x.label), true);
  check('an empty loan record does not throw', _borrowerStage({}).label, 'In Review');
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
