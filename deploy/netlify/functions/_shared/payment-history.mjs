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
export async function writeCached(kind, account, rows, extra) {
  const out = Object.assign({ servicer: kind, account, asOf: new Date().toISOString(), rows }, extra || {});
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

// ── Deploy 237.068 (Mike) — the rest of the FCI servicing picture, cached with the payments:
//   notes   getNotes (FCI rep notes: boarding confirmations, borrower contact …)
//   ledger  getLoanActivities (every receipt with clearing + funds-release dates)
//   charges getLoanCharges (fees on the loan, with what has been paid)
// Nightly the warm job pulls each ONCE for the whole book (fciLoadBulk) and
// slices per account; an on-demand refresh uses the per-account variants.
const NOTE_FIELDS = 'account noteDate fciRep contactNumber subject noteType contactPerson note borrowerFullName';
const LEDGER_FIELDS = 'loanAccount dateDue dateReceived dateDeposited clearingDate releaseDate balance description reference notes toInterest toPrincipal toLateCharge toReserve toImpound toLenderFee toBrokerFee toOtherPayments toChargesPrincipal toChargesInterest toPrepay lateCharge interestPaidTo';
const CHARGE_FIELDS = 'loanAccount date reference description type interestRate deferred origianlBalance unpaidBalance accruedInterest totalDue details{ date payerName reference amount }';

function normNote(n) {
  return { date: fciDate(n.noteDate) || String(n.noteDate || '').slice(0, 10), rep: String(n.fciRep || ''), subject: String(n.subject || ''), type: String(n.noteType || ''),
    contact: String(n.contactPerson || ''), text: String(n.note || '').slice(0, 2000) };
}
function normLedger(a) {
  return { dateDue: fciDate(a.dateDue), dateReceived: fciDate(a.dateReceived), dateDeposited: fciDate(a.dateDeposited), clearingDate: fciDate(a.clearingDate), releaseDate: fciDate(a.releaseDate),
    balance: fciNum(a.balance), description: String(a.description || ''), reference: String(a.reference || ''), notes: String(a.notes || '').slice(0, 300),
    toInterest: fciNum(a.toInterest), toPrincipal: fciNum(a.toPrincipal), toLateCharge: fciNum(a.toLateCharge), toReserve: fciNum(a.toReserve), toImpound: fciNum(a.toImpound),
    toLenderFee: fciNum(a.toLenderFee), toBrokerFee: fciNum(a.toBrokerFee), toOther: fciNum(a.toOtherPayments), toCharges: (fciNum(a.toChargesPrincipal) || 0) + (fciNum(a.toChargesInterest) || 0),
    lateCharge: fciNum(a.lateCharge), interestPaidTo: fciDate(a.interestPaidTo) };
}
function normCharge(c) {
  return { date: fciDate(c.date), reference: String(c.reference || ''), description: String(c.description || ''), type: String(c.type || ''),
    original: fciNum(c.origianlBalance), unpaid: fciNum(c.unpaidBalance), accrued: fciNum(c.accruedInterest), totalDue: fciNum(c.totalDue), deferred: !!c.deferred,
    paid: Array.isArray(c.details) ? c.details.map((d) => ({ date: fciDate(d.date), payer: String(d.payerName || ''), amount: fciNum(d.amount) })) : [] };
}
const byDateDesc = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || ''));

export async function fciNotes(account) {
  const d = await fciQuery('{ getNotes(account:"' + fciAccount(account) + '"){ ' + NOTE_FIELDS + ' } }', { timeoutMs: 30000 });
  return (Array.isArray(d.getNotes) ? d.getNotes : []).map(normNote).sort(byDateDesc('date'));
}
export async function fciLedger(account) {
  const d = await fciQuery('{ getLoanActivities(loanaccount:"' + fciAccount(account) + '"){ ' + LEDGER_FIELDS + ' } }', { timeoutMs: 30000 });
  return (Array.isArray(d.getLoanActivities) ? d.getLoanActivities : []).map(normLedger).sort(byDateDesc('dateReceived'));
}
export async function fciCharges(account) {
  const d = await fciQuery('{ getLoanCharges(account:"' + fciAccount(account) + '"){ ' + CHARGE_FIELDS + ' } }', { timeoutMs: 30000 });
  return (Array.isArray(d.getLoanCharges) ? d.getLoanCharges : []).map(normCharge).sort(byDateDesc('date'));
}
/** Whole-book pulls (3 calls) for the nightly warm; each degrades to null on error. */
export async function fciLoadBulk() {
  const out = { notes: null, ledger: null, charges: null, errors: [] };
  const norm = (v) => fciAccount(v);
  try {
    const d = await fciQuery('{ getNotes(investor:"all"){ ' + NOTE_FIELDS + ' } }', { timeoutMs: 60000 });
    out.notes = new Map();
    (Array.isArray(d.getNotes) ? d.getNotes : []).forEach((n) => { const k = norm(n.account); if (!k) return; (out.notes.get(k) || out.notes.set(k, []).get(k)).push(normNote(n)); });
  } catch (e) { out.errors.push('notes: ' + ((e && e.message) || 'error')); }
  try {
    const d = await fciQuery('{ getLoanActivities{ ' + LEDGER_FIELDS + ' } }', { timeoutMs: 60000 });
    out.ledger = new Map();
    (Array.isArray(d.getLoanActivities) ? d.getLoanActivities : []).forEach((a) => { const k = norm(a.loanAccount); if (!k) return; (out.ledger.get(k) || out.ledger.set(k, []).get(k)).push(normLedger(a)); });
  } catch (e) { out.errors.push('ledger: ' + ((e && e.message) || 'error')); }
  try {
    const d = await fciQuery('{ getLoanCharges{ ' + CHARGE_FIELDS + ' } }', { timeoutMs: 60000 });
    out.charges = new Map();
    (Array.isArray(d.getLoanCharges) ? d.getLoanCharges : []).forEach((c) => { const k = norm(c.loanAccount); if (!k) return; (out.charges.get(k) || out.charges.set(k, []).get(k)).push(normCharge(c)); });
  } catch (e) { out.errors.push('charges: ' + ((e && e.message) || 'error')); }
  return out;
}

/** Live pull for one account (no cache read); writes the cache. fciBulk = fciLoadBulk() result (nightly) or null (per-account calls). */
export async function fetchAndCache(kind, account, spFeeds, fciBulk) {
  let rows, extra = {};
  if (kind === 'FCI') {
    if (!fciConfigured()) throw new Error('FCI_API_TOKEN is not set');
    rows = await fciHistory(account);
    const k = fciAccount(account);
    const pick = async (mapName, fn) => {
      if (fciBulk && fciBulk[mapName]) return (fciBulk[mapName].get(k) || []).slice().sort(byDateDesc(mapName === 'ledger' ? 'dateReceived' : 'date'));
      try { return await fn(account); } catch (e) { return { error: (e && e.message) || 'error' }; }
    };
    extra.notes = await pick('notes', fciNotes);
    extra.ledger = await pick('ledger', fciLedger);
    extra.charges = await pick('charges', fciCharges);
  } else if (kind === 'Servicing Pros') {
    if (!spConfiguredAccounts(process.env).length) throw new Error('Servicing Pros API keys are not set');
    rows = spHistoryFrom(spFeeds || await spLoadFeeds(), account);
  } else {
    throw new Error('No payment-history integration for this servicer');
  }
  return writeCached(kind, account, rows, extra);
}
