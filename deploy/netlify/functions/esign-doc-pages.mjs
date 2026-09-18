/**
 * esign-doc-pages.mjs — POST /api/esign-doc-pages
 *
 * Deploy 237.168 (Mike: "PandaDoc can combine multiple PDFs or move around the
 * page order of PDFs. Is that something we could add?")
 *
 * Page surgery on a DRAFT e-sign document.
 *
 *   { id, owner?, add: { filename, pdfBase64 }, at? }
 *       Insert another PDF's pages before 1-based page `at`; omit `at` to
 *       append. Pages are added ONE FILE AT A TIME on purpose: a request body
 *       is capped near 6MB by the gateway, so uploading a pre-combined file
 *       would fail where appending the same pages one by one succeeds.
 *
 *   { id, owner?, order: [3, 1, 2] }
 *       Rebuild the document in that page order. A page left out of the list
 *       is deleted. Any field on a deleted page goes with it, and the response
 *       says how many, so the UI can warn before and confirm after.
 *
 * Draft-only, like every other edit: a sent document's SHA-256 is sealed into
 * each signer's audit record and printed on the certificate page, so its bytes
 * must never move under them.
 *
 * Fields are remapped by the same helper that moved the pages (see
 * _shared/esign-docs.mjs), never by a second copy of the arithmetic.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  readDoc, writeDoc, sanitizeDoc, docKey, docPdfStore, inspectPdf, pushHistory, baseUrl,
  insertPdfPages, reorderPdfPages, remapFieldPages, MAX_PDF_BYTES, MAX_DOC_BYTES,
} from './_shared/esign-docs.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);
const mb = (n) => (Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const body = await readJsonBody(req);
    if (!body || !body.id) return json(400, { error: 'id required' });

    const selfEmail = normalizeEmail(user.email);
    let ownerKey = keySafe(selfEmail);
    if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
      if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
      ownerKey = keySafe(normalizeEmail(body.owner));
    }
    const doc = await readDoc(ownerKey, body.id);
    if (!doc) return json(404, { error: 'Document not found' });
    if (doc.status !== 'draft') {
      return json(409, { error: 'Pages can only be changed while the document is a draft (this one is ' + doc.status + '). Cancel it and start a new draft to re-arrange pages.' });
    }

    const key = docKey(ownerKey, doc.id);
    const currentB64 = await docPdfStore().get(key, { type: 'text' }).catch(() => null);
    if (!currentB64) return json(404, { error: 'This document has no PDF on file' });
    const currentBytes = Buffer.from(currentB64, 'base64');

    let result = null, note = '', droppedFields = 0;

    // ── Add another PDF's pages ──
    if (body.add && typeof body.add === 'object') {
      const addB64 = String(body.add.pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '');
      if (!addB64) return json(400, { error: 'pdfBase64 required' });
      const addBytes = Buffer.from(addB64, 'base64');
      if (addBytes.length > MAX_PDF_BYTES) {
        return json(413, { error: 'That PDF is ' + mb(addBytes.length) + ' — a single file can be at most ' + mb(MAX_PDF_BYTES) + '. Add it in smaller pieces.' });
      }
      const filename = String(body.add.filename || 'document.pdf').replace(/[\\/:*?"<>|]+/g, '').slice(0, 200) || 'document.pdf';
      try { await inspectPdf(addB64); }
      catch (e) { return json(400, { error: 'That file is not a readable PDF (' + ((e && e.message) || 'parse failed') + ')' }); }

      try { result = await insertPdfPages(currentBytes, addBytes, body.at); }
      catch (e) { return json(400, { error: 'Could not add those pages: ' + ((e && e.message) || 'unknown') }); }

      if (result.bytes.length > MAX_DOC_BYTES) {
        return json(413, {
          error: 'Adding that would make the document ' + mb(result.bytes.length) + ', over the ' + mb(MAX_DOC_BYTES) +
                 ' limit. Compress the file, or send the extra pages as a second document.',
        });
      }
      const atEnd = result.at > ((doc.pdf && doc.pdf.pageCount) || 0);
      note = 'Added ' + result.addedCount + ' page' + (result.addedCount === 1 ? '' : 's') + ' from ' + filename +
             (atEnd ? ' at the end' : ' before page ' + result.at);
      doc.pdf = doc.pdf || {};
      // Remember what went in, so the history of an assembled document reads
      // like a table of contents rather than one opaque "document.pdf".
      doc.pdf.parts = (Array.isArray(doc.pdf.parts) ? doc.pdf.parts : [
        { filename: doc.pdf.filename || 'document.pdf', pages: (doc.pdf.pageCount || 0), at: 1 },
      ]).concat([{ filename, pages: result.addedCount, at: result.at }]);

    // ── Re-order / delete pages ──
    } else if (Array.isArray(body.order)) {
      try { result = await reorderPdfPages(currentBytes, body.order); }
      catch (e) { return json(400, { error: 'Could not re-arrange the pages: ' + ((e && e.message) || 'unknown') }); }
      note = 'Page order changed' + (result.dropped ? ' — ' + result.dropped + ' page' + (result.dropped === 1 ? '' : 's') + ' removed' : '');

    } else {
      return json(400, { error: 'Nothing to do — send add:{pdfBase64} or order:[…]' });
    }

    droppedFields = remapFieldPages(doc, result.remap);

    const newB64 = result.bytes.toString('base64');
    let info;
    try { info = await inspectPdf(newB64); }
    catch (e) { return json(500, { error: 'The re-built PDF could not be read back (' + ((e && e.message) || 'parse failed') + '). Nothing was changed.' }); }
    if (info.pageCount !== result.pageCount) {
      return json(500, { error: 'Page count did not come out as expected. Nothing was changed.' });
    }

    // Write the bytes FIRST: a doc record pointing at a PDF that never landed
    // is worse than a PDF the record has not caught up to yet.
    await docPdfStore().set(key, newB64);
    doc.pdf = Object.assign({}, doc.pdf, info);
    if (droppedFields) note += ' · ' + droppedFields + ' field' + (droppedFields === 1 ? '' : 's') + ' on removed pages deleted';
    pushHistory(doc, 'pages', note, selfEmail);
    await writeDoc(doc);

    return json(200, {
      ok: true,
      doc: sanitizeDoc(doc, { includeSignUrls: true, base: baseUrl(req) }),
      pageCount: info.pageCount,
      addedCount: result.addedCount || 0,
      at: result.at || 0,
      droppedPages: result.dropped || 0,
      droppedFields,
      bytes: result.bytes.length,
      maxDocBytes: MAX_DOC_BYTES,
    });
  } catch (e) {
    console.error('esign-doc-pages error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
