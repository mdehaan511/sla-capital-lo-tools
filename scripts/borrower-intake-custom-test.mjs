/**
 * scripts/borrower-intake-custom-test.mjs — Deploy 236.918
 *
 * Gate for borrower-added document trays (_shared/borrower-intake-custom.mjs).
 *
 * Three endpoints must agree on what a borrower-originated tray IS
 * (add-category mints it, status lists it, upload accepts it). This pins the
 * rule they share: `borrower_` slug prefix, `borrower` section, the same doc
 * shape staff custom trays have, and — critically — that staff-added custom
 * trays and checklist trays are NOT borrower trays.
 *
 * Run: node scripts/borrower-intake-custom-test.mjs
 */
import {
  BORROWER_TRAY_PREFIX, isBorrowerTray, normalizeTrayLabel,
  findBorrowerTrayByLabel, mintBorrowerTray, borrowerTrayEntries,
  isBorrowerVisibleTray, borrowerVisibleEntries,
} from '../deploy/netlify/functions/_shared/borrower-intake-custom.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('borrower intake custom-tray gate\n');

// ── Minting ───────────────────────────────────────────────────────────────
{
  const { slug, doc } = mintBorrowerTray('  Gift   letter ', { addedBy: 'b@example.com' });
  check('slug carries the borrower prefix', slug.indexOf(BORROWER_TRAY_PREFIX), 0);
  check('doc.slug matches', doc.slug, slug);
  check('label is whitespace-normalised', doc.label, 'Gift letter');
  check('lands in the Borrower section for staff', doc.section, 'borrower');
  check('flagged custom + borrowerAdded', [doc.isCustom, doc.borrowerAdded], [true, true]);
  check('never required', doc.required, false);
  check('starts pending with no AI verdict', [doc.verdict, doc.aiVerdict], ['pending', '']);
  check('conditions say manual review (no rubric to auto-approve against)', /manual review/i.test(doc.conditions), true);
  check('history records who added it', doc.history[0].by, 'b@example.com');

  // Same keys the staff _blankCustomDoc shape carries, so every renderer +
  // upload path treats it as a normal doc.
  const REQUIRED = ['slug','isCustom','label','section','conditions','required','verdict','processorNotes','naReason',
    'currentDocId','currentFilename','currentSize','currentUploadedAt','currentMimeType','aiVerdict','aiNotes',
    'aiFindings','aiExtractedEntities','aiReviewedAt','aiError','processorOverrideReason','approvedAt','approvedBy','history'];
  check('carries every field of the staff custom-tray shape', REQUIRED.filter((k) => !(k in doc)), []);

  const two = mintBorrowerTray('x');
  check('two mints never collide', two.slug === slug, false);
  check('label capped at 120 chars', mintBorrowerTray('a'.repeat(300)).doc.label.length, 120);
}

// ── What counts as the borrower's tray ────────────────────────────────────
{
  // Realistic minted slugs: borrower_<ms timestamp>_<rand>.
  const docs = {
    borrower_1788900000001_ab: { label: 'Gift Letter', createdAt: '2026-09-02', isCustom: true, borrowerAdded: true },
    borrower_1788800000000_zz: { label: 'Old portal upload', createdAt: '2026-09-01', isCustom: true },   // pre-236.918 path
    custom_1_staff:            { label: 'Internal memo', isCustom: true, section: 'loan' },
    borrower_loe:              { label: 'Borrower Letter of Explanation', section: 'borrower' },       // CHECKLIST slug, not custom
    appraisal:                 { label: 'Appraisal' },
  };
  check('minted borrower_ doc is theirs', isBorrowerTray('borrower_1788900000001_ab', docs.borrower_1788900000001_ab), true);
  check('old-portal borrower_ upload (no borrowerAdded flag) still counts', isBorrowerTray('borrower_1788800000000_zz', docs.borrower_1788800000000_zz), true);
  check('staff custom_ tray is NOT theirs', isBorrowerTray('custom_1_staff', docs.custom_1_staff), false);
  check('checklist slug is NOT theirs', isBorrowerTray('appraisal', docs.appraisal), false);
  // The LOE checklist slug starts with "borrower_" too. The first version of
  // this rule was prefix-only and this gate caught it sorting borrower_loe
  // into the borrower's own trays — the rule now matches the MINTED shape
  // (borrower_<timestamp>_<rand>), so checklist slugs never qualify.
  check('checklist borrower_loe is NOT a borrower-minted tray', isBorrowerTray('borrower_loe', docs.borrower_loe), false);
  check('a future borrower_<word> checklist slug would not qualify either', isBorrowerTray('borrower_bank_statements', { label: 'x' }), false);
  check('a missing doc is never a tray', isBorrowerTray('borrower_1788900000000_gone', undefined), false);

  const entries = borrowerTrayEntries(docs).map((e) => e.slug);
  check('entries exclude staff + checklist trays', entries.indexOf('custom_1_staff') < 0 && entries.indexOf('appraisal') < 0, true);
  check('entries are oldest first', entries, ['borrower_1788800000000_zz', 'borrower_1788900000001_ab']);
  check('entries tolerate a missing docs map', borrowerTrayEntries(undefined), []);
}

