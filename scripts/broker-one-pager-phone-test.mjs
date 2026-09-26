/**
 * broker-one-pager-phone-test.mjs — Deploy 237.284 (issue #6)
 *
 * Sara: "the broker pdf is not personalizing the phone number". The endpoint
 * read only the top-level profile.phone; for reps whose phone lives in
 * profile.user_metadata.phone (the identity-login mirror, and every record
 * saved before 236.578 promoted it) the footer printed the company line.
 *
 *   node scripts/broker-one-pager-phone-test.mjs
 */
import { readFileSync } from 'node:fs';

let fails = 0;
function check(name, ok) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fails++;
}

const src = readFileSync('deploy/netlify/functions/broker-one-pager.mjs', 'utf8');

console.log('broker-one-pager: the rep phone comes from wherever the record has it');
check('the footer phone goes through repPhone(profile, user)', /phone: repPhone\(profile, user\),/.test(src));
check('no bare top-level-only read is left', !/profile && profile\.phone\)/.test(src));
check('the profile read is strong', /getStore\(\{ name: 'profiles', consistency: 'strong' \}\)/.test(src));

// Exercise the helper itself, lifted out of the endpoint (its imports need
// node_modules; the helper does not).
const m = src.match(/function repPhone\(profile, user\) \{[\s\S]*?\n\}/);
check('repPhone is defined', !!m);
const repPhone = m ? new Function(m[0] + '\nreturn repPhone;')() : () => '';

check('top-level phone', repPhone({ phone: '4065707339' }, {}) === '4065707339');
check('user_metadata phone only (the reported case)', repPhone({ user_metadata: { phone: '(509) 555-0100' } }, {}) === '(509) 555-0100');
check('top-level wins over user_metadata', repPhone({ phone: '1', user_metadata: { phone: '2' } }, {}) === '1');
check('token phone when the profile has none', repPhone({ user_metadata: {} }, { user_metadata: { phone: '509-555-0199' } }) === '509-555-0199');
check('no profile at all falls back to the token', repPhone(null, { user_metadata: { phone: '5095550100' } }) === '5095550100');
check('nothing anywhere -> blank (builder then uses the company line)', repPhone(null, null) === '');
check('whitespace is trimmed', repPhone({ phone: '  5095550100 ' }, {}) === '5095550100');

if (fails) { console.log('\n' + fails + ' failing'); process.exit(1); }
console.log('\nall passing');
