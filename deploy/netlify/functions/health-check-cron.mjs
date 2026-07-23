/**
 * health-check-cron.mjs — scheduled platform health check.
 * Hardening Phase A3 (Deploy 236.388).
 *
 * Runs every 6 hours. Verifies the invariants the platform depends
 * on and Slack-alerts (errors channel) when any fail:
 *
 *   1. Postgres reachable (supabase-db ping).
 *   2. Materialized indexes exist at their current versions
 *      (clients-index, quotes-index, prospects-index) — a version-
 *      mismatched index silently degrades every list page to the
 *      slow fallback path.
 *   3. blob↔PG record-count drift within threshold for clients +
 *      loans. Counts only (blob key listing + PG count query) — the
 *      deep field-level diff stays in admin-blob-pg-sync for manual
 *      runs; this catches gross drift (a failing write path) within
 *      hours instead of waiting for a user to notice a missing tile.
 *
 * Also invocable manually: GET /api/health-check (admin) returns the
 * full report without waiting for the schedule.
 */
import { getStore } from '@netlify/blobs';
import { json, requireAuth, isAdmin, handleOptions } from './_shared/auth.mjs';
import { db, ping } from './_shared/supabase-db.mjs';
import { readIndex as readClientsIndex } from './_shared/clients-index.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs';
import { prospectsIndex } from './_shared/prospects-index.mjs';
import { postSlack } from './_shared/slack.mjs';

export const config = { schedule: '0 */6 * * *' };

const DRIFT_THRESHOLD = 5; // records of blob↔PG count difference tolerated

async function _blobCount(storeName) {
  const store = getStore({ name: storeName, consistency: 'eventual' });
  const { blobs } = await store.list();
  // Count only owner-scoped records (`<owner>/<id>` keys).
  return blobs.filter((b) => b.key.indexOf('/') > 0).length;
}

