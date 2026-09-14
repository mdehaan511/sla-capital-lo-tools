/**
 * esign-doc-pdf.mjs — GET /api/esign-doc-pdf
 *
 * Deploy 237.022 (Mike): streams PDF bytes to the E-Sign editor / detail page.
 *   ?id=&owner=&which=original   the uploaded PDF (editor render)
 *   ?id=&owner=&which=final      the executed PDF (completed docs only)
 *   ?templateId=                 a template's PDF (editor render)
 * Auth: the owner, or admin / processor. Final-PDF reads are PII-audited like
 * envelope-final-pdf.
 */
import {
  handleOptions, json, requireAuth, isAdmin, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { logPiiAccess } from './_shared/pii-audit.mjs';
import {
  readDoc, docKey, docPdfStore, docFinalStore, tplStore, tplPdfStore, safeFilename,
} from './_shared/esign-docs.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);

function pdfResponse(b64, filename, inline) {
  const bytes = Buffer.from(b64, 'base64');
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.length),
      'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename="' + filename + '"',
      'Cache-Control': 'private, no-cache',
    },
  });
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const url = new URL(req.url);

    const templateId = url.searchParams.get('templateId');
    if (templateId) {
      const { blobs } = await tplStore().list();
      const hit = blobs.find(({ key }) => key.endsWith('/' + keySafe(templateId)));
      if (!hit) return json(404, { error: 'Template not found' });
      const b64 = await tplPdfStore().get(hit.key, { type: 'text' }).catch(() => null);
      if (!b64) return json(404, { error: 'Template PDF missing' });
      return pdfResponse(b64, 'template.pdf', true);
    }

    const id = url.searchParams.get('id');
    if (!id) return json(400, { error: 'id required' });
    const selfEmail = normalizeEmail(user.email);
    const ownerParam = url.searchParams.get('owner');
    let ownerKey = keySafe(selfEmail);
    if (ownerParam && normalizeEmail(ownerParam) !== selfEmail) {
      if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
      ownerKey = keySafe(normalizeEmail(ownerParam));
    }
    const doc = await readDoc(ownerKey, id);
    if (!doc) return json(404, { error: 'Document not found' });
    const which = url.searchParams.get('which') === 'final' ? 'final' : 'original';
    const key = docKey(ownerKey, doc.id);
    if (which === 'final') {
      if (doc.status !== 'completed') return json(409, { error: 'Document is not completed yet' });
      const b64 = await docFinalStore().get(key, { type: 'text' }).catch(() => null);
      if (!b64) return json(404, { error: 'Executed PDF not on file' });
      logPiiAccess(req, context, { action: 'download', resource: 'esign_final_pdf', actorEmail: selfEmail, ownerEmail: doc.ownerEmail || '', resourceId: doc.id }).catch(() => {});
      return pdfResponse(b64, safeFilename(doc.title) + ' - signed.pdf', url.searchParams.get('inline') === '1');
    }
    const b64 = await docPdfStore().get(key, { type: 'text' }).catch(() => null);
    if (!b64) return json(404, { error: 'PDF not on file' });
    return pdfResponse(b64, safeFilename(doc.title) + '.pdf', true);
  } catch (e) {
    console.error('esign-doc-pdf error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
