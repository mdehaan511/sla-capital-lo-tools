#!/usr/bin/env node
/**
 * scripts/fci-payoff-watch-test.mjs — Deploy 237.179
 *
 * Mike: "is there a way to check and confirm when it is picked up by FCI or that it was
 * successful?"
 *
 * 237.171 reads a demand back seconds after sending it. FCI's tracker can lag, so that
 * answers "did it fail outright" but not "did it land". A demand that is not confirmed on
 * the spot now goes on a waiting list, and three things re-check it: the 4-hourly cron,
 * the loan page (which already has FCI's list in hand), and the immediate read-back.
 *
 * The risk is those three disagreeing — one of them calling a demand confirmed that the
 * others do not. So the matching lives in ONE pure function and this pins it, along with
 * the list's own arithmetic: when to nag, when to give up, and that re-filing the same
 * demand does not put it on the list twice.
 *
 * Run: node scripts/fci-payoff-watch-test.mjs
 */
import { payoffListHasDate } from '../deploy/netlify/functions/_shared/fci-api.mjs';
import {
  watchKey, ageHours, isOverdue, isGivenUp, OVERDUE_HOURS, GIVE_UP_DAYS,
} from '../deploy/netlify/functions/_shared/fci-payoff-watch.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};

// FCI's date formats differ per query (portfolio is MM/DD/YYYY, getPayoffRequests is full
// ISO), which is exactly how a "confirmed" could be missed.
console.log('\nIs the demand in FCI\'s list?');
const rec = (dates, latest) => ({
  requests: dates.map((d) => ({ payoffDate: d })),
  latestRequest: latest ? { payoffDate: latest } : null,
});
check('an ISO payoff date from FCI matches the YYYY-MM-DD we sent',
  payoffListHasDate(rec(['2026-10-15T00:00:00Z']), '2026-10-15'), true);
check('a US-formatted one matches too', payoffListHasDate(rec(['10/15/2026']), '2026-10-15'), true);
check('so does one only on latestRequest', payoffListHasDate(rec([], '2026-10-15'), '2026-10-15'), true);
check('a DIFFERENT date is not a match', payoffListHasDate(rec(['2026-11-15']), '2026-10-15'), false);
check('an empty list is not a match', payoffListHasDate(rec([]), '2026-10-15'), false);
check('no record at all is not a match', payoffListHasDate(null, '2026-10-15'), false);
check('a blank date we sent can never match anything',
  [payoffListHasDate(rec(['2026-10-15']), ''), payoffListHasDate(rec(['2026-10-15']), null)], [false, false]);
check('junk in FCI\'s row does not throw or match',
  payoffListHasDate({ requests: [{ payoffDate: null }, {}, null] }, '2026-10-15'), false);

// One demand = one row, however many times it is filed.
console.log('\nThe waiting list');
const e = { ownerKey: 'lo@x.com', clientId: 'c1', loanId: 'l1', payoffDate: '2026-10-15' };
check('the key is the demand, not the attempt',
  watchKey(Object.assign({}, e, { at: 'T1' })) === watchKey(Object.assign({}, e, { at: 'T2' })), true);
check('a different payoff date is a different demand',
  watchKey(e) === watchKey(Object.assign({}, e, { payoffDate: '2026-11-15' })), false);
check('a different loan is a different demand',
  watchKey(e) === watchKey(Object.assign({}, e, { loanId: 'l2' })), false);

console.log('\nWhen to nag, when to stop');
const now = Date.parse('2026-09-20T12:00:00Z');
const at = (hoursAgo) => ({ at: new Date(now - hoursAgo * 3600000).toISOString() });
check('age is measured in hours from when it was sent', Math.round(ageHours(at(5), now)), 5);
check('a demand sent an hour ago is not overdue yet', isOverdue(at(1), now), false);
check('one past the ' + OVERDUE_HOURS + 'h mark is', isOverdue(at(OVERDUE_HOURS + 1), now), true);
check('...but only ONCE — a nagged demand is not nagged again',
  isOverdue(Object.assign(at(48), { notifiedOverdue: true }), now), false);
check('it keeps being checked for ' + GIVE_UP_DAYS + ' days', isGivenUp(at(GIVE_UP_DAYS * 24 - 1), now), false);
check('...and is dropped after that (by then it is a phone call)',
  isGivenUp(at(GIVE_UP_DAYS * 24 + 1), now), true);
check('an entry with no timestamp is treated as brand new, never as ancient',
  [ageHours({}, now), isGivenUp({}, now)], [0, false]);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
