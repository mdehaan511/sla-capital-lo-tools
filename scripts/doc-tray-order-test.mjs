/**
 * doc-tray-order-test.mjs — Deploy 237.228
 *
 * Dan's Slack list for the Documents tab: drop the Insurance Invoice tray,
 * put the Borrower / Guarantor / Collateral / Closing trays in a named order,
 * and add a "Post Close" section holding the executed documents, the final HUD,
 * the recorded security instrument and the final title policy.
 *
 * Two things this has to hold onto:
 *
 *  1. The ORDER lives in TRAY_ORDER, not in the checklist arrays. A review
 *     snapshots its trays when it is created and the page lists them with
 *     Object.keys(review.docs) — creation order, frozen for every review that
 *     already exists. Sorting by TRAY_ORDER is what moves the trays on the
 *     reviews Dan is actually looking at.
 *  2. loan-doc-review.js carries its own copy of SECTIONS, DOC_META and
 *     TRAY_ORDER (no build step, no import). Copies drift. These checks fail
 *     when they do.
 *
 *   node scripts/doc-tray-order-test.mjs
 */
import { readFileSync } from 'node:fs';
import {
  SECTIONS, TRAY_ORDER, DSCR_DOCS, RTL_DOCS, GUC_DOCS, GUC_CONSTRUCTION_DOCS,
  RETIRED_SLUGS, PORTFOLIO_EXTRA_COLLATERAL, findCategory, getChecklist, displaySection,
} from '../deploy/netlify/functions/_shared/loan-review-checklists.mjs';

const CLIENT = readFileSync('deploy/loan-doc-review.js', 'utf8');
const NAMING = readFileSync('deploy/netlify/functions/_shared/doc-naming.mjs', 'utf8');

let fails = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '\n         ' + detail));
  if (!ok) fails++;
}
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  check(name, a === b, a === b ? '' : 'got  ' + a + '\n         want ' + b);
}
// The slugs a checklist files under one section, in the order the array holds them.
const sec = (list, key) => list.filter((d) => d.section === key).map((d) => d.slug);
// A literal array of strings out of the client file (it has no exports to import).
function clientArray(name) {
  const m = new RegExp('var ' + name + ' = \\[([\\s\\S]*?)\\n  \\];').exec(CLIENT);
  if (!m) throw new Error('could not find ' + name + ' in loan-doc-review.js');
  return m[1].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    .match(/'[^']+'/g).map((s) => s.slice(1, -1));
}

console.log('Dan\'s order — DSCR');
{
  eq('borrower', sec(DSCR_DOCS, 'borrower'), [
    'articles_of_organization', 'certificate_of_good_standing', 'ein_letter', 'ofac_entity',
    'operating_agreement', 'bank_stmt_current', 'bank_stmt_previous', 'voided_check_ach',
    'track_record_reo',
    // not on Dan's list — kept, after the ones that are
    'entity_background_check', 'foreign_entity_registration']);
  eq('guarantor', sec(DSCR_DOCS, 'guarantor'), [
    'guarantor_id', 'credit_authorization', 'credit_report', 'guarantor_background_check',
    'ofac_personal', 'pfs', 'proof_of_citizenship']);
  eq('collateral leads with Dan\'s six', sec(DSCR_DOCS, 'collateral').slice(0, 5), [
    'appraisal', 'psa', 'evidence_of_insurance', 'proof_of_insurance_pif', 'flood_certificate']);
  eq('closing', sec(DSCR_DOCS, 'closing'), [
    'title_eo_insurance', 'emd_receipt', 'cpl', 'tax_certificate', 'title_commitment',
    'wire_instructions', 'prelim_settlement', 'borrower_closing_funds_receipt',
    'title_escrow_contact', 'payoff_demand', 'invoice', 'original_doc_tracking']);
  eq('post close', sec(DSCR_DOCS, 'post_close'), [
    'executed_closing_documents', 'executed_ach_form', 'executed_deed', 'closing_w9',
    'final_hud', 'recorded_security_instrument', 'final_title_policy']);
}

