/**
 * scripts/doc-naming-test.mjs — Deploy 237.133
 *
 * Gate for the shared document namer (deploy/netlify/functions/_shared/
 * doc-naming.mjs): "{Doc Type} - {address | entity | borrower}[ - {Mon YYYY}]",
 * modeled on the 11415 Prairie Ct SE loan file that prompted it.
 *
 * Run: node scripts/doc-naming-test.mjs
 */
import {
  canonicalDocName, applyCanonicalDocName, docSubject, docTypeLabel, statementPeriod,
  zipFolderFor, zipNameFor, baseSlugOf,
} from '../deploy/netlify/functions/_shared/doc-naming.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const tray = (docId, filename, extra) => Object.assign({ currentDocId: docId, currentFilename: filename, documents: [{ docId, filename, hidden: false }] }, extra || {});
function makeReview() {
  return {
    id: 'r1', address: '11415 Prairie Ct SE, Olympia, WA, 98513', borrowerName: 'Jeremy Wilson',
    guarantors: [{ index: 0, name: 'Jeremy Wilson' }, { index: 1, name: 'Dilma Herrera Aguilar' }],
    sourceLoanSnapshot: { address: '11415 Prairie Ct SE, Olympia, WA, 98513', vestingLLCs: [{ name: 'Imagine Investors LLC' }] },
    docs: {
      bank_stmt_current: tray('d1', 'Statement_082026_8251.pdf'),
      bank_stmt_previous: tray('d2', 'stmt.pdf'),
      psa: tray('d3', 'Prairie PSA.pdf'),
      tax_certificate: tray('d4', 'Tax Certificate - RONALD E & RUTH JO MARKS - Closing.pdf'),
      articles_of_organization: tray('d5', 'articles.pdf'),
      guarantor_id__g1: tray('d6', 'IMG_2044.jpg', { guarantorIndex: 1, guarantorName: 'Dilma Herrera Aguilar', label: 'Guarantor ID' }),
      ofac_personal: tray('d7', 'ofac.pdf'),
      credit_authorization: tray('d8', 'auth.pdf'),
      custom_1: tray('d9', 'Assessor Map.pdf', { isCustom: true, label: 'Assessor Map', section: 'collateral' }),
      custom_2: tray('d10', 'Untitled spreadsheet - Sheet1.pdf', { isCustom: true, label: 'Budget / Draw Schedule' }),
      loan_application: tray('d11', 'Signed Loan Application - 11415 Prairie Ct SE.pdf'),
      cpl: tray('d12', 'cpl.pdf'),
      track_record: tray('d13', 'Untitled spreadsheet - Track Record.pdf'),
    },
  };
}

console.log('document naming gate\n');
let r = makeReview();

check('statement month from the statement END date; a close in the first days of a month is the previous month',
  [statementPeriod('2026-08-31'), statementPeriod('2026-09-02'), statementPeriod('2026-01-05'), statementPeriod('2026-09-15'), statementPeriod('nope')],
  ['Aug 2026', 'Aug 2026', 'Dec 2025', 'Sep 2026', '']);
check('bank statement: holder the AI read, matched back to the roster, + month',
  canonicalDocName(r, 'bank_stmt_current', 'd1', { entities: { borrowerName: 'JEREMY D WILSON', documentDate: '2026-08-31' } }),
  'Bank Statement - Jeremy Wilson - Aug 2026.pdf');
check('bank statement in the ENTITY name → the entity as the loan spells it',
  canonicalDocName(r, 'bank_stmt_previous', 'd2', { entities: { llcName: 'IMAGINE INVESTORS, L.L.C.'.replace(/L\.L\.C\./, 'LLC'), documentDate: '2026-07-31' } }),
  'Bank Statement - Imagine Investors LLC - Jul 2026.pdf');
check('bank statement before any review: entity, no month yet (the review adds it)',
  canonicalDocName(r, 'bank_stmt_current', 'd1', { entities: {}, ignoreTray: true }), 'Bank Statement - Imagine Investors LLC.pdf');
check('collateral → the property street address', canonicalDocName(r, 'psa', 'd3'), 'Purchase Agreement - 11415 Prairie Ct SE.pdf');
check('closing doc is named for the PROPERTY, never the seller the AI read off the page',
  canonicalDocName(r, 'tax_certificate', 'd4', { entities: { llcName: 'RONALD E & RUTH JO MARKS' } }), 'Tax Certificate - 11415 Prairie Ct SE.pdf');
