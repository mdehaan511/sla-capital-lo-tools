/**
 * esign-doc-cancel.mjs — POST /api/esign-doc-cancel
 *
 * Deploy 237.022 (Mike): cancels a SENT document (every outstanding link dies,
 * status → cancelled, it stays in the Cancelled tab for the record), or
 * DELETES a draft / cancelled document outright (record + bytes).
 *
 * Body: { id, owner?, reason? }               → cancel a sent doc
 * Body: { id, owner?, delete: true }          → delete a draft or cancelled doc
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  readDoc, writeDoc, sanitizeDoc, retireToken, pushHistory, docKey,
  docsStore, docPdfStore, docFinalStore, docSigStore, esignIndex,
} from './_shared/esign-docs.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);

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
    const key = docKey(ownerKey, doc.id);

    if (body.delete) {
      if (doc.status !== 'draft' && doc.status !== 'cancelled') {
        return json(409, { error: 'Only drafts and cancelled documents can be deleted (this one is ' + doc.status + ')' });
      }
      for (const s of doc.signers || []) await retireToken(s);
      await Promise.all([
        docPdfStore().delete(key).catch(() => {}),
        docFinalStore().delete(key).catch(() => {}),
        ...(doc.signers || []).map((s) => docSigStore().delete(key + '/' + s.id).catch(() => {})),
      ]);
      await docsStore().delete(key);
      await esignIndex.removeRecord(ownerKey, doc.id).catch(() => {});
      return json(200, { ok: true, deleted: true });
    }

    if (doc.status === 'completed') return json(409, { error: 'A completed document cannot be cancelled' });
    if (doc.status === 'cancelled') return json(200, { ok: true, doc: sanitizeDoc(doc) });
    for (const s of doc.signers || []) await retireToken(s);
    doc.status = 'cancelled';
    doc.cancelledAt = new Date().toISOString();
    doc.cancelReason = String(body.reason || '').slice(0, 300);
    pushHistory(doc, 'cancelled', 'Cancelled' + (doc.cancelReason ? ': ' + doc.cancelReason : ''), selfEmail);
    await writeDoc(doc);
    return json(200, { ok: true, doc: sanitizeDoc(doc) });
  } catch (e) {
    console.error('esign-doc-cancel error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
