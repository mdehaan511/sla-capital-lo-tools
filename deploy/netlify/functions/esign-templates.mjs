/**
 * esign-templates.mjs — GET/POST /api/esign-templates
 *
 * Deploy 237.028 (Mike): reusable E-Sign layouts. A template is a PDF plus the
 * field layout plus signer ROLES (name/kind/order, no email) — "Borrower",
 * "Guarantor", "SLA Signer". Using a template stamps out a draft with the
 * fields in place and the roles waiting for real people.
 *
 * Templates are an ORG-WIDE library: every LO / processor sees every
 * template. Only the creator or an admin may edit or delete one.
 *
 * GET                        → { templates:[summary…] }
 * GET ?id=                   → { template } (full: roles + fields)
 * POST { name, fromDocId, fromOwner? }  → save an existing document's layout as a template
 * POST { name, filename, pdfBase64, roles?, fields?, sequential?, message? } → template from an upload
 * POST { action:'update', id, name?, roles?, fields?, sequential?, message? }
 * POST { action:'delete', id }
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  MAX_PDF_BYTES, readDoc, tplStore, tplPdfStore, docPdfStore, docKey, inspectPdf, newId,
  normalizeSigners, normalizeFields, fullName, SIGNER_COLORS, MAX_SIGNERS,
} from './_shared/esign-docs.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);

function summary(t) {
  return {
    id: t.id, name: t.name, ownerEmail: t.ownerEmail, ownerName: t.ownerName,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    pageCount: (t.pdf && t.pdf.pageCount) || 0, filename: (t.pdf && t.pdf.filename) || '',
    roles: (t.roles || []).map((r) => ({ id: r.id, name: r.name, kind: r.kind, order: r.order })),
    fieldCount: (t.fields || []).length, sequential: t.sequential !== false, useCount: t.useCount || 0,
  };
}

function normalizeRoles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_SIGNERS) throw new Error('At most ' + MAX_SIGNERS + ' roles');
  return list.map((r, i) => ({
    id: (r && r.id && /^s[0-9a-z_]{1,20}$/i.test(r.id)) ? r.id : ('s' + (i + 1)),
    name: String((r && (r.name || r.roleName)) || '').trim().slice(0, 60) || ('Signer ' + (i + 1)),
    kind: ['borrower', 'user', 'other'].indexOf(r && r.kind) >= 0 ? r.kind : 'borrower',
    order: Math.max(1, Math.min(MAX_SIGNERS, parseInt(r && r.order, 10) || 1)),
    color: (r && /^#[0-9a-f]{6}$/i.test(r.color || '')) ? r.color : SIGNER_COLORS[i % SIGNER_COLORS.length],
  }));
}

async function findTemplate(id) {
  const { blobs } = await tplStore().list();
  const hit = blobs.find(({ key }) => key.endsWith('/' + keySafe(String(id || ''))));
  if (!hit) return null;
  const t = await tplStore().get(hit.key, { type: 'json' }).catch(() => null);
  return t ? { t, key: hit.key } : null;
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const selfEmail = normalizeEmail(user.email);

    if (req.method === 'GET') {
      const url = new URL(req.url);
      const id = url.searchParams.get('id');
      if (id) {
        const found = await findTemplate(id);
        if (!found) return json(404, { error: 'Template not found' });
        return json(200, { template: found.t });
      }
      const { blobs } = await tplStore().list();
      const list = await Promise.all(blobs.map(({ key }) => tplStore().get(key, { type: 'json' }).catch(() => null)));
      const templates = list.filter(Boolean).map(summary).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return json(200, { templates });
    }

    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = await readJsonBody(req);
    if (!body) return json(400, { error: 'Invalid JSON body' });
    const now = new Date().toISOString();

    if (body.action === 'delete' || body.action === 'update') {
      const found = await findTemplate(body.id);
      if (!found) return json(404, { error: 'Template not found' });
      const t = found.t;
      if (t.ownerEmail !== selfEmail && !isAdmin(user)) return json(403, { error: 'Only the template creator or an admin can change it' });
      if (body.action === 'delete') {
        await tplPdfStore().delete(found.key).catch(() => {});
        await tplStore().delete(found.key);
        return json(200, { ok: true, deleted: true });
      }
      if (body.name !== undefined) t.name = String(body.name || '').trim().slice(0, 120) || t.name;
      if (body.message !== undefined) t.message = String(body.message || '').slice(0, 2000);
      if (body.sequential !== undefined) t.sequential = !!body.sequential;
      try {
        if (body.roles !== undefined) t.roles = normalizeRoles(body.roles);
        if (body.fields !== undefined) t.fields = normalizeFields(body.fields, t.roles).map((f) => { delete f.value; return f; });
      } catch (e) { return json(400, { error: e.message }); }
      t.updatedAt = now;
      await tplStore().setJSON(found.key, t);
      return json(200, { ok: true, template: t });
    }

    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) return json(400, { error: 'Template name required' });
    const tpl = {
      id: newId('est'), name,
      ownerEmail: selfEmail, ownerKey: keySafe(selfEmail), ownerName: fullName(user),
      createdAt: now, updatedAt: now, useCount: 0,
      pdf: null, roles: [], fields: [], sequential: true, message: '',
    };
    let pdfBase64 = null;

    if (body.fromDocId) {
      let ownerKey = keySafe(selfEmail);
      if (body.fromOwner && normalizeEmail(body.fromOwner) !== selfEmail) {
        if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
        ownerKey = keySafe(normalizeEmail(body.fromOwner));
      }
      const doc = await readDoc(ownerKey, body.fromDocId);
      if (!doc || !doc.pdf) return json(404, { error: 'Source document not found' });
      pdfBase64 = await docPdfStore().get(docKey(ownerKey, doc.id), { type: 'text' }).catch(() => null);
      if (!pdfBase64) return json(404, { error: 'Source PDF missing' });
      tpl.pdf = Object.assign({}, doc.pdf);
      tpl.sequential = doc.sequential !== false;
      tpl.message = String(doc.message || '');
      // Signers → roles. A borrower named "Jane Doe" becomes the role "Borrower 1".
      const counts = {};
      tpl.roles = (doc.signers || []).map((s, i) => {
        const base = s.roleName || (s.kind === 'user' ? 'SLA Signer' : s.kind === 'borrower' ? 'Borrower' : 'Signer');
        counts[base] = (counts[base] || 0) + 1;
        return { id: s.id, name: s.roleName || (base + ' ' + counts[base]), kind: s.kind, order: s.order || 1, color: s.color || SIGNER_COLORS[i % SIGNER_COLORS.length] };
      });
      tpl.fields = (doc.fields || []).map((f) => { const c = Object.assign({}, f); if (f.signerId !== 'sender') delete c.value; return c; });
    } else {
      pdfBase64 = String(body.pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '');
      if (!pdfBase64) return json(400, { error: 'pdfBase64 or fromDocId required' });
      if (Math.floor(pdfBase64.length * 3 / 4) > MAX_PDF_BYTES) return json(413, { error: 'PDF is too large' });
      let info;
      try { info = await inspectPdf(pdfBase64); } catch (e) { return json(400, { error: 'Not a readable PDF' }); }
      tpl.pdf = Object.assign({ filename: String(body.filename || 'template.pdf').slice(0, 200) }, info);
      try {
        tpl.roles = normalizeRoles(body.roles);
        tpl.fields = normalizeFields(body.fields, tpl.roles).map((f) => { if (f.signerId !== 'sender') delete f.value; return f; });
      } catch (e) { return json(400, { error: e.message }); }
      tpl.sequential = body.sequential !== false;
      tpl.message = String(body.message || '').slice(0, 2000);
    }
    const key = tpl.ownerKey + '/' + keySafe(tpl.id);
    await tplPdfStore().set(key, pdfBase64);
    await tplStore().setJSON(key, tpl);
    return json(200, { ok: true, template: tpl });
  } catch (e) {
    console.error('esign-templates error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
