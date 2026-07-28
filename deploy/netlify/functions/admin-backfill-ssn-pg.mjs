/**
 * admin-backfill-ssn-pg.mjs — POST /api/admin-backfill-ssn-pg
 *
 * Surgical repair for the "SSNs not showing on borrower profiles" bug.
 *
 * The blob store is the source of truth and DOES hold the encrypted SSNs
 * (client-ssn-reveal decrypts them fine). But Postgres — which the profile
 * UI now reads (hasSSN = !!clients.ssn_enc) after the C3 cutover — is
 * missing ssn_enc for most clients. The bulk re-mirror
 * (admin-backfill-loans-pg, which uses a PostgREST merge-duplicates upsert)
 * did NOT persist ssn_enc even when the projected payload carried it — the
 * ~only clients that have it in PG got there via the writeClient/RPC path.
 *
 * This endpoint sidesteps that: it walks the clients blob store and, for
 * every record whose blob has ssn_enc, does a DIRECT PATCH by primary key
 * (db.update — UPDATE ... WHERE id = ...) of ONLY the ssn_enc + ssn_last4
 * columns. Nothing else on the row is touched, so there's no risk of
 * clobbering fresher PG data. ssn_last4 is taken from the blob's ssnLast4
 * when present, otherwise derived by decrypting ssn_enc (server-side, never
 * returned).
 *
 * Body:
 *   { mode: 'count' | 'run',   // default 'count' (read-only)
 *     clientId?: string,        // restrict to ONE client (for a safe test)
 *     limit?: number }          // cap clients processed
 *
 * Response includes a `verify` sample: after a run it re-reads a couple of
 * updated clients from PG and reports whether ssn_enc is now present, so we
 * can confirm the write actually landed.
 *
 * Admin-only. Fail-soft per client (an error on one never aborts the rest).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { db, ping } from './_shared/supabase-db.mjs';
import { decryptField } from './_shared/crypto.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-backfill-ssn-pg error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function last4FromRec(rec) {
  // Prefer the stored ssnLast4; otherwise decrypt ssn_enc and take last 4.
  if (rec.ssnLast4) return String(rec.ssnLast4).slice(-4);
  try {
    const ssn = decryptField(rec.ssn_enc);
    const digits = String(ssn || '').replace(/\D/g, '');
    return digits ? digits.slice(-4) : null;
  } catch (_) { return null; }
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  try { const p = await ping(); if (!p.ok) return json(500, { error: 'Supabase ping HTTP ' + p.status }); }
  catch (e) { return json(500, { error: 'Supabase env: ' + (e && e.message) }); }

  const body = (await req.json().catch(() => ({}))) || {};
  const run = body.mode === 'run';
  const onlyClientId = String(body.clientId || '').trim();
  const limit = Number.isFinite(body.limit) && body.limit > 0 ? body.limit : Infinity;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  let scanned = 0, withSsn = 0, patched = 0, failed = 0, patchedLast4 = 0;
  const errors = [];
  const patchedIds = [];

  const { blobs } = await clientsStore.list();
  const READ_CHUNK = 25;
  for (let i = 0; i < blobs.length && scanned < limit; i += READ_CHUNK) {
    const slice = blobs.slice(i, Math.min(i + READ_CHUNK, blobs.length));
    // Sequential within the chunk keeps PG write pressure modest.
    for (const { key } of slice) {
      if (scanned >= limit) break;
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!rec || !rec.id) continue;
      if (onlyClientId && rec.id !== onlyClientId) continue;
      scanned++;
      if (!rec.ssn_enc) continue;   // nothing to backfill for this client
      withSsn++;
      const l4 = last4FromRec(rec);
      if (l4) patchedLast4++;
      if (!run) { patchedIds.push(rec.id); continue; }
      try {
        await db.update('clients', { id: rec.id }, { ssn_enc: rec.ssn_enc, ssn_last4: l4 });
        patched++;
        if (patchedIds.length < 5) patchedIds.push(rec.id);
      } catch (e) {
        failed++;
        if (errors.length < 20) errors.push(rec.id + ': ' + (e && e.message));
      }
    }
  }

  // Verify: re-read up to 3 of the patched clients straight from PG and
  // report whether ssn_enc is now present. Proves the write landed.
  const verify = [];
  if (run) {
    for (const id of patchedIds.slice(0, 3)) {
      const row = await db.first('clients', { eq: { id }, select: 'id,ssn_enc,ssn_last4' }).catch(() => null);
      verify.push({ id, pgHasSSN: !!(row && row.ssn_enc), pgLast4: (row && row.ssn_last4) || '' });
    }
  }

  return json(200, {
    ok: true,
    mode: run ? 'run' : 'count',
    onlyClientId: onlyClientId || null,
    scanned,
    withSsnInBlob: withSsn,
    patched,
    patchedLast4,
    failed,
    sampleIds: patchedIds.slice(0, 10),
    verify,
    errors,
  });
}
