/**
 * scripts/esign-pages-test.mjs — Deploy 237.168 (Mike)
 *
 * Combining PDFs and re-ordering pages is only safe if the FIELDS follow the
 * pages. A field is a page number plus a position on that page, so the page
 * move and the field remap have to agree exactly or every signature block
 * lands on the wrong sheet — silently, on a document about to go to a
 * borrower.
 *
 * So this builds real PDFs whose pages are individually identifiable (each
 * page gets a unique width), runs the actual helpers the endpoint calls, and
 * checks the resulting page order AND where every field ended up.
 *
 *   node scripts/esign-pages-test.mjs
 */
import { PDFDocument } from '../deploy/node_modules/pdf-lib/cjs/index.js';
import {
  insertPdfPages, reorderPdfPages, remapFieldPages,
} from '../deploy/netlify/functions/_shared/esign-docs.mjs';

let failed = 0;
const fail = (m) => { failed++; console.log('  ✗ ' + m); };
const ok   = (m) => console.log('  ✓ ' + m);

/** A PDF whose page i is identifiable by its width (tag + i). */
async function makePdf(tag, count) {
  const pdf = await PDFDocument.create();
  for (let i = 1; i <= count; i++) pdf.addPage([tag + i, 800]);
  return Buffer.from(await pdf.save());
}
async function widths(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return pdf.getPages().map((p) => Math.round(p.getSize().width));
}
const field = (id, page) => ({ id, page, type: 'signature', signerId: 's1', x: 0.1, y: 0.1, w: 0.2, h: 0.05 });
const pagesOf = (doc) => doc.fields.map((f) => f.id + '@' + f.page).join(' ');

// A = pages 101,102,103   B = pages 201,202
const A = await makePdf(100, 3);
const B = await makePdf(200, 2);

console.log('Combining two PDFs\n');

// ── Append ──
{
  const r = await insertPdfPages(A, B, undefined);
  const w = await widths(r.bytes);
  const doc = { fields: [field('f1', 1), field('f2', 3)] };
  const dropped = remapFieldPages(doc, r.remap);
  if (String(w) === String([101, 102, 103, 201, 202]) && r.pageCount === 5 && r.addedCount === 2 && r.at === 4) ok('append puts B after A: ' + w.join(','));
  else fail('append order wrong: ' + w.join(',') + ' (at ' + r.at + ', count ' + r.pageCount + ')');
  if (pagesOf(doc) === 'f1@1 f2@3' && !dropped) ok('fields on A stay put');
  else fail('append moved fields: ' + pagesOf(doc));
}

// ── Insert in the middle (the real "combine" case: an exhibit before signatures) ──
{
  const r = await insertPdfPages(A, B, 2);
  const w = await widths(r.bytes);
  const doc = { fields: [field('f1', 1), field('f2', 2), field('f3', 3)] };
  const dropped = remapFieldPages(doc, r.remap);
  if (String(w) === String([101, 201, 202, 102, 103])) ok('insert before page 2: ' + w.join(','));
  else fail('insert order wrong: ' + w.join(','));
  // f1 was on A page 1 (unmoved); f2/f3 were on A pages 2,3 which are now 4,5.
  if (pagesOf(doc) === 'f1@1 f2@4 f3@5' && !dropped) ok('fields after the insert point shift by 2');
  else fail('insert remap wrong: ' + pagesOf(doc));
}

// ── Insert at the very front ──
{
  const r = await insertPdfPages(A, B, 1);
  const w = await widths(r.bytes);
  const doc = { fields: [field('f1', 1)] };
  remapFieldPages(doc, r.remap);
  if (String(w) === String([201, 202, 101, 102, 103]) && pagesOf(doc) === 'f1@3') ok('insert at the front pushes every field down');
  else fail('front insert wrong: ' + w.join(',') + ' / ' + pagesOf(doc));
}

// ── Out-of-range positions are clamped, not rejected ──
{
  const r = await insertPdfPages(A, B, 99);
  const w = await widths(r.bytes);
  if (String(w) === String([101, 102, 103, 201, 202])) ok('a position past the end appends');
  else fail('clamp failed: ' + w.join(','));
}

console.log('\nRe-ordering and deleting pages');

