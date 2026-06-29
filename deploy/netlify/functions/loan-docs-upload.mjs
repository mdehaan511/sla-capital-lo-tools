/**
 * loan-docs-upload.mjs — POST /api/loan-docs-upload
 *
 * Deploy 236.119 (Phase D.1) — per-loan document upload for the
 * Documents tab on Loan Details. Parallel to the Loan Doc Review
 * system (loan-review-doc-upload) but simpler — no checklist
 * trays, no AI review workflow, just "store a file under this
 * loan in a category."
 *
 * Body (base64-in-JSON pattern, same as loan-review-doc-upload):
 *   {
 *     clientId, loanId,
 *     category:   'borrower' | 'property' | 'title' | 'insurance' |
 *                 'loan-app' | 'rate-sheet' | 'closing' | 'other',
 *     filename:   'appraisal.pdf',
 *     mimeType:   'application/pdf',
 *     contentBase64: '...',
 *     notes?:     '',
 *     owner?:     'other@lo.com'  // admin cross-LO override
 *   }
 *
 * Response: { ok: true, doc: <metadata record> }
 *
 * Storage:
 *   metadata: blob store `loan-docs` keyed ownerKey/docId.json
 *   bytes:    blob store `loan-docs-files` keyed ownerKey/docId
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — matches loan-review-doc-upload
const VALID_CATEGORIES = ['borrower', 'property', 'title', 'insurance', 'loan-app', 'rate-sheet', 'closing', 'other'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-docs-upload top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const clientId = String(body.clientId || '').trim();
  const loanId   = String(body.loanId   || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!body.contentBase64) return json(400, { error: 'contentBase64 required' });

  const category = String(body.category || 'other').toLowerCase().trim();
  if (VALID_CATEGORIES.indexOf(category) < 0) {
    return json(400, { error: 'Invalid category: ' + category + '. Must be one of ' + VALID_CATEGORIES.join(', ') });
  }

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  // Decode bytes.
  let bytes;
  try { bytes = Buffer.from(body.contentBase64, 'base64'); }
  catch (e) { return json(400, { error: 'contentBase64 is not valid base64' }); }
  if (bytes.length > MAX_BYTES) return json(413, { error: 'File too large; max is ' + (MAX_BYTES / 1024 / 1024) + 'MB' });
  if (bytes.length === 0)       return json(400, { error: 'Empty file' });

  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  const now = new Date().toISOString();
  const docId = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  const doc = {
    id: docId, clientId, loanId, ownerKey,
    category,
    filename:    String(body.filename || ('document-' + docId + '.bin')).slice(0, 255),
    mimeType:    String(body.mimeType || 'application/octet-stream').slice(0, 120),
    sizeBytes:   bytes.length,
    notes:       String(body.notes || '').trim(),
    uploadedAt:  now,
    uploadedBy:  user.email || '',
    uploadedByName: authorName,
    updatedAt:   now,
  };

  const metaStore  = getStore({ name: 'loan-docs',       consistency: 'strong' });
  const bytesStore = getStore({ name: 'loan-docs-files', consistency: 'strong' });

  const blobKey = ownerKey + '/' + docId;
  try {
    await bytesStore.set(blobKey, bytes, {
      metadata: { filename: doc.filename, mimeType: doc.mimeType, loanId, clientId },
    });
    await metaStore.setJSON(blobKey + '.json', doc);
  } catch (e) {
    return json(500, { error: 'Failed to store document: ' + (e.message || 'unknown') });
  }

  return json(200, { ok: true, doc });
}
