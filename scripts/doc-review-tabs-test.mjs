/**
 * scripts/doc-review-tabs-test.mjs — Deploy 237.136
 *
 * Gate for the doc review's status model (deploy/loan-doc-review.js). The page is one
 * big IIFE with no exports, so the test LIFTS the real status / stage block out of the
 * file and runs it in a vm: tab routing is checked against the code that ships, not a
 * copy of it. If the block is renamed the markers below fail loudly.
 *
 * Run: node scripts/doc-review-tabs-test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../deploy/loan-doc-review.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('marker missing: ' + from.slice(0, 50));
  return src.slice(a, b);
};
const code =
  cut('  var APP_SLUGS = {', '  var DOC_META = {') +
  cut('  var _STATUSES = [', '  var STAGE_EMPTY = {');

const ctx = {
  console, String, Array, Object,
  DOC_META: {
    loan_application: { label: 'Loan Application', section: 'loan' },
    term_sheet: { label: 'Term Sheet', section: 'loan' },
    appraisal: { label: 'Appraisal', section: 'collateral' },
    guarantor_id: { label: 'Guarantor ID', section: 'guarantor' },
    articles_of_organization: { label: 'Articles', section: 'borrower' },
    cpl: { label: 'CPL', section: 'closing' },
  },
  _review: null,
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
};
const setDocs = (docs) => { ctx._review = { docs }; };
const run = (s) => vm.runInContext(s, ctx);
const stage = (slug) => run('_stageOf(' + JSON.stringify(slug) + ')');
const status = (slug) => run('_statusOf(' + JSON.stringify(slug) + ')');
const onCond = (slug) => run('_onConditionsTab(' + JSON.stringify(slug) + ')');
const sec = (slug) => run('_secOf(' + JSON.stringify(slug) + ')');

console.log('doc review tabs + status gate\n');

check('the nine statuses from Mike\'s screenshot, in order',
  run('_STATUSES.map(function(s){return s.label})'),
  ['Approved', 'Not Applicable', 'Requested', 'Received', 'Outstanding', 'Rejected', 'Conditions', 'Post Close', 'Prior to Close']);

// ── tab routing ───────────────────────────────────────────────────────────
setDocs({
  empty:       {},
  collected:   { currentDocId: 'd1' },
  requested:   { status: 'requested' },
  received:    { status: 'received', currentDocId: 'd1' },
  outstanding: { status: 'outstanding' },
  rejected:    { status: 'rejected', currentDocId: 'd1' },
  approved:    { status: 'approved', currentDocId: 'd1' },
  na:          { status: 'na' },
  conds:       { status: 'conditions', currentDocId: 'd1' },
  post:        { status: 'post_close' },
  prior:       { status: 'prior_to_close' },
});
check('Processor tab: not collected, collected-but-unreviewed, and the collection statuses',
  ['empty', 'collected', 'requested', 'received', 'outstanding', 'rejected'].map(stage),
  ['processor', 'processor', 'processor', 'processor', 'processor', 'processor']);
check('Underwriting tab: every status where the processor has made a call',
  ['approved', 'na', 'conds', 'post', 'prior'].map(stage), ['uw', 'uw', 'uw', 'uw', 'uw']);

// ── the Conditions tab is a VIEW of Underwriting ──────────────────────────
setDocs({
  open1:    { status: 'conditions', conditions: [{ id: 'c1', status: 'outstanding' }] },
  received: { status: 'conditions', conditions: [{ id: 'c1', status: 'received' }] },
  cleared:  { status: 'conditions', conditions: [{ id: 'c1', status: 'cleared' }] },
  justmark: { status: 'conditions' },
  approvedWithOpen: { status: 'approved', conditions: [{ id: 'c1', status: 'outstanding' }] },
  hiddenOpen: { status: 'conditions', hidden: true, conditions: [{ id: 'c1', status: 'outstanding' }] },
  plain:    { status: 'approved' },
});
check('Conditions tab: outstanding + received show; CLEARED drops off (Mike\'s rule)',
  ['open1', 'received', 'cleared'].map(onCond), [true, true, false]);
check('a tray just marked Conditions with nothing listed still shows, so the items can be added', onCond('justmark'), true);
check('an open condition on an Approved tray still shows on Conditions', onCond('approvedWithOpen'), true);
check('hidden trays and clean trays never show on Conditions', [onCond('hiddenOpen'), onCond('plain')], [false, false]);
check('…and every one of those is still on the Underwriting tab (it always shows all reviewed docs)',
  ['open1', 'received', 'cleared', 'justmark', 'approvedWithOpen', 'plain'].map(stage),
  ['uw', 'uw', 'uw', 'uw', 'uw', 'uw']);

// ── trays reviewed before this deploy ────────────────────────────────────
setDocs({
  legacyProcApproved: { verdict: 'approved', currentDocId: 'd1' },            // was "Ready for UW"
  legacyUwApproved:   { verdict: 'approved', uwVerdict: 'approved' },          // was "Approved Docs"
  legacyConditions:   { verdict: 'approved', uwVerdict: 'conditions' },        // was "Pending Conditions"
  legacyNa:           { verdict: 'na' },
  legacyIssues:       { verdict: 'issues', currentDocId: 'd1' },
  legacyPending:      { verdict: 'pending', currentDocId: 'd1', aiVerdict: 'approved' }, // was "AI Reviewed"
});
check('legacy trays derive a status from the old verdict pair',
  ['legacyProcApproved', 'legacyUwApproved', 'legacyConditions', 'legacyNa', 'legacyIssues', 'legacyPending'].map(status),
  ['approved', 'approved', 'conditions', 'na', 'rejected', '']);
check('…and land on the right tab with no migration',
  ['legacyProcApproved', 'legacyUwApproved', 'legacyConditions', 'legacyNa', 'legacyIssues', 'legacyPending'].map(stage),
  ['uw', 'uw', 'uw', 'uw', 'processor', 'processor']);
setDocs({ x: { status: 'outstanding', verdict: 'approved', uwVerdict: 'approved' } });
check('an explicit status always beats the legacy pair', [status('x'), stage('x')], ['outstanding', 'processor']);

// ── hidden trays ─────────────────────────────────────────────────────────
setDocs({ h1: { hidden: true }, h2: { hidden: true, hiddenConfirmedAt: '2026-09-17T00:00:00Z' } });
check('an unconfirmed hide waits on the underwriter; a confirmed one leaves both tabs', [stage('h1'), stage('h2')], ['uw', 'hiddenDone']);

// ── sections ─────────────────────────────────────────────────────────────
setDocs({ loan_application: {}, term_sheet: {}, appraisal: {}, guarantor_id__g1: {}, cpl: {}, custom_1: { section: 'collateral' }, orphan: {} });
check('Loan Application + Term Sheet get their own section, first in the list',
  [run('SECTIONS[0].key'), run('SECTIONS[0].label'), sec('loan_application'), sec('term_sheet')],
  ['application', 'Application & Terms', 'application', 'application']);
check('every other tray keeps its checklist section (per-guarantor slugs resolve by base)',
  ['appraisal', 'guarantor_id__g1', 'cpl', 'custom_1', 'orphan'].map(sec),
  ['collateral', 'guarantor', 'closing', 'collateral', 'loan']);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
