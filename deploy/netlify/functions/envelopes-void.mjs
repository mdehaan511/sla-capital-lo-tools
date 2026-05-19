/**
 * envelopes-void.mjs — POST /api/envelopes-void
 *
 * NATIVE eSIGN \u2014 Deploy 185. Cancels an envelope:
 *   1. Invalidates every signer token by removing them from the
 *      `envelope-signer-idx` and clearing them on the envelope.
 *   2. Flips status to 'voided'.
 *   3. Deletes any stashed original-PDF and final-PDF bytes.
 *
 * Body: { envelopeId, owner?, reason? }
 * Auth: requester or admin.
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

    const user = requireAuth(context, req);
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
      return json(403, { error: 'Not authorized to void this envelope' });
    }
    if (env.status === 'completed' || env.status === 'voided') {
      return json(400, { error: 'Envelope already ' + env.status });
    }

    const now = new Date().toISOString();

    // Invalidate every outstanding token
    const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
    env.signers = (env.signers || []).map((s) => {
      if (s.token) {
        // Best-effort delete from index; the token also gets cleared
        // from the envelope itself.
        idx.delete(s.token).catch(() => {});
      }
      return { ...s, token: null };
    });

    env.status = 'voided';
    env.statusUpdatedAt = now;
    env.history = env.history || [];
    env.history.push({
      ts: now, status: 'voided',
      note: 'Voided by ' + normalizeEmail(user.email) +
        (body.reason ? ': ' + String(body.reason).slice(0, 200) : ''),
    });

    try { await store.setJSON(key, env); }
    catch (e) {
      console.error('envelopes-void write failed:', e);
      return json(500, { error: 'Failed to update envelope' });
    }

    // Clean up stashed bytes (best-effort)
    const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
    const finalStore = getStore({ name: 'envelope-final-pdfs', consistency: 'strong' });
    for (let i = 0; i < (env.docs || []).length; i++) {
      pdfStore.delete(`${env.ownerKey}/${env.id}/${i}`).catch(() => {});
      finalStore.delete(`${env.ownerKey}/${env.id}/${i}`).catch(() => {});
    }

    return json(200, { ok: true, envelope: env });
  } catch (e) {
    console.error('envelopes-void error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};
