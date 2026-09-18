/**
 * scripts/fci-payoff-ui-test.mjs — Deploy 237.144
 *
 * The FCI blocks on Loan Details render inside one big page script, and 236.804 showed
 * how they fail: an undeclared identifier (esc vs escH) threw inside BOTH the .then and
 * the .catch, so the box spun forever with no error and node --check saw nothing wrong.
 * This LIFTS loadFciActivity + loadFciPayoff out of loan-details.js and runs them against
 * stubbed responses, so that class of bug fails here instead of in front of a processor.
 *
 * Deploy 237.170: the box used to end "FCI accepted these", which we had not
 * earned -- insertPayoff can answer without a GraphQL error and without creating
 * anything. Each demand now carries whether FCI's OWN records confirmed it, and these
 * checks pin that the page says which.
 *
 * Run: node scripts/fci-payoff-ui-test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../deploy/loan-details.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('marker missing: ' + from.slice(0, 50));
  return src.slice(a, b);
};
const code = cut('function _fciDay(v) {', 'function openPayoffOrderModal');

const els = {};
const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', style: {} });
let nextJson = null;
const ctx = {
  console, String, Number, Array, Object, Date, JSON, isFinite, parseFloat, encodeURIComponent,
  document: { getElementById: (id) => el(id) },
  escH: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  fmtDate: (d) => String(d || ''),
  showToast: () => {},
  SLA: { getToken: () => Promise.resolve('tok'), api: () => Promise.resolve(nextJson) },
  fetch: () => Promise.resolve({ json: () => Promise.resolve(nextJson) }),
  _loanId: 'l1', _clientId: 'c1', _loEmail: 'lo@x.com',
  _loan: { servicerLoanNumber: '399653858', servicerName: 'FCI' },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let failures = 0;
const check = (name, fn) => {
  try { const v = fn(); if (v === true) { console.log('  ok   ' + name); return; } failures++; console.log('  FAIL ' + name + ' :: ' + v); }
  catch (e) { failures++; console.log('  FAIL ' + name + ' :: threw ' + (e && e.message)); }
};
const run = (s) => vm.runInContext(s, ctx);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── dates: FCI answers in two formats, ours is ISO ────────────────────────
check('_fciDay takes ISO, plain dates and US alike', () =>
  [run("_fciDay('2026-09-18T02:50:04.706Z')"), run("_fciDay('2026-10-15')"), run("_fciDay('10/15/2026')"), run("_fciDay('')")]
    .join('|') === '9/18/2026|10/15/2026|10/15/2026|—' || [run("_fciDay('2026-09-18T02:50:04.706Z')"), run("_fciDay('2026-10-15')")].join('|'));

// ── FCI notes fold away, closed ───────────────────────────────────────────
nextJson = { notes: [{ date: '2026-09-01', subject: 'Boarding', text: 'Loan boarded.' }, { date: '2026-09-05', subject: 'Call', text: 'Borrower called.' }], rows: [], asOf: '2026-09-17' };
run('loadFciActivity()');
await tick(); await tick();
check('FCI notes are a collapsed <details>, not an open list', () => {
  const h = els.fciActivityBody.innerHTML || '';
  if (h.indexOf('<details') < 0) return 'not collapsible';
  if (/<details[^>]*\bopen\b/.test(h)) return 'it defaults OPEN';
  return h.indexOf('FCI notes (2)') > 0 && h.indexOf('Loan boarded.') > 0 || 'notes missing';
});
check('the payments table stays outside the fold', () => {
  const h = els.fciActivityBody.innerHTML || '';
  return h.indexOf('</details>') < h.indexOf('Latest payments') || 'payments got folded in too';
});
nextJson = { notes: [], rows: [], asOf: '2026-09-17' };
run('loadFciActivity()');
await tick(); await tick();
check('no notes still renders without throwing', () => (els.fciActivityBody.innerHTML || '').indexOf('No notes from FCI') > 0 || 'empty-state broken');

// ── a demand we filed shows even before FCI lists it (Mike's report) ──────
const filedOnly = {
  ok: true, serviced: true, account: '399653858', value: null, requests: null,
  filed: [{ at: '2026-09-18T02:50:04.706Z', by: 'mike@slacapital.com', payoffDate: '2026-10-15', company: 'Sir Lends A Lot LLC', contact: 'beth@slacapital.com' }],
};
nextJson = filedOnly;
run('loadFciPayoff(true)');
await tick(); await tick();
check('a demand FCI has not listed yet is shown, with who ordered it', () => {
  const h = els.fciPayoffBody.innerHTML || '';
  return h.indexOf('Ordered by us') > 0 && h.indexOf('10/15/2026') > 0 && h.indexOf('mike') > 0 || 'demand not shown';
});
check('the page NEVER claims FCI accepted it', () =>
  (els.fciPayoffBody.innerHTML || '').indexOf('FCI accepted') < 0 || 'the page still asserts FCI accepted it');
check('and it says what to do if it lingers', () => (els.fciPayoffBody.innerHTML || '').indexOf('call it in') > 0 || 'no guidance');

nextJson = Object.assign({}, filedOnly, {
  requests: { payoffStatus: 'Active', requests: [{ dateReceived: '2026-09-18T00:00:00Z', payoffDate: '2026-10-15', expirationDate: '2026-10-20', trackingStatus: 'Issued', requestedBy: 'Lender' }] },
});
run('loadFciPayoff(true)');
await tick(); await tick();
check('once FCI lists the same demand it stops being duplicated as pending', () => {
  const h = els.fciPayoffBody.innerHTML || '';
  return h.indexOf('Demand History') > 0 && h.indexOf('Ordered by us') < 0 || 'still double-listed';
});

// Deploy 237.170 -- the three states of a demand we sent.
nextJson = { ok: true, serviced: true, account: '399653858', value: null, requests: null, filed: [
  { at: '2026-09-18T02:50:04.706Z', by: 'mike@slacapital.com', payoffDate: '2026-10-15', company: 'A', confirmed: true },
  { at: '2026-09-18T02:51:04.706Z', by: 'mike@slacapital.com', payoffDate: '2026-11-15', company: 'B', confirmed: false },
  { at: '2026-09-18T02:52:04.706Z', by: 'mike@slacapital.com', payoffDate: '2026-12-15', company: 'C' },
] };
run('loadFciPayoff(true)');
await tick(); await tick();
check('confirmed, not confirmed and unknown are each named on the row', () => {
  const h = els.fciPayoffBody.innerHTML || '';
  return (h.indexOf('>confirmed<') > 0 && h.indexOf('not confirmed') > 0 && h.indexOf('unknown') > 0)
    || 'the three states are not distinguished';
});
check('a demand from BEFORE this deploy carries no flag and must read unknown \u2014 not confirmed', () => {
  const h = els.fciPayoffBody.innerHTML || '';
  // three rows, exactly one 'unknown' (the flagless one)
  return (h.match(/unknown/g) || []).length === 1 || 'a flagless demand was not reported as unknown';
});
check('the footnote tells you what to do about an unconfirmed one', () =>
  (els.fciPayoffBody.innerHTML || '').indexOf('check the FCI portal') > 0 || 'no guidance for an unconfirmed demand');

nextJson = { ok: true, serviced: true, account: '399653858', value: null, requests: null, filed: [] };
run('loadFciPayoff(true)');
await tick(); await tick();
check('a loan with nothing ordered renders the plain empty state', () => {
  const h = els.fciPayoffBody.innerHTML || '';
  return h.indexOf('No live payoff figure') > 0 && h.indexOf('Ordered by us') < 0 || 'empty state broken';
});

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
