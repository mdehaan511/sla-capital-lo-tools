#!/usr/bin/env node
/**
 * scripts/sign-housekeeping-test.mjs — Deploy 237.267
 *
 * Sara (2026-09-24): "Hey I didnt get an email today on a completed app" -- 10482 Pinehurst,
 * signed at 9:35 AM during the Supabase outage. The signing handler skipped its follow-ups
 * (emails, lo-notify, app-signed-bell) to protect the signature, recorded them on the
 * application record, and nothing ever finished them; 25 of 208 signings had done the same.
 * Now the handler hands the skipped list to a background job that finishes it.
 *
 * What would hurt, so what this guards (the real functions are loaded with their imports
 * stubbed and RUN):
 *   1. The job sending to the wrong people, or without the signed PDF / the signer's audit.
 *   2. A co-signed application: the interim copy + every co-signer's invite with ITS token,
 *      and no bell / no advance until the last signer.
 *   3. A step that failed staying on the list (so a retry can do it) while the others come
 *      off (so a retry never sends twice); a clean record being a no-op.
 *   4. The job runnable without the internal signature by an admin, and by nobody else.
 *   5. The handler no longer firing the job when it skips, or firing it unsigned.
 *
 * Run: node scripts/sign-housekeeping-test.mjs
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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)));
  if (!ok) fail++;
};
const assert = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fail++; };
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const readFn = (p) => readFileSync(new URL(p, FN), 'utf8');
const jsonStub = (status, body) => ({ status, body, ok: status < 400, json: async () => body });

async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: { URL: 'https://portal.slacapital.ai' } }, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, parseInt, parseFloat, isFinite, encodeURIComponent, AbortSignal }, extraGlobals || {}));
  const namesFor = (spec) => {
    const wanted = new Set();
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m;
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + esc + '[\'"]', 'g');
    while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => wanted.add(n));
    const dre = new RegExp('const\\s*\\{([^}]*)\\}\\s*=\\s*await import\\([\'"]' + esc + '[\'"]\\)', 'g');
    while ((m = dre.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s*:\s*/)[0]).filter(Boolean).forEach((n) => wanted.add(n));
    Object.keys(stubs[spec] || {}).forEach((n) => wanted.add(n));
    return [...wanted];
  };
  const synth = (spec) => {
    const table = stubs[spec] || {};
    const names = namesFor(spec);
    return new vm.SyntheticModule(names, function () { names.forEach((n) => this.setExport(n, (n in table) ? table[n] : (() => undefined))); }, { context: ctx, identifier: spec });
  };
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file, importModuleDynamically: async (spec) => { const m = synth(spec); await m.link(() => {}); await m.evaluate(); return m; } });
  await mod.link(async (spec) => synth(spec));
  await mod.evaluate();
  return mod.namespace;
}
const req = (method, url, headers, body) => ({ method, url, headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || '' }, text: async () => (body == null ? '' : JSON.stringify(body)), body });
const storesFrom = (data) => ({ getStore: ({ name }) => {
  data[name] = data[name] || {};
  const s = data[name];
  return {
    get: async (k, o) => (k in s ? (o && o.type === 'json' && typeof s[k] === 'string' ? JSON.parse(s[k]) : s[k]) : null),
    setJSON: async (k, v) => { s[k] = JSON.parse(JSON.stringify(v)); },
    set: async (k, v) => { s[k] = v; },
    delete: async (k) => { delete s[k]; },
    list: async () => ({ blobs: Object.keys(s).map((key) => ({ key })) }),
  };
} });
const SIG = (id, slug) => 'sig:' + id + ':' + slug;

