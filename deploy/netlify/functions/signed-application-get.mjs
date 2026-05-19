/**
 * signed-application-get.mjs — GET /api/signed-application
 *
 * Deploy 179. LO-authed endpoint. Returns either the signed PDF
 * binary (default) or the audit metadata as JSON depending on the
 * `?meta=1` query parameter. The audit metadata view powers the
 * "Signed Application" panel on Loan Details (showing signer name,
 * signed at, IP, etc.); the PDF view is the Download button.
 *
 * Query params:
 *   clientId    (required)
 *   loanId      (required)
 *   owner       (admin cross-LO override)
 *   meta=1      return JSON with audit only; otherwise return the PDF
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, isAdmin, keySafe,
} from './_shared/auth.mjs';
import { verifyAudit } from './_shared/esign.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('signed-application-get error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const loanId   = url.searchParams.get('loanId');
  const wantMeta = url.searchParams.get('meta') === '1';
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'signed_applications', consistency: 'strong' });
  const key = `${ownerKey}/${keySafe(clientId)}/${keySafe(loanId)}`;
  let rec = null;
  try { rec = await store.get(key, { type: 'json' }); } catch (_) {}
  if (!rec) return json(404, { error: 'No signed application on file for this loan' });

  if (wantMeta) {
    // Return metadata only — no PDF binary. Validates the seal so the
    // UI can show "tamper-evident: ✓" or warn if invalid.
    const sealValid = verifyAudit(rec.audit);
    return json(200, {
      clientId: rec.clientId,
      loanId: rec.loanId,
      borrowerEmail: rec.borrowerEmail,
      propertyAddress: rec.propertyAddress,
      audit: rec.audit,
      pdfSize: rec.pdfSize,
      createdAt: rec.createdAt,
      sealValid,
    });
  }

  // PDF binary response. Headers set so the browser shows a download
  // dialog with a sensible filename.
  if (!rec.pdfBase64) return json(404, { error: 'PDF not found in record' });
  const filenameSafe = (rec.propertyAddress || 'signed-application')
    .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 80);
  const pdfBytes = Buffer.from(rec.pdfBase64, 'base64');
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdfBytes.length),
      'Content-Disposition': `attachment; filename="${filenameSafe}_SLA_Signed_Application.pdf"`,
      'Cache-Control': 'private, no-cache',
    },
  });
}
