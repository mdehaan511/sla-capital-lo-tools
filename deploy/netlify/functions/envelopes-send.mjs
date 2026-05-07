/**
 * envelopes-send.mjs — POST /api/envelopes-send
 *
 * Second phase of the e-sign flow. The frontend calls /api/envelopes
 * first (fast: validates + saves record + stashes PDF bytes), then this
 * endpoint to do the slow PandaDoc upload+send. Decoupling them keeps
 * each call short and well clear of any function timeout.
 *
 * Body: { envelopeId, owner? }
 *
 * Returns the updated envelope record. On live send timeout (PDF still
 * processing on PandaDoc's side after our 6s poll), returns ok: true
 * with envelope.status='queued' — the LO clicks "Refresh status" later
 * to complete the send.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { sendEnvelope, pandadocStatus, mapStatus } from './_shared/pandadoc.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('envelopes-send top-level error:', e);
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
  try { env = await store.get(key, { type: 'json' }); }
  catch (_) { env = null; }
  if (!env) return json(404, { error: 'Envelope not found' });

  // Permission check
  if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
    return json(403, { error: 'Not authorized to send this envelope' });
  }

  // Don't re-send already-sent envelopes
  if (env.status !== 'queued') {
    return json(200, { ok: true, envelope: env, note: 'Envelope already past queued state' });
  }

  const pdStatus = pandadocStatus();

  // If PandaDoc isn't configured this is a no-op (Phase 1 stub mode):
  // the envelope stays in 'queued' state with no documentId.
  if (!pdStatus.enabled) {
    env.history = env.history || [];
    env.history.push({
      ts: new Date().toISOString(),
      status: 'queued',
      note: 'Send called but PandaDoc not configured (stub mode).',
    });
    try { await store.setJSON(key, env); } catch (_) {}
    return json(200, { ok: true, envelope: env, note: 'PandaDoc not configured' });
  }

  // Pull stashed PDFs from the side blob store.
  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });

  let lastResult = null;
  for (let i = 0; i < (env.docs || []).length; i++) {
    const doc = env.docs[i];
    const stamp = new Date().toISOString();

    if (doc.kind !== 'rate_sheet') {
      env.history.push({
        ts: stamp,
        status: 'queued',
        note: 'Skipped ' + doc.kind + ' — anchor tags not yet wired into that document type.',
      });
      continue;
    }
    if (!doc.hadPdf) {
      env.history.push({
        ts: stamp,
        status: 'queued',
        note: 'Skipped rate sheet — no PDF bytes were uploaded with the create call.',
      });
      continue;
    }

    // Fetch PDF bytes for this doc
    let pdfBase64 = null;
    try {
      pdfBase64 = await pdfStore.get(`${ownerKey}/${env.id}/${i}`);
    } catch (_) { pdfBase64 = null; }
    if (!pdfBase64) {
      env.status = 'failed';
      env.statusUpdatedAt = stamp;
      env.sendError = 'PDF bytes not found in storage';
      env.history.push({
        ts: stamp,
        status: 'failed',
        note: 'PDF lookup failed — bytes missing from storage.',
      });
      break;
    }

    const result = await sendEnvelope({
      pdfBase64,
      name: doc.name || 'Rate Sheet',
      signers: env.signers,
      message: env.message,
      subject: 'SLA Capital — Please review and sign: ' + (doc.name || 'Rate Sheet'),
      envelopeId: env.id,
    });
    lastResult = result;

    if (result.ok) {
      env.pandadocDocumentId = result.pandadocDocumentId;
      if (result.pending) {
        env.history.push({
          ts: stamp,
          status: 'queued',
          note: 'Uploaded to PandaDoc (doc ' + result.pandadocDocumentId + '), still processing. Click "Refresh status" in a minute to complete the send.',
        });
      } else {
        const mapped = mapStatus(result.status);
        if (result.mode === 'live' && mapped) {
          env.status = mapped;
          env.statusUpdatedAt = stamp;
        }
        env.history.push({
          ts: stamp,
          status: env.status,
          note: result.mode === 'dry-run'
            ? 'Dry-run send simulated. PDF size: ' + pdfBase64.length + ' bytes.'
            : 'Sent via PandaDoc (document ' + result.pandadocDocumentId + ').',
        });
      }
    } else {
      env.status = 'failed';
      env.statusUpdatedAt = stamp;
      env.sendError = result.error || 'unknown';
      env.history.push({
        ts: stamp,
        status: 'failed',
        note: 'Send failed: ' + (result.error || 'unknown'),
      });
      break;
    }
  }

  // Persist updated record
  try { await store.setJSON(key, env); }
  catch (e) { console.warn('envelope post-send write failed:', e && e.message); }

  // Cleanup: delete stashed PDFs after a successful (or definitively
  // failed) send so we don't accumulate megabytes of dead bytes. We KEEP
  // them only when status is still 'queued' (pending case — refresh may
  // need them again, though refresh uses the documentId, not the bytes).
  if (env.status !== 'queued') {
    const docCount = (env.docs || []).length;
    for (let i = 0; i < docCount; i++) {
      try { await pdfStore.delete(`${ownerKey}/${env.id}/${i}`); }
      catch (_) {}
    }
  }

  if (lastResult && !lastResult.ok && pdStatus.mode === 'live') {
    return json(502, {
      ok: false,
      envelope: env,
      error: 'PandaDoc send failed: ' + lastResult.error,
    });
  }

  return json(200, { ok: true, envelope: env });
}