const KEY = 'sara.s@slacapital.com/c_1783738892128_7az9/l_1790174752500_dvol4v';
const RECORD = (over) => Object.assign({
  clientId: 'c_1783738892128_7az9', loanId: 'l_1790174752500_dvol4v', ownerKey: 'sara.s@slacapital.com', ownerEmail: 'sara.s@slacapital.com', requestedBy: 'sara.s@slacapital.com',
  borrowerEmail: 'synergifund@outlook.com', status: 'complete', signedAt: '2026-09-24T16:35:17.421Z', signedAuditKey: KEY,
  _housekeepingSkipped: ['emails', 'lo-notify', 'app-signed-bell'],
  prefill: { propertyAddress: '10482 Pinehurst Drive, Jacksonville, FL, 32218' }, data: { numGuarantors: '1' },
}, over || {});
const SIGNED = (over) => Object.assign({
  clientId: 'c_1783738892128_7az9', loanId: 'l_1790174752500_dvol4v', ownerKey: 'sara.s@slacapital.com',
  propertyAddress: '10482 Pinehurst Drive, Jacksonville, FL, 32218', status: 'complete', numBorrowers: 1,
  borrower1: { role: 'borrower1', name: 'Kandiah Lingan', email: 'synergifund@outlook.com', audit: { signerName: 'Kandiah Lingan', signerEmail: 'synergifund@outlook.com', signedAt: '2026-09-24T16:35:17.421Z', ipAddress: '1.2.3.4' } },
  borrower2: null, pdfBase64: Buffer.from('%PDF-signed').toString('base64'), pdfSize: 11,
}, over || {});

const mk = (record, signed, opts) => {
  opts = opts || {};
  const data = { borrower_info: { [KEY]: record }, signed_applications: { [KEY]: signed } };
  const w = { data, calls: [] };
  const log = (name) => (a) => { w.calls.push([name, a]); if (opts.fail === name) throw new Error(name + ' exploded'); return opts.returns && name in opts.returns ? opts.returns[name] : true; };
  w.fn = loadFunction('borrower-info-sign-housekeeping-background.mjs', {
    '@netlify/blobs': storesFrom(data),
    './_shared/auth.mjs': { handleOptions: () => null, json: jsonStub, readJsonBody: async (r) => { try { const t = await r.text(); return t ? JSON.parse(t) : {}; } catch (_) { return null; } }, requireAuth: async () => opts.user || null, isAdmin: (u) => !!(u && u.admin) },
    './_shared/review-truth.mjs': { internalBgSig: SIG },
    './_shared/borrower-info-sync.mjs': { syncPropertyFieldsToLoan: log('property-sync'), advanceQuoteToInProcessing: async (r) => { w.calls.push(['advance', r]); return opts.advance || { ok: true, loanUpdated: true }; } },
    './borrower-info-sign.mjs': { emailSignedCopy: log('emailSignedCopy'), emailBorrower2AuthLink: log('emailBorrower2AuthLink'), notifyLOOfSignedApp: (r, audit, o) => { w.calls.push(['notifyLO', { r, audit, o }]); if (opts.fail === 'notifyLO') throw new Error('notifyLO exploded'); return !(opts.returns && opts.returns.notifyLO === false); } },
    './_shared/loan-event-notify.mjs': { notifyDocSignedByIds: log('bell') },
  });
  return w;
};
const post = async (w, body, headers) => (await w.fn).default(req('POST', 'https://portal.slacapital.ai/.netlify/functions/borrower-info-sign-housekeeping-background', headers || { 'x-sla-internal': SIG(KEY, 'sign-housekeeping') }, body), {});
const names = (w) => w.calls.map((c) => c[0]);

