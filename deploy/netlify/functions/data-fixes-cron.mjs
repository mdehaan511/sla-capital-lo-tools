/**
 * data-fixes-cron.mjs — every 10 minutes
 *
 * Deploy 237.281 — applies each pending entry of _shared/data-fixes.mjs ONCE, through the
 * app's own write path (writeClient: Postgres first, then the blob mirror), with an Audit Log
 * entry and a Notes & Activity line on the loan, and records the outcome in the `data-fixes`
 * store so it never runs again. A pending list is empty almost always; the run is then one
 * small read. Scheduled functions are invoked by Netlify only (no public route).
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { DATA_FIXES, applyFix } from './_shared/data-fixes.mjs';

export const config = { schedule: '*/10 * * * *' };

export async function runDataFixes(opts) {
  const o = opts || {};
  const fixes = o.fixes || DATA_FIXES;
  const log = getStore({ name: 'data-fixes', consistency: 'strong' });
  const done = (await log.get('applied', { type: 'json' }).catch(() => null)) || {};
  const out = [];
  for (const fix of fixes) {
    if (!fix || !fix.id || done[fix.id]) continue;
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const key = keySafe(fix.ownerKey) + '/' + keySafe(fix.clientId);
    const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
    const r = client ? applyFix(client, fix) : { result: 'skipped', note: 'client not found' };
    if (r.result === 'applied') {
      appendNoteEntry(r.loan, {
        kind: 'system',
        text: 'Data correction: ' + r.note + ' (requested by ' + (fix.requestedBy || 'staff') + '). ' + (fix.reason || ''),
        author: 'SLA Platform', authorEmail: 'system@slacapital.com',
        meta: { via: 'data_fix', fixId: fix.id, field: fix.field, from: fix.from, to: fix.to },
      });
      try { await writeClient(fix.ownerKey, client, { clientsStore }); }
      catch (e) { out.push({ id: fix.id, result: 'error', note: e && e.message }); continue; } // not recorded: retried next run
      try {
        await recordLoanChanges({
          ownerKey: fix.ownerKey, clientId: fix.clientId, loanId: fix.loanId,
          actor: 'system@slacapital.com', actorName: 'Data fix (requested by ' + (fix.requestedBy || 'staff') + ')',
          source: 'Data fix ' + fix.id, changes: diffLoan(r.before, r.loan),
        });
      } catch (e) { console.warn('[data-fixes] change log failed (non-fatal):', e && e.message); }
    }
    done[fix.id] = { result: r.result, note: r.note, at: new Date().toISOString() };
    await log.setJSON('applied', done);
    out.push({ id: fix.id, result: r.result, note: r.note });
  }
  return out;
}

export default async () => {
  try {
    const r = await runDataFixes();
    if (r.length) console.log('[data-fixes]', JSON.stringify(r));
  } catch (e) {
    console.error('[data-fixes] failed:', e && e.message);
  }
  return new Response('ok');
};
