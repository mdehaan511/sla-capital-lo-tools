#!/usr/bin/env node
/**
 * scripts/bell-page-parity-test.mjs — Deploy 237.202
 *
 * Mike: "My notifications are saying 9+ but when I go to the page its only showing 5."
 *
 * Both numbers were honest and they described different things. The badge counts six
 * feeds — mail waiting, processing alerts, due tasks, loan apps received, reminders due,
 * and unread stored notifications. /notifications.html only ever knew about the last one,
 * because it read the notifications store directly and the other five live nowhere but
 * inside the bell. Two surfaces, two sets of arithmetic, no way to notice they disagreed.
 *
 * So the arithmetic is now ONE exported function and this file guards the identity that
 * makes the page's total equal the bell's:
 *
 *     sum(openRows(f).weight) + f.mentions.length === openCount(f)
 *
 * The weight matters. Thirty-three envelopes are one row in both surfaces and thirty-three
 * on the badge, so a gate that just counted rows would "pass" while the page said 5 and the
 * bell said 9+ — which is the exact bug, spelled differently.
 *
 * sla-notifications.js is a browser IIFE with no exports, so the whole real file runs here
 * against a stub DOM and we read what it hung on window. That also proves the export
 * survives — a helper nothing can reach is the same as no helper.
 *
 * Run: node scripts/bell-page-parity-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};

// ── run the real bell against a stub browser ────────────────────────────────
const BELL_SRC = readFileSync(new URL('../deploy/sla-notifications.js', import.meta.url), 'utf8');
const noop = () => {};
const el = { style: {}, classList: { add: noop, remove: noop }, addEventListener: noop,
             querySelector: () => null, querySelectorAll: () => [], appendChild: noop,
             insertBefore: noop, setAttribute: noop, getAttribute: () => '', textContent: '' };
const win = {
  SLA: { urls: { loanDetails: (id, o) => '/loan-details/' + id + (o && o.owner ? '?owner=' + o.owner : '') } },
  setTimeout: noop, setInterval: noop, clearInterval: noop, addEventListener: noop,
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  location: { pathname: '/notifications.html', search: '' },
  console,
};
win.window = win;
win.document = {
  readyState: 'complete', hidden: false, addEventListener: noop,
  // No .nav-right: inject() bows out (after scheduling a retry into our no-op
  // setTimeout) without touching the DOM, which is all we want from it here.
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  createElement: () => Object.assign({}, el), head: Object.assign({}, el), body: Object.assign({}, el),
};
vm.createContext(win);
new vm.Script(BELL_SRC, { filename: 'sla-notifications.js' }).runInContext(win);

console.log('\nThe export exists at all');
const N = win.SLANotify;
assert('window.SLANotify is published', !!N, 'the IIFE ran but hung nothing on window');
['feeds', 'openRows', 'openCount', 'subscribe', 'categoryOf'].forEach((k) =>
  assert('  .' + k + '()', N && typeof N[k] === 'function'));
assert('  .categories[]', Array.isArray(N && N.categories) && N.categories.length >= 5);

// ── fixtures ────────────────────────────────────────────────────────────────
const feeds = (over) => Object.assign({
  due: [], future: [], loanAppEvents: [], procAlerts: [], dueTasks: [],
  mail: null, mailN: 0, mentions: [],
}, over || {});

/** The identity the whole fix rests on. */
const parity = (f) => N.openRows(f).reduce((n, r) => n + (r.weight || 1), 0) + (f.mentions || []).length;

console.log('\nThe page adds up to the bell');
// Mike's actual bell on 2026-09-20: 33 unsorted mail, a stack of processing alerts and
// 5 unread servicing notifications. The page showed 5 of those 40.
const MIKE = feeds({
  mailN: 33, mail: { unsorted: 33, overdue: 33, oldestHours: 400 },
  procAlerts: [{ id: 'p1', loanId: 'l1', title: '1907 S Rainier St', subtitle: 'Unassigned' },
               { id: 'p2', loanId: 'l2', title: '49100 Fuller Rd', subtitle: 'Unassigned' }],
  mentions: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }, { id: 'n5' }],
});
check('the bell counts 40 where the page used to say 5', N.openCount(MIKE), 40);
check('...and the page now reaches the same 40', parity(MIKE), 40);
check('33 envelopes are ONE row', N.openRows(MIKE).filter((r) => r.kind === 'mail').length, 1);
check('...carrying all 33 in its weight', N.openRows(MIKE).find((r) => r.kind === 'mail').weight, 33);

