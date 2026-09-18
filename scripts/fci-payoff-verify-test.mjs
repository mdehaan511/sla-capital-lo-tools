#!/usr/bin/env node
/**
 * scripts/fci-payoff-verify-test.mjs — Deploy 237.170
 *
 * Mike ordered a payoff on 6401 S Pine St. I told him it had gone through. He checked the
 * FCI portal and it had not.
 *
 * My reasoning was "fciQuery throws on any GraphQL error and nothing threw". That is not
 * a receipt. fciQuery throws on a network failure, a timeout, a non-2xx or a GraphQL
 * `errors` array — it does NOT throw on HTTP 200 + {"data":{"insertPayoff":false}}, and
 * nothing in the endpoint ever read the return value. Any clean response was recorded as
 * a filed demand and reported to the LO as success.
 *
 * These checks pin the two rules that replace that inference:
 *   1. An answer that plainly is not a success — false / 0 / null / '' — is a FAILURE.
 *   2. Everything else is UNKNOWN until FCI's own records show the demand, and a
 *      read-back that fails must never come back "confirmed".
 *
 * Run: node scripts/fci-payoff-verify-test.mjs
 */
import { insertPayoffVerdict, fciConfirmPayoffFiled } from '../deploy/netlify/functions/_shared/fci-api.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};

console.log('\nReading the mutation\'s answer');
check('false is a refusal, not a filing', insertPayoffVerdict({ insertPayoff: false }), 'no');
check('0 is a refusal', insertPayoffVerdict({ insertPayoff: 0 }), 'no');
check('null is a refusal', insertPayoffVerdict({ insertPayoff: null }), 'no');
check('an empty string is a refusal', insertPayoffVerdict({ insertPayoff: '' }), 'no');
check('"false" as text is a refusal too (the type is undocumented)',
  ['false', 'FALSE', ' 0 ', 'error', 'failed'].map((v) => insertPayoffVerdict({ insertPayoff: v })),
  ['no', 'no', 'no', 'no', 'no']);

check('true is NOT taken as proof — only as "not obviously a refusal"',
  insertPayoffVerdict({ insertPayoff: true }), 'unknown');
check('an id or a number is unknown', [insertPayoffVerdict({ insertPayoff: 12345 }), insertPayoffVerdict({ insertPayoff: 'PO-1' })],
  ['unknown', 'unknown']);
check('an object is unknown', insertPayoffVerdict({ insertPayoff: { __typename: 'Payoff' } }), 'unknown');
check('a response with no insertPayoff key at all is unknown, not a refusal',
  [insertPayoffVerdict({}), insertPayoffVerdict(null)], ['unknown', 'unknown']);

// This is the distinction that matters: 'unknown' does NOT mean filed. It means the
// caller has to go and confirm it, which is exactly what the endpoint now does.
console.log('\nThe read-back never invents a confirmation');
const saved = process.env.FCI_API_TOKEN;
delete process.env.FCI_API_TOKEN;      // force fciQuery to throw
const r = await fciConfirmPayoffFiled('399653858', '2026-10-15');
if (saved !== undefined) process.env.FCI_API_TOKEN = saved;
check('a read-back that cannot run reports NOT confirmed', r.confirmed, false);
check('...and says it never actually checked, so the page can say "unknown"', r.checked, false);
check('...with a reason worth reading', /read-back failed/.test(r.reason || ''), true);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
