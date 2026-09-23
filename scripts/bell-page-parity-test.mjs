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
import { readFileSync, readdirSync } from 'node:fs';
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
  /sla-notifications\.js\?v=(2372\d\d|237249)/.test(PAGE),
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

// ── the live alert list is the one Mike asked for ───────────────────────────
// 237.204 made close-date alerts forward-only; 237.206 removed them outright, along
// with the standing "N open conditions" count. What a LIVE alert is for: something
// true right now that someone ends by doing something. A thing that happens at a
// moment is a stored notification instead.
console.log('\nThe live alert list');
const ALERTS = readFileSync(new URL('../deploy/netlify/functions/processing-alerts.mjs', import.meta.url), 'utf8');
const alertKinds = [...new Set((ALERTS.match(/kind: '([a-z_]+)'/g) || []).map((m) => m.slice(7, -1)))].sort();
check('exactly two, and they are the two Mike named', alertKinds, ['stale', 'unassigned']);
assert('no close-date alert survives anywhere in the file',
  !/closing_soon|CLOSING_WINDOW|_daysUntil|_closesPhrase/.test(ALERTS.replace(/^ \*.*$/gm, '')),
  'Mike: "Remove Closing Soon, people know that."');
assert('stale measures the last UPDATE, not time in stage',
  /const lastTouch = l\.updated_at \|\| ex\.processingStageAt/.test(ALERTS),
  'Mike: "if its gone 7+ days without an update"');
check('...at 7 days', (ALERTS.match(/const STALE_DAYS\s+= (\d+)/) || [])[1], '7');
check('unassigned is measured in HOURS, at 24',
  (ALERTS.match(/const UNASSIGNED_HOURS = (\d+)/) || [])[1], '24');
assert('...and is admins only', /if \(manager && !assignee && inPipeline\)/.test(ALERTS));
// The flood guard. Both rules are scoped to loans IN the pipeline: an untouched lead is
// not a stalled loan, and it is not unassigned -- it is a lead. This is the check that
// would have caught 237.204's 403-day-old rows before Mike saw them.
assert('BOTH rules are scoped to loans in the pipeline, never leads',
  (ALERTS.match(/inPipeline/g) || []).length >= 3 &&
  /const ACTIVE_STAGES\s+= \['new_loan', 'processing', 'underwriting', 'pp_approved'\]/.test(ALERTS),
  'an empty processing_stage means Leads -- alerting on those is the flood');
// Deploy 237.208 -- RUN the date helpers instead of only reading them. `now` in this
// handler is Date.now(), a number; _hoursSince treated it as a Date and threw on the
// first unassigned loan it found, with node --check and every source assertion above
// passing. Lifting and executing is the only check that sees that class of mistake.
{
  const lift = (name) => {
    const m = ALERTS.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'));
    assert('  ' + name + ' can be lifted', !!m, 'renamed or removed');
    return m ? new Function('"use strict";' + m[0] + ' return ' + name + ';')() : () => null;
  };
  const NOW = Date.now();                       // EXACTLY what the handler passes
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const _hoursSince = lift('_hoursSince');
  const _daysSince = lift('_daysSince');
  const _fmtDays = lift('_fmtDays');
  const _fmtHours = new Function('"use strict";' +
    (ALERTS.match(/function _fmtDays\([\s\S]*?\n}/) || [''])[0] +
    (ALERTS.match(/function _fmtHours\([\s\S]*?\n}/) || [''])[0] + ' return _fmtHours;')();
  check('26 hours ago is 26 hours', _hoursSince(ago(26 * 3600000), NOW), 26);
  check('...and clears the 24-hour bar', _hoursSince(ago(26 * 3600000), NOW) >= 24, true);
  check('23 hours ago does NOT', _hoursSince(ago(23 * 3600000), NOW) >= 24, false);
  check('9 days ago is 9 days', _daysSince(ago(9 * 86400000), NOW), 9);
  check('nothing to measure from is null, not zero',
    [_hoursSince('', NOW), _hoursSince('not a date', NOW), _daysSince(null, NOW)], [null, null, null]);
  check('hours read as hours until two days, then as days',
    [_fmtHours(1), _fmtHours(26), _fmtHours(72)], ['1 hour', '26 hours', '3 days']);
  check('and a day is a day', [_fmtDays(0), _fmtDays(1), _fmtDays(9)], ['today', '1 day', '9 days']);
}

assert('the bell draws the two kinds that exist',
  /a\.kind === 'stale'/.test(BELL_SRC) && /a\.kind === 'unassigned'/.test(BELL_SRC));
assert('...and names no kind that does not',
  !/'closing_soon'|'aging'|'conditions'|'unassigned_closing'/.test(BELL_SRC));

