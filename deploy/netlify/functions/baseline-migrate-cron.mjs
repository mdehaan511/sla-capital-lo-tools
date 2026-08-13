/**
 * baseline-migrate-cron.mjs — Scheduled Baseline → SLA stage read-back sync.
 *
 * Deploy 236.551 (loan-processing-stage migration — Phase 1 automation, the
 * last slice). The mirror cron (baseline-mirror-sync-cron) keeps
 * `baseline_loans_mirror` fresh from Baseline's API. THIS cron reads that mirror
 * and runs the EXISTING `upsertBaselineLoan` over every loan — the same call the
 * manual /api/baseline-migrate button uses — which writes `baselineStatus`,
 * `baselineSubstatus`, and (the field the Processing Pipeline board reads)
 * `processingStage` onto the SLA loan. So the board now auto-populates from
 * Baseline stage with no manual "Run migrate" click.
 *
 * Phase-1 mirror, Phase-2-ready: `upsertBaselineLoan` PRESERVES SLA-authored
 * fields (processor-advanced processingStage, notes, doc-review, etc.) — its
 * documented cutover contract. So a full cutover later is just: stop this cron.
 *
 * Runs every 30 min, offset from the 15-min mirror cron so the mirror is fresh.
 * A persisted rotating cursor guarantees the whole roster gets covered across
 * runs even if one hits the time budget; steady-state runs are cheap because
 * unchanged loans upsert as 'no_change' (no write). Each run drops a one-line
 * summary into `baseline-sync-log` (visible on baseline-log.html).
 */
import { getStore } from '@netlify/blobs';
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';
import { upsertBaselineLoan } from './_shared/baseline-upsert.mjs';

// :10 and :40 — a few minutes after the :00/:15/:30/:45 mirror-cron runs.
export const config = { schedule: '10,40 * * * *' };

const TIME_BUDGET_MS = 24_000; // exit before Netlify's ~30s scheduled-fn kill
const LOG_STORE = 'baseline-sync-log';
const CURSOR_KEY = 'migrate-cron-cursor';

export default async (req) => {
  const startedAt = Date.now();
  const log = {
    startedAt: new Date(startedAt).toISOString(),
    runBy: 'cron', schedule: config.schedule, kind: 'migrate',
    mirrorCount: 0, processed: 0, created: 0, updated: 0, noChange: 0, skipped: 0,
    errors: [], truncated: false,
  };

  try {
    const mirror = await listMirroredLoans();
    log.mirrorCount = mirror.length;

    if (mirror.length) {
      let cursor = await readCursor();
      if (cursor < 0 || cursor >= mirror.length) cursor = 0;

      let i = cursor;
      for (; i < mirror.length; i++) {
        const rec = mirror[i];
        try {
          const r = await upsertBaselineLoan(rec, { dryRun: false, includeChanges: false });
          if (r.action === 'created')       log.created++;
          else if (r.action === 'updated')  log.updated++;
          else if (r.action === 'no_change') log.noChange++;
          else                               log.skipped++;
        } catch (e) {
          if (log.errors.length < 20) log.errors.push({ id: rec && rec.Id, error: (e && e.message) || 'unknown' });
        }
        log.processed++;
        if (Date.now() - startedAt > TIME_BUDGET_MS) { i++; break; }
      }

      // 0 = finished the roster this run; else resume here next run.
      const nextCursor = (i >= mirror.length) ? 0 : i;
      log.truncated = nextCursor !== 0;
      log.nextCursor = nextCursor;
      await writeCursor(nextCursor);
    }
  } catch (e) {
    log.error = 'cron exception: ' + (e && e.message);
  }

  log.elapsedMs = Date.now() - startedAt;
  await writeLog(log, startedAt);
  return new Response(JSON.stringify(log), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function readCursor() {
  try {
    const s = getStore({ name: LOG_STORE, consistency: 'strong' });
    const v = await s.get(CURSOR_KEY, { type: 'json' });
    return (v && typeof v.offset === 'number') ? v.offset : 0;
  } catch (_) { return 0; }
}
async function writeCursor(offset) {
  try {
    const s = getStore({ name: LOG_STORE, consistency: 'strong' });
    await s.setJSON(CURSOR_KEY, { offset, at: new Date().toISOString() });
  } catch (_) {}
}
async function writeLog(log, startedAtMs) {
  try {
    const store = getStore({ name: LOG_STORE, consistency: 'eventual' });
    const ts = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
    await store.setJSON('migrate-cron/' + ts, log);
  } catch (_) {}
}
