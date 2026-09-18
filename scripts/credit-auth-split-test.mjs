#!/usr/bin/env node
/**
 * scripts/credit-auth-split-test.mjs — Deploy 237.156
 *
 * Mike: "Each guarantor should sign their own credit auth." They already do — the
 * application writes one prequal-credit-auth page per signer. This deploy lifts each
 * signer's page out of the signed application and files it into THEIR tray.
 *
 * The failure that matters is filing one guarantor's signature page under another, so
 * this gate does not trust the page map — it RENDERS a real two-guarantor application,
 * decodes the text off the pages the map points at, and checks that the page really is
 * that person's authorization and really does not name the other guarantor. 237.133
 * found exactly this class of bug in the ZIP naming (both guarantors' IDs sat in
 * guarantor 1's tray), and it was only caught by looking at real output.
 *
 * pdfkit writes text as WinAnsi hex inside TJ arrays, so the decoder below reads the
 * inflated content stream rather than pretending a PDF is a string.
 *
 * Run: node scripts/credit-auth-split-test.mjs     (needs deploy/node_modules)
 */
import zlib from 'node:zlib';
import { renderSignedApplicationWithPages } from '../deploy/netlify/functions/_shared/loan-application-pdf.mjs';
import {
  validateAuthPages, splitAuthPages, fileCreditAuthPages,
  guarantorIndexFor, positionOfRole, slugForSigner,
} from '../deploy/netlify/functions/_shared/credit-auth-split.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + String(why).slice(0, 300) : ''));
};

// ── read the text off a PDF's pages ───────────────────────────────────────
// Content streams come out in page order; pdfkit emits text as <hex> runs inside a TJ
// array, WinAnsi, so the hex decodes straight to readable characters.
function pageTexts(buf) {
  const latin = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end < 0) continue;
    let s;
    try { s = zlib.inflateSync(buf.subarray(start, end)).toString('latin1'); }
    catch (_) { s = buf.subarray(start, end).toString('latin1'); }
    if (!/\bBT\b/.test(s) || !/T[jJ]/.test(s)) continue;
    let text = '';
    const hx = /<([0-9a-fA-F]+)>/g; let h;
    while ((h = hx.exec(s))) text += Buffer.from(h[1], 'hex').toString('latin1');
    (s.match(/\(((?:\\.|[^()\\])*)\)/g) || []).forEach((p) => { text += ' ' + p.slice(1, -1); });
    out.push(text);
  }
  return out;
}

const audit = (name, at) => ({
  signerName: name, signerEmail: 'x@x.com', signedAt: at,
  ip: '1.2.3.4', userAgent: 'gate', seal: 'seal-' + name, consentVersion: 1, formDataHash: 'h',
});
const G1 = 'Jeremy Wilson', G2 = 'Dilma Herrera Aguilar';
const record = {
  ownerKey: 'lo_x', clientId: 'c1', loanId: 'l1', propertyAddress: '123 Main St',
  data: {
    propertyAddress: '123 Main St', entityName: 'Imagine Investors LLC', numGuarantors: '2',
    firstName: 'Jeremy', lastName: 'Wilson', email: 'jw@x.com',
    guarantors: [{ firstName: 'Dilma', lastName: 'Herrera Aguilar', email: 'dh@x.com' }],
  },
};
const signers = [
  { role: 'borrower1', name: G1, email: 'jw@x.com', audit: audit(G1, '2026-09-18T10:00:00Z'), signedAuths: ['esign', 'application', 'prequal_credit', 'info_release'] },
  { role: 'borrower2', name: G2, email: 'dh@x.com', audit: audit(G2, '2026-09-18T11:00:00Z'), signedAuths: ['prequal_credit'] },
];

console.log('\nThe page map (loan-application-pdf.mjs)');
const rendered = await renderSignedApplicationWithPages({ record, client: { id: 'c1' }, signers, status: 'complete' });
const { buffer, authPages, pageCount } = rendered;
const texts = pageTexts(buffer);

check('one entry per signer, in signing order', authPages.map((a) => a.role), ['borrower1', 'borrower2']);
check('each carries the signer and their own signing time',
  authPages.map((a) => a.name + '@' + a.signedAt),
  [G1 + '@2026-09-18T10:00:00Z', G2 + '@2026-09-18T11:00:00Z']);
