/**
 * application-packet-complete-background.mjs -- the packet signature counts.
 *
 * Deploy 237.256 (Mike: "send the current Rate Sheet and Loan Application together in a
 * single email for e-signing ... after they are signed they need to get saved to the loan as
 * separate documents" / "The packet signature counts.")
 *
 * When an e-sign envelope that carries the Loan Application completes, envelope-sign.mjs
 * fires this (Netlify background function: 202 at once, up to 15 minutes to work). It turns
 * the envelope's signatures into the application's OWN signed record by driving the two
 * handlers a borrower would have used on the long form, with the audit context (name, IP,
 * user agent, geolocation) each signer produced on the packet:
 *
 *   1. borrower 1  -> borrower-info-sign's signApplicationInternal(): the signed_applications
 *                     record + audit seal, the borrower-info record marked signed, co-signer
 *                     tokens minted (no invite emails: they signed the packet already),
 *                     property sync, the loan advanced into processing (autoAttachOnApproval
 *                     files the signed application + credit-auth pages into the review trays),
 *                     the LO notified, the bell rung.
 *   2. each co-signer -> borrower2-auth-sign's signCosignerInternal() with the token minted in
 *                     step 1: their audit, the PDF re-rendered with every signature, the record
 *                     completed, the loan advanced when the last one signs.
 *   3. filing      -> when the loan was ALREADY in processing (nothing advanced, so nothing
 *                     auto-attached), the final signed application is attached to the review's
 *                     Loan Application tray here, once.
 *
 * Idempotent: the envelope remembers what happened (`envelope.application`), so a retry never
 * signs twice; the handlers refuse a second signature anyway. Every failure is written onto
 * the envelope where Loan Details can show it.
 *
 * POST { ownerKey, envelopeId }   header x-sla-internal: internalBgSig(envelopeId, 'packet')
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody, normalizeEmail } from './_shared/auth.mjs';
import { internalBgSig } from './_shared/review-truth.mjs';
import { loadRecord, newRecordKey } from './_shared/borrower-info-keys.mjs';
import { applicationParties } from './_shared/loan-application-unsigned.mjs';
import { signApplicationInternal } from './borrower-info-sign.mjs';
import { signCosignerInternal } from './borrower2-auth-sign.mjs';
import { attachPdfToReviewSlug } from './_shared/loan-review-auto-attach.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('application-packet-complete error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _sigOk(req, envelopeId) {
  const hdr = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('x-sla-internal') || '') : '';
  const want = internalBgSig(envelopeId, 'packet');
  return !!want && hdr === want;
}

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = (await readJsonBody(req)) || {};
  const ownerKey = String(body.ownerKey || '').trim();
  const envelopeId = String(body.envelopeId || '').trim();
  if (!ownerKey || !envelopeId) return json(400, { error: 'ownerKey and envelopeId required' });
  if (!_sigOk(req, envelopeId)) return json(403, { error: 'Bad internal signature' });

  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const envKey = `${ownerKey}/${envelopeId}`;
  const envelope = await envStore.get(envKey, { type: 'json' }).catch(() => null);
  if (!envelope) return json(404, { error: 'Envelope not found' });
  const appDocs = (envelope.docs || []).filter((d) => d && d.kind === 'loan_app');
  if (!appDocs.length) return json(200, { ok: true, skipped: 'no-loan-app' });
  if (envelope.status !== 'completed') return json(200, { ok: true, skipped: 'envelope-not-completed', status: envelope.status });
  if (envelope.application && envelope.application.signedAt) return json(200, { ok: true, skipped: 'already-signed', signedAt: envelope.application.signedAt });

  const now = new Date().toISOString();
  const note = async (patch, historyNote) => {
    envelope.application = Object.assign({}, envelope.application || {}, patch, { updatedAt: new Date().toISOString() });
    if (historyNote) (envelope.history = envelope.history || []).push({ ts: new Date().toISOString(), status: envelope.status, note: historyNote });
    try { await envStore.setJSON(envKey, envelope); } catch (e) { console.warn('packet-complete: envelope write failed:', e && e.message); }
  };

  // ── the application on file, and who has to sign it ──────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const client = await clientsStore.get(`${ownerKey}/${envelope.clientId}`, { type: 'json' }).catch(() => null);
  if (!client) { await note({ error: 'client not found' }, 'Application signature: client record not found.'); return json(404, { error: 'Client not found' }); }
  const record = await loadRecord(biStore, ownerKey, envelope.clientId, envelope.loanId, client);
  if (!record) { await note({ error: 'no application on file' }, 'Application signature: no long-form application on file.'); return json(404, { error: 'No application on file' }); }
  if (record.signedAt || record.b1SignedAt) {
    await note({ skipped: 'application-already-signed', signedAt: record.signedAt || record.b1SignedAt }, 'Application was already signed on the long form; the packet copy stays as a signed copy.');
    return json(200, { ok: true, skipped: 'application-already-signed' });
  }
  const recordKey = newRecordKey(ownerKey, envelope.clientId, envelope.loanId);
  const parties = applicationParties(record, client);
  const signerFor = (email) => (envelope.signers || []).find((s) => s && normalizeEmail(s.email) === normalizeEmail(email) && s.audit && s.audit.signedAt) || null;
  const missing = parties.filter((p) => !signerFor(p.email)).map((p) => (p.firstName + ' ' + p.lastName).trim() + ' <' + p.email + '>');
  if (missing.length) {
    await note({ error: 'signer missing: ' + missing.join(', ') }, 'Application signature not applied: the packet has no signature from ' + missing.join(', ') + '.');
    return json(409, { error: 'Not every party on the application signed this packet: ' + missing.join(', ') });
  }

  // ── 1. borrower 1 ─────────────────────────────────────────────────────────
  const p1 = parties[0];
  const s1 = signerFor(p1.email);
  const ctxOf = (s) => ({
    signerName: s.audit.signerName || ((s.firstName || '') + ' ' + (s.lastName || '')).trim(),
    ip: s.audit.ipAddress || '', ua: s.audit.userAgent || '', geolocation: s.audit.geolocation || '',
  });
  let r1;
  try {
    r1 = await signApplicationInternal(Object.assign({ record, recordKey, signerEmail: p1.email, envelopeId }, ctxOf(s1)));
  } catch (e) { r1 = { ok: false, error: 'threw: ' + ((e && e.message) || 'unknown') }; }
  if (!r1 || !r1.ok) {
    await note({ error: 'borrower 1: ' + ((r1 && r1.error) || 'failed') }, 'Application signature failed for ' + p1.email + ': ' + ((r1 && r1.error) || 'unknown') + '.');
    return json(500, { error: 'Application signature failed: ' + ((r1 && r1.error) || 'unknown') });
  }
  const cosigners = [];
  let lastAdvance = r1.advanceResult || null;

  // ── 2. each co-signer, with the token borrower 1's signature minted ───────
  for (const t of (r1.secondaryTokens || [])) {
    const party = parties.find((p) => p.pos === t.pos) || parties.find((p) => normalizeEmail(p.email) === normalizeEmail(t.email));
    const s = party ? signerFor(party.email) : null;
    if (!s) { cosigners.push({ pos: t.pos, email: t.email, ok: false, error: 'no packet signature' }); continue; }
    let r2;
    try { r2 = await signCosignerInternal(Object.assign({ token: t.token, envelopeId }, ctxOf(s))); }
    catch (e) { r2 = { ok: false, error: 'threw: ' + ((e && e.message) || 'unknown') }; }
    cosigners.push({ pos: t.pos, email: party.email, ok: !!(r2 && r2.ok), error: (r2 && r2.error) || '', status: r2 && r2.status });
    if (r2 && r2.ok && r2.advanceResult) lastAdvance = r2.advanceResult;
  }
  const allCosigned = cosigners.every((c) => c.ok);

  // ── 3. file the signed application when nothing advanced (already in processing) ─
  let filed = null;
  if (allCosigned) {
    const advancedNow = !!(lastAdvance && lastAdvance.ok && lastAdvance.loanUpdated);
    if (!advancedNow) {
      try {
        const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
        const signed = await signedStore.get(r1.signedKey, { type: 'json' });
        if (signed && signed.pdfBase64) {
          const street = String(envelope.propertyAddress || (record.prefill && record.prefill.propertyAddress) || '').split(',')[0].trim() || 'loan';
          filed = await attachPdfToReviewSlug({
            ownerKey, clientId: envelope.clientId, loanId: envelope.loanId,
            address: envelope.propertyAddress || '',
            slug: 'loan_application',
            bytes: Buffer.from(signed.pdfBase64, 'base64'),
            filename: 'Signed Loan Application - ' + street + '.pdf',
            sourceNote: 'auto-attached on e-sign packet completion (envelope ' + envelope.id + ')',
            actorEmail: 'auto:esign-packet',
          });
        }
      } catch (e) { filed = { ok: false, reason: (e && e.message) || 'attach threw' }; }
    } else {
      filed = { ok: true, via: 'advance' };
    }
  }

  await note({
    signedAt: allCosigned ? now : '', signedKey: r1.signedKey || '', borrower1: { email: p1.email, ok: true },
    cosigners, advanceResult: lastAdvance, filed, error: allCosigned ? '' : 'a co-signer signature failed',
  }, allCosigned
    ? 'Loan Application signed as part of this packet' + (cosigners.length ? ' (' + (1 + cosigners.length) + ' signers)' : '') + '; the loan carries its own signed application record.'
    : 'Loan Application: borrower 1 signed; a co-signer signature failed -- see the envelope record.');
  return json(200, { ok: allCosigned, signedKey: r1.signedKey || '', cosigners, advanceResult: lastAdvance, filed });
}