console.log('\nSara\'s Pinehurst record: the three skipped steps get finished');
{
  const w = mk(RECORD(), SIGNED());
  const r = await post(w, { recordKey: KEY });
  check('200: the borrower copy, the LO email and the bell, in that order; nothing else', [r.status, names(w), r.body.completed, r.body.failed, r.body.remaining, r.body.via], [200, ['emailSignedCopy', 'notifyLO', 'bell'], ['emails', 'lo-notify', 'app-signed-bell'], [], [], 'internal']);
  const copy = w.calls[0][1], lo = w.calls[1][1], bell = w.calls[2][1];
  check('the borrower copy: to the signer, the FINAL copy, with the signed PDF, under the LO\'s reply-to', [copy.toEmail, copy.toName, copy.isInterim, copy.pdfBuffer.toString(), copy.ownerKey, copy.propertyAddress], ['synergifund@outlook.com', 'Kandiah Lingan', false, '%PDF-signed', 'sara.s@slacapital.com', '10482 Pinehurst Drive, Jacksonville, FL, 32218']);
  check('the LO email: the record (so it resolves to Sara), the signer\'s audit, the PDF, no co-signer', [lo.r.requestedBy, lo.audit.signerName, lo.audit.ipAddress, lo.o.hasB2, lo.o.pdfBuffer.toString()], ['sara.s@slacapital.com', 'Kandiah Lingan', '1.2.3.4', false, '%PDF-signed']);
  check('the bell: the loan, the doc label, the signer', [bell.ownerKey, bell.loanId, bell.docLabel, bell.signer], ['sara.s@slacapital.com', 'l_1790174752500_dvol4v', 'Loan Application', 'Kandiah Lingan']);
  const rec = w.data.borrower_info[KEY];
  check('the record: the skipped list is gone, the completion is recorded with when and how', ['_housekeepingSkipped' in rec, rec._housekeepingCompleted.map((c) => c.step), rec._housekeepingCompleted[0].via, !!rec._housekeepingCompleted[0].at], [false, ['emails', 'lo-notify', 'app-signed-bell'], 'internal', true]);
}

console.log('\nA co-signed application, and the loan-side steps');
{
  const rec2 = RECORD({ status: 'awaiting_b2_signature', signedAt: '', b1SignedAt: '2026-09-24T16:35:17.421Z', b2Token: 'tok-b2', b3Token: '', _housekeepingSkipped: ['emails', 'lo-notify', 'app-signed-bell'] });
  const signed2 = SIGNED({ status: 'awaiting_b2_signature', numBorrowers: 2, borrower2: { role: 'borrower2', name: 'Priya Lingan', email: 'priya@x.com', audit: null } });
  let w = mk(rec2, signed2);
  let r = await post(w, { recordKey: KEY });
  check('two borrowers: the INTERIM copy to borrower 1, the invite to borrower 2 with its token, the LO told a co-signer is pending, NO bell yet', [names(w), w.calls[0][1].isInterim, w.calls[0][1].coBorrowerName, w.calls[1][1].toEmail, w.calls[1][1].token, w.calls[1][1].b1Name, w.calls[2][1].o.hasB2, w.calls[2][1].o.b2Name, r.body.completed], [['emailSignedCopy', 'emailBorrower2AuthLink', 'notifyLO'], true, 'Priya Lingan', 'priya@x.com', 'tok-b2', 'Kandiah Lingan', true, 'Priya Lingan', ['emails', 'lo-notify', 'app-signed-bell']]);
  assert('...the co-signer link is built with a real host, not an empty one', /portal\.slacapital\.ai/.test(w.calls[1][1].req.headers.get('host')) && w.calls[1][1].req.headers.get('x-forwarded-proto') === 'https');
  w = mk(RECORD({ _housekeepingSkipped: ['property-sync', 'advance', 'emails', 'lo-notify', 'app-signed-bell'] }), SIGNED());
  r = await post(w, { recordKey: KEY });
  check('the loan first: property sync, then the advance into processing, then the emails and the bell', [names(w), r.body.completed], [['property-sync', 'advance', 'emailSignedCopy', 'notifyLO', 'bell'], ['property-sync', 'advance', 'emails', 'lo-notify', 'app-signed-bell']]);
  w = mk(RECORD({ _housekeepingSkipped: ['advance'] }), SIGNED(), { advance: { ok: false, reason: 'no loan matched loanId="l_x"' } });
  r = await post(w, { recordKey: KEY });
  check('an advance that finds nothing to advance is not a failure (the loan already moved)', [r.body.completed, r.body.failed], [['advance'], []]);
}

