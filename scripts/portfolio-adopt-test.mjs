/**
 * scripts/portfolio-adopt-test.mjs — Deploy 236.921
 *
 * Gate for adoptPortfolioFromLoan + the per-property backfill that follows it
 * (loan-review-sync-categories.mjs).
 *
 * Mike: "This loan is a portfolio but only appears to have document collection
 * for 1 property." The review was created while the loan was single-property;
 * the loan became a 3-property portfolio later and nothing re-derived that.
 *
 * The fixture mirrors 2524 Hawthorne's review: RTL, shared base collateral
 * trays (some holding documents), custom "Other" trays, no `properties`.
 *
 * Run: node scripts/portfolio-adopt-test.mjs
 */
import { adoptPortfolioFromLoan, syncMissingCategories } from '../deploy/netlify/functions/loan-review-sync-categories.mjs';
import { portfolioCollateralEntries } from '../deploy/netlify/functions/_shared/loan-review-checklists.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

const LOAN = {
  id: 'l_1787245471368_bth3', isPortfolio: true, toolType: 'dscr', propertyCount: 3,
  properties: [
    { address: '2524 Hawthorne Ave, Evansville, IN 47714, USA' },
    { address: '436 S Linwood Ave, Evansville, IN 47713' },
    { address: '108 E Maryland St, Evansville, IN 47711' },
  ],
};
function tray(section, extra) {
  return Object.assign({ section, verdict: 'pending', currentDocId: '', documents: [], history: [] }, extra || {});
}
function fixture() {
  return {
    id: 'r_test', loanType: 'rtl', address: LOAN.properties[0].address,
    source: { kind: 'existing', loanId: LOAN.id, clientId: 'c_1', ownerKey: 'sara.s@slacapital.com' },
    docs: {
      appraisal:             tray('collateral', { currentDocId: 'd_appr', documents: [{ docId: 'd_appr' }] }),
      sow:                   tray('collateral', { currentDocId: 'd_sow' }),
      psa:                   tray('collateral'),
      evidence_of_insurance: tray('collateral'),
      flood_certificate:     tray('collateral'),
      other_1787673737217_oqvb: tray('collateral', { isCustom: true, label: 'Survey' }),
      custom_1787761802655_fypj: tray('collateral', { isCustom: true, label: 'HOA letter', borrowerRequested: true }),
      loan_application:      tray('loan', { currentDocId: 'd_app' }),
      term_sheet:            tray('loan'),
    },
  };
}

console.log('portfolio adopt gate\n');

// ── The reported case ─────────────────────────────────────────────────────
{
  const review = fixture();
  const r = adoptPortfolioFromLoan(review, LOAN);
  check('adopts the loan\'s three properties', [r.adopted, r.from, r.to], [true, 0, 3]);
  check('review.properties carries the addresses in order',
    review.properties.map((p) => p.address), LOAN.properties.map((p) => p.address));
  check('review is flagged portfolio', review.isPortfolio, true);

  // Base collateral trays became Property 1's, keeping their documents.
  check('base collateral trays migrated', r.migrated.sort(),
    ['appraisal', 'evidence_of_insurance', 'flood_certificate', 'psa', 'sow']);
  check('  appraisal now lives at appraisal__p0 with its document',
    [!!review.docs.appraisal, review.docs.appraisal__p0 && review.docs.appraisal__p0.currentDocId], [false, 'd_appr']);
  check('  tagged as Property 1 with the primary address',
    [review.docs.sow__p0.propertyIndex, review.docs.sow__p0.propertyAddress], [0, LOAN.properties[0].address]);
  check('  the move is on the tray history', /portfolio/i.test(review.docs.sow__p0.history.slice(-1)[0].note), true);

  // Custom trays and non-collateral trays are untouched.
  check('custom collateral trays stay shared (untagged, same key)',
    [!!review.docs.other_1787673737217_oqvb, review.docs.other_1787673737217_oqvb.propertyIndex], [true, undefined]);
  check('a team-requested custom tray keeps its flag', review.docs.custom_1787761802655_fypj.borrowerRequested, true);
  check('loan-section trays untouched', [!!review.docs.loan_application, review.docs.loan_application.currentDocId], [true, 'd_app']);

  // Now the existing backfill mints Property 2 + 3.
  const { added } = syncMissingCategories(review);
  const entries = portfolioCollateralEntries('rtl').map((e) => e.slug);
  const p1 = added.filter((s) => /__p1$/.test(s)).map((s) => s.replace(/__p1$/, ''));
  const p2 = added.filter((s) => /__p2$/.test(s)).map((s) => s.replace(/__p2$/, ''));
  check('every portfolio collateral category minted for Property 2', entries.filter((e) => p1.indexOf(e) < 0), []);
  check('… and Property 3', entries.filter((e) => p2.indexOf(e) < 0), []);
  check('Property 1 gets the guaranteed docs it lacked (not the ones it already had)',
    added.filter((s) => /__p0$/.test(s)).indexOf('appraisal__p0') < 0 &&
    added.filter((s) => /__p0$/.test(s)).length > 0, true);
  check('no shared base tray was re-created', entries.filter((e) => !!review.docs[e]), []);

  // Idempotent: a second page open changes nothing.
  const again = adoptPortfolioFromLoan(review, LOAN);
  const { added: added2 } = syncMissingCategories(review);
  check('second pass adopts nothing', again.adopted, false);
  check('second pass adds nothing', added2, []);
}

// ── Nothing to do ─────────────────────────────────────────────────────────
{
  const single = fixture();
  const r = adoptPortfolioFromLoan(single, { isPortfolio: false, properties: [] });
  check('single-property loan → untouched', [r.adopted, !!single.properties, !!single.docs.appraisal], [false, false, true]);

  const already = fixture(); already.properties = LOAN.properties.map((p, i) => ({ index: i, label: 'Property ' + (i + 1), address: p.address }));
  check('review already at three → untouched', adoptPortfolioFromLoan(already, LOAN).adopted, false);

  const twoProp = { isPortfolio: true, properties: LOAN.properties.slice(0, 2) };
  const grows = fixture(); grows.properties = [{ index: 0, label: 'Main', address: 'x' }];
  const g = adoptPortfolioFromLoan(grows, twoProp);
  check('a review with fewer properties than the loan grows', [g.from, g.to], [1, 2]);
  check('  and keeps the label it already had for Property 1', grows.properties[0].label, 'Main');

  check('null inputs never throw', adoptPortfolioFromLoan(null, LOAN).adopted, false);
  check('a loan with one listed property is not a portfolio', adoptPortfolioFromLoan(fixture(), { isPortfolio: true, properties: [{ address: 'x' }] }).adopted, false);
}

// ── A __p0 that already exists is never clobbered ─────────────────────────
{
  const review = fixture();
  review.docs.appraisal__p0 = tray('collateral', { propertyIndex: 0, currentDocId: 'd_keep' });
  const r = adoptPortfolioFromLoan(review, LOAN);
  check('base appraisal left alone when appraisal__p0 already exists',
    [r.migrated.indexOf('appraisal') < 0, !!review.docs.appraisal, review.docs.appraisal__p0.currentDocId], [true, true, 'd_keep']);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
