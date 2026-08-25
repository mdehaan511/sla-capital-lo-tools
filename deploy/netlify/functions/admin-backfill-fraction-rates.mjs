/**
 * admin-backfill-fraction-rates.mjs — POST /api/admin-backfill-fraction-rates
 *
 * Deploy 236.716 — ONE-TIME data fix. Baseline imports stored rate fields as
 * decimal fractions (0.069) instead of percent (6.9). Deploy 236.715 already
 * normalizes the Closed Loans DISPLAY; this rewrites the records themselves so
 * every other surface (Loan Details, UW tab, Pipeline) reads correct values.
 *
 * Rule: for each of rate / soldRate / buyRate, a value in (0, 1) is a fraction
 * — scale it ×100. No real rate in this business is below 1%, and sizer-saved
 * percent values (10.375) pass through untouched, so the rule is safe to run
 * repeatedly (idempotent: once scaled, values are ≥ 1).
 *
 * Body: { dryRun?: bool (default true), maxWrites?: int (default 100) }
 *   dryRun returns the full change list without writing. Commit mode writes at
 *   most maxWrites clients per call (stays inside the 26s budget) and reports
 *   `remaining` — re-invoke until remaining is 0.
 *
 * Response: { ok, dryRun, scannedClients, scannedLoans, affectedLoans,
 *             writes, remaining, changes: [{owner, clientId, loanId, address,
 *             field, from, to}] (capped at 500 rows) }
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';

const RATE_FIELDS = ['rate', 'soldRate', 'buyRate'];

function scaled(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[%\s,]/g, ''));
  if (!isFinite(n) || n <= 0 || n >= 1) return null;
  // 0.069 -> '6.9'; trim float noise to 6 decimals.
  return String(+(n * 100).toFixed(6));
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-backfill-fraction-rates error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;           // default TRUE — commit is opt-in
  const maxWrites = Math.max(1, Math.min(500, parseInt(body.maxWrites, 10) || 100));

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await clientsStore.list();

  let scannedClients = 0, scannedLoans = 0, affectedLoans = 0, writes = 0, remaining = 0;
  const changes = [], failures = [];

  // Read in parallel chunks; write sequentially (strict-write discipline).
  const CHUNK = 25;
  for (let i = 0; i < blobs.length; i += CHUNK) {
    const chunk = blobs.slice(i, i + CHUNK);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' })
        .then((rec) => ({ key, rec }))
        .catch(() => ({ key, rec: null }))));
    for (const { key, rec } of recs) {
      if (!rec || !Array.isArray(rec.loans)) continue;
      scannedClients++;
      const owner = key.indexOf('/') > 0 ? key.slice(0, key.indexOf('/')) : '';
      let clientChanges = 0;
      for (const loan of rec.loans) {
        if (!loan) continue;
        scannedLoans++;
        let loanTouched = false;
        for (const f of RATE_FIELDS) {
          const to = scaled(loan[f]);
          if (to == null) continue;
          if (changes.length < 500) {
            changes.push({ owner, clientId: rec.id, loanId: loan.id, address: loan.address || '', field: f, from: String(loan[f]), to });
          }
          if (!dryRun) loan[f] = to;
          loanTouched = true; clientChanges++;
        }
        if (loanTouched) affectedLoans++;
      }
      if (clientChanges && !dryRun) {
        if (writes >= maxWrites) { remaining++; continue; }
        rec.updatedAt = new Date().toISOString();
        // A failed write (e.g. the pg-mirror's status-demotion guard firing on
        // pre-existing blob↔PG drift) must not abort the whole batch — skip the
        // client, report it, keep going. Failures stay unfixed and reappear on
        // the next run, so nothing is silently lost.
        try {
          await writeClient(owner, rec, { clientsStore });
          writes++;
        } catch (e) {
          failures.push({ owner, clientId: rec.id, error: (e && e.message || 'unknown').slice(0, 300) });
        }
      }
    }
  }

  return json(200, { ok: true, dryRun, scannedClients, scannedLoans, affectedLoans, writes, remaining, failures, changes });
}
