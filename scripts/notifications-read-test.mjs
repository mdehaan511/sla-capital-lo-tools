#!/usr/bin/env node
/**
 * scripts/notifications-read-test.mjs — Deploy 237.197
 *
 * Mike: "a profile based notifications page ... shows all historical notifications, both
 * unread and read ... if they click one of the notifications it goes to whatever that
 * notification is and marks it as read. They can also mark notifications as unread or
 * mark all notifications as read ... filter by date and type."
 *
 * The change underneath is the risky one: the bell's tick used to DELETE a notification
 * and now MARKS IT READ. Get that wrong in the other direction — a mark that quietly
 * drops items, or a read state that does not stick — and the history Mike asked for is
 * missing the things people actually dealt with, which are the ones worth looking up.
 *
 * markUserNotifications talks to a blob store, so the store is faked here; everything
 * else is the real function.
 *
 * Run: node scripts/notifications-read-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── the real module, with @netlify/blobs swapped for a doc we can inspect ──
const src = readFileSync(new URL('../deploy/netlify/functions/_shared/user-notifications.mjs', import.meta.url), 'utf8')
  .replace(/^import .*@netlify\/blobs.*$/m, '')
  .replace(/^import \{ keySafe, normalizeEmail \}.*$/m, '')
  .replace(/\bexport (async function|function|const)/g, '$1');

let DOC = null;
const fakeStore = {
  get: async () => (DOC ? JSON.parse(JSON.stringify(DOC)) : null),
  setJSON: async (_k, v) => { DOC = JSON.parse(JSON.stringify(v)); },
};
const ctx = {
  console, Date, Math, JSON, Array, Set, String, Number,
  getStore: () => fakeStore,
  keySafe: (s) => String(s || '').replace(/[^a-z0-9_-]/gi, '_'),
  normalizeEmail: (s) => String(s || '').trim().toLowerCase(),
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const call = (fn, ...args) => vm.runInContext(fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')', ctx);

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + String(why).slice(0, 220) : ''));
};

const ME = 'beth@slacapital.com';
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
function seed() {
  DOC = { email: ME, items: [
    { id: 'n1', kind: 'borrower_upload', createdAt: iso(0), title: 'Nehemias uploaded PFS' },
    { id: 'n2', kind: 'mention',         createdAt: iso(2), snippet: 'take a look' },
    { id: 'n3', kind: 'full_file',       createdAt: iso(9), title: 'Full file ready' },
  ] };
}

// `const` inside the vm does not become a context property, so read the two retention
// numbers off the source. They are the difference between a history and a bell's memory.
console.log('\nRetention — a record, not a bell\'s memory');
const constOf = (name) => {
  const m = new RegExp('const ' + name + '\\s*=\\s*([0-9*\\s]+);').exec(src);
  return m ? Function('return (' + m[1] + ')')() : null;
};
assert('kept long enough to be called history (180 days)',
  constOf('MAX_AGE_MS') === 180 * 86400000, String(constOf('MAX_AGE_MS')));
assert('and deep enough (400 items)', constOf('MAX_ITEMS') === 400, String(constOf('MAX_ITEMS')));

console.log('\nReading and un-reading');
seed();
check('everything starts unread', (await call('listUserNotifications', ME, { unreadOnly: true })).length, 3);
check('marking one read changes exactly one', await call('markUserNotifications', ME, { ids: ['n2'] }), { changed: 1, unread: 2 });
assert('IT IS STILL THERE — read, not deleted', (await call('listUserNotifications', ME)).length === 3);
check('...and the bell no longer shows it',
  (await call('listUserNotifications', ME, { unreadOnly: true })).map((n) => n.id), ['n1', 'n3']);
check('marking the same one again is a no-op, not a second write',
  await call('markUserNotifications', ME, { ids: ['n2'] }), { changed: 0, unread: 2 });

check('marking it UNREAD puts it back on the bell',
  await call('markUserNotifications', ME, { ids: ['n2'], unread: true }), { changed: 1, unread: 3 });
check('un-reading an already-unread one is a no-op',
  await call('markUserNotifications', ME, { ids: ['n2'], unread: true }), { changed: 0, unread: 3 });

console.log('\nMark all as read');
seed();
check('clears the bell in one go', await call('markUserNotifications', ME, { all: true }), { changed: 3, unread: 0 });
check('...and loses NOTHING', (await call('listUserNotifications', ME)).length, 3);
assert('every one of them carries when it was read',
  (await call('listUserNotifications', ME)).every((n) => !!n.readAt));
check('running it again changes nothing', await call('markUserNotifications', ME, { all: true }), { changed: 0, unread: 0 });

console.log('\nThe page still has everything to show');
const all = await call('listUserNotifications', ME);
check('read and unread together, newest first', all.map((n) => n.id), ['n1', 'n2', 'n3']);
check('each keeps its kind, so the type filter has something to filter on',
  all.map((n) => n.kind), ['borrower_upload', 'mention', 'full_file']);
check('each keeps its date, so the date filter does too',
  all.every((n) => /^\d{4}-\d{2}-\d{2}T/.test(n.createdAt)), true);

console.log('\nRubbish in');
seed();
check('an id that is not there changes nothing', await call('markUserNotifications', ME, { ids: ['nope'] }), { changed: 0, unread: 3 });
check('no ids and no all changes nothing', await call('markUserNotifications', ME, {}), { changed: 0, unread: 3 });
DOC = null;
check('a user with no notifications at all does not throw', await call('markUserNotifications', ME, { all: true }), { changed: 0, unread: 0 });
check('...and lists as empty', await call('listUserNotifications', ME), []);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
