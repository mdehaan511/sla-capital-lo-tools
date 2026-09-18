#!/usr/bin/env node
/**
 * scripts/doc-sections-test.mjs — Deploy 237.150 (Dan Austin)
 *
 * The page's own rules are gated by scripts/doc-review-tabs-test.mjs. This is the
 * SERVER half of the same two changes, and it exists because they are the kind that
 * go wrong quietly:
 *
 *   1. Sections. The Documents tab, the loan-file ZIP and the e-sign category picker
 *      each decide where a document belongs. 237.133 built the ZIP folders to mirror
 *      the tab; retiring "Loan Documents" would have silently pulled the commitment
 *      letter (and the LOI, revised terms, exception request) into a "6 - Other"
 *      folder. displaySection() is now the one mapping, and this checks all three
 *      surfaces agree — including that no stored `section` had to be rewritten.
 *
 *   2. Credit Authorization became a per-guarantor tray. The risk is not the mint,
 *      it is the MIGRATION: an existing shared tray holding a signed form must move
 *      to Guarantor 1 with its documents, not be dropped or duplicated.
 *
 *      Deploy 237.152 (Mike: "Each guarantor should sign their own credit auth"):
 *      237.150 had exempted this slug so a jointly-signed form passed in everyone's
 *      tray. It does not. The application already writes one prequal-credit-auth page
 *      PER SIGNER and emails each guarantor their own link, so the tray rule and what
 *      the app produces now say the same thing -- which is what these checks pin.
 *
 * Run: node scripts/doc-sections-test.mjs
 */
import {
  SECTIONS, displaySection, GUARANTOR_PER_PERSON, getChecklist, stripTraySuffix,
} from '../deploy/netlify/functions/_shared/loan-review-checklists.mjs';
import {
  adoptGuarantorsFromLoan, expandGuarantorTrays, guarantorNote, isPerPersonSlug,
} from '../deploy/netlify/functions/_shared/guarantor-trays.mjs';
import { zipFolderFor } from '../deploy/netlify/functions/_shared/doc-naming.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};

// ── sections ───────────────────────────────────────────────────────────────
console.log('\nSections (_shared/loan-review-checklists.mjs)');
check('the on-screen order, with Other last', SECTIONS.map((s) => s.key),
  ['application', 'borrower', 'guarantor', 'collateral', 'closing', 'other']);
check('"Loan Documents" is gone', SECTIONS.filter((s) => s.key === 'loan').length, 0);

check('a checklist entry still filed under \'loan\' renders under the application',
  displaySection('loan', 'commitment_letter'), 'application');
check('the sections that stayed are untouched',
  ['borrower', 'guarantor', 'collateral', 'closing'].map((s) => displaySection(s, 'x')),
  ['borrower', 'guarantor', 'collateral', 'closing']);
check('a non-checklist tray goes to Other whatever section it was filed under',
  [displaySection('collateral', 'custom_1758'), displaySection('borrower', 'other_zip_3')],
  ['other', 'other']);
check('an unknown or missing section goes to Other, not into the application',
  [displaySection('', 'appraisal'), displaySection('made_up', 'appraisal')], ['other', 'other']);

// The checklists themselves must not have been rewritten — displaySection is a
// DISPLAY mapping, so every review already on disk keeps working untouched.
const dscr = getChecklist('dscr');
const stillLoan = dscr.filter((d) => d.section === 'loan').map((d) => d.slug);
assert('the DSCR checklist still files those entries under \'loan\' (no data migration)',
  stillLoan.includes('commitment_letter') && stillLoan.includes('loan_application'),
  'section: \'loan\' entries found: ' + JSON.stringify(stillLoan));
check('…and every one of them displays under the application',
  stillLoan.map((s) => displaySection('loan', s)), stillLoan.map(() => 'application'));

// ── the loan-file ZIP follows the same map ────────────────────────────────
console.log('\nLoan-file ZIP folders (_shared/doc-naming.mjs)');
const review = { id: 'r1', loanType: 'dscr', guarantors: [], guarantorNames: [], docs: {
  commitment_letter: { section: 'loan' },
  appraisal:         { section: 'collateral' },
  cpl:               { section: 'closing' },
  custom_9:          { section: 'borrower', isCustom: true, label: 'Signed side letter' },
} };
const folder = (slug) => zipFolderFor(review, slug, review.docs[slug], '');
check('the commitment letter files with the application, at the top of the ZIP',
  folder('commitment_letter'), '1 - Application & Terms');
check('the other sections keep their place',
  [folder('appraisal'), folder('cpl')], ['4 - Collateral', '5 - Closing']);
check('a non-checklist doc gets the one Other folder, last',
  folder('custom_9'), '6 - Other');
assert('every ZIP folder number matches the section\'s place on the page',
  SECTIONS.every((s, i) => {
    const f = zipFolderFor(review, 'probe', { section: s.key }, '');
    return f.split(' - ')[0] === String(i + 1) || s.key === 'other';
  }), 'a folder number drifted from the SECTIONS order');

