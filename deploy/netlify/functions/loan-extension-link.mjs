/**
 * loan-extension-link.mjs — POST /api/loan-extension-link
 *
 * Deploy 236.903 (Mike) — "Make it so its possible to get the signing request
 * as a link to send to borrowers as well as the email."
 *
 * Returns the signing URL for whoever's turn it currently is. Extensions are
 * SEQUENTIAL — the lender signs first and only then is the borrower's token
 * minted — so "the link" is not a fixed thing you can capture at send time.
 * This resolves the active signer at the moment you ask.
 *
 * A signer who has no live token (never invited, or the token expired) gets a
 * fresh one minted here, which is what makes this useful for the borrower half
 * of a sequential send.
 *
 * Body: { envelopeId, owner?, email? }
 *   email — optional, to get a specific signer's link rather than the active
 *           one (e.g. re-copying the lender's link while they still hold it).
 * Auth: processor tier — same people who send extensions.
 *
 * Deliberately does NOT email anything. envelopes-resend-signer already does
 * the "send them a fresh email" job; this is the copy-a-link path, so the two
 * don't compete over who last rotated the token.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { generateSignerToken } from './_shared/native-esign.mjs';

const TOKEN_TTL_DAYS = 30;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-link error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const gate = canOverrideOwner(user);
  if (!gate.ok) return json(gate.status || 403, { error: gate.reason || 'Not authorized' });

  const body = await readJsonBody(req);
  if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });

  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const envKey = ownerKey + '/' + body.envelopeId;
  const envelope = await envStore.get(envKey, { type: 'json' }).catch(() => null);
  if (!envelope) return json(404, { error: 'Envelope not found' });
  if (envelope.status === 'voided')    return json(400, { error: 'That extension request was cancelled.' });
  if (envelope.status === 'completed') return json(400, { error: 'That extension is already fully executed.' });

  const signers = envelope.signers || [];
  const wanted = normalizeEmail(body.email || '');
  let idxNum = -1;
  if (wanted) {
    idxNum = signers.findIndex((s) => s && normalizeEmail(s.email) === wanted);
    if (idxNum < 0) return json(404, { error: 'No signer on this extension with that email.' });
    if (signers[idxNum].audit && signers[idxNum].audit.signedAt) {
      return json(400, { error: signers[idxNum].email + ' has already signed.' });
    }
  } else {
    // Whose turn is it? For a sequential envelope that is the first unsigned
    // signer, which is exactly who holds (or should hold) a live token.
    idxNum = signers.findIndex((s) => !s.audit || !s.audit.signedAt);
    if (idxNum < 0) return json(400, { error: 'Everyone has signed.' });
  }

  const signer = signers[idxNum];
  const now = Date.now();
  const expired = signer.tokenExpiresAt && new Date(signer.tokenExpiresAt).getTime() < now;

  let minted = false;
  if (!signer.token || expired) {
    // No live token: mint one. This is the normal case for the BORROWER on a
    // sequential extension before the lender has signed — there is no link to
    // copy until someone creates it.
    const token = generateSignerToken();
    const tokenExpiresAt = new Date(now + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    signers[idxNum] = { ...signer, token, tokenExpiresAt };
    envelope.signers = signers;
    envelope.history = envelope.history || [];
    envelope.history.push({
      ts: new Date().toISOString(), status: envelope.status,
      note: 'Signing link generated for ' + signer.email + ' by ' + normalizeEmail(user.email) +
        (expired ? ' (previous link had expired).' : '.'),
    });
    await envStore.setJSON(envKey, envelope);

    const sIdx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
    await sIdx.setJSON(token, { envelopeKey: envKey, signerIndex: idxNum, expiresAt: tokenExpiresAt });
    minted = true;
  }

  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
  const token = envelope.signers[idxNum].token;

  return json(200, {
    ok: true,
    url: base + '/term-sheet-sign.html?t=' + encodeURIComponent(token),
    signer: {
      email: signer.email,
      name: ((signer.firstName || '') + ' ' + (signer.lastName || '')).trim(),
      role: signer.role || '',
    },
    expiresAt: envelope.signers[idxNum].tokenExpiresAt,
    minted,
    propertyAddress: envelope.propertyAddress || '',
  });
}
