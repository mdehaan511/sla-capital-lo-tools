/**
 * envelopes-refresh.mjs — POST /api/envelopes-refresh
 *
 * Manually refresh an envelope's status from PandaDoc. Until Phase 3 wires
 * up webhooks, this is how the LO sees whether the borrower has viewed,
 * signed, or completed an envelope.
 *
 * Two responsibilities:
 *   1. Pull the latest PandaDoc status, map it onto our internal status,
 *      surface per-recipient signing state.
 *   2. If the envelope is in 'queued' state and the document just reached
 *      draft (i.e. the initial create timed out our short waitForDraft and
 *      the LO is now coming back), trigger the send call. This lets the
 *      "Refresh status" button finish what the create call started.
 *
 * Body: { envelopeId, owner? }
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
const PD_BASE = 'https://api.pandadoc.com/public/v1';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('envelopes-refresh top-level error:', e);
    return json(500, {
      error: 'Server error: ' + ((e && e.message) || 'unknown'),
      stack: String((e && e.stack) || '').split('\n').slice(0, 5).join(' | ').slice(0, 500),
    });
  }
};

async function handle(req, context) {
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

  // Hit PandaDoc for the doc's current status
  const result = await getDocumentStatus(env.pandadocDocumentId);
  if (!result.ok) {
    return json(502, {
      ok: false,
      envelope: env,
      error: result.error || 'PandaDoc status fetch failed',
    });
  }

  const stamp = new Date().toISOString();
  let changed = false;
  let triggeredSend = false;
  let sendError = null;

  // ── Recovery path: doc reached draft, our queued envelope hasn't been
  //    sent yet — trigger the send call now.
  if (env.status === 'queued' && result.status === 'document.draft') {
    try {
      const sendResp = await fetch(`${PD_BASE}/documents/${env.pandadocDocumentId}/send`, {
        method: 'POST',
        headers: {
          'Authorization': `API-Key ${process.env.PANDADOC_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: String(env.message || '').slice(0, 4000),
          subject: 'SLA Capital — Please review and sign',
          silent: false,
        }),
      });
      const sendBody = await sendResp.json().catch(() => ({}));
      if (sendResp.ok) {
        env.status = 'sent';
        env.statusUpdatedAt = stamp;
        env.history = env.history || [];
        env.history.push({
          ts: stamp,
          status: 'sent',
          note: 'Refresh: doc finished uploading, send triggered.',
        });
        triggeredSend = true;
        changed = true;
      } else {
        sendError = sendBody.detail || sendBody.message || ('HTTP ' + sendResp.status);
        env.history = env.history || [];
        env.history.push({
          ts: stamp,
          status: env.status,
          note: 'Refresh: send retry failed (' + sendError + ').',
        });
      }
    } catch (e) {
      sendError = (e && e.message) || 'fetch failed';
      env.history = env.history || [];
      env.history.push({
        ts: stamp,
        status: env.status,
        note: 'Refresh: send retry threw (' + sendError + ').',
      });
    }
  }

  // Otherwise, map and store the latest PandaDoc-side status
  if (!triggeredSend) {
    const mapped = mapStatus(result.status);
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
  }

  // Also surface per-recipient signing state so the LO can see who signed
  if (Array.isArray(result.recipients)) {
    env.recipientStatus = result.recipients.map((r) => ({
      email: r.email,
      hasCompleted: !!r.has_completed,
      lastViewDate: r.last_view_date || null,
    }));
  }

  if (changed || env.recipientStatus || triggeredSend) {
    try { await store.setJSON(key, env); }
    catch (e) { console.warn('refresh write failed:', e && e.message); }
  }

  return json(200, {
    ok: true,
    envelope: env,
    changed,
    triggeredSend,
    sendError,
    rawStatus: result.status,
  });
}
