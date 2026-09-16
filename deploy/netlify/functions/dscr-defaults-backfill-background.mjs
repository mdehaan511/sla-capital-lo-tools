/**
 * dscr-defaults-backfill-background.mjs — Netlify BACKGROUND function
 * (name ends in `-background`: returns 202 at once, runs up to 15 minutes).
 *
 * Deploy 237.118 (Mike: "Run a blanks only backfill please") — one-shot walk
 * of every client book applying the 237.084 DSCR defaults (Investor = DIYA,
 * TPO = 1) to pipeline DSCR loans that were sizer-saved before that rule went
 * live (2026-09-15 23:38Z) and never re-saved since — 808 E Dalton was one.
 * Dry run on 2026-09-16: 3,191 client records, 363 DSCR loans, 164 to fill
 * (125 active / 27 on hold / 6 awaiting app / 6 approved).
 *
 * BLANKS ONLY, the same rule as _shared/dscr-defaults.mjs applyDscrDefaults:
 * a TPO already on the loan (or an Admin Mode _adminTpo, even 0) and an
 * investor already on the loan are never touched. Pipeline loans only —
 * closed / sold / denied / cancelled / liquidated loans and Baseline imports
 * are skipped: on a funded loan a blank investor is a record-keeping gap, not
 * a default to fill.
 *
 * Every write goes through writeClient (Postgres first, then the blob mirror)
 * and lands in the loan audit log as source "DSCR defaults backfill".
 * loan.updatedAt is deliberately NOT bumped (no "recently updated" noise; the
 * audit log carries the change). The run report is saved to
 * settings/dscr_defaults_backfill_last.
 *
 * Fired by deploy-succeeded after this deploy (internal HMAC header) and
 * callable by an admin (JWT) if it ever needs re-running.
 * Body: { dryRun?, budgetMs?, targets?: [{ ownerKey, clientId, loanId }] }.
 */
import { createHmac } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail } from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { applyDscrDefaults } from './_shared/dscr-defaults.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';

const SKIP_STATUS = new Set(['closed', 'sold', 'denied', 'cancelled', 'liquidated', 'paid_off', 'suspended', 'dead', 'withdrawn', 'archived']);
const SOURCE = 'DSCR defaults backfill';
const MAX_ROWS = 500;
const READ_BATCH = 8;

export function internalBackfillSig() {
  const secret = process.env.ESIGN_SEAL_SECRET || '';
  if (!secret) return '';
  return createHmac('sha256', secret).update('dscr-defaults').digest('hex');
}

function isDscr(loan) { return !!loan && String(loan.toolType || '').toLowerCase() === 'dscr'; }

function eligible(loan) {
  if (!isDscr(loan)) return false;
  if (/^l_baseline_/.test(String(loan.id || ''))) return false;
  if (SKIP_STATUS.has(String(loan.status || '').toLowerCase())) return false;
  const hasAdminTpo = loan._adminTpo != null && loan._adminTpo !== '';
  const tpoBlank = !hasAdminTpo && (loan.tpo == null || loan.tpo === '' || !(Number(loan.tpo) > 0));
  const invBlank = !String(loan.investorId || '').trim() && !String(loan.investorName || '').trim();
  return tpoBlank || invBlank;
}

export async function backfillDscrDefaults({ dryRun = false, budgetMs = 13 * 60000, targets = null, actor = 'system' } = {}) {
  const started = Date.now();
  const stats = { dryRun, clientsScanned: 0, dscrLoans: 0, candidates: 0, updated: 0, clientsWritten: 0, skipped: 0, errors: 0, truncated: false, rows: [] };
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
    const pending = []; // [{ loan, before }]
    for (const loan of client.loans) {
      if (!isDscr(loan)) continue;
      stats.dscrLoans += 1;
      if (!eligible(loan)) continue;
      if (wanted && !wanted.some((t) => t.loanId === loan.id)) continue;
      stats.candidates += 1;
      const preview = Object.assign({}, loan);
      let changed = [];
      try { changed = await applyDscrDefaults(preview); } catch (e) { stats.errors += 1; continue; }
      if (!changed.length) continue;
      if (stats.rows.length < MAX_ROWS) {
        stats.rows.push({ ownerKey, clientId: client.id, loanId: loan.id, address: String(loan.address || '').slice(0, 80), status: String(loan.status || ''), changed, tpo: preview.tpo, investorName: preview.investorName || '', investorId: preview.investorId || '' });
      }
      if (dryRun) continue;
      const before = Object.assign({}, loan);
      if (changed.indexOf('tpo') >= 0) loan.tpo = preview.tpo;
      if (changed.indexOf('investor') >= 0) { loan.investorId = preview.investorId; loan.investorName = preview.investorName; }
      pending.push({ loan, before });
    }
    if (dryRun || !pending.length) return;
    try {
      await writeClient(ownerKey, client, { clientsStore });
      stats.clientsWritten += 1;
    } catch (e) {
      stats.errors += 1;
      console.warn('[dscr-defaults-backfill] write failed for ' + key + ':', e && e.message);
      if (stats.rows.length < MAX_ROWS) stats.rows.push({ ownerKey, clientId: client.id, error: String((e && e.message) || 'write failed') });
      return;
    }
    for (const p of pending) {
      stats.updated += 1;
      try {
        await recordLoanChanges({ ownerKey, clientId: client.id, loanId: p.loan.id, actor, actorName: SOURCE, source: SOURCE, changes: diffLoan(p.before, p.loan) });
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
    const wantSig = internalBackfillSig();
    let actor = 'system';
    if (!(wantSig && hdrSig && hdrSig === wantSig)) {
      const user = await requireAuth(context, req);
      if (!user) return json(401, { error: 'Not authenticated' });
      if (!isAdmin(user)) return json(403, { error: 'Admin only' });
      actor = normalizeEmail(user.email);
    }
    const body = await readJsonBody(req).catch(() => ({})) || {};
    const dryRun = body.dryRun === true;
    const stats = await backfillDscrDefaults({
      dryRun,
      budgetMs: Math.min(14 * 60000, Number(body.budgetMs) || 13 * 60000),
      targets: Array.isArray(body.targets) ? body.targets : null,
      actor,
    });
    const report = { at: new Date().toISOString(), source: String(body.source || actor), stats };
    try { await getStore({ name: 'settings', consistency: 'strong' }).setJSON('dscr_defaults_backfill_last', report); } catch (e) { console.warn('[dscr-defaults-backfill] report save failed:', e && e.message); }
    console.log('[dscr-defaults-backfill] done:', JSON.stringify(Object.assign({}, stats, { rows: stats.rows.length })));
    return json(200, { ok: true, stats: Object.assign({}, stats, { rows: stats.rows.slice(0, 50) }) });
  } catch (e) {
    console.error('dscr-defaults-backfill-background error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
