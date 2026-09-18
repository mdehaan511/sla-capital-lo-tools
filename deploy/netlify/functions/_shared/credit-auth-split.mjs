/**
 * _shared/credit-auth-split.mjs — Deploy 237.156 (Mike: "Each guarantor should sign
 * their own credit auth")
 *
 * They already do. The application writes one "Authorization to Conduct Prequal Credit
 * & Background Checks" page PER SIGNER (loan-application-pdf.mjs), and borrower-info-sign
 * emails guarantors 2-4 their own token link so each signs personally — an independent
 * signature event with its own IP, timestamp and seal. What was missing is that those
 * pages only existed INSIDE the one application PDF, so every guarantor's
 * credit_authorization tray still had to be filled by hand.
 *
 * This lifts each signer's page out of the signed application and files it into THEIR
 * tray: `credit_authorization__g<i>` on a multi-guarantor review, or the base
 * `credit_authorization` tray when the loan has one guarantor.
 *
 * SAFETY — filing one guarantor's signature page under another is the failure this must
 * never produce (the same trap 237.133 hit with guarantor IDs), so it refuses rather
 * than guesses:
 *   - the map's pageCount must equal the stored PDF's real page count. A pdfkit change,
 *     or a regenerate that did not refresh the map, makes those disagree and nothing is
 *     filed.
 *   - every recorded range must be in bounds, ordered and non-overlapping.
 *   - a signer is matched to a guarantor BY NAME first and by position only as a
 *     fallback; on a multi-guarantor review a signer who matches nobody is SKIPPED.
 *   - a page is only filed into a tray that already exists (guarantor-trays.mjs mints
 *     them); it never invents one.
 *
 * Idempotent: each tray records `creditAuthSource`, keyed on that signer's OWN signing
 * time rather than on the PDF. A two-guarantor loan renders the application twice (once
 * per signer), so a PDF-keyed marker would re-file borrower 1 the second time round and
 * leave two copies in their tray. This can therefore be called from the signing flow AND
 * from the Doc Review page-open sync as often as either fires.
 *
 * Zero-throw, like loan-review-auto-attach — it runs inside the signing flow and must
 * never be the reason an application fails to save.
 */
import { getStore } from '@netlify/blobs';
import { PDFDocument } from 'pdf-lib';
import { keySafe } from './auth.mjs';
// NOTE: loan-review-auto-attach calls US, so we must not import it back -- a cycle
// between two _shared modules is exactly the kind of thing esbuild bundles quietly
// and then fails on at runtime. Its attachToSlug is passed in as `attach` instead,
// so there is still only one implementation of "put this doc in that tray".

const BASE_SLUG = 'credit_authorization';

/** Loose name key: case, punctuation and extra spaces don't count. */
function normName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** Last name only, for "LAST, FIRST" and middle-name variants. */
function lastOf(s) {
  const n = normName(s);
  if (!n) return '';
  const parts = n.split(' ');
  return parts[parts.length - 1];
}

/**
 * Which guarantor on the review is this signer? Name first, position second.
 * Returns -1 when the review has 2+ guarantors and nothing matched — the caller skips,
 * because a wrong answer here is worse than no answer.
 */
export function guarantorIndexFor(signer, roster, position) {
  const list = Array.isArray(roster) ? roster : [];
  if (list.length < 2) return 0;
  const want = normName(signer && signer.name);
  if (want) {
    let hit = list.findIndex((g) => normName(g && g.name) === want);
    if (hit >= 0) return hit;
    // Compare the SET of name words. "WILSON, JEREMY" is the same person as
    // "Jeremy Wilson" (order), and "Jeremy A Wilson" contains them (middle name),
    // while "Pat Wilson" against a Jeremy Wilson and a Dana Wilson is neither —
    // two guarantors sharing a surname must never be resolved by guessing.
    const wantSet = new Set(want.split(' '));
    const subset = (a, b) => [...a].every((t) => b.has(t));
    const setHits = list.map((g, i) => [i, new Set(normName(g && g.name).split(' ').filter(Boolean))])
      .filter(([, gs]) => gs.size && (subset(gs, wantSet) || subset(wantSet, gs)));
    if (setHits.length === 1) return setHits[0][0];
    const wantLast = lastOf(signer && signer.name);
    const byLast = list.map((g, i) => [i, lastOf(g && g.name)]).filter(([, n]) => n && n === wantLast);
    if (byLast.length === 1) return byLast[0][0];
  }
  // Position fallback: role 'borrower2' is guarantor index 1. Only trusted when that
  // guarantor has no name on the roster to contradict it.
  const pos = Number(position);
  if (isFinite(pos) && pos >= 0 && pos < list.length && !normName(list[pos] && list[pos].name)) return pos;
  return -1;
}

