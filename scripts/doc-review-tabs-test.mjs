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
 * Deploy 237.150 added Dan's four layout rules: no "Loan Documents" section, ONE
 * "Other Documents" section at the bottom, Credit Authorization per guarantor, and
 * an Underwriting tab that lists EVERY tray rather than only the reviewed ones.
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
  // _secOf calls _isOtherSlug, which lives much further down the file.
  cut('  function _isOtherSlug(slug) {', '  function _fmtMoney(') +
  cut('  var _STATUSES = [', '  var STAGE_EMPTY = {');

const ctx = {
  console, String, Array, Object,
  DOC_META: {
    loan_application: { label: 'Loan Application', section: 'loan' },
    term_sheet: { label: 'Term Sheet', section: 'loan' },
    // Deploy 237.150 -- the checklist still files these under 'loan'; the page folds
    // that into Application & Terms rather than migrating any review data.
    commitment_letter: { label: 'Loan Commitment Letter', section: 'loan' },
    letter_of_intent: { label: 'Letter of Intent', section: 'loan' },
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

// Dan's six (237.138), plus the one Jessy asked for (237.213): the processor's answer to
// a condition, which sits between the two condition kinds and the underwriter's approval.
check('Dan\'s six statuses in his order, with Condition Addressed where it belongs',
  run('_STATUSES.map(function(s){return s.label})'),
  ['Outstanding', 'Received', 'Processor Approved', 'PTD Condition', 'PTF Condition', 'Condition Addressed', 'Underwriter Approved']);
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
setDocs({ loan_application: {}, term_sheet: {}, appraisal: {}, guarantor_id__g1: {}, cpl: {},
          commitment_letter: {}, letter_of_intent: {}, custom_1: { section: 'collateral' }, other_zip_7: {},
          marked: { isCustom: true, section: 'borrower' }, orphan: {} });
check('Loan Application + Term Sheet get their own section, first in the list',
  [run('SECTIONS[0].key'), run('SECTIONS[0].label'), sec('loan_application'), sec('term_sheet')],
  ['application', 'Application & Terms', 'application', 'application']);
check('every other tray keeps its checklist section (per-guarantor slugs resolve by base)',
  ['appraisal', 'guarantor_id__g1', 'cpl'].map(sec),
  ['collateral', 'guarantor', 'closing']);

// ── Deploy 237.150 — Dan's layout rules ────────────────────────────────
check('there is no "Loan Documents" section any more',
  run('SECTIONS.filter(function(s){return s.key==="loan"}).length'), 0);
check('what filed under it renders with the application (Dan: "move this up with those")',
  ['commitment_letter', 'letter_of_intent'].map(sec), ['application', 'application']);
check('the application leads the section and the term sheet follows it',
  run('["term_sheet","loan_application"].sort(function(a,b){return (APP_SLUGS[a]||99)-(APP_SLUGS[b]||99)})'),
  ['loan_application', 'term_sheet']);
check('ONE Other Documents section, and it is last',
  [run('SECTIONS[SECTIONS.length-1].key'), run('SECTIONS[SECTIONS.length-1].label'),
   run('SECTIONS.filter(function(s){return s.key==="other"}).length')],
  ['other', 'Other Documents', 1]);
check('every non-checklist tray lands in it, whatever section it was filed under',
  ['custom_1', 'other_zip_7', 'marked'].map(sec), ['other', 'other', 'other']);
check('a tray with no section at all lands there too, not in the application',
  sec('orphan'), 'other');

// ── Dan: the UW sees every tray from one screen ─────────────────────────
setDocs({
  emptyTray:  { status: 'outstanding' },
  collected:  { status: 'received', currentDocId: 'd1' },
  procApp:    { status: 'processor_approved', currentDocId: 'd1' },
  uwApp:      { status: 'uw_approved', currentDocId: 'd1' },
  hidUnconf:  { hidden: true },
  hidDone:    { hidden: true, hiddenConfirmedAt: '2026-09-18T00:00:00Z' },
});
const bucket = (vis, hid) => run('_bucketTabs(' + JSON.stringify(vis) + ',' + JSON.stringify(hid) + ')');
const VIS = ['emptyTray', 'collected', 'procApp', 'uwApp'];
check('Underwriting lists EVERY tray — including one the processor has not approved',
  bucket(VIS, []).uw, VIS);
check('…and the Processor tab stays the narrow one',
  bucket(VIS, []).processor, ['emptyTray', 'collected']);
check('an unconfirmed hide still rides along on Underwriting; a confirmed one is out of both',
  [bucket(VIS, ['hidUnconf', 'hidDone']).uw.indexOf('hidUnconf') >= 0,
   bucket(VIS, ['hidUnconf', 'hidDone']).uw.indexOf('hidDone') >= 0], [true, false]);
check('bucketing never mutates the list it was handed', (function() {
  const before = VIS.slice(); bucket(VIS, ['hidUnconf']); return JSON.stringify(VIS) === JSON.stringify(before);
})(), true);

// ── Deploy 237.150 — what actually renders ────────────────────────────
// Three of Dan's four asks are about the LAYOUT, and _secOf cannot show any of them:
// the section headers, the single Other block and the guarantor grouping are all built
// in renderSections. So lift that too and read the HTML it returns. node --check would
// not have caught a leftover reference to the per-section Other block it replaced.
const rctx = {
  console, String, Array, Object, JSON, RegExp, isFinite, parseFloat,
  DOC_META: ctx.DOC_META,
  _review: null,
  _activeTab: 'processor',
  _showHidden: {},
  _activeCollateralProperty: 0,
  _activeGuarantor: 0,
  STAGE_EMPTY: { processor: 'nothing for the processor', uw: 'no trays', conditions: 'no conditions' },
  escHtml: (v) => String(v == null ? '' : v),
  escAttr: (v) => String(v == null ? '' : v),
  escJs:   (v) => String(v == null ? '' : v),
  // Marked so a tray is findable in the output without matching the real markup.
  renderTray: (slug) => '<!--tray:' + slug + '-->',
};
vm.createContext(rctx);
vm.runInContext(
  cut('  var APP_SLUGS = {', '  var DOC_META = {') +
  cut('  function _isOtherSlug(slug) {', '  function _fmtMoney(') +
  cut('  var _STATUSES = [', '  var STAGE_EMPTY = {') +
  cut('  function renderSections(slugs) {', '  // Deploy 236.501 \u2014 a slug is an'),
  rctx);

const render = (docs, tab) => {
  rctx._review = { docs, guarantors: [], properties: [] };
  rctx._activeTab = tab || 'processor';
  return vm.runInContext('renderSections(' + JSON.stringify(Object.keys(docs)) + ')', rctx);
};
const headings = (html) => {
  const out = []; const re = /<div class="section-title">([^<]*)<\/div>/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
};
const trayOrder = (html) => {
  const out = []; const re = /<!--tray:([^>]*)-->/g; let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
};

const FILE = {
  loan_application: {}, term_sheet: {}, commitment_letter: {}, letter_of_intent: {},
  bank_stmt_current: { section: 'borrower' },
  guarantor_id: {}, appraisal: {}, cpl: {},
  custom_1: { section: 'collateral', isCustom: true, label: 'Side letter' },
  custom_2: { section: 'borrower', isCustom: true, label: 'Misc' },
};
ctx.DOC_META.bank_stmt_current = { label: 'Bank Statement', section: 'borrower' };
rctx.DOC_META = ctx.DOC_META;
const procHtml = render(FILE, 'processor');

check('the page renders the new section order, with no "Loan Documents" heading',
  headings(procHtml), ['Application & Terms', 'Borrower Documents', 'Guarantor Documents',
    'Collateral Documents', 'Closing Documents', 'Other Documents']);
check('the application and term sheet lead, then what used to be Loan Documents',
  trayOrder(procHtml).slice(0, 4),
  ['loan_application', 'term_sheet', 'commitment_letter', 'letter_of_intent']);
check('BOTH custom trays render in the one Other section at the very bottom',
  trayOrder(procHtml).slice(-2), ['custom_1', 'custom_2']);
check('…and exactly one "Other Documents" heading exists (Dan saw two)',
  headings(procHtml).filter((h) => h === 'Other Documents').length, 1);
check('the retired per-section Other band is gone from the markup',
  [procHtml.indexOf('dr-other-block'), procHtml.indexOf('dr-other-head')], [-1, -1]);
check('"+ Add Category" survives, once, on the Other section',
  (procHtml.match(/dr-add-doc-btn/g) || []).length, 1);

// The Underwriting tab renders the same file with no Add button and no empty-state hint.
const uwHtml = render(FILE, 'uw');
check('Underwriting shows the same sections without the processor-only Add button',
  [headings(uwHtml).length, (uwHtml.match(/dr-add-doc-btn/g) || []).length], [6, 0]);

// An empty Other section still renders for the processor, so the button is reachable.
const noOther = {}; Object.keys(FILE).forEach((k) => { if (!/^custom_/.test(k)) noOther[k] = FILE[k]; });
const emptyOtherProc = render(noOther, 'processor');
check('with nothing filed as Other, the section still shows for the processor',
  [headings(emptyOtherProc).indexOf('Other Documents') >= 0, emptyOtherProc.indexOf('dr-other-empty') >= 0],
  [true, true]);
check('…and drops away entirely on Underwriting',
  headings(render(noOther, 'uw')).indexOf('Other Documents'), -1);

// ── Deploy 237.213 (Jessy, via Mike) — a condition stays a condition ─────────
// "when Dee underwrites a file, and if she marks a file as 'PTD' it goes to Conditions.
// Raissa then goes to Conditions Tab to resolve them and changes status to 'Received'
// when she updated doc or resolve condition - which leads the file back to Underwriting
// tab. If we could keep the file under Conditions or add a status maybe like 'Condition
// Addressed' and keep the files with conditions in the Conditions Tab."
//
// There were TWO doors the tray fell through: the processor picking Received, and the
// server stamping Received on upload (Dan's auto-rule). Both are walked here.
console.log('\nA condition stays on the Conditions tab until the UNDERWRITER moves it');
const { isUnderCondition, statusAfterUpload, CONDITION_STATUSES } =
  await import('../deploy/netlify/functions/_shared/doc-status.mjs');
const open = (id) => ({ id, title: 'Need ' + id, status: 'outstanding' });
const done = (id) => ({ id, title: 'Need ' + id, status: 'cleared' });
const TRAYS = {
  ptdBare:        { currentDocId: 'd', status: 'ptd_condition', verdict: 'approved', uwVerdict: 'conditions' },                 // Dee marked PTD, itemised nothing
  ptdItems:       { currentDocId: 'd', status: 'ptd_condition', verdict: 'approved', uwVerdict: 'conditions', conditions: [open('c1')] },
  addressed:      { currentDocId: 'd', status: 'condition_addressed', verdict: 'approved', uwVerdict: 'conditions' },
  addressedDone:  { currentDocId: 'd', status: 'condition_addressed', uwVerdict: 'conditions', conditions: [done('c1')] },        // Dee cleared the item, has not approved yet
  healed:         { currentDocId: 'd', status: 'received', verdict: 'pending', uwVerdict: 'conditions' },                        // an upload BEFORE this deploy
  plainReceived:  { currentDocId: 'd', status: 'received', verdict: 'pending', uwVerdict: '' },
  uwApproved:     { currentDocId: 'd', status: 'uw_approved', verdict: 'approved', uwVerdict: 'approved', conditions: [done('c1')] },
  approvedOpen:   { currentDocId: 'd', status: 'processor_approved', verdict: 'approved', conditions: [open('c2')] },
  empty:          {},
};
setDocs(TRAYS);
check('the status itself stays on Conditions — even with nothing itemised', onCond('addressed'), true);
check('...and even after the last item is cleared, until the underwriter approves',
  onCond('addressedDone'), true);
check('it is on the UNDERWRITER\'s desk, so it is not back in the processor\'s queue', stage('addressed'), 'uw');
check('a tray an upload knocked to Received BEFORE this deploy reads as Condition Addressed',
  [status('healed'), onCond('healed'), stage('healed')], ['condition_addressed', true, 'uw']);
check('...but an ordinary Received tray is untouched', [status('plainReceived'), onCond('plainReceived'), stage('plainReceived')], ['received', false, 'processor']);
check('the underwriter approving is what takes it off the tab', onCond('uwApproved'), false);
check('Mike\'s rule still holds for PTD/PTF: a bare PTD shows, so the items can be added', onCond('ptdBare'), true);

// The page and the server must agree on what "under a condition" means, tray for tray.
Object.keys(TRAYS).forEach((k) => {
  check('  page and server agree on "' + k + '"', run('_underCondition(' + JSON.stringify(k) + ')'), isUnderCondition(TRAYS[k]));
});
check('exactly three statuses mean "under a condition"', CONDITION_STATUSES, ['ptd_condition', 'ptf_condition', 'condition_addressed']);

console.log('\nDoor 1 — the server stamping Received on upload');
check('a document landing on a PTD tray is the condition being ADDRESSED', statusAfterUpload(TRAYS.ptdBare), 'condition_addressed');
check('...same when the condition is only an open item on an approved tray', statusAfterUpload(TRAYS.approvedOpen), 'condition_addressed');
check('...and a second upload keeps it there', statusAfterUpload(TRAYS.addressed), 'condition_addressed');
check('an ordinary tray is still Dan\'s auto-Received', [statusAfterUpload(TRAYS.empty), statusAfterUpload(TRAYS.plainReceived), statusAfterUpload(undefined)], ['received', 'received', 'received']);
check('an approved tray with every condition cleared is an ordinary tray again', statusAfterUpload(TRAYS.uwApproved), 'received');
const fn = (p) => fs.readFileSync(new URL('../deploy/netlify/functions/' + p, import.meta.url), 'utf8');
['loan-review-doc-upload.mjs', 'loan-review-doc-upload-chunk.mjs', 'borrower-intake-upload.mjs', '_shared/loan-review-auto-attach.mjs'].forEach((p) => {
  const t = fn(p);
  check('  ' + p + ' asks doc-status, and no longer hard-codes Received',
    [/statusAfterUpload\(/.test(t), /status\s*[:=]\s*'received'/.test(t)], [true, false]);
});
// borrower-doc-upload mints a BRAND-NEW custom tray every time; there is no prior tray
// for a condition to be on, so Received is right there and is left alone on purpose.
check('  borrower-doc-upload (always a new tray) is deliberately still Received',
  /isCustom:\s+true[\s\S]{0,300}status:\s+'received'/.test(fn('borrower-doc-upload.mjs')), true);

console.log('\nDoor 2 — the processor picking Received (the handler is RUN, not read)');
const setStatusSrc = (() => {
  const a = src.indexOf('  global.dr_setStatus = function(slug, status) {');
  const b = src.indexOf('  global.dr_setVerdict = function(slug, verdict) {', a);
  if (a < 0 || b < 0) throw new Error('marker missing: dr_setStatus');
  return src.slice(a, b);
})();
const sent = [];
const toasts = [];
ctx.global = {};
ctx._user = { email: 'raissa@slacapital.com' };
ctx._primaryHealFields = () => null;
ctx.showToast = (m) => toasts.push(m);
ctx.render = () => {};
ctx.Date = Date;
ctx.global.SLA = { LoanReviews: { patch: (id, patch) => { sent.push(patch); return { then: (ok) => { ok({ review: ctx._review }); return { catch: () => {} }; } }; } } };
ctx.global.dr_openFlagModal = () => { sent.push('FLAG_MODAL'); };
vm.runInContext(setStatusSrc, ctx);
ctx._review = { id: 'r1', docs: JSON.parse(JSON.stringify(TRAYS)) };
const setStatus = (slug, st) => { sent.length = 0; toasts.length = 0; run('global.dr_setStatus(' + JSON.stringify(slug) + ',' + JSON.stringify(st) + ')'); return sent[0] && sent[0].docs && sent[0].docs[slug]; };

let p1 = setStatus('ptdBare', 'received');
check('Raissa picks Received on Dee\'s PTD tray -> it is recorded as Condition Addressed',
  [p1.status, p1.uwVerdict, p1.conditionAddressedBy], ['condition_addressed', 'conditions', 'raissa@slacapital.com']);
check('...and she is told why, so the different label is not a surprise', /stays on the Conditions tab/.test(toasts[0] || ''), true);
p1 = setStatus('approvedOpen', 'received');
check('the same on a tray whose condition is an open item', p1.status, 'condition_addressed');
p1 = setStatus('plainReceived', 'received');
check('on a tray with NO condition, Received is just Received', [p1.status, p1.uwVerdict], ['received', '']);
p1 = setStatus('addressed', 'uw_approved');
check('the underwriter approving clears the condition marker', [p1.status, p1.uwVerdict], ['uw_approved', 'approved']);
p1 = setStatus('addressed', 'ptd_condition');
check('...or she can put it straight back under a condition', [p1.status, p1.uwVerdict], ['ptd_condition', 'conditions']);
p1 = setStatus('ptdBare', 'condition_addressed');
check('picking Condition Addressed directly does the same thing', [p1.status, p1.verdict, p1.uwVerdict], ['condition_addressed', 'approved', 'conditions']);
check('the pipeline tile never counts it as approved (that needs uwVerdict approved)', p1.uwVerdict === 'approved', false);

console.log('\nOffered only where it means something');
check('the dropdown filters Condition Addressed to trays under a condition (or already holding it)',
  /_STATUSES\.filter\(function\(st\) \{ return !st\.onlyUnderCondition \|\| st\.key === _status \|\| _underCondition\(slug\); \}\)/.test(src), true);
check('it has its own colour in the chip and the dropdown', /condition_addressed:\{ bg: '#0f766e'/.test(src), true);
const LDH = fs.readFileSync(new URL('../deploy/loan-details.html', import.meta.url), 'utf8');
check('the page is pinned to a loan-doc-review.js that HAS the status',
  Number((LDH.match(/loan-doc-review\.js\?v=(\d+)/) || [])[1]) >= 237213, true);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
