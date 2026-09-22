#!/usr/bin/env node
/**
 * scripts/broker-portal-test.mjs — Deploy 237.234 (Mike)
 *
 * Mike: "a simplified version [of the broker portal] right now that doesn't have the sizers
 * yet but allows them to login, see their loans that are in processing with borrowers, and
 * upload documents on behalf of those borrowers ... a list of their quoted loans with the
 * terms being negotiated."
 *
 * What would hurt, so what this guards (the real functions are loaded with their imports
 * stubbed and RUN — the harness in scripts/review-path-run-test.mjs):
 *   1. A broker seeing a loan that is not theirs (another broker's, or a loan whose mirror
 *      row is stale), or an LO-internal field (notes, buy rate) leaving in the projection.
 *   2. A loan of theirs missing because the same broker exists as a second client record
 *      under another LO.
 *   3. A broker who signs in at "/" landing on the borrower portal (the old bounce).
 *   4. An invite that says "emailed" without a send, or a send that leaks the link into
 *      the wrong address.
 *
 * Run: node scripts/broker-portal-test.mjs
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

// ── 1. the broker's loans ───────────────────────────────────────────────────
console.log('\n/api/broker-loans: the partner\'s loans, grouped, borrower-safe');
{
  const { _borrowerStage, _deriveSlaDisplayId } = await import('../deploy/netlify/functions/borrower-portal-loans.mjs').catch(() => ({}));
  const blobs = {
    'lo1/c_b1': { id: 'c_b1', firstName: 'Bo', lastName: 'Broker', email: 'bo@brokerage.com', _isBroker: true, loans: [] },
    'lo1/c_1': { id: 'c_1', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', loans: [
      { id: 'l_1', address: '634 Luna Court, Jacksonville, FL', brokerId: 'c_b1', processingStage: 'processing', status: 'active', toolType: 'rtl', loanType: 'Light Rehab', loanAmt: '206000', rate: '11', points: '2', brokerFee: '1', purchasePrice: '140000', rehabBudget: '89000', docsActive: 20, docsCollected: 7, openConditions: 1, vestingLLCs: [{ name: 'Revive Jax LLC' }], notesLog: [{ text: 'LO private note' }], buyRate: 9.5, updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'l_2', address: '10 Quote St, Tampa, FL', brokerId: 'c_b1', status: 'active', toolType: 'dscr', loanAmt: '300000', rate: '7.25', points: '1', updatedAt: '2026-09-21T00:00:00Z' },
      { id: 'l_3', address: '5 Other Broker Ave', brokerId: 'c_OTHER', processingStage: 'processing', status: 'active', updatedAt: '2026-09-22T00:00:00Z' },
      { id: 'l_4', address: '9 Closed Rd', brokerId: 'c_b1', status: 'closed', processingStage: 'pp_closed', loanAmt: '100000', updatedAt: '2026-08-01T00:00:00Z' },
    ] },
    'lo2/c_9': { id: 'c_9', firstName: 'Ann', lastName: 'Other', email: 'ann@x.com', loans: [
      { id: 'l_5', address: '77 Second LO Way', brokerId: 'c_b2', processingStage: 'underwriting', status: 'active', loanAmt: '400000', updatedAt: '2026-09-19T00:00:00Z' },
      { id: 'l_6', address: '88 Stale Mirror Ln', brokerId: 'c_SOMEONE_ELSE', processingStage: 'processing', status: 'active', updatedAt: '2026-09-19T00:00:00Z' },
    ] },
  };
  const pg = {
    clients: [{ id: 'c_b1', is_broker: true, email: 'bo@brokerage.com' }, { id: 'c_b2', is_broker: true, email: 'BO@Brokerage.com' }, { id: 'c_nb', is_broker: false, email: 'bo@brokerage.com' }],
    loans: [
      { id: 'l_1', client_id: 'c_1', owner_email: 'lo1', broker_id: 'c_b1' }, { id: 'l_2', client_id: 'c_1', owner_email: 'lo1', broker_id: 'c_b1' },
      { id: 'l_4', client_id: 'c_1', owner_email: 'lo1', broker_id: 'c_b1' }, { id: 'l_5', client_id: 'c_9', owner_email: 'lo2', broker_id: 'c_b2' },
      { id: 'l_6', client_id: 'c_9', owner_email: 'lo2', broker_id: 'c_b2' }, // stale: the blob says someone else
    ],
  };
  const queries = [], grantCalls = [];
  const mk = (opts) => loadFunction('broker-loans.mjs', {
    '@netlify/blobs': { getStore: () => ({ get: async (k) => blobs[k] ? JSON.parse(JSON.stringify(blobs[k])) : null }) },
    './_shared/loan-access-store.mjs': { listAccessibleLoans: async () => [], grantLoanAccess: async (g) => { grantCalls.push([opts.user.email, g.loanId, g.role]); }, revokeLoanAccess: async () => {} },
    './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => opts.user, isAdmin: (u) => !!(u && u.admin), normalizeEmail: (s) => String(s || '').trim().toLowerCase(), keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_') },
    './_shared/access.mjs': { isBrokerRole: (u) => !!(u && u.broker) },
    './_shared/broker-partners.mjs': { getPartner: async (e) => (e === 'bo@brokerage.com' ? { email: e, clientId: 'c_b1', ownerKey: 'lo1', company: 'Bo Brokerage', firstName: 'Bo', lastName: 'Broker', status: opts.status || 'approved' } : null), checkPartnerAccess: async () => (opts.status && opts.status !== 'approved' ? { ok: false, reason: 'Partner application is still pending approval' } : { ok: true }) },
    './_shared/sla-rep.mjs': { getRep: async (k) => ({ email: k + '@slacapital.com', name: 'Rep One', phone: '555' }) },
    './_shared/supabase-db.mjs': { db: { select: async (table, q) => { queries.push([table, q]); if (table === 'clients') return pg.clients.filter((c) => c.email.toLowerCase() === String(q.ilike.email).toLowerCase()); if (table === 'loans') return pg.loans.filter((l) => q.in.broker_id.includes(l.broker_id)); return []; } } },
    './borrower-portal-loans.mjs': { _borrowerStage, _deriveSlaDisplayId },
  });
  let fn = (await mk({ user: { email: 'bo@brokerage.com', broker: true } })).default;
  let r = await fn(req('GET', 'https://portal.slacapital.ai/api/broker-loans'), {});
  check('a partner gets 200', r.status, 200);
  check('every broker client record with their email counts, plus the partner link (the non-broker record with the same email does not)', r.body.brokerIds.sort(), ['c_b1', 'c_b2']);
  check('grouped: in processing / quoted / closed', [r.body.groups.processing.map((l) => l.loanId), r.body.groups.quoted.map((l) => l.loanId), r.body.groups.closed.map((l) => l.loanId)], [['l_1', 'l_5'], ['l_2'], ['l_4']]);
  check('another broker\'s loan, and a loan whose mirror row is stale, are not theirs', JSON.stringify(r.body.groups).indexOf('l_3') < 0 && JSON.stringify(r.body.groups).indexOf('l_6') < 0, true);
  const l1 = r.body.groups.processing.find((l) => l.loanId === 'l_1');
  check('the terms being negotiated, the borrower and the entity, the document counts', [l1.loanAmt, l1.rate, l1.points, l1.brokerFee, l1.borrower, l1.entity, l1.docsCollected + '/' + l1.docsActive, l1.openConditions, l1.stage.label], ['206000', '11', '2', '1', 'Kandiah Lingan', 'Revive Jax LLC', '7/20', 1, 'Document Collection']);
  check('...and what the documents page needs to open it', [l1.clientId, l1.ownerKey, !!l1.slaDisplayId], ['c_1', 'lo1', true]);
  assert('nothing LO-internal leaves (notes, buy rate, the raw record)', !('notesLog' in l1) && !('buyRate' in l1) && !('notes' in l1) && Object.keys(l1).length < 40);
  check('the rep rides along', r.body.rep.name, 'Rep One');
  check('the partner was granted the intake page for each loan in processing, as broker', grantCalls.slice().sort(), [['bo@brokerage.com', 'l_1', 'broker'], ['bo@brokerage.com', 'l_5', 'broker']]);
  grantCalls.length = 0;
  fn = (await mk({ user: { email: 'nobody@x.com', broker: false } })).default;
  r = await fn(req('GET', 'https://x/api/broker-loans'), {});
  check('a signed-in user without the broker role: 403', r.status, 403);
  fn = (await mk({ user: { email: 'bo@brokerage.com', broker: true }, status: 'pending' })).default;
  r = await fn(req('GET', 'https://x/api/broker-loans'), {});
  check('a pending partner: 403 with the code the page reads', [r.status, r.body.code], [403, 'partner_not_approved']);
  fn = (await mk({ user: { email: 'mike@slacapital.com', admin: true } })).default;
  r = await fn(req('GET', 'https://x/api/broker-loans?as=bo@brokerage.com'), {});
  check('an admin previews a partner with ?as', [r.status, r.body.mode, r.body.groups.processing.length], [200, 'admin-preview', 2]);
  check('...and a preview grants NOTHING (the grant would carry the admin\'s email, or the partner\'s without them asking)', grantCalls, []);
  r = await fn(req('GET', 'https://x/api/broker-loans'), {});
  check('...and gets nothing without it (there is no "all brokers" list here)', r.status, 400);
}

// ── 2. the invite, emailed ──────────────────────────────────────────────────
console.log('\nThe desk can email the invite');
{
  const sent = [];
  const mk = (fetchImpl) => loadFunction('broker-partner-save.mjs', {
    './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => ({ email: 'mike@slacapital.com' }), readJsonBody: async (r) => r.body, isAdmin: () => true, normalizeEmail: (s) => String(s || '').trim().toLowerCase() },
    './_shared/broker-partners.mjs': { getPartner: async (e) => ({ email: e, firstName: 'Bo', status: 'approved' }), mintInvite: async (e) => ({ email: e, firstName: 'Bo', inviteToken: 'tok123' }), ALL_PROGRAMS: ['dscr', 'rtl', 'guc', 'mf'] },
  }, { fetch: fetchImpl });
  let fn = (await mk(async (url, o) => { sent.push([url, JSON.parse(o.body)]); return { ok: true, text: async () => '' }; })).default;
  let r = await fn(req('POST', 'https://portal.slacapital.ai/api/broker-partner-save', {}, { email: 'bo@brokerage.com', action: 'invite' }), {});
  check('a plain invite mints the link and emails NOBODY', [r.status, r.body.emailed, sent.length, r.body.inviteUrl], [200, false, 0, 'https://portal.slacapital.ai/broker-signup.html?t=tok123']);
  r = await fn(req('POST', 'https://portal.slacapital.ai/api/broker-partner-save', {}, { email: 'bo@brokerage.com', action: 'invite', send: true }), {});
  check('send: true emails the partner the same link, reply-to the inviting admin', [r.body.emailed, sent[0][1].to, sent[0][1].reply_to, sent[0][1].text.indexOf(r.body.inviteUrl) >= 0, sent[0][1].html.indexOf(r.body.inviteUrl) >= 0], [true, ['bo@brokerage.com'], 'mike@slacapital.com', true, true]);
  fn = (await mk(async () => ({ ok: false, status: 422, text: async () => 'bad address' }))).default;
  r = await fn(req('POST', 'https://x/api/broker-partner-save', {}, { email: 'bo@brokerage.com', action: 'invite', send: true }), {});
  check('a failed send says so and still hands back the link', [r.status, r.body.emailed, /422/.test(r.body.emailError), !!r.body.inviteUrl], [200, false, true, true]);
  const desk = read('broker-partners.html');
  assert('the desk offers "Email it" and never sends without the click', /action: 'invite', send: true/.test(desk) && /function emailInvite/.test(desk) && !/action: 'invite', send: true \}\)\.then[\s\S]{0,40}invite\(/.test(desk));
}

// ── 3. where a broker lands ─────────────────────────────────────────────────
console.log('\nSign-in routing');
{
  const IDX = read('index.html');
  const a = IDX.indexOf('      if (user) {\n        var _em = String(user.email'), z = IDX.indexOf('      loginScreen.style.display = \'none\';', a);
  assert('the routing block was found', a > 0 && z > a);
  const run = (user) => {
    const c = { user, gone: '', getRoles: (u) => u.roles || [], isProcessor: (u) => (u.roles || []).some((r) => r === 'processor' || r === 'admin'), isAdmin: (u) => (u.roles || []).includes('admin'), isSuperAdmin: () => false, String };
    c.window = { location: { replace: (h) => { c.gone = h; } } };
    vm.createContext(c);
    try { vm.runInContext('(function(){' + IDX.slice(a, z) + '})()', c); } catch (e) { return 'threw ' + e.message; }
    return c.gone;
  };
  check('a broker lands on the broker portal', run({ email: 'bo@brokerage.com', roles: ['broker'] }), '/broker-portal.html');
  check('a borrower still lands on the borrower portal', run({ email: 'b@x.com', roles: ['borrower'] }), '/borrower-portal.html');
  check('staff stay', [run({ email: 'p@slacapital.com', roles: ['processor'] }), run({ email: 'lo@slacapital.com', roles: [] })], ['', '']);
  assert('the "Broker" choice on portal-select goes to the portal, not the coming-soon page', /href="\/broker-portal\.html"/.test(read('portal-select.html')) && !/href="\/broker-coming-soon\.html"/.test(read('portal-select.html')));
  const P = read('broker-portal.html');
  assert('the portal page loads no pricing module and asks /api/broker-loans', !/-pricing\.js/.test(P) && /\/api\/broker-loans/.test(P));
  assert('each loan in processing links to the borrower\'s document page as the broker', /borrower-intake\.html\?loanId=[^"]*via=broker/.test(P));
  assert('an unsigned visitor is sent to sign in', /if \(!user\) \{ window\.location\.replace\('\/'\); return; \}/.test(P));
  assert('sign-out signs out of Supabase BEFORE going to "/" (which would route a signed-in broker straight back)', /signOut\(\)\.then\(done, done\)/.test(P));
  assert('the application link carries the broker and their rep', /\/apply\.html\?broker=/.test(P) && /&lo=/.test(P));
  const toml = read('netlify.toml');
  assert('the redirect exists', /from = "\/api\/broker-loans"\s*\n\s*to = "\/\.netlify\/functions\/broker-loans"/.test(toml));
}

// ── 4. the broker opens the borrower's document page ────────────────────────
console.log('\nOpening a loan in processing: a loan-access grant, role broker, kept in sync');
{
  const calls = [];
  const grants = [{ loanId: 'l_old', role: 'broker' }, { loanId: 'l_keep', role: 'broker' }, { loanId: 'l_given', role: 'borrower' }];
  const ns = await loadFunction('broker-loans.mjs', {
    './_shared/loan-access-store.mjs': {
      listAccessibleLoans: async () => grants,
      grantLoanAccess: async (g) => { calls.push(['grant', g.loanId, g.role, g.primaryClientId, g.ownerKey, g.grantedBy]); },
      revokeLoanAccess: async (g) => { calls.push(['revoke', g.loanId, g.revokedBy]); },
    },
    './_shared/auth.mjs': { normalizeEmail: (s) => String(s || '').toLowerCase(), keySafe: (s) => s },
  });
  await ns.syncGrants('bo@brokerage.com', [{ loanId: 'l_keep', clientId: 'c_1', ownerKey: 'lo1' }, { loanId: 'l_new', clientId: 'c_2', ownerKey: 'lo2' }]);
  check('a new loan in processing is granted (role broker); a loan no longer theirs is revoked; a grant someone gave them on purpose is left alone; one they hold already is not re-granted',
    calls.sort(), [['grant', 'l_new', 'broker', 'c_2', 'lo2', 'broker-portal'], ['revoke', 'l_old', 'broker-portal']]);

  // the real grant reader, against a fake store
  const store = { 'bo_brokerage_com': { grants: [{ loanId: 'l_1', role: 'broker', primaryClientId: 'c_1', ownerKey: 'lo1' }, { loanId: 'l_2', role: 'broker', revokedAt: 'T' }] } };
  const LA = await loadFunction('_shared/loan-access-store.mjs', {
    '@netlify/blobs': { getStore: () => ({ get: async (k) => store[k] || null }) },
    './auth.mjs': { keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_'), normalizeEmail: (s) => String(s || '').toLowerCase() },
  });
  check('getLoanGrant returns the live grant with its role, null when revoked or absent', [await LA.getLoanGrant('Bo@Brokerage.com', 'l_1'), await LA.getLoanGrant('bo@brokerage.com', 'l_2'), await LA.getLoanGrant('bo@brokerage.com', 'l_9')],
    [{ loanId: 'l_1', primaryClientId: 'c_1', ownerKey: 'lo1', role: 'broker', grantedAt: '' }, null, null]);

  // the intake endpoints: what they say and do for a broker. A missing import is invisible
  // to node --check (the rateEl class) -- every helper each file calls must be imported.
  const declared = (src) => { const names = new Set(); for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => names.add(n)); for (const m of src.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]); for (const m of src.matchAll(/^(?:const|let|var)\s+(\w+)/gm)) names.add(m[1]); return names; };
  const ST = readFn('borrower-intake-status.mjs'), UP = readFn('borrower-intake-upload.mjs');
  check('intake-status: every helper the viewer block calls is imported', ['isAdmin', 'normalizeEmail', 'keySafe', 'getLoanGrant'].filter((n) => !declared(ST).has(n)), []);
  check('intake-upload: same', ['getLoanGrant', 'normalizeEmail', '_borrowerNameFor', '_uploaderName'].filter((n) => !declared(UP).has(n)), []);
  assert('intake-status tells the page whose documents these are and who is looking', /borrower: _bName,\s*\n\s*entity: _entity,\s*\n\s*viewer: \{ role: viewerRole, email: normalizeEmail\(user\.email\) \}/.test(ST));
  assert('...the role comes from the grant, else staff', /if \(g && g\.role\) viewerRole = g\.role;/.test(ST) && /viewerRole = 'staff'/.test(ST));
  assert('intake-upload reads the grant role right after the loan is authorized, before any write', UP.indexOf('const _grantRole =') > UP.indexOf('await canReadLoan(user') && UP.indexOf('const _grantRole =') < UP.indexOf('uploadedVia:'));
  assert('...a broker upload is recorded as one, on the tray and in the AI note', /uploadedVia: _grantRole === 'broker' \? 'broker' : 'borrower'/.test(UP) && /uploadedByBroker: normalizeEmail\(user\.email\)/.test(UP) && /\(broker upload\)/.test(UP));
  assert('...and the bell says who, for whom', /' \\u2014 broker, for ' \+ \(_borrowerNameFor\(client\)/.test(UP));

  const IN = read('borrower-intake.html');
  assert('the page paints "on behalf of" from the server\'s answer, not the URL', /function _paintOnBehalf\(data\)/.test(IN) && /_asBroker = !!\(data && data\.viewer && data\.viewer\.role === 'broker'\)/.test(IN) && /_paintOnBehalf\(data\);/.test(IN));
  assert('...with the borrower named and the address', /You are uploading on behalf of ' \+ escH\(data\.borrower \|\| who\)/.test(IN));
  assert('...and the back link goes to the broker portal', /back\.setAttribute\('href', '\/broker-portal'\)/.test(IN));
}

// ── 5. an application started from the portal is the broker's ──────────────
console.log('\napply.html?broker=');
{
  const AP = read('apply.html');
  const a = AP.indexOf('  var brokerFromUrl = '), z = AP.indexOf("  var refFromUrl = (params.get('ref') || '').trim();");
  assert('the prefill block was found', a > 0 && z > a);
  const run = (query) => {
    const els = {}, hidden = [], calls = [];
    const el = (id) => (els[id] = els[id] || { value: '', readOnly: false, style: {} });
    const c = { params: new URLSearchParams(query), setSubmitter: (t) => calls.push(t), setTimeout: (fn) => fn(), URLSearchParams,
      document: { getElementById: (id) => el(id), querySelector: (sel) => ({ style: { set display(v) { hidden.push(sel + ':' + v); } } }) } };
    vm.createContext(c);
    vm.runInContext(AP.slice(a, z), c);
    return { els, hidden, calls };
  };
  let r = run('?lo=rep@slacapital.com&broker=Bo%40Brokerage.com&brokerName=Bo%20Broker&brokerCompany=Bo%20Brokerage&brokerPhone=555-0100');
  check('broker mode is chosen for them, the broker filled in, the email locked', [r.calls, r.els.brokerEmail.value, r.els.brokerEmail.readOnly, r.els.brokerName.value, r.els.brokerCompany.value, r.els.brokerPhone.value, r.hidden], [['broker'], 'bo@brokerage.com', true, 'Bo Broker', 'Bo Brokerage', '555-0100', ['.submitter-card:none']]);
  r = run('?lo=rep@slacapital.com');
  check('no broker param: the form is untouched', [r.calls, Object.keys(r.els)], [[], []]);
  r = run('?broker=not-an-email');
  check('a malformed broker value is ignored', r.calls, []);
  assert('prospects-save still routes a broker submission on the broker email and stamps brokerId on the loan (unchanged)', /brokerEmail/.test(readFn('prospects-save.mjs')) && /loan\.brokerId = linked\.id/.test(readFn('prospects-save.mjs')));
}

// ── 6. the polishes (Deploy 237.235): program labels + the rep on each loan ─
console.log('\nProgram labels as Loan Details prints them; reps per loan');
{
  const ns = await loadFunction('broker-loans.mjs', { './_shared/auth.mjs': { normalizeEmail: (s) => String(s || '').toLowerCase(), keySafe: (s) => s } });
  check('RTL types by code', ['light', 'heavy', 'bridge', 'transactional', 'construction'].map((c) => ns.programLabel({ toolType: 'rtl', loanType: c })),
    ['Light Rehab (<50% of Loan)', 'Heavy Rehab (>50% of Loan)', 'Bridge (No Rehab)', 'Transactional Funding (1-day)', 'Construction']);
  check('a stored loanTypeLabel (what the sizer captured) wins', ns.programLabel({ toolType: 'rtl', loanType: 'light', loanTypeLabel: 'Light Rehab' }), 'Light Rehab');
  check('DSCR with and without a product; 5+ unit', [ns.programLabel({ toolType: 'dscr', loanType: '30Y Fixed' }), ns.programLabel({ toolType: 'dscr' }), ns.programLabel({ toolType: 'dscr', mfProgram: true, loanType: '7/6 ARM' })], ['DSCR · 30-Year Fixed', 'DSCR', 'DSCR 5+ Unit · 7/6 ARM']);
  check('GUC; an unknown RTL code falls back to the family, never the raw code', [ns.programLabel({ toolType: 'guc', loanType: 'construction' }), ns.programLabel({ toolType: 'rtl', loanType: 'zzz' })], ['Ground-Up Construction', 'Bridge / Rehab']);
  check('purpose', ['purchase', 'cashout', 'rateterm', ''].map((p) => ns.purposeLabel({ loanPurpose: p })), ['Purchase', 'Cash-Out Refinance', 'Rate/Term Refinance', '']);
  const P = read('broker-portal.html');
  // Lift the page's helpers + card/rep renderers and RUN them against a fake DOM (a grep for
  // their shape missed three of six negative mutations).
  {
    const lift = (name) => { const m = new RegExp('\\n(function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\})\\n').exec(P); if (!m) throw new Error('page function ' + name + ' not found'); return m[1]; };
    const oneLine = (name) => { const m = new RegExp('\\nfunction ' + name + '\\([^)]*\\)\\{[^\\n]*\\}').exec(P); if (!m) throw new Error('page function ' + name + ' not found'); return m[0]; };
    const src = ['escH', 'escA', 'money', 'pct', 'pts', 'fmtDate', 'program', 'repOf', 'multiRep'].map(oneLine).join('\n') + '\n' +
      ['stageChip', 'intakeHref', 'loanCard', 'repHtml', 'renderRep'].map(lift).join('\n');
    const mkEl = () => { const el = { style: {}, innerHTML: '', textContent: '' }; el.querySelector = () => el.h2 || (el.h2 = mkEl()); return el; };
    const dom = { repCard: mkEl(), repBody: mkEl() };
    const c = { ME: null, document: { getElementById: (id) => dom[id] || null }, encodeURIComponent, location: { search: '' } };
    c.window = c;
    vm.createContext(c);
    let ok = true, why = '';
    try { vm.runInContext(src, c); } catch (e) { ok = false; why = 'page code threw: ' + e.message; }
    const run = (js) => { try { return vm.runInContext(js, c); } catch (e) { why = 'threw: ' + e.message; return ''; } };
    const rep1 = { email: 'a@sla.com', name: 'Rep A' }, rep2 = { email: 'b@sla.com', name: 'Rep B' };
    const loan = { loanId: 'l_1', clientId: 'c_1', ownerKey: 'b_at_sla_com', program: 'Light Rehab (<50% of Loan)', loanType: 'light', purposeLabel: 'Purchase', address: '1 Main St', slaDisplayId: 'SLA-1', stage: { key: 'processing', label: 'Document Collection' } };
    assert('the page prints the server\'s label, not the raw code', ok && run('program(' + JSON.stringify(loan) + ')') === 'Light Rehab (<50% of Loan)' && run('program({loanType:"light"})') === 'light', why);
    c.ME = { reps: { b_at_sla_com: rep2 }, rep: rep2 }; // the loan's own rep IS known -- only the single-rep rule keeps it off the card
    const oneRepCard = String(run('loanCard(' + JSON.stringify(loan) + ', "processing")'));
    c.ME = { reps: { a_at_sla_com: rep1, b_at_sla_com: rep2 }, rep: rep1 };
    const twoRepCard = String(run('loanCard(' + JSON.stringify(loan) + ', "processing")'));
    assert('the loan\'s rep is named only when the broker works with more than one rep', ok && !/Rep:/.test(oneRepCard) && /Rep: Rep B/.test(twoRepCard) && /Purpose/.test(twoRepCard) && /Light Rehab/.test(twoRepCard), why || ('one=' + oneRepCard.slice(0, 220) + ' two=' + twoRepCard.slice(0, 220)));
    run('renderRep(' + JSON.stringify(rep1) + ')');
    const two = dom.repBody.innerHTML, twoHead = dom.repCard.h2 && dom.repCard.h2.textContent;
    c.ME = { reps: { a_at_sla_com: rep1 }, rep: rep1 };
    run('renderRep(' + JSON.stringify(rep1) + ')');
    const one = dom.repBody.innerHTML, oneHead = dom.repCard.h2 && dom.repCard.h2.textContent;
    assert('...and the rep card lists every rep, the inviting rep first, each once', ok && two.indexOf('Rep A') >= 0 && two.indexOf('Rep B') > two.indexOf('Rep A') && twoHead === 'Your Sir Lends A Lot Reps' && one.indexOf('Rep B') < 0 && (one.match(/Rep A/g) || []).length === 1 && oneHead === 'Your Sir Lends A Lot Rep', why || ('two=' + two + ' one=' + one));
  }
  const BL = readFn('broker-loans.mjs');
  assert('reps are resolved per owner on the list (their own reps, never the roster)', /reps\[l\.ownerKey\] = await getRep\(l\.ownerKey\)/.test(BL) && /repKey: normalizeEmail\(partner\.ownerKey \|\| ''\), reps,/.test(BL) && !/listRepsPublic/.test(BL));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
