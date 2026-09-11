/**
 * loan-extension-reset-signer.mjs — POST /api/loan-extension-reset-signer
 *
 * Deploy 236.980 (Mike: "There was an error and I need to get it resigned.")
 *
 * Voids ONE signer's signature on a loan-extension envelope and puts that
 * signer back in the queue, leaving everyone else's signature exactly as it
 * was. Built for the case where a signing link was used by the wrong hands
 * (the 3602 24th Ave W guarantor link was signed a minute after it was
 * generated for hand delivery) and the real person still has to sign.
 *
 *   1. The signer's sealed audit is moved to signer.voidedAudits[] with who /
 *      when / why — the signing event that happened stays on the record, it
 *      just no longer counts. audit / signedAt / token are cleared.
 *   2. The agreement is re-rendered from the envelope's own terms and stored
 *      as the envelope's ORIGINAL again (completed envelopes have none), so
 *      the remaining signatures + the new one can be stamped onto it.
 *   3. The executed PDF(s) are deleted — they carry the voided signature.
 *      Once the signer signs again, envelope-sign re-stamps every valid
 *      signature and issues a fresh executed copy + certificate.
 *   4. If it is now that signer's turn (everyone before them in the sequence
 *      has signed) a fresh link is minted and emailed — or handed back
 *      (sendEmail:false) for the LO to send. Otherwise the sequence reaches
 *      them in turn.
 *
 * Body: { envelopeId, owner?, email | signerIndex, reason?, sendEmail? }
 * ADMIN ONLY — this discards a sealed signature.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { generateSignerToken, hashPdf } from './_shared/native-esign.mjs';
import { buildExtensionAgreementPdf } from './_shared/extension-agreement-pdf.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { syncExtensionMarker, signerName, isSigned } from './_shared/extension-marker.mjs';

const TOKEN_TTL_DAYS = 30;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-reset-signer error:', e);
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
  if (!isAdmin(user)) return json(403, { error: 'Admin only — this voids a signature.' });
  const selfEmail = normalizeEmail(user.email);

  const body = await readJsonBody(req);
  if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });
  const reason = String(body.reason || '').trim().slice(0, 300);
  const sendEmail = body.sendEmail !== false && body.sendEmail !== 'false';

  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const envKey = ownerKey + '/' + body.envelopeId;
  const envelope = await envStore.get(envKey, { type: 'json' }).catch(() => null);
  if (!envelope) return json(404, { error: 'Envelope not found' });
  if (envelope.envelopeKind !== 'loan_extension') return json(400, { error: 'That envelope is not a loan extension.' });
  if (envelope.status === 'voided') return json(400, { error: 'That extension request was cancelled.' });
  if (envelope.envelopeMode === 'pandadoc-legacy') return json(400, { error: 'Legacy envelope — read only.' });

  const signers = Array.isArray(envelope.signers) ? envelope.signers : [];
  let idx = Number.isInteger(body.signerIndex) ? body.signerIndex : -1;
  if (idx < 0 && body.email) {
    const e = normalizeEmail(body.email);
    idx = signers.findIndex((s) => s && normalizeEmail(s.email || '') === e);
  }
  if (idx < 0 || !signers[idx]) return json(404, { error: 'No signer on this extension matches that email.' });
  const signer = signers[idx];
  if (!isSigned(signer)) return json(409, { error: signerName(signer) + ' has not signed yet — nothing to reset. Use Resend / Copy link instead.' });

  // ── The loan, for the agreement's fill values ─────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const found = await locateLoan({ ownerKey: envelope.ownerKey, clientId: envelope.clientId, loanId: envelope.loanId, clientsStore });
  if (!found) return json(404, { error: 'The loan behind this extension could not be located.' });
  const { client, loan } = found;

  // ── 1. Void the signature (keep the event on the record) ──────────
  const now = new Date().toISOString();
  const voided = { ...(signer.audit || {}), signedAt: signer.audit && signer.audit.signedAt, voidedAt: now, voidedBy: selfEmail, reason };
  signers[idx] = {
    ...signer,
    audit: null, signedAt: null, token: null, tokenExpiresAt: null,
    voidedAudits: (Array.isArray(signer.voidedAudits) ? signer.voidedAudits : []).concat([voided]),
  };
  envelope.signers = signers;

  // ── 2. Restore an original to stamp onto ──────────────────────────
  const terms = envelope.extensionTerms || {};
  const lenderSigner = signers.find((s) => s && s.role === 'lender');
  const borrowerSigner = signers.find((s) => s && s.role === 'borrower');
  const loanAmount = _num(loan.finalLoanAmount) || _num(loan.loanAmt);
  const values = {
    todaysDate:      String(envelope.createdAt || '').slice(0, 10),
    borrowerName:    borrowerSigner ? signerName(borrowerSigner) : (client.entityName || ''),
    originationDate: loan.fundingDate || '',
    loanAmount,
    propertyAddress: envelope.propertyAddress || loan.address || '',
    currentUpb:      _num(terms.currentUpb) || _num(loan.upb) || loanAmount,
    newMaturityDate: terms.newMaturityDate || '',
    extensionFee:    _num(terms.extensionFee),
    feeHandling:     terms.feeHandling === 'add_to_principal' ? 'add_to_principal' : 'at_signing',
    lenderName:      lenderSigner ? signerName(lenderSigner) : 'Mike DeHaan',
    guarantors:      signers.filter((s) => s && /^guarantor/i.test(String(s.role || ''))).map((s) => ({ name: signerName(s), role: s.role })),
  };
  let built;
  try { built = await buildExtensionAgreementPdf(values); }
  catch (e) { return json(500, { error: 'Agreement re-render failed: ' + (e.message || 'unknown') }); }
  const pdfBase64 = built.buffer.toString('base64');
  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  await pdfStore.set(envelope.ownerKey + '/' + envelope.id + '/0', pdfBase64);
  envelope.docs = Array.isArray(envelope.docs) && envelope.docs.length ? envelope.docs : [{ kind: 'loan_extension', name: 'Loan Extension Agreement' }];
  envelope.docs[0] = { ...envelope.docs[0], hadPdf: true, pdfHash: hashPdf(pdfBase64), pdfSize: built.buffer.length, sigCoords: null, sigFields: built.sigFields };

  // ── 3. The executed copy carried the voided signature — drop it ───
  const wasCompleted = envelope.status === 'completed' || envelope.status === 'completed_stamping_failed';
  let finalsDropped = 0;
  try {
    const finalStore = getStore({ name: 'envelope-final-pdfs', consistency: 'strong' });
    for (let i = 0; i < envelope.docs.length; i++) {
      try { await finalStore.delete(envelope.ownerKey + '/' + envelope.id + '/' + i); finalsDropped++; } catch (_) {}
    }
  } catch (e) { console.warn('loan-extension-reset-signer: final pdf cleanup failed (non-fatal):', e && e.message); }

  // ── 4. Back in the queue ──────────────────────────────────────────
  envelope.status = 'partially_signed';
  envelope.statusUpdatedAt = now;
  envelope.history = Array.isArray(envelope.history) ? envelope.history : [];
  const theirTurn = signers.slice(0, idx).every(isSigned);
  let invited = false, url = null;
  if (theirTurn) {
    const token = generateSignerToken();
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    envelope.signers[idx] = { ...envelope.signers[idx], token, tokenExpiresAt, invitedAt: now, resendCount: 0 };
    const idxStore = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
    await idxStore.setJSON(token, { envelopeKey: envKey, signerIndex: idx, expiresAt: tokenExpiresAt });
    const proto = (req.headers && req.headers.get ? req.headers.get('x-forwarded-proto') : null) || 'https';
    const host = (req.headers && req.headers.get ? req.headers.get('host') : null) || '';
    const base = host ? `${proto}://${host}` : (process.env.URL || 'https://portal.slacapital.ai');
    url = `${base}/term-sheet-sign.html?t=${encodeURIComponent(token)}`;
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey && sendEmail) {
      try {
        let loName = envelope.requesterEmail;
        try {
          const p = await getStore({ name: 'profiles', consistency: 'eventual' }).get(keySafe(envelope.requesterEmail), { type: 'json' });
          const n = p ? (((p.firstName || '') + ' ' + (p.lastName || '')).trim()) : '';
          if (n) loName = n;
        } catch (_) {}
        const { sendInvitationEmail } = await import('./envelopes-send.mjs');
        invited = !!(await sendInvitationEmail({
          apiKey, signer: envelope.signers[idx], envelope, link: url, loName,
          propertyAddress: envelope.propertyAddress || loan.address || '', ownerKey: envelope.ownerKey,
        }));
      } catch (e) { console.warn('loan-extension-reset-signer: invitation email failed:', e && e.message); }
    }
  }
  const who = signerName(signer) + ' <' + (signer.email || '') + '>';
  envelope.history.push({
    ts: now, status: envelope.status,
    note: 'Signature by ' + who + ' voided by ' + selfEmail + (reason ? ' — ' + reason : '') + '.' +
      (wasCompleted ? ' The executed copy was withdrawn; it is re-issued once they sign again.' : '') +
      (theirTurn ? (invited ? ' Fresh signing link emailed.' : (sendEmail ? ' Fresh link generated (email failed — use Copy link).' : ' Fresh link generated for the LO to send.')) : ' They are invited in turn once the earlier signers finish.'),
  });
  await envStore.setJSON(envKey, envelope);

  // ── Marker + note on the loan ─────────────────────────────────────
  const lenderSigned = !!(lenderSigner && isSigned(lenderSigner));
  const markerStatus = lenderSigned ? 'lender_signed' : 'sent';
  const meta = (user && user.user_metadata) || {};
  await syncExtensionMarker(envelope, markerStatus,
    'Loan Extension Agreement: signature by ' + who + ' voided' + (reason ? ' (' + reason + ')' : '') +
      (theirTurn ? (invited ? ' — fresh signing link emailed.' : ' — fresh signing link generated to send by hand.') : ' — re-signs in turn.') +
      (wasCompleted ? ' The executed copy is withdrawn until they sign again.' : ''),
    { clientsStore, author: meta.full_name || meta.fullName || user.email || '', authorEmail: selfEmail, via: 'loan_extension_reset_signer',
      extra: { executedAt: '' } });

  return json(200, {
    ok: true, envelopeId: envelope.id, signerIndex: idx, email: signer.email || '', name: signerName(signer),
    invited, url, linkOnly: theirTurn && !sendEmail, pendingTurn: !theirTurn, finalsDropped,
    status: envelope.status, markerStatus, wasCompleted,
  });
}