async function _pgCount(table) {
  // PostgREST count via a HEAD-style minimal select with pagination.
  // Cheap approach: page through select=id — tables are small enough
  // (<5k rows) that 1-5 pages is fine.
  let count = 0;
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const rows = await db.select(table, { select: 'id', limit: PAGE, offset });
    count += (rows || []).length;
    if ((rows || []).length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  return count;
}

async function runChecks(opts) {
  const problems = [];
  const report = { ranAt: new Date().toISOString(), checks: {} };
  const skipDrift = !!(opts && opts.skipDrift);

  // 1. PG reachable
  try {
    const p = await ping();
    report.checks.pg = p.ok ? 'ok' : 'unreachable (HTTP ' + p.status + ')';
    if (!p.ok) problems.push('Postgres unreachable (HTTP ' + p.status + ')');
  } catch (e) {
    report.checks.pg = 'error: ' + (e && e.message);
    problems.push('Postgres ping threw: ' + (e && e.message));
  }

  // 2. Indexes exist at current version
  try {
    const c = await readClientsIndex();
    report.checks.clientsIndex = c.exists ? 'ok' : 'missing/stale-version';
    if (!c.exists) problems.push('clients-index missing or version-mismatched');
  } catch (e) { problems.push('clients-index read threw: ' + (e && e.message)); }
  try {
    const q = await quotesIndex.readIndex();
    report.checks.quotesIndex = q.exists ? 'ok' : 'missing/stale-version';
    if (!q.exists) problems.push('quotes-index missing or version-mismatched');
  } catch (e) { problems.push('quotes-index read threw: ' + (e && e.message)); }
  try {
    const p = await prospectsIndex.readIndex();
    report.checks.prospectsIndex = p.exists ? 'ok' : 'missing/stale-version';
    if (!p.exists) problems.push('prospects-index missing or version-mismatched');
  } catch (e) { problems.push('prospects-index read threw: ' + (e && e.message)); }

  // 3. blob↔PG count drift (clients + loans)
  // Deploy 236.397: skipped on branch deploys. Netlify Blob stores
  // are SITE-scoped — staging shares them with prod while pointing at
  // its own Postgres, so blob-vs-PG counts diverge there by design
  // until Phase C2 retires blob reads. Detection is host-based (the
  // caller passes skipDrift from the request hostname) because
  // CONTEXT is a build-time var that 236.396 wrongly assumed exists
  // at function runtime. The cron itself only ever runs on the
  // published production deploy, so this only affects manual GETs.
  if (skipDrift) {
    report.checks.drift = 'skipped (branch deploy — blob stores are shared with production)';
    report.ok = problems.length === 0;
    report.problems = problems;
    return report;
  }
  try {
    const [blobClients, pgClients] = await Promise.all([
      _blobCount('clients'), _pgCount('clients'),
    ]);
    const diff = Math.abs(blobClients - pgClients);
    report.checks.clientsDrift = 'blob=' + blobClients + ' pg=' + pgClients + ' (Δ' + diff + ')';
    if (diff > DRIFT_THRESHOLD) {
      problems.push('CLIENT drift: blob=' + blobClients + ' vs pg=' + pgClients +
        ' — run /api/admin-blob-pg-sync (dryRun) to diagnose');
    }
  } catch (e) { problems.push('clients drift check threw: ' + (e && e.message)); }
  try {
    // Loans live nested in client blobs, so the blob-side count needs
    // the clients-index (summary rows carry loans[]). Cheap: sum from
    // the index we already read is not exposed here — use PG-only
    // count + compare against the clients-index total if available.
    const pgLoans = await _pgCount('loans');
    report.checks.loansPg = String(pgLoans);
    let idxLoans = null;
    const c = await readClientsIndex();
    if (c.exists && c.index && c.index.byOwner) {
      idxLoans = 0;
      for (const o of Object.keys(c.index.byOwner)) {
        for (const cl of (c.index.byOwner[o] || [])) {
          idxLoans += (cl && Array.isArray(cl.loans)) ? cl.loans.length : 0;
        }
      }
      const diff = Math.abs(idxLoans - pgLoans);
      report.checks.loansDrift = 'index=' + idxLoans + ' pg=' + pgLoans + ' (Δ' + diff + ')';
      if (diff > DRIFT_THRESHOLD) {
        problems.push('LOAN drift: clients-index=' + idxLoans + ' vs pg=' + pgLoans +
          ' — run /api/admin-blob-pg-sync (dryRun) to diagnose');
      }
    }
  } catch (e) { problems.push('loans drift check threw: ' + (e && e.message)); }

  report.ok = problems.length === 0;
  report.problems = problems;
  return report;
}

export default async (req, context) => {
  // Manual invocation path: GET with admin auth returns the report.
  // Scheduled invocations arrive as POSTs from Netlify's scheduler
  // with no user; detect via the scheduled `next_run` body marker OR
  // simply the absence of auth + POST method.
  const isManual = req.method === 'GET';
  if (isManual) {
    const pre = handleOptions(req); if (pre) return pre;
    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
  }

  // Deploy 236.400 — Netlify runs scheduled functions on EVERY deployed
  // context, including branch deploys (learned the hard way: staging's
  // cron fired every 6h comparing prod's shared blobs against staging
  // PG and spammed #platform-errors all night). Scheduled runs bail
  // outside production; staging health is the smoke suite's job.
  // Detection: Netlify's context.deploy.context when present, request
  // hostname (branch deploys carry the "--" infix) as fallback.
  if (!isManual) {
    const deployCtx = (context && context.deploy && context.deploy.context) || '';
    let host = '';
    try { host = new URL(req.url).host; } catch (_) {}
    const isProd = deployCtx ? (deployCtx === 'production') : !host.includes('--');
    if (!isProd) {
      console.log('[health-check] skipping scheduled run on non-production deploy (' + (deployCtx || host) + ')');
      return json(200, { ok: true, skipped: 'non-production scheduled run' });
    }
  }

  // Branch-deploy hostnames always carry the "--" infix
  // (staging--slaloantools.netlify.app); prod serves from the bare
  // site domain or a custom domain. Scheduled runs only ever execute
  // on the published production deploy, so this matters for manual
  // GETs against staging.
  let skipDrift = false;
  try { skipDrift = new URL(req.url).host.includes('--'); } catch (_) {}

  let report;
  try {
    report = await runChecks({ skipDrift });
  } catch (e) {
    report = { ok: false, problems: ['health check itself threw: ' + (e && e.message)] };
  }

  if (!report.ok) {
    const text = ':hospital: *Platform health check FAILED*\n• ' +
      report.problems.join('\n• ');
    await postSlack({ text }, { channel: 'errors' }).catch(() => {});
    console.warn('[health-check] FAILED:', report.problems.join(' | '));
  } else {
    console.log('[health-check] all checks passed', report.checks);
  }

  return json(200, report);
};