// ── Straight re-order ──
{
  const r = await reorderPdfPages(A, [3, 1, 2]);
  const w = await widths(r.bytes);
  const doc = { fields: [field('f1', 1), field('f2', 2), field('f3', 3)] };
  const dropped = remapFieldPages(doc, r.remap);
  if (String(w) === String([103, 101, 102]) && r.pageCount === 3 && !r.dropped) ok('pages re-ordered: ' + w.join(','));
  else fail('re-order wrong: ' + w.join(','));
  // page1 -> slot2, page2 -> slot3, page3 -> slot1
  if (pagesOf(doc) === 'f1@2 f2@3 f3@1' && !dropped) ok('every field followed its page');
  else fail('re-order remap wrong: ' + pagesOf(doc));
}

// ── Delete a page: its fields go with it, and are counted ──
{
  const r = await reorderPdfPages(A, [1, 3]);
  const w = await widths(r.bytes);
  const doc = { fields: [field('f1', 1), field('f2', 2), field('f3', 2), field('f4', 3)] };
  const dropped = remapFieldPages(doc, r.remap);
  if (String(w) === String([101, 103]) && r.dropped === 1) ok('dropping page 2 leaves: ' + w.join(','));
  else fail('delete wrong: ' + w.join(',') + ' dropped ' + r.dropped);
  if (pagesOf(doc) === 'f1@1 f4@2' && dropped === 2) ok('the 2 fields on the deleted page went with it');
  else fail('delete remap wrong: ' + pagesOf(doc) + ' (reported ' + dropped + ' dropped)');
}

// ── Junk in the order list cannot corrupt the document ──
{
  const r = await reorderPdfPages(A, [2, 2, 0, 99, 'x', 1]);
  const w = await widths(r.bytes);
  if (String(w) === String([102, 101])) ok('repeats and out-of-range entries are ignored: ' + w.join(','));
  else fail('junk order produced: ' + w.join(','));
}
{
  let threw = '';
  try { await reorderPdfPages(A, []); } catch (e) { threw = e.message; }
  if (/at least one page/i.test(threw)) ok('emptying a document is refused');
  else fail('empty order was allowed (' + threw + ')');
}

// ── The bytes stay a readable PDF the stamper can load ──
{
  const r = await insertPdfPages(A, B, 2);
  const again = await reorderPdfPages(r.bytes, [5, 4, 3, 2, 1]);
  const w = await widths(again.bytes);
  if (String(w) === String([103, 102, 202, 201, 101])) ok('a combined document can be re-ordered again: ' + w.join(','));
  else fail('second pass wrong: ' + w.join(','));
}

// ── Rotation (Deploy 237.169): scanned exhibits arrive sideways ──
console.log('\nRotating pages');
async function angles(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return pdf.getPages().map((p) => p.getRotation().angle || 0);
}
{
  const r = await reorderPdfPages(A, [1, { page: 2, rotate: 90 }, { page: 3, rotate: 180 }]);
  const a = await angles(r.bytes);
  if (String(a) === String([0, 90, 180]) && r.rotated === 2) ok('pages turn without moving: ' + a.join(','));
  else fail('rotation wrong: ' + a.join(',') + ' (rotated ' + r.rotated + ')');
}
{
  // Turning twice adds up: a page already rotated keeps its own angle as the base.
  const once  = await reorderPdfPages(A, [{ page: 1, rotate: 90 }, 2, 3]);
  const twice = await reorderPdfPages(once.bytes, [{ page: 1, rotate: 90 }, 2, 3]);
  const a = await angles(twice.bytes);
  if (a[0] === 180) ok('a second quarter turn lands on 180');
  else fail('rotation did not accumulate: ' + a.join(','));
}
{
  const r = await reorderPdfPages(A, [{ page: 1, rotate: 45 }, { page: 2, rotate: -90 }, { page: 3, rotate: 720 }]);
  const a = await angles(r.bytes);
  if (String(a) === String([0, 270, 0])) ok('odd angles ignored, negatives normalized: ' + a.join(','));
  else fail('angle normalization wrong: ' + a.join(','));
}
{
  // Re-order, rotate and delete in one pass, with the fields following.
  const r = await reorderPdfPages(A, [{ page: 3, rotate: 90 }, 1]);
  const w = await widths(r.bytes), a = await angles(r.bytes);
  const doc = { fields: [field('f1', 1), field('f2', 2), field('f3', 3)] };
  const dropped = remapFieldPages(doc, r.remap);
  if (String(w) === String([103, 101]) && String(a) === String([90, 0]) && pagesOf(doc) === 'f1@2 f3@1' && dropped === 1) {
    ok('re-order + rotate + delete in one pass keeps fields straight');
  } else fail('combined pass wrong: ' + w.join(',') + ' / ' + a.join(',') + ' / ' + pagesOf(doc));
}

console.log('');
if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('✓ pages and fields move together');