check('the recorded page count is the PDF\'s real one', pageCount, texts.length);
assert('the pages are distinct and in order',
  authPages[0].end < authPages[1].start, JSON.stringify(authPages));

// THE question: is the page we recorded actually that person's authorization?
for (const ap of authPages) {
  const t = (texts[ap.start] || '').toUpperCase();
  const mine = ap.name.split(/\s+/).pop().toUpperCase();
  const other = authPages.find((o) => o !== ap).name.split(/\s+/).pop().toUpperCase();
  assert('page ' + ap.start + ' is ' + ap.name + '\'s authorization',
    t.indexOf('AUTHORIZATION TO CONDUCT PREQUAL') >= 0 && t.indexOf(mine) >= 0,
    'text: ' + t.slice(0, 200));
  assert('  ...and does NOT name ' + (ap === authPages[0] ? G2 : G1),
    t.indexOf(other) < 0, 'the other guarantor appears on this page');
}

// ── the guards ────────────────────────────────────────────────────────────
console.log('\nGuards (credit-auth-split.mjs)');
check('a good map validates', (await validateAuthPages(buffer, authPages, pageCount)).ok, true);
check('a page count that disagrees with the PDF is refused',
  (await validateAuthPages(buffer, authPages, pageCount + 1)).ok, false);
check('a range past the end of the document is refused',
  (await validateAuthPages(buffer, [{ start: 0, end: pageCount + 5 }], pageCount)).ok, false);
check('overlapping ranges are refused',
  (await validateAuthPages(buffer, [{ start: 3, end: 5 }, { start: 4, end: 6 }], pageCount)).ok, false);
check('no map at all is refused', (await validateAuthPages(buffer, [], pageCount)).ok, false);
check('a drifted map splits NOTHING rather than guessing',
  (await splitAuthPages(buffer, authPages, pageCount + 1)).length, 0);

// ── the split ─────────────────────────────────────────────────────────────
console.log('\nThe split');
const cut = await splitAuthPages(buffer, authPages, pageCount);
check('one document per signer', cut.length, 2);
for (let i = 0; i < cut.length; i++) {
  const pages = pageTexts(cut[i].bytes);
  const mine = cut[i].name.split(/\s+/).pop().toUpperCase();
  const other = cut[1 - i].name.split(/\s+/).pop().toUpperCase();
  const all = pages.join(' ').toUpperCase();
  assert(cut[i].name + '\'s document holds their authorization, on its own',
    pages.length === 1 && all.indexOf('AUTHORIZATION TO CONDUCT PREQUAL') >= 0 && all.indexOf(mine) >= 0,
    pages.length + ' page(s): ' + all.slice(0, 200));
  assert('  ...and nothing of ' + cut[1 - i].name + '\'s', all.indexOf(other) < 0, all.slice(0, 200));
}

// ── whose tray ────────────────────────────────────────────────────────────
console.log('\nWhose tray (the 237.133 trap)');
const roster = [{ index: 0, name: G1, label: 'Guarantor 1' }, { index: 1, name: G2, label: 'Guarantor 2' }];
check('matched by name, not by the order they signed in',
  [guarantorIndexFor({ name: G2 }, roster, 0), guarantorIndexFor({ name: G1 }, roster, 1)], [1, 0]);
check('a middle name or "LAST, FIRST" still lands on the right person',
  [guarantorIndexFor({ name: 'Jeremy A Wilson' }, roster, -1), guarantorIndexFor({ name: 'WILSON, JEREMY' }, roster, -1)], [0, 0]);
check('a signer nobody on the roster matches is REFUSED, not guessed',
  guarantorIndexFor({ name: 'Somebody Else' }, roster, -1), -1);
check('two guarantors sharing a surname do not collide on the last name',
  guarantorIndexFor({ name: 'Pat Wilson' }, [{ name: 'Jeremy Wilson' }, { name: 'Dana Wilson' }], -1), -1);
check('position is used only when that guarantor has no name to contradict it',
  [guarantorIndexFor({ name: '' }, [{ name: G1 }, { name: '' }], 1),
   guarantorIndexFor({ name: '' }, roster, 1)], [1, -1]);
