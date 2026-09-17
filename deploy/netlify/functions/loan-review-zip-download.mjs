/**
 * loan-review-zip-download.mjs — GET /api/loan-review-zip-download
 *
 * Deploy 236.159 — bundles the uploaded documents on a doc review into a single
 * ZIP for offline / investor-handoff use.
 *
 * Deploy 237.133 (Mike, 11415 Prairie Ct SE: "its downloading items with
 * different file structure and name that doesn't make sense. It also appears to
 * be downloading random files") — three fixes:
 *   1. SCOPE. The Documents tab now asks which review tabs to take (just the one
 *      open, or a hand-picked set) and sends their trays as ?slugs=. No slugs =
 *      every tray, as before.
 *   2. NO RANDOM FILES. Replaced documents and each tray's upload history used
 *      to ride along as "prior-1-…" files. They are now left out unless the
 *      processor ticks "include replaced / prior versions" (?prior=1), and then
 *      they sit in a "Prior versions" folder of their own.
 *   3. STRUCTURE + NAMES. Folders were guessed from a regex over the slug — it
 *      filed "bank_stmt_current" under Income because "current" contains "rent",
 *      and dropped most trays in Other. Folders are now the tab's own sections
 *      (numbered, a folder per guarantor), and every file is named by the shared
 *      namer: "{Doc Type} - {address | entity | borrower}[ - {Mon YYYY}]".
 *      Loans filed before this deploy download clean too — names are computed
 *      here from what the review already knows; nothing is re-reviewed.
 *
 * Auth: requireAuth + isProcessor (same gate as loan-review-doc-get).
 * Query: ?reviewId=…[&slugs=a,b,c][&tabs=uw,reviewed][&prior=1]
 * Response: application/zip, attachment.
 */
import { getStore } from '@netlify/blobs';
import JSZip from 'jszip';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe, corsHeaders,
} from './_shared/auth.mjs';
import { logPiiAccess } from './_shared/pii-audit.mjs';   // Deploy 236.456 (F3)
import { zipFolderFor, zipNameFor } from './_shared/doc-naming.mjs';

