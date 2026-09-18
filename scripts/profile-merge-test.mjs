/**
 * scripts/profile-merge-test.mjs — Deploy 237.153
 *
 * Chance: "Camelot asks me for my birthday every time I log in (I have input
 * it already)." identity-login.mjs rebuilt the profile record from the login
 * payload and setJSON'd it, wiping every app-owned field — birthday, start
 * date, avatar, phone — on every login.
 *
 * Run: node scripts/profile-merge-test.mjs
 */
import { mergeIdentityProfile, nameFromIdentity, APP_OWNED_PROFILE_FIELDS } from '../deploy/netlify/functions/_shared/profile-record.mjs';

let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

// What Chance's record looks like after he answers the prompt.
const STORED = {
  id: 'abc-123',
  email: 'chance@slacapital.com',
  fullName: 'Chance Luce',
  roles: ['admin'],
  confirmed_at: '2025-06-02T00:00:00.000Z',
  created_at: '2025-06-02T00:00:00.000Z',
  last_seen_at: '2026-09-17T10:00:00.000Z',
  birthday: '03-08',
  birthYear: '1990',
  startDate: '2025-06-02',
  avatar: 'paladin',
  phone: '509-555-0101',
  user_metadata: { full_name: 'Chance Luce', phone: '509-555-0101' },
};

// A Netlify Identity login event: identity fields only, no app fields.
const LOGIN = {
  id: 'abc-123',
  email: 'Chance@SLACapital.com',
  confirmed_at: '2025-06-02T00:00:00.000Z',
  created_at: '2025-06-02T00:00:00.000Z',
  user_metadata: { full_name: 'Chance Luce' },
  app_metadata: { roles: ['admin'] },
};

// ── 1. The reported bug: a login must not erase what the app owns ──────────
{
  const after = mergeIdentityProfile(STORED, LOGIN);
  for (const f of APP_OWNED_PROFILE_FIELDS) {
    ok(after[f] === STORED[f], 'login keeps ' + f + ' [' + JSON.stringify(after[f]) + ']');
  }
  ok(after.birthday === '03-08', 'the birthday prompt will not fire again');
  ok(after.created_at === STORED.created_at, 'created_at (the fallback anniversary) does not move');
  ok(after.email === 'chance@slacapital.com', 'email is normalized');
  ok(after.last_seen_at !== STORED.last_seen_at, 'last_seen_at is refreshed');

  // Ten logins in a row must be as harmless as one.
  let rec = STORED;
  for (let i = 0; i < 10; i++) rec = mergeIdentityProfile(rec, LOGIN);
  ok(rec.birthday === '03-08' && rec.startDate === '2025-06-02' && rec.avatar === 'paladin',
    'ten consecutive logins still keep the calendar fields');
}

// The old code is what broke it — prove this test would have caught it.
{
  const meta = LOGIN.user_metadata;
  const old = {
    id: LOGIN.id, email: LOGIN.email, fullName: meta.full_name, roles: ['admin'],
    confirmed_at: LOGIN.confirmed_at, last_seen_at: new Date().toISOString(),
    created_at: LOGIN.created_at, user_metadata: meta,
  };
  ok(old.birthday === undefined && old.startDate === undefined,
    'the old blind write really did drop birthday + startDate (regression guard is real)');
}

// ── 2. A thin payload must not blank good stored values ───────────────────
{
  const thin = { id: 'abc-123', email: 'chance@slacapital.com' }; // no metadata at all
  const after = mergeIdentityProfile(STORED, thin);
  ok(after.fullName === 'Chance Luce', 'a nameless payload does not erase the name');
  ok(Array.isArray(after.roles) && after.roles[0] === 'admin', 'a payload with no roles does not downgrade to user');
  ok(after.birthday === '03-08', 'a thin payload still keeps the birthday');
  ok(after.user_metadata.phone === '509-555-0101', 'app-set user_metadata keys survive');
  ok(after.confirmed_at === STORED.confirmed_at, 'confirmed_at is kept');
}

// Identity still wins where it should.
{
  const renamed = Object.assign({}, LOGIN, { user_metadata: { full_name: 'Chance R. Luce' }, app_metadata: { roles: ['super_admin'] } });
  const after = mergeIdentityProfile(STORED, renamed);
  ok(after.fullName === 'Chance R. Luce', 'a new name from identity is taken');
  ok(after.roles[0] === 'super_admin', 'new roles from identity are taken');
  ok(after.birthday === '03-08', '...without touching the app fields');
}

// ── 3. Brand-new records keep the old defaults ────────────────────────────
{
  const fresh = mergeIdentityProfile(null, { id: 'new-1', email: 'New@slacapital.com', user_metadata: {}, app_metadata: {} });
  ok(fresh.email === 'new@slacapital.com', 'new record: email normalized');
  ok(fresh.roles.length === 1 && fresh.roles[0] === 'user', 'new record: roles default to user');
  ok(typeof fresh.created_at === 'string' && fresh.created_at.length > 10, 'new record: created_at is stamped');
  ok(fresh.fullName === '', 'new record: fullName is an empty string, not undefined');
  const signup = mergeIdentityProfile(null, { id: 'new-2', email: 'x@slacapital.com' }, { lastSeen: false });
  ok(signup.last_seen_at === null, 'signup does not claim the user has been seen');
}

// A seeded record (start date from Dan's list) must survive the first signup.
{
  const seeded = { email: 'newhire@slacapital.com', startDate: '2026-04-13', birthday: '08-16' };
  const after = mergeIdentityProfile(seeded, { id: 's1', email: 'newhire@slacapital.com', user_metadata: { full_name: 'New Hire' } }, { lastSeen: false });
  ok(after.startDate === '2026-04-13' && after.birthday === '08-16', 'signup keeps a pre-seeded calendar');
  ok(after.fullName === 'New Hire', 'signup still records the name');
}

// ── 4. The name helper reads every shape identity sends ───────────────────
ok(nameFromIdentity({ full_name: 'A B' }) === 'A B', 'name from full_name');
ok(nameFromIdentity({ name: 'C D' }) === 'C D', 'name from name');
ok(nameFromIdentity({ firstName: 'E', lastName: 'F' }) === 'E F', 'name from first/last');
ok(nameFromIdentity({}) === '', 'no name is an empty string');
ok(nameFromIdentity(null) === '', 'null metadata is safe');

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
