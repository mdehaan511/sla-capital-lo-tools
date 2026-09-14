/**
 * esign-sign-info.mjs — GET /api/esign-sign-info?t=<token>
 *
 * Deploy 237.028 (Mike): PUBLIC (no auth). The signer landing page
 * (esign-sign.html) calls this first. Returns everything the page needs to
 * render: document meta + page sizes, this signer, every field (the signer's
 * own to fill, everyone else's to display), prior signers' adopted signatures
 * so their boxes render, and the consent text. Never returns tokens or other
 * signers' emails.
 *
 * state: 'ready' | 'waiting' (sequential, not your turn) | 'signed' |
 *        'completed' | 'cancelled' | 'expired'
 */
import { handleOptions, json } from './_shared/auth.mjs';
import { checkRateLimit } from './_shared/rate-limit.mjs';
import {
  TERMSHEET_CONSENT_VERSION, TERMSHEET_CONSENT_TEXT, TERMSHEET_CONSENT_LABEL,
} from './_shared/native-esign.mjs';
import { lookupByToken, pendingSigners, docSigStore, docKey, writeDoc } from './_shared/esign-docs.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const rl = await checkRateLimit(req, context, { bucket: 'esign-sign-info', max: 200, windowSec: 300 });
    if (!rl.allowed) return json(429, { error: 'Too many requests — try again in a minute' });

    const url = new URL(req.url);
    const t = url.searchParams.get('t') || '';
    const found = await lookupByToken(t);
    if (!found) return json(404, { error: 'This signing link is not valid. Ask the sender for a new link.' });
    const { doc, signer } = found;

    let state = 'ready';
    if (doc.status === 'cancelled') state = 'cancelled';
    else if (doc.status === 'completed') state = 'completed';
    else if (signer.signedAt) state = 'signed';
    else if (signer.tokenExpiresAt && new Date(signer.tokenExpiresAt) < new Date()) state = 'expired';
    else if (!pendingSigners(doc).some((s) => s.id === signer.id)) state = 'waiting';

    // First open → viewedAt (best-effort; the LO sees "Viewed" on the status page).
    if (state === 'ready' && !signer.viewedAt) {
      signer.viewedAt = new Date().toISOString();
      if (!Array.isArray(doc.history)) doc.history = [];
      doc.history.push({ ts: signer.viewedAt, event: 'viewed', note: (signer.name || signer.email) + ' opened the signing link', by: signer.email });
      writeDoc(doc).catch((e) => console.warn('esign-sign-info: viewedAt write failed:', e && e.message));
    }

    // Prior signers' adopted signatures (so their boxes render on the page).
    const key = docKey(doc.ownerKey, doc.id);
    const priorSigs = {};
    await Promise.all((doc.signers || []).filter((s) => s.signedAt && s.id !== signer.id).map(async (s) => {
      const rec = await docSigStore().get(key + '/' + s.id, { type: 'json' }).catch(() => null);
      if (rec) priorSigs[s.id] = { signature: rec.signature || null, initials: rec.initials || null };
    }));

    const signersPublic = (doc.signers || []).map((s) => ({
      id: s.id, name: s.name, kind: s.kind, order: s.order, color: s.color, signedAt: s.signedAt || null, isYou: s.id === signer.id,
    }));

    return json(200, {
      state,
      doc: {
        id: doc.id, title: doc.title, message: doc.message || '', ownerName: doc.ownerName || '',
        pageCount: doc.pdf ? doc.pdf.pageCount : 0, pages: doc.pdf ? doc.pdf.pages : [],
        sequential: !!doc.sequential, status: doc.status,
      },
      signer: { id: signer.id, name: signer.name, email: signer.email, kind: signer.kind, color: signer.color, signedAt: signer.signedAt || null },
      signers: signersPublic,
      fields: (doc.fields || []).map((f) => Object.assign({}, f, { mine: f.signerId === signer.id })),
      priorSigs,
      consent: { version: TERMSHEET_CONSENT_VERSION, text: TERMSHEET_CONSENT_TEXT, checkboxLabel: TERMSHEET_CONSENT_LABEL },
      waitingOn: state === 'waiting' ? pendingSigners(doc).map((s) => s.name || 'another signer') : [],
    });
  } catch (e) {
    console.error('esign-sign-info error:', e);
    return json(500, { error: 'Server error' });
  }
};
