/**
 * loan-application-pdf-unsigned.mjs — GET /api/loan-application-pdf-unsigned
 *
 * Deploy 231 — generate an UNSIGNED internal-use Loan Application PDF
 * for a loan whose long-form application was filled on behalf of the
 * borrower (via the LO's "Save on behalf of client" flow). Renders the
 * same template as the signed version (Section A through Declarations,
 * the new Loan Details + Estimated Fees + Disclaimer blocks from
 * Deploy 230, etc.) but stamps each signature spot with "[UNSIGNED —
 * Filled by LO on behalf of borrower]" and replaces the cryptographic
 * audit trail with an "Application Entry Record" naming the LO who
 * triggered the generation.
 *
 * Auth: any authenticated user (admin override via ?owner=).
 * Query: clientId, loanId, owner? (admin only)
 *
 * Response: PDF binary attachment.
 *
 * Distinct from /api/signed-application-get because:
 *   - That endpoint reads a pre-generated PDF blob (stored at sign time).
 *   - This endpoint renders fresh from current borrower_info data so
 *     LOs can pull a snapshot any time the data changes.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { newRecordKey, loadRecord } from './_shared/borrower-info-keys.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-application-pdf-unsigned error:', e);
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
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  // Owner resolution. Admin override allowed.
  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  // Load the client record (for entity fallback + propertyAddress).
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${ownerKey}/${keySafe(clientId)}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client) return json(404, { error: 'Client not found' });

  // Load the borrower_info record. Need data to render anything
  // meaningful. The newRecordKey helper handles the Deploy 168
  // per-loan key format AND falls back to legacy per-client key
  // (loadRecord encapsulates both paths).
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(biStore, ownerKey, clientId, loanId, client);
  if (!record) return json(404, { error: 'No long-form application data on file for this loan' });

  // Build the signers array from borrower_info data. Each "signer" is
  // a guarantor; their audit is null because nobody signed. The PDF
  // renderer in unsigned mode treats audit=null as the "Unsigned"
  // stamp variant.
  const guarantors = (record.data && Array.isArray(record.data.guarantors))
    ? record.data.guarantors
    : [];
  const signers = guarantors
    .slice(0, 2)
    .filter((g) => g && (g.firstName || g.lastName || g.email))
    .map((g, idx) => ({
      role:  idx === 0 ? 'borrower1' : 'borrower2',
      name:  ((g.firstName || '') + ' ' + (g.lastName || '')).trim(),
      email: g.email || '',
      audit: null,
      signedAuths: [],
    }));
  // Fall back to client.firstName/lastName when no guarantor was filled
  // (data captured only via the LO's edit-on-behalf save without going
  // through the full guarantor section).
  if (signers.length === 0) {
    signers.push({
      role:  'borrower1',
      name:  ((client.firstName || '') + ' ' + (client.lastName || '')).trim(),
      email: client.email || '',
      audit: null,
      signedAuths: [],
    });
  }

  // "Entered By" — the LO who triggered the generation. Pull display
  // name from Netlify Identity metadata.
  const meta = (user && user.user_metadata) || {};
  const enteredBy = {
    name:  meta.full_name || meta.fullName || user.email || '',
    email: user.email || '',
    at:    new Date().toISOString(),
  };

  // Deploy 236.221 — Phase 4: locate the loan on the client record
  // so the renderer can prefer loan-level values (loanAmt,
  // purchasePrice, etc.) over the long-app snapshot. Undefined loan
  // → renderer falls back to data.* as before.
  const _loan = Array.isArray(client.loans)
    ? client.loans.find((l) => l && l.id === loanId)
    : null;

  let pdfBuffer;
  try {
    pdfBuffer = await renderSignedApplicationPDF({
      record,
      client,
      loan: _loan,
      signers,
      status: 'unsigned',
      unsigned: true,
      enteredBy,
    });
  } catch (e) {
    console.error('loan-application-pdf-unsigned: render failed:', e);
    return json(500, { error: 'Failed to render PDF: ' + (e.message || 'unknown') });
  }

  // Filename: borrower last name or property address fragment, plus date.
  const lastName = (signers[0] && signers[0].name && signers[0].name.split(' ').slice(-1)[0]) || 'borrower';
  const datePart = new Date().toISOString().slice(0, 10);
  const filename = ('SLA_Loan_Application_UNSIGNED_' + lastName + '_' + datePart + '.pdf')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');

  return new Response(pdfBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
