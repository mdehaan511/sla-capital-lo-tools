/**
 * loan-payment-history.mjs — GET /api/loan-payment-history?servicer=&account=
 *
 * Deploy 237.053 (Mike) — borrower payment history for the Closed Loans
 * Servicing tab (a row expands to show it). Pulled live from the servicer of
 * record, normalized to one row shape, and cached for an hour per account so
 * repeated clicks don't hammer FCI (whose report methods are rate-limited).
 *
 *   FCI            getBorrowerPayment(account, excludeFunding:true)
 *   Servicing Pros GET /api/v2/lender/payments filtered to the loan
 *
 * Response: { ok, servicer, account, asOf, rows: [{ dateDue, dateReceived,
 *   daysLate, amount, toInterest, toPrincipal, lateCharges, type, reference,
 *   balance }], cached }
 * Auth: processor or admin (staff pages only).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, isProcessor } from './_shared/auth.mjs';
import { fciConfigured, fciQuery, fciAccount, fciNum, fciDate } from './_shared/fci-api.mjs';
import { spConfiguredAccounts, spPayments, spLoans, spDate, spNum } from './_shared/servicingpros-api.mjs';

const CACHE_STORE = 'payment_history_cache';
const TTL_MS = 60 * 60 * 1000;

const isSp = (name, acct) => /servicing\s*pro/i.test(String(name || '')) || /^\d{2}-\d{4}-/.test(String(acct || ''));
const isFci = (name, acct) => /fci/i.test(String(name || '')) || (!name && /^\d{6,}$/.test(String(acct || '')));

async function fciHistory(acct) {
  const q = '{ getBorrowerPayment(account:"' + fciAccount(acct) + '" excludeFunding:true){ dateReceived dateDue dayVariance reference paymentType totalAmount toInterest toPrincipal lateChargesPaid accruedLateCharges toReserve toEscrow toUnpaidInterest notes } }';
  const d = await fciQuery(q, { timeoutMs: 30000 });
  const list = Array.isArray(d.getBorrowerPayment) ? d.getBorrowerPayment : [];
  return list.map((p) => ({
    dateDue: fciDate(p.dateDue), dateReceived: fciDate(p.dateReceived),
    daysLate: fciNum(p.dayVariance), amount: fciNum(p.totalAmount),
    toInterest: fciNum(p.toInterest), toPrincipal: fciNum(p.toPrincipal),
    lateCharges: fciNum(p.lateChargesPaid), toReserve: fciNum(p.toReserve), toEscrow: fciNum(p.toEscrow),
    type: String(p.paymentType || ''), reference: String(p.reference || ''), notes: String(p.notes || '').slice(0, 200),
    balance: null,
  }));
}

async function spHistory(acct) {
  const accounts = spConfiguredAccounts(process.env);
  const target = String(acct || '').trim();
  let recId = '';
  const rows = [];
  for (const a of accounts) {
    try {
      const loans = await spLoans(a);
      const hit = loans.find((l) => l.account === target || l.accountNumber === target);
      if (hit) recId = hit.recId;
      const pays = await spPayments(a);
      pays.forEach((p) => {
        if ((recId && String(p.LoanRecID) === String(recId)) || String(p.Account || '').trim() === target) rows.push(p);
      });
      if (rows.length) break;
    } catch (_) { /* try the other book */ }
  }
  return rows.map((p) => ({
    dateDue: spDate(p.DateDue), dateReceived: spDate(p.DateRec),
    daysLate: spNum(p.DaysLate), amount: spNum(p.Amount) != null ? spNum(p.Amount) : ((spNum(p.ToInterest) || 0) + (spNum(p.ToPrincipal) || 0) + (spNum(p.ToLateCharge) || 0) + (spNum(p.ToReserve) || 0) + (spNum(p.ToOtherPayments) || 0)),
    toInterest: spNum(p.ToInterest), toPrincipal: spNum(p.ToPrincipal), lateCharges: spNum(p.ToLateCharge),
    toReserve: spNum(p.ToReserve), toEscrow: null,
    type: String(p.SourceTyp || p.SourceApp || ''), reference: String(p.RecID || ''), notes: '',
    balance: spNum(p.LoanBalance),
  }));
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user) && !isProcessor(user)) return json(403, { error: 'Processor or admin only' });

    const url = new URL(req.url);
    const servicer = String(url.searchParams.get('servicer') || '').trim();
    const account = String(url.searchParams.get('account') || '').trim();
    const force = url.searchParams.get('force') === '1';
    if (!account) return json(400, { error: 'This loan has no servicer loan number yet — add it on the loan\'s Servicing tab.' });

    let kind = isSp(servicer, account) ? 'Servicing Pros' : isFci(servicer, account) ? 'FCI' : '';
    if (!kind) return json(400, { error: 'Servicer "' + (servicer || 'unknown') + '" has no payment-history integration (FCI and Servicing Pros do).' });

    const cache = getStore({ name: CACHE_STORE, consistency: 'strong' });
    const key = kind.replace(/\s+/g, '_').toLowerCase() + '/' + account.replace(/[^A-Za-z0-9_-]/g, '_');
    if (!force) {
      const hit = await cache.get(key, { type: 'json' }).catch(() => null);
      if (hit && hit.asOf && Date.now() - Date.parse(hit.asOf) < TTL_MS) return json(200, Object.assign({ ok: true, cached: true }, hit));
    }

    let rows;
    if (kind === 'FCI') {
      if (!fciConfigured()) return json(503, { error: 'FCI_API_TOKEN is not set' });
      rows = await fciHistory(account);
    } else {
      if (!spConfiguredAccounts(process.env).length) return json(503, { error: 'Servicing Pros API keys are not set' });
      rows = await spHistory(account);
    }
    rows.sort((a, b) => String(b.dateReceived || b.dateDue || '').localeCompare(String(a.dateReceived || a.dateDue || '')));
    const out = { servicer: kind, account, asOf: new Date().toISOString(), rows };
    await cache.setJSON(key, out).catch(() => {});
    return json(200, Object.assign({ ok: true, cached: false }, out));
  } catch (e) {
    console.error('loan-payment-history error:', e);
    return json(500, { error: 'Payment history failed: ' + ((e && e.message) || 'unknown') });
  }
};