console.log('\nBack button');
assert('the clicked row is painted read before leaving', /function openOne\([\s\S]*?nrow_[\s\S]*?Mark unread/.test(PAGE));
assert('...and the list is re-read when the page comes back from the bfcache',
  /addEventListener\('pageshow'[\s\S]*?e\.persisted[\s\S]*?load\(\)/.test(PAGE));

// ── the header re-renders under the bell (Deploy 237.249) ────────────────
// sla-nav paints the header on identity init / login / logout with host.innerHTML = ...,
// which drops the bell it hosts. The next poll rendered into nothing and threw
// "Cannot read properties of null (reading 'classList')" (Slack, 7:48 AM, Jeremy's loan).
// Run the real file against a header that exists, wipe it, and render again.
console.log('\nThe header re-renders under the bell');
{
  const noop = () => {};
  const listeners = {};
  const mkEl = (id) => {
    const e = { id, style: {}, _classes: [], textContent: '', _inner: '', _listeners: [],
      classList: { add(c) { e._classes.push(c); }, remove(c) { e._classes = e._classes.filter((x) => x !== c); }, contains(c) { return e._classes.indexOf(c) >= 0; } },
      addEventListener(t, fn) { e._listeners.push(t); },
      querySelector: () => null, querySelectorAll: () => [], appendChild: noop, setAttribute: noop, getAttribute: () => '', contains: () => false };
    Object.defineProperty(e, 'innerHTML', {
      get() { return e._inner; },
      set(v) { e._inner = String(v); (String(v).match(/id="([^"]+)"/g) || []).forEach((m) => { const cid = m.slice(4, -1); if (!reg[cid]) reg[cid] = mkEl(cid); }); },
    });
    return e;
  };
  let reg = {};
  let navRight = null;
  const doc = {
    readyState: 'complete', hidden: false, visibilityState: 'visible',
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    querySelector: (sel) => (sel === '.nav-right' ? navRight : null), querySelectorAll: () => [],
    getElementById: (id) => reg[id] || null,
    createElement: (tag) => mkEl(''),
    head: mkEl('head'), body: mkEl('body'),
  };
  const w = {
    SLA: { urls: { loanDetails: (id) => '/loan-details/' + id } },
    setTimeout: noop, setInterval: noop, clearInterval: noop, addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { pathname: '/loan-details.html', search: '' }, console,
  };
  w.window = w; w.document = doc;
  // a header exists from the start
  let inserts = 0;
  navRight = mkEl('nav-right'); navRight.insertBefore = (wrap) => { inserts++; reg.slaNotifWrap = wrap; };
  vm.createContext(w);
  new vm.Script(BELL_SRC, { filename: 'sla-notifications.js' }).runInContext(w);
  const B = w.SLANotify;
  assert('the bell mounts into the header at boot, with its button wired', !!reg.slaNotifWrap && !!reg.slaNotifBtn && reg.slaNotifBtn._listeners.indexOf('click') >= 0);
  assert('...the document-level listeners are bound once', (listeners.click || []).length === 1 && (listeners.visibilitychange || []).length === 1);
  const F = { mentions: [], loanAppEvents: [], procAlerts: [], dueTasks: [], due: [{ id: 'r1', title: 'Call', date: '2026-09-23' }], future: [], mailN: 0 };
  let threw = null;
  try { B._render(F); } catch (e) { threw = e.message; }
  assert('a normal render paints the badge', threw === null && reg.slaNotifBtn._classes.indexOf('has-due') >= 0, threw);
  B._mount();
  assert('mount() while the bell is already there adds nothing (one bell, ever)', inserts === 1, 'inserts=' + inserts);
  // the header re-renders: everything the bell put there is gone
  reg = {};
  threw = null;
  try { B._render(F); } catch (e) { threw = e.message; }
  assert('after the header re-rendered, render does not throw', threw === null, threw);
  assert('...the bell is back in the new header, button wired again, badge painted', !!reg.slaNotifWrap && !!reg.slaNotifBtn && reg.slaNotifBtn._listeners.indexOf('click') >= 0 && reg.slaNotifBtn._classes.indexOf('has-due') >= 0);
  assert('...without binding the document listeners a second time', (listeners.click || []).length === 1 && (listeners.visibilitychange || []).length === 1);
  assert('...and exactly one new bell was inserted', inserts === 2, 'inserts=' + inserts);
  // no header at all (signed out, a page without one): nothing to paint, nothing to throw
  reg = {}; navRight = null; threw = null;
  try { B._render(F); } catch (e) { threw = e.message; }
  assert('with no header on the page, render stays quiet', threw === null && !reg.slaNotifBtn, threw);
  assert('every page pins the bell to this deploy or newer', (() => {
    const dir = new URL('../deploy/', import.meta.url);
    const bad = readdirSync(dir).filter((f) => /\.html$/.test(f)).filter((f) => {
      const t = readFileSync(new URL(f, dir), 'utf8');
      const m = /sla-notifications\.js\?v=(\d+|237249)/.exec(t);
      if (!t.includes('sla-notifications.js')) return false;
      return !m || (m[1] !== '237249' && parseInt(m[1], 10) < 237249);
    });
    return bad.length === 0;
  })());
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
