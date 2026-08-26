/**
 * _shared/borrower-portal-activity.mjs — Deploy 236.747
 *
 * Lightweight "this borrower actually uses the portal" marker. Stamped on
 * every authenticated borrower portal call (borrower-portal-loans +
 * borrower-intake-status); read by the daily corrected-docs reminder cron so
 * it only emails borrowers who have logged in at least once. The store starts
 * empty, so borrowers who have never opened the portal are never emailed by
 * the cron (the processor's manual send is not gated).
 *
 * Zero-throw: activity tracking must never break a portal request.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE = 'borrower-portal-activity';
const RESTAMP_MS = 6 * 60 * 60 * 1000; // rewrite at most every 6h per user

export async function markPortalActivity(email) {
  try {
    const em = normalizeEmail(email || '');
    if (!em || !em.includes('@')) return;
    const store = getStore({ name: STORE, consistency: 'eventual' });
    const key = keySafe(em);
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    if (existing && existing.lastSeenAt && (Date.now() - Date.parse(existing.lastSeenAt)) < RESTAMP_MS) return;
    await store.setJSON(key, {
      email: em,
      firstSeenAt: (existing && existing.firstSeenAt) || new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[portal-activity] mark failed (non-fatal):', e && e.message);
  }
}

export async function hasPortalActivity(email) {
  try {
    const em = normalizeEmail(email || '');
    if (!em || !em.includes('@')) return false;
    const store = getStore({ name: STORE, consistency: 'eventual' });
    const rec = await store.get(keySafe(em), { type: 'json' }).catch(() => null);
    return !!(rec && rec.lastSeenAt);
  } catch (_) {
    return false;
  }
}