check('entity doc → the vesting entity until the Articles are reviewed',
  canonicalDocName(r, 'articles_of_organization', 'd5'), 'Articles of Organization - Imagine Investors LLC.pdf');
r.docs.articles_of_organization.aiReviewedAt = '2026-09-10T00:00:00Z';
r.docs.articles_of_organization.aiExtractedEntities = { llcName: 'Imagine Investors, LLC' };
check('…then the Articles are the entity name of record (for every entity doc)',
  [canonicalDocName(r, 'articles_of_organization', 'd5'), docSubject(r, 'bank_stmt_current', r.docs.bank_stmt_current, {})],
  ['Articles of Organization - Imagine Investors, LLC.pdf', 'Imagine Investors, LLC']);
r = makeReview();
check('per-guarantor tray → that guarantor; the extension follows the file', canonicalDocName(r, 'guarantor_id__g1', 'd6'), 'Guarantor ID - Dilma Herrera Aguilar.jpg');
check('shared guarantor tray: the person the AI read, as the roster spells them',
  canonicalDocName(r, 'ofac_personal', 'd7', { entities: { borrowerName: 'Jeremy David Wilson' } }), 'OFAC Check (Personal) - Jeremy Wilson.pdf');
check('shared guarantor tray, nobody read, two guarantors → both', canonicalDocName(r, 'credit_authorization', 'd8'), 'Credit Authorization - Jeremy Wilson & Dilma Herrera Aguilar.pdf');
check('custom tray: its own label; slashes cleaned; no section → the property',
  [canonicalDocName(r, 'custom_1', 'd9'), canonicalDocName(r, 'custom_2', 'd10')],
  ['Assessor Map - 11415 Prairie Ct SE.pdf', 'Budget Draw Schedule - 11415 Prairie Ct SE.pdf']);
check('track record is the sponsor\'s; loan + closing docs the property',
  [canonicalDocName(r, 'track_record', 'd13', { entities: { borrowerName: 'Jeremy Wilson' } }), canonicalDocName(r, 'loan_application', 'd11'), canonicalDocName(r, 'cpl', 'd12')],
  ['Track Record - Jeremy Wilson.pdf', 'Loan Application - 11415 Prairie Ct SE.pdf', 'Closing Protection Letter - 11415 Prairie Ct SE.pdf']);
check('type labels + base slug', [docTypeLabel('bank_stmt_previous', {}), docTypeLabel('guarantor_id__g0', { label: 'ID for each Guarantor — Jeremy' }), docTypeLabel('title_eo_insurance', {}), baseSlugOf('appraisal__p2')],
  ['Bank Statement', 'Guarantor ID', 'Title E&O Insurance', 'appraisal']);
check('the tray\'s OWN label wins over the cross-checklist lookup; a portfolio suffix is dropped',
  [docTypeLabel('term_sheet', { label: 'Rate Sheet' }), docTypeLabel('appraisal__p1', { label: 'Appraisal — Property 2' }), docTypeLabel('emd_receipt', {})],
  ['Rate Sheet', 'Appraisal', 'EMD Receipt']);

