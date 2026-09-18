/**
 * fci-payoff-confirm-cron.mjs — every 4 hours
 *
 * Deploy 237.179 (Mike: "is there a way to check and confirm when it is picked up by FCI
 * or that it was successful?").
 *
 * 237.171 reads a payoff demand back from FCI seconds after sending it, which catches an
 * outright failure but not a slow one — FCI's tracker can list a demand later, and until
 * now nothing looked again and nobody was told.
 *
 * This walks the short waiting list (_shared/fci-payoff-watch), asks FCI whether each
 * demand is in their records yet, and:
 *   - CONFIRMED  → stamps `confirmed` / `confirmedAt` on the loan's own payoff entry,
 *                  tells whoever ordered it, and drops it from the list.
 *   - STILL MISSING after 24h → tells them ONCE that it has not landed, so a demand
 *                  nobody is watching cannot sit dead for a week.
 *   - after 7 days → drops it. By then it is a phone call, not a poll.
 *
 * Zero-throw per item: one bad loan must not stop the rest, and the list is only written
 * once at the end.
 */
import { keySafe } from './_shared/auth.mjs';
import { getStore } from '@netlify/blobs';
import { fciConfigured, fciConfirmPayoffFiled } from './_shared/fci-api.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { pushUserNotification } from './_shared/user-notifications.mjs';
import {
  listWatched, saveWatched, isGivenUp, isOverdue, ageHours, GIVE_UP_DAYS, OVERDUE_HOURS,
} from './_shared/fci-payoff-watch.mjs';

export const config = { schedule: '17 */4 * * *' };

/** Stamp the confirmation onto the loan's own record. Returns true when it stuck. */
async function markConfirmed(item) {
  const store = getStore({ name: 'clients', consistency: 'strong' });
  const key = keySafe(item.ownerKey) + '/' + keySafe(item.clientId);
  const client = await store.get(key, { type: 'json' }).catch(() => null);
  if (!client || !Array.isArray(client.loans)) return false;
  const loan = client.loans.find((l) => l && l.id === item.loanId);
  if (!loan || !Array.isArray(loan.payoffRequests)) return false;
  const entry = loan.payoffRequests.find((p) => p && String(p.payoffDate) === String(item.payoffDate));
  if (!entry) return false;
  if (entry.confirmed === true) return true;          // someone else got there first
  entry.confirmed = true;
  entry.confirmedAt = new Date().toISOString();
  entry.confirmReason = '';
  entry.confirmedBy = 'fci-payoff-confirm-cron';
  loan.updatedAt = entry.confirmedAt;
  await writeClient(keySafe(item.ownerKey), client, { clientsStore: store });
  return true;
}

export default async () => {
  const stats = { checked: 0, confirmed: 0, overdue: 0, droppedOld: 0, failed: 0 };
  try {
    if (!fciConfigured()) { console.log('[fci-payoff-confirm] FCI_API_TOKEN not set — skipping'); return new Response('ok'); }
    const items = await listWatched();
    if (!items.length) return new Response('ok');

    const now = Date.now();
    const keep = [];
    for (const item of items) {
      try {
        if (isGivenUp(item, now)) {
          stats.droppedOld++;
          console.warn('[fci-payoff-confirm] giving up after ' + GIVE_UP_DAYS + 'd:', item.loanId, item.payoffDate);
          continue;                                     // off the list, stays "not confirmed" on the loan
        }
        stats.checked++;
        const r = await fciConfirmPayoffFiled(item.account, item.payoffDate);
        if (r.confirmed) {
          stats.confirmed++;
          const stuck = await markConfirmed(item);
          if (item.by) {
            await pushUserNotification(item.by, {
              kind: 'payoff_confirmed',
              title: 'Payoff demand confirmed by FCI',
              body: 'The demand you ordered' + (item.address ? ' on ' + item.address : '') +
                    ' (payoff date ' + item.payoffDate + ') is now in FCI\'s records.',
              href: '/loan-details/' + item.loanId + (item.ownerKey ? '?owner=' + encodeURIComponent(item.ownerKey) : '') + '#servicing',
            }).catch(() => {});
          }
          if (!stuck) console.warn('[fci-payoff-confirm] confirmed but could not stamp the loan:', item.loanId);
          continue;                                     // resolved — off the list
        }
        // Not there yet. Say so once, then keep quietly checking until we give up.
        if (isOverdue(item, now)) {
          stats.overdue++;
          item.notifiedOverdue = true;
          if (item.by) {
            await pushUserNotification(item.by, {
              kind: 'payoff_unconfirmed',
              title: 'Payoff demand still not showing at FCI',
              body: 'The demand you ordered' + (item.address ? ' on ' + item.address : '') +
                    ' (payoff date ' + item.payoffDate + ') has not appeared in FCI\'s records after ' +
                    OVERDUE_HOURS + ' hours. Check the FCI portal and re-order or call it in.',
              href: '/loan-details/' + item.loanId + (item.ownerKey ? '?owner=' + encodeURIComponent(item.ownerKey) : '') + '#servicing',
            }).catch(() => {});
          }
        }
        item.checks = (Number(item.checks) || 0) + 1;
        item.lastCheckedAt = new Date().toISOString();
        item.lastReason = r.reason || '';
        keep.push(item);
      } catch (e) {
        stats.failed++;
        console.warn('[fci-payoff-confirm] item failed (kept):', item && item.loanId, e && e.message);
        keep.push(item);                                 // a bad check is not a verdict
      }
    }
    await saveWatched(keep);
    console.log('[fci-payoff-confirm]', JSON.stringify(Object.assign(stats, { remaining: keep.length })));
  } catch (e) {
    console.error('[fci-payoff-confirm] failed:', e && e.message);
  }
  return new Response('ok');
};