const EVERYTHING = feeds({
  mailN: 4, mail: { unsorted: 4, overdue: 1 },
  procAlerts: [{ id: 'p1', loanId: 'l1', title: 'Closing soon', subtitle: 'Friday', owner: 'lo@x.com' }],
  dueTasks: [{ id: 't1', title: 'Call the borrower', dueDate: '2026-09-20', loanId: 'l2', ownerKey: 'lo@x.com' }],
  loanAppEvents: [{ id: 'la_q1', title: 'Jane Doe', subtitle: '1 Main St', dateIso: '2026-09-19T10:00:00Z' }],
  due: [{ id: 'r1', borrower: 'Ed Weaver', address: '4723 N Eva Rd', dueDate: '2026-09-20', note: 'call' }],
  mentions: [{ id: 'n1' }, { id: 'n2' }],
});
check('every feed at once still balances', [N.openCount(EVERYTHING), parity(EVERYTHING)], [10, 10]);
check('one row per live item, mail aside', N.openRows(EVERYTHING).map((r) => r.kind),
  ['mail', 'processing', 'task', 'loan_app_received', 'reminder']);

console.log('\nNothing is shown twice, and nothing is shown that cannot be acted on');
// Mentions are stored notifications; the history list already prints them. If they were
// in openRows too, every unread notification would appear twice on one screen.
check('mentions are NOT in the live rows', N.openRows(feeds({ mentions: [{ id: 'n1' }] })), []);
check('...though they still count toward the bell', N.openCount(feeds({ mentions: [{ id: 'n1' }] })), 1);
check('upcoming reminders are not "open now"', N.openCount(feeds({ future: [{ id: 'r9' }] })), 0);

console.log('\nEvery live row can be clicked through');
N.openRows(EVERYTHING).forEach((r) => {
  assert('  ' + r.kind + ' has a link and a title', !!r.href && !!r.title, JSON.stringify(r));
});
check('a processing alert keeps its owner scope',
  N.openRows(EVERYTHING).find((r) => r.kind === 'processing').href, '/loan-details/l1?owner=lo@x.com');

console.log('\nQuiet day, and bad day');
check('nothing outstanding is zero, not an empty-looking one', [N.openCount(feeds()), N.openRows(feeds()).length], [0, 0]);
check('no feeds at all (a failed fetch) does not throw', [N.openCount(null), N.openRows(null)], [0, []]);

