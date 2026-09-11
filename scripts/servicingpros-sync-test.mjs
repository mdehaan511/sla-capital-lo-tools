/**
 * scripts/servicingpros-sync-test.mjs — Deploy 236.983
 *
 * Gate for the pure half of the Servicing Pros sync (deploy/netlify/functions/
 * _shared/servicingpros-api.mjs): how their loan rows are read, how a paid-off
 * loan is recognised, which env keys count as configured, and how one servicer
 * account stamped on several of our loans resolves.
 *
 * Run: node scripts/servicingpros-sync-test.mjs
 */
import {
  ACCOUNTS, spConfiguredAccounts, spDate, spNum, spPct, normalizeSpLoan, dispositionForSp, pickLoanForSpRow,
} from '../deploy/netlify/functions/_shared/servicingpros-api.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('servicing pros sync gate\n');

// ── env keys → accounts ─────────────────────────────────────────────────
check('no keys → nothing configured', spConfiguredAccounts({}).map((a) => a.key), []);
check('one key → that account only', spConfiguredAccounts({ SERVICINGPROS_API_KEY_SLA_KAF: 'x'.repeat(40) }).map((a) => a.key), ['SLA_KAF']);
check('both keys → both accounts, SLA first', spConfiguredAccounts({ SERVICINGPROS_API_KEY_SLA: 'y'.repeat(40), SERVICINGPROS_API_KEY_SLA_KAF: 'x'.repeat(40) }).map((a) => a.label), ['SLA', 'SLA-KAF']);
check('a blank / too-short value is not a key', spConfiguredAccounts({ SERVICINGPROS_API_KEY_SLA: ' ' }).length, 0);
check('investor per book matches the 236.734 reconcile', [ACCOUNTS.SLA.investorName, ACCOUNTS.SLA_KAF.investorName], ['Sir Lends A Lot LLC', 'King Arthur Fund 1 LLC']);

// ── value parsing ───────────────────────────────────────────────────────
check('their datetime → ISO date', spDate('2026-10-01 00:00:00'), '2026-10-01');
check('null / 1900 placeholder / n/a → blank', [spDate(null), spDate('1900-01-01 00:00:00'), spDate('n/a')], ['', '', '']);
check('numbers: "335000.0000" string, 502850, null', [spNum('335000.0000'), spNum(502850), spNum(null)], [335000, 502850, null]);
check('rates arrive as percents; a decimal form is normalized', [spPct(10.99), spPct(0.11), spPct(0)], ['10.99', '11', '']);

// ── a loan row as their feed sends it ───────────────────────────────────
const RAW = {
  LoanRecID: '0CB890E76A5B417B80CE08D0A780C707', LoanAccount: '26-0079-SL', LoanAccountNumber: '2004809808',
  LoanTermsOrigBal: 335000, LoanTermsPrinBal: 335000, LoanTermsNoteRate: 11,
  LoanTermsClosingDate: '2026-03-20 00:00:00', LoanTermsMaturityDate: '2027-04-01 00:00:00',
  LoanTermsNextDueDate: '2026-10-01 00:00:00', LoanTermsPaidToDate: '2026-09-01 00:00:00', LoanTermsPaidOffDate: null,
  LoanTermsPmtPI: 3070.83, LoanTermsRegularPayment: 3090.83, LoanDaysLate: -20, LoanServiceStatus: 1,
  LoanTermsUnpaidLateCharges: 0, LoanTermsCategories: 'Portal Access, Active', LastPaymentDate: '2026-09-09 00:00:00',
  BorrowerFullName: 'Some Borrower', BorrowerEmailAddress: 'B@Example.com', BorrowerCity: 'SPOKANE', BorrowerState: 'WA',
};
const l = normalizeSpLoan(RAW, 'SLA_KAF');
check('account / book / balances / rate', [l.account, l.book, l.origBalance, l.principalBalance, l.noteRate], ['26-0079-SL', 'SLA_KAF', 335000, 335000, '11']);
check('dates', [l.closingDate, l.maturityDate, l.nextDueDate, l.paidToDate, l.lastPaymentDate, l.paidOffDate], ['2026-03-20', '2027-04-01', '2026-10-01', '2026-09-01', '2026-09-09', '']);
check('regular payment preferred over P&I; days late; status', [l.regularPayment, l.pmtPI, l.daysLate, l.serviceStatus], [3090.83, 3070.83, -20, 1]);
check('borrower contact kept but lower-cased email', [l.borrowerName, l.borrowerEmail], ['Some Borrower', 'b@example.com']);
check('active loan → sold', dispositionForSp(l), 'sold');
const paid = normalizeSpLoan(Object.assign({}, RAW, { LoanTermsPaidOffDate: '2026-08-15 00:00:00', LoanTermsPrinBal: 0, LoanServiceStatus: 0 }), 'SLA');
check('an explicit paid-off date → paid_off', [paid.paidOff, dispositionForSp(paid), paid.paidOffDate], [true, 'paid_off', '2026-08-15']);
check('missing regular payment falls back to P&I', normalizeSpLoan(Object.assign({}, RAW, { LoanTermsRegularPayment: null }), 'SLA').regularPayment, 3070.83);

// ── one account stamped on several loans ────────────────────────────────
const row = { origBalance: 335000 };
check('single match passes through', pickLoanForSpRow([{ loanId: 'a', loanAmt: 335000 }], row).pick.loanId, 'a');
check('two loans at one property: the balance picks the lien', pickLoanForSpRow([{ loanId: '1st', loanAmt: 335000 }, { loanId: '2nd', loanAmt: 60000 }], row).pick.loanId, '1st');
check('both within 2% → nothing chosen', pickLoanForSpRow([{ loanId: 'a', loanAmt: 335000 }, { loanId: 'b', loanAmt: 336000 }], row).pick, null);
check('closest is 10% off → nothing chosen', pickLoanForSpRow([{ loanId: 'a', loanAmt: 300000 }, { loanId: 'b', loanAmt: 100000 }], row).pick, null);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
