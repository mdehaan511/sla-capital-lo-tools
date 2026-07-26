/**
 * borrower-doc-upload.mjs — POST /api/borrower-doc-upload
 *
 * Deploy 236.171 — Access Refactor PR #4. Lets an authenticated
 * borrower upload a document against a loan they have access to.
 * The upload lands on the loan's doc review as a CUSTOM tray
 * (isCustom:true, section:'borrower') so the processor sees it
 * alongside the normal checklist without any additional plumbing.
 *
 * Body:
 *   {
 *     loanId, primaryClientId, ownerKey,
 *     filename, mimeType, sizeBytes, contentBase64,
 *     label?           // Human-readable tray label; defaults to
 *                       // the filename minus extension.
 *   }
 *
 * Auth: canReadLoan against the borrower's loan_access grant.
 * (We use canReadLoan even for uploads because for BORROWERS the
 * distinction between read + upload doesn't matter — they have
 * no other mutations they could perform. Processor-side uploads
 * still go through loan-review-doc-upload with its canReviewDocs
 * gate.)
 *
 * Behavior:
 *   1. Confirm the borrower has a grant on this loan.
 *   2. Locate (or create) the loan's doc review record.
 *   3. Add a custom slug + write the blob bytes.
 *   4. Set aiVerdict=''; verdict='pending' so the processor
 *      manually reviews. No AI review triggers for borrower
 *      uploads (they haven't got a rubric).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canReadLoan } from './_shared/access.mjs';

const MAX_BYTES = 25 * 1024 * 1024;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-doc-upload error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const { loanId, primaryClientId, ownerKey, filename, contentBase64 } = body;
  if (!loanId || !contentBase64) return json(400, { error: 'loanId and contentBase64 required' });

  // Load the loan for the access check. Borrowers must have a
  // live grant on THIS loanId; LOs / admins hit the ownerKey
  // short-circuit inside canReadLoan.
  let loan = null;
  let client = null;
  try {
    if (primaryClientId && ownerKey) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      loan = client && Array.isArray(client.loans)
        ? client.loans.find((l) => l && l.id === loanId) || null
        : null;
    }
  } catch (_) {}
  const perm = await canReadLoan(user, loan || { id: loanId, ownerKey }, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  // Decode + size-check the bytes.
  let bytes;
  try { bytes = Buffer.from(contentBase64, 'base64'); }
  catch (e) { return json(400, { error: 'contentBase64 not valid base64' }); }
  if (bytes.length === 0)             return json(400, { error: 'Empty file' });
  if (bytes.length > MAX_BYTES)       return json(413, { error: 'Too large (max 25MB)' });

  // Find or create the review for this loan. Follows the pattern
  // loan-details.html uses for the Documents tab discovery.
  const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let review = null;
  try {
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r) continue;
      if (r.source && r.source.loanId === loanId) { review = r; break; }
      if (r.address && loan && loan.address &&
          String(r.address).toLowerCase().trim() === String(loan.address).toLowerCase().trim()) {
        review = r; break;
      }
    }
  } catch (e) {
    console.warn('[borrower-doc-upload] review lookup failed:', e && e.message);
  }
  if (!review) {
    // Auto-create a minimal review. When the processor opens the
    // Documents tab, they'll see the custom tray waiting.
    review = {
      id:              'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      address:         loan ? (loan.address || '') : '',
      investor:        '',
      loanType:        loan ? (loan.loanType || '').toLowerCase() : '',
      docs:            {},
      snapshotClient:  client || {},
      snapshotLoan:    loan   || {},
      source:          { loanId, clientId: primaryClientId || '', ownerKey: ownerKey || '' },
      createdAt:       new Date().toISOString(),
      updatedAt:       new Date().toISOString(),
      createdBy:       'auto:borrower-upload',
    };
  }

  // Allocate the custom tray + write the blob.
  const now       = new Date().toISOString();
  const slug      = 'borrower_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const docId     = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const label     = String(body.label || _stripExt(filename) || 'Borrower Upload').slice(0, 120);
  const mimeType  = String(body.mimeType || 'application/pdf');
  const finalName = String(filename || (label + '.pdf'));

  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  try {
    await docsStore.set(keySafe(review.id) + '/' + docId, bytes, {
      metadata: {
        reviewId:   review.id,
        slug,
        filename:   finalName,
        mimeType,
        uploadedAt: now,
        uploadedBy: normalizeEmail(user.email),
        source:     'borrower-upload',
      },
    });
  } catch (e) {
    return json(500, { error: 'Failed to write file: ' + (e && e.message || 'unknown') });
  }

  review.docs = review.docs || {};
  review.docs[slug] = {
    slug,
    isCustom:        true,
    label,
    section:         'borrower',
    conditions:      'Uploaded by the borrower via the portal. Needs manual review.',
    required:        false,
    verdict:         'pending',
    processorNotes:  '',
    naReason:        '',
    currentDocId:    docId,
    currentFilename: finalName,
    currentSize:     bytes.length,
    currentMimeType: mimeType,
    currentUploadedAt: now,
    aiVerdict:       '',
    aiNotes:         '',
    aiFindings:      [],
    aiExtractedEntities: {},
    aiReviewedAt:    '',
    aiError:         '',
    processorOverrideReason: '',
    approvedAt:      '',
    approvedBy:      '',
    history:         [],
    documents:       [{
      docId, filename: finalName, size: bytes.length, mimeType,
      uploadedAt: now, hidden: false,
    }],
    uploadedByBorrower: normalizeEmail(user.email),
  };
  review.updatedAt = now;

  try { await reviewsStore.setJSON(keySafe(review.id), review); }
  catch (e) { return json(500, { error: 'Failed to save review: ' + (e && e.message || 'unknown') }); }

  return json(200, {
    ok:       true,
    reviewId: review.id,
    slug,
    docId,
    filename: finalName,
  });
}

function _stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '');
}
