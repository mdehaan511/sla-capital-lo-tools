/**
 * scripts/doc-review-tabs-test.mjs — Deploy 237.138
 *
 * Gate for the doc review's status model (deploy/loan-doc-review.js). The page is one
 * big IIFE with no exports, so the test LIFTS the real status / stage block out of the
 * file and runs it in a vm: tab routing is checked against the code that ships, not a
 * copy of it. If the block is renamed the markers below fail loudly.
 *
 * Statuses are Dan Austin's list (237.138): Outstanding / Received / Processor
 * Approved / PTD Condition / PTF Condition / Underwriter Approved.
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

check('Dan\'s six statuses, in his order',
  run('_STATUSES.map(function(s){return s.label})'),
  ['Outstanding', 'Received', 'Processor Approved', 'PTD Condition', 'PTF Condition', 'Underwriter Approved']);
check('Not Applicable survives only as a legacy option', run('_LEGACY_STATUSES.map(function(s){return s.label})'), ['Not Applicable']);

// ── Dan's two behavioural notes ───────────────────────────────────────────
setDocs({
  empty:     {},
  withDoc:   { currentDocId: 'd1' },
  multiDoc:  { documents: [{ docId: 'd1', hidden: false }] },
  allHidden: { documents: [{ docId: 'd1', hidden: true }] },
});
check('Outstanding is the base status until a document is uploaded',
  [status('empty'), status('allHidden')], ['outstanding', 'outstanding']);
check('a tray holding a document reads Received even before anyone sets it',
  [status('withDoc'), status('multiDoc')], ['received', 'received']);

// ── tab routing ───────────────────────────────────────────────────────────
setDocs({
  outstanding: { status: 'outstanding' },
  received:    { status: 'received', currentDocId: 'd1' },
  procApp:     { status: 'processor_approved', currentDocId: 'd1' },
  ptd:         { status: 'ptd_condition', currentDocId: 'd1' },
  ptf:         { status: 'ptf_condition', currentDocId: 'd1' },
  uwApp:       { status: 'uw_approved', currentDocId: 'd1' },
  legacyNa:    { status: 'na' },
});
check('Processor tab: Outstanding + Received (not collected, or collected and unreviewed)',
  ['outstanding', 'received'].map(stage), ['processor', 'processor']);
check('Underwriting tab: everything the processor has made a call on',
  ['procApp', 'ptd', 'ptf', 'uwApp', 'legacyNa'].map(stage), ['uw', 'uw', 'uw', 'uw', 'uw']);

// ── the Conditions tab is a VIEW of Underwriting ──────────────────────────
setDocs({
  ptdOpen:   { status: 'ptd_condition', conditions: [{ id: 'c1', status: 'outstanding', priorTo: 'docs' }] },
  ptfRecv:   { status: 'ptf_condition', conditions: [{ id: 'c1', status: 'received', priorTo: 'funding' }] },
  cleared:   { status: 'ptd_condition', conditions: [{ id: 'c1', status: 'cleared', priorTo: 'docs' }] },
  justmark:  { status: 'ptf_condition' },
  approvedWithOpen: { status: 'processor_approved', conditions: [{ id: 'c1', status: 'outstanding' }] },
  hiddenOpen: { status: 'ptd_condition', hidden: true, conditions: [{ id: 'c1', status: 'outstanding' }] },
  plain:     { status: 'uw_approved' },
});
check('Conditions tab: outstanding + received show; CLEARED drops off (Mike\'s rule)',
  ['ptdOpen', 'ptfRecv', 'cleared'].map(onCond), [true, true, false]);
check('a tray just marked PTD / PTF with nothing listed still shows, so the items can be added', onCond('justmark'), true);
check('an open condition on an approved tray still shows on Conditions', onCond('approvedWithOpen'), true);
check('hidden trays and clean trays never show on Conditions', [onCond('hiddenOpen'), onCond('plain')], [false, false]);
check('…and every one of those is still on the Underwriting tab (it always shows all reviewed docs)',
  ['ptdOpen', 'ptfRecv', 'cleared', 'justmark', 'approvedWithOpen', 'plain'].map(stage),
  ['uw', 'uw', 'uw', 'uw', 'uw', 'uw']);

// ── trays reviewed before this deploy ────────────────────────────────────
setDocs({
  legacyProcApproved: { verdict: 'approved', currentDocId: 'd1' },
  legacyUwApproved:   { verdict: 'approved', uwVerdict: 'approved' },
  legacyCondDocs:     { verdict: 'approved', uwVerdict: 'conditions', conditions: [{ id: 'c1', status: 'outstanding', priorTo: 'docs' }] },
  legacyCondFunding:  { verdict: 'approved', uwVerdict: 'conditions', conditions: [{ id: 'c1', status: 'outstanding', priorTo: 'funding' }] },
  legacyNa:           { verdict: 'na' },
  legacyIssues:       { verdict: 'issues', currentDocId: 'd1' },
  legacyCollected:    { verdict: 'pending', currentDocId: 'd1', aiVerdict: 'approved' },
  legacyEmpty:        { verdict: 'pending' },
});
check('legacy trays derive a status; an old conditions tray picks PTD vs PTF from its own items',
  ['legacyProcApproved', 'legacyUwApproved', 'legacyCondDocs', 'legacyCondFunding', 'legacyNa', 'legacyIssues', 'legacyCollected', 'legacyEmpty'].map(status),
  ['processor_approved', 'uw_approved', 'ptd_condition', 'ptf_condition', 'na', 'outstanding', 'received', 'outstanding']);
check('…and land on the right tab with no migration',
  ['legacyProcApproved', 'legacyUwApproved', 'legacyCondDocs', 'legacyNa', 'legacyIssues', 'legacyCollected'].map(stage),
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