console.log('\nFailures stay on the list; a clean record is a no-op; a retry never sends twice');
{
  let w = mk(RECORD(), SIGNED(), { fail: 'notifyLO' });
  let r = await post(w, { recordKey: KEY });
  check('the LO email throws: the copy and the bell still go, lo-notify stays on the record for a retry', [r.status, r.body.ok, r.body.completed, r.body.failed.map((f) => f.step), r.body.remaining, w.data.borrower_info[KEY]._housekeepingSkipped], [200, false, ['emails', 'app-signed-bell'], ['lo-notify'], ['lo-notify'], ['lo-notify']]);
  w = mk(RECORD(), SIGNED(), { returns: { emailSignedCopy: false } });
  r = await post(w, { recordKey: KEY });
  check('a copy that does not send counts as failed', [r.body.failed.map((f) => f.step), r.body.remaining], [['emails'], ['emails']]);
  w = mk(RECORD({ _housekeepingSkipped: undefined }), SIGNED());
  r = await post(w, { recordKey: KEY });
  check('a record with nothing skipped: no-op, nothing sent', [r.status, r.body.skipped, w.calls.length], [200, 'nothing-to-do', 0]);
  w = mk(RECORD({ _housekeepingSkipped: ['primary-client-write'] }), SIGNED());
  r = await post(w, { recordKey: KEY });
  check('a step this job does not know stays put, nothing sent', [r.status, r.body.skipped, r.body.remaining, w.calls.length], [200, 'nothing-to-do', ['primary-client-write'], 0]);
  w = mk(RECORD(), null);
  r = await post(w, { recordKey: KEY });
  check('no signed PDF on file -> 409, nothing sent', [r.status, w.calls.length], [409, 0]);
}

console.log('\nWho may run it');
{
  let w = mk(RECORD(), SIGNED());
  let r = await post(w, { recordKey: KEY }, { 'x-sla-internal': 'sig:wrong' });
  check('a bad signature and no admin -> 403, nothing sent', [r.status, w.calls.length], [403, 0]);
  w = mk(RECORD(), SIGNED(), { user: { email: 'mike@slacapital.com', admin: true } });
  r = await post(w, { recordKey: KEY }, {});
  check('an admin\'s bearer token runs it (the by-hand catch-up), recorded as such', [r.status, r.body.via, r.body.completed.length], [200, 'admin', 3]);
  w = mk(RECORD(), SIGNED(), { user: { email: 'lo@slacapital.com', admin: false } });
  r = await post(w, { recordKey: KEY }, {});
  check('a signed-in non-admin without the signature -> 403', [r.status, w.calls.length], [403, 0]);
}

console.log('\nThe handler hands off what it skipped');
{
  const SRC = readFn('borrower-info-sign.mjs');
  assert('the helpers the job needs are exported', /export async function emailSignedCopy\(/.test(SRC) && /export async function emailBorrower2AuthLink\(/.test(SRC) && /export async function notifyLOOfSignedApp\(/.test(SRC));
  assert('the hand-off fires exactly when something was skipped, after the warning, before the response', /_housekeepingSkipped\.join\(', '\) \+ ' — ' \+ _marks\.join\(' \| '\)\);\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*await _fireHousekeeping\(recordKey, _housekeepingSkipped, req\);\s*\}/.test(SRC));
  const lift = (start, end) => { const a = SRC.indexOf(start); const z = SRC.indexOf(end, a + start.length); return SRC.slice(a, z + end.length); };
  const code = lift('async function _fireHousekeeping(recordKey, skipped, req) {', '\n}\n');
  const posts = [];
  const c = { fetch: async (url, o) => { posts.push({ url, headers: o.headers, body: JSON.parse(o.body) }); return { status: 202, ok: true }; }, internalBgSig: SIG, process: { env: { URL: 'https://portal.slacapital.ai' } }, URL, JSON, AbortSignal, console: { warn() {} } };
  vm.createContext(c); vm.runInContext(code + '\n_fireHousekeeping("' + KEY + '", ["emails", "lo-notify"], { url: "https://portal.slacapital.ai/api/borrower-info-sign" });', c);
  await new Promise((r) => setTimeout(r, 10));
  check('...it POSTs the record key and the list to the background job, signed with the internal HMAC', [posts[0].url, posts[0].headers['x-sla-internal'], posts[0].body], ['https://portal.slacapital.ai/.netlify/functions/borrower-info-sign-housekeeping-background', SIG(KEY, 'sign-housekeeping'), { recordKey: KEY, skipped: ['emails', 'lo-notify'] }]);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
