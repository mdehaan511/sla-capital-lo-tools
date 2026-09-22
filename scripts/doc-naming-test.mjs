/**
 * scripts/doc-naming-test.mjs — Deploy 237.133
 *
 * Gate for the shared document namer (deploy/netlify/functions/_shared/
 * doc-naming.mjs): "{Doc Type} - {address | entity | borrower}[ - {Mon YYYY}]",
 * modeled on the 11415 Prairie Ct SE loan file that prompted it.
 *
 * Run: node scripts/doc-naming-test.mjs
 */
import { readFileSync } from 'node:fs';
import {
  canonicalDocName, applyCanonicalDocName, docSubject, docTypeLabel, statementPeriod,
  zipFolderFor, zipNameFor, baseSlugOf, renameTrayDocuments, entityFromFilename, distinguisher,
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
  // Deploy 237.237 (Jessy) -- a second document on the tray takes what the
  // uploader's own name says and the canonical name does not, before "(2)".
  r.docs.psa.documents.unshift({ docId: 'd3b', filename: 'addendum.pdf', hidden: false });
  check('a second document on the tray says what it is, not "(2)"',
    applyCanonicalDocName(r, 'psa', 'd3b', { incomingFilename: 'addendum.pdf' }).name,
    'Purchase Agreement - 11415 Prairie Ct SE - addendum.pdf');
  r.docs.psa.documents.unshift({ docId: 'd3c', filename: 'x.pdf', hidden: false });
  check('…and a junk name still falls back to the counter',
    applyCanonicalDocName(r, 'psa', 'd3c', { incomingFilename: '4h789215nu9snamf25.pdf' }).name,
    'Purchase Agreement - 11415 Prairie Ct SE (2).pdf');
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
  // Deploy 237.228 (Dan) -- Post Close became section 6, so Other is 7. The number
  // is the section's place on the page; the ZIP reads in the order the tab does.
  check('folders = the tab\'s sections, numbered; a folder per guarantor; bank statements are NOT "Income"',
    ['bank_stmt_current', 'guarantor_id__g1', 'ofac_personal', 'psa', 'loan_application', 'cpl', 'custom_1', 'custom_2'].map((s) => zipFolderFor(z, s, z.docs[s])),
    ['2 - Borrower Entity', '3 - Guarantor/Dilma Herrera Aguilar', '3 - Guarantor', '4 - Collateral', '1 - Application & Terms', '5 - Closing', '7 - Other', '7 - Other']);
  check('a post-close document files into its own folder',
    ['executed_deed', 'final_hud'].map((s) => zipFolderFor(z, s, { slug: s })),
    ['6 - Post Close', '6 - Post Close']);
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

// ── Deploy 237.237: a ZIP of different companies' operating agreements ─────
// Jessy: "I did a Zip upload of different Operating Agreements but it named each
// file with the same name. If we could please add a function where it accepts the
// original file name from how each file is named from my computer that would be
// super nice." Mike: "I have renaming things because most times people (borrowers
// especially) upload documents with names like 4h789215nu9snamf25.pdf."
//
// This is SLA-20260616-2306 (5909 Cates) as it actually sits on disk: the entity of
// record is Kalahari Capital LLC, six operating agreements for six different
// companies in the ownership chain are all "Operating Agreement - Kalahari Capital
// LLC (n).pdf", and only two of the six were ever individually AI-reviewed.
console.log('\n5909 Cates: six companies, one name');
{
  const oa = (n, orig, llc) => ({
    docId: 'oa' + n, filename: 'Operating Agreement - Kalahari Capital LLC' + (n > 1 ? ' (' + n + ')' : '') + '.pdf',
    originalFilename: orig, nameAuto: true, hidden: false,
    aiExtractedEntities: llc ? { llcName: llc } : undefined,
  });
  const z = {
    id: 'r_cates', address: '5909 Cates Ave, St. Louis, MO, 63112', borrowerName: 'Donato Callahan',
    guarantors: [{ index: 0, name: 'Donato Callahan' }],
    sourceLoanSnapshot: { address: '5909 Cates Ave, St. Louis, MO, 63112' },
    docs: {
      articles_of_organization: { aiReviewedAt: '2026-09-18T00:00:00Z', aiExtractedEntities: { llcName: 'Kalahari Capital LLC' }, section: 'borrower', documents: [] },
      operating_agreement: {
        section: 'borrower', label: 'Operating Agreement',
        currentDocId: 'oa1', currentFilename: 'Operating Agreement - Kalahari Capital LLC.pdf',
        documents: [
          oa(1, 'Kalahari -Operating Agreement - Borrower - 5909 Cates Ave LLC.pdf', ''),
          oa(2, 'Treeline Capital LLC - OA - Borrower - 5909 Cates Ave LLC.pdf', ''),
          oa(3, 'OA - DEER TRAIL RE HOLDINGS LIMITED PARTNERSHIP - Borrower - 5909 Cates Ave LLC.pdf', ''),
          oa(4, 'Operating Agreement - Borrower - 5909 Cates Ave LLC.pdf', '5909 Cates Ave, LLC'),
          oa(5, 'DTCM Management LLC - OA - Borrower - 5909 Cates Ave LLC.pdf', 'DTCM Management, L.L.C.'),
          oa(6, 'DEER TRAIL RE TRUST - TRUST AGREEMENT - Borrower - 5909 Cates Ave LLC.pdf', ''),
        ],
      },
    },
  };
  const moved = renameTrayDocuments(z, 'operating_agreement');
  const names = z.docs.operating_agreement.documents.map((d) => d.filename);
  check('every one of the six is named for the company it is actually about', names, [
    // read off the page by the AI, or — for the four nobody reviewed — taken from
    // the name the uploader gave it, which is what Jessy asked for.
    'Operating Agreement - 5909 Cates Ave, LLC - Kalahari.pdf',
    'Operating Agreement - Treeline Capital LLC.pdf',
    'Operating Agreement - DEER TRAIL RE HOLDINGS LIMITED PARTNERSHIP.pdf',
    'Operating Agreement - 5909 Cates Ave, LLC.pdf',
    'Operating Agreement - DTCM Management, L.L.C.pdf',
    'Operating Agreement - DEER TRAIL RE TRUST.pdf',
  ]);
  check('all six moved, and no two files share a name', [moved, new Set(names.map((s) => s.toLowerCase())).size], [6, 6]);
  check('the tray\'s current document keeps up', z.docs.operating_agreement.currentFilename, names[0]);
  check('running it again changes nothing', [renameTrayDocuments(z, 'operating_agreement'), z.docs.operating_agreement.documents.map((d) => d.filename)], [0, names]);
  // The loan's own spelling wins for the loan's own entity — one company, one
  // spelling across the file, however each document happened to print it.
  const one = JSON.parse(JSON.stringify(z));
  one.docs.operating_agreement.documents = [
    { docId: 'k1', filename: 'a.pdf', originalFilename: 'KALAHARI CAPITAL, L.L.C. - OA.pdf', nameAuto: true },
    { docId: 'k2', filename: 'b.pdf', originalFilename: 'kalahari capital llc operating agreement.pdf', nameAuto: true },
  ];
  renameTrayDocuments(one, 'operating_agreement');
  check('the same company two ways is still one company, spelled the loan\'s way',
    one.docs.operating_agreement.documents.map((d) => d.filename),
    ['Operating Agreement - Kalahari Capital LLC.pdf', 'Operating Agreement - Kalahari Capital LLC (2).pdf']);
}

{
  // The re-name is a set operation over a whole tray, so the trays it must NOT
  // disturb matter as much as the one it fixes.
  const b = makeReview();
  b.docs.bank_stmt_current = { section: 'borrower', currentDocId: 'b1', currentFilename: 'Bank Statement - Imagine Investors LLC - Aug 2026.pdf', documents: [
    { docId: 'b1', filename: 'Bank Statement - Imagine Investors LLC - Aug 2026.pdf', originalFilename: 'Statement_082026_8251.pdf', documentDate: '2026-08-31', nameAuto: true },
    { docId: 'b2', filename: 'Bank Statement - Imagine Investors LLC - Jul 2026.pdf', originalFilename: 'stmt.pdf', documentDate: '2026-07-31', nameAuto: true },
  ] };
  check('a tray that is already right is left alone, months and all',
    [renameTrayDocuments(b, 'bank_stmt_current'), b.docs.bank_stmt_current.documents.map((d) => d.filename)],
    [0, ['Bank Statement - Imagine Investors LLC - Aug 2026.pdf', 'Bank Statement - Imagine Investors LLC - Jul 2026.pdf']]);
  b.docs.bank_stmt_current.documents[1].nameManual = true;
  b.docs.bank_stmt_current.documents[1].filename = 'July statement FINAL.pdf';
  b.docs.bank_stmt_current.documents[0].filename = 'wrong.pdf';
  renameTrayDocuments(b, 'bank_stmt_current');
  check('a name a person typed survives a re-name of everything around it',
    b.docs.bank_stmt_current.documents.map((d) => d.filename),
    ['Bank Statement - Imagine Investors LLC - Aug 2026.pdf', 'July statement FINAL.pdf']);
  const single = makeReview();
  check('a one-document tray is never re-named as a set', renameTrayDocuments(single, 'psa'), 0);
  // It runs on page open, which is how the loans already in this state get fixed.
  const SYNC = readFileSync(new URL('../deploy/netlify/functions/loan-review-sync-categories.mjs', import.meta.url), 'utf8');
  check('the page-open self-heal calls it for every tray, and writes when it moved something',
    [/import \{ renameTrayDocuments \}/.test(SYNC),
     /for \(const slug of Object\.keys\(review\.docs \|\| \{\}\)\) renamed \+= renameTrayDocuments\(review, slug\);/.test(SYNC),
     /if \(added\.length \|\| relabeled \|\| healed \|\| renamed \|\|/.test(SYNC)],
    [true, true, true]);
  // Deploy 237.239 -- and the page shows the new names on the load that fixes them.
  // It used to re-render only when the sync ADDED a tray, so a re-name landed in the
  // store and the processor went on reading the old names until the next visit.
  const PAGE = readFileSync(new URL('../deploy/loan-doc-review.js', import.meta.url), 'utf8');
  check('the page re-renders when the sync re-named something, not only when it added a tray',
    /\(\(sr\.added && sr\.added\.length\) \|\| sr\.renamed\)/.test(PAGE), true);
}

console.log('\nWhat a file name is allowed to contribute');
{
  // A company is a phrase ending in LLC / Inc / Corp / Trust / Limited Partnership.
  // Everything else a borrower types is ignored — Mike's half of the bargain.
  check('a company is found where there is one', [
    'Treeline Capital LLC - OA - Borrower - 5909 Cates Ave LLC.pdf',
    'OA - DEER TRAIL RE HOLDINGS LIMITED PARTNERSHIP - Borrower.pdf',
    'Kalahari Capital LLC Operating Agreement.pdf',
    'Operating_Agreement_Treeline Capital LLC.pdf',
    'OA DTCM Management LLC.pdf',
  ].map(entityFromFilename), [
    'Treeline Capital LLC', 'DEER TRAIL RE HOLDINGS LIMITED PARTNERSHIP',
    'Kalahari Capital LLC', 'Treeline Capital LLC', 'DTCM Management LLC']);
  check('and nothing is invented where there is not', [
    '4h789215nu9snamf25.pdf', 'IMG_2044.jpg', 'Scan_001.pdf', 'document.pdf',
    '20260918_140233.pdf', 'articles of organization.pdf', 'LLC.pdf', '5909 LLC.pdf',
  ].map(entityFromFilename), ['', '', '', '', '', '', '', '']);
  // The tie-breaker when two documents still land on the same name.
  check('the tie-breaker says what the canonical name does not',
    ['Operating Agreement - Amendment 2.pdf', 'OA - First Amendment.pdf', 'restated 2019.pdf']
      .map((f) => distinguisher(f, 'Operating Agreement - Kalahari Capital LLC')),
    ['Amendment 2', 'First Amendment', 'restated 2019']);
  check('…and stays quiet when the file name is noise',
    ['4h789215nu9snamf25.pdf', 'IMG_2044.jpg', 'Kalahari Capital LLC.pdf', 'scan copy final.pdf']
      .map((f) => distinguisher(f, 'Operating Agreement - Kalahari Capital LLC')),
    ['', '', '', '']);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
