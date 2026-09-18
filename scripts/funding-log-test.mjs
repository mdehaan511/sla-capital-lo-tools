/**
 * scripts/funding-log-test.mjs — Deploy 237.157
 * Pins the Funding Plan chain-of-custody log (_shared/funding-log.mjs).
 * Run: node scripts/funding-log-test.mjs
 */
import { appendFundingLog, MAX_FUNDING_LOG } from '../deploy/netlify/functions/_shared/funding-log.mjs';

let failures = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) failures++; };

// A first assignment logs one line per field that moved.
let before = { fundingSource: '', companyOnDocs: '', investorName: '', assignedDate: '' };
let loan = { fundingSource: 'sla_capital', companyOnDocs: 'Sir Lends A Lot LLC', investorName: 'Colchis', assignedDate: '2026-09-18' };
let added = appendFundingLog(loan, before, { actor: 'mike@slacapital.com', source: 'Funding Plan' });
ok(added.length === 4, 'four moves logged on the first save');
ok(loan.fundingLog.length === 4, 'entries land on loan.fundingLog');
ok(loan.fundingLog[0].field === 'fundingSource', 'funding source is logged first');
ok(loan.fundingLog[0].to === 'SLA Capital', 'the source code is written out in English');
ok(loan.fundingLog[0].by === 'mike@slacapital.com' && loan.fundingLog[0].source === 'Funding Plan', 'who and where are recorded');
ok(!!Date.parse(loan.fundingLog[0].at), 'timestamped');

// Re-saving without changes adds nothing.
added = appendFundingLog(loan, Object.assign({}, loan), { actor: 'mike@slacapital.com' });
ok(added.length === 0 && loan.fundingLog.length === 4, 'a save that moves nothing logs nothing');

// Moving the loan to another investor logs the from -> to chain.
before = Object.assign({}, loan);
loan.investorName = 'King Arthur Fund 1 LLC';
loan.assignedDate = '2026-10-01';
added = appendFundingLog(loan, before, { actor: 'dan@slacapital.com', source: 'Servicing' });
ok(added.length === 2, 'the re-assignment logs the investor + the date');
const move = loan.fundingLog[0];
ok(move.field === 'investorName' && move.from === 'Colchis' && move.to === 'King Arthur Fund 1 LLC', 'from -> to is the chain');
ok(loan.fundingLog.length === 6 && loan.fundingLog[5].field === 'assignedDate', 'newest first, history kept');

// A form that does not carry the field must not log a phantom clear.
before = Object.assign({}, loan);
loan.companyOnDocs = '';
added = appendFundingLog(loan, before, { actor: 'x@y.com' });
ok(added.length === 0, 'a blank arriving over a real value is not logged as a move');

// Cap.
let big = { investorName: 'A', fundingLog: [] };
for (let i = 0; i < MAX_FUNDING_LOG + 10; i++) {
  const b = Object.assign({}, big);
  big.investorName = 'Investor ' + i;
  appendFundingLog(big, b, { actor: 'x@y.com' });
}
ok(big.fundingLog.length === MAX_FUNDING_LOG, 'history caps at ' + MAX_FUNDING_LOG);
ok(big.fundingLog[0].to === 'Investor ' + (MAX_FUNDING_LOG + 9), 'the newest entry survives the cap');

// Never throws.
ok(appendFundingLog(null, null, {}).length === 0, 'a missing loan is a no-op, not a crash');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall checks pass');
process.exit(failures ? 1 : 0);
