/**
 * payment-history.mjs — borrower payment history from the servicer of record,
 * normalized to one row shape + a per-account cache.
 *
 * Deploy 237.054 (Mike) — split out of loan-payment-history.mjs so the nightly
 * warm job (payment-history-warm-background) and the on-demand endpoint share
 * one fetcher + one cache. The Servicing tab reads the cache, which the warm
 * job fills every morning after the FCI / Servicing Pros syncs, so expanding a
 * row is instant; "Refresh" on the row forces a live pull.
 *
 * Cache: store payment_history_cache, key <servicer>/<account> →
 *   { servicer, account, asOf, rows }
 */
import { getStore } from '@netlify/blobs';
import { fciConfigured, fciQuery, fciAccount, fciNum, fciDate } from './fci-api.mjs';
import { spConfiguredAccounts, spPayments, spLoans, spDate, spNum } from './servicingpros-api.mjs';

export const CACHE_STORE = 'payment_history_cache';
export const CACHE_TTL_MS = 26 * 60 * 60 * 1000;   // the warm job runs daily

export const isSpServicer = (name, acct) => /servicing\s*pro/i.test(String(name || '')) || /^\d{2}-\d{4}-/.test(String(acct || ''));
export const isFciServicer = (name, acct) => /fci/i.test(String(name || '')) || (!name && /^\d{6,}$/.test(String(acct || '')));
export function servicerKind(name, acct) {
  return isSpServicer(name, acct) ? 'Servicing Pros' : isFciServicer(name, acct) ? 'FCI' : '';
}
export function cacheKey(kind, account) {
  return String(kind).replace(/\s+/g, '_').toLowerCase() + '/' + String(account).replace(/[^A-Za-z0-9_-]/g, '_');
}
export const cacheStore = () => getStore({ name: CACHE_STORE, consistency: 'strong' });

export async function readCached(kind, account) {
  const hit = await cacheStore().get(cacheKey(kind, account), { type: 'json' }).catch(() => null);
  if (hit && hit.asOf && Date.now() - Date.parse(hit.asOf) < CACHE_TTL_MS) return hit;
  return null;
}
export async function writeCached(kind, account, rows) {
  const out = { servicer: kind, account, asOf: new Date().toISOString(), rows };
  await cacheStore().setJSON(cacheKey(kind, account), out).catch(() => {});
  return out;
}

export function sortRows(rows) {
  return rows.sort((a, b) => String(b.dateReceived || b.dateDue || '').localeCompare(String(a.dateReceived || a.dateDue || '')));
}

export async function fciHistory(account) {
  const q = '{ getBorrowerPayment(account:"' + fciAccount(account) + '" excludeFunding:true){ dateReceived dateDue dayVariance reference paymentType totalAmount toInterest toPrincipal lateChargesPaid accruedLateCharges toReserve toEscrow toUnpaidInterest notes } }';
  const d = await fciQuery(q, { timeoutMs: 30000 });
  const list = Array.isArray(d.getBorrowerPayment) ? d.getBorrowerPayment : [];
  return sortRows(list.map((p) => ({
    dateDue: fciDate(p.dateDue), dateReceived: fciDate(p.dateReceived),
    daysLate: fciNum(p.dayVariance), amount: fciNum(p.totalAmount),
    toInterest: fciNum(p.toInterest), toPrincipal: fciNum(p.toPrincipal),
    lateCharges: fciNum(p.lateChargesPaid), toReserve: fciNum(p.toReserve), toEscrow: fciNum(p.toEscrow),
    type: String(p.paymentType || ''), reference: String(p.reference || ''), notes: String(p.notes || '').slice(0, 200),
    balance: null,
  })));
}

// Servicing Pros: one payments feed per book covers every loan — load once,
// then slice per account. { feeds: [{ loansByAccount: Map, pays: [] }] }
export async function spLoadFeeds() {
  const feeds = [];
  for (const a of spConfiguredAccounts(process.env)) {
    try {
      const loans = await spLoans(a);
      const byAcct = new Map();
      loans.forEach((l) => { if (l.account) byAcct.set(l.account, l); if (l.accountNumber) byAcct.set(l.accountNumber, l); });
      const pays = await spPayments(a) || [];
      feeds.push({ book: a.key, loansByAccount: byAcct, pays });
    } catch (e) { feeds.push({ book: a.key, error: (e && e.message) || 'error', loansByAccount: new Map(), pays: [] }); }
  }
  return feeds;
}
export function spHistoryFrom(feeds, account) {
  const target = String(account || '').trim();
  const rows = [];
  for (const f of feeds) {
    const hit = f.loansByAccount.get(target);
    const recId = hit ? hit.recId : '';
    f.pays.forEach((p) => {
      if ((recId && String(p.LoanRecID) === String(recId)) || String(p.Account || '').trim() === target) rows.push(p);
    });
    if (rows.length) break;
  }
  return sortRows(rows.map((p) => ({
    dateDue: spDate(p.DateDue), dateReceived: spDate(p.DateRec),
    daysLate: spNum(p.DaysLate),
    amount: spNum(p.Amount) != null ? spNum(p.Amount) : ((spNum(p.ToInterest) || 0) + (spNum(p.ToPrincipal) || 0) + (spNum(p.ToLateCharge) || 0) + (spNum(p.ToReserve) || 0) + (spNum(p.ToOtherPayments) || 0)),
    toInterest: spNum(p.ToInterest), toPrincipal: spNum(p.ToPrincipal), lateCharges: spNum(p.ToLateCharge),
    toReserve: spNum(p.ToReserve), toEscrow: null,
    type: String(p.SourceTyp || p.SourceApp || ''), reference: String(p.RecID || ''), notes: '',
    balance: spNum(p.LoanBalance),
  })));
}

/** Live pull for one account (no cache read); writes the cache. */
export async function fetchAndCache(kind, account, spFeeds) {
  let rows;
  if (kind === 'FCI') {
    if (!fciConfigured()) throw new Error('FCI_API_TOKEN is not set');
    rows = await fciHistory(account);
  } else if (kind === 'Servicing Pros') {
    if (!spConfiguredAccounts(process.env).length) throw new Error('Servicing Pros API keys are not set');
    rows = spHistoryFrom(spFeeds || await spLoadFeeds(), account);
  } else {
    throw new Error('No payment-history integration for this servicer');
  }
  return writeCached(kind, account, rows);
}