console.log('Dan\'s order — RTL');
{
  eq('borrower', sec(RTL_DOCS, 'borrower'), [
    'articles_of_organization', 'certificate_of_good_standing', 'ein_or_w9', 'ofac_entity',
    'operating_agreement', 'bank_stmt_current', 'bank_stmt_previous', 'voided_check',
    'track_record',
    'entity_background_check', 'borrower_loe']);
  eq('guarantor', sec(RTL_DOCS, 'guarantor'), [
    'guarantor_id', 'credit_authorization', 'credit_report', 'guarantor_background_check',
    'ofac_personal', 'pfs', 'guarantor_loe']);
  eq('collateral leads with Dan\'s six (BPO, then the appraisal that stands in for it)',
    sec(RTL_DOCS, 'collateral').slice(0, 7), [
      'bpo_valuation', 'appraisal', 'psa', 'assignment_agreement', 'evidence_of_insurance',
      'proof_of_insurance_pif', 'flood_certificate']);
  eq('closing', sec(RTL_DOCS, 'closing'), [
    'title_eo_insurance', 'emd_receipt', 'cpl', 'tax_certificate', 'title_commitment',
    'wire_instructions', 'prelim_settlement', 'borrower_closing_funds_receipt',
    'payoff_demand', 'draw_wire_form', 'original_doc_tracking']);
  eq('post close', sec(RTL_DOCS, 'post_close'), [
    'executed_closing_documents', 'executed_ach_form', 'executed_deed', 'closing_w9',
    'final_hud', 'recorded_security_instrument', 'final_title_policy']);
  // GUC inherits RTL and swaps the BPO for a full as-completed appraisal (236.744).
  eq('GUC leads collateral with the appraisal', sec(GUC_DOCS, 'collateral').slice(0, 1), ['appraisal']);
  check('GUC still carries the construction docs',
    GUC_CONSTRUCTION_DOCS.every((d) => GUC_DOCS.some((x) => x.slug === d.slug)));
}

console.log('the Post Close section');
{
  const keys = SECTIONS.map((s) => s.key);
  eq('sits between Closing and Other', keys, [
    'application', 'borrower', 'guarantor', 'collateral', 'closing', 'post_close', 'other']);
  check('displaySection passes it through', displaySection('post_close', 'final_hud') === 'post_close');
  check('the loan-file ZIP has a folder name for it', /post_close: 'Post Close'/.test(NAMING));
  check('the page mirrors it', /\{ key: 'post_close',\s*label: 'Post Close'/.test(CLIENT));
  check('the move-document picker offers it',
    /SEC_ORDER = \[[^\]]*'post_close'\]/.test(CLIENT) && /post_close: 'Post Close'/.test(CLIENT));
  for (const slug of ['executed_closing_documents', 'executed_ach_form', 'executed_deed',
                      'closing_w9', 'final_hud', 'recorded_security_instrument', 'final_title_policy']) {
    check(slug + ' renders under Post Close on the page',
      new RegExp(slug + ":\\s*\\{[^}]*section: 'post_close'").test(CLIENT));
  }
  for (const slug of ['recorded_security_instrument', 'final_title_policy']) {
    const d = findCategory(slug);
    check(slug + ' is storage-only (filed after funding, not underwritten)',
      !!d && d.optional === true && d.noReview === true);
    check(slug + ' is on BOTH checklists', DSCR_DOCS.some((x) => x.slug === slug) && RTL_DOCS.some((x) => x.slug === slug));
  }
}

console.log('the Insurance Invoice tray is retired, not deleted');
{
  check('off every checklist',
    !['dscr', 'rtl', 'guc'].some((t) => getChecklist(t).some((d) => d.slug === 'insurance_invoice')));
  check('a portfolio review stops minting one per property',
    !PORTFOLIO_EXTRA_COLLATERAL.includes('insurance_invoice'));
  check('named as retired', RETIRED_SLUGS.includes('insurance_invoice'));
  const d = findCategory('insurance_invoice');
  check('a legacy tray still resolves its label and section (so the ZIP still files it)',
    !!d && d.label === 'Insurance Invoice' && d.section === 'collateral');
  check('the page keeps a legacy tray that HOLDS a document',
    /RETIRED_SLUGS\[String\(s\)\.replace\(\/__\[pg\]\\d\+\$\/, ''\)\]\) return true;\s*\n\s*return _trayHasDoc\(docs\[s\]\);/.test(CLIENT));
  check('the page drops an empty one', /var RETIRED_SLUGS = \{ insurance_invoice: 1 \}/.test(CLIENT));
}