// ── Duplicate names hand back the existing tray ───────────────────────────
{
  const docs = { borrower_1788900000001_ab: { label: 'Gift Letter' }, custom_1: { label: 'Gift Letter' } };
  check('same name, case-insensitive → existing borrower slug', findBorrowerTrayByLabel(docs, 'gift letter'), 'borrower_1788900000001_ab');
  check('a staff tray with that name does not count', findBorrowerTrayByLabel({ custom_1: { label: 'Gift Letter' } }, 'Gift Letter'), '');
  check('unknown name → empty', findBorrowerTrayByLabel(docs, 'Lease'), '');
  check('blank name → empty, no throw', findBorrowerTrayByLabel(docs, '   '), '');
  check('normalizeTrayLabel collapses whitespace', normalizeTrayLabel('  a   b  '), 'a b');
}

// ── 236.920: trays the TEAM requested from the borrower ───────────────────
{
  const docs = {
    custom_1_req:              { label: 'HOA statement', isCustom: true, section: 'loan', borrowerRequested: true, borrowerRequestedAt: '2026-09-09T10:00:00Z', borrowerHint: 'Latest quarter' },
    custom_2_internal:         { label: 'Internal memo', isCustom: true, section: 'loan' },
    custom_3_unrequested:      { label: 'Was requested', isCustom: true, borrowerRequested: false },
    custom_4_hidden:           { label: 'Hidden but requested', isCustom: true, borrowerRequested: true, hidden: true },
    borrower_1788900000001_ab: { label: 'Gift Letter', createdAt: '2026-09-02', isCustom: true, borrowerAdded: true },
  };
  check('a team-requested tray is visible to the borrower', isBorrowerVisibleTray('custom_1_req', docs.custom_1_req), true);
  check('an unrequested staff tray is NOT', isBorrowerVisibleTray('custom_2_internal', docs.custom_2_internal), false);
  check('borrowerRequested:false is NOT (un-requesting hides it again)', isBorrowerVisibleTray('custom_3_unrequested', docs.custom_3_unrequested), false);
  check('a hidden tray is never shown, requested or not', isBorrowerVisibleTray('custom_4_hidden', docs.custom_4_hidden), false);
  check("the borrower's own tray is still visible", isBorrowerVisibleTray('borrower_1788900000001_ab', docs.borrower_1788900000001_ab), true);

  const vis = borrowerVisibleEntries(docs);
  check('visible entries = own + requested only', vis.map((e) => e.slug).sort(), ['borrower_1788900000001_ab', 'custom_1_req']);
  check('each entry says why it is visible', vis.map((e) => e.slug + ':' + e.kind).sort(), ['borrower_1788900000001_ab:own', 'custom_1_req:requested']);
  check('ordered by when it reached the borrower (own first here)', vis.map((e) => e.slug), ['borrower_1788900000001_ab', 'custom_1_req']);
  check('a request on a CHECKLIST slug is harmless (status dedupes it)', isBorrowerVisibleTray('appraisal', { borrowerRequested: true }), true);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
