/**
 * envelopes-refresh.mjs — POST /api/envelopes-refresh
 *
 * Manually refresh an envelope's status from PandaDoc. Until Phase 3 wires
 * up webhooks, this is how the LO sees whether the borrower has viewed,
 * signed, or completed an envelope.
 *
 * Body: { envelopeId, owner? }
 *
 * No-op if:
 *   - PandaDoc is not configured (mode=disabled)
 *   - The envelope's pandadocDocumentId is missing or starts with 'dry-'
 *   - The envelope is already in a terminal state (completed/voided/expired)
 *
 * Permission: requester (original sender) or admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { getDocumentStatus, mapStatus, pandadocStatus } from './_shared/pandadoc.mjs';

const TERMINAL = new Set(['completed', 'voided', 'expired']);

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

  // Permission check
  if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
    return json(403, { error: 'Not authorized to refresh this envelope' });
  }

  // Nothing to refresh from
  if (TERMINAL.has(env.status)) {
    return json(200, { ok: true, envelope: env, note: 'Already in terminal state' });
  }
  if (!env.pandadocDocumentId) {
    return json(200, { ok: true, envelope: env, note: 'No PandaDoc document ID — nothing to refresh' });
  }
  if (String(env.pandadocDocumentId).startsWith('dry-')) {
    return json(200, { ok: true, envelope: env, note: 'Dry-run envelope — nothing to refresh' });
  }
  const pd = pandadocStatus();
  if (pd.mode === 'disabled') {
    return json(200, { ok: true, envelope: env, note: 'PandaDoc not configured' });
  }

  // Hit PandaDoc
  const result = await getDocumentStatus(env.pandadocDocumentId);
  if (!result.ok) {
    return json(502, {
      ok: false,
      envelope: env,
      error: result.error || 'PandaDoc status fetch failed',
    });
  }

  const mapped = mapStatus(result.status);
  const stamp = new Date().toISOString();
  let changed = false;
  if (mapped && mapped !== env.status) {
    env.status = mapped;
    env.statusUpdatedAt = stamp;
    env.history = env.history || [];
    env.history.push({
      ts: stamp,
      status: mapped,
      note: 'Refreshed from PandaDoc (raw status: ' + result.status + ')',
    });
    changed = true;
  }

  // Also surface per-recipient signing state so the LO can see who signed
  if (Array.isArray(result.recipients)) {
    env.recipientStatus = result.recipients.map((r) => ({
      email: r.email,
      hasCompleted: !!r.has_completed,
      lastViewDate: r.last_view_date || null,
    }));
  }

  if (changed || env.recipientStatus) {
    try { await store.setJSON(key, env); }
    catch (e) { console.warn('refresh write failed:', e && e.message); }
  }

  return json(200, {
    ok: true,
    envelope: env,
    changed,
    rawStatus: result.status,
  });
};
