/**
 * signed-app-regenerate.mjs — Deploy 236.55
 *
 * Helper that regenerates the stored signed-application PDF after an LO
 * edits data on a record that has already been e-signed. Common case:
 * borrower made a typo, the LO opens the application in review mode,
 * fixes the typo, saves. Without this helper the signed PDF still shows
 * the typo because it was rendered once at sign time and never refreshed.
 *
 * What we DO regenerate:
 *   - The visible data on the rendered PDF (form fields, addresses,
 *     income / declaration answers, property details, etc.)
 *
 * What we DO NOT change:
 *   - The signer audit blocks (borrower1 / borrower2 names, emails,
 *     signed-at timestamps, IP, user agent, dataHash, audit seal). These
 *     are passed verbatim into the re-render, so the Signatures page of
 *     the PDF still proves WHO signed WHEN with what was originally
 *     attested to.
 *   - The status (awaiting_borrower2 vs complete). We just re-render at
 *     whatever state the signed record was already in.
 *
 * We append a `corrections[]` audit trail to the signed_applications
 * record so anyone reviewing later can see who corrected what and when.
 * The caller is responsible for separately logging the regen on the
 * loan's notesLog (audit log on Loan Details).
 */
import { getStore } from '@netlify/blobs';
import { renderSignedApplicationPDF } from './loan-application-pdf.mjs';

const SIGNED_STORE = 'signed_applications';
const CLIENTS_STORE = 'clients';

function safeKey(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildSignedKey(ownerKey, clientId, loanId) {
  return `${ownerKey}/${safeKey(clientId)}/${safeKey(loanId || '_no_loan')}`;
}

/**
 * regenerateSignedApplicationPDF — re-render + replace the stored signed
 * application PDF using the LATEST record data. Returns a diagnostic
 * object the caller can log; never throws.
 *
 * @param {object} record — the borrower_info record (latest, post-save)
 * @param {string} editor — email of the LO who triggered the regen
 * @returns {object} { ok, regenerated?, reason?, signedKey?, corrections? }
 */
export async function regenerateSignedApplicationPDF(record, editor) {
  if (!record || !record.ownerKey || !record.clientId) {
    return { ok: false, reason: 'missing_ownerKey_or_clientId' };
  }

  const signedKey = buildSignedKey(record.ownerKey, record.clientId, record.loanId);
  const signedStore = getStore({ name: SIGNED_STORE, consistency: 'strong' });

  let signedRecord;
  try {
    signedRecord = await signedStore.get(signedKey, { type: 'json' });
  } catch (e) {
    return { ok: false, reason: 'load_failed: ' + (e && e.message) };
  }
  if (!signedRecord) {
    // Application has never been signed (or no signed PDF exists for this
    // loan). Nothing to regenerate — caller can treat this as a no-op.
    return { ok: false, reason: 'no_signed_record' };
  }

  // Load the client for the PDF (entity-name fallback, contact-card
  // header, etc.). Best-effort: if missing, the renderer can still emit
  // a useful document from the record alone.
  let client = null;
  try {
    const clientsStore = getStore({ name: CLIENTS_STORE, consistency: 'strong' });
    const ckey = `${record.ownerKey}/${safeKey(record.clientId)}`;
    client = await clientsStore.get(ckey, { type: 'json' });
  } catch (_) { /* non-fatal */ }

  // Build signers array from the existing signed record. Pass the
  // original audit blocks verbatim — we are NOT re-signing, just
  // re-rendering with corrected data. The seal stays valid as proof of
  // what was originally attested to; the visible data text just gets
  // refreshed to whatever the LO corrected.
  const signers = [];
  if (signedRecord.borrower1) signers.push(signedRecord.borrower1);
  if (signedRecord.borrower2) signers.push(signedRecord.borrower2);
  if (signers.length === 0) {
    return { ok: false, reason: 'no_signers_in_signed_record' };
  }

  // Deploy 236.221 Phase 4 — locate the loan on the client record so
  // renderer can prefer canonical loan values over the long-app snapshot
  // whenever the LO has inline-edited on Loan Details since signing.
  const _regenLoan = (client && Array.isArray(client.loans) && record.loanId)
    ? client.loans.find((l) => l && l.id === record.loanId)
    : null;

  let pdfBuffer;
  try {
    pdfBuffer = await renderSignedApplicationPDF({
      record,
      client,
      loan: _regenLoan,
      status: signedRecord.status || 'complete',
      signers,
    });
  } catch (e) {
    console.error('signed-app regen: PDF render failed:', e);
    return { ok: false, reason: 'render_failed: ' + (e && e.message) };
  }

  const now = new Date().toISOString();
  signedRecord.pdfBase64 = pdfBuffer.toString('base64');
  signedRecord.pdfSize = pdfBuffer.length;
  signedRecord.updatedAt = now;
  if (!Array.isArray(signedRecord.corrections)) signedRecord.corrections = [];
  signedRecord.corrections.push({
    at: now,
    by: String(editor || 'unknown'),
    reason: 'lo_data_correction',
  });

  try {
    await signedStore.setJSON(signedKey, signedRecord);
  } catch (e) {
    console.error('signed-app regen: store write failed:', e);
    return { ok: false, reason: 'write_failed: ' + (e && e.message) };
  }

  return {
    ok: true,
    regenerated: true,
    signedKey,
    corrections: signedRecord.corrections.length,
    status: signedRecord.status,
  };
}
