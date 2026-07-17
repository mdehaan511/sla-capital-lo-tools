/**
 * admin-pg-resync.mjs — POST /api/admin-pg-resync
 *
 * Phase 2 recovery tool. Reads one client (and its loans) from the
 * blob store and force-upserts them into Postgres — the same mirror
 * call an instrumented mutation endpoint would fire, but callable
 * on demand. Use when admin-pg-diff shows drift and you want to
 * heal it immediately without waiting for the next mutation.
 *
 * Body: { clientId, owner? }
 * Response: { ok, wroteClient, wroteLoans, deletedStaleLoans, blobFound }
 *
 * Admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { projectClient, projectLoan } from './_shared/pg-projections.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-pg-resync error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const clientId = String(body.clientId || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });

  const selfEmail = normalizeEmail(user.email);
  const ownerParam = String(body.owner || '').trim();
  const ownerKey = ownerParam ? keySafe(normalizeEmail(ownerParam)) : keySafe(selfEmail);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const blobKey = ownerKey + '/' + keySafe(clientId);
  const rec = await clientsStore.get(blobKey, { type: 'json' }).catch(() => null);
  if (!rec) return json(404, { error: 'Client not found in blob store at ' + blobKey });

  // Directly upsert (not via pg-mirror's fire-and-forget wrapper) so
  // we can await + report errors. Same projections + same conflict
  // targets, just synchronous so the response reflects the actual
  // outcome instead of "started".
  const cRow = projectClient(rec, ownerKey);
  const loanRows = [];
  const currentLoanIds = new Set();
  if (Array.isArray(rec.loans)) {
    for (const l of rec.loans) {
      if (!l || !l.id) continue;
      const row = projectLoan(l, cRow.id, ownerKey);
      if (row) { loanRows.push(row); currentLoanIds.add(l.id); }
    }
  }

  let wroteClient = false;
  let wroteLoans = 0;
  let deletedStaleLoans = 0;
  const errors = [];

  try {
    await db.upsert('clients', cRow, { onConflict: 'id' });
    wroteClient = true;
  } catch (e) {
    errors.push('client upsert failed: ' + (e && e.message));
    // If the client write fails, the loan writes will FK-fail. Give up.
    return json(500, { ok: false, errors });
  }

  if (loanRows.length) {
    try {
      await db.upsert('loans', loanRows, { onConflict: 'id' });
      wroteLoans = loanRows.length;
    } catch (e) {
      errors.push('loans upsert failed: ' + (e && e.message));
    }
  }

  // Reconcile: delete PG loans that USED to be on this client but
  // aren't anymore. Same logic pg-mirror.upsertClientWithLoans has.
  try {
    const existing = await db.select('loans', {
      select: 'id',
      eq: { client_id: cRow.id },
    });
    for (const row of (existing || [])) {
      if (row && row.id && !currentLoanIds.has(row.id)) {
        try {
          await db.del('loans', { id: row.id });
          deletedStaleLoans++;
        } catch (e) {
          errors.push('stale loan delete ' + row.id + ' failed: ' + (e && e.message));
        }
      }
    }
  } catch (e) {
    errors.push('stale-loan reconcile failed: ' + (e && e.message));
  }

  return json(200, {
    ok: errors.length === 0,
    ownerKey,
    clientId,
    wroteClient,
    wroteLoans,
    deletedStaleLoans,
    blobFound: true,
    errors,
  });
}
