/**
 * admin-import-batch.mjs — POST /api/admin-import-batch
 *
 * Deploy 236.331 — bulk-import batch write. Client-side importer
 * calls this in chunks (default 50/batch) with an already-deduped
 * list of new clients. Server writes each as `<ownerKey>/<clientId>`
 * in the clients blob store. No dedupe check here — the client
 * already filtered against admin-import-preview.
 *
 * Body: {
 *   clients: [
 *     { firstName, lastName, email, phone, ownerEmail },
 *     ...
 *   ]
 * }
 *   Max 200 per request (typical batch is 50; higher values push
 *   the Netlify Functions 10s ceiling).
 *
 * Response: {
 *   ok: true,
 *   created: N,
 *   failed: [ { row, email, reason }, ... ],
 * }
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.341 — write-through the clients-index blob so bulk-
// imported clients show up in cross-owner reads immediately without
// waiting for the next background rebuild.
import { upsertClient } from './_shared/clients-index.mjs';

const MAX_BATCH = 200;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-import-batch error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (!body || !Array.isArray(body.clients)) {
    return json(400, { error: 'clients array required' });
  }
  if (body.clients.length > MAX_BATCH) {
    return json(400, { error: `batch cap is ${MAX_BATCH}; got ${body.clients.length}` });
  }

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const now = new Date().toISOString();
  const importedBy = normalizeEmail(user.email);

  const failed = [];
  let created = 0;

  // Write records sequentially in parallel batches of 10 to avoid
  // hammering Netlify Blobs while still finishing well under 10s
  // for a 50-item chunk.
  const PAR = 10;
  for (let i = 0; i < body.clients.length; i += PAR) {
    const slice = body.clients.slice(i, i + PAR);
    const results = await Promise.all(slice.map(async (raw, idx) => {
      const rowIdx = i + idx;
      try {
        const email = String(raw.email || '').trim().toLowerCase();
        const ownerEmail = String(raw.ownerEmail || '').trim().toLowerCase();
        if (!email || email.indexOf('@') < 1) {
          return { ok: false, rowIdx, email, reason: 'invalid email' };
        }
        if (!ownerEmail || ownerEmail.indexOf('@') < 1) {
          return { ok: false, rowIdx, email, reason: 'missing owner' };
        }
        const firstName  = String(raw.firstName  || '').trim();
        const lastName   = String(raw.lastName   || '').trim();
        const phone      = String(raw.phone      || '').trim();
        // Deploy 236.332 — accept optional entityName from the
        // importer (CRM exports usually have an Organization column).
        const entityName = String(raw.entityName || '').trim();

        const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const ownerKey = keySafe(normalizeEmail(ownerEmail));
        const key = ownerKey + '/' + keySafe(clientId);

        const record = {
          id: clientId,
          firstName, lastName,
          email, phone,
          entityName,
          createdAt: now,
          updatedAt: now,
          createdBy: ownerEmail,
          loans: [],
          companies: [],
          _importedAt: now,
          _importedBy: importedBy,
          _importSource: 'bulk-csv',
        };
        await store.setJSON(key, record);
        upsertClient(ownerKey, record).catch(() => {});
        return { ok: true, rowIdx };
      } catch (e) {
        return { ok: false, rowIdx, email: raw && raw.email, reason: (e && e.message) || 'write failed' };
      }
    }));
    for (const r of results) {
      if (r.ok) created++;
      else failed.push({ row: r.rowIdx, email: r.email || '', reason: r.reason });
    }
  }

  return json(200, {
    ok: true,
    created,
    failed,
    submitted: body.clients.length,
  });
}
