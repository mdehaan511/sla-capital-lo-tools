/**
 * admin-import-preview.mjs — POST /api/admin-import-preview
 *
 * Deploy 236.331 — bulk-import preview. Given a list of emails,
 * returns the set that ALREADY exist as clients anywhere in the
 * system so the client-side importer can mark those rows as skips
 * before the user confirms.
 *
 * Body: { emails: [ 'a@x.com', 'b@y.com', ... ] }
 *   Deduplicated + lowercased server-side. Cap: 30 000 emails per
 *   request (well over the reported 20 852 CRM export).
 *
 * Response: { existing: [ 'a@x.com', ... ] }
 *   Only the intersection — client-side subtracts to get the "will
 *   be created" count. Every match reason is "email exists in the
 *   clients blob store under SOME owner namespace" — cross-owner
 *   dedupe per Mike's Deploy 236.331 config choice.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
} from './_shared/auth.mjs';

const MAX_INPUT = 30000;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-import-preview error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (!body || !Array.isArray(body.emails)) {
    return json(400, { error: 'emails array required' });
  }
  if (body.emails.length > MAX_INPUT) {
    return json(400, { error: `emails cap is ${MAX_INPUT}; got ${body.emails.length}` });
  }

  // Normalize + dedupe input.
  const wanted = new Set();
  for (const e of body.emails) {
    const t = String(e || '').trim().toLowerCase();
    if (t && t.indexOf('@') > 0) wanted.add(t);
  }
  if (wanted.size === 0) return json(200, { existing: [], scanned: 0 });

  // Scan every client blob once; check email against the wanted set.
  // O(N clients) — the wanted set is O(1) lookup. Faster than 20K
  // per-email lookups.
  const store = getStore({ name: 'clients', consistency: 'strong' });
  const existing = new Set();
  let scanned = 0;

  const { blobs } = await store.list();
  // Parallel-fetch in chunks of 25 to keep memory reasonable.
  const CHUNK = 25;
  for (let i = 0; i < blobs.length; i += CHUNK) {
    const slice = blobs.slice(i, i + CHUNK);
    const recs = await Promise.all(slice.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)));
    for (const rec of recs) {
      scanned++;
      if (!rec) continue;
      const em = String(rec.email || '').trim().toLowerCase();
      if (em && wanted.has(em)) existing.add(em);
    }
    // Bail early once we've matched every wanted email — no point
    // scanning the rest.
    if (existing.size === wanted.size) break;
  }

  return json(200, {
    existing: Array.from(existing),
    scanned,
    requested: wanted.size,
  });
}
