#!/usr/bin/env node
/**
 * scripts/bell-coverage-test.mjs — Deploy 237.198
 *
 * Mike: "I cant seem to see a bell for testing. Does my profile not have one?"
 *
 * It was not his profile. The bell was missing from 20 staff pages including
 * sla-dashboard.html, the page everyone lands on — so the notifications work shipped the
 * day before was unreachable from the place people start.
 *
 * It went unnoticed because nothing failed. `inject()` returned silently when .nav-right
 * was not in the DOM yet, and nothing anywhere said a bell had not mounted. That is a
 * gap a gate can hold shut cheaply: a page with the shared nav and no bell script is now
 * a test failure rather than something a person has to notice.
 *
 * Run: node scripts/bell-coverage-test.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = join(root, 'deploy');

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + String(why).slice(0, 400) : ''));
};

const pages = readdirSync(deploy).filter((f) => f.endsWith('.html'));
const read = (f) => readFileSync(join(deploy, f), 'utf8');

console.log('\nEvery staff page has the bell');
// The shared nav is what makes a page a staff page — borrower and public pages have no
// nav and must NOT get one (see feedback_one_nav_everywhere).
const withNav = pages.filter((f) => read(f).includes('sla-nav.js'));
assert('there are staff pages to check', withNav.length > 20, String(withNav.length));
const noBell = withNav.filter((f) => !read(f).includes('sla-notifications.js'));
check('none of them is missing sla-notifications.js', noBell, []);

console.log('\n...and the landing page especially');
const dash = read('sla-dashboard.html');
assert('sla-dashboard.html has the bell — it is where people start',
  dash.includes('sla-notifications.js'));
assert('...and it loads AFTER the nav that it mounts into',
  dash.indexOf('sla-nav.js') < dash.indexOf('sla-notifications.js'));

console.log('\nOrdering holds wherever defer is used');
// Deferred scripts run in document order, so a deferred nav needs a deferred bell;
// mixing them puts the bell first and it would find no nav to mount into.
const mixed = withNav.filter((f) => {
  const h = read(f);
  const nav = /<script[^>]*sla-nav\.js[^>]*>/.exec(h);
  const bell = /<script[^>]*sla-notifications\.js[^>]*>/.exec(h);
  if (!nav || !bell) return false;
  return /\bdefer\b/.test(nav[0]) !== /\bdefer\b/.test(bell[0]);
});
check('no page defers one of the pair but not the other', mixed, []);

console.log('\nThe bell waits for its nav rather than giving up');
const bellSrc = read('sla-notifications.js');
assert('inject() retries instead of returning on a missing .nav-right',
  /_injectTries/.test(bellSrc) && /setTimeout\(inject/.test(bellSrc),
  'inject() still gives up the first time it does not find the nav');
assert('...but does give up eventually, so a nav-less page costs nothing',
  /_injectTries\+\+ > \d+/.test(bellSrc));

console.log('\nThe bell never deletes a notification');
// 237.197 made notifications a history; anything in the bell that still calls the
// delete endpoint empties the record the notifications page exists to show.
assert('no call to notifications-dismiss survives in the bell',
  !bellSrc.includes('notifications-dismiss'),
  'the bell still deletes somewhere — it should mark read');
assert('it marks read instead', bellSrc.includes('notifications-read'));
assert('and it asks for unread only, or read items pile back in',
  bellSrc.includes('notifications-list?unread=1'));

console.log('\nThe way through to the history');
assert('"See all notifications" is in the drop-down', bellSrc.includes('sla-notif-seeall'));
assert('...and the page it points at exists', pages.includes('notifications.html'));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
