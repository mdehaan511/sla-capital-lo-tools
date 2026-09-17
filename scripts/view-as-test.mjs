// scripts/view-as-test.mjs -- Deploy 237.127 gate for the Owner "View as user" layer in _shared/auth.mjs (db stubbed, no network). Run: node scripts/view-as-test.mjs
import * as auth from '../deploy/netlify/functions/_shared/auth.mjs';
import { db } from '../deploy/netlify/functions/_shared/supabase-db.mjs';

db.select = async (table, opts) => {
  if (table !== 'sla_user_roles') return [];
  const e = opts && opts.eq && opts.eq.email;
  const map = { 'lo@slacapital.com': ['loan_officer'], 'proc@slacapital.com': ['processor'] };
  return map[e] ? [{ email: e, roles: map[e] }] : [];
};
const owner = { email: 'mike@slacapital.com', app_metadata: { roles: ['super_admin'] } };
const admin = { email: 'chance@slacapital.com', app_metadata: { roles: ['admin'] } };
const ctx = (u) => ({ clientContext: { user: u } });
const req = (method, path, viewAs) => new Request('https://portal.slacapital.ai' + path, { method, headers: viewAs ? { 'x-sla-view-as': viewAs } : {} });
let fails = 0;
const check = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fails++; };

let u = await auth.requireAuth(ctx(owner), req('GET', '/api/clients'));
check('no header -> real owner', u && u.email === 'mike@slacapital.com');
u = await auth.requireAuth(ctx(owner), req('GET', '/api/clients', 'lo@slacapital.com'));
check('owner GET with header -> target email', u && u.email === 'lo@slacapital.com');
check('target roles from table', u && auth.getRoles(u).join() === 'loan_officer' && !auth.isAdmin(u));
check('viewer recorded', u && u._viewAsBy === 'mike@slacapital.com');
u = await auth.requireAuth(ctx(owner), req('POST', '/api/loan-fields-save', 'lo@slacapital.com'));
check('owner POST write while viewing -> refused (null)', u === null);
u = await auth.requireAuth(ctx(owner), req('POST', '/api/loan-reviews-list', 'lo@slacapital.com'));
check('owner POST read (-list) while viewing -> allowed as target', u && u.email === 'lo@slacapital.com');
u = await auth.requireAuth(ctx(owner), req('DELETE', '/api/x-get', 'lo@slacapital.com'));
check('DELETE never allowed', u === null);
u = await auth.requireAuth(ctx(admin), req('GET', '/api/clients', 'lo@slacapital.com'));
check('non-owner header ignored -> real admin', u && u.email === 'chance@slacapital.com');
u = await auth.requireAuth(ctx(admin), req('POST', '/api/loan-fields-save', 'lo@slacapital.com'));
check('non-owner write with header -> still their own write (header ignored)', u && u.email === 'chance@slacapital.com');
u = await auth.requireAuth(ctx(owner), req('GET', '/api/clients', 'nobody@x.com'));
check('target with no role row -> refused', u === null);
u = await auth.requireAuth(ctx(owner), req('GET', '/api/clients', 'MIKE@slacapital.com'));
check('viewing as yourself -> real user', u && u.email === 'mike@slacapital.com' && auth.isSuperAdmin(u));
u = await auth.requireAuth(ctx(owner), req('GET', '/api/clients', 'not-an-email'));
check('junk header ignored', u && u.email === 'mike@slacapital.com');
u = await auth.requireAuth(ctx(null), req('GET', '/api/clients', 'lo@slacapital.com'));
check('no login + header -> null', u === null);
console.log(fails ? fails + ' FAILED' : 'all view-as checks pass');
process.exit(fails ? 1 : 0);
