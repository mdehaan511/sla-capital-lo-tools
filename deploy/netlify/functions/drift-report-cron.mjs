/**
 * drift-report-cron.mjs — daily blob↔PG deep drift report.
 * Deploy 236.432 (Hardening C5 — the bake-off clock).
 *
 * Runs the full presence diff (_shared/blob-pg-drift.mjs — the same
 * scan admin-blob-pg-sync's dry-run performs) once a day and posts a
 * one-line report to #platform-errors. It posts EVERY day, clean or
 * not — the daily line is the bake-off evidence trail, and a silent
 * cron is indistinguishable from a dead one.
 *
 * C5 criterion: after 7 consecutive clean reports, blob reads retire
 * and Postgres becomes the only read path. The 6-hour health-check
 * cron still catches gross count drift between these daily deep runs.
 *
 * Schedule: 10:00 UTC = 3am Pacific (quiet hours, after any late
 * evening LO activity has settled).
 *
 * Manual runs: GET with admin auth returns the full JSON report
 * (and skips Slack — the poster is the schedule, not the browser).
 */
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { computeDrift } from './_shared/blob-pg-drift.mjs';
import { postSlack } from './_shared/slack.mjs';

export const config = { schedule: '0 10 * * *' };

export default async (req, context) => {
  // Manual invocation: GET with admin auth. Scheduled invocations
  // arrive as POSTs from Netlify's scheduler with no user.
  const isManual = req.method === 'GET';
  if (isManual) {
    const pre = handleOptions(req); if (pre) return pre;
    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
  }

  // Deploy 236.400 pattern — Netlify fires scheduled functions on
  // EVERY deployed context including branch deploys; staging's cron
  // would diff prod's shared blobs against staging PG and cry drift
  // all night. Scheduled runs bail outside production.
  if (!isManual) {
    const deployCtx = (context && context.deploy && context.deploy.context) || '';
    let host = '';
    try { host = new URL(req.url).host; } catch (_) {}
    const isProd = deployCtx ? (deployCtx === 'production') : !host.includes('--');
    if (!isProd) {
      console.log('[drift-report] skipping scheduled run on non-production deploy (' + (deployCtx || host) + ')');
      return json(200, { ok: true, skipped: 'non-production scheduled run' });
    }
  }

  let drift;
  try {
    drift = await computeDrift();
  } catch (e) {
    const msg = (e && e.message) || 'unknown';
    if (!isManual) {
      await postSlack({
        text: ':warning: *C5 drift report FAILED to run*: ' + msg +
          '\nThe bake-off clock needs a manual `/api/drift-report` run today.',
      }, { channel: 'errors' }).catch(() => {});
    }
    return json(500, { error: 'drift scan failed: ' + msg });
  }

  const mC = drift.missingClients.length;
  const mL = drift.missingLoans.length;
  const oC = drift.orphanClientIds.length;
  const oL = drift.orphanLoanIds.length;
  const clean = (mC + mL + oC + oL) === 0;

  const report = {
    ok: true,
    clean,
    scanned: drift.scanned,
    pgMissing: {
      clients: drift.missingClients.map((c) => ({ id: c.id, ownerKey: c.ownerKey })),
      loans:   drift.missingLoans.map((l) => ({ id: l.id, clientId: l.clientId, ownerKey: l.ownerKey })),
    },
    pgOrphans: { clients: drift.orphanClientIds, loans: drift.orphanLoanIds },
    durationMs: drift.durationMs,
  };

  if (!isManual) {
    const scannedLine = drift.scanned.clients + ' clients / ' + drift.scanned.loans +
      ' loans across ' + drift.scanned.owners + ' owners in ' +
      Math.round(drift.durationMs / 1000) + 's';
    let text;
    if (clean) {
      text = ':white_check_mark: *C5 drift report: CLEAN* — ' + scannedLine;
    } else {
      const sample = (arr) => arr.slice(0, 5).map((x) => '`' + (x.id || x) + '`').join(' ');
      text = ':rotating_light: *C5 drift report: DRIFT FOUND* — ' + scannedLine +
        '\n• PG missing: ' + mC + ' clients, ' + mL + ' loans' +
        (mL ? ' — e.g. ' + sample(drift.missingLoans) : '') +
        '\n• PG orphans: ' + oC + ' clients, ' + oL + ' loans' +
        (oL ? ' — e.g. ' + sample(drift.orphanLoanIds) : '') +
        '\nDiagnose with POST /api/admin-blob-pg-sync {dryRun:true}; the bake-off clock resets.';
    }
    await postSlack({ text }, { channel: 'errors' }).catch(() => {});
    console.log('[drift-report] ' + (clean ? 'clean' : 'DRIFT') + ' — ' + scannedLine);
  }

  return json(200, report);
};
