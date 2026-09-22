/**
 * esign-docs.mjs — GET/POST /api/esign-docs
 *
 * Deploy 237.028 (Mike): general-purpose E-Sign tool. See _shared/esign-docs.mjs
 * for the record model.
 *
 * GET  ?meta=1                 → { docTypes, consentVersion, maxPdfBytes, isStaff }
 * GET  ?id=&owner=             → { doc }  (full record, secrets stripped, live sign URLs)
 * GET  ?status=&all=1&loanId=  → { docs: [summary, …] }  own docs; staff may pass all=1;
 *                                loanId keeps docs started from / filed to that loan
 * POST { title, filename, pdfBase64 }            → { ok, doc }  new draft from an upload
 * POST { title, templateId }                     → { ok, doc }  new draft from a template
 *
 * Owner override (?owner= / body.owner) is admin/processor only, same rule as
 * every other owner-scoped endpoint.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  MAX_PDF_BYTES, MAX_DOC_BYTES, MAX_DIRECT_BYTES, TOKEN_TTL_DAYS, docTypeOptions, listSummaries, readDoc, writeDoc, sanitizeDoc, takeStaged,
  newId, docKey, docPdfStore, tplStore, tplPdfStore, inspectPdf, pushHistory, fullName, baseUrl,
  SIGNER_COLORS, normalizeLoanRef,
} from './_shared/esign-docs.mjs';
import { TERMSHEET_CONSENT_VERSION } from './_shared/native-esign.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const selfEmail = normalizeEmail(user.email);
    const url = new URL(req.url);

    if (req.method === 'GET') {
      if (url.searchParams.get('meta')) {
        return json(200, {
          docTypes: docTypeOptions(),
          consentVersion: TERMSHEET_CONSENT_VERSION,
          maxPdfBytes: MAX_PDF_BYTES,
          maxDirectBytes: MAX_DIRECT_BYTES, // Deploy 237.231 — above this the page uploads in slices
          maxDocBytes: MAX_DOC_BYTES,   // Deploy 237.168 — ceiling on an assembled document
          tokenTtlDays: TOKEN_TTL_DAYS,
          isStaff: staff(user),
          signerColors: SIGNER_COLORS,
        });
      }
      const id = url.searchParams.get('id');
      if (id) {
        const ownerParam = url.searchParams.get('owner');
        let ownerKey = keySafe(selfEmail);
        if (ownerParam && normalizeEmail(ownerParam) !== selfEmail) {
          if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
          ownerKey = keySafe(normalizeEmail(ownerParam));
        }
        const doc = await readDoc(ownerKey, id);
        if (!doc) return json(404, { error: 'Document not found' });
        return json(200, { doc: sanitizeDoc(doc, { includeSignUrls: true, base: baseUrl(req) }) });
      }
      const byOwner = await listSummaries();
      const all = url.searchParams.get('all') === '1' && staff(user);
      const status = String(url.searchParams.get('status') || '');
      let docs = [];
      if (all) {
        Object.keys(byOwner).forEach((ok) => { (byOwner[ok] || []).forEach((d) => docs.push(d)); });
      } else {
        docs = (byOwner[keySafe(selfEmail)] || []).slice();
      }
      if (status) docs = docs.filter((d) => d.status === status);
      const loanId = String(url.searchParams.get('loanId') || '');
      if (loanId) docs = docs.filter((d) => (d.loan && d.loan.loanId === loanId) || (d.assignment && d.assignment.loanId === loanId));
      docs.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      return json(200, { docs, scope: all ? 'all' : 'self' });
    }

    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await readJsonBody(req);
    if (!body) return json(400, { error: 'Invalid JSON body' });

    let ownerKey = keySafe(selfEmail);
    let ownerEmail = selfEmail;
    if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
      if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
      ownerEmail = normalizeEmail(body.owner);
      ownerKey = keySafe(ownerEmail);
    }

    const now = new Date().toISOString();
    const doc = {
      id: newId('esd'),
      ownerKey, ownerEmail,
      ownerName: ownerEmail === selfEmail ? fullName(user) : ownerEmail,
      createdBy: selfEmail,
      title: String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      status: 'draft',
      pdf: null,
      signers: [], fields: [],
      sequential: true,
      message: '',
      createdAt: now, updatedAt: now,
      sentAt: null, completedAt: null, cancelledAt: null,
      history: [],
      assignment: null, suggestion: null, suggestionState: null,
      templateId: null, templateName: '',
      // Deploy 237.029 — optional loan the document was started from.
      loan: normalizeLoanRef(body.loan),
    };

    let pdfBase64 = null;
    if (body.templateId) {
      // Templates are an org-wide library: any staff or LO may instantiate any template.
      const { blobs } = await tplStore().list();
      let tpl = null;
      for (const { key } of blobs) {
        if (key.endsWith('/' + keySafe(String(body.templateId)))) {
          tpl = await tplStore().get(key, { type: 'json' }).catch(() => null);
          if (tpl) { pdfBase64 = await tplPdfStore().get(key, { type: 'text' }).catch(() => null); }
          break;
        }
      }
      if (!tpl || !pdfBase64) return json(404, { error: 'Template not found' });
      doc.templateId = tpl.id;
      doc.templateName = tpl.name || '';
      if (!doc.title) doc.title = tpl.name || 'Untitled document';
      doc.pdf = Object.assign({}, tpl.pdf);
      doc.sequential = tpl.sequential !== false;
      doc.message = String(tpl.message || '');
      // Roles become signers with the name/email left for the LO to fill in.
      doc.signers = (tpl.roles || []).map((r, i) => ({
        id: r.id || ('s' + (i + 1)), name: '', email: '', kind: r.kind || 'borrower', order: r.order || 1,
        color: r.color || SIGNER_COLORS[i % SIGNER_COLORS.length], roleName: r.name || ('Signer ' + (i + 1)),
        token: null, tokenExpiresAt: null, invitedAt: null, signedAt: null, viewedAt: null, audit: null, resendCount: 0,
      }));
      doc.fields = JSON.parse(JSON.stringify(tpl.fields || []));
      pushHistory(doc, 'created', 'Created from template "' + doc.templateName + '"', selfEmail);
    } else {
      // Deploy 237.231 — a large file arrives in slices (esign-doc-upload-chunk)
      // and is referenced here by its stagedId; a small one still rides inline.
      if (body.stagedId) {
        pdfBase64 = await takeStaged(ownerKey, body.stagedId);
        if (!pdfBase64) return json(400, { error: 'That upload is no longer available — please choose the file again.' });
      } else {
        pdfBase64 = String(body.pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '');
      }
      if (!pdfBase64) return json(400, { error: 'pdfBase64 required' });
      const approxBytes = Math.floor(pdfBase64.length * 3 / 4);
      if (approxBytes > MAX_PDF_BYTES) return json(413, { error: 'PDF is too large — the limit is ' + Math.round(MAX_PDF_BYTES / 1024 / 1024 * 10) / 10 + ' MB' });
      let info;
      try { info = await inspectPdf(pdfBase64); }
      catch (e) { return json(400, { error: 'That file is not a readable PDF (' + ((e && e.message) || 'parse failed') + ')' }); }
      if (!info.pageCount) return json(400, { error: 'PDF has no pages' });
      const filename = String(body.filename || 'document.pdf').replace(/[\\/:*?"<>|]+/g, '').slice(0, 200) || 'document.pdf';
      doc.pdf = Object.assign({ filename }, info);
      if (!doc.title) doc.title = filename.replace(/\.pdf$/i, '') || 'Untitled document';
      pushHistory(doc, 'created', 'Uploaded ' + filename + ' (' + info.pageCount + ' page' + (info.pageCount === 1 ? '' : 's') + ')', selfEmail);
    }

    await docPdfStore().set(docKey(ownerKey, doc.id), pdfBase64);
    await writeDoc(doc);
    return json(200, { ok: true, doc: sanitizeDoc(doc) });
  } catch (e) {
    console.error('esign-docs error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
