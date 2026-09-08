/**
 * scripts/search-quote-dedupe-test.mjs — Deploy 236.908
 *
 * Gate for the universal search's quote/loan reconcile
 * (reconcileQuotesWithLoans in search-pg.mjs).
 *
 * Mike: "make it so that in the universal search the quotes don't appear if
 * a loan also exists."
 *
 * The rule: a quote never shows when a loan exists for it — whether that loan
 * matched the search or not, and whether the quote knows its loanId or is a
 * legacy address-keyed draft. The loan takes its place in the results, but
 * only inside the caller's scope.
 *
 * Run: node scripts/search-quote-dedupe-test.mjs
 */
import { reconcileQuotesWithLoans } from '../deploy/netlify/functions/search-pg.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

const ME = 'mike@slacapital.com';
const loan = (id, address, ownerKey = ME) => ({ id, address, ownerKey, status: 'active' });
const quote = (id, loanId, address) => ({ id, loanId: loanId || '', address, name: 'Q ' + id });
const ids = (arr) => arr.map((x) => x.id);

console.log('search quote/loan dedupe gate\n');

// ── The reported case: the loan exists but did not match the search ──────
{
  const r = reconcileQuotesWithLoans({
    quotes: [quote('q1', 'l_1', '402 Plymouth Rd')],
    loans: [],
    found: [loan('l_1', '402 Plymouth Road, Valparaiso, IN')],
    wantAll: false, selfEmail: ME,
  });
  check('quote with an existing loan is dropped', ids(r.quotes), []);
  check('  and the loan is shown in its place', ids(r.loans), ['l_1']);
}

// ── Loan already in the results: no duplicate ────────────────────────────
{
  const r = reconcileQuotesWithLoans({
    quotes: [quote('q1', 'l_1', 'x')],
    loans: [loan('l_1', 'x')],
    found: [loan('l_1', 'x')],
    wantAll: false, selfEmail: ME,
  });
  check('quote dropped when its loan already matched', ids(r.quotes), []);
  check('  loan not duplicated', ids(r.loans), ['l_1']);
}

// ── Legacy quote with NO loanId, loan at the same address ────────────────
{
  const r = reconcileQuotesWithLoans({
    quotes: [quote('q_legacy', '', '430 main st, spokane, wa 99208, USA')],
    loans: [],
    found: [loan('l_2', '430 Main St., Spokane, WA 99208')],
    wantAll: false, selfEmail: ME,
  });
  check('address-keyed legacy quote dropped when a loan sits at that address', ids(r.quotes), []);
  check('  (normalisation ignores case, punctuation, trailing USA)', ids(r.loans), ['l_2']);
}

// ── Scope: the loan lives in another LO's book ───────────────────────────
{
  const other = loan('l_3', '1 Elm', 'beth@slacapital.com');
  const mine = reconcileQuotesWithLoans({
    quotes: [quote('q3', 'l_3', '1 Elm')], loans: [], found: [other],
    wantAll: false, selfEmail: ME,
  });
  check('"mine" scope: quote still dropped (a loan exists)', ids(mine.quotes), []);
  check('  but another LO\'s loan is NOT surfaced', ids(mine.loans), []);

  const all = reconcileQuotesWithLoans({
    quotes: [quote('q3', 'l_3', '1 Elm')], loans: [], found: [other],
    wantAll: true, selfEmail: ME,
  });
  check('"All LOs" scope: the loan is surfaced', ids(all.loans), ['l_3']);
}

// ── Genuine orphan drafts stay ───────────────────────────────────────────
{
  const r = reconcileQuotesWithLoans({
    quotes: [quote('q4', '', '9 Nowhere Ln'), quote('q5', 'l_gone', '5 Deleted St')],
    loans: [],
    found: [],   // Postgres found nothing for either
    wantAll: false, selfEmail: ME,
  });
  check('a quote with no loan anywhere stays', ids(r.quotes), ['q4', 'q5']);
  check('  nothing added to loans', ids(r.loans), []);
}

// ── Order: matched loans keep priority, surfaced ones append ─────────────
{
  const r = reconcileQuotesWithLoans({
    quotes: [quote('qa', 'l_b', 'B'), quote('qb', 'l_c', 'C')],
    loans: [loan('l_a', 'A')],
    found: [loan('l_c', 'C'), loan('l_b', 'B')],
    wantAll: false, selfEmail: ME,
  });
  check('matched loans stay first; surfaced loans follow in quote order', ids(r.loans), ['l_a', 'l_b', 'l_c']);
  check('  every quote with a loan is gone', ids(r.quotes), []);
}

// ── Robustness ───────────────────────────────────────────────────────────
{
  const r = reconcileQuotesWithLoans({ quotes: [null, quote('q6', '', '')], loans: [null], found: [null], wantAll: false, selfEmail: ME });
  check('nulls and empty addresses do not throw', ids(r.quotes), ['q6']);
  const e = reconcileQuotesWithLoans({ quotes: undefined, loans: undefined, found: undefined, wantAll: false, selfEmail: ME });
  check('missing inputs → empty outputs', [e.quotes.length, e.loans.length], [0, 0]);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
