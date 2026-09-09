/**
 * scripts/review-retype-test.mjs — Deploy 236.927
 *
 * Gate for retypeReview (loan-review-retype.mjs): flipping a Doc Review's
 * checklist to match the loan's tool type without losing a single document.
 *
 * Run: node scripts/review-retype-test.mjs
 */
import { retypeReview } from '../deploy/netlify/functions/loan-review-retype.mjs';
import { getChecklist, portfolioCollateralEntries } from '../deploy/netlify/functions/_shared/loan-review-checklists.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
function tray(section, extra) {
  return Object.assign({ section, verdict: 'pending', currentDocId: '', documents: [], history: [] }, extra || {});
}
const DSCR = getChecklist('dscr').map((e) => e.slug), RTL = getChecklist('rtl').map((e) => e.slug);
const RTL_ONLY = RTL.filter((s) => !DSCR.includes(s)), DSCR_ONLY = DSCR.filter((s) => !RTL.includes(s));

const KEPT = ['condo_hoa_docs', 'sow', 'track_record', 'voided_check'];   // RTL-only trays with work on them

function rtlReview() {
  // Every RTL checklist tray, pristine -- then the interesting ones on top.
  const docs = {};
  getChecklist('rtl').forEach((e) => { docs[e.slug] = tray(e.section); });
  Object.assign(docs, {
      appraisal:        tray('collateral', { currentDocId: 'd_appr', documents: [{ docId: 'd_appr' }] }),
      sow:              tray('collateral', { currentDocId: 'd_sow' }),               // RTL-only, has a doc -> kept
      bpo_valuation:    tray('collateral'),                                          // RTL-only, pristine -> removed
      assignment_agreement: tray('collateral', { hidden: true }),                    // RTL-only, hidden + pristine -> removed
      track_record:     tray('borrower', { verdict: 'na', naReason: 'Not applicable' }), // RTL-only, N/A'd -> kept
      condo_hoa_docs:   tray('collateral', { processorNotes: 'asked title' }),      // RTL-only, notes -> kept
      voided_check:     tray('borrower', { aiVerdict: 'issues' }),                   // RTL-only, AI ran -> kept
      psa:              tray('collateral'),                                          // in BOTH -> untouched
      loan_application: tray('loan', { currentDocId: 'd_app' }),
      other_1787673737217_oqvb: tray('collateral', { isCustom: true, label: 'Survey' }),
  });
  return { id: 'r_test', loanType: 'rtl', investor: 'colchis', address: '1 Main St', docs };
}

console.log('review retype gate\n');
check('sanity: RTL and DSCR checklists differ', RTL_ONLY.length > 0 && DSCR_ONLY.length > 0, true);

// -- The reported case: RTL review on a DSCR loan ---------------------------
{
  const rv = rtlReview();
  const r = retypeReview(rv, 'dscr', { by: 'mike@slacapital.com', now: '2026-09-09T20:00:00.000Z' });
  check('flips rtl -> dscr', [r.changed, r.from, r.to, rv.loanType], [true, 'rtl', 'dscr', 'dscr']);
  check('default investor follows the type', [r.investorFrom, r.investorTo, rv.investor], ['colchis', 'diya', 'diya']);
  check('every pristine RTL-only tray removed, nothing else', r.removed.sort(), RTL_ONLY.filter((s) => KEPT.indexOf(s) < 0).sort());
  check('RTL-only trays with work on them kept', r.kept.sort(), KEPT.slice().sort());
  check('  kept trays are exactly as they were',
    [rv.docs.sow.currentDocId, rv.docs.track_record.naReason, rv.docs.voided_check.aiVerdict], ['d_sow', 'Not applicable', 'issues']);
  check('shared trays untouched', [rv.docs.appraisal.currentDocId, rv.docs.loan_application.currentDocId, !!rv.docs.psa], ['d_appr', 'd_app', true]);
  check('custom tray untouched', rv.docs.other_1787673737217_oqvb.label, 'Survey');
  check('every DSCR-only tray now exists', DSCR_ONLY.filter((s) => !rv.docs[s]), []);
  check('added = exactly the DSCR-only slugs', r.added.slice().sort(), DSCR_ONLY.slice().sort());
  check('stamped on the review', [rv.retypedFrom, rv.retypedBy, rv.retypedAt], ['rtl', 'mike@slacapital.com', '2026-09-09T20:00:00.000Z']);
  check('history line explains it', /RTL to DSCR.*removed \d+.*kept 4.*added \d+/.test(rv.history.slice(-1)[0].note), true);

  const again = retypeReview(rv, 'dscr');
  check('second pass is a no-op', [again.changed, rv.history.length], [false, 1]);
}

