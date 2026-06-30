/**
 * loan-review-zip-download.mjs — GET /api/loan-review-zip-download
 *
 * Deploy 236.159 — bundles every uploaded document on a doc-review
 * (one per active tray, plus everything in each tray's `history`)
 * into a single ZIP for offline / investor-handoff use.
 *
 * Auth: requireAuth + isProcessor (same gate as loan-review-doc-get).
 * Query: ?reviewId=...
 * Response: application/zip, attachment; filename="...-Documents.zip"
 *
 * ZIP layout — flat. Filenames are namespaced as
 *   <Section>/<slug>-<displayName>
 * so the LO sees the same logical grouping as the review UI:
 *   Loan/sow-Statement of Work.pdf
 *   Borrower/operating-agreement-LLC Operating Agreement.pdf
 *   ...
 * Filename collisions (rare — same display name across trays) are
 * disambiguated with a -2 / -3 suffix.
 */
import { getStore } from '@netlify/blobs';
import JSZip from 'jszip';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe, corsHeaders,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-zip-download error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const reviewId = url.searchParams.get('reviewId');
  if (!reviewId) return json(400, { error: 'reviewId required' });

  const reviewsStore = getStore({ name: 'loan_reviews',     consistency: 'strong' });
  const docsStore    = getStore({ name: 'loan-review-docs', consistency: 'strong' });

  const review = await reviewsStore.get(keySafe(reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  // Walk every tray and every doc (current + history) and queue them
  // for fetch. The fetches happen in parallel since the blob store
  // calls are independent.
  const queue = []; // { sectionLabel, slug, docId, filename }
  const docMap = (review.docs && typeof review.docs === 'object') ? review.docs : {};
  for (const slug of Object.keys(docMap)) {
    const d = docMap[slug] || {};
    if (d.hidden) continue; // Deploy 236.161 — skip hidden trays.
    const sectionLabel = _sectionLabelForSlug(slug);
    // Deploy 236.163 — prefer the multi-doc documents[] array when
    // present. Live (non-hidden) docs get bundled; hidden (replaced)
    // docs are skipped by default. Legacy single-doc trays still
    // surface via the currentDocId fallback below.
    if (Array.isArray(d.documents) && d.documents.length) {
      d.documents.forEach((entry) => {
        if (!entry || !entry.docId || entry.hidden) return;
        queue.push({
          sectionLabel, slug,
          docId:    entry.docId,
          filename: entry.filename || (slug + '.pdf'),
        });
      });
    } else if (d.currentDocId) {
      queue.push({
        sectionLabel, slug,
        docId:    d.currentDocId,
        filename: d.currentFilename || (slug + '.pdf'),
      });
    }
    if (Array.isArray(d.history)) {
      d.history.forEach((h, hi) => {
        if (!h || !h.docId) return;
        queue.push({
          sectionLabel, slug,
          docId:    h.docId,
          filename: 'prior-' + (hi + 1) + '-' + (h.filename || (slug + '.pdf')),
        });
      });
    }
  }

  const zip = new JSZip();
  const seen = new Set();
  const manifest = [];
  manifest.push('SLA Capital — Loan Document Review ZIP');
  manifest.push('Review: ' + (review.address || review.id));
  manifest.push('Generated: ' + new Date().toISOString());
  manifest.push('');
  manifest.push('Contents (' + queue.length + ' document' + (queue.length === 1 ? '' : 's') + '):');

  // Fetch in parallel for speed; the blob store handles concurrent
  // reads natively. Failed fetches are noted in the manifest rather
  // than aborting the whole ZIP — partial bundles are better than
  // nothing for the LO.
  const fetched = await Promise.all(queue.map(async (q) => {
    try {
      const key = keySafe(reviewId) + '/' + keySafe(q.docId);
      const r = await docsStore.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!r || !r.data) return { ...q, ok: false, error: 'not found' };
      return { ...q, ok: true, bytes: Buffer.from(r.data), metaName: (r.metadata && r.metadata.filename) || q.filename };
    } catch (e) {
      return { ...q, ok: false, error: (e && e.message) || 'unknown' };
    }
  }));

  fetched.forEach((f) => {
    if (!f.ok) {
      manifest.push('  [MISSING] ' + f.sectionLabel + '/' + f.slug + ' — ' + f.filename + ' (' + f.error + ')');
      return;
    }
    // Disambiguate by adding -2 / -3 / ... to the basename when a
    // filename collision shows up.
    const baseDir = _safePath(f.sectionLabel);
    const base = _safePath(f.filename) || (f.slug + '.pdf');
    let candidate = baseDir + '/' + base;
    if (seen.has(candidate)) {
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext  = dot > 0 ? base.slice(dot)  : '';
      let n = 2;
      while (seen.has(baseDir + '/' + stem + '-' + n + ext)) n++;
      candidate = baseDir + '/' + stem + '-' + n + ext;
    }
    seen.add(candidate);
    zip.file(candidate, f.bytes);
    manifest.push('  [OK] ' + candidate + '  (' + f.bytes.length + ' bytes)');
  });

  zip.file('bundle-manifest.txt', manifest.join('\n'));

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Filename mirrors the loan-bundle convention from 236.152:
  // "<Street> - Documents.zip" (street portion only, filesystem-safe).
  const rawAddr = String(review.address || '').trim();
  const street = rawAddr ? rawAddr.split(',')[0].trim() : '';
  const safeStreet = street
    .replace(/[<>:"|?*\\\/\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  // Deploy 236.161 — renamed per Mike from " - Documents" to
  // " - Full Loan File". The investor / closing-package context
  // is what matters; "Documents" was too generic.
  const filename = (safeStreet ? safeStreet + ' - Full Loan File' : 'Loan File - ' + reviewId) + '.zip';

  return new Response(out, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type':        'application/zip',
      'Content-Length':      String(out.length),
      'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, "'") + '"',
      'Cache-Control':       'private, no-store',
    },
  });
}

// Strip characters that would break ZIP paths or filesystem extracts
// on Windows. Spaces / ordinary punctuation are fine.
function _safePath(s) {
  return String(s || '')
    .replace(/[<>:"|?*\\/\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Section labels match what loan-doc-review.js groups by. Keeps the
// ZIP folder structure aligned with the on-screen review.
function _sectionLabelForSlug(slug) {
  const s = String(slug || '').toLowerCase();
  if (/(borrow|guarantor|fico|credit|w2|paystub|tax-return|bank-statement|drivers|passport)/.test(s)) return 'Borrower';
  if (/(operating|articles|ein|llc|entity|certificate-of-good)/.test(s))                              return 'Entity';
  if (/(appraisal|insurance|hoi|title|survey|inspection|env|flood|prelim|hazard|property)/.test(s))   return 'Property';
  if (/(rent-roll|lease|rent|t12|t-12|noi|rent-schedule)/.test(s))                                    return 'Income';
  if (/(purchase|psa|contract|hud|cd|closing|wire|loi|term-sheet|rate-sheet|loan-app)/.test(s))      return 'Loan';
  return 'Other';
}
