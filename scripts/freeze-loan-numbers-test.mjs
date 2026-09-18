/**
 * scripts/freeze-loan-numbers-test.mjs — Deploy 237.164 (Mike)
 *
 * Freezing a loan number is only safe while two things hold:
 *
 *   1. "Closed" means the same thing to the freeze as it does to the Closed
 *      Loans page. The rule is written out twice (closed-loans.html's
 *      isClosedLoan and _shared/loan-number.mjs's isClosedLoanRecord), so this
 *      pulls the browser copy out of the shipped page and compares them.
 *   2. The value stamped is EXACTLY what the loan already displays. If it ever
 *      differs, freezing would silently rename loans and unhook them from
 *      Sitewire — the opposite of the point.
 *
 * Plus the guarantees the sweep leans on: blanks only, idempotent, and frozen
 * numbers are flagged so the Baseline dedupe's merge-by-number pass skips them.
 *
 *   node scripts/freeze-loan-numbers-test.mjs
 */
import { readFileSync } from 'node:fs';
import {
  isClosedLoanRecord, freezeLoanNumber, freezeClientLoanNumbers,
  isFrozenLoanNumber, slaLoanNumber, deriveSlaLoanNumber,
} from '../deploy/netlify/functions/_shared/loan-number.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
function extract(src, marker, file) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('could not find ' + marker + ' in ' + file);
  let k = src.indexOf('{', i), depth = 0;
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, k + 1);
}
const pageIsClosed = new Function(
  extract(read('deploy/closed-loans.html'), 'function isClosedLoan(l){', 'closed-loans.html') +
  '\nreturn isClosedLoan;')();

let failed = 0;
const fail = (m) => { failed++; console.log('  ✗ ' + m); };
const ok   = (m) => console.log('  ✓ ' + m);

// ── 1. Closed means closed, on both sides ──
console.log('"Closed" agrees with the Closed Loans page\n');
const STATES = [
  { name: 'fresh sizer quote',    loan: { status: 'active' },                          want: false },
  { name: 'in processing',        loan: { status: 'in_processing', processingStage: 'underwriting' }, want: false },
  { name: 'cleared to close',     loan: { status: 'approved', processingStage: 'pp_approved' },       want: false },
  { name: 'on hold',              loan: { status: 'on_hold' },                         want: false },
  { name: 'denied',               loan: { status: 'denied' },                          want: false },
  { name: 'status closed',        loan: { status: 'closed' },                          want: true  },
  { name: 'stage pp_closed',      loan: { status: 'in_processing', processingStage: 'pp_closed' },    want: true  },
  { name: 'disposition post close', loan: { status: 'in_processing', disposition: 'post_close' },     want: true  },
  { name: 'disposition servicing',  loan: { disposition: 'servicing' },                want: true  },
  { name: 'disposition pending sale', loan: { disposition: 'pending sale' },           want: true  },
  { name: 'disposition paid off', loan: { disposition: 'paid_off' },                   want: true  },
  { name: 'sold',                 loan: { status: 'sold' },                            want: true  },
  { name: 'legacy baselineStatus', loan: { baselineStatus: 'In Servicing' },           want: true  },
  { name: 'empty record',         loan: {},                                            want: false },
];
for (const s of STATES) {
  const mine = isClosedLoanRecord(s.loan), page = !!pageIsClosed(s.loan);
  if (mine === page && mine === s.want) ok(s.name.padEnd(24) + (mine ? 'closed' : 'open'));
  else fail(s.name + ' — freeze says ' + mine + ', Closed Loans page says ' + page + ', expected ' + s.want);
}

// ── 2. The stamped value is the number already on screen ──
console.log('\nFreezing changes no displayed number');
const CLOSED = [
  { id: 'l_1787948453094_1sxv', status: 'closed', fundingDate: '2026-08-31', createdAt: '2026-08-28T20:20:53.094Z' },
  { id: 'l_1780000000000_zzz9', disposition: 'servicing', createdAt: '2026-02-02T00:00:00Z' },
  { id: 'l_1770000000000_aa11', status: 'closed', fundingDate: '2026-01-05T00:00:00.000Z' },
];
for (const loan of CLOSED) {
  const shownBefore = slaLoanNumber(loan);
  const stamped = freezeLoanNumber(loan);
  const shownAfter = slaLoanNumber(loan);
  if (stamped && stamped === shownBefore && shownAfter === shownBefore) ok(loan.id + ' → ' + stamped + ' (unchanged on screen)');
  else fail(loan.id + ' — shown ' + shownBefore + ', stamped ' + stamped + ', now shows ' + shownAfter);
  if (!isFrozenLoanNumber(loan)) fail(loan.id + ' — missing the frozen breadcrumb');
}