// -- Investor + refusals ----------------------------------------------------
{
  const rv = rtlReview(); rv.investor = 'stride';
  retypeReview(rv, 'dscr');
  check('an explicit investor choice is kept', rv.investor, 'stride');

  const blank = rtlReview(); blank.investor = '';
  retypeReview(blank, 'dscr');
  check('a blank investor gets the new default', blank.investor, 'diya');

  const light = rtlReview(); light.loanType = 'light';
  check('a light review is refused', retypeReview(light, 'dscr').changed, false);
  check('an unknown target is refused', retypeReview(rtlReview(), 'bridge').changed, false);
  check('null never throws', retypeReview(null, 'dscr').changed, false);
}

// -- DSCR -> RTL works the other way too ------------------------------------
{
  const rv = { id: 'r2', loanType: 'dscr', investor: 'diya', docs: { lease_agreements: tray('collateral'), appraisal: tray('collateral', { currentDocId: 'x' }) } };
  const r = retypeReview(rv, 'rtl');
  check('dscr -> rtl removes the pristine DSCR-only tray, mints RTL', [r.removed, rv.investor, !!rv.docs.sow, !!rv.docs.appraisal], [['lease_agreements'], 'colchis', true, true]);
}

// -- Portfolio review: per-property trays resolve through their base --------
{
  const props = [{ index: 0, label: 'Property 1', address: 'A' }, { index: 1, label: 'Property 2', address: 'B' }, { index: 2, label: 'Property 3', address: 'C' }];
  const rv = {
    id: 'r3', loanType: 'rtl', investor: 'colchis', properties: props, isPortfolio: true,
    docs: {
      sow__p0: tray('collateral', { propertyIndex: 0, currentDocId: 'd_sow' }),
      sow__p1: tray('collateral', { propertyIndex: 1 }),                     // sow is guaranteed on every portfolio -> stays
      bpo_valuation__p1: tray('collateral', { propertyIndex: 1 }),           // RTL-only, pristine -> removed
      assignment_agreement__p2: tray('collateral', { propertyIndex: 2 }),    // RTL-only, pristine -> removed
      condo_hoa_docs__p0: tray('collateral', { propertyIndex: 0, currentDocId: 'd_hoa' }), // RTL-only with a doc -> kept
      appraisal__p0: tray('collateral', { propertyIndex: 0, currentDocId: 'd_appr' }),
      loan_application: tray('loan', { currentDocId: 'd_app' }),
    },
  };
  const r = retypeReview(rv, 'dscr');
  check('portfolio: pristine RTL-only per-property trays removed', r.removed.sort(), ['assignment_agreement__p2', 'bpo_valuation__p1']);
  check('portfolio: RTL-only tray with a doc kept', r.kept, ['condo_hoa_docs__p0']);
  check('portfolio: guaranteed SOW trays untouched', [rv.docs.sow__p0.currentDocId, !!rv.docs.sow__p1], ['d_sow', true]);
  const wantP = portfolioCollateralEntries('dscr').map((e) => e.slug);
  const missing = [];
  wantP.forEach((s) => [0, 1, 2].forEach((i) => { if (!rv.docs[s + '__p' + i]) missing.push(s + '__p' + i); }));
  check('portfolio: every DSCR collateral category exists for all three properties', missing, []);
  check('portfolio: no shared base collateral tray was minted', wantP.filter((s) => !!rv.docs[s]), []);
  check('portfolio: appraisal document intact', rv.docs.appraisal__p0.currentDocId, 'd_appr');
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