/** 'borrower3' → 2. Anything unrecognised → -1. */
export function positionOfRole(role) {
  const m = /^borrower(\d+)$/.exec(String(role || ''));
  return m ? (parseInt(m[1], 10) - 1) : -1;
}

/**
 * Validate the recorded map against the PDF it claims to describe.
 * Returns { ok, reason, pageCount } — never throws.
 */
export async function validateAuthPages(pdfBytes, authPages, recordedPageCount) {
  try {
    if (!pdfBytes || !pdfBytes.length) return { ok: false, reason: 'no-bytes' };
    if (!Array.isArray(authPages) || !authPages.length) return { ok: false, reason: 'no-map' };
    const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const count = pdf.getPageCount();
    // The map was recorded by the render that produced these bytes. If the totals
    // disagree, these are not those bytes (or pdfkit's paging moved) — stop.
    if (recordedPageCount != null && Number(recordedPageCount) !== count) {
      return { ok: false, reason: 'page-count-drift:' + recordedPageCount + '!=' + count, pageCount: count };
    }
    let prevEnd = -1;
    for (const ap of authPages) {
      const s = Number(ap && ap.start), e = Number(ap && ap.end);
      if (!isFinite(s) || !isFinite(e)) return { ok: false, reason: 'bad-range', pageCount: count };
      if (s < 0 || e < s || e >= count) return { ok: false, reason: 'out-of-bounds', pageCount: count };
      if (s <= prevEnd) return { ok: false, reason: 'overlapping-ranges', pageCount: count };
      prevEnd = e;
    }
    return { ok: true, pageCount: count };
  } catch (e) {
    return { ok: false, reason: 'load-failed:' + ((e && e.message) || 'unknown') };
  }
}

/**
 * Lift each signer's authorization out of the application.
 * Returns [{ ...authPage, bytes }] — only for entries that validated.
 */
export async function splitAuthPages(pdfBytes, authPages, recordedPageCount) {
  const v = await validateAuthPages(pdfBytes, authPages, recordedPageCount);
  if (!v.ok) {
    console.warn('[credit-auth-split] not splitting:', v.reason);
    return [];
  }
  const out = [];
  try {
    const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    for (const ap of authPages) {
      try {
        const one = await PDFDocument.create();
        const idx = [];
        for (let p = ap.start; p <= ap.end; p++) idx.push(p);
        const copied = await one.copyPages(src, idx);
        copied.forEach((p) => one.addPage(p));
        one.setTitle('Authorization to Conduct Prequal Credit & Background Checks');
        one.setSubject((ap.name || ap.roleLabel || '') + ' — lifted from the signed loan application');
        out.push(Object.assign({}, ap, { bytes: Buffer.from(await one.save()) }));
      } catch (e) {
        console.warn('[credit-auth-split] page ' + (ap && ap.start) + ' failed:', e && e.message);
      }
    }
  } catch (e) {
    console.warn('[credit-auth-split] split failed:', e && e.message);
  }
  return out;
}

