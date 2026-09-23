#!/usr/bin/env node
/**
 * scripts/mail-mailbox-label-test.mjs — Deploy 237.257 (Mike)
 *
 * "For our stable integration we added another address there at 2261 Market Street STE
 * 94354. We need to make sure that one is syncing as well ... and will wind down the
 * current seattle address."
 *
 * The sync pulls every location on the Stable account (listMailItems is called with no
 * locationId), so the new box syncs by construction; this guards that nothing narrows it,
 * and that a person can SEE which box a piece came to while both are live.
 *
 * Run: node scripts/mail-mailbox-label-test.mjs
 */
import { readFileSync } from 'node:fs';
import { mailboxOf, slimItem } from '../deploy/netlify/functions/_shared/mail-store.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const read = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');

console.log('\nThe label, from the address Stable puts on each piece');
check('the new box', mailboxOf({ locationAddress: '2261 Market Street, #94354, San Francisco, CA, 94114' }), 'San Francisco');
check('the box being wound down', mailboxOf({ locationAddress: '1522 Western Ave, #30395, Seattle, WA, 98101' }), 'Seattle');
check('the Spokane box', mailboxOf({ locationAddress: '100 N Howard St STE R, Spokane, WA, 99201' }), 'Spokane');
check('an unknown box falls back to its city', mailboxOf({ locationAddress: '1 Main St, Suite 2, Boise, ID, 83702' }), 'Boise');
check('no address: no label', [mailboxOf({}), mailboxOf(null), mailboxOf({ locationAddress: '' })], ['', '', '']);
const slim = slimItem({ id: 'x', locationAddress: '2261 Market Street, #94354, San Francisco, CA, 94114', receivedAt: '2026-09-23T17:00:00Z' });
check('every list row carries the label and the full line', [slim.mailbox, slim.mailboxAddress], ['San Francisco', '2261 Market Street, #94354, San Francisco, CA, 94114']);

console.log('\nThe sync covers every box');
const sync = read('netlify/functions/mail-sync.mjs');
const calls = sync.match(/listMailItems\(\{[^}]*\}\)/g) || [];
assert('listMailItems is called with no locationId filter (' + calls.length + ' call sites)', calls.length >= 2 && calls.every((c) => !/locationId/.test(c)), calls.join(' | '));
assert('each piece records the box it arrived at', /locationId: loc\.id \|\| '',\s*\n\s*locationAddress: \[la\.line1, la\.line2, la\.city, la\.state, la\.postalCode\]/.test(sync));

console.log('\nAnd the portal says which box');
const html = read('mail.html');
assert('the Mail page list row shows the box', /i\.mailbox \? ' · ' \+ esc\(i\.mailbox\)/.test(html));
assert('the detail pane shows the full address', /i\.mailboxAddress \? ' at ' \+ esc\(i\.mailboxAddress\)/.test(html));
const api = read('netlify/functions/mail.mjs');
assert('the detail endpoint sends it', /mailbox: mailboxOf\(item\), mailboxAddress: item\.locationAddress/.test(api) && /mailboxOf,/.test(api));
const cron = read('netlify/functions/mail-alert-cron.mjs');
assert('the new-mail email names the box beside the recipient', /mailboxOf\(i\) \? ' <span style="color:#777">\(' \+ esc\(mailboxOf\(i\)\)/.test(cron) && /mailboxOf \} from '\.\/_shared\/mail-store\.mjs'/.test(cron));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