// ── 3. Blanks only, idempotent ──
console.log('\nBlanks only, and safe to re-run');
const baseline = { id: 'l_x', status: 'closed', fundingDate: '2026-03-03', slaDisplayId: 'SLA-20260101-0001' };
if (freezeLoanNumber(baseline) === '' && baseline.slaDisplayId === 'SLA-20260101-0001' && !isFrozenLoanNumber(baseline)) ok('a Baseline id / hand edit is left alone');
else fail('an existing number was overwritten: ' + baseline.slaDisplayId);

const open = { id: 'l_y', status: 'in_processing', createdAt: '2026-03-03' };
if (freezeLoanNumber(open) === '' && !open.slaDisplayId) ok('an open loan is not frozen');
else fail('an open loan got a number: ' + open.slaDisplayId);

const twice = { id: 'l_z', status: 'closed', fundingDate: '2026-04-04' };
const first = freezeLoanNumber(twice);
const stampedAt = twice.slaDisplayIdFrozenAt;
const second = freezeLoanNumber(twice);
if (first && second === '' && twice.slaDisplayId === first && twice.slaDisplayIdFrozenAt === stampedAt) ok('re-running is a no-op');
else fail('second pass moved something: ' + JSON.stringify(twice));

// ── 4. The client sweep the write path runs ──
console.log('\nClient sweep');
const client = { id: 'c_1', loans: [
  { id: 'l_a', status: 'closed', fundingDate: '2026-05-05' },
  { id: 'l_b', status: 'active',  createdAt: '2026-05-05' },
  { id: 'l_c', disposition: 'sold', slaDisplayId: 'SLA-20250101-0007', createdAt: '2026-05-05' },
] };
const done = freezeClientLoanNumbers(client);
if (done.length === 1 && done[0].loanId === 'l_a' && client.loans[1].slaDisplayId === undefined && client.loans[2].slaDisplayId === 'SLA-20250101-0007') {
  ok('one closed blank frozen, open loan and Baseline id untouched');
} else fail('sweep touched the wrong loans: ' + JSON.stringify(done) + ' / ' + JSON.stringify(client.loans.map((l) => l.slaDisplayId)));
if (!freezeClientLoanNumbers(client).length) ok('second sweep is a no-op');
else fail('second sweep stamped again');

// ── 5. A frozen number must never look authoritative to Baseline ──
console.log('\nBaseline dedupe guard');
const dedupeSrc = read('deploy/netlify/functions/baseline-dedupe-merge.mjs');
if (/if \(disp && !isFrozenLoanNumber\(loan\)\)/.test(dedupeSrc)) ok('merge-by-number index skips frozen numbers');
else fail('baseline-dedupe-merge no longer guards its number index — a hash collision could delete a record');
if (isFrozenLoanNumber({ slaDisplayId: 'SLA-20260101-0001' })) fail('a plain stored number reads as frozen');
else ok('a stored Baseline id does not read as frozen');

// ── 6. Derivation is still the shared one ──
console.log('\nDerivation');
const pin = { id: 'l_1787948453094_1sxv', fundingDate: '2026-08-31' };
if (deriveSlaLoanNumber(pin) === 'SLA-20260831-0929') ok('pinned loan still derives SLA-20260831-0929');
else fail('derivation drifted: ' + deriveSlaLoanNumber(pin));

// ── 7. Wired into the write path, ahead of Postgres ──
// The stamp has to happen BEFORE the PG upsert: Postgres is the write
// authority and clients-list-pg serves the Closed Loans board from it, so a
// freeze applied after that call would reach the blob only and the number
// would read back empty — the exact bug 237.158 fixed.
console.log('\nWiring');
const writeSrc = read('deploy/netlify/functions/_shared/client-write.mjs');
const atFreeze = writeSrc.indexOf('freezeClientLoanNumbers(client)');
const atUpsert = writeSrc.indexOf('upsertClientWithLoansStrict');
if (/import \{ freezeClientLoanNumbers \} from '\.\/loan-number\.mjs'/.test(writeSrc) && atFreeze > 0 && atUpsert > 0 && atFreeze < atUpsert) {
  ok('writeClient freezes before the Postgres upsert');
} else fail('writeClient no longer freezes ahead of the PG upsert (freeze@' + atFreeze + ', upsert@' + atUpsert + ')');

const hookSrc = read('deploy/netlify/functions/deploy-succeeded.mjs');
const fnSrc   = read('deploy/netlify/functions/freeze-loan-numbers-background.mjs');
const hookJob = /fn: 'freeze-loan-numbers-background', sig: '([a-z-]+)'/.exec(hookSrc);
const fnSig   = /update\('([a-z-]+)'\)/.exec(fnSrc);
if (hookJob && fnSig && hookJob[1] === fnSig[1]) ok('the one-shot deploy job signs with the name the function checks');
else fail('deploy-succeeded and the backfill disagree on the internal signature: ' + (hookJob && hookJob[1]) + ' vs ' + (fnSig && fnSig[1]));

console.log('');
if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('✓ freeze rules hold');