// ── Credit Authorization is per guarantor ─────────────────────────────────
console.log('\nPer-guarantor Credit Authorization (_shared/guarantor-trays.mjs)');
assert('credit_authorization is collected per person now', isPerPersonSlug('credit_authorization'));
check('…and the rest of the list is unchanged',
  GUARANTOR_PER_PERSON.filter((s) => s !== 'credit_authorization'),
  ['guarantor_id', 'proof_of_citizenship', 'credit_report', 'guarantor_background_check',
   'ofac_personal', 'guarantor_loe', 'pfs']);

const note = guarantorNote('Jane Doe', 'Guarantor 2');
assert('a guarantor\'s tray wants THAT guarantor\'s document — no shared-form exemption',
  /wrong tray/.test(note) && /Jane Doe/.test(note) && !/SINGLE authorization/.test(note), note);
assert('every per-person slug gets the same note, credit auth included',
  [guarantorNote('Jane Doe', 'Guarantor 2'), guarantorNote('A', 'Guarantor 1')]
    .every((n) => n.indexOf(' THIS TRAY IS FOR ONE GUARANTOR ONLY: ') === 0 && /wrong tray/.test(n)));
check('the note is keyed off the base slug, suffix or not', stripTraySuffix('credit_authorization__g1'), 'credit_authorization');

// The rubric the AI grades against must say the same thing as the application.
const caRubric = (getChecklist('dscr').find((d) => d.slug === 'credit_authorization') || {}).conditions || '';
assert('the checklist no longer says "signed by all guarantors"',
  !/by all guarantors|by every guarantor/i.test(caRubric), caRubric);
assert('…it says each guarantor signs their own',
  /signs their OWN authorization/.test(caRubric) && /signature from one guarantor does not cover another/i.test(caRubric), caRubric);
// The rubrics are copied across three files as single-quoted literals, so an apostrophe
// in one is a parse error, not a typo (237.152 hit exactly that). Keep them plain.
assert('no apostrophe can sneak back into the credit-auth rubric',
  caRubric.indexOf("'") < 0, caRubric);
assert('RTL says it too', (() => {
  const r = (getChecklist('rtl').find((d) => d.slug === 'credit_authorization') || {}).conditions || '';
  return r === caRubric;
})(), 'the two checklists disagree on the credit-auth rubric');

// A real review that already holds a signed credit auth in the shared tray.
const r = {
  id: 'r2', loanType: 'dscr', guarantors: [], docs: {
    credit_authorization: {
      slug: 'credit_authorization', section: 'guarantor', conditions: 'Signed by every guarantor.',
      currentDocId: 'doc-ca', currentFilename: 'Credit Auth.pdf', verdict: 'approved',
      documents: [{ docId: 'doc-ca', filename: 'Credit Auth.pdf' }], history: [],
    },
  },
};
const adopted = adoptGuarantorsFromLoan(r, ['Mike Borrower', 'Jane Doe']);
check('a second guarantor is adopted', [adopted.adopted, adopted.to], [true, 2]);
check('the existing shared credit auth MOVES to Guarantor 1 (nothing is dropped)',
  [!!r.docs['credit_authorization__g0'], !!r.docs.credit_authorization,
   adopted.migrated.indexOf('credit_authorization') >= 0], [true, false, true]);
check('…keeping its document, its filename and its verdict',
  [r.docs['credit_authorization__g0'].currentDocId, r.docs['credit_authorization__g0'].currentFilename,
   r.docs['credit_authorization__g0'].verdict, r.docs['credit_authorization__g0'].documents.length],
  ['doc-ca', 'Credit Auth.pdf', 'approved', 1]);
assert('…and says in its history why it moved',
  (r.docs['credit_authorization__g0'].history || []).some((h) => h.action === 'guarantor_adopt'));

const added = expandGuarantorTrays(r);
assert('guarantor 2 gets their own credit auth tray', added.includes('credit_authorization__g1'),
  'added: ' + JSON.stringify(added));
check('the minted tray is filed to the right person',
  [r.docs['credit_authorization__g1'].guarantorIndex, r.docs['credit_authorization__g1'].guarantorName],
  [1, 'Jane Doe']);
assert('…carrying the per-person rubric, naming her',
  /THIS TRAY IS FOR ONE GUARANTOR ONLY: Jane Doe/.test(r.docs['credit_authorization__g1'].conditions) &&
  /signs their OWN authorization/.test(r.docs['credit_authorization__g1'].conditions),
  r.docs['credit_authorization__g1'].conditions);
assert('a re-run adds nothing (idempotent — it runs on every page open)',
  expandGuarantorTrays(r).length === 0);
check('nothing is left in the shared bucket, so the "All guarantors — shared" group stops rendering',
  Object.keys(r.docs).filter((s) => (r.docs[s].guarantorIndex == null) && r.docs[s].section === 'guarantor'), []);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