// ── the page actually uses it ───────────────────────────────────────────────
// The helpers being right is what 237.167 taught me not to mistake for the feature
// working; see feedback_verify_the_data_path.
console.log('\nThe page is wired to it');
const PAGE = readFileSync(new URL('../deploy/notifications.html', import.meta.url), 'utf8');
// 237.203: the page subscribes rather than fetching. Fetching for itself is what broke
// it — that ran before resolveRole() knew the caller is a processor, so mail and
// processing alerts were missing from the very section added to show them.
assert('notifications.html rides the bell\'s refresh', /SLANotify\.subscribe\(/.test(PAGE));
assert('...and does NOT fetch the feeds on its own clock',
  !/SLANotify\.feeds\(\)/.test(PAGE),
  'a boot-time fetch races resolveRole() and under-reports');
assert('...renders the live rows', /SLANotify\.openRows\(/.test(PAGE));
assert('...and takes the NUMBER from openCount, not from the row count',
  /SLANotify\.openCount\(/.test(PAGE) && !/openRows\([^)]*\)\.length\s*;/.test(PAGE),
  'counting rows would say 1 where the bell says 33');
assert('...and version-pins the script it needs SLANotify from',
  /sla-notifications\.js\?v=2372\d\d/.test(PAGE),
  'a cached copy of the old file has no SLANotify (feedback_guard_the_function)');

const BELL = BELL_SRC;
assert('the badge is drawn from the same openCount', /var alertCount = openCount\(f\);/.test(BELL));
assert('collect() returns the feeds rather than rendering them', /function collect\(\)/.test(BELL) && /window\.SLANotify = \{/.test(BELL));
assert('refresh() still exists for every caller that polls it', /function refresh\(\) \{\s*return collect\(\)/.test(BELL));

// ── the back button ─────────────────────────────────────────────────────────
// Mike: "if I click into one and return with the back button ... show it as now being
// read". A bfcached page runs no script on return, so the row has to be painted read
// before the navigation AND the list re-read on pageshow.
// ── categories ──────────────────────────────────────────────────────────────
// Mike: "Documents Uploaded. Loan Updates. Mail. Payments."
console.log('\nCategories');
check('Mike\'s four, in his order, then a home for anything unmapped',
  N.categories, ['Documents Uploaded', 'Loan Updates', 'Mail', 'Payments', 'Other']);
[['borrower_upload', 'Documents Uploaded'], ['full_file', 'Documents Uploaded'],
 ['mention', 'Loan Updates'], ['deed', 'Loan Updates'], ['processing', 'Loan Updates'],
 ['task', 'Loan Updates'], ['loan_app_received', 'Loan Updates'], ['reminder', 'Loan Updates'],
 ['mail', 'Mail'],
 ['servicing', 'Payments'], ['payoff_confirmed', 'Payments'], ['payoff_unconfirmed', 'Payments'],
].forEach(([kind, want]) => check('  ' + kind, N.categoryOf(kind), want));
check('a kind nobody has taught us still lands somewhere', N.categoryOf('whatever_is_next'), 'Other');
check('...and so does a missing one', N.categoryOf(undefined), 'Other');
// Every kind THIS FILE mints must have a real home: an "Other" bucket in the live list
// would be our own doing, not an unknown notification from somewhere else.
{
  const minted = [...new Set(N.openRows(EVERYTHING).map((r) => r.kind))];
  minted.forEach((k) => assert('  openRows mints ' + k + ' into a named category',
    N.categoryOf(k) !== 'Other', k + ' falls through to Other'));
}

// ── the subscription contract ───────────────────────────────────────────────
console.log('\nSubscribers see what the badge saw');
{
  const seen = [];
  const off = N.subscribe((f) => seen.push(f));
  assert('subscribe() returns an unsubscribe', typeof off === 'function');
  assert('a subscriber added before any refresh waits rather than firing with nothing', seen.length === 0);
  assert('a non-function is ignored, not pushed', typeof N.subscribe(null) === 'function');
  off();
}
assert('the bell notifies AFTER render, so the two agree at every instant',
  /render\(f\);[\s\S]{0,400}_feedSubs\.forEach/.test(BELL_SRC),
  'notifying first would show the page a total the badge has not drawn yet');
assert('a late subscriber is replayed the last pass instead of waiting a minute',
  /if \(_lastFeeds\) \{ try \{ fn\(_lastFeeds\); \}/.test(BELL_SRC));
assert('a throwing subscriber cannot break the bell',
  /_feedSubs\.forEach\(function\(fn\) \{ try \{ fn\(f\); \} catch/.test(BELL_SRC));

console.log('\nThe page groups and filters by category');
assert('both lists are grouped through one helper', /function groupedHtml\(/.test(PAGE));
assert('  the history list is grouped', /list\.innerHTML = groupedHtml\(/.test(PAGE));
assert('  the live list is grouped', /liveList'\)\.innerHTML =\s*\n?\s*groupedHtml\(/.test(PAGE));
assert('the filter is by category, built from what this person actually has',
  /function buildCategoryFilter\(/.test(PAGE) && /id="fCat"/.test(PAGE));
assert('...and nothing still refers to the old type filter', !/fType/.test(PAGE));
assert('categories come from the bell, not a second copy on the page',
  /SLANotify\.categoryOf/.test(PAGE) && !/KIND_CATEGORY/.test(PAGE),
  'two maps would group the two halves of the same page differently');

console.log('\nThe subtitle says what is true');
// Inside a STRING literal, not anywhere in the file -- the comment above the new
// subtitle quotes the old one on purpose, and that record is worth keeping.
assert('it no longer explains the bell to the reader',
  !/['\"][^'\"\n]*the bell shows/.test(PAGE),
  'Mike: "The subtext at the stop of 2 unread of 5 is still misleading"');
assert('...and no longer reads "N unread of M"', !/unread of ' \+/.test(PAGE));
assert('an empty account gets a sentence, not three zeroes',
  /Nothing needs your attention right now/.test(PAGE));

// ── no alert for a close date that has already passed ───────────────────────
// Mike: "Thres also a ton of notifications of close dates past that never got out of
// leads ... we shouldnt have a close date past notification at all."
console.log('\nNo close-date-past alerts');
const ALERTS = readFileSync(new URL('../deploy/netlify/functions/processing-alerts.mjs', import.meta.url), 'utf8');
check('both close-date windows are forward-only',
  (ALERTS.match(/du != null && du >= 0 && du <= CLOSING_WINDOW_DAYS/g) || []).length, 2);
assert('no window still admits a negative day count',
  !/du != null && du <= CLOSING_WINDOW_DAYS/.test(ALERTS));
assert('the "passed N ago" wording is gone with it', !/passed ' \+ _fmtDays/.test(ALERTS));
assert('and the module header no longer promises it',
  !/already\s*\n \*\s*past and the loan hasn/.test(ALERTS));
assert('forward-looking alerts survive -- this was a noise fix, not a feature removal',
  /kind: 'closing_soon'/.test(ALERTS) && /kind: 'unassigned_closing'/.test(ALERTS) &&
  /_closesPhrase\(du\)/.test(ALERTS));
// 237.205: _fmtDays(0) is the word "today", so "closes in " + _fmtDays(du) said "closes
// in today". Only visible once the past-date branch stopped drowning it out.
assert('no alert phrases a close date for itself -- they all go through _closesPhrase',
  !/subtitle:[^\n]*_fmtDays/.test(ALERTS),
  'building "closes in " + _fmtDays(du) at the call site skips the today/tomorrow guard');
assert('...the nearest two days are phrased, not counted',
  /return 'closes today'/.test(ALERTS) && /return 'closes tomorrow'/.test(ALERTS));

console.log('\nBack button');
assert('the clicked row is painted read before leaving', /function openOne\([\s\S]*?nrow_[\s\S]*?Mark unread/.test(PAGE));
assert('...and the list is re-read when the page comes back from the bfcache',
  /addEventListener\('pageshow'[\s\S]*?e\.persisted[\s\S]*?load\(\)/.test(PAGE));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