// ── the real Prairie Ct shapes: both guarantors' documents sat in guarantor 1's tray ─
{
  const p = makeReview();
  p.docs.guarantor_id__g0 = { currentDocId: 'j', currentFilename: 'a.pdf', guarantorIndex: 0, guarantorName: 'Jeremy Wilson', section: 'guarantor', label: 'Guarantor ID (Driver’s License or Passport)',
    documents: [{ docId: 'j', filename: 'a.pdf', aiExtractedEntities: { borrowerName: 'Jeremy David Wilson' } }, { docId: 'dl', filename: 'b.pdf', aiExtractedEntities: { borrowerName: 'Dilma Herrera Aguilar' } }] };
  check('the person ON the document wins over the tray it was dropped in (never one person\'s name on another\'s ID)',
    [canonicalDocName(p, 'guarantor_id__g0', 'j'), canonicalDocName(p, 'guarantor_id__g0', 'dl')],
    ['Guarantor ID - Jeremy Wilson.pdf', 'Guarantor ID - Dilma Herrera Aguilar.pdf']);
  check('…and so does the ZIP folder', [zipFolderFor(p, 'guarantor_id__g0', p.docs.guarantor_id__g0, 'j'), zipFolderFor(p, 'guarantor_id__g0', p.docs.guarantor_id__g0, 'dl')],
    ['3 - Guarantor/Jeremy Wilson', '3 - Guarantor/Dilma Herrera Aguilar']);
  check('"LAST, FIRST" and middle names still find the roster member',
    [canonicalDocName(p, 'ofac_personal', 'd7', { entities: { borrowerName: 'WILSON, JEREMY' } }), canonicalDocName(p, 'ofac_personal', 'd7', { entities: { borrowerName: 'Herrera Aguilar, Dilma Leticia' } })],
    ['OFAC Check (Personal) - Jeremy Wilson.pdf', 'OFAC Check (Personal) - Dilma Herrera Aguilar.pdf']);
  p.docs.credit_authorization.documents[0].aiExtractedEntities = { borrowerName: 'Jeremy Wilson / Dilma Herrera Aguilar' };
  check('a joint document names both, and stays at the Guarantor root in the ZIP',
    [canonicalDocName(p, 'credit_authorization', 'd8'), zipFolderFor(p, 'credit_authorization', p.docs.credit_authorization, 'd8')],
    ['Credit Authorization - Jeremy Wilson & Dilma Herrera Aguilar.pdf', '3 - Guarantor']);
  check('a name the roster does not know is used as read', canonicalDocName(p, 'ofac_personal', 'd7', { entities: { borrowerName: 'Pat Q Stranger' } }), 'OFAC Check (Personal) - Pat Q Stranger.pdf');
}

// ── apply: mutates the entry + currentFilename, keeps hand-typed / generated names ─
{
  const a = applyCanonicalDocName(r, 'psa', 'd3', { incomingFilename: 'Prairie PSA.pdf', entities: {}, ignoreTray: true });
  const e = r.docs.psa.documents[0];
  check('apply: renames entry + current, remembers the upload name, flags nameAuto',
    [a, e.filename, r.docs.psa.currentFilename, e.originalFilename, e.nameAuto],
    [{ name: 'Purchase Agreement - 11415 Prairie Ct SE.pdf', changed: true }, 'Purchase Agreement - 11415 Prairie Ct SE.pdf', 'Purchase Agreement - 11415 Prairie Ct SE.pdf', 'Prairie PSA.pdf', true]);
  check('apply again: idempotent', applyCanonicalDocName(r, 'psa', 'd3', {}).changed, false);
  r.docs.psa.documents.unshift({ docId: 'd3b', filename: 'addendum.pdf', hidden: false });
  check('a second document on the tray never collides', applyCanonicalDocName(r, 'psa', 'd3b', { incomingFilename: 'addendum.pdf' }).name, 'Purchase Agreement - 11415 Prairie Ct SE (2).pdf');
  r.docs.cpl.documents[0].nameManual = true;
  check('a hand-typed name is never overwritten', applyCanonicalDocName(r, 'cpl', 'd12', {}), { name: 'cpl.pdf', changed: false });
  r.docs.loan_application.documents[0].nameLocked = true;
  check('an app-generated name is never overwritten', applyCanonicalDocName(r, 'loan_application', 'd11', {}).name, 'Signed Loan Application - 11415 Prairie Ct SE.pdf');
  const rr = makeReview();
  rr.docs.ofac_personal.documents = [{ docId: 'old', filename: 'x.pdf', hidden: true }, { docId: 'd7', filename: 'ofac.pdf', hidden: false }];
  check('a REPLACE carries a V-number, and keeps it when the review later refines the name',
    [applyCanonicalDocName(rr, 'ofac_personal', 'd7', { mode: 'replace', entities: {}, ignoreTray: true }).name, applyCanonicalDocName(rr, 'ofac_personal', 'd7', { entities: { borrowerName: 'Dilma Herrera Aguilar' } }).name],
    ['OFAC Check (Personal) - Jeremy Wilson & Dilma Herrera Aguilar V2.pdf', 'OFAC Check (Personal) - Dilma Herrera Aguilar V2.pdf']);
  const st = makeReview();
  st.docs.bank_stmt_current.aiExtractedEntities = { borrowerName: 'Someone Else', documentDate: '2026-03-31' };
  st.docs.bank_stmt_current.documentDate = '2026-03-31';
  check('upload time ignores the tray\'s stale ai* fields (they describe the PREVIOUS document)',
    applyCanonicalDocName(st, 'bank_stmt_current', 'd1', { entities: {}, ignoreTray: true }).name, 'Bank Statement - Imagine Investors LLC.pdf');
  check('unknown tray / doc: no throw, no change', [applyCanonicalDocName(r, 'nope', 'x', {}), applyCanonicalDocName(null, 'psa', 'd3', {})], [{ name: '', changed: false }, { name: '', changed: false }]);
}

