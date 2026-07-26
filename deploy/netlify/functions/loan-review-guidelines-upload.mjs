/**
 * loan-review-guidelines-upload.mjs — POST /api/loan-review-guidelines-upload
 *
 * Super-admin only. Stores the investor's underwriting guidelines PDF
 * so the AI doc-review (loan-review-doc-upload) can attach it on every
 * Claude vision call.
 *
 * Body: {
 *   investor:     'diya' | 'colchis' | other lowercase string,
 *   filename:     string,
 *   contentBase64: base64-encoded PDF bytes,
 * }
 *
 * Key shape: <investor> (lowercase). Re-uploading the same investor
 * overwrites the previous version.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isSuperAdmin, normalizeEmail,
} from './_shared/auth.mjs';

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — same cap as doc upload

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-review-guidelines-upload error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const investor = String(body.investor || '').toLowerCase().trim();
  if (!investor) return json(400, { error: 'investor required' });
  if (!body.contentBase64) return json(400, { error: 'contentBase64 required' });

  let bytes;
  try { bytes = Buffer.from(body.contentBase64, 'base64'); }
  catch (e) { return json(400, { error: 'contentBase64 invalid' }); }
  if (!bytes.length) return json(400, { error: 'Empty file' });
  if (bytes.length > MAX_BYTES) return json(413, { error: 'File too large (max 25MB)' });

  const now = new Date().toISOString();
  const store = getStore({ name: 'loan-review-guidelines', consistency: 'strong' });
  await store.set(investor, bytes, {
    metadata: {
      investor,
      filename:   String(body.filename || (investor + '-guidelines.pdf')),
      uploadedAt: now,
      uploadedBy: normalizeEmail(user.email),
    },
  });

  return json(200, {
    ok: true,
    investor,
    sizeBytes: bytes.length,
    uploadedAt: now,
  });
}
