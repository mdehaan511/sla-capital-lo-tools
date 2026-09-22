/**
 * esign-doc-upload-chunk.mjs — POST /api/esign-doc-upload-chunk
 *
 * Deploy 237.231 (Mike: "is it possible to increase the file size to 10mb").
 *
 * Why a second path: the E-Sign create/append endpoints take the whole PDF as
 * base64 inside one JSON body, and the gateway caps a function request near
 * 6 MB — base64 inflates by a third, so ~4.5 MB of PDF was the ceiling no
 * matter what the code said. This endpoint takes a PDF in ~3 MB slices,
 * assembles them server-side into a STAGED upload, and hands back a stagedId
 * that the normal create (esign-docs) / add-pages (esign-doc-pages) calls
 * accept in place of pdfBase64. Every rule those endpoints already enforce
 * (readable PDF, page count, MAX_DOC_BYTES on an assembled document, naming,
 * history) still runs — only the transport changed. Mirrors
 * loan-review-doc-upload-chunk, which has carried 80 MB closing packages
 * since 236.766.
 *
 * Two actions on one endpoint:
 *   CHUNK    { uploadId, chunkIndex, totalChunks, contentBase64 }
 *            → esign-chunks/<ownerKey>/<uploadId>/<index>
 *   FINALIZE { uploadId, totalChunks, sizeBytes, finalize: true }
 *            → concatenates, checks MAX_PDF_BYTES and the %PDF header, stores
 *              the base64 at esign-staged/<ownerKey>/<uploadId>, deletes the
 *              chunks, returns { stagedId, size }.
 *
 * The staged blob is keyed by the OWNER the document will belong to, so a
 * stagedId can only be consumed by a request for that same owner (takeStaged
 * in _shared/esign-docs.mjs), and it is deleted on consumption. Nothing here
 * is a document yet: a staged upload nobody finishes is just an orphan blob.
 *
 * Auth: requireAuth, with the same owner-override rule as esign-docs (staff
 * may stage on behalf of another owner; everyone else stages for themselves).
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { MAX_PDF_BYTES, chunkStore, stagingStore, stageKey } from './_shared/esign-docs.mjs';

const MAX_CHUNKS = 8;   // 8 × 3 MB comfortably covers the 10 MB single-file ceiling
const staff = (u) => isAdmin(u) || isProcessor(u);
const mb = (n) => (Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('esign-doc-upload-chunk error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const selfEmail = normalizeEmail(user.email || '');
  if (!selfEmail) return json(400, { error: 'No email in token' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON body' });

  let ownerKey = keySafe(selfEmail);
  if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
    if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const uploadId = keySafe(String(body.uploadId || ''));
  if (!/^u_[A-Za-z0-9_]{6,60}$/.test(uploadId)) return json(400, { error: 'uploadId required' });
  const total = Number(body.totalChunks);
  if (!Number.isInteger(total) || total <= 0 || total > MAX_CHUNKS) {
    return json(400, { error: 'totalChunks must be 1–' + MAX_CHUNKS + ' (a single file can be at most ' + mb(MAX_PDF_BYTES) + ')' });
  }
  const chunks = chunkStore();
  const prefix = ownerKey + '/' + uploadId + '/';

  // ── 1. Store one slice ────────────────────────────────────────────
  if (body.finalize !== true) {
    const idx = Number(body.chunkIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= total) return json(400, { error: 'chunkIndex out of range' });
    const b64 = String(body.contentBase64 || '').replace(/\s+/g, '');
    if (!b64) return json(400, { error: 'contentBase64 required' });
    let bytes;
    try { bytes = Buffer.from(b64, 'base64'); } catch (_) { return json(400, { error: 'contentBase64 is not valid base64' }); }
    if (!bytes.length) return json(400, { error: 'Empty chunk' });
    if (bytes.length > 4 * 1024 * 1024) return json(413, { error: 'A slice must be under 4 MB' });
    await chunks.set(prefix + String(idx).padStart(3, '0'), bytes);
    return json(200, { ok: true, chunkIndex: idx, bytes: bytes.length });
  }

  // ── 2. Finalize: assemble → validate → stage ──────────────────────
  const parts = [];
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    const buf = await chunks.get(prefix + String(i).padStart(3, '0'), { type: 'arrayBuffer' }).catch(() => null);
    if (!buf) return json(400, { error: 'Missing part ' + (i + 1) + ' of ' + total + ' — please upload the file again.' });
    const b = Buffer.from(buf);
    totalBytes += b.length;
    if (totalBytes > MAX_PDF_BYTES) {
      await cleanup(chunks, prefix, total);
      return json(413, { error: 'That PDF is over the ' + mb(MAX_PDF_BYTES) + ' single-file limit. Compress it, or add it in smaller pieces.' });
    }
    parts.push(b);
  }
  const bytes = Buffer.concat(parts, totalBytes);
  // The cheap sanity check here; esign-docs / esign-doc-pages still run inspectPdf.
  if (bytes.length < 8 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    await cleanup(chunks, prefix, total);
    return json(400, { error: 'That file is not a PDF' });
  }
  if (body.sizeBytes != null && Number(body.sizeBytes) !== bytes.length) {
    await cleanup(chunks, prefix, total);
    return json(400, { error: 'Upload arrived incomplete (' + mb(bytes.length) + ' of ' + mb(Number(body.sizeBytes)) + ') — please try again.' });
  }

  // Stored as base64 TEXT: that is the shape every E-Sign store holds PDFs in
  // (esign-doc-pdfs, templates, final), so the consumers stay byte-for-byte
  // on the path they already use.
  await stagingStore().set(stageKey(ownerKey, uploadId), bytes.toString('base64'), {
    metadata: { size: String(bytes.length), by: selfEmail, at: new Date().toISOString() },
  });
  await cleanup(chunks, prefix, total);
  return json(200, { ok: true, stagedId: uploadId, size: bytes.length });
}

async function cleanup(chunks, prefix, total) {
  for (let i = 0; i < total; i++) {
    await chunks.delete(prefix + String(i).padStart(3, '0')).catch(() => {});
  }
}