/** The tray this signer's page belongs in, or '' when there isn't a safe one. */
export function slugForSigner(review, gi) {
  const docs = (review && review.docs) || {};
  const per = BASE_SLUG + '__g' + gi;
  if (docs[per]) return per;
  const roster = (review && Array.isArray(review.guarantors)) ? review.guarantors : [];
  // The base tray is only right when nobody has been split out — on a multi-guarantor
  // review it is the shared bucket we just spent 237.150/.152 emptying.
  if (roster.length < 2 && docs[BASE_SLUG]) return BASE_SLUG;
  return '';
}

/**
 * File each signer's authorization into their own tray.
 *
 * @param {object} a
 * @param {object} a.review        the review (MUTATED; the caller saves)
 * @param {Buffer} a.pdfBytes      the signed application
 * @param {Array}  a.authPages     the map recorded by renderSignedApplicationWithPages
 * @param {number} a.pageCount     the page count recorded with it
 * @param {string} a.stamp         the signed app's updatedAt — the idempotency key
 * @param {string} a.actorEmail
 * @param {Function} a.attach      loan-review-auto-attach's attachToSlug (passed in;
 *                                 see the note at the top of this file)
 * @param {object} [a.docsStore]   the loan-review-docs store; opened here when omitted
 * @returns {Promise<{ ok, filed, slugs, skipped }>} — never throws
 */
export async function fileCreditAuthPages({ review, pdfBytes, authPages, pageCount, stamp, actorEmail, attach, docsStore }) {
  const result = { ok: true, filed: 0, slugs: [], skipped: [] };
  try {
    if (!review || !review.docs) return { ok: false, filed: 0, slugs: [], skipped: ['no-review'] };
    if (typeof attach !== 'function') return { ok: false, filed: 0, slugs: [], skipped: ['no-attach-fn'] };
    const pages = await splitAuthPages(pdfBytes, authPages, pageCount);
    if (!pages.length) return { ok: true, filed: 0, slugs: [], skipped: ['nothing-to-split'] };

    const roster = Array.isArray(review.guarantors) ? review.guarantors : [];
    const store = docsStore || getStore({ name: 'loan-review-docs', consistency: 'strong' });
    const src = String(stamp || '');

    for (const ap of pages) {
      // An unsigned block (a co-signer who has not signed yet) is not a document.
      if (ap.signed === false) { result.skipped.push('unsigned:' + (ap.role || '?')); continue; }

      const gi = guarantorIndexFor(ap, roster, positionOfRole(ap.role));
      if (gi < 0) { result.skipped.push('no-guarantor-match:' + (ap.name || ap.role || '?')); continue; }

      const slug = slugForSigner(review, gi);
      if (!slug) { result.skipped.push('no-tray:g' + gi); continue; }

      const ds = review.docs[slug];
      const marker = (ap.signedAt || src) + '#' + (ap.role || 'signer');
      if (ds.creditAuthSource === marker) { result.skipped.push('already-filed:' + slug); continue; }

      const who = ap.name || (roster[gi] && roster[gi].name) || ap.roleLabel || 'Guarantor';
      const filename = 'Credit Authorization - ' + who + '.pdf';
      attach({
        review, slug, bytes: ap.bytes, filename, mimeType: 'application/pdf',
        sourceNote: 'lifted from the signed loan application (page ' + (ap.start + 1) + ')',
        actorEmail,
      });
      ds.creditAuthSource = marker;
      try {
        await store.set(keySafe(review.id) + '/' + ds.currentDocId, ap.bytes, {
          metadata: {
            reviewId: review.id, slug, filename, mimeType: 'application/pdf',
            uploadedAt: new Date().toISOString(),
            uploadedBy: actorEmail || 'auto:credit-auth-split',
            source: 'signed_applications#p' + ap.start,
          },
        });
        result.filed++;
        result.slugs.push(slug);
      } catch (e) {
        console.warn('[credit-auth-split] blob write failed for ' + slug + ':', e && e.message);
        result.skipped.push('blob-failed:' + slug);
      }
    }
    return result;
  } catch (e) {
    console.error('[credit-auth-split] unexpected:', e && e.message);
    return { ok: false, filed: result.filed, slugs: result.slugs, skipped: result.skipped.concat(['error']) };
  }
}
