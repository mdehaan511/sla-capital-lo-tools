/**
 * loan-bundle-download.mjs — GET /api/loan-bundle-download
 *
 * Deploy 236.148 — single regenerated Loan Application PDF with
 * ALL guarantors (primary + additional sub-form guarantors)
 * merged into the same document, followed by each additional
 * guarantor's signed Credit Authorization.
 *
 * Per Mike: "I want the whole Application PDF modified to insert
 * the additional guarantor into the loan application. Should look
 * just like this one after the other with guarantor 2, guarantor
 * 3, etc..."
 *
 * Output PDF structure (no cover page):
 *   - Regenerated Loan Application PDF rendered via
 *     renderSignedApplicationPDF() with data.guarantors[] holding
 *     positions 0/1/2/3 — so the Guarantor Info, Entity
 *     Information (% ownership rows), and Declarations columns
 *     all show up naturally in their long-app slots.
 *   - Each additional sub-form guarantor's signed Credit
 *     Authorization PDF pages, in guarantor order.
 *
 * Data sources, in order of preference:
 *   1. borrower_info record (the long-app submission) — has the
 *      complete property/loan/borrower data shape natively.
 *   2. Synthesized from the loan record + primary client when no
 *      borrower_info exists yet (long-app hasn't been completed).
 *
 * Additional guarantors (loan.guarantorClientIds) are flattened
 * into the long-app shape via synthRecordForGuarantor() and
 * appended to data.guarantors[] in open slots (positions 1, 2, 3
 * — whichever isn't already filled by the long-app data).
 *
 * The original signed PDF in signed_applications is NOT included
 * in the bundle — Mike asked for the MODIFIED PDF, not a
 * concatenation. The signed PDF remains in storage as the legal
 * artifact and is downloadable separately via the existing
 * "Download Signed Application (PDF)" button.
 *
 * Query: ?clientId=...&loanId=...&owner=...
 * Response: application/pdf
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail, corsHeaders,
} from './_shared/auth.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';
import { synthRecordForGuarantor } from './_shared/guarantor-synth.mjs';
import { loadRecord } from './_shared/borrower-info-keys.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-bundle-download top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get('clientId') || '').trim();
  const loanId   = String(url.searchParams.get('loanId')   || '').trim();
  const ownerP   = String(url.searchParams.get('owner')    || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (ownerP && ownerP !== selfEmail && ownerP !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(ownerP));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore   = getStore({ name: 'clients',                       consistency: 'strong' });
  const biStore        = getStore({ name: 'borrower_info',                 consistency: 'strong' });
  const signedAppStore = getStore({ name: 'signed_applications',           consistency: 'strong' });

  const primary = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
  if (!primary) return json(404, { error: 'Primary client not found' });
  const loan = Array.isArray(primary.loans) ? primary.loans.find((l) => l && l.id === loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found on primary client' });

  // ── 1. Build the base record ────────────────────────────
  // Prefer the long-app borrower_info record (full data shape).
  // Fall back to a synthesized record from the loan + primary
  // client data if the long-app hasn't been completed.
  let record = null;
  try {
    record = await loadRecord(biStore, ownerKey, clientId, loanId, primary);
  } catch (e) {
    console.warn('loan-bundle-download: borrower_info load failed:', e && e.message);
  }
  if (!record) {
    record = synthRecordForGuarantor({
      guarantor: primary, loan, primary, ownerKey, asGuarantorIndex: 0,
    });
  }
  // Defensive copy so we don't mutate the borrower_info record.
  record = JSON.parse(JSON.stringify(record));
  record.data = record.data || {};
  record.data.guarantors = Array.isArray(record.data.guarantors) ? record.data.guarantors.slice() : [];

  // ── 2. Append additional sub-form guarantors ────────────
  const additionalGids = (Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [])
    .filter((gid) => gid && gid !== clientId);

  // Cap at 4 guarantor slots total (renderer supports g0..g3).
  const MAX_GUARANTORS = 4;

  // Already-occupied slots: any non-empty entries from the
  // long-app record. The primary's data is always in slot 0;
  // a long-app co-borrower (if any) is in slot 1.
  const additionalRecords = []; // { guarantor, subState, slotIdx }
  for (let i = 0; i < additionalGids.length; i++) {
    if (record.data.guarantors.length >= MAX_GUARANTORS) break;
    const gid = additionalGids[i];
    let guarantor;
    try { guarantor = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' }); }
    catch (_) {}
    if (!guarantor) continue;
    const flat = _flattenGuarantorForLongApp(guarantor, loan);
    const slotIdx = record.data.guarantors.length;
    record.data.guarantors.push(flat);
    const subState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[loanId]) || {};
    additionalRecords.push({ guarantor, subState, slotIdx });
  }

  // ── 3. Build signers list from the original signed record ──
  // Only include borrower1-4 entries that actually signed (have
  // an audit block with signedAt). These signers participate in
  // ALL the long-app signature sections (ESIGN consent, Loan
  // Acknowledgement, Prequal Credit & Background Check, Info
  // Release) and the audit trail.
  let signers = [];
  let signedAppRec = null;
  try {
    const signedKey = ownerKey + '/' + keySafe(clientId) + '/' + keySafe(loanId);
    signedAppRec = await signedAppStore.get(signedKey, { type: 'json' });
  } catch (_) {}
  if (signedAppRec) {
    ['borrower1', 'borrower2', 'borrower3', 'borrower4'].forEach((roleKey) => {
      const block = signedAppRec[roleKey];
      if (block && block.audit && block.audit.signedAt) {
        signers.push({
          role:          block.role || roleKey,
          name:          block.name || '',
          email:         block.email || '',
          audit:         block.audit,
          signedAuths:   block.signedAuths || [],
        });
      }
    });
  }
  // Deploy 236.149 — additional sub-form guarantors get appended
  // to signers with prequalOnly: true. The renderer's ESIGN /
  // Loan Acknowledgement / Info-Release loops skip them (they
  // didn't sign those), but the Prequal Credit & Background
  // Check loop INCLUDES them — so their Credit Authorization
  // renders inline as a long-app-format page (matching the
  // primary's) instead of being appended as a separate
  // narrower-format PDF afterwards.
  for (const entry of additionalRecords) {
    const audit = entry.subState && entry.subState.creditAuthAudit;
    if (!audit || !audit.signedAt) continue;
    // Map the guarantor's slot in data.guarantors to the
    // matching borrowerN role label.
    const roleKey = 'borrower' + (entry.slotIdx + 1); // slot 1 → borrower2, etc.
    signers.push({
      role:        roleKey,
      name:        audit.signerName || (((entry.guarantor.firstName || '') + ' ' + (entry.guarantor.lastName || '')).trim()),
      email:       audit.signerEmail || entry.guarantor.email || '',
      audit:       audit,
      signedAuths: ['prequal_credit'],
      prequalOnly: true,
    });
  }

  // ── 4. Render the merged loan-application PDF ────────────
  let appPdfBytes;
  const unsigned = signers.length === 0;
  try {
    appPdfBytes = await renderSignedApplicationPDF({
      record,
      client: primary,
      signers,
      status: 'complete',
      unsigned,
      enteredBy: unsigned ? {
        name:  (user.user_metadata && user.user_metadata.full_name) || selfEmail,
        email: selfEmail,
        at:    new Date().toISOString(),
      } : {},
    });
  } catch (e) {
    console.error('loan-bundle-download: render failed:', e);
    return json(500, { error: 'Failed to render application: ' + (e.message || 'unknown') });
  }

  // Deploy 236.149 — sub-form Credit Auth PDFs are no longer
  // appended separately. Additional guarantors are now passed
  // as prequalOnly signers above, which causes the long-app
  // renderer to inline a Prequal Credit & Background Check
  // page for each of them in the exact same format as the
  // primary's — eliminating the "Guarantor 2 looks different
  // from Guarantor 1" issue.
  const outBytes = appPdfBytes;

  // Deploy 236.152 — filename uses the property's street portion
  // (everything before the first comma in loan.address), per Mike:
  // "Loan Application bundles download with the name of Loan
  // Address (meaning Street number and name) then '- Loan
  // Application'". Falls back to slaDisplayId / loanId only when
  // no address is on file. Filesystem-illegal chars are stripped
  // so the browser save dialog accepts the suggested name on
  // every OS (Windows is the strict one).
  const rawAddr = String(loan.address || '').trim();
  const street = rawAddr ? rawAddr.split(',')[0].trim() : '';
  const safeStreet = street
    .replace(/[<>:"|?*\\\/\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const filename = (safeStreet
    ? safeStreet + ' - Loan Application'
    : 'Loan Application - ' + (loan.slaDisplayId || loanId)) + '.pdf';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':        'application/pdf',
    'Content-Length':      String(outBytes.length),
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control':       'private, no-store',
  });
  return new Response(outBytes, { status: 200, headers });
}

// Flatten a client record (with nested homeAddress, declarations,
// etc.) into the flat shape the long-app PDF renderer reads from
// data.guarantors[i]. Same field mapping as guarantor-synth's
// internal flattener, but inlined here so we can pull per-loan
// ownership from the loan record.
function _flattenGuarantorForLongApp(g, loan) {
  g = g || {};
  const ha   = g.homeAddress    || {};
  const pa   = g.prevAddress    || {};
  const ma   = g.mailingAddress || {};
  const decl = g.declarations   || {};
  const ownership =
    (loan && loan.guarantorOwnership && loan.guarantorOwnership[g.id]) ||
    g.ownership || '';
  return {
    firstName:        g.firstName || '',
    lastName:         g.lastName  || '',
    email:            g.email     || '',
    phone:            g.phone     || '',
    dob:              g.dob       || '',
    fico:             g.fico      || '',
    ssn_enc:          g.ssn_enc   || '',
    ssn:              g.ssn       || '',
    marital:          g.maritalStatus || g.marital || '',
    usCitizen:        g.usCitizen || '',
    flips:            g.flips     || '',
    rentals:          g.rentals   || '',
    ownership,
    address:          ha.street || '',
    city:             ha.city   || '',
    state:            ha.state  || '',
    zip:              ha.zip    || '',
    twoYearAddress:   g.twoYearAddress || '',
    prevAddress:      pa.street || '',
    prevCity:         pa.city   || '',
    prevState:        pa.state  || '',
    prevZip:          pa.zip    || '',
    mailingSameAsHome: g.mailingSameAsHome || '',
    mailingAddress:   ma.street || '',
    mailingCity:      ma.city   || '',
    mailingState:     ma.state  || '',
    mailingZip:       ma.zip    || '',
    bankruptcy7yr:         decl.bankruptcy7yr         || '',
    foreclosure7yr:        decl.foreclosure7yr        || '',
    partyToLawsuit:        decl.partyToLawsuit        || '',
    delinquentFederalDebt: decl.delinquentFederalDebt || '',
    obligatedToForeclosed: decl.obligatedToForeclosed || '',
    outstandingJudgments:  decl.outstandingJudgments  || '',
    intendToOccupy:        decl.intendToOccupy        || '',
  };
}

