/**
 * loan-extension-restamp.mjs — POST /api/loan-extension-restamp
 *
 * Deploy 236.897 (Mike) — repair an already-executed Loan Extension Agreement
 * whose signature lines came back blank.
 *
 * "It came back with a signing confirmation page but the document does not
 * show as signed... We need this document corrected and cannot send for
 * e-signing again."
 *
 * The signatures were never in question — the certificate page carries both,
 * sealed. What was missing is the stamp on the agreement itself, because
 * loan-extension-send stored `sigCoords: null` and the stamper had nowhere to
 * put them. This rebuilds the executed PDF the way it should have come out:
 *
 *   1. Re-render the agreement from the envelope's own extensionTerms and the
 *      loan record — the same generator, the same inputs.
 *   2. Stamp each party's signature onto their rule, from the SEALED audit
 *      already on the envelope. No new signature is created and no signer is
 *      asked for anything; the signing events are the ones that happened.
 *   3. Re-append the certificate page.
 *
 * The rebuilt file replaces the stored final PDF, so every existing download
 * path (envelope-final-pdf, the servicing row) serves the corrected document.
 *
 * Body: { envelopeId, owner?, dryRun? }
 * Auth: ADMIN. Rewriting an executed document is not a routine action.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { appendSignaturePageToPdf, hashPdf } from './_shared/native-esign.mjs';
import { buildExtensionAgreementPdf } from './_shared/extension-agreement-pdf.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-restamp error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : 0;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req);
  if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });

  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const envKey = ownerKey + '/' + body.envelopeId;
  const envelope = await envStore.get(envKey, { type: 'json' }).catch(() => null);
  if (!envelope) return json(404, { error: 'Envelope not found' });
  if (envelope.envelopeKind !== 'loan_extension') {
    return json(400, { error: 'That envelope is not a loan extension.' });
  }

  const signed = (envelope.signers || []).filter((s) => s && s.audit && s.audit.signedAt);
  if (signed.length !== (envelope.signers || []).length || !signed.length) {
    return json(400, { error: 'Envelope is not fully executed — nothing to restamp.' });
  }

  // ── The loan, found by LOAN id (the client may since have merged) ──
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const found = await locateLoan({
    ownerKey: envelope.ownerKey, clientId: envelope.clientId,
    loanId: envelope.loanId, clientsStore,
  });
  if (!found) return json(404, { error: 'Loan not found for envelope ' + envelope.id });
  const { client, loan } = found;

  // ── Rebuild the agreement from the envelope's own terms ───────────
  const terms = envelope.extensionTerms || {};
  const lenderSigner   = (envelope.signers || []).find((s) => s.role === 'lender');
  const borrowerSigner = (envelope.signers || []).find((s) => s.role === 'borrower');
  const loanAmount = _num(loan.finalLoanAmount) || _num(loan.loanAmt);
  const values = {
    // The agreement's effective date is the day it was generated.
    todaysDate:      String(envelope.createdAt || '').slice(0, 10),
    borrowerName:    borrowerSigner
                       ? ((borrowerSigner.firstName || '') + ' ' + (borrowerSigner.lastName || '')).replace(/\s*—\s*$/, '').trim()
                       : (client.entityName || ''),
    originationDate: loan.fundingDate || '',
    loanAmount:      loanAmount,
    propertyAddress: envelope.propertyAddress || loan.address || '',
    currentUpb:      _num(terms.currentUpb) || _num(loan.upb) || loanAmount,
    newMaturityDate: terms.newMaturityDate || '',
    extensionFee:    _num(terms.extensionFee),
    feeHandling:     terms.feeHandling === 'add_to_principal' ? 'add_to_principal' : 'at_signing',
    lenderName:      lenderSigner
                       ? ((lenderSigner.firstName || '') + ' ' + (lenderSigner.lastName || '')).replace(/\s*—\s*$/, '').trim()
                       : 'Mike DeHaan',
  };

  let built;
  try { built = await buildExtensionAgreementPdf(values); }
  catch (e) { return json(500, { error: 'Agreement re-render failed: ' + (e.message || 'unknown') }); }

  // If the re-render is byte-identical to the original we know the inputs were
  // reconstructed exactly. pdfkit stamps a CreationDate so this usually won't
  // match — it is reported, not enforced.
  const rebuiltHash = hashPdf(built.buffer.toString('base64'));
  const originalHash = (envelope.docs && envelope.docs[0] && envelope.docs[0].pdfHash) || '';

  // ── Stamp the signatures that already happened ────────────────────
  let finalB64;
  try {
    finalB64 = await appendSignaturePageToPdf({
      pdfBase64: built.buffer.toString('base64'),
      envelope,
      doc: { sigFields: built.sigFields },
    });
  } catch (e) {
    return json(500, { error: 'Stamping failed: ' + (e.message || 'unknown') });
  }

  const summary = {
    envelopeId: envelope.id,
    loanId: envelope.loanId,
    address: values.propertyAddress,
    stamped: signed.map((s) => ({
      role: s.role,
      name: ((s.firstName || '') + ' ' + (s.lastName || '')).trim(),
      signedAt: s.audit.signedAt,
    })),
    values,
    rebuiltHash,
    originalHash,
    hashMatchesOriginal: !!originalHash && rebuiltHash === originalHash,
    bytes: Buffer.from(finalB64, 'base64').length,
  };

  if (body.dryRun) return json(200, { ok: true, dryRun: true, ...summary });

  // ── Replace the stored final PDF ──────────────────────────────────
  const finalStore = getStore({ name: 'envelope-final-pdfs', consistency: 'strong' });
  await finalStore.set(envelope.ownerKey + '/' + envelope.id + '/0', finalB64);

  const now = new Date().toISOString();
  envelope.history = envelope.history || [];
  envelope.history.push({
    ts: now, status: envelope.status,
    note: 'Executed PDF re-stamped by ' + normalizeEmail(user.email) +
      ' — signature lines were blank on the original render (236.897). ' +
      'Signatures unchanged; taken from the sealed audit.',
  });
  envelope.restampedAt = now;
  if (envelope.docs && envelope.docs[0]) envelope.docs[0].sigFields = built.sigFields;
  await envStore.setJSON(envKey, envelope);

  // Leave a trace on the loan too, so the correction is visible where staff work.
  try {
    // Deploy 236.897 — also restore the servicing-row marker. On this envelope
    // it was never written at all: the client was merged between the send and
    // the borrower signing, so the old (clientId, loanId) lookup found nothing
    // and returned silently. Now that we've located the loan by loan id, put
    // the chip back where it belongs.
    const cur = loan.extensionEsign || null;
    if (!cur || cur.envelopeId === envelope.id) {
      loan.extensionEsign = {
        envelopeId: envelope.id,
        status: 'completed',
        sentAt: (cur && cur.sentAt) || envelope.createdAt || '',
        newMaturityDate: terms.newMaturityDate || (cur && cur.newMaturityDate) || '',
        updatedAt: now,
      };
    }
    appendNoteEntry(loan, {
      kind: 'status',
      text: 'Signed Loan Extension Agreement re-issued — the executed copy now shows both signatures on the agreement itself (the original render left the signature lines blank). Signatures and audit trail are unchanged.',
      author: 'eSign', authorEmail: normalizeEmail(user.email),
      meta: { via: 'loan_extension_restamp', envelopeId: envelope.id },
    });
    loan.updatedAt = now;
    await writeClient(found.ownerKey, client, { clientsStore });
    summary.markerWritten = true;
  } catch (e) {
    // Report it. The PDF is already repaired and stored, so this is not fatal
    // to the request — but silently swallowing it is how the marker went
    // missing in the first place.
    console.error('loan-extension-restamp: loan write FAILED:', e && e.message);
    summary.markerWritten = false;
    summary.markerError = (e && e.message) || 'unknown';
  }

  return json(200, { ok: true, ...summary });
}
