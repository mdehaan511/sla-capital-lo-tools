/**
 * esign-doc-save.mjs — POST /api/esign-doc-save
 *
 * Deploy 237.028 (Mike): saves the editor state of a DRAFT e-sign document.
 * Body: { id, owner?, title?, signers?, fields?, sequential?, message? }
 * Signers keep their lifecycle fields (token / signedAt / …) by id; fields are
 * replaced wholesale (the editor owns the layout). Only drafts are editable —
 * a sent document's layout is what the signers are looking at.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  readDoc, writeDoc, sanitizeDoc, normalizeSigners, normalizeFields, pushHistory, baseUrl,
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
    if (doc.status !== 'draft') return json(409, { error: 'Only drafts can be edited (this document is ' + doc.status + ')' });

    if (body.title !== undefined) doc.title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 160) || doc.title;
    if (body.message !== undefined) doc.message = String(body.message || '').slice(0, 2000);
    if (body.sequential !== undefined) doc.sequential = !!body.sequential;

    if (body.signers !== undefined) {
      let normalized;
      try { normalized = normalizeSigners(body.signers); }
      catch (e) { return json(400, { error: e.message }); }
      const prev = {};
      (doc.signers || []).forEach((s) => { prev[s.id] = s; });
      doc.signers = normalized.map((s) => {
        const p = prev[s.id] || {};
        return Object.assign({
          token: null, tokenExpiresAt: null, invitedAt: null, signedAt: null, viewedAt: null, audit: null, resendCount: 0,
          roleName: p.roleName || '',
        }, p, s);
      });
    }
    if (body.fields !== undefined) {
      try { doc.fields = normalizeFields(body.fields, doc.signers); }
      catch (e) { return json(400, { error: e.message }); }
      // Pages must exist on the PDF.
      const pc = (doc.pdf && doc.pdf.pageCount) || 1;
      doc.fields = doc.fields.filter((f) => f.page >= 1 && f.page <= pc);
    }
    pushHistory(doc, 'saved', 'Draft saved', selfEmail);
    // Keep the history from ballooning on autosave: collapse consecutive saves.
    if (doc.history.length >= 2) {
      const a = doc.history[doc.history.length - 2], b = doc.history[doc.history.length - 1];
      if (a.event === 'saved' && b.event === 'saved') doc.history.splice(doc.history.length - 2, 1);
    }
    await writeDoc(doc);
    return json(200, { ok: true, doc: sanitizeDoc(doc, { includeSignUrls: true, base: baseUrl(req) }) });
  } catch (e) {
    console.error('esign-doc-save error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
