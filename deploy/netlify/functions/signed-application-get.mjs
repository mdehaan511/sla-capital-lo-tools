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
import { logPiiAccess } from './_shared/pii-audit.mjs';   // Deploy 236.456 (F3)

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

  const user = await requireAuth(context, req);
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
    // Deploy 180: records have two shapes in the wild:
    //   - Old (Deploy 179): { audit, borrowerEmail, ... }     single-signer
    //   - New (Deploy 180): { borrower1: {audit, email, ...}, borrower2: null | {audit?, ...},
    //                         status, numBorrowers, ... }
    // We surface both shapes here so the loan-details UI keeps
    // working without changes. The UI reads `meta.audit` for the
    // status pane — we mirror borrower1.audit there. New UI code
    // can opt into reading borrower1/borrower2/status directly.
    const b1 = rec.borrower1 || null;
    const b2 = rec.borrower2 || null;
    const primaryAudit = (b1 && b1.audit) || rec.audit || null;
    const sealValid = primaryAudit ? verifyAudit(primaryAudit) : false;
    const b2SealValid = (b2 && b2.audit) ? verifyAudit(b2.audit) : null;
    return json(200, {
      clientId: rec.clientId,
      loanId: rec.loanId,
      // Backward-compat fields (Deploy 179 UI)
      borrowerEmail: (b1 && b1.email) || rec.borrowerEmail || '',
      audit: primaryAudit,
      // New fields (Deploy 180)
      status: rec.status || 'complete',
      numBorrowers: rec.numBorrowers || 1,
      borrower1: b1 ? {
        name: b1.name, email: b1.email, audit: b1.audit, signedAuths: b1.signedAuths,
      } : null,
      borrower2: b2 ? {
        name: b2.name, email: b2.email,
        invitedAt: b2.invitedAt, tokenExpiresAt: b2.tokenExpiresAt,
        audit: b2.audit, signedAuths: b2.signedAuths,
        hasPendingSignature: !b2.audit || !b2.audit.signedAt,
      } : null,
      // Common
      propertyAddress: rec.propertyAddress,
      pdfSize: rec.pdfSize,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt || rec.createdAt,
      sealValid,
      b2SealValid,
    });
  }

  // PDF binary response. Headers set so the browser shows a download
  // dialog with a sensible filename.
  if (!rec.pdfBase64) return json(404, { error: 'PDF not found in record' });
  const filenameSafe = (rec.propertyAddress || 'signed-application')
    .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 80);
  const pdfBytes = Buffer.from(rec.pdfBase64, 'base64');
  // Deploy 236.456 (F3) — audit the signed-app PDF disclosure (not the
  // meta=1 status peek above, which returns no PII payload). Fail-open.
  await logPiiAccess(req, context, {
    action: 'doc_download', resource: 'signed_application',
    actorEmail: user.email, actorRole: isAdmin(user) ? 'admin' : 'lo',
    ownerEmail: owner, clientId, loanId,
    detail: filenameSafe + '_SLA_Signed_Application.pdf',
  });
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
