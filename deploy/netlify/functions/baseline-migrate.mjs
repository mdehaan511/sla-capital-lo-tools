/**
 * baseline-migrate.mjs — POST /api/baseline-migrate
 *
 * Deploy 236.177 — Baseline Migration Stage 1. Walks the local
 * mirror + upserts every loan into the SLA `clients` store under
 * the pseudo-owner `baseline-migration@sla-import.local` (see
 * _shared/baseline-upsert.mjs).
 *
 * Body: {
 *   dryRun?:   bool   // default TRUE. Pass dryRun:false to write.
 *   limit?:    number // optional cap for staged testing
 *   offset?:   number // optional starting index
 * }
 *
 * Response:
 *   {
 *     ok, dryRun,
 *     mirrorCount, processed, created, updated, noChange, skipped, errors,
 *     byStatus: { active, approved, closed, denied, on_hold },
 *     samples: [{ externalId, action, status, processingStage, changesCount }, ...]
 *   }
 *
 * Auth: admin only.
 *
 * Idempotent by design — repeat runs update Baseline-authored
 * fields, preserve SLA-authored fields (see baseline-upsert.mjs
 * for the field partition).
 */
import { handleOptions, json, requireAuth, isAdmin, readJsonBody } from './_shared/auth.mjs';
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';
import { upsertBaselineLoan, IMPORT_OWNER_EMAIL, IMPORT_OWNER_KEY } from './_shared/baseline-upsert.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-migrate top-level error:', e);
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
  // Default to dry-run for safety. Caller must opt in with
  // dryRun:false to actually write.
  const dryRun = body.dryRun !== false;
  const offset = Math.max(0, parseInt(body.offset || 0, 10) || 0);
  const limit  = Math.max(0, parseInt(body.limit  || 0, 10) || 0); // 0 = no cap

  const mirror = await listMirroredLoans();
  const slice = limit > 0 ? mirror.slice(offset, offset + limit) : mirror.slice(offset);

  let created = 0, updated = 0, noChange = 0, skipped = 0;
  const errors = [];
  const byStatus = { active: 0, approved: 0, closed: 0, denied: 0, on_hold: 0 };
  const samples = [];
  const sampleCap = 20;

  for (const rec of slice) {
    try {
      const r = await upsertBaselineLoan(rec, { dryRun, includeChanges: true });
      if (r.action === 'created')   created++;
      else if (r.action === 'updated')  updated++;
      else if (r.action === 'no_change') noChange++;
      else if (r.action === 'skipped')   skipped++;
      if (byStatus[r.status] !== undefined) byStatus[r.status]++;
      if (samples.length < sampleCap) {
        samples.push({
          externalId:      r.externalId,
          action:          r.action,
          status:          r.status,
          processingStage: r.processingStage,
          changesCount:    r.changes ? r.changes.length : 0,
        });
      }
    } catch (e) {
      errors.push({ id: rec && rec.Id, error: (e && e.message) || 'unknown' });
    }
  }

  return json(200, {
    ok:            true,
    dryRun,
    mirrorCount:   mirror.length,
    processed:     slice.length,
    created, updated, noChange, skipped,
    errors:        errors.slice(0, 20),
    errorCount:    errors.length,
    byStatus,
    samples,
    importOwner:   IMPORT_OWNER_EMAIL,
    importOwnerKey: IMPORT_OWNER_KEY,
  });
}