const TAB_LABELS = { pending: 'Pending Docs', ai: 'AI Reviewed', uw: 'Ready for UW', conditions: 'Pending Conditions', reviewed: 'Approved Docs' };

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

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const reviewId = url.searchParams.get('reviewId');
  if (!reviewId) return json(400, { error: 'reviewId required' });
  const slugsParam = url.searchParams.get('slugs');
  const wanted = (slugsParam == null) ? null
    : new Set(String(slugsParam).split(',').map((s) => s.trim()).filter(Boolean));
  const includePrior = url.searchParams.get('prior') === '1';
  const tabs = String(url.searchParams.get('tabs') || '').split(',').map((t) => t.trim()).filter((t) => TAB_LABELS[t]);

  const reviewsStore = getStore({ name: 'loan_reviews',     consistency: 'strong' });
  const docsStore    = getStore({ name: 'loan-review-docs', consistency: 'strong' });

  const review = await reviewsStore.get(keySafe(reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  // One queue row per file: { folder, name, docId, slug, stored }.
  const queue = [];
  const docMap = (review.docs && typeof review.docs === 'object') ? review.docs : {};
  for (const slug of Object.keys(docMap)) {
    if (wanted && !wanted.has(slug)) continue;
    const d = docMap[slug] || {};
    if (d.hidden) continue; // Deploy 236.161 — a hidden tray is "not needed on this loan".
    const folder = zipFolderFor(review, slug, d);
    const liveIds = {};
    // Deploy 236.163 — live documents[] first; legacy single-doc trays fall back
    // to currentDocId.
    if (Array.isArray(d.documents) && d.documents.length) {
      d.documents.forEach((entry) => {
        if (!entry || !entry.docId) return;
        if (entry.hidden) {
          if (includePrior) queue.push({ folder: folder + '/Prior versions', name: 'replaced - ' + (entry.filename || (slug + '.pdf')), docId: entry.docId, slug, stored: entry.filename || '' });
          return;
        }
        liveIds[entry.docId] = 1;
        // Per DOCUMENT: on a multi-guarantor loan the folder follows the person the
        // document is about, even when it was dropped in the other guarantor's tray.
        queue.push({ folder: zipFolderFor(review, slug, d, entry.docId), name: zipNameFor(review, slug, entry.docId), docId: entry.docId, slug, stored: entry.filename || '' });
      });
    } else if (d.currentDocId) {
      liveIds[d.currentDocId] = 1;
      queue.push({ folder, name: zipNameFor(review, slug, d.currentDocId), docId: d.currentDocId, slug, stored: d.currentFilename || '' });
    }
    if (includePrior && Array.isArray(d.history)) {
      d.history.forEach((h, hi) => {
        if (!h || !h.docId || liveIds[h.docId]) return;
        queue.push({ folder: folder + '/Prior versions', name: 'prior ' + (hi + 1) + ' - ' + (h.filename || (slug + '.pdf')), docId: h.docId, slug, stored: h.filename || '' });
      });
    }
  }
  if (!queue.length) return json(404, { error: 'No documents in the selected tab(s).' });

  const scopeLabel = !wanted ? 'every tab' : (tabs.length ? tabs.map((t) => TAB_LABELS[t]).join(', ') : 'selected trays');
  const zip = new JSZip();
  const seen = new Set();
  const manifest = [];
  manifest.push('SLA Capital — Loan Document Review ZIP');
  manifest.push('Review: ' + (review.address || review.id));
  manifest.push('Generated: ' + new Date().toISOString());
  manifest.push('Scope: ' + scopeLabel + (includePrior ? ' + replaced / prior versions' : ''));
  manifest.push('');
  manifest.push('Contents (' + queue.length + ' document' + (queue.length === 1 ? '' : 's') + '):');

  // Fetch in parallel; a failed fetch is noted in the manifest rather than
  // aborting the whole ZIP — a partial bundle beats nothing.
  const fetched = await Promise.all(queue.map(async (q) => {
    try {
      const r = await docsStore.get(keySafe(reviewId) + '/' + keySafe(q.docId), { type: 'arrayBuffer' });
      if (!r) return { ...q, ok: false, error: 'not found' };
      return { ...q, ok: true, bytes: Buffer.from(r) };
    } catch (e) {
      return { ...q, ok: false, error: (e && e.message) || 'unknown' };
    }
  }));

  fetched.forEach((f) => {
    if (!f.ok) {
      manifest.push('  [MISSING] ' + f.folder + '/' + f.name + ' (' + f.error + ')');
      return;
    }
    const baseDir = f.folder.split('/').map(_safePath).filter(Boolean).join('/');
    const base = _safePath(f.name) || (f.slug + '.pdf');
    let candidate = baseDir + '/' + base;
    if (seen.has(candidate.toLowerCase())) {
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext  = dot > 0 ? base.slice(dot)  : '';
      let n = 2;
      while (seen.has((baseDir + '/' + stem + ' (' + n + ')' + ext).toLowerCase())) n++;
      candidate = baseDir + '/' + stem + ' (' + n + ')' + ext;
    }
    seen.add(candidate.toLowerCase());
    zip.file(candidate, f.bytes);
    manifest.push('  [OK] ' + candidate + '  (' + f.bytes.length + ' bytes)' +
      ((f.stored && _safePath(f.stored) !== base) ? '   <- uploaded as "' + f.stored + '"' : ''));
  });

  zip.file('bundle-manifest.txt', manifest.join('\n'));

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // "<Street> - Full Loan File.zip" (236.161); a single tab names itself.
  const rawAddr = String(review.address || '').trim();
  const street = rawAddr ? rawAddr.split(',')[0].trim() : '';
  const safeStreet = street
    .replace(/[<>:"|?*\\\/\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const suffix = !wanted ? 'Full Loan File' : (tabs.length === 1 ? TAB_LABELS[tabs[0]] : (tabs.length === Object.keys(TAB_LABELS).length ? 'Full Loan File' : 'Loan File (' + (tabs.length || 'selected') + ' tabs)'));
  const filename = (safeStreet ? safeStreet + ' - ' + suffix : 'Loan File - ' + reviewId) + '.zip';

  // Deploy 236.456 (F3) — audit the loan-file zip disclosure. Fail-open.
  await logPiiAccess(req, context, {
    action: 'doc_download', resource: 'loan_review_zip',
    actorEmail: user.email, actorRole: 'processor',
    clientId: review.clientId || null, loanId: review.loanId || null,
    resourceId: reviewId, detail: filename + ' [' + scopeLabel + (includePrior ? ', prior' : '') + ', ' + queue.length + ' docs]',
  });

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

// Strip characters that would break ZIP paths or filesystem extracts on
// Windows. Spaces / ordinary punctuation are fine.
function _safePath(s) {
  return String(s || '')
    .replace(/[<>:"|?*\\/\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
