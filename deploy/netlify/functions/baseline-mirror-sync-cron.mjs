/**
 * baseline-mirror-sync-cron.mjs — Scheduled Baseline mirror sync.
 *
 * Deploy 236.28. Netlify Scheduled Function — runs every 15 minutes
 * via the `schedule` config exported below. Replaces the dashboard's
 * "click Sync from Baseline" requirement for routine refreshes; the
 * manual button still works for "I need it RIGHT NOW" cases.
 *
 * Why a separate file instead of just calling baseline-mirror-sync:
 *   - That endpoint requires Netlify Identity auth (admin), which a
 *     scheduled invocation can't provide.
 *   - Scheduled invocations should do the WHOLE roster in one go when
 *     possible (the manual button chunks for UI progress, but a cron
 *     just needs to finish). We loop chunks server-side here against
 *     a time budget so we exit gracefully before Netlify kills us.
 *
 * After the first full sync, almost everything skips the detail fetch
 * (status hasn't changed → ~ms per loan from blob read). So the typical
 * 15-min run does the whole 253-loan list in a few seconds and only
 * spends real time on the handful of loans that actually changed since
 * the previous run.
 *
 * Each run writes a one-line summary into `baseline-sync-log` so admins
 * can confirm the cron is alive from baseline-log.html.
 */
import { getStore } from '@netlify/blobs';
import {
  fetchAllLoanList, fetchLoanDetail,
  loadMirroredLoan, saveMirroredLoan,
} from './_shared/baseline-mirror.mjs';

// Deploy 236.687 — Baseline feed CUT as SLA goes independent (Mike). The
// schedule is removed so Netlify no longer pulls fresh Baseline data
// automatically; the function still works if triggered manually for a
// deliberate one-off resync. Re-add the schedule below to resume automation.
const LEGACY_SCHEDULE = '*/15 * * * *';
export const config = {};

// Time budget for the whole invocation. Netlify Pro gives 30s; we exit
// at 24s to leave headroom for the log write. If we hit the budget
// mid-roster the next 15-min run picks up where this one left off
// (the incremental skip optimization makes that cheap).
const TIME_BUDGET_MS = 24_000;
const CHUNK_SIZE     = 50;   // per-iteration slice of the list

// Deploy 236.35 — loans in a TERMINAL state rarely have data changes
// that we care about (they've already closed / been archived). For
// those, we keep the Status+Substatus skip optimization. But any loan
// still in pipeline can have its dates (Origination, etc.) shift in
// Baseline without a status change — Mike noticed SLA-20260302-1930
// showing a stale Origination because of exactly this. Pipeline loans
// now get a forced detail refresh every cron run so date fields stay
// fresh. Typical pipeline = ~50 loans × ~300ms = ~15s, well within
// the 24s budget; terminal loans (~200) are blob-read skips.
const TERMINAL_STATUSES = new Set([
  'closed', 'sold', 'funded',
  'in_servicing', 'servicing',
  'liquidated',
  'archived', 'lost', 'declined', 'denied', 'withdrawn', 'cancelled',
]);
function isTerminalStatus(s) {
  return TERMINAL_STATUSES.has(String(s || '').toLowerCase());
}

export default async (req) => {
  const startedAt = Date.now();
  const log = {
    startedAt: new Date(startedAt).toISOString(),
    runBy:     'manual',
    schedule:  LEGACY_SCHEDULE,
    totalCount: 0,
    processed:  0,
    synced:     0,
    skipped:    0,
    errors:     [],
    truncated:  false,
  };

  try {
    const list = await fetchAllLoanList();
    if (!list.ok) {
      log.error = 'list fetch failed: ' + (list.error || ('HTTP ' + list.status));
      await writeLog(log, startedAt);
      return new Response(JSON.stringify(log), { status: 502 });
    }
    log.totalCount = list.loans.length;

    // Walk the roster in CHUNK_SIZE batches so we can check the time
    // budget between batches and exit cleanly.
    for (let offset = 0; offset < list.loans.length; offset += CHUNK_SIZE) {
      const slice = list.loans.slice(offset, offset + CHUNK_SIZE);
      for (const stub of slice) {
        const id = stub && stub.Id;
        if (!id) continue;

        // Incremental skip: if mirror already has this loan AND
        // Status+Substatus match the list view, there's no need to
        // hit /loan/{Id}. Most cron runs short-circuit here.
        // Deploy 236.35 — only skip TERMINAL loans this way. Pipeline
        // loans always get a fresh detail fetch so silent date-field
        // updates (Origination, etc.) propagate.
        const existing = await loadMirroredLoan(id);
        if (existing
            && isTerminalStatus(stub.Status)
            && existing.Status    === stub.Status
            && existing.Substatus === stub.Substatus) {
          log.skipped += 1;
          log.processed += 1;
          continue;
        }

        const detail = await fetchLoanDetail(id);
        if (!detail.ok) {
          log.errors.push({ id, error: detail.error || ('HTTP ' + detail.status) });
          log.processed += 1;
          continue;
        }
        try {
          await saveMirroredLoan(id, detail.loan);
          log.synced += 1;
        } catch (e) {
          log.errors.push({ id, error: 'mirror write failed: ' + (e && e.message) });
        }
        log.processed += 1;
      }
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        log.truncated = true;
        break;
      }
    }
  } catch (e) {
    log.error = 'cron exception: ' + (e && e.message);
  }

  log.elapsedMs = Date.now() - startedAt;
  await writeLog(log, startedAt);
  return new Response(JSON.stringify(log), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function writeLog(log, startedAtMs) {
  try {
    const store = getStore({ name: 'baseline-sync-log', consistency: 'eventual' });
    // Key: cron/<ISO> so admins can sort newest-first and distinguish
    // cron runs from manual triggers (which use a different prefix).
    const ts = new Date(startedAtMs).toISOString().replace(/[:.]/g, '-');
    await store.setJSON('cron/' + ts, log);
  } catch (_) {
    // Log write failure shouldn't fail the cron — the mirror writes
    // already landed. Swallow so the next 15-min run is unaffected.
  }
}
