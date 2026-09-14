/**
 * admin-loan-tape-export-background.mjs — POST /api/admin-loan-tape-export
 *
 * Deploy 237.030 (Mike) — auditor loan tape: every loan FUNDED in a calendar
 * year, with its status as of year-end and the delinquency cohort at that
 * date (Current / 1-30 / 31-60 / 61-90 / 90+). Built as a BACKGROUND job
 * (202 now, ~1-3 min) because year-end delinquency comes from the servicers:
 *   • FCI  — getLoanDeliquency(account, dateTo) per loan (as-of a date).
 *   • Servicing Pros — the payments feed: paid-to date as of year-end from
 *     payments received by then, next due = +1 month, days late from there.
 *   • Loans paid off / sold before year-end are labelled as such (a buyer's
 *     servicer has the history for sold loans — we don't).
 *
 * Body: { year: 2025, asOf?: 'YYYY-MM-DD' (default Dec 31 of year) }
 * Output → store loan_tapes_export key '<year>': { status, meta, xlsxB64 }.
 * GET /api/admin-loan-tape-export-status?year=2025 for progress, +&download=1
 * for the .xlsx. Auth: admin or processor.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, isProcessor, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { pgGet } from './_shared/mail-match.mjs';
import { buildXlsx } from './_shared/xlsx-write.mjs';
import { fciConfigured, fciQuery, fciNum, fciDate } from './_shared/fci-api.mjs';
import { ACCOUNTS as SP_ACCOUNTS, spConfiguredAccounts, spPayments, spLoans, spDate } from './_shared/servicingpros-api.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';

const STORE = 'loan_tapes_export';
const BUDGET_MS = 13 * 60 * 1000;

const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };
const ymd = (v) => { const s = String(v || '').trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10); };
const mdy = (y) => { const m = String(y || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[2] + '-' + m[3] + '-' + m[1] : ''; };
const dateCell = (y) => { const m = String(y || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return ''; const serial = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000); return { v: serial, s: 'date' }; };
const cur = (v) => { const n = num(v); return n == null ? '' : { v: n, s: 'cur' }; };
const pct = (v) => { const n = num(v); if (n == null) return ''; return { v: n > 1 ? n / 100 : n, s: 'pct' }; };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const addMonths = (y, n) => { const m = String(y).match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return ''; const d = new Date(Date.UTC(+m[1], +m[2] - 1 + n, +m[3])); return d.toISOString().slice(0, 10); };
const bucketOf = (days) => days <= 0 ? 'Current' : days <= 30 ? '1-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
const isFci = (l) => /fci/i.test(String(l.servicerName || '')) || (!l.servicerName && /^\d{6,}$/.test(String(l.servicerLoanNumber || '')));
const isSp = (l) => /servicing\s*pro/i.test(String(l.servicerName || '')) || /^\d{2}-\d{4}-/.test(String(l.servicerLoanNumber || ''));

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(new Array(Math.min(size, items.length || 1)).fill(0).map(async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-loan-tape-export error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user) && !isProcessor(user)) return json(403, { error: 'Admin or processor only' });

  const body = (await readJsonBody(req)) || {};
  const year = parseInt(body.year, 10);
  if (!(year >= 2015 && year <= 2100)) return json(400, { error: 'year required (e.g. 2025)' });
  const asOf = ymd(body.asOf) || (year + '-12-31');
  const started = Date.now();
  const store = getStore({ name: STORE, consistency: 'strong' });
  const meta = { year, asOf, status: 'running', startedAt: new Date().toISOString(), startedBy: normalizeEmail(user.email), phase: 'loans', notes: [] };
  const save = (extra) => store.setJSON(String(year), Object.assign({ meta }, extra || {})).catch(() => {});
  await save();

  // 1. Loans funded in the year (PG locate → client blob for the full record).
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await pgGet('loans', 'select=id,client_id,owner_email,funding_date' +
      '&funding_date=gte.' + year + '-01-01&funding_date=lte.' + year + '-12-31&order=funding_date.asc&limit=1000&offset=' + offset);
    page.forEach((r) => rows.push(r));
    if (page.length < 1000) break;
  }
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const cache = new Map();
  const loans = [];
  for (const r of rows) {
    const ownerKey = keySafe(normalizeEmail(r.owner_email || ''));
    const ck = ownerKey + '/' + keySafe(r.client_id);
    if (!cache.has(ck)) cache.set(ck, await clientsStore.get(ck, { type: 'json' }).catch(() => null));
    const client = cache.get(ck);
    const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === r.id) : null;
    if (!loan) { meta.notes.push('No client record for ' + r.id); continue; }
    loans.push({ loan, client, ownerKey });
  }
  meta.loansFound = loans.length;

  // Funded production = closed/serviced loans; deals with a funding date but a
  // denied/cancelled status are listed separately so the auditor sees them.
  const isFunded = ({ loan }) => {
    const st = String(loan.status || '').toLowerCase();
    if (st === 'denied' || st === 'cancelled') return false;
    const d = String(loan.disposition || '').toLowerCase();
    return st === 'closed' || st === 'sold' || st === 'liquidated' || !!d || /closed|sold|servicing|paid/i.test(String(loan.baselineStatus || ''));
  };
  const funded = loans.filter(isFunded);
  const excluded = loans.filter((x) => !isFunded(x));

  // 2. Year-end delinquency.
  meta.phase = 'servicers'; await save();
  const ye = new Map(); // loanId -> { bucket, detail, source, nextDue, upb }
  const fciLoans = funded.filter(({ loan }) => loan.servicerLoanNumber && isFci(loan));
  const spLoansList = funded.filter(({ loan }) => loan.servicerLoanNumber && isSp(loan));
  meta.fciLoans = fciLoans.length; meta.spLoans = spLoansList.length;

  if (fciLoans.length && fciConfigured()) {
    let fciErrors = 0;
    await pool(fciLoans, 4, async ({ loan }) => {
      if (Date.now() - started > BUDGET_MS) return;
      const acct = String(loan.servicerLoanNumber).replace(/[^0-9A-Za-z-]/g, '');
      try {
        const d = await fciQuery('{ getLoanDeliquency(account:"' + acct + '" dateTo:"' + mdy(asOf) + '"){ detail{ account borrowerName current nextDueDate principalBalance upb1to30 upb31to60 upb61to90 upb121plus } } }', { timeoutMs: 30000 });
        const det = (d.getLoanDeliquency && d.getLoanDeliquency.detail || []).find((x) => String(x.account || '').replace(/[^0-9A-Za-z-]/g, '') === acct) || (d.getLoanDeliquency && d.getLoanDeliquency.detail || [])[0];
        if (!det) { ye.set(loan.id, { bucket: 'No FCI record at date', source: 'FCI', detail: 'Not on FCI book as of ' + asOf }); return; }
        const b = (fciNum(det.upb121plus) > 0) ? '90+' : (fciNum(det.upb61to90) > 0) ? '61-90' : (fciNum(det.upb31to60) > 0) ? '31-60' : (fciNum(det.upb1to30) > 0) ? '1-30' : 'Current';
        ye.set(loan.id, { bucket: b, source: 'FCI', nextDue: fciDate(det.nextDueDate) || '', upb: fciNum(det.principalBalance), detail: 'FCI delinquency report as of ' + asOf });
      } catch (e) {
        fciErrors++;
        ye.set(loan.id, { bucket: 'FCI lookup failed', source: 'FCI', detail: String((e && e.message) || 'error').slice(0, 120) });
      }
    });
    if (fciErrors) meta.notes.push('FCI lookups failed: ' + fciErrors);
  } else if (fciLoans.length) {
    meta.notes.push('FCI_API_TOKEN not set — FCI year-end status unavailable');
  }

  if (spLoansList.length) {
    const accounts = spConfiguredAccounts(process.env);
    const pays = [];
    const spByAccount = new Map();
    for (const a of accounts) {
      try {
        (await spPayments(a) || []).forEach((p) => pays.push(p));
        (await spLoans(a) || []).forEach((l) => { if (l.account) spByAccount.set(l.account, l); }); // normalized rows
      } catch (e) { meta.notes.push('Servicing Pros ' + a.label + ': ' + ((e && e.message) || 'error').slice(0, 100)); }
    }
    spLoansList.forEach(({ loan }) => {
      const acc = String(loan.servicerLoanNumber).trim();
      const sp = spByAccount.get(acc);
      const recId = sp && sp.recId;
      const mine = pays.filter((p) => (recId && String(p.LoanRecID) === String(recId)) || String(p.Account || '').trim() === acc);
      const received = mine.filter((p) => spDate(p.DateRec) && spDate(p.DateRec) <= asOf).map((p) => spDate(p.DateDue)).filter(Boolean).sort();
      if (!sp && !mine.length) { ye.set(loan.id, { bucket: 'No Servicing Pros record', source: 'Servicing Pros', detail: 'Not in the feed (paid-off loans are not returned)' }); return; }
      const paidTo = received.length ? received[received.length - 1] : '';
      const firstDue = sp ? (sp.firstPaymentDate || sp.nextDueDate) : '';
      const nextDue = paidTo ? addMonths(paidTo, 1) : firstDue;
      if (!nextDue) { ye.set(loan.id, { bucket: 'Unknown', source: 'Servicing Pros', detail: 'No due dates in the feed' }); return; }
      const days = daysBetween(nextDue, asOf);
      ye.set(loan.id, { bucket: bucketOf(days), source: 'Servicing Pros', nextDue, detail: 'From payments received by ' + asOf + (paidTo ? ' (paid to ' + paidTo + ')' : '') });
    });
  }

  // 3. Rows.
  meta.phase = 'workbook'; await save();
  const statusAtYE = ({ loan }) => {
    const po = ymd(loan.payoffDate || loan.paidOffDate);
    const sold = ymd(loan.soldDate);
    const fundedOn = ymd(loan.fundingDate || loan.closedAt);
    if (fundedOn && fundedOn > asOf) return { status: 'Not yet funded', bucket: '' };
    if (po && po <= asOf) return { status: 'Paid off ' + po, bucket: 'Paid off' };
    const y = ye.get(loan.id);
    if (y) return { status: (sold && sold <= asOf ? 'Sold ' + sold + ' · ' : '') + 'Performing? ' + y.bucket, bucket: y.bucket, y };
    if (sold && sold <= asOf) return { status: 'Sold ' + sold + ' (serviced by buyer)', bucket: 'Sold — no servicer data' };
    return { status: 'Active — no servicer data', bucket: 'No servicer data' };
  };
  const borrowerName = (c) => ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
  const slaNo = (l) => l.slaDisplayId || deriveBaselineLoanId({ id: l.id, fundingDate: l.fundingDate || '' }) || '';
  const product = (l) => { const t = String(l.toolType || '').toLowerCase(); return t === 'rtl' ? 'RTL' : t === 'dscr' ? 'DSCR' : t === 'guc' ? 'Ground-Up' : ''; };
  const isIO = (l) => (l.isIO === true || l.isIO === 'true' || l.isIO === 'io' || l.isIO === 'yes') ? 'Interest-only' : (l.isIO === false || l.isIO === 'no' || l.isIO === 'false') ? 'Amortized' : '';
  const dutch = (l) => String(l.dutchInterest || '').toLowerCase() === 'non_dutch' ? 'Non-Dutch' : (l.dutchInterest ? 'Dutch' : '');
  const purpose = (l) => { const p = String(l.loanPurpose || '').toLowerCase(); return p === 'cashout' ? 'Cash-out refi' : p === 'rateterm' ? 'Rate/term refi' : p ? 'Purchase' : ''; };
  const dispLabel = (l) => { const d = String(l.disposition || '').toLowerCase().replace(/[_\s]+/g, ' '); return d === 'post close' ? 'Post Close' : d === 'pending sale' ? 'Pending Sale' : d === 'paid off' ? 'Paid Off' : d === 'sold' ? 'Sold' : d === 'servicing' ? 'Servicing' : (l.status || ''); };

  const HEAD = ['SLA Loan #', 'Property Address', 'City', 'State', 'ZIP', 'Borrower', 'Borrowing Entity', 'Product', 'Purpose', 'Interest Structure', 'Amortization',
    'Funding Date', 'Maturity Date', 'Term (mo)', 'Original Loan Amount', 'Rate', 'Points', 'Purchase Price', 'As-Is Value', 'ARV', 'Rehab Budget', 'FICO', 'Lien',
    'Status Today', 'Investor', 'Sold Date', 'Sold Rate', 'Payoff Date', 'Servicer', 'Servicer Loan #', 'Current UPB (today)', 'Days Late (today)', 'Paid-To (today)', 'Next Due (today)',
    'Status at ' + asOf, 'Delinquency Cohort at ' + asOf, 'UPB at ' + asOf, 'Next Due at ' + asOf, 'Cohort Source'];
  const addrParts = (a) => { const p = String(a || '').split(',').map((s) => s.trim()); const st = (p[2] || '').match(/([A-Z]{2})\s*(\d{5})?/); return { street: p[0] || '', city: p[1] || '', state: st ? st[1] : (p[2] || ''), zip: st && st[2] ? st[2] : ((p[2] || '').match(/\d{5}/) || [''])[0] }; };
  const row = (x) => {
    const { loan: l, client: c } = x; const a = addrParts(l.address); const s = statusAtYE(x); const y = s.y || {};
    return [slaNo(l), a.street, a.city, a.state, a.zip, borrowerName(c), l.entityName || c.entityName || (Array.isArray(l.vestingLLCs) && l.vestingLLCs[0] && l.vestingLLCs[0].name) || '',
      product(l), purpose(l), dutch(l), isIO(l), dateCell(ymd(l.fundingDate || l.closedAt)), dateCell(ymd(l.maturityDate)), num(l.loanTerm) || '',
      cur(l.finalLoanAmount || l.loanAmt), pct(l.rate), num(l.points) != null ? num(l.points) : '', cur(l.purchasePrice), cur(l.propValue || l.aivBpo), cur(l.arv), cur(l.rehabBudget),
      num(c.fico) || '', l.lienPosition || '', dispLabel(l), l.investorName || '', dateCell(ymd(l.soldDate)), pct(l.soldRate), dateCell(ymd(l.payoffDate)),
      l.servicerName || '', l.servicerLoanNumber || '', cur(l.currentBalance || l.upb), num(l.daysLate) != null ? num(l.daysLate) : '', dateCell(ymd(l.paidToDate)), dateCell(ymd(l.nextDueDate)),
      s.status, s.bucket, y.upb != null ? cur(y.upb) : '', dateCell(ymd(y.nextDue)), y.source || ''];
  };
  funded.sort((p, q) => String(p.loan.fundingDate || '').localeCompare(String(q.loan.fundingDate || '')));
  const tape = [HEAD].concat(funded.map(row));
  const excl = [HEAD].concat(excluded.map(row));

  // Summary.
  const total = funded.reduce((s, x) => s + (num(x.loan.finalLoanAmount || x.loan.loanAmt) || 0), 0);
  const byMonth = {}; const byProduct = {}; const cohorts = {};
  funded.forEach((x) => {
    const m = ymd(x.loan.fundingDate || x.loan.closedAt).slice(0, 7); const amt = num(x.loan.finalLoanAmount || x.loan.loanAmt) || 0;
    (byMonth[m] = byMonth[m] || { n: 0, amt: 0 }); byMonth[m].n++; byMonth[m].amt += amt;
    const p = product(x.loan) || 'Unknown'; (byProduct[p] = byProduct[p] || { n: 0, amt: 0 }); byProduct[p].n++; byProduct[p].amt += amt;
    const b = statusAtYE(x).bucket || 'Not yet funded'; (cohorts[b] = cohorts[b] || { n: 0, amt: 0 }); cohorts[b].n++; cohorts[b].amt += amt;
  });
  const summary = [
    ['SLA Capital — ' + year + ' Loan Production', ''],
    ['Generated', new Date().toISOString().slice(0, 10)], ['Status as of', asOf], [],
    ['Loans funded in ' + year, funded.length], ['Total original principal', cur(total)],
    ['Deals with a ' + year + ' funding date but denied/cancelled (see Excluded sheet)', excluded.length], [],
    ['By product', 'Loans', 'Original principal']].concat(Object.keys(byProduct).sort().map((k) => [k, byProduct[k].n, cur(byProduct[k].amt)]))
    .concat([[], ['By funding month', 'Loans', 'Original principal']], Object.keys(byMonth).sort().map((k) => [k, byMonth[k].n, cur(byMonth[k].amt)]))
    .concat([[], ['Cohort at ' + asOf, 'Loans', 'Original principal']], ['Current', '1-30', '31-60', '61-90', '90+', 'Paid off', 'Sold — no servicer data', 'No servicer data', 'No FCI record at date', 'FCI lookup failed', 'No Servicing Pros record', 'Unknown', 'Not yet funded']
      .filter((k) => cohorts[k]).map((k) => [k, cohorts[k].n, cur(cohorts[k].amt)]))
    .concat([[], ['Notes'], ['Delinquency cohorts come from the servicer of record as of the date: FCI (delinquency report) or Servicing Pros (payments received by the date). Loans sold before the date are serviced by the buyer; their history is not available to SLA.']],
      meta.notes.map((n) => [n]));

  const buf = await buildXlsx([
    { name: 'Summary', rows: summary },
    { name: year + ' Loan Tape', rows: tape },
    { name: 'Excluded (not funded)', rows: excl },
  ]);
  meta.status = 'done'; meta.phase = 'done'; meta.finishedAt = new Date().toISOString();
  meta.funded = funded.length; meta.excluded = excluded.length; meta.totalPrincipal = Math.round(total);
  meta.cohorts = Object.keys(cohorts).reduce((o, k) => (o[k] = cohorts[k].n, o), {});
  meta.tookSeconds = Math.round((Date.now() - started) / 1000);
  meta.filename = 'SLA ' + year + ' Loan Tape (status ' + asOf + ').xlsx';
  // Small preview for the status endpoint (QA without opening the file).
  const plain = (v) => (v && typeof v === 'object') ? v.v : v;
  meta.preview = tape.slice(0, 8).map((r) => r.map(plain));
  meta.yeStatuses = funded.map((x) => [slaNo(x.loan), String(x.loan.address || '').split(',')[0], statusAtYE(x).bucket, (ye.get(x.loan.id) || {}).detail || '']);
  await save({ xlsxB64: Buffer.from(buf).toString('base64') });
  return json(200, { ok: true });
}