console.log('TRAY_ORDER is what actually orders the page');
{
  eq('the page\'s copy matches the shared one', clientArray('TRAY_ORDER'), TRAY_ORDER);
  check('no duplicates', new Set(TRAY_ORDER).size === TRAY_ORDER.length);
  const rank = {};
  TRAY_ORDER.forEach((s, i) => { rank[s] = i + 1; });
  const all = [...DSCR_DOCS, ...RTL_DOCS, ...GUC_CONSTRUCTION_DOCS].map((d) => d.slug);
  const unlisted = [...new Set(all)].filter((s) => !rank[s]);
  check('every checklist slug is in it', unlisted.length === 0, 'missing: ' + unlisted.join(', '));
  // The arrays are written in the order they render; TRAY_ORDER must agree, or
  // reading the checklist would tell you something the page does not do.
  for (const [name, list] of [['DSCR', DSCR_DOCS], ['RTL', RTL_DOCS], ['GUC', GUC_DOCS]]) {
    for (const s of SECTIONS) {
      const written = sec(list, s.key);
      if (written.length < 2) continue;
      const sorted = written.slice().sort((a, b) => rank[a] - rank[b]);
      eq(name + ' ' + s.key + ': the array reads the way the page renders', written, sorted);
    }
  }
  // The page applies it to EVERY section, not just Application & Terms.
  check('the page sorts every section by it',
    /Object\.keys\(bySection\)\.forEach\(function\(k\) \{ bySection\[k\]\.sort\(_byTrayOrder\); \}\);/.test(CLIENT));
  check('hidden trays are ordered the same way',
    /Object\.keys\(hiddenBySection\)\.forEach\(function\(k\) \{ hiddenBySection\[k\]\.sort\(_byTrayOrder\); \}\);/.test(CLIENT));
  check('the application and term sheet still lead their section',
    /if \(APP_SLUGS\[base\]\) return APP_SLUGS\[base\];/.test(CLIENT));
  check('an unlisted tray sorts after every listed one',
    /return 1000 \+ \(TRAY_RANK\[base\] \|\| 900\);/.test(CLIENT));
}

console.log('a review that already exists gets the new order');
{
  // What the page does: take the review's trays in CREATION order and sort them.
  // A 236-era DSCR review was created in the old checklist order, so this is the
  // case that matters — the reorder is worth nothing if it only lands on new files.
  const rank = {};
  TRAY_ORDER.forEach((s, i) => { rank[s] = i + 1; });
  const APP = { loan_application: 1, term_sheet: 2 };
  const trayRank = (slug) => {
    const base = slug.replace(/__[pg]\d+$/, '');
    return APP[base] ? APP[base] : 1000 + (rank[base] || 900);
  };
  const created = ['operating_agreement', 'articles_of_organization', 'certificate_of_good_standing',
    'entity_background_check', 'ofac_entity', 'ein_letter', 'track_record_reo',
    'bank_stmt_current', 'bank_stmt_previous', 'voided_check_ach', 'custom_1758000000_ab12'];
  eq('an old review\'s Borrower section re-sorts into Dan\'s order',
    created.slice().sort((a, b) => trayRank(a) - trayRank(b)), [
      'articles_of_organization', 'certificate_of_good_standing', 'ein_letter', 'ofac_entity',
      'operating_agreement', 'bank_stmt_current', 'bank_stmt_previous', 'voided_check_ach',
      'track_record_reo', 'entity_background_check', 'custom_1758000000_ab12']);
  // Per-guarantor and per-property trays sort by their BASE slug, and two trays
  // that share a base keep the order they were created in (1, then 2).
  const perG = ['pfs__g0', 'guarantor_id__g0', 'guarantor_id__g1', 'credit_report__g0'];
  eq('per-guarantor trays sort by base slug and keep the person order within it',
    perG.slice().sort((a, b) => trayRank(a) - trayRank(b)),
    ['guarantor_id__g0', 'guarantor_id__g1', 'credit_report__g0', 'pfs__g0']);
  eq('Application & Terms still leads with the application and term sheet',
    ['commitment_letter', 'term_sheet', 'letter_of_intent', 'loan_application']
      .sort((a, b) => trayRank(a) - trayRank(b)),
    ['loan_application', 'term_sheet', 'letter_of_intent', 'commitment_letter']);
}

console.log('the browser is served the new file');
{
  const LDH = readFileSync('deploy/loan-details.html', 'utf8');
  check('loan-details.html pins a loan-doc-review.js that HAS the new order',
    Number((LDH.match(/loan-doc-review\.js\?v=(\d+)/) || [])[1]) >= 237228);
}

console.log('the page\'s section list still mirrors the shared one');
{
  const m = /var SECTIONS = \[([\s\S]*?)\n  \];/.exec(CLIENT);
  const keys = [...m[1].matchAll(/key: '([a-z_]+)'/g)].map((x) => x[1]);
  const labels = [...m[1].matchAll(/label: '([^']+)'/g)].map((x) => x[1].trim());
  eq('same keys, same order', keys, SECTIONS.map((s) => s.key));
  eq('same labels', labels, SECTIONS.map((s) => s.label.trim()));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
