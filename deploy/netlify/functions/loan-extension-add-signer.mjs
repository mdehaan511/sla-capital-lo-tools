/**
 * loan-extension-add-signer.mjs — POST /api/loan-extension-add-signer
 *
 * Deploy 236.974 (Mike: "if for some reason a guarantor needs to be added that
 * the existing signed extension can be sent just to the 2nd one for signing.")
 *
 * Adds one guarantor signer to an EXISTING loan-extension envelope — including
 * one that is already fully executed — and gets only that person signing:
 *
 *   1. Appends the signer (role guarantorN, last in the signing sequence).
 *   2. Re-renders the agreement from the envelope's own extensionTerms + the
 *      loan, now with a signature rule for the new guarantor, and stores it as
 *      the envelope's ORIGINAL (envelope-pdfs). The originals are deleted once
 *      an envelope completes, and the stamper needs one to stamp onto.
 *   3. If everyone else has signed, mints the new signer's link and emails it
 *      now; a completed envelope goes back to partially_signed. When they sign,
 *      envelope-sign stamps EVERY signature (the earlier ones from their sealed
 *      audit — nobody re-signs) and re-issues the executed PDF + certificate.
 *      If earlier signers are still pending, the sequence reaches the new one
 *      in turn (envelope-sign invites the next unsigned signer).
 *
 * Body: { envelopeId, owner?, name, email }
 * Processor tier (canOverrideOwner) — same gate as cancel / link.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { generateSignerToken, hashPdf } from './_shared/native-esign.mjs';
import { buildExtensionAgreementPdf } from './_shared/extension-agreement-pdf.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { syncExtensionMarker, signerName, isSigned } from './_shared/extension-marker.mjs';

const TOKEN_TTL_DAYS = 30;
const MAX_SIGNERS = 6;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-add-signer error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : 0;
}
function _splitName(full, fallbackFirst) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: fallbackFirst || '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const gate = canOverrideOwner(user);
  if (!gate.ok) return json(gate.status || 403, { error: gate.reason || 'Not authorized' });
  const selfEmail = normalizeEmail(user.email);

  const body = await readJsonBody(req);
  if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });
  const email = normalizeEmail(body.email || '');
  const name = String(body.name || '').trim().slice(0, 120);
  if (!email || !email.includes('@')) return json(400, { error: 'A valid email for the guarantor is required.' });
  if (!name) return json(400, { error: 'The guarantor\'s name (as it should appear on the agreement) is required.' });

  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const envKey = ownerKey + '/' + body.envelopeId;
  const envelope = await envStore.get(envKey, { type: 'json' }).catch(() => null);
  if (!envelope) return json(404, { error: 'Envelope not found' });
  if (envelope.envelopeKind !== 'loan_extension') return json(400, { error: 'That envelope is not a loan extension.' });
  if (envelope.status === 'voided') return json(400, { error: 'That extension request was cancelled — send a new one instead.' });
  if (envelope.envelopeMode === 'pandadoc-legacy') return json(400, { error: 'Legacy envelope — read only.' });

  const signers = Array.isArray(envelope.signers) ? envelope.signers : [];
  if (signers.some((s) => s && normalizeEmail(s.email || '') === email)) {
    return json(409, { error: email + ' is already a signer on this extension.' });
  }
  if (signers.length >= MAX_SIGNERS) return json(400, { error: 'This extension already has the maximum number of signers.' });

  // ── The loan, for the agreement's fill values ─────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const found = await locateLoan({ ownerKey: envelope.ownerKey, clientId: envelope.clientId, loanId: envelope.loanId, clientsStore });
  if (!found) return json(404, { error: 'The loan behind this extension could not be located.' });
  const { client, loan } = found;

  // ── New signer: last in the sequence, its own rule on the agreement ──
  const existingGuarantors = signers.filter((s) => /^guarantor/i.test(String((s && s.role) || '')));
  const role = 'guarantor' + (existingGuarantors.length + 2);
  const nm = _splitName(name, '');
  const signingOrder = signers.reduce((m, s) => Math.max(m, Number((s && s.signingOrder) || 0)), 0) + 1;
  const newSigner = {
    firstName: nm.firstName, lastName: nm.lastName, email, role, signingOrder,
    token: null, tokenExpiresAt: null, audit: null, signedAt: null, invitedAt: null, resendCount: 0,
    addedAt: new Date().toISOString(), addedBy: selfEmail,
  };

  // ── Re-render the agreement with the extra rule → the envelope's original ──
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
    guarantors:      existingGuarantors.map((s) => ({ name: signerName(s), role: s.role })).concat([{ name, role }]),
  };
  let built;
  try { built = await buildExtensionAgreementPdf(values); }
  catch (e) { return json(500, { error: 'Agreement re-render failed: ' + (e.message || 'unknown') }); }
  const pdfBase64 = built.buffer.toString('base64');
  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  await pdfStore.set(envelope.ownerKey + '/' + envelope.id + '/0', pdfBase64);
  envelope.docs = Array.isArray(envelope.docs) && envelope.docs.length ? envelope.docs : [{ kind: 'loan_extension', name: 'Loan Extension Agreement' }];
  envelope.docs[0] = { ...envelope.docs[0], hadPdf: true, pdfHash: hashPdf(pdfBase64), pdfSize: built.buffer.length, sigCoords: null, sigFields: built.sigFields };

  // ── Append + (maybe) invite now ───────────────────────────────────
  const othersSigned = signers.length > 0 && signers.every(isSigned);
  const wasCompleted = envelope.status === 'completed' || envelope.status === 'completed_stamping_failed';
  envelope.signers = signers.concat([newSigner]);
  const newIdx = envelope.signers.length - 1;
  const now = new Date().toISOString();
  envelope.history = Array.isArray(envelope.history) ? envelope.history : [];

  let invited = false, url = null;
  if (othersSigned) {
    const token = generateSignerToken();
    const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    envelope.signers[newIdx] = { ...newSigner, token, tokenExpiresAt, invitedAt: now };
    const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
    await idx.setJSON(token, { envelopeKey: envKey, signerIndex: newIdx, expiresAt: tokenExpiresAt });
    envelope.status = 'partially_signed';
    envelope.statusUpdatedAt = now;

    const proto = (req.headers && req.headers.get ? req.headers.get('x-forwarded-proto') : null) || 'https';
    const host = (req.headers && req.headers.get ? req.headers.get('host') : null) || '';
    const base = host ? `${proto}://${host}` : (process.env.URL || 'https://portal.slacapital.ai');
    url = `${base}/term-sheet-sign.html?t=${encodeURIComponent(token)}`;
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      try {
        let loName = envelope.requesterEmail;
        try {
          const p = await getStore({ name: 'profiles', consistency: 'eventual' }).get(keySafe(envelope.requesterEmail), { type: 'json' });
          const n = p ? (((p.firstName || '') + ' ' + (p.lastName || '')).trim()) : '';
          if (n) loName = n;
        } catch (_) {}
        const { sendInvitationEmail } = await import('./envelopes-send.mjs');
        invited = !!(await sendInvitationEmail({
          apiKey, signer: envelope.signers[newIdx], envelope, link: url, loName,
          propertyAddress: envelope.propertyAddress || loan.address || '', ownerKey: envelope.ownerKey,
        }));
      } catch (e) { console.warn('loan-extension-add-signer: invitation email failed:', e && e.message); }
    }
  }
  envelope.history.push({
    ts: now, status: envelope.status,
    note: 'Guarantor added by ' + selfEmail + ': ' + name + ' <' + email + '>' +
      (wasCompleted ? ' — the executed agreement is re-issued once they sign.' : '') +
      (othersSigned ? (invited ? ' Invited to sign now.' : ' Signing link generated (email not sent — use Copy link).') : ' They are invited in turn once the earlier signers finish.'),
  });
  await envStore.setJSON(envKey, envelope);

  // ── Marker + note on the loan ─────────────────────────────────────
  const lenderSigned = !!(lenderSigner && isSigned(lenderSigner));
  const markerStatus = envelope.status === 'completed' ? 'completed' : (lenderSigned ? 'lender_signed' : 'sent');
  const meta = (user && user.user_metadata) || {};
  await syncExtensionMarker(envelope, markerStatus,
    'Guarantor added to the Loan Extension Agreement: ' + name + ' <' + email + '>' +
      (othersSigned ? (invited ? ' — invited to sign now.' : ' — signing link ready to copy.') : ' — signs after the earlier signers.') +
      (wasCompleted ? ' The executed copy will be re-issued with every signature once they sign.' : ''),
    { clientsStore, author: meta.full_name || meta.fullName || user.email || '', authorEmail: selfEmail, via: 'loan_extension_add_signer' });

  return json(200, {
    ok: true, envelopeId: envelope.id, signerIndex: newIdx, role, email, name,
    invited, url, status: envelope.status, markerStatus, reissue: wasCompleted,
  });
}
