/**
 * envelopes-void.mjs — POST /api/envelopes/:id/void
 *
 * Cancels (voids) an envelope. In Phase 1 this just flips the status
 * to 'voided' since there's no PandaDoc envelope to actually cancel.
 * In Phase 2 we'll add the real cancel API call.
 *
 * Body: { envelopeId, owner?, reason? }
 *
 * Auth:
 *   - The requester (whoever sent it) can void.
 *   - Admins can void anyone's envelope.
 *   - Already-completed or already-voided envelopes can't be re-voided.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
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
  try {
    env = await store.get(key, { type: 'json' });
  } catch (_) { env = null; }
  if (!env) return json(404, { error: 'Envelope not found' });

  // Permission check: requester must be the original sender or an admin
  if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
    return json(403, { error: 'Not authorized to void this envelope' });
  }

  if (env.status === 'completed' || env.status === 'voided') {
    return json(400, { error: 'Envelope already ' + env.status });
  }

  const now = new Date().toISOString();
  env.status = 'voided';
  env.statusUpdatedAt = now;
  env.history = env.history || [];
  env.history.push({
    ts: now,
    status: 'voided',
    note: 'Voided by ' + normalizeEmail(user.email) + (body.reason ? ': ' + String(body.reason).slice(0, 200) : ''),
  });

  // Phase 2 TODO: if env.pandadocEnvelopeId, call PandaDoc void here

  try {
    await store.setJSON(key, env);
  } catch (e) {
    console.error('envelopes-void write failed:', e);
    return json(500, { error: 'Failed to update envelope' });
  }

  return json(200, { ok: true, envelope: env });
};
