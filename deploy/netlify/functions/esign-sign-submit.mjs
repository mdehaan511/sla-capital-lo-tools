/**
 * esign-sign-submit.mjs — POST /api/esign-sign-submit
 *
 * Deploy 237.028 (Mike): PUBLIC. The signer finishes.
 *
 * Body: {
 *   t, consentAccepted:true, consentVersion,
 *   signature: { kind:'drawn', png:'data:image/png;base64,…' } | { kind:'typed', text },
 *   initials:  { kind:'drawn'|'typed', … }      (only when they have initials fields)
 *   values:    { [fieldId]: value }              (text / date / checkbox fields)
 *   geolocation?: 'lat,lng'
 * }
 *
 * Validates the token + turn + consent + every required field, stores the
 * adopted signature (esign-doc-sigs), seals the audit record with the same
 * HMAC scheme as the term-sheet eSign, retires the token, then either
 * invites the next order group or — when this was the last signature —
 * stamps the executed PDF, emails everyone a copy, and queues the AI
 * "which loan / what doc type" suggestion.
 */
import { handleOptions, json, readJsonBody } from './_shared/auth.mjs';
import { checkRateLimit } from './_shared/rate-limit.mjs';
import {
  TERMSHEET_CONSENT_VERSION, sealSignature, getClientIp, getUserAgent,
} from './_shared/native-esign.mjs';
import {
  lookupByToken, pendingSigners, signerFields, coerceValue, docSigStore, docKey, writeDoc, retireToken,
  mintToken, sendInviteEmail, sendSignedNotice, finalizeDocument, queueSuggestion, pushHistory, baseUrl, signUrl,
} from './_shared/esign-docs.mjs';

const MAX_PNG_CHARS = 400 * 1024; // ~300KB image — a signature pad export is typically 10–40KB

