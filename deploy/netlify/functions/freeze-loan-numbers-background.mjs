/**
 * freeze-loan-numbers-background.mjs — Netlify BACKGROUND function
 * (name ends in `-background`: returns 202 at once, runs up to 15 minutes).
 *
 * Deploy 237.164 (Mike: "go ahead and freeze the loan numbers after closing")
 *
 * One-shot sweep that writes down the SLA loan number of every CLOSED loan
 * that never had one stored. 237.158 fixed the Closed Loans Draws tab by
 * matching Sitewire on the number the app displays, which for a loan
 * originated in the portal is DERIVED from its id + funding date rather than
 * stored. Derived means movable: correct the funding date and the number
 * changes under whatever was keyed to it outside this app. Freezing stamps the
 * number already on screen, so nothing visibly changes and every existing
 * Sitewire property keeps matching — it just stops being a computation.
 *
 * From here on new closes are frozen at write time by _shared/client-write.mjs
 * (the single path every mutation funnels through). This function exists for
 * the loans that closed BEFORE that went live.
 *
 * Rules, all from _shared/loan-number.mjs so the sweep and the live path can
 * never disagree:
 *   - closed only (the Closed Loans page's own isClosedLoan test),
 *   - blanks only — a Baseline id or a hand edit (237.102) is never touched,
 *   - the stamped value is exactly what the loan already displays,
 *   - frozen numbers carry slaDisplayIdSource:'derived', which keeps them out
 *     of the Baseline dedupe's merge-by-number pass (a hash can coincide with
 *     a real Baseline Id, and that pass deletes records).
 *
 * Every write goes through writeClient (Postgres first, then the blob mirror)
 * and lands in the loan audit log as "SLA number freeze". loan.updatedAt is
 * deliberately NOT bumped — this is bookkeeping, not activity, and bumping it
 * would push every closed loan to the top of "recently updated". The run
 * report is saved to settings/freeze_loan_numbers_last.
 *
 * Fired once by deploy-succeeded (internal HMAC header) and callable by an
 * admin (JWT) to re-run or to preview.
 * Body: { dryRun?, budgetMs?, targets?: [{ ownerKey, clientId, loanId }] }
 */
import { createHmac } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail } from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { isClosedLoanRecord, deriveSlaLoanNumber } from './_shared/loan-number.mjs';
import { recordLoanChanges } from './_shared/loan-change-log.mjs';

const SOURCE = 'SLA number freeze';
const MAX_ROWS = 500;
const READ_BATCH = 8;

export function internalFreezeSig() {
  const secret = process.env.ESIGN_SEAL_SECRET || '';
  if (!secret) return '';
  return createHmac('sha256', secret).update('freeze-loan-numbers').digest('hex');
}

function needsFreeze(loan) {
  if (!loan || !loan.id) return false;
  if (String(loan.slaDisplayId || '').trim()) return false;   // Baseline id / hand edit wins
  return isClosedLoanRecord(loan);
}

