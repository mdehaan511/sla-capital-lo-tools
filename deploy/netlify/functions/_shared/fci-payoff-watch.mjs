/**
 * _shared/fci-payoff-watch.mjs — Deploy 237.179 (Mike: "is there a way to check and
 * confirm when it is picked up by FCI or that it was successful?")
 *
 * 237.171 verifies a payoff demand by reading it back from FCI seconds after sending it.
 * That catches an outright failure, but FCI's tracker can lag: a demand that lands ten
 * minutes later stayed "not confirmed" on our record for good, because nothing ever
 * looked again. Nobody was told when it did land, either.
 *
 * This is the waiting list. A demand that was not confirmed on the spot goes on it, a
 * cron re-checks the list a few times a day, and the demand comes off when FCI's own
 * records show it — at which point the person who ordered it is told.
 *
 * ONE small blob, not a walk. Finding "loans with an unconfirmed demand" by scanning the
 * clients store would be thousands of reads for a handful of rows (and the profiles-store
 * walk already taught us what that costs — see reference_profiles_store_slow). The list
 * is written when a demand is filed and cleared when it resolves, so it only ever holds
 * what is genuinely outstanding.
 */
import { getStore } from '@netlify/blobs';

const STORE = 'fci-payoff-watch';
const KEY = 'pending';
/** Stop re-checking after this long — by then it is a phone call, not a poll. */
export const GIVE_UP_DAYS = 7;
/** Tell the orderer it still has not landed after this long. */
export const OVERDUE_HOURS = 24;
const MAX_ITEMS = 500;

const _store = () => getStore({ name: STORE, consistency: 'strong' });

/** One stable key per demand, so re-filing the same one does not double the list. */
export function watchKey(e) {
  return [e && e.ownerKey, e && e.clientId, e && e.loanId, e && e.payoffDate].join('|');
}

export async function listWatched() {
  const doc = await _store().get(KEY, { type: 'json' }).catch(() => null);
  return Array.isArray(doc && doc.items) ? doc.items : [];
}

export async function saveWatched(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS);
  await _store().setJSON(KEY, { items: list, updatedAt: new Date().toISOString() });
  return list.length;
}

/**
 * Put a demand on the waiting list (or refresh the one already there).
 * Zero-throw: a payoff must not fail to file because the watch list is unwell.
 */
export async function watchPayoff(entry) {
  try {
    if (!entry || !entry.loanId || !entry.payoffDate) return false;
    const k = watchKey(entry);
    const items = (await listWatched()).filter((it) => watchKey(it) !== k);
    items.unshift({
      ownerKey: entry.ownerKey || '', clientId: entry.clientId || '', loanId: entry.loanId || '',
      account: entry.account || '', payoffDate: entry.payoffDate || '',
      at: entry.at || new Date().toISOString(),
      by: entry.by || '', address: entry.address || '',
      checks: 0, notifiedOverdue: false,
    });
    await saveWatched(items);
    return true;
  } catch (e) {
    console.warn('[fci-payoff-watch] could not enqueue:', e && e.message);
    return false;
  }
}

/** Drop a demand from the list (confirmed, or given up on). */
export async function unwatchPayoff(entry) {
  try {
    const k = watchKey(entry);
    const items = await listWatched();
    const next = items.filter((it) => watchKey(it) !== k);
    if (next.length !== items.length) await saveWatched(next);
    return items.length - next.length;
  } catch (e) {
    console.warn('[fci-payoff-watch] could not dequeue:', e && e.message);
    return 0;
  }
}

/** Hours since a demand was sent. */
export function ageHours(entry, now) {
  const t = Date.parse((entry && entry.at) || '');
  if (!isFinite(t)) return 0;
  return ((now || Date.now()) - t) / 3600000;
}

export function isGivenUp(entry, now) {
  return ageHours(entry, now) > GIVE_UP_DAYS * 24;
}
export function isOverdue(entry, now) {
  return !entry.notifiedOverdue && ageHours(entry, now) >= OVERDUE_HOURS;
}