check('a single-guarantor loan is always guarantor 1', guarantorIndexFor({ name: 'Anyone' }, [{ name: G1 }], -1), 0);
check('roles map to positions', ['borrower1', 'borrower3', 'nonsense'].map(positionOfRole), [0, 2, -1]);

const twoG = { id: 'r1', guarantors: roster, docs: { credit_authorization__g0: {}, credit_authorization__g1: {} } };
const oneG = { id: 'r2', guarantors: [{ index: 0, name: G1 }], docs: { credit_authorization: {} } };
const shared = { id: 'r3', guarantors: roster, docs: { credit_authorization: {} } };
check('per-guarantor trays are used when they exist',
  [slugForSigner(twoG, 0), slugForSigner(twoG, 1)], ['credit_authorization__g0', 'credit_authorization__g1']);
check('a one-guarantor loan uses the plain tray', slugForSigner(oneG, 0), 'credit_authorization');
check('a 2-guarantor review with only the OLD shared tray files nothing (that bucket is retired)',
  slugForSigner(shared, 1), '');

// ── filing, end to end ────────────────────────────────────────────────────
console.log('\nFiling');
const blobs = new Map();
const fakeStore = { set: async (k, v, meta) => { blobs.set(k, { v, meta }); } };
const review = {
  id: 'rev_1', guarantors: roster,
  docs: { credit_authorization__g0: { verdict: 'pending' }, credit_authorization__g1: { verdict: 'pending' } },
};
const filed = await fileCreditAuthPages({
  review, pdfBytes: buffer, authPages, pageCount, stamp: '2026-09-18T11:00:00Z',
  actorEmail: 'gate@x.com', attach: attachStub, docsStore: fakeStore,
});
function attachStub({ review: r, slug, bytes, filename }) {
  r.docs[slug].currentDocId = 'd_' + slug;
  r.docs[slug].currentFilename = filename;
  r.docs[slug].currentSize = bytes.length;
}
check('both guarantors get their own, in their own tray',
  [filed.filed, filed.slugs.sort()], [2, ['credit_authorization__g0', 'credit_authorization__g1']]);
check('named for the person who signed it',
  [review.docs.credit_authorization__g0.currentFilename, review.docs.credit_authorization__g1.currentFilename],
  ['Credit Authorization - ' + G1 + '.pdf', 'Credit Authorization - ' + G2 + '.pdf']);
assert('the bytes really landed in the blob store', blobs.size === 2, JSON.stringify([...blobs.keys()]));
assert('and each blob is that guarantor\'s page', (() => {
  const g1 = blobs.get('rev_1/d_credit_authorization__g0');
  return !!g1 && pageTexts(g1.v).join(' ').toUpperCase().indexOf('WILSON') >= 0;
})());

const again = await fileCreditAuthPages({
  review, pdfBytes: buffer, authPages, pageCount, stamp: '2026-09-18T11:00:00Z',
  actorEmail: 'gate@x.com', attach: attachStub, docsStore: fakeStore,
});
check('a second run files nothing (page-open sync can call it as often as it likes)',
  [again.filed, again.skipped.every((s) => s.indexOf('already-filed') === 0)], [0, true]);

// The co-signer has not signed yet: their block is on the document but unsigned.
const halfSigners = [signers[0], { role: 'borrower2', name: G2, email: 'dh@x.com', audit: null, signedAuths: [] }];
const half = await renderSignedApplicationWithPages({ record, client: { id: 'c1' }, signers: halfSigners, status: 'awaiting_borrower2' });
const halfReview = { id: 'rev_2', guarantors: roster, docs: { credit_authorization__g0: {}, credit_authorization__g1: {} } };
const halfFiled = await fileCreditAuthPages({
  review: halfReview, pdfBytes: half.buffer, authPages: half.authPages, pageCount: half.pageCount,
  stamp: 's', actorEmail: 'gate@x.com', attach: attachStub, docsStore: fakeStore,
});
check('an unsigned co-signer page is NOT filed as their authorization',
  [halfFiled.filed, halfFiled.slugs], [1, ['credit_authorization__g0']]);
assert('  ...and the reason says so', halfFiled.skipped.some((s) => s.indexOf('unsigned') === 0), JSON.stringify(halfFiled.skipped));

check('no attach function means nothing is written',
  (await fileCreditAuthPages({ review, pdfBytes: buffer, authPages, pageCount, stamp: 'x' })).ok, false);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