export async function freezeLoanNumbers({ dryRun = false, budgetMs = 13 * 60000, targets = null, actor = 'system' } = {}) {
  const started = Date.now();
  const stats = {
    dryRun, clientsScanned: 0, loansSeen: 0, closedLoans: 0, alreadyNumbered: 0,
    candidates: 0, frozen: 0, clientsWritten: 0, skipped: 0, errors: 0, truncated: false, rows: [],
  };
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const wanted = Array.isArray(targets) && targets.length ? targets : null;
  let keys;
  if (wanted) {
    keys = Array.from(new Set(wanted.map((t) => keySafe(t.ownerKey) + '/' + keySafe(t.clientId))));
  } else {
    const { blobs } = await clientsStore.list();
    keys = blobs.map((b) => b.key);
  }

  async function processClient(key, client) {
    stats.clientsScanned += 1;
    if (!client || !client.id || !Array.isArray(client.loans)) return;
    const slash = key.indexOf('/');
    const ownerKey = slash > 0 ? key.slice(0, slash) : '';
    // Never write a record whose blob key does not match its id — writeClient
    // would mint a duplicate under the "right" key instead of updating this one.
    if (!ownerKey || key.slice(slash + 1) !== keySafe(client.id)) { stats.skipped += 1; return; }

    const pending = []; // [{ loanId, number }]
    for (const loan of client.loans) {
      stats.loansSeen += 1;
      if (!isClosedLoanRecord(loan)) continue;
      stats.closedLoans += 1;
      if (String(loan.slaDisplayId || '').trim()) { stats.alreadyNumbered += 1; continue; }
      if (!needsFreeze(loan)) continue;
      if (wanted && !wanted.some((t) => t.loanId === loan.id)) continue;
      const number = deriveSlaLoanNumber(loan);
      if (!/^SLA-\d{8}-\d{4}$/.test(number)) { stats.errors += 1; continue; }
      stats.candidates += 1;
      if (stats.rows.length < MAX_ROWS) {
        stats.rows.push({
          ownerKey, clientId: client.id, loanId: loan.id,
          address: String(loan.address || '').slice(0, 80),
          status: String(loan.status || ''), disposition: String(loan.disposition || ''),
          toolType: String(loan.toolType || ''), fundingDate: String(loan.fundingDate || ''),
          number,
        });
      }
      if (dryRun) continue;
      // The stamp itself is writeClient's job (freezeClientLoanNumbers runs in
      // the write path), so the sweep and a normal save can never diverge. We
      // only record what we expect it to do, then verify below.
      pending.push({ loanId: loan.id, number });
    }
    if (dryRun || !pending.length) return;

    try {
      await writeClient(ownerKey, client, { clientsStore });
      stats.clientsWritten += 1;
    } catch (e) {
      stats.errors += 1;
      console.warn('[freeze-loan-numbers] write failed for ' + key + ':', e && e.message);
      if (stats.rows.length < MAX_ROWS) stats.rows.push({ ownerKey, clientId: client.id, error: String((e && e.message) || 'write failed') });
      return;
    }
    for (const p of pending) {
      const loan = client.loans.find((l) => l && l.id === p.loanId);
      const landed = String((loan && loan.slaDisplayId) || '').trim();
      if (!landed) { stats.errors += 1; continue; }  // write path declined it — do not claim a freeze
      stats.frozen += 1;
      try {
        await recordLoanChanges({
          ownerKey, clientId: client.id, loanId: p.loanId,
          actor, actorName: SOURCE, source: SOURCE,
          changes: [{ field: 'slaDisplayId', label: 'SLA Loan Number', from: '', to: landed }],
        });
      } catch (_) { /* best-effort */ }
    }
  }

  for (let i = 0; i < keys.length; i += READ_BATCH) {
    if (Date.now() - started > budgetMs) { stats.truncated = true; break; }
    const batch = keys.slice(i, i + READ_BATCH);
    const clients = await Promise.all(batch.map((k) => clientsStore.get(k, { type: 'json' }).catch(() => null)));
    for (let j = 0; j < batch.length; j++) await processClient(batch[j], clients[j]);
  }
  stats.ms = Date.now() - started;
  return stats;
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const hdrSig = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('x-sla-internal') || '') : '';
    const wantSig = internalFreezeSig();
    let actor = 'system';
    if (!(wantSig && hdrSig && hdrSig === wantSig)) {
      const user = await requireAuth(context, req);
      if (!user) return json(401, { error: 'Not authenticated' });
      if (!isAdmin(user)) return json(403, { error: 'Admin only' });
      actor = normalizeEmail(user.email);
    }
    const body = await readJsonBody(req).catch(() => ({})) || {};
    const dryRun = body.dryRun === true;
    const stats = await freezeLoanNumbers({
      dryRun,
      budgetMs: Math.min(14 * 60000, Number(body.budgetMs) || 13 * 60000),
      targets: Array.isArray(body.targets) ? body.targets : null,
      actor,
    });
    const report = { at: new Date().toISOString(), source: String(body.source || actor), stats };
    try { await getStore({ name: 'settings', consistency: 'strong' }).setJSON('freeze_loan_numbers_last', report); }
    catch (e) { console.warn('[freeze-loan-numbers] report save failed:', e && e.message); }
    console.log('[freeze-loan-numbers] done:', JSON.stringify(Object.assign({}, stats, { rows: stats.rows.length })));
    return json(200, { ok: true, stats: Object.assign({}, stats, { rows: stats.rows.slice(0, 50) }) });
  } catch (e) {
    console.error('freeze-loan-numbers-background error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