function normalizeSig(raw, label) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'drawn') {
    const png = String(raw.png || '');
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png)) throw new Error(label + ' image is not a PNG');
    if (png.length > MAX_PNG_CHARS) throw new Error(label + ' image is too large — clear and draw again');
    return { kind: 'drawn', png };
  }
  if (raw.kind === 'typed') {
    const text = String(raw.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (text.length < 2) throw new Error('Type your ' + label.toLowerCase());
    return { kind: 'typed', text };
  }
  throw new Error(label + ' is required');
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const rl = await checkRateLimit(req, context, { bucket: 'esign-sign-submit', max: 30, windowSec: 300 });
    if (!rl.allowed) return json(429, { error: 'Too many attempts — try again in a few minutes' });

    const body = await readJsonBody(req);
    if (!body || !body.t) return json(400, { error: 'Missing signing token' });
    const found = await lookupByToken(body.t);
    if (!found) return json(404, { error: 'This signing link is not valid. Ask the sender for a new link.' });
    const { doc, signer } = found;

    if (doc.status === 'cancelled') return json(409, { error: 'This document was cancelled by the sender' });
    if (doc.status !== 'sent') return json(409, { error: 'This document is ' + doc.status });
    if (signer.signedAt) return json(409, { error: 'You have already signed this document' });
    if (signer.tokenExpiresAt && new Date(signer.tokenExpiresAt) < new Date()) return json(410, { error: 'This signing link has expired — ask the sender to re-send it' });
    if (!pendingSigners(doc).some((s) => s.id === signer.id)) return json(409, { error: 'It is not your turn to sign yet — you will be emailed when the document is ready for you' });
    if (body.consentAccepted !== true) return json(400, { error: 'You must agree to the electronic signature consent' });
    if (Number(body.consentVersion) !== TERMSHEET_CONSENT_VERSION) return json(409, { error: 'The consent text changed — reload the page and try again' });

    // ── Collect values ──
    const mine = signerFields(doc, signer.id);
    const values = (body.values && typeof body.values === 'object') ? body.values : {};
    const needSig = mine.some((f) => f.type === 'signature');
    const needIni = mine.some((f) => f.type === 'initials');
    let sigRec = null, iniRec = null;
    try {
      if (needSig) sigRec = normalizeSig(body.signature, 'Signature');
      if (needIni) iniRec = normalizeSig(body.initials, 'Initials');
    } catch (e) { return json(400, { error: e.message }); }
    const missing = [];
    mine.forEach((f) => {
      if (f.type === 'signature') { f.value = !!sigRec; if (f.required && !sigRec) missing.push(f); return; }
      if (f.type === 'initials')  { f.value = !!iniRec; if (f.required && !iniRec) missing.push(f); return; }
      const v = coerceValue(f.type, values[f.id]);
      f.value = v;
      if (f.required && (v === '' || v === false || v === null || v === undefined)) missing.push(f);
    });
    if (missing.length) {
      const f = missing[0];
      return json(400, { error: 'Please complete the required ' + f.type + (f.label ? ' "' + f.label + '"' : '') + ' on page ' + f.page, missing: missing.map((m) => m.id) });
    }

    // ── Audit + seal ──
    const signedAt = new Date().toISOString();
    const signerIndex = (doc.signers || []).findIndex((s) => s.id === signer.id);
    const audit = {
      envelopeId: doc.id, signerIndex, signerName: signer.name, signerEmail: signer.email, signedAt,
      consentVersion: TERMSHEET_CONSENT_VERSION,
      ipAddress: getClientIp(req), userAgent: String(getUserAgent(req) || '').slice(0, 300),
      geolocation: String(body.geolocation || '').slice(0, 80),
      docHashes: [String((doc.pdf && doc.pdf.hash) || '')],
      signatureKind: sigRec ? sigRec.kind : (iniRec ? iniRec.kind : 'none'),
    };
    audit.seal = sealSignature(audit);
    if (!audit.seal) return json(500, { error: 'Signing is not configured on the server (missing seal secret)' });

    const key = docKey(doc.ownerKey, doc.id);
    await docSigStore().setJSON(key + '/' + signer.id, { signature: sigRec, initials: iniRec, signedAt });
    signer.audit = audit;
    signer.signedAt = signedAt;
    await retireToken(signer);
    pushHistory(doc, 'signed', (signer.name || signer.email) + ' signed', signer.email);

    const base = baseUrl(req);
    const remaining = (doc.signers || []).filter((s) => !s.signedAt);
    let completed = false;
    const emailResults = [];
    if (!remaining.length) {
      try {
        await finalizeDocument(doc, { base });
        completed = true;
      } catch (e) {
        // The signature is captured and sealed; stamping can be retried by the
        // LO from the status page. Don't fail the signer.
        console.error('esign-sign-submit: finalize failed:', e && e.message);
        doc.finalizeError = (e && e.message) || 'stamping failed';
        pushHistory(doc, 'finalize_failed', doc.finalizeError, 'system');
      }
    } else {
      // Sequential: the next order group may just have become active — invite anyone without a live token.
      for (const s of pendingSigners(doc)) {
        if (s.token || s.signedAt) continue;
        await mintToken(doc, s);
        try {
          await sendInviteEmail({ doc, signer: s, link: signUrl(base, s.token) });
          s.invitedAt = new Date().toISOString();
          emailResults.push({ signerId: s.id, ok: true });
        } catch (e) {
          console.warn('esign-sign-submit: next-signer invite failed:', e && e.message);
          emailResults.push({ signerId: s.id, ok: false, error: e && e.message });
        }
      }
    }
    await writeDoc(doc);
    await sendSignedNotice({ doc, signer, remaining, link: base + '/esign.html#doc=' + encodeURIComponent(doc.id) });
    if (completed) {
      doc.suggestionState = 'pending';
      await writeDoc(doc);
      await queueSuggestion(doc, base);
    }
    return json(200, { ok: true, completed, state: completed ? 'completed' : 'signed', signedAt });
  } catch (e) {
    console.error('esign-sign-submit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
