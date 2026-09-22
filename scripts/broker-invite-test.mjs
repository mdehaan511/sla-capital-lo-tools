#!/usr/bin/env node
/**
 * scripts/broker-invite-test.mjs — Deploy 237.236 (Mike)
 *
 * Mike: "For brokers instead of invite to borrower portal it should be invite to broker
 * portal. In fact we need to completely diverge the borrowers and brokers. We were doing
 * the broker tag for a while but we need to make those completely separate lists so that
 * less gets confused."
 *
 * What would hurt, so what this guards (the real functions are loaded with their imports
 * stubbed and RUN — the harness from scripts/review-path-run-test.mjs):
 *   1. A broker still getting a BORROWER login from "Invite Broker" (the old path), or the
 *      new path handing a login to the borrower's own address / a team member's address.
 *   2. The partner record landing under the wrong LO, unapproved, or with no role — a
 *      broker who can't sign in, or signs in and sees nothing.
 *   3. The email carrying the wrong link for the account they have (a claim link for a
 *      login that exists 409s on broker-claim; a sign-in link for no login lands nowhere).
 *   4. A borrower's client record being turned into a broker by an email match (the tag
 *      creeping back in through the save path).
 *   5. The Broker Book page still offering the tag toggle or the borrower-portal invite.
 *
 * Run: node scripts/broker-invite-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

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
const DEPLOY = new URL('../deploy/', import.meta.url);
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');
const readFn = (p) => readFileSync(new URL(p, FN), 'utf8');
const keySafe = (s) => String(s || '').replace(/[:/\\]/g, '_').replace(/^\.+/, '').slice(0, 128); // the real one: '@' stays
const normalizeEmail = (s) => String(s || '').trim().toLowerCase();

async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: { RESEND_API_KEY: 're_test' } }, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, encodeURIComponent, AbortSignal, Set, Map }, extraGlobals || {}));
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const exportsObj = {};
    wanted.forEach((n) => { exportsObj[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(exportsObj), function () { Object.keys(exportsObj).forEach((k) => this.setExport(k, exportsObj[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace;
}
const req = (method, url, headers, body) => ({ method, url, headers: { get: (k) => (headers || {})[k.toLowerCase()] || '' }, body });

// Every helper a function CALLS must be in an import list (node --check cannot see this;
// the rateEl class of bug). Names below are the ones these files reach for.
const HELPERS = ['handleOptions', 'json', 'requireAuth', 'readJsonBody', 'isAdmin', 'isProcessor', 'normalizeEmail', 'keySafe', 'getStore',
  'isBrokerRole', 'canOverrideOwner', 'isLoanInProcessing', 'getPartner', 'savePartner', 'mintInvite', 'markPortalInvite', 'syncRoleTable',
  'getSb', 'findUserIdByEmail', 'lastSignInByUserId', 'mintDurablePortalLink', 'linkExpiryCopy', 'writeLoanInvite', 'grantLoanAccess',
  'linkOrCreateBroker', 'writeClient', 'clientAsBroker', 'splitBrokerName', 'sendPartnerInviteEmail', 'getOwnerReplyTo', 'db', 'ensureBorrowerUser', 'sendBorrowerEmail'];
function declaredCheck(file) {
  const src = readFn(file);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imported = new Set();
  const re = /import\s*\{([^}]*)\}\s*from/g; let m;
  while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => imported.add(n));
  const local = new Set(); const fre = /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fre.exec(code))) local.add(m[1]);
  const missing = HELPERS.filter((h) => new RegExp('(?<![\\w$.])' + h + '\\s*[(.]').test(code) && !imported.has(h) && !local.has(h));
  return missing;
}

// ── A. the shared invite email, run for real against a fake Resend ─────────
console.log('\nThe partner invite email (shared by the desk and the loan)');
{
  const mod = await import('../deploy/netlify/functions/_shared/broker-invite-email.mjs');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push([url, JSON.parse(o.body)]); return calls.length === 3 ? { ok: false, status: 422, text: async () => 'bad address' } : { ok: true, text: async () => '' }; };
  process.env.RESEND_API_KEY = 're_test';
  const claim = await mod.sendPartnerInviteEmail({ toEmail: 'bo@brokerage.com', url: 'https://x/broker-signup.html?t=tok', rec: { firstName: 'Bo' }, actor: 'jeremy@slacapital.com', mode: 'claim', forAddress: '1 Main St' });
  const c1 = calls[0][1];
  check('a claim goes to the partner, reply-to the LO, with the one-time link in text and html', [claim.ok, c1.to, c1.reply_to, c1.text.indexOf('https://x/broker-signup.html?t=tok') >= 0, c1.html.indexOf('https://x/broker-signup.html?t=tok') >= 0, /works once/.test(c1.text), /Hi Bo/.test(c1.text), c1.text.indexOf('1 Main St') >= 0], [true, ['bo@brokerage.com'], 'jeremy@slacapital.com', true, true, true, true, true]);
  const signin = await mod.sendPartnerInviteEmail({ toEmail: 'bo@brokerage.com', url: 'https://x/api/borrower-link?t=abc', rec: { firstName: 'Bo' }, mode: 'signin', expiry: { text: 'EXPIRES-TXT', html: '<p>EXPIRES-HTML</p>' } });
  const c2 = calls[1][1];
  check('a sign-in link says so, carries the expiry copy and the portal address, and does not call the link one-time', [signin.ok, /Sign in here/.test(c2.text), c2.text.indexOf('EXPIRES-TXT') >= 0, c2.html.indexOf('EXPIRES-HTML') >= 0, /portal\.slacapital\.ai/.test(c2.text), /works once/.test(c2.text), 'reply_to' in c2], [true, true, true, true, true, false, false]);
  const bad = await mod.sendPartnerInviteEmail({ toEmail: 'bo@brokerage.com', url: 'https://x', rec: {}, mode: 'claim' });
  check('a Resend failure is reported, never thrown', [bad.ok, /422/.test(bad.error)], [false, true]);
  delete process.env.RESEND_API_KEY;
  const nokey = await mod.sendPartnerInviteEmail({ toEmail: 'bo@brokerage.com', url: 'https://x', rec: {}, mode: 'claim' });
  check('no API key = not sent, said plainly', [nokey.ok, /RESEND_API_KEY/.test(nokey.error), calls.length], [false, true, 3]);
  globalThis.fetch = realFetch;
  const html = mod.partnerInviteCopy({ mode: 'claim', url: 'https://x', rec: { firstName: '<b>' }, forAddress: '<i>' }).html;
  assert('names are escaped in the html', html.indexOf('&lt;b&gt;') >= 0 && html.indexOf('<b>') < 0 && html.indexOf('&lt;i&gt;') >= 0);
}

// ── B. /api/broker-portal-invite, run ──────────────────────────────────────
console.log('\n/api/broker-portal-invite: the broker gets the partner portal, never a borrower login');
{
  check('every helper broker-portal-invite calls is imported', declaredCheck('broker-portal-invite.mjs'), []);
  const mkWorld = (o) => {
    o = o || {};
    const w = {
      blobs: {}, partners: {}, roles: {}, users: {}, lastSignIn: {},
      calls: { save: [], role: [], mint: [], durable: [], email: [], loanInvite: [], grant: [], link: [], writeClient: [], mark: [] },
      linkResult: o.linkResult === undefined ? { id: 'b_new', created: true, broker: { name: 'Bo Broker', company: 'Bo Co', phone: '555' } } : o.linkResult,
    };
    const LOAN = { id: 'l_1', address: '1 Main St', processingStage: o.stage === undefined ? 'processing' : o.stage, brokerEmail: 'bo@brokerage.com', brokerName: 'Bo Broker', brokerCompany: 'Bo Co', brokerPhone: '555' };
    if (o.brokerId) LOAN.brokerId = o.brokerId;
    if (o.loanPatch) Object.assign(LOAN, o.loanPatch);
    w.blobs['lo1@slacapital.com/c_1'] = { id: 'c_1', firstName: 'Kandiah', lastName: 'Lingan', email: o.clientEmail || 'k@x.com', loans: [LOAN] };
    w.blobs['lo1@slacapital.com/b_9'] = { id: 'b_9', firstName: 'Bo', lastName: 'Broker', email: 'bo@brokerage.com', _isBroker: true, _brokerCompany: 'Bo Co', phone: '555', loans: [] };
    // A broker-SUBMITTED application: the loan lives under the broker's own record and the
    // real borrower is a linked guarantor (Mike's 1565 E Farwell test loan).
    if (o.parentIsBroker) {
      Object.assign(LOAN, { brokerId: 'b_9', _isBrokerLoan: true, borrowerName: 'JimTest Testerguy', guarantorClientIds: ['c_j'],
        guarantors: [{ firstName: 'JimTest', lastName: 'Testerguy', email: 'tester@testmail.com', clientId: 'c_j' }] });
      w.blobs['lo1@slacapital.com/c_1'].loans = [];
      w.blobs['lo1@slacapital.com/b_9'].loans = [LOAN];
      if (o.loanPatch) Object.assign(LOAN, o.loanPatch); // the case's own overrides win
    }
    w.blobs['lo1@slacapital.com/c_plain'] = { id: 'c_plain', firstName: 'Just', lastName: 'Borrower', email: 'jb@x.com', loans: [] };
    if (o.partner) w.partners['bo@brokerage.com'] = o.partner;
    if (o.roleRow) w.roles['bo@brokerage.com'] = o.roleRow;
    if (o.userId) w.users['bo@brokerage.com'] = o.userId;
    w.stubs = {
      '@netlify/blobs': { getStore: () => ({ get: async (k) => w.blobs[k] || null }) },
      './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => w.user, readJsonBody: async (r) => r.body, normalizeEmail, keySafe },
      './_shared/access.mjs': {
        isBrokerRole: (u) => (u.app_metadata.roles || []).indexOf('broker') >= 0,
        canOverrideOwner: (u) => ({ ok: (u.app_metadata.roles || []).some((r) => r === 'admin' || r === 'processor') }),
        isLoanInProcessing: (l) => !!l.processingStage,
      },
      './_shared/broker-partners.mjs': {
        getPartner: async (e) => w.partners[normalizeEmail(e)] || null,
        savePartner: async (e, patch, actor) => { w.calls.save.push([e, patch, actor]); const rec = w.partners[e] || { email: e, status: 'pending', clientId: '', ownerKey: '', company: '', firstName: '', lastName: '', phone: '' }; Object.assign(rec, patch); w.partners[e] = rec; return rec; },
        mintInvite: async (e, actor) => { w.calls.mint.push([e, actor]); const rec = w.partners[e]; rec.inviteToken = 'tok123'; return rec; },
        markPortalInvite: async (e, patch) => { w.calls.mark.push([e, patch]); const rec = w.partners[e]; if (rec) rec.portalInvite = Object.assign({}, rec.portalInvite || {}, patch); return rec; },
      },
      './_shared/sla-roles.mjs': { syncRoleTable: async (e, roles) => { w.calls.role.push([e, roles]); return { ok: true }; } },
      './_shared/supabase-db.mjs': { db: { first: async (t, q) => (t === 'sla_user_roles' && w.roles[q.eq.email]) ? { email: q.eq.email, roles: w.roles[q.eq.email] } : null } },
      './_shared/borrower-invite-core.mjs': {
        getSb: () => ({ base: 'sb' }),
        findUserIdByEmail: async (sb, e) => w.users[e] || '',
        lastSignInByUserId: async (sb, id) => w.lastSignIn[id] || '',
        mintDurablePortalLink: (e, origin, opts) => { w.calls.durable.push([e, opts]); return { url: origin + '/api/borrower-link?t=durable', kind: opts && opts.kind, expiresText: 'soon' }; },
        linkExpiryCopy: () => ({ text: 'EXP', html: '<p>EXP</p>' }),
        writeLoanInvite: async (loanId, who, entry) => { w.calls.loanInvite.push([loanId, who, entry]); },
      },
      './_shared/loan-access-store.mjs': { grantLoanAccess: async (g) => { w.calls.grant.push(g); } },
      './_shared/broker-link.mjs': { linkOrCreateBroker: async (ownerKey, l) => { w.calls.link.push([ownerKey, l]); return w.linkResult; } },
      './_shared/client-write.mjs': { writeClient: async (ownerKey, c) => { w.calls.writeClient.push([ownerKey, JSON.parse(JSON.stringify(c))]); } },
      './_shared/broker-client.mjs': {
        clientAsBroker: (c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' '), company: c._brokerCompany || c.entityName || '', email: c.email || '', phone: c.phone || '' }),
        splitBrokerName: (n) => { const p = String(n || '').trim().split(/\s+/); return p.length < 2 ? { firstName: p[0] || '', lastName: '' } : { firstName: p.slice(0, -1).join(' '), lastName: p[p.length - 1] }; },
      },
      './_shared/broker-invite-email.mjs': { sendPartnerInviteEmail: async (a) => { w.calls.email.push(a); return w.emailResult || { ok: true }; } },
      './_shared/email.mjs': { getOwnerReplyTo: async () => 'lo1@slacapital.com' },
    };
    w.user = o.user || { email: 'lo1@slacapital.com', app_metadata: { roles: ['loan_officer'] } };
    return w;
  };
  const run = async (w, method, body, query) => {
    const fn = (await loadFunction('broker-portal-invite.mjs', w.stubs)).default;
    return fn(req(method, 'https://portal.slacapital.ai/api/broker-portal-invite' + (query || ''), {}, body), {});
  };

  // 1. the LO on their own loan, no login yet
  let w = mkWorld();
  let r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('the LO invites the broker on their loan: 200, a CLAIM link, emailed', [r.status, r.body.ok, r.body.mode, /broker-signup\.html\?t=tok123$/.test(r.body.inviteUrl), r.body.emailed, r.body.email], [200, true, 'claim', true, true, 'bo@brokerage.com']);
  check('...the partner record: approved, owned by the loan\'s LO, linked to the broker record, named from the loan', [w.partners['bo@brokerage.com'].status, w.partners['bo@brokerage.com'].ownerKey, w.partners['bo@brokerage.com'].clientId, w.partners['bo@brokerage.com'].firstName, w.partners['bo@brokerage.com'].lastName, w.partners['bo@brokerage.com'].company], ['approved', 'lo1@slacapital.com', 'b_new', 'Bo', 'Broker', 'Bo Co']);
  check('...role broker in the table; the claim minted once', [w.calls.role, w.calls.mint.length], [[['bo@brokerage.com', ['broker']]], 1]);
  check('...the email: to the broker, reply-to the owning LO, claim mode, names the loan', [w.calls.email.length, w.calls.email[0].toEmail, w.calls.email[0].actor, w.calls.email[0].mode, w.calls.email[0].forAddress, w.calls.email[0].url === r.body.inviteUrl], [1, 'bo@brokerage.com', 'lo1@slacapital.com', 'claim', '1 Main St', true]);
  check('...the loan remembers a BROKER-portal invite (the status line reads it) and the loan is granted, role broker', [w.calls.loanInvite.map((x) => [x[0], x[1], x[2].portal, x[2].mode]), w.calls.grant.map((g) => [g.loanId, g.role, g.email, g.ownerKey])], [[['l_1', 'broker', 'broker', 'claim']], [['l_1', 'broker', 'bo@brokerage.com', 'lo1@slacapital.com']]]);
  check('...a loan with no brokerId is linked to a broker record and written, so the portal lists it', [w.calls.link.length, w.calls.link[0][1].brokerEmail, w.calls.writeClient.length, w.calls.writeClient[0][1].loans[0].brokerId, r.body.linked], [1, 'bo@brokerage.com', 1, 'b_new', true]);
  check('...the partner record remembers the invite', [w.calls.mark.length, w.calls.mark[0][1].mode, w.calls.mark[0][1].by, w.calls.mark[0][1].loanId, w.calls.mark[0][1].emailed], [1, 'claim', 'lo1@slacapital.com', 'l_1', true]);
  assert('...never a borrower login: no ensureBorrowerUser, no borrower-role grant anywhere in the file', !/ensureBorrowerUser/.test(readFn('broker-portal-invite.mjs')) && !/role: 'borrower'/.test(readFn('broker-portal-invite.mjs')));

  // 2. a login already exists (they were a borrower-portal user before)
  w = mkWorld({ userId: 'u1', roleRow: ['borrower'], brokerId: 'b_9' });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a broker who already has a login gets a SIGN-IN link (kind broker), not a claim that would 409', [r.status, r.body.mode, r.body.inviteUrl, w.calls.durable, w.calls.mint.length, w.calls.email[0].mode, w.calls.email[0].expiry && w.calls.email[0].expiry.text], [200, 'signin', 'https://portal.slacapital.ai/api/borrower-link?t=durable', [['bo@brokerage.com', { kind: 'broker' }]], 0, 'signin', 'EXP']);
  check('...their borrower role is kept, broker added (union, not replace); an already-linked loan is not re-linked', [w.calls.role, w.calls.link.length, w.calls.writeClient.length, r.body.linked], [[['bo@brokerage.com', ['borrower', 'broker']]], 0, 0, true]);

  // 3. the two mix-ups
  w = mkWorld({ clientEmail: 'bo@brokerage.com' });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('the broker email being the borrower\'s own email is refused, nothing written or sent', [r.status, /borrower/.test(r.body.error), w.calls.save.length, w.calls.email.length, w.calls.role.length], [409, true, 0, 0, 0]);
  w = mkWorld({ loanPatch: { brokerEmail: 'jeremy@slacapital.com' } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a team address is refused', [r.status, /team/.test(r.body.error), w.calls.save.length], [409, true, 0]);
  w = mkWorld({ roleRow: ['loan_officer'] });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('an address with a staff role is refused', [r.status, /team member/.test(r.body.error), w.calls.save.length, w.calls.role.length], [409, true, 0, 0]);
  // Mike's loan: the parent client IS the broker; the borrower is the linked guarantor.
  w = mkWorld({ parentIsBroker: true });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'b_9' });
  check('a broker-SUBMITTED application: the parent client is the broker, so their email is not "the borrower\'s own" -- invited', [r.status, r.body.email, w.partners['bo@brokerage.com'].clientId, w.calls.link.length, w.calls.email.length], [200, 'bo@brokerage.com', 'b_9', 0, 1]);
  w = mkWorld({ parentIsBroker: true, loanPatch: { guarantors: [{ firstName: 'JimTest', lastName: 'Testerguy', email: 'bo@brokerage.com', clientId: 'c_j' }] } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'b_9' });
  check('...but a broker-parent loan whose GUARANTOR carries the broker email is still refused', [r.status, /borrower/.test(r.body.error), w.calls.email.length], [409, true, 0]);
  w = mkWorld({ parentIsBroker: true, loanPatch: { guarantors: [], borrowerEmail: 'bo@brokerage.com' } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'b_9' });
  check('...or whose typed borrower email is the broker email', [r.status, w.calls.email.length], [409, 0]);

  // 4. suspended stays suspended
  w = mkWorld({ partner: { email: 'bo@brokerage.com', status: 'suspended', ownerKey: 'x', clientId: 'b_9' } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a suspended partner is not quietly re-approved by an LO invite', [r.status, /suspended/.test(r.body.error), w.calls.save.length, w.calls.role.length, w.calls.email.length], [409, true, 0, 0, 0]);

  // 5. an existing partner under another LO keeps their rep and their details
  w = mkWorld({ partner: { email: 'bo@brokerage.com', status: 'approved', ownerKey: 'lo2@slacapital.com', clientId: 'b_other', firstName: 'Robert', lastName: 'Broker', company: 'Robert Co', phone: '777' }, brokerId: 'b_9' });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('an existing partner keeps their inviting rep, record link and details; only status is (re)asserted', [r.status, w.partners['bo@brokerage.com'].ownerKey, w.partners['bo@brokerage.com'].clientId, w.partners['bo@brokerage.com'].firstName, w.partners['bo@brokerage.com'].company, w.calls.save[0][1]], [200, 'lo2@slacapital.com', 'b_other', 'Robert', 'Robert Co', { status: 'approved' }]);

  // 6. who may call
  w = mkWorld();
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1', owner: 'lo2@slacapital.com' });
  check('a plain LO cannot invite on another LO\'s loan', [r.status, w.calls.save.length], [403, 0]);
  w = mkWorld({ user: { email: 'proc@slacapital.com', app_metadata: { roles: ['processor'] } } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1', owner: 'lo1@slacapital.com' });
  check('a processor may, naming the owner; the record lands under that LO with the LO as reply-to', [r.status, w.partners['bo@brokerage.com'].ownerKey, w.calls.email[0].actor, w.calls.loanInvite[0][2].sentBy], [200, 'lo1@slacapital.com', 'lo1@slacapital.com', 'proc@slacapital.com']);
  w = mkWorld({ user: { email: 'bo@brokerage.com', app_metadata: { roles: ['broker'] } } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a broker login cannot invite', [r.status], [403]);
  w = mkWorld({ user: { email: 'k@x.com', app_metadata: { roles: ['borrower'] } } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a borrower login cannot invite', [r.status], [403]);

  // 7. from the broker's own page
  w = mkWorld();
  r = await run(w, 'POST', { brokerClientId: 'b_9' });
  check('from the Broker Book page: 200, partner linked to that record, no loan record, no grant', [r.status, r.body.mode, w.partners['bo@brokerage.com'].clientId, w.partners['bo@brokerage.com'].ownerKey, w.calls.loanInvite.length, w.calls.grant.length, w.calls.link.length, w.calls.email[0].forAddress], [200, 'claim', 'b_9', 'lo1@slacapital.com', 0, 0, 0, '']);
  w = mkWorld();
  r = await run(w, 'POST', { brokerClientId: 'c_plain' });
  check('a BORROWER record cannot be invited as a broker', [r.status, /borrower record/.test(r.body.error), w.calls.save.length], [400, true, 0]);
  w = mkWorld();
  r = await run(w, 'POST', { brokerClientId: 'nope' });
  check('an unknown record is 404', [r.status], [404]);

  // 8. link failure is reported, not fatal; a loan not in processing gets no grant yet
  w = mkWorld({ linkResult: null, loanPatch: { brokerName: '' } });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('no broker record could be made (no name): the invite still goes out and the LO is told the loan will not show yet', [r.status, r.body.linked, /will not show/.test(r.body.linkNote), w.calls.writeClient.length, w.calls.email.length, w.partners['bo@brokerage.com'].status], [200, false, true, 0, 1, 'approved']);
  w = mkWorld({ stage: '' });
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a loan not yet in processing: invited and recorded, but no document-page grant yet', [r.status, w.calls.loanInvite.length, w.calls.grant.length], [200, 1, 0]);

  // 9. the email failing is not a failed invite
  w = mkWorld(); w.emailResult = { ok: false, error: 'Resend 422 bad address' };
  r = await run(w, 'POST', { loanId: 'l_1', primaryClientId: 'c_1' });
  check('a failed email: 200 with the link in hand, emailed false and why, the partner record says so', [r.status, r.body.emailed, /422/.test(r.body.emailError), /broker-signup/.test(r.body.inviteUrl), w.calls.mark[0][1].emailed], [200, false, true, true, false]);

  // 10. GET status
  w = mkWorld();
  r = await run(w, 'GET', null, '?brokerClientId=b_9');
  check('status with no partner record: not invited', [r.status, r.body.invited, r.body.hasPartner, r.body.email], [200, false, false, 'bo@brokerage.com']);
  w = mkWorld({ partner: { email: 'bo@brokerage.com', status: 'approved', inviteAcceptedAt: '2026-09-20T00:00:00Z', portalInvite: { at: '2026-09-19T00:00:00Z', by: 'lo1@slacapital.com', mode: 'claim', emailed: true } }, userId: 'u9' });
  w.lastSignIn.u9 = '2026-09-21T10:00:00Z';
  r = await run(w, 'GET', null, '?brokerClientId=b_9');
  check('a claimed login: invited, hasLogin, last sign-in, and the user id is remembered so the user list is not paged again', [r.status, r.body.invited, r.body.hasLogin, r.body.lastSignInAt, r.body.claimedAt, r.body.sentAt, r.body.status, w.calls.mark], [200, true, true, '2026-09-21T10:00:00Z', '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z', 'approved', [['bo@brokerage.com', { userId: 'u9' }]]]);
  w = mkWorld({ user: { email: 'lo1@slacapital.com', app_metadata: { roles: ['loan_officer'] } } });
  r = await run(w, 'GET', null, '?brokerClientId=b_9&owner=lo2@slacapital.com');
  check('status honours the same owner rule', [r.status], [403]);
}

// ── C. the borrower-portal invite refuses brokers ──────────────────────────
console.log('\n/api/borrower-intake-invite no longer mints a borrower login for a broker');
{
  const calls = { ensure: 0, grant: 0, mail: 0, record: [] };
  const fn = (await loadFunction('borrower-intake-invite.mjs', {
    '@netlify/blobs': { getStore: () => ({ get: async () => ({ id: 'c_1', email: 'k@x.com', first_name: 'K', loans: [{ id: 'l_1', address: '1 Main', processingStage: 'processing', brokerEmail: 'bo@brokerage.com' }] }) }) },
    './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => ({ email: 'lo1@slacapital.com', app_metadata: { roles: ['loan_officer'] } }), readJsonBody: async (r) => r.body, isAdmin: () => false, isProcessor: () => false, normalizeEmail, keySafe },
    './_shared/loan-access-store.mjs': { grantLoanAccess: async () => { calls.grant++; } },
    './_shared/access.mjs': { isLoanInProcessing: () => true },
    './_shared/email.mjs': { getOwnerReplyTo: async () => '' },
    './_shared/borrower-invite-core.mjs': {
      getSb: () => ({}), ensureBorrowerUser: async () => { calls.ensure++; return { userId: 'u' }; }, borrowerMagicLink: async () => 'https://magic',
      lastSignInByUserId: async () => '', mintDurablePortalLink: () => null, linkExpiryCopy: () => ({ text: '', html: '' }),
      sendBorrowerEmail: async () => { calls.mail++; return true; }, readLoanInvites: async () => null, writeLoanInvite: async (id, who) => { calls.record.push(who); }, escHtml: (s) => s,
    },
  })).default;
  let r = await fn(req('POST', 'https://x/api/borrower-intake-invite', {}, { loanId: 'l_1', primaryClientId: 'c_1', recipient: 'broker' }), {});
  check('recipient broker is refused (410) before any user, grant, email or record', [r.status, /Preferred Partner portal/.test(r.body.error), calls.ensure, calls.grant, calls.mail, calls.record], [410, true, 0, 0, 0, []]);
  r = await fn(req('POST', 'https://x/api/borrower-intake-invite', {}, { loanId: 'l_1', primaryClientId: 'c_1', recipient: 'borrower' }), {});
  check('the borrower invite still works as before', [r.status, r.body.recipient, calls.ensure, calls.grant, calls.mail, calls.record], [200, 'borrower', 1, 1, 1, ['borrower']]);
  check('borrower-intake-invite imports everything it calls', declaredCheck('borrower-intake-invite.mjs'), []);

  // the loan's status line: a claim-mode broker has no user id on the loan record; it comes from the partner record
  {
    const marks = []; let lookups = 0;
    const partner = { email: 'bo@brokerage.com', status: 'approved', inviteAcceptedAt: '2026-09-20T00:00:00Z', portalInvite: { mode: 'claim' } };
    const fn2 = (await loadFunction('borrower-intake-invite.mjs', {
      '@netlify/blobs': { getStore: () => ({ get: async () => null }) },
      './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => ({ email: 'lo1@slacapital.com', app_metadata: { roles: ['loan_officer'] } }), readJsonBody: async (r) => r.body, isAdmin: () => false, isProcessor: () => false, normalizeEmail, keySafe },
      './_shared/broker-partners.mjs': { getPartner: async () => partner, markPortalInvite: async (e, p) => { marks.push([e, p]); Object.assign(partner.portalInvite, p); } },
      './_shared/borrower-invite-core.mjs': {
        getSb: () => ({}), findUserIdByEmail: async () => { lookups++; return 'u77'; }, lastSignInByUserId: async (sb, id) => (id === 'u77' ? '2026-09-21T10:00:00Z' : ''),
        readLoanInvites: async () => ({ loanId: 'l_1', borrower: { email: 'k@x.com', userId: 'u1', sentAt: '2026-09-01T00:00:00Z' }, broker: { email: 'bo@brokerage.com', userId: '', sentAt: '2026-09-19T00:00:00Z', portal: 'broker', mode: 'claim' } }),
        escHtml: (s) => s,
      },
    })).default;
    let g = await fn2(req('GET', 'https://x/api/borrower-intake-invite?loanId=l_1', {}, null), {});
    check('a claimed broker\'s last login is found through the partner record, once, and remembered', [g.status, g.body.broker.lastSignInAt, g.body.broker.portal, g.body.borrower.lastSignInAt, lookups, marks], [200, '2026-09-21T10:00:00Z', 'broker', '', 1, [['bo@brokerage.com', { userId: 'u77' }]]]);
    g = await fn2(req('GET', 'https://x/api/borrower-intake-invite?loanId=l_1', {}, null), {});
    check('...the second read uses the remembered id (no second lookup)', [g.body.broker.lastSignInAt, lookups], ['2026-09-21T10:00:00Z', 1]);
  }
}

// ── C2. the client-level borrower invite refuses a broker record ────────────
console.log('\n/api/borrower-portal-invite refuses a Broker Book record');
{
  const mk = (client) => loadFunction('borrower-portal-invite.mjs', {
    '@netlify/blobs': { getStore: () => ({ get: async () => client }) },
    './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => ({ email: 'lo1@slacapital.com' }), readJsonBody: async (r) => r.body, isAdmin: () => false, normalizeEmail, keySafe },
    './_shared/borrower-invite-core.mjs': { getSb: () => null, readLoanInvites: async () => null, escHtml: (s) => s },
  });
  let fn = (await mk({ id: 'b_9', email: 'bo@brokerage.com', _isBroker: true, loans: [{ id: 'l_x', brokerId: 'b_9', _isBrokerLoan: true }] })).default;
  let r = await fn(req('POST', 'https://x/api/borrower-portal-invite', {}, { clientId: 'b_9' }), {});
  check('a broker record (only brokered placeholders) is refused with the way forward', [r.status, /Preferred Partner portal/.test(r.body.error)], [409, true]);
  fn = (await mk({ id: 'c_1', email: '', loans: [{ id: 'l_1' }] })).default;
  r = await fn(req('POST', 'https://x/api/borrower-portal-invite', {}, { clientId: 'c_1' }), {});
  check('a borrower record gets past the guard (here: stopped later by having no email)', [r.status, /no email/.test(r.body.error)], [400, true]);
  fn = (await mk({ id: 'b_9', email: '', _isBroker: true, loans: [{ id: 'l_own' }] })).default;
  r = await fn(req('POST', 'https://x/api/borrower-portal-invite', {}, { clientId: 'b_9' }), {});
  check('a broker who also has a loan of their own may still be invited as a borrower for it', [r.status], [400]);
  check('borrower-portal-invite imports everything it calls', declaredCheck('borrower-portal-invite.mjs'), []);
}

// ── D. the pages ───────────────────────────────────────────────────────────
console.log('\nLoan Details, Doc Review, the Broker Book page');
{
  const LD = read('loan-details.js');
  const lift = (src, start, end) => { const a = src.indexOf(start); if (a < 0) throw new Error('not found: ' + start.slice(0, 40)); const z = src.indexOf(end, a); return src.slice(a, z + end.length); };
  // ldInvite: broker → the partner-portal endpoint; borrower → unchanged
  {
    const code = lift(LD, '\nfunction ldInvite(recipient) {', '\n}\n');
    const calls = []; const el = { textContent: '', innerHTML: '' };
    const c = { _client: { id: 'c_1' }, _loanId: 'l_1', _loan: { processingStage: 'processing' }, _loEmail: 'lo1@x', _user: { email: 'lo1@x' },
      isInProcessing: () => true, showToast: () => {}, escH: (s) => String(s), escAttr: (s) => String(s), ldLoadInviteStatus: () => { c.statusLoads++; }, refreshBorrowerAccessList: () => {}, setTimeout: (f) => f(), statusLoads: 0,
      document: { getElementById: () => el }, SLA: { api: (m, p, b) => { calls.push([m, p, b]); return Promise.resolve(c.resp); } }, resp: { ok: true, email: 'bo@b.com', emailed: true } };
    c.window = c; vm.createContext(c); vm.runInContext(code, c);
    vm.runInContext("ldInvite('broker')", c); await new Promise((r) => setTimeout(r, 0));
    vm.runInContext("ldInvite('borrower')", c); await new Promise((r) => setTimeout(r, 0));
    check('Loan Details: Invite Broker → /api/broker-portal-invite; Invite Borrower → the borrower path, both with the loan ids', calls.map((x) => [x[1], x[2].loanId, x[2].primaryClientId, x[2].recipient]), [['/api/broker-portal-invite', 'l_1', 'c_1', 'broker'], ['/api/borrower-intake-invite', 'l_1', 'c_1', 'borrower']]);
    c.resp = { ok: true, email: 'bo@b.com', emailed: false, emailError: 'Resend 422', inviteUrl: 'https://x/broker-signup.html?t=abc' };
    vm.runInContext("ldInvite('broker')", c); await new Promise((r) => setTimeout(r, 0));
    assert('...when the email did not send, the LO gets the link on the page', el.innerHTML.indexOf('https://x/broker-signup.html?t=abc') >= 0 && /did not send/.test(el.innerHTML));
    assert('...the broker button says where it goes', /ldInvite\(\\'broker\\'\)" style="white-space:nowrap" title="Invite this broker to the Preferred Partner portal/.test(LD));
    assert('...the status line names the portal, and flags a pre-split (borrower-login) broker invite for re-sending', /e\.portal === 'broker' \? 'Broker \(partner portal\)' : 'Broker \(old borrower-portal invite/.test(LD) && /e\.portal === 'broker' \? 'Broker \(partner portal\)' : 'Broker \(old borrower-portal invite/.test(read('loan-doc-review.js')));
  }
  // doc review
  {
    const DR = read('loan-doc-review.js');
    const code = lift(DR, '  global.dr_invite = function(recipient) {', '\n  };\n');
    const calls = [];
    const c = { global: {}, _review: { source: { loanId: 'l_1', clientId: 'c_1' }, loEmail: 'lo1@x' }, showToast: () => {}, dr_loadInviteStatus: () => {} };
    c.global.SLA = { api: (m, p, b) => { calls.push([m, p, b]); return Promise.resolve({ ok: true, email: 'bo@b.com', emailed: true }); } };
    vm.createContext(c); vm.runInContext(code, c);
    vm.runInContext("global.dr_invite('broker'); global.dr_invite('borrower')", c); await new Promise((r) => setTimeout(r, 0));
    check('Doc Review: the same split', calls.map((x) => [x[1], x[2].recipient, x[2].owner]), [['/api/broker-portal-invite', 'broker', 'lo1@x'], ['/api/borrower-intake-invite', 'borrower', 'lo1@x']]);
  }
  // the Broker Book / client page
  {
    const CD = read('client-details.html');
    assert('the broker tag toggle is gone from the client page', !/toggleBrokerTag|client-broker-tag|Tag as Broker|Remove Broker Tag/.test(CD));
    assert('a broker record offers Invite to Broker Portal + the Broker Book; a borrower record keeps Invite to Borrower Portal', /\(_isBrokerFlag\s*\n\s*\? '<div[^]*?inviteBrokerPortal\(\)[^]*?Invite to Broker Portal[^]*?brokers\.html\?focus=[^]*?: '<div[^]*?invitePortal\(\)/.test(CD));
    assert('a pure broker does not get Create New Loan / Send Loan Prequal; a broker with loans of their own keeps them', /var _brokerOwnLoans = \(c\.loans \|\| \[\]\)\.some\(function\(l\) \{ return l && !\(l\._isBrokerLoan \|\| l\.brokerId\); \}\);\s*\n\s*var _borrowerActions = !_isBrokerFlag \|\| _brokerOwnLoans;/.test(CD) && /\(_borrowerActions \? '<button type="button" class="action-btn primary" onclick="openCreateLoanModal\(\)"/.test(CD) && /\(_borrowerActions \? '<div style="display:flex;flex-direction:column;gap:2px">' \+\s*\n\s*'<button type="button" class="action-btn" onclick="sendLoanPrequal\(\)"/.test(CD));
    assert('the back link on a broker page goes to the Broker Book', /c\._isBroker \? 'brokers\.html' : 'clients\.html'/.test(CD) && /c\._isBroker \? 'Broker Book' : 'All Borrowers'/.test(CD));
    assert('the status line on a broker page reads the partner portal, a borrower page the borrower portal', /if \(c\._isBroker\) loadBrokerPortalStatus\(\); else loadPortalInviteStatus\(\);/.test(CD));
    const code = lift(CD, '\nfunction inviteBrokerPortal() {', '\n}\n') + lift(CD, '\nfunction loadBrokerPortalStatus() {', '\n}\n');
    const calls = []; const els = { brokerPortalInviteBtn: { disabled: false }, brokerPortalInviteStatus: { textContent: '', innerHTML: '' }, acctPillSlot: { innerHTML: '' } };
    const c = { _client: { id: 'b_9', email: 'bo@b.com' }, _clientId: 'b_9', _loEmail: 'lo2@x', _user: { email: 'admin@x' }, confirm: () => true, showToast: () => {}, escH: (s) => String(s), escAttr: (s) => String(s),
      document: { getElementById: (id) => els[id] || null }, SLA: { api: (m, p, b) => { calls.push([m, p, b]); return Promise.resolve(m === 'GET' ? { invited: true, email: 'bo@b.com', hasLogin: true, lastSignInAt: '2026-09-21T10:00:00Z', sentAt: '2026-09-19T00:00:00Z', claimedAt: '2026-09-20T00:00:00Z', status: 'approved' } : { ok: true, email: 'bo@b.com', emailed: true, mode: 'claim' }); } }, Date, encodeURIComponent };
    c.window = c; vm.createContext(c); vm.runInContext(code, c);
    vm.runInContext('inviteBrokerPortal()', c); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    check('the client page invites a broker record to the PARTNER portal, with the owner override, then reloads the status', [calls[0][0], calls[0][1], calls[0][2], calls[1] && calls[1][0], calls[1] && calls[1][1]], ['POST', '/api/broker-portal-invite', { brokerClientId: 'b_9', owner: 'lo2@x' }, 'GET', '/api/broker-portal-invite?brokerClientId=b_9&owner=lo2%40x']);
    assert('...and paints the partner pill and the invited / login / last-login line', /Partner/.test(els.acctPillSlot.innerHTML) && /Portal invited bo@b\.com/.test(els.brokerPortalInviteStatus.innerHTML) && /login set up/.test(els.brokerPortalInviteStatus.innerHTML) && /last login/.test(els.brokerPortalInviteStatus.innerHTML));
  }
  // activate.html + the redeem page + the API helper + the redirect
  {
    const AC = read('activate.html');
    assert('activate.html sends a Preferred Partner to their portal', /var isBroker = Array\.isArray\(roles\) && roles\.indexOf\('broker'\) >= 0;\s*\n\s*var dest = \(!isStaff && isBroker\) \? '\/broker-portal\.html' : \(!isStaff && isBorrower\) \? '\/borrower-portal\.html' : '\/';/.test(AC));
    const BL = readFn('borrower-link.mjs');
    const code = lift(BL, '\nfunction _portalBtn(kind) {', '\n}\n') + lift(BL, '\nfunction _borrowerPortalBtn() {', '\n}\n') + lift(BL, '\nfunction _newLinkEmail(link, expiresText, kind) {', '\n}\n');
    const c = { escHtml: (s) => String(s), PORTAL_LINK_TTL_HOURS: 72 };
    vm.createContext(c); vm.runInContext(code, c);
    const btn = vm.runInContext("[_portalBtn('broker'), _portalBtn('borrower'), _portalBtn('staff')]", c);
    check('the redeem page\'s footer button follows the kind', [/broker-portal\.html/.test(btn[0]), /borrower-portal\.html/.test(btn[1]), /index\.html/.test(btn[2])], [true, true, true]);
    const mail = vm.runInContext("[_newLinkEmail('https://l', 'soon', 'broker').text, _newLinkEmail('https://l', 'soon', 'borrower').text]", c);
    check('a resent broker link is called a partner portal link, a borrower\'s still a borrower portal link', [/partner portal/.test(mail[0]), /borrower portal/.test(mail[1])], [true, true]);
    process.env.ESIGN_SEAL_SECRET = process.env.ESIGN_SEAL_SECRET || 'test-secret';
    const core = await import('../deploy/netlify/functions/_shared/borrower-invite-core.mjs');
    const b = core.mintDurablePortalLink('bo@b.com', 'https://x', { kind: 'broker' });
    const s = core.mintDurablePortalLink('lo@b.com', 'https://x', { kind: 'staff' });
    const n = core.mintDurablePortalLink('k@b.com', 'https://x');
    check('a durable link minted for a broker verifies as a broker; staff and borrower unchanged', [b.kind, core.verifyDurablePortalToken(b.token).kind, core.verifyDurablePortalToken(s.token).kind, core.verifyDurablePortalToken(n.token).kind], ['broker', 'broker', 'staff', 'borrower']);
    const API = read('sla-api.js');
    assert('SLA.BrokerPortal.invite / .status exist and hit the endpoint', /BrokerPortal: \{\s*\n\s*invite: function \(data\) \{ return api\('POST', '\/api\/broker-portal-invite', data\); \}/.test(API) && /'\/api\/broker-portal-invite' \+ \(qs\.length/.test(API));
    assert('the redirect exists', /from = "\/api\/broker-portal-invite"\s*\n\s*to = "\/\.netlify\/functions\/broker-portal-invite"/.test(read('netlify.toml')));
  }
}

// ── E. the save path never turns a borrower into a broker ──────────────────
console.log('\nbroker-link: an email match never turns a borrower\'s record into a broker');
{
  const mk = (blobs, hitFor) => {
    const w = { writes: [], lookups: [] };
    w.fn = loadFunction('_shared/broker-link.mjs', {
      '@netlify/blobs': { getStore: () => ({ get: async (k) => blobs[k] || null }) },
      './auth.mjs': { keySafe, normalizeEmail },
      './client-write.mjs': { writeClient: async (ownerKey, c) => { w.writes.push(JSON.parse(JSON.stringify(c))); } },
      './client-lookup.mjs': { findClientByEmail: async (ownerKey, email, store, opts) => { w.lookups.push(opts); const c = hitFor[email]; return c ? { key: ownerKey + '/' + c.id, client: c } : null; } },
      './broker-client.mjs': { clientAsBroker: (c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' '), company: c._brokerCompany || '', email: c.email || '', phone: c.phone || '' }) },
      './supabase-db.mjs': { db: { select: async () => [] } },
    });
    return w;
  };
  // (a) the email is on a BORROWER (has loans, not flagged)
  let borrower = { id: 'c_k', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', loans: [{ id: 'l_1' }] };
  let w = mk({ 'lo1/c_k': borrower }, { 'k@x.com': borrower });
  let r = await (await w.fn).linkOrCreateBroker('lo1', { brokerName: 'Kandiah Lingan', brokerEmail: 'k@x.com', brokerCompany: 'K Co' });
  check('a borrower with the broker\'s email is NOT adopted: a separate broker record is created, the borrower untouched', [r && r.created, r && /^b_/.test(r.id), r && r.id !== 'c_k', w.writes.length, w.writes[0] && w.writes[0]._isBroker, w.writes[0] && w.writes[0].id !== 'c_k', borrower._isBroker, w.lookups[0]], [true, true, true, 1, true, true, undefined, { prefer: 'broker' }]);
  // (b) a bare contact (no loans) is still adopted, as before
  let contact = { id: 'c_bare', firstName: 'Bo', lastName: 'Broker', email: 'bo@b.com', loans: [] };
  w = mk({ 'lo1/c_bare': contact }, { 'bo@b.com': contact });
  r = await (await w.fn).linkOrCreateBroker('lo1', { brokerName: 'Bo Broker', brokerEmail: 'bo@b.com', brokerCompany: 'Bo Co' });
  check('a bare contact (no loans) with the email is adopted and flagged, as before', [r && r.created, r && r.id, contact._isBroker, w.writes.length, w.writes[0] && w.writes[0].id], [false, 'c_bare', true, 1, 'c_bare']);
  // (c) an existing broker record is reused, nothing written
  let broker = { id: 'b_1', firstName: 'Bo', lastName: 'Broker', email: 'bo@b.com', _isBroker: true, loans: [] };
  w = mk({ 'lo1/b_1': broker }, { 'bo@b.com': broker });
  r = await (await w.fn).linkOrCreateBroker('lo1', { brokerName: 'Bo Broker', brokerEmail: 'bo@b.com' });
  check('a broker record is reused with no write', [r && r.created, r && r.id, w.writes.length], [false, 'b_1', 0]);
  // (d) a brokerId that points at a borrower's record is not adopted either
  borrower = { id: 'c_k', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', loans: [{ id: 'l_1' }] };
  w = mk({ 'lo1/c_k': borrower }, {});
  r = await (await w.fn).linkOrCreateBroker('lo1', { brokerId: 'c_k', brokerName: 'Some Broker', brokerEmail: 'sb@x.com' });
  check('a brokerId pointing at a borrower record is treated as dangling: a real broker record is made instead', [r && r.created, r && r.id !== 'c_k', borrower._isBroker, w.writes.length], [true, true, undefined, 1]);
  // the lookup: which record wins when one email is on both
  {
    const rows = [{ id: 'c_k', email: 'k@x.com', is_broker: false }, { id: 'b_k', email: 'k@x.com', is_broker: true }];
    const blobs = { 'lo1/c_k': { id: 'c_k' }, 'lo1/b_k': { id: 'b_k' } };
    const lk = await loadFunction('_shared/client-lookup.mjs', {
      '@netlify/blobs': { getStore: () => ({ get: async (k) => blobs[k] || null }) },
      './auth.mjs': { keySafe, normalizeEmail },
      './supabase-db.mjs': { db: { select: async () => rows.slice() } },
    });
    const a = await lk.findClientByEmail('lo1', 'k@x.com', { get: async (k) => blobs[k] || null });
    const b = await lk.findClientByEmail('lo1', 'k@x.com', { get: async (k) => blobs[k] || null }, { prefer: 'broker' });
    const c = await lk.findClientByEmail('lo1', 'k@x.com', { get: async (k) => blobs[k] || null }, { prefer: 'borrower' });
    check('one email on a borrower AND a broker: borrower flows get the borrower, broker-link gets the broker', [a && a.client.id, b && b.client.id, c && c.client.id], ['c_k', 'b_k', 'c_k']);
    rows.reverse();
    const d = await lk.findClientByEmail('lo1', 'k@x.com', { get: async (k) => blobs[k] || null });
    check('...whatever order PG returns them in', [d && d.client.id], ['c_k']);
  }
  check('broker-link and client-lookup import everything they call', [declaredCheck('_shared/broker-link.mjs'), declaredCheck('_shared/client-lookup.mjs')], [[], []]);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
