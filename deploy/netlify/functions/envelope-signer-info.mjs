/**
 * envelope-signer-info.mjs — GET /api/envelope-signer-info
 *
 * Public endpoint (token-based). Returns the context a signer needs to
 * render the signing page: who they are, what they\u2019re signing, signing
 * state, and metadata about the PDFs (but NOT the PDF bytes \u2014 those
 * stream via /api/envelope-signer-pdf so the page can iframe them).
 *
 * Query: ?t=TOKEN
 * Returns: {
 *   envelopeId, propertyAddress, message, loName,
 *   signer: { firstName, lastName, email, alreadySigned },
 *   docs:   [ { idx, name, kind, pdfSize, pdfHash } ],
 *   status, expired,
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, normalizeEmail, keySafe } from './_shared/auth.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';

export default async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error('envelope-signer-info error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, null, { bucket: 'env-info', max: 200, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  if (!token) return json(400, { error: 'Missing token' });

  const found = await lookupEnvelopeByToken(token);
  if (!found) return json(404, { error: 'Signing link not found' });
  const { envelope, signerIndex } = found;
  const signer = envelope.signers[signerIndex];

  const expired = signer.tokenExpiresAt && new Date(signer.tokenExpiresAt) < new Date();
  const alreadySigned = !!(signer.audit && signer.audit.signedAt);

  // Look up the LO\u2019s name for the page header.
  let loName = envelope.requesterEmail;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });
    const p = await profilesStore.get(keySafe(envelope.requesterEmail), { type: 'json' });
    if (p) {
      const n = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
      if (n) loName = n;
    }
  } catch (_) {}

  // Look up property address for context.
  let propertyAddress = '';
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });
    const client = await clientsStore.get(`${envelope.ownerKey}/${envelope.clientId}`, { type: 'json' });
    const loan = client && (client.loans || []).find((l) => l.id === envelope.loanId);
    if (loan) propertyAddress = loan.propertyAddress || '';
  } catch (_) {}

  return json(200, {
    envelopeId: envelope.id,
    propertyAddress,
    message: envelope.message || '',
    loName,
    signer: {
      firstName: signer.firstName,
      lastName:  signer.lastName,
      email:     signer.email,
      alreadySigned,
    },
    docs: (envelope.docs || []).map((d, i) => ({
      idx: i,
      name: d.name,
      kind: d.kind,
      pdfSize: d.pdfSize,
      pdfHash: d.pdfHash,
    })),
    status: envelope.status,
    expired,
  });
}

// Token \u2192 envelope lookup. Fast path via the signer index; fallback to
// a walk of the envelopes store if the index miss.
export async function lookupEnvelopeByToken(token) {
  if (!token) return null;
  const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });

  let envelopeKey = null;
  let signerIndex = -1;
  try {
    const rec = await idx.get(token, { type: 'json' });
    if (rec && rec.envelopeKey != null && rec.signerIndex != null) {
      envelopeKey = rec.envelopeKey;
      signerIndex = rec.signerIndex;
    }
  } catch (_) {}

  if (envelopeKey) {
    try {
      const env = await envStore.get(envelopeKey, { type: 'json' });
      if (env && env.signers && env.signers[signerIndex] && env.signers[signerIndex].token === token) {
        return { envelope: env, envelopeKey, signerIndex };
      }
    } catch (_) {}
  }

  // Walk fallback
  try {
    const { blobs } = await envStore.list();
    for (const { key } of blobs) {
      const env = await envStore.get(key, { type: 'json' });
      if (!env || !env.signers) continue;
      const i = env.signers.findIndex((s) => s && s.token === token);
      if (i >= 0) {
        // Backfill the index
        try {
          await idx.setJSON(token, {
            envelopeKey: key,
            signerIndex: i,
            expiresAt: env.signers[i].tokenExpiresAt,
          });
        } catch (_) {}
        return { envelope: env, envelopeKey: key, signerIndex: i };
      }
    }
  } catch (e) {
    console.warn('envelope walk failed:', e && e.message);
  }
  return null;
}
