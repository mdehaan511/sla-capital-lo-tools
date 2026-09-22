#!/usr/bin/env node
/**
 * scripts/broker-loan-advance-test.mjs — Deploy 237.238 (Mike)
 *
 * Mike: "I am trying to force push my test loan to processing and getting this modal even
 * though you can see the guarantor and entity in the background." … "hopefully we can
 * finally be done with these broker/borrower mix ups!"
 *
 * The loan carried its guarantor in `guarantorClientIds` (what the Contacts tab renders) but
 * not in the flat `guarantors[]` (what the advance gate, the rate-sheet signer and the sizer
 * PDFs read), and `_borrowerInfoPending` stayed true. What this guards (the real functions
 * are loaded with their imports stubbed and RUN):
 *   1. Linking a guarantor client fills the flat array; loans linked before are backfilled on
 *      their way into processing and the pending flag clears.
 *   2. The Loan Details gate never disagrees with the Contacts tab again.
 *   3. On a broker-parent loan nothing reads the broker as the borrower: the vesting entity,
 *      the broker portal's borrower/entity, and search results.
 *
 * Run: node scripts/broker-loan-advance-test.mjs
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
const keySafe = (s) => String(s || '').replace(/[:/\\]/g, '_').replace(/^\.+/, '').slice(0, 128);
const normalizeEmail = (s) => String(s || '').trim().toLowerCase();

async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, encodeURIComponent, AbortSignal, Set, Map, parseFloat, isFinite, NaN }, extraGlobals || {}));
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
const lift = (src, start, end) => { const a = src.indexOf(start); if (a < 0) throw new Error('not found: ' + start.slice(0, 50)); const z = src.indexOf(end, a + start.length); return src.slice(a, z + end.length); };

const HELPERS = ['getStore', 'keySafe', 'normalizeEmail', 'writeClient', 'findClientByEmail', 'syncFlatGuarantors', 'hasRealGuarantor', 'pushFlatGuarantor',
  'handleOptions', 'json', 'requireAuth', 'readJsonBody', 'isAdmin', 'canOverrideOwner', 'appendNoteEntry', 'completeAutoTasks', 'diffLoan', 'recordLoanChanges',
  'notifyLoLoanClosed', 'ringClosingBell', 'postSlack', '_pgSelect', '_nameBrokerLoanBorrowers', '_borrowerStage', '_deriveSlaDisplayId', 'getRep'];
function declaredCheck(file) {
  const src = readFn(file);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imported = new Set();
  const re = /import\s*\{([^}]*)\}\s*from/g; let m;
  while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => imported.add(n));
  const local = new Set(); const fre = /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fre.exec(code))) local.add(m[1]);
  return HELPERS.filter((h) => new RegExp('(?<![\\w$.])' + h + '\\s*[(.]').test(code) && !imported.has(h) && !local.has(h));
}

const GL_STUBS = (blobs, writes) => ({
  '@netlify/blobs': { getStore: () => ({ get: async (k) => blobs[k] || null }) },
  './auth.mjs': { keySafe },
  './client-write.mjs': { writeClient: async (ownerKey, c) => { writes.push(JSON.parse(JSON.stringify(c))); } },
  './client-lookup.mjs': { findClientByEmail: async (ownerKey, email) => { const c = Object.values(blobs).find((x) => x && normalizeEmail(x.email) === normalizeEmail(email)); return c ? { key: ownerKey + '/' + c.id, client: c } : null; } },
});

// ── A. guarantor-link: the flat array follows the link ──────────────────────
console.log('\nguarantor-link: linking a guarantor client fills the flat guarantors[] too');
{
  check('guarantor-link imports everything it calls', declaredCheck('_shared/guarantor-link.mjs'), []);
  const writes = [];
  const blobs = { 'lo1/c_k': { id: 'c_k', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', phone: '509', loans: [] } };
  const GL = await loadFunction('_shared/guarantor-link.mjs', GL_STUBS(blobs, writes));
  const primary = { id: 'b_1', _isBroker: true, loans: [] };
  const loan = { id: 'l_1', _isBrokerLoan: true, _borrowerInfoPending: true };
  primary.loans.push(loan);
  let r = await GL.linkGuarantorToLoan({ ownerKey: 'lo1', primaryClientId: 'b_1', loanId: 'l_1', primary, loan, clientsStore: { get: async (k) => blobs[k] || null }, guarantor: { firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', ownershipPct: '50' } });
  check('an existing client is linked AND mirrored into the flat array with its ownership', [r.matchedExistingClient, loan.guarantorClientIds, loan.guarantors], [true, ['c_k'], [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', phone: '509', clientId: 'c_k', ownership: '50' }]]);
  r = await GL.linkGuarantorToLoan({ ownerKey: 'lo1', primaryClientId: 'b_1', loanId: 'l_1', primary, loan, clientsStore: { get: async (k) => blobs[k] || null }, guarantor: { firstName: 'Kandiah', lastName: 'Lingan', email: 'K@X.com' } });
  check('linking the same person again adds nothing twice', [r.alreadyLinked, loan.guarantorClientIds.length, loan.guarantors.length], [true, 1, 1]);
  r = await GL.linkGuarantorToLoan({ ownerKey: 'lo1', primaryClientId: 'b_1', loanId: 'l_1', primary, loan, clientsStore: { get: async (k) => blobs[k] || null }, guarantor: { firstName: 'New', lastName: 'Person', email: 'np@x.com' } });
  // (three writes: the helper persists the guarantor client on every link, as before)
  check('a brand-new guarantor is created, linked and mirrored', [r.matchedExistingClient, loan.guarantorClientIds.length, loan.guarantors[1] && loan.guarantors[1].firstName, loan.guarantors[1] && loan.guarantors[1].clientId === r.guarantor.id, writes.length], [false, 2, 'New', true, 3]);
  assert('the flat array is the same shape loan-add-guarantor keeps (firstName/lastName/email/phone/clientId/ownership)', Object.keys(loan.guarantors[0]).sort().join(',') === 'clientId,email,firstName,lastName,ownership,phone');

  // the backfill for loans linked before this deploy
  const old = { id: 'l_old', _isBrokerLoan: true, guarantorClientIds: ['c_k', 'c_missing', 'c_m'], guarantors: [{ firstName: 'Manual', lastName: 'Entry', email: 'm@x.com', clientId: 'c_m' }], guarantorOwnership: { c_k: 40 } };
  blobs['lo1/c_m'] = { id: 'c_m', firstName: 'Manual', lastName: 'Entry', email: 'm@x.com', loans: [] };
  const added = await GL.syncFlatGuarantors('lo1', old, { get: async (k) => blobs[k] || null });
  check('syncFlatGuarantors mirrors the missing linked clients only, keeps what is there, skips an unreadable id', [added, old.guarantors.map((g) => g.clientId), old.guarantors[1].ownership], [1, ['c_m', 'c_k'], '40']);
  check('hasRealGuarantor: a named entry yes, a blank or empty array no', [GL.hasRealGuarantor(old), GL.hasRealGuarantor({ guarantors: [{}] }), GL.hasRealGuarantor({ guarantors: [] }), GL.hasRealGuarantor({})], [true, false, false, false]);
  check('syncFlatGuarantors with nothing linked does nothing', [await GL.syncFlatGuarantors('lo1', { id: 'x' }, { get: async () => null })], [0]);
}

// ── B. prospects-save: the borrower the broker named is not "pending" ───────
console.log('\nprospects-save: a broker application that names its borrower is not pending');
{
  const PS = readFn('prospects-save.mjs');
  assert('the pending flag is cleared right after the borrower is linked (inside the same try)', /linked borrower guarantor \$\{_bEmail\} to loan \$\{loan\.id\}`\);\s*\n(\s*\/\/.*\n)*\s*loan\._borrowerInfoPending = false;/.test(PS));
  assert('...and only there: a submission with no borrower email stays pending', /_borrowerInfoPending: isBrokerSubmission,/.test(PS) && (PS.match(/_borrowerInfoPending = false/g) || []).length === 1);
}

// ── C. loan-advance-status: the backfill on the way into processing ────────
console.log('\n/api/loan-advance-status: a broker loan\'s linked borrower is mirrored and the flag cleared');
{
  check('loan-advance-status imports everything it calls', declaredCheck('loan-advance-status.mjs'), []);
  const mk = async (blobs) => {
    const writes = [];
    const GL = await loadFunction('_shared/guarantor-link.mjs', GL_STUBS(blobs, []));
    const fn = (await loadFunction('loan-advance-status.mjs', {
      '@netlify/blobs': { getStore: () => ({ get: async (k) => blobs[k] || null }) },
      './_shared/auth.mjs': { handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => ({ email: 'lo1@slacapital.com', app_metadata: { roles: ['loan_officer'] } }), readJsonBody: async (r) => r.body, isAdmin: () => false, keySafe, normalizeEmail },
      './_shared/access.mjs': { canOverrideOwner: () => ({ ok: false }) },
      './_shared/client-write.mjs': { writeClient: async (ownerKey, c) => { writes.push(JSON.parse(JSON.stringify(c))); } },
      './_shared/auto-task-complete.mjs': { completeAutoTasks: async () => ({}) },
      './_shared/loan-change-log.mjs': { diffLoan: () => [], recordLoanChanges: async () => {} },
      './_shared/email.mjs': { notifyLoLoanClosed: async () => {} },
      './_shared/closing-bell.mjs': { ringClosingBell: async () => {} },
      './_shared/notes-log.mjs': { appendNoteEntry: (loan, e) => { loan.notesLog = (loan.notesLog || []).concat([e]); } },
      './_shared/slack.mjs': { postSlack: async () => {} },
      './_shared/guarantor-link.mjs': { syncFlatGuarantors: GL.syncFlatGuarantors, hasRealGuarantor: GL.hasRealGuarantor },
    })).default;
    return { fn, writes };
  };
  const brokerBook = () => ({
    'lo1@slacapital.com/b_1': { id: 'b_1', firstName: 'ZZ Test', lastName: 'Broker', email: 'bt@x.com', _isBroker: true, loans: [
      { id: 'l_1', status: 'active', _isBrokerLoan: true, _borrowerInfoPending: true, guarantors: [], guarantorClientIds: ['c_j'], borrowerName: 'JimTest Testerguy' },
      { id: 'l_2', status: 'active', _isBrokerLoan: true, _borrowerInfoPending: true, guarantors: [], guarantorClientIds: [] },
      { id: 'l_3', status: 'active', guarantors: [], guarantorClientIds: ['c_j'] },
    ] },
    'lo1@slacapital.com/c_j': { id: 'c_j', firstName: 'JimTest', lastName: 'Testerguy', email: 'tester@testmail.com', loans: [] },
  });
  let blobs = brokerBook();
  let { fn, writes } = await mk(blobs);
  let r = await fn(req('POST', 'https://x/api/loan-advance-status', {}, { clientId: 'b_1', loanId: 'l_1', newStatus: 'approved' }), {});
  let l1 = writes[0] && writes[0].loans.find((l) => l.id === 'l_1');
  check('Mike\'s loan: advanced, the linked borrower mirrored into the flat array, the flag cleared, stage stamped', [r.status, r.body.success, l1 && l1.status, l1 && l1.processingStage, l1 && l1.guarantors, l1 && l1._borrowerInfoPending, !!(l1 && l1._brokerBorrowerSyncedAt)], [200, true, 'approved', 'new_loan', [{ firstName: 'JimTest', lastName: 'Testerguy', email: 'tester@testmail.com', phone: '', clientId: 'c_j', ownership: '' }], false, true]);
  blobs = brokerBook(); ({ fn, writes } = await mk(blobs));
  r = await fn(req('POST', 'https://x/api/loan-advance-status', {}, { clientId: 'b_1', loanId: 'l_2', newStatus: 'approved' }), {});
  let l2 = writes[0] && writes[0].loans.find((l) => l.id === 'l_2');
  check('a broker loan with NO linked borrower still advances (the page gates that) but stays pending', [r.status, l2 && l2.status, l2 && l2.guarantors, l2 && l2._borrowerInfoPending], [200, 'approved', [], true]);
  blobs = brokerBook(); ({ fn, writes } = await mk(blobs));
  r = await fn(req('POST', 'https://x/api/loan-advance-status', {}, { clientId: 'b_1', loanId: 'l_3', newStatus: 'approved' }), {});
  let l3 = writes[0] && writes[0].loans.find((l) => l.id === 'l_3');
  check('a non-broker loan is untouched by the sync', [r.status, l3 && l3.guarantors, '_borrowerInfoPending' in (l3 || {}), '_brokerBorrowerSyncedAt' in (l3 || {})], [200, [], false, false]);
}

// ── D. Loan Details: the gate and the vesting entity ───────────────────────
console.log('\nLoan Details: the gate agrees with the Contacts tab; the broker\'s company is not the LLC');
{
  const LD = read('loan-details.js');
  const gate = lift(LD, '\nfunction _brokerLoanNeedsBorrowerInfo() {', '\n}\n');
  const c = { _loan: null }; vm.createContext(c); vm.runInContext(gate, c);
  const ask = (loan) => { c._loan = loan; return vm.runInContext('_brokerLoanNeedsBorrowerInfo()', c); };
  check('the gate: a linked guarantor client is borrower info (Mike\'s loan) -> no modal', ask({ _isBrokerLoan: true, _borrowerInfoPending: true, guarantors: [], guarantorClientIds: ['c_j'] }), false);
  check('...no guarantor anywhere -> modal', ask({ _isBrokerLoan: true, _borrowerInfoPending: true, guarantors: [], guarantorClientIds: [] }), true);
  check('...a blank linked id does not count', ask({ _isBrokerLoan: true, guarantors: [], guarantorClientIds: [''] }), true);
  check('...a named flat entry -> no modal (as before)', ask({ _isBrokerLoan: true, guarantors: [{ firstName: 'A' }] }), false);
  check('...the flag cleared -> no modal; not a broker loan -> no modal', [ask({ _isBrokerLoan: true, _borrowerInfoPending: false }), ask({ _isBrokerLoan: false })], [false, false]);

  const vest = lift(LD, '  function _initialVestingLLCs() {', '\n  }\n');
  const v = { l: {}, c: {}, _bwPrimaryIsBroker: false }; vm.createContext(v); vm.runInContext(vest, v);
  const vestOf = (l, cl, brokerParent) => { v.l = l; v.c = cl; v._bwPrimaryIsBroker = brokerParent; return vm.runInContext('_initialVestingLLCs()', v); };
  check('the vesting entity on a broker-parent loan is NOT the broker\'s company', vestOf({}, { entityName: 'ZZ Test Brokerage LLC', companies: [{ name: 'ZZ Test Brokerage LLC' }] }, true), [{ name: '' }]);
  check('...a borrower parent still auto-fills from their companies / entity name', [vestOf({}, { companies: [{ name: 'Priscilla Company', ein: '12' }] }, false), vestOf({}, { entityName: 'Legacy LLC' }, false)], [[{ name: 'Priscilla Company', ein: '12' }], [{ name: 'Legacy LLC' }]]);
  check('...the loan\'s own vestingLLCs always win, broker parent or not', vestOf({ vestingLLCs: [{ name: 'Real Holdings LLC' }] }, { entityName: 'ZZ Test Brokerage LLC' }, true), [{ name: 'Real Holdings LLC' }]);
  assert('loan-details.html loads a loan-details.js pinned to this deploy or newer', (() => { const m = /loan-details\.js\?v=(\d+|237238)/.exec(read('loan-details.html')); return !!m && (m[1] === '237238' || parseInt(m[1], 10) >= 237237); })());
}

// ── E. the broker portal names the borrower, not the broker ─────────────────
console.log('\nBroker portal: on a broker-parent loan the borrower is the borrower');
{
  check('broker-loans imports everything it calls', declaredCheck('broker-loans.mjs'), []);
  const BL = readFn('broker-loans.mjs');
  const code = lift(BL, '\nfunction entityOf(loan, client) {', '\n}\n') + lift(BL, '\nfunction project(loan, client, ownerKey) {', '\n}\n');
  const c = { normalizeEmail, _borrowerStage: () => ({ key: 'processing', label: 'Document Collection' }), _deriveSlaDisplayId: () => 'SLA-1', programLabel: () => 'P', purposeLabel: () => '' };
  vm.createContext(c); vm.runInContext(code, c);
  const run = (loan, client) => { c.__l = loan; c.__c = client; return vm.runInContext('project(__l, __c, "lo1")', c); };
  const broker = { id: 'b_1', firstName: 'ZZ Test', lastName: 'Broker', email: 'bt@x.com', _isBroker: true, entityName: 'ZZ Test Brokerage LLC' };
  let p = run({ id: 'l_1', _isBrokerLoan: true, guarantors: [{ firstName: 'JimTest', lastName: 'Testerguy', email: 'tester@testmail.com', clientId: 'c_j' }], vestingLLCs: [] }, broker);
  check('broker parent + mirrored guarantor: the borrower is the guarantor, no entity from the broker', [p.borrower, p.borrowerEmail, p.entity], ['JimTest Testerguy', 'tester@testmail.com', '']);
  p = run({ id: 'l_1', _isBrokerLoan: true, guarantors: [], borrowerName: 'JimTest Testerguy', borrowerEmail: 'tester@testmail.com', vestingLLCs: [{ name: 'Real Holdings LLC' }] }, broker);
  check('broker parent, not yet mirrored: the name the broker typed, and the loan\'s own LLC', [p.borrower, p.borrowerEmail, p.entity], ['JimTest Testerguy', 'tester@testmail.com', 'Real Holdings LLC']);
  p = run({ id: 'l_1', _isBrokerLoan: true, guarantors: [], vestingLLCs: [] }, broker);
  check('broker parent with nothing at all: blank, never the broker', [p.borrower, p.borrowerEmail, p.entity], ['', '', '']);
  p = run({ id: 'l_2', brokerId: 'b_1', guarantors: [], vestingLLCs: [] }, { id: 'c_1', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', entityName: 'K Holdings' });
  check('a borrower parent is unchanged: their name, their email, their entity', [p.borrower, p.borrowerEmail, p.entity], ['Kandiah Lingan', 'k@x.com', 'K Holdings']);
  p = run({ id: 'l_3', brokerEmail: 'bt@x.com', guarantors: [{ firstName: 'Only', lastName: 'Guarantor', email: 'og@x.com' }] }, broker);
  check('a legacy broker-parent loan (no flag, broker email = parent email) is caught too', [p.borrower, p.entity], ['Only Guarantor', '']);
}

// ── F. search names the borrower, and the broker as a broker ───────────────
console.log('\nSearch: a broker-parent loan is named after its borrower; the broker reads "(broker)"');
{
  check('search-pg imports everything it calls', declaredCheck('search-pg.mjs'), []);
  const SP = readFn('search-pg.mjs');
  assert('the loan select carries is_broker_loan + guarantor_client_ids', /'is_broker_loan,guarantor_client_ids,'/.test(SP) && /const LOAN_SELECT = [\s\S]*?is_broker_loan,guarantor_client_ids/.test(SP));
  const calls = [];
  const code = lift(SP, '\nfunction _rowToLoanResult(l, selfEmail) {', '\n}\n') + lift(SP, '\nasync function _nameBrokerLoanBorrowers(loans) {', '\n}\n');
  const c = { normalizeEmail, encodeURIComponent, _pgSelect: async (table, qs) => { calls.push([table, qs]); return [{ id: 'c_j', first_name: 'JimTest', last_name: 'Testerguy', email: 'tester@testmail.com' }]; } };
  vm.createContext(c); vm.runInContext(code, c);
  const rows = [
    { id: 'l_1', client_id: 'b_1', owner_email: 'lo1@x', address: '1565 E Farwell', is_broker_loan: true, guarantor_client_ids: ['c_j'], clients: { first_name: 'ZZ Test', last_name: 'Broker', email: 'bt@x.com' } },
    { id: 'l_2', client_id: 'b_1', owner_email: 'lo1@x', address: '2 Main', is_broker_loan: true, guarantor_client_ids: [], clients: { first_name: 'ZZ Test', last_name: 'Broker' } },
    { id: 'l_3', client_id: 'c_1', owner_email: 'lo1@x', address: '3 Main', is_broker_loan: false, guarantor_client_ids: ['c_j'], clients: { first_name: 'Kandiah', last_name: 'Lingan' } },
  ];
  c.__rows = rows;
  const out = vm.runInContext('__rows.map((r) => _rowToLoanResult(r, "lo1@x"))', c);
  check('row conversion: broker-parent loans say "(broker)" and remember their linked guarantors; a borrower row is unchanged', out.map((o) => [o.borrower, o._gids]), [['ZZ Test Broker (broker)', ['c_j']], ['ZZ Test Broker (broker)', []], ['Kandiah Lingan', []]]);
  c.__out = out;
  const named = await vm.runInContext('_nameBrokerLoanBorrowers(__out)', c);
  check('one clients lookup names the borrower on every broker-parent row that has one; the rest keep "(broker)"', [named, calls.length, /id=in\.\(c_j\)/.test(calls[0][1]), out.map((o) => o.borrower)], [1, 1, true, ['JimTest Testerguy', 'ZZ Test Broker (broker)', 'Kandiah Lingan']]);
  calls.length = 0;
  check('no broker-parent rows: no lookup at all', [await vm.runInContext('_nameBrokerLoanBorrowers([{ borrower: "x", _gids: [] }, { borrower: "y" }])', c), calls.length], [0, 0]);
  assert('the handler names them before the response and strips the helper field', /await _nameBrokerLoanBorrowers\(finalLoans\);[\s\S]{0,200}delete l\._gids/.test(SP) && SP.indexOf('_nameBrokerLoanBorrowers(finalLoans)') < SP.indexOf('loans:     finalLoans.slice(0, PER_CATEGORY)'));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
