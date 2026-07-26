/**
 * envelopes-refresh.mjs — POST /api/envelopes-refresh
 *
 * NATIVE eSIGN \u2014 Deploy 185. Re-read the envelope from our own blob
 * store and return the latest state. There\u2019s no external service to
 * refresh against; this endpoint exists only to preserve the existing
 * frontend API surface (the loan-details UI polls it on demand).
 *
 * Body: { envelopeId, owner? }
 * Returns: { ok, envelope, changed: false }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const body = await readJsonBody(req);
    if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });

    const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
    const store = getStore({ name: 'envelopes', consistency: 'strong' });
    const key = `${ownerKey}/${body.envelopeId}`;
    let env;
    try { env = await store.get(key, { type: 'json' }); }
    catch (_) { env = null; }
    if (!env) return json(404, { error: 'Envelope not found' });

    if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
      return json(403, { error: 'Not authorized to refresh this envelope' });
    }

    // Strip tokens from the response (security: tokens are signer-private)
    const sanitized = {
      ...env,
      signers: (env.signers || []).map((s) => ({
        firstName: s.firstName, lastName: s.lastName, email: s.email,
        role: s.role, signingOrder: s.signingOrder,
        signedAt: s.signedAt || (s.audit && s.audit.signedAt) || null,
        invitedAt: s.invitedAt, resendCount: s.resendCount,
        hasSigned: !!(s.audit && s.audit.signedAt),
        audit: s.audit ? {
          signedAt: s.audit.signedAt,
          ipAddress: s.audit.ipAddress,
          consentVersion: s.audit.consentVersion,
          geolocation: s.audit.geolocation,
          seal: s.audit.seal ? (s.audit.seal.slice(0, 32) + '\u2026') : '',
        } : null,
      })),
      envelopeMode: env.envelopeMode || (env.pandadocMode ? 'pandadoc-legacy' : 'native'),
    };

    return json(200, { ok: true, envelope: sanitized, changed: false });
  } catch (e) {
    console.error('envelopes-refresh error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};