// ── ZIP layout ────────────────────────────────────────────────────────────
{
  const z = makeReview();
  // Deploy 237.150 (Dan) -- Application & Terms leads, "Loan" is retired into it, and
  // BOTH custom trays land in the one Other folder even though custom_1 was filed
  // under Collateral. That last pair is the change: one Other area, at the bottom.
  check('folders = the tab\'s sections, numbered; a folder per guarantor; bank statements are NOT "Income"',
    ['bank_stmt_current', 'guarantor_id__g1', 'ofac_personal', 'psa', 'loan_application', 'cpl', 'custom_1', 'custom_2'].map((s) => zipFolderFor(z, s, z.docs[s])),
    ['2 - Borrower Entity', '3 - Guarantor/Dilma Herrera Aguilar', '3 - Guarantor', '4 - Collateral', '1 - Application & Terms', '5 - Closing', '6 - Other', '6 - Other']);
  z.docs.bank_stmt_current.documents[0].documentDate = '2026-08-31';
  z.docs.bank_stmt_current.documents[0].aiExtractedEntities = { borrowerName: 'Jeremy Wilson' };
  check('zip names: a legacy raw upload name is canonical in the ZIP with no re-review',
    [zipNameFor(z, 'bank_stmt_current', 'd1'), zipNameFor(z, 'psa', 'd3'), zipNameFor(z, 'custom_2', 'd10')],
    ['Bank Statement - Jeremy Wilson - Aug 2026.pdf', 'Purchase Agreement - 11415 Prairie Ct SE.pdf', 'Budget Draw Schedule - 11415 Prairie Ct SE.pdf']);
  z.docs.cpl.documents[0].nameManual = true;
  check('zip names: hand-typed names survive', zipNameFor(z, 'cpl', 'd12'), 'cpl.pdf');
  z.docs.term_sheet = tray('dt', 'Rate Sheet - 11415 Prairie Ct SE.pdf', { label: 'Term Sheet', section: 'loan' });
  z.docs.credit_report__g0 = tray('dc', 'Credit Report - Guarantor - Jeremy Wilson.pdf', { guarantorIndex: 0, guarantorName: 'Jeremy Wilson', section: 'guarantor', label: 'Credit Report' });
  check('a purposeful "{X} - {right subject}" name stays (app-generated docs filed before this deploy); the retired three-part names do not',
    [zipNameFor(z, 'loan_application', 'd11'), zipNameFor(z, 'term_sheet', 'dt'), zipNameFor(z, 'credit_report__g0', 'dc')],
    ['Signed Loan Application - 11415 Prairie Ct SE.pdf', 'Rate Sheet - 11415 Prairie Ct SE.pdf', 'Credit Report - Jeremy Wilson.pdf']);
  check('…and apply leaves it alone too', applyCanonicalDocName(z, 'term_sheet', 'dt', {}), { name: 'Rate Sheet - 11415 Prairie Ct SE.pdf', changed: false });
  const p = makeReview();
  p.properties = [{ index: 0, address: '913 Mission Oaks Dr, Billings, MT 59105' }, { index: 1, address: '919 Mission Oaks Dr, Billings, MT 59105' }];
  p.docs.appraisal__p1 = tray('dp', 'appr.pdf');
  check('portfolio: a per-property tray is named + foldered for ITS property',
    [canonicalDocName(p, 'appraisal__p1', 'dp'), zipFolderFor(p, 'appraisal__p1', p.docs.appraisal__p1)],
    ['Appraisal - 919 Mission Oaks Dr.pdf', '4 - Collateral/919 Mission Oaks Dr']);
  const solo = makeReview(); solo.guarantors = [{ index: 0, name: 'Jeremy Wilson' }]; solo.docs.guarantor_id = tray('dg', 'dl.png');
  check('single guarantor: no per-person folder, shared tray names them', [zipFolderFor(solo, 'guarantor_id', solo.docs.guarantor_id), canonicalDocName(solo, 'guarantor_id', 'dg')], ['3 - Guarantor', 'Guarantor ID - Jeremy Wilson.png']);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
