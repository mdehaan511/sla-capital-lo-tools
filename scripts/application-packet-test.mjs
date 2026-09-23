#!/usr/bin/env node
/**
 * scripts/application-packet-test.mjs — Deploy 237.256 / 237.259 (Mike)
 *
 * Mike: "The loan officers want to be able to send the current Rate Sheet and Loan
 * Application together in a single email for e-signing ... after they are signed they need
 * to get saved to the loan as separate documents." / "The packet signature counts."
 *
 * What would hurt, so what this guards (the real functions are loaded with their imports
 * stubbed and RUN — the vm harness, now with dynamic import() support):
 *   1. A packet whose application is signed by someone the application does not name, or
 *      not by everyone it names — the signature could not count.
 *   2. A signer who never accepted the application's own consents (ESIGN, acknowledgement,
 *      credit authorization, information release) being treated as having signed it.
 *   3. The packet completing without the application's own signed record (no advance, no
 *      credit-auth pages, nothing in the tray), or signing it twice, or a co-signer's
 *      signature applied with the wrong token / the wrong audit context.
 *   4. The internal path bypassing the long-form handler's checks it must keep (already
 *      signed), or the public path losing its rate limit / token resolution.
 *   5. The send modal offering a FINISHED application's in-packet path when it is already
 *      signed, or with a party that has no email.
 *   6. (237.259, Mike: "sign the rate sheet and complete the loan application from the same
 *      link ... normally sent when there is no application on file yet") The step: nothing on
 *      file, or started and unfinished -> no application document in the envelope, the
 *      long-form link issued for the borrower-signer (reused while live), the signer page
 *      handing the designated signer the record's CURRENT link until the application is
 *      signed -- and never to another signer, never once done, never expired.
 *   7. The shared issue step (borrower-info-issue) changing what Send Full Loan Application
 *      writes: the record, the 14-day token, token reuse, the indexes, the answers surviving.
 *   8. Send Full Loan Application itself: the email, the loan note, the response shape.
 *
 * Run: node scripts/application-packet-test.mjs
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
const jsonStub = (status, body) => ({ status, body, ok: status < 400, json: async () => body });

// The harness: every static AND dynamic import resolves to a synthetic module whose exports
// come from the stub table (unknown names -> a no-op returning undefined).
async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: { RESEND_API_KEY: 're_test', URL: 'https://portal.slacapital.ai' } }, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, encodeURIComponent, AbortSignal, Set, Map, parseInt, parseFloat, isFinite, Response, fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }) }, extraGlobals || {}));
  const namesFor = (spec) => {
    const wanted = new Set();
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m;
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + esc + '[\'"]', 'g');
    while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => wanted.add(n)); // the EXPORTED name links
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
  const mod = new vm.SourceTextModule(src, {
    context: ctx, identifier: file,
    importModuleDynamically: async (spec) => { const m = synth(spec); await m.link(() => {}); await m.evaluate(); return m; },
  });
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
const AUTH = { handleOptions: () => null, json: jsonStub, readJsonBody: async (r) => { try { const t = await r.text(); return t ? JSON.parse(t) : {}; } catch (_) { return null; } }, keySafe, normalizeEmail, isAdmin: () => false, isProcessor: () => false, requireAuth: async () => ({ email: 'lo1@slacapital.com', user_metadata: { full_name: 'Lo One' }, app_metadata: { roles: ['loan_officer'] } }) };

const HELPERS = ['getStore', 'keySafe', 'normalizeEmail', 'handleOptions', 'json', 'readJsonBody', 'requireAuth', 'isAdmin', 'internalBgSig', 'loadRecord', 'newRecordKey',
  'applicationParties', 'signApplicationInternal', 'signCosignerInternal', 'attachPdfToReviewSlug', 'renderUnsignedApplicationForLoan', 'renderSignedApplicationPDF',
  'ESIGN_CONSENT_VERSION', 'rateSheetSignable', 'isBroker', 'brokerOf', 'hashPdf', 'canListAllClients', 'lookupEnvelopeByToken', 'sealSignature', 'checkRateLimit',
  'issueApplicationLink', 'generateToken', 'writeTokenIndex', 'deleteTokenIndex', 'borrowerInfoIndex', 'seedGuarantorSSNsFromProfiles', 'applyLoanPrefill', 'buildBorrowerPrefill', 'clientActsAsBroker',
  'appendNoteEntry', 'writeClient', 'getOwnerReplyTo', 'logBorrowerSendFromResponse'];
function declaredCheck(file) {
  const src = readFn(file);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imported = new Set();
  let m; const re = /import\s*\{([^}]*)\}\s*from/g;
  while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => imported.add(n));
  const dre = /const\s*\{([^}]*)\}\s*=\s*await import\(/g;
  while ((m = dre.exec(src))) m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => imported.add(n));
  const local = new Set(); const fre = /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fre.exec(code))) local.add(m[1]);
  return HELPERS.filter((h) => new RegExp('(?<![\\w$.])' + h + '\\s*[(.]').test(code) && !imported.has(h) && !local.has(h));
}

// ── fixtures ────────────────────────────────────────────────────────────────
const RECORD = (over) => Object.assign({
  ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1', status: 'in_progress', token: 'b1tok',
  borrowerEmail: 'k@x.com', prefill: { propertyAddress: '1 Main St, Spokane, WA' },
  data: { numGuarantors: '1', propertyAddress: '1 Main St, Spokane, WA', guarantors: [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }] },
}, over || {});
const RECORD2 = () => RECORD({ data: { numGuarantors: '2', guarantors: [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }, { firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com' }] } });
const CLIENT = { id: 'c_1', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', loans: [{ id: 'l_1', address: '1 Main St, Spokane, WA', status: 'active', guarantorClientIds: [] }] };

// ── A. the application PDF and its parties ─────────────────────────────────
console.log('\nThe Loan Application as a packet document: rendered from the file, signed by its parties');
{
  check('loan-application-unsigned imports everything it calls', declaredCheck('_shared/loan-application-unsigned.mjs'), []);
  const renders = [];
  const mk = (record) => loadFunction('_shared/loan-application-unsigned.mjs', {
    '@netlify/blobs': storesFrom({ clients: { 'lo1@slacapital.com/c_1': CLIENT } }),
    './auth.mjs': { keySafe },
    './borrower-info-keys.mjs': { loadRecord: async () => record },
    './loan-application-pdf.mjs': { renderSignedApplicationPDF: async (a) => { renders.push(a); return Buffer.from('%PDF-app'); } },
  });
  let M = await mk(RECORD2());
  check('parties = borrower 1 (from the application, client as fallback) + every co-guarantor with an email', M.applicationParties(RECORD2(), CLIENT), [{ pos: 1, firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }, { pos: 2, firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com' }]);
  check('...a co-guarantor without an email is not a party (the long form would not ask them either)', M.applicationParties(RECORD({ data: { numGuarantors: '2', guarantors: [{ firstName: 'K', lastName: 'L', email: 'k@x.com' }, { firstName: 'No', lastName: 'Mail' }] } }), CLIENT).length, 1);
  check('...an empty application falls back to the client record for borrower 1', M.applicationParties(RECORD({ borrowerEmail: '', data: { guarantors: [] } }), CLIENT), [{ pos: 1, firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }]);
  let r = await M.renderUnsignedApplicationForLoan({ ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1', enteredBy: { name: 'Lo One', email: 'lo1@slacapital.com' } });
  check('rendered UNSIGNED, every party listed as a signer, from the loan on the client', [r.ok, r.pdfBuffer.toString(), renders[0].unsigned, renders[0].status, renders[0].signers.map((s) => s.role + ':' + s.email), renders[0].loan && renders[0].loan.id, r.parties.length], [true, '%PDF-app', true, 'unsigned', ['borrower1:k@x.com', 'borrower2:p@x.com'], 'l_1', 2]);
  M = await mk(RECORD({ signedAt: '2026-09-20T00:00:00Z' }));
  r = await M.renderUnsignedApplicationForLoan({ ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1' });
  check('an application already signed cannot go into a packet', [r.ok, r.status], [false, 409]);
  M = await mk(null);
  r = await M.renderUnsignedApplicationForLoan({ ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1' });
  check('no application on file -> 404', [r.ok, r.status], [false, 404]);
  M = await mk(RECORD({ data: {} }));
  r = await M.renderUnsignedApplicationForLoan({ ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1' });
  check('an application with no data yet -> 409', [r.ok, r.status], [false, 409]);
}

// ── B. creating the envelope ───────────────────────────────────────────────
console.log('\n/api/envelopes: a finished application rides in the packet; otherwise it is the step after signing');
{
  check('envelopes.mjs imports everything it calls', declaredCheck('envelopes.mjs'), []);
  const FINISHED = RECORD({ status: 'complete' });
  const ISSUED = { token: 'apptok', recordKey: 'lo1@slacapital.com/c_1/l_1', tokenReused: false, existing: null, link: 'https://portal.slacapital.ai/borrower-info.html?t=apptok' };
  const mk = (renderResult, onFile, issueResult) => {
    const data = { clients: { 'lo1@slacapital.com/c_1': CLIENT } };
    const w = { data, renderCalls: [], issueCalls: [] };
    w.fn = loadFunction('envelopes.mjs', {
      '@netlify/blobs': storesFrom(data),
      './_shared/access.mjs': { canListAllClients: () => ({ ok: true }) },
      './_shared/auth.mjs': AUTH,
      './_shared/native-esign.mjs': { hashPdf: (b) => 'h:' + String(b).length },
      './_shared/rate-sheet-signable.mjs': { rateSheetSignable: () => ({ ok: true }), isBroker: () => false, brokerOf: () => null },
      './_shared/loan-application-unsigned.mjs': { renderUnsignedApplicationForLoan: async (a) => { w.renderCalls.push(a); return typeof renderResult === 'function' ? renderResult(a) : renderResult; } },
      './_shared/borrower-info-keys.mjs': { loadRecord: async () => onFile || null },
      './_shared/borrower-info-issue.mjs': { issueApplicationLink: async (a) => { w.issueCalls.push(a); if (issueResult instanceof Error) throw issueResult; return issueResult || ISSUED; } },
    });
    return w;
  };
  const RENDER_OK = { ok: true, pdfBuffer: Buffer.from('%PDF-app'), parties: [{ pos: 1, firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }, { pos: 2, firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com' }], loan: CLIENT.loans[0] };
  const post = async (w, body) => (await w.fn).default(req('POST', 'https://portal.slacapital.ai/api/envelopes', {}, body), {});
  const RS = { kind: 'rate_sheet', name: 'Rate Sheet', pdfBase64: Buffer.from('%PDF-rs').toString('base64') };
  const K = { firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }, P = { firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com' };

  // the finished application (237.256): rendered into the packet, signed by its parties
  let w = mk(RENDER_OK, FINISHED);
  let r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K, P] });
  let env = r.body.envelope;
  check('finished (complete, unsigned) + rate sheet, both parties signing: the application renders into the packet, stashed, marked; no link issued', [r.status, env.docs.length, env.docs[1].kind, env.docs[1].source, env.docs[1].name, env.docs[1].pdfHash, env.docs[0].source, env.application.mode, env.application.parties.length, w.renderCalls[0].enteredBy.email, !!w.data['envelope-pdfs'][env.ownerKey + '/' + env.id + '/1'], w.issueCalls.length], [200, 2, 'loan_app', 'longapp', 'Loan Application — 1 Main St, Spokane, WA', 'h:' + Buffer.from('%PDF-app').toString('base64').length, 'upload', 'packet', 2, 'lo1@slacapital.com', true, 0]);
  w = mk(RENDER_OK, FINISHED);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K] });
  check('a party of the finished application missing from the packet -> refused, named', [r.status, r.body.code, /Priya Lingan <p@x\.com>/.test(r.body.error)], [409, 'loan_app_signers', true]);
  w = mk(RENDER_OK, FINISHED);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K, P, { firstName: 'Bo', lastName: 'Broker', email: 'bo@b.com' }] });
  check('a signer who is not on the finished application -> refused, named', [r.status, /bo@b\.com/.test(r.body.error)], [409, true]);
  w = mk({ ok: true, pdfBuffer: Buffer.from('x'), parties: [{ pos: 1, firstName: 'K', lastName: 'L', email: '' }], loan: null }, FINISHED);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K] });
  check('a party with no email on the finished application -> refused', [r.status, r.body.code], [409, 'loan_app_party_no_email']);
  w = mk(RENDER_OK, RECORD({ status: 'complete', signedAt: '2026-09-20T00:00:00Z' }));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K] });
  check('an application already signed cannot go into a packet, either way', [r.status, r.body.code, w.renderCalls.length, w.issueCalls.length], [409, 'loan_app_unavailable', 0, 0]);

  // the step (Mike's normal case): nothing on file yet
  w = mk(RENDER_OK, null);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K], message: 'hi' });
  env = r.body.envelope;
  check('nothing on file: the envelope is the rate sheet alone; the application is a STEP for the signer, its link issued (nothing rendered, one PDF stashed)', [r.status, env.docs.length, env.docs[0].kind, env.application.mode, env.application.signerIndex, env.application.signerEmail, env.application.token, env.application.recordKey, env.application.tokenReused, env.application.status, w.renderCalls.length, w.issueCalls.length, Object.keys(w.data['envelope-pdfs']).length], [200, 1, 'rate_sheet', 'longform', 0, 'k@x.com', 'apptok', 'lo1@slacapital.com/c_1/l_1', false, 'pending', 0, 1, 1]);
  check('...the link is issued for that signer, on this loan, by this LO, into the borrower_info store', [w.issueCalls[0].recipientEmail, w.issueCalls[0].client.id, w.issueCalls[0].loan.id, w.issueCalls[0].ownerKey, w.issueCalls[0].ownerEmail, w.issueCalls[0].requestedBy, w.issueCalls[0].loName, typeof w.issueCalls[0].store.setJSON], ['k@x.com', 'c_1', 'l_1', 'lo1@slacapital.com', 'lo1@slacapital.com', 'lo1@slacapital.com', 'Lo One', 'function']);
  assert('...and the envelope history says who continues into the application', env.history.some((h) => /Loan Application step: k@x\.com continues into the long-form application/.test(h.note) && /new application link/.test(h.note)));
  w = mk(RENDER_OK, RECORD({ status: 'in_progress' }), { token: 'b1tok', recordKey: 'lo1@slacapital.com/c_1/l_1', tokenReused: true, existing: RECORD({ status: 'in_progress' }), link: 'x' });
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K] });
  check('started but unfinished: the step too, with the live link reused', [r.status, r.body.envelope.application.mode, r.body.envelope.application.token, r.body.envelope.application.tokenReused, r.body.envelope.application.status, w.renderCalls.length, /existing application link/.test(r.body.envelope.history.map((h) => h.note).join(' '))], [200, 'longform', 'b1tok', true, 'in_progress', 0, true]);
  w = mk(RENDER_OK, null);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [P, K] });
  check('two signers: the step goes to the one whose email is the borrower\'s (the client\'s here), not the first slot', [r.body.envelope.application.signerIndex, r.body.envelope.application.signerEmail, w.issueCalls[0].recipientEmail], [1, 'k@x.com', 'k@x.com']);
  w = mk(RENDER_OK, null, new Error('blob down'));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS, { kind: 'loan_app' }], signers: [K] });
  check('the link cannot be issued -> refused with the reason, no envelope written', [r.status, r.body.code, /blob down/.test(r.body.error), Object.keys(w.data.envelopes || {}).length], [500, 'loan_app_unavailable', true, 0]);
  w = mk(RENDER_OK, null);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [{ kind: 'loan_app' }], signers: [K] });
  check('the step without the rate sheet is not a packet -> 400', [r.status], [400]);

  // untouched
  w = mk(RENDER_OK, FINISHED);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [RS], signers: [K] });
  check('a rate-sheet-only envelope is untouched: no render, no issue, no application block', [r.status, w.renderCalls.length, w.issueCalls.length, r.body.envelope.application, r.body.envelope.docs[0].source], [200, 0, 0, null, 'upload']);
  w = mk(RENDER_OK, FINISHED);
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', docs: [{ kind: 'rate_sheet' }], signers: [K] });
  check('a rate sheet still needs its bytes', [r.status], [400]);
}

// ── C. signing the envelope ────────────────────────────────────────────────
console.log('\n/api/envelope-sign: the application\'s consents, and the hand-off on completion');
{
  check('envelope-sign imports everything it calls', declaredCheck('envelope-sign.mjs'), []);
  const mk = (envelope) => {
    const data = { envelopes: { [envelope.ownerKey + '/' + envelope.id]: envelope }, 'envelope-pdfs': {}, 'envelope-final-pdfs': {} };
    envelope.docs.forEach((d, i) => { data['envelope-pdfs'][envelope.ownerKey + '/' + envelope.id + '/' + i] = 'b64-' + i; });
    const w = { data, fetches: [], notified: [], attached: [] };
    w.fn = loadFunction('envelope-sign.mjs', {
      '@netlify/blobs': storesFrom(data),
      './_shared/auth.mjs': AUTH,
      './_shared/native-esign.mjs': { TERMSHEET_CONSENT_VERSION: 1, generateSignerToken: () => 'tok', sealSignature: () => 'seal', verifySignature: () => true, hashPdf: () => 'h', getClientIp: (r) => r.headers.get('x-nf-client-connection-ip'), getUserAgent: (r) => r.headers.get('user-agent'), appendSignaturePageToPdf: async ({ doc }) => 'stamped-' + doc.kind },
      './_shared/esign.mjs': { ESIGN_CONSENT_VERSION: 2 },
      './_shared/review-truth.mjs': { internalBgSig: (id, slug) => 'sig:' + id + ':' + slug },
      './envelope-signer-info.mjs': { lookupEnvelopeByToken: async (t) => { const idx = envelope.signers.findIndex((s) => s.token === t); return idx < 0 ? null : { envelope, envelopeKey: envelope.ownerKey + '/' + envelope.id, signerIndex: idx }; } },
      './_shared/email.mjs': { getOwnerReplyTo: async () => 'lo1@slacapital.com' },
      './_shared/rate-limit.mjs': { checkRateLimit: async () => ({ allowed: true }) },
      './_shared/notes-log.mjs': { appendNoteEntry: () => {} },
      './_shared/client-write.mjs': { writeClient: async () => {} },
      './_shared/loan-locate.mjs': { locateLoan: async () => null },
      './_shared/extension-marker.mjs': { syncExtensionMarker: async () => {} },
      './envelopes-send.mjs': { sendInvitationEmail: async () => true },
      './_shared/loan-event-notify.mjs': { notifyDocSignedByIds: async (a) => { w.notified.push(a.docLabel); } },
      './_shared/loan-review-auto-attach.mjs': { attachPdfToReviewSlug: async (a) => { w.attached.push(a.slug); return { attached: 1, reviewId: 'rv1' }; }, queueAiReviews: async () => {} },
    }, { fetch: async (url, o) => { w.fetches.push({ url, headers: o.headers, body: JSON.parse(o.body || '{}') }); return { ok: true, status: 202, json: async () => ({}), text: async () => '' }; } });
    return w;
  };
  const ENV = (docs, signers) => ({ id: 'env_1', ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1', propertyAddress: '1 Main St', status: 'sent', history: [], docs, signers: signers.map((s, i) => Object.assign({ role: i ? 'cosigner' : 'borrower', audit: null, signedAt: null, tokenExpiresAt: null }, s)) });
  const sign = async (w, body) => (await w.fn).default(req('POST', 'https://portal.slacapital.ai/api/envelope-sign', { 'x-nf-client-connection-ip': '9.9.9.9', 'user-agent': 'UA/1' }, body), {});
  const BASE = { consentAccepted: true, consentVersion: 1, geolocation: '' };
  let w = mk(ENV([{ kind: 'rate_sheet', name: 'RS', pdfHash: 'a' }, { kind: 'loan_app', name: 'App', pdfHash: 'b' }], [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', token: 't1' }]));
  let r = await sign(w, Object.assign({ t: 't1', signerName: 'Kandiah Lingan' }, BASE));
  check('a packet with the application refuses a signature without the application\'s consents', [r.status, /Loan Application consents/.test(r.body.error)], [400, true]);
  r = await sign(w, Object.assign({ t: 't1', signerName: 'Kandiah Lingan', appConsentAccepted: true, appConsentVersion: 1 }, BASE));
  check('...or with an out-of-date consent version', [r.status, r.body.currentAppVersion], [409, 2]);
  r = await sign(w, Object.assign({ t: 't1', signerName: 'Kandiah Lingan', appConsentAccepted: true, appConsentVersion: 2 }, BASE));
  const envAfter = w.data.envelopes['lo1@slacapital.com/env_1'];
  check('with both consents: signed and completed; the audit carries the application consent version; both documents stamped separately', [r.status, r.body.status, envAfter.signers[0].audit.appConsentVersion, envAfter.signers[0].audit.ipAddress, Object.keys(w.data['envelope-final-pdfs']).length, w.data['envelope-final-pdfs']['lo1@slacapital.com/env_1/1']], [200, 'completed', 2, '9.9.9.9', 2, 'stamped-loan_app']);
  const bg = w.fetches.find((f) => /application-packet-complete-background/.test(f.url));
  check('...and the packet completion is handed off, signed with the internal secret, naming the envelope', [!!bg, bg && bg.headers['x-sla-internal'], bg && bg.body], [true, 'sig:env_1:packet', { ownerKey: 'lo1@slacapital.com', envelopeId: 'env_1' }]);
  check('...the rate sheet still files into its tray and rings the bell as before', [w.attached, w.notified], [['term_sheet'], ['Rate Sheet']]);
  w = mk(ENV([{ kind: 'rate_sheet', name: 'RS', pdfHash: 'a' }], [{ firstName: 'K', lastName: 'L', email: 'k@x.com', token: 't1' }]));
  r = await sign(w, Object.assign({ t: 't1', signerName: 'K L' }, BASE));
  check('a rate-sheet-only envelope: no application consent asked, nothing handed off, audit says so', [r.status, w.data.envelopes['lo1@slacapital.com/env_1'].signers[0].audit.appConsentVersion, w.fetches.filter((f) => /packet-complete/.test(f.url)).length], [200, null, 0]);
  w = mk(ENV([{ kind: 'rate_sheet', name: 'RS', pdfHash: 'a' }, { kind: 'loan_app', name: 'App', pdfHash: 'b' }], [{ firstName: 'K', lastName: 'L', email: 'k@x.com', token: 't1' }, { firstName: 'P', lastName: 'L', email: 'p@x.com', token: 't2' }]));
  r = await sign(w, Object.assign({ t: 't1', signerName: 'K L', appConsentAccepted: true, appConsentVersion: 2 }, BASE));
  check('two signers, first signs: partially signed, no hand-off yet', [r.status, r.body.status, w.fetches.filter((f) => /packet-complete/.test(f.url)).length], [200, 'partially_signed', 0]);
  r = await sign(w, Object.assign({ t: 't2', signerName: 'P L', appConsentAccepted: true, appConsentVersion: 2 }, BASE));
  check('...second signs: completed, handed off once', [r.status, r.body.status, w.fetches.filter((f) => /packet-complete/.test(f.url)).length], [200, 'completed', 1]);
}

// ── D. the consent endpoint ────────────────────────────────────────────────
console.log('\n/api/envelope-consent carries the application\'s package');
{
  const fn = (await loadFunction('envelope-consent.mjs', {
    './_shared/auth.mjs': AUTH,
    './_shared/native-esign.mjs': { TERMSHEET_CONSENT_VERSION: 1, TERMSHEET_CONSENT_TEXT: 'TS', TERMSHEET_CONSENT_LABEL: 'ok' },
    './_shared/rate-limit.mjs': { checkRateLimit: async () => ({ allowed: true }) },
    './_shared/esign.mjs': { ESIGN_CONSENT_VERSION: 2, ESIGN_CONSENT_TEXT: 'E', LOAN_ACKNOWLEDGEMENT_TEXT: 'A', PREQUAL_CREDIT_AUTH_TEXT: 'P', INFO_RELEASE_AUTH_TEXT: 'I', ESIGN_CHECKBOX_LABEL: 'e', LOAN_ACK_CHECKBOX_LABEL: 'a', PREQUAL_CHECKBOX_LABEL: 'p', INFO_RELEASE_CHECKBOX_LABEL: 'i' },
  })).default;
  const r = await fn(req('GET', 'https://x/api/envelope-consent', {}, null), {});
  check('the four sections, at the application\'s consent version, beside the term-sheet consent', [r.status, r.body.version, r.body.application.version, r.body.application.sections.map((s) => s.key + ':' + s.text + ':' + s.checkboxLabel)], [200, 1, 2, ['esign:E:e', 'ack:A:a', 'prequal:P:p', 'release:I:i']]);
}

// ── E. the hand-off: the packet's signatures become the application's own ──
console.log('\napplication-packet-complete-background: the packet signature counts');
{
  check('the orchestrator imports everything it calls', declaredCheck('application-packet-complete-background.mjs'), []);
  const LAU = await loadFunction('_shared/loan-application-unsigned.mjs', { '@netlify/blobs': storesFrom({}), './auth.mjs': { keySafe }, './borrower-info-keys.mjs': {}, './loan-application-pdf.mjs': {} });
  const mk = (o) => {
    o = o || {};
    const envelope = Object.assign({ id: 'env_1', ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1', propertyAddress: '1 Main St, Spokane, WA', status: 'completed', history: [],
      docs: [{ kind: 'rate_sheet', name: 'RS' }, { kind: 'loan_app', name: 'App' }],
      signers: [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', audit: { signedAt: '2026-09-23T10:00:00Z', signerName: 'Kandiah S. Lingan', ipAddress: '1.1.1.1', userAgent: 'UA-K', geolocation: '47,-117' } }] }, o.envelope || {});
    const data = { envelopes: { 'lo1@slacapital.com/env_1': envelope }, clients: { 'lo1@slacapital.com/c_1': CLIENT }, signed_applications: { 'lo1@slacapital.com/c_1/l_1': { pdfBase64: Buffer.from('%PDF-signed').toString('base64') } } };
    const w = { data, b1: [], b2: [], attached: [] };
    w.fn = loadFunction('application-packet-complete-background.mjs', {
      '@netlify/blobs': storesFrom(data),
      './_shared/auth.mjs': AUTH,
      './_shared/review-truth.mjs': { internalBgSig: (id, slug) => 'sig:' + id + ':' + slug },
      './_shared/borrower-info-keys.mjs': { loadRecord: async () => ('record' in o ? o.record : RECORD()), newRecordKey: (ok, c, l) => ok + '/' + c + '/' + l },
      './_shared/loan-application-unsigned.mjs': { applicationParties: LAU.applicationParties },
      './borrower-info-sign.mjs': { signApplicationInternal: async (a) => { w.b1.push(a); return o.b1 || { ok: true, signedKey: 'lo1@slacapital.com/c_1/l_1', secondaryTokens: [], advanceResult: { ok: true, loanUpdated: true } }; } },
      './borrower2-auth-sign.mjs': { signCosignerInternal: async (a) => { w.b2.push(a); return o.b2 || { ok: true, status: 'complete', advanceResult: { ok: true, loanUpdated: true } }; } },
      './_shared/loan-review-auto-attach.mjs': { attachPdfToReviewSlug: async (a) => { w.attached.push({ slug: a.slug, bytes: a.bytes.toString(), filename: a.filename }); return { ok: true, attached: 1 }; } },
    });
    return w;
  };
  const run = async (w, sig) => (await w.fn).default(req('POST', 'https://x/.netlify/functions/application-packet-complete-background', { 'x-sla-internal': sig === undefined ? 'sig:env_1:packet' : sig }, { ownerKey: 'lo1@slacapital.com', envelopeId: 'env_1' }), {});
  let w = mk();
  let r = await run(w, 'wrong');
  check('a call without the internal signature is refused', [r.status, w.b1.length], [403, 0]);
  w = mk();
  r = await run(w);
  const b1 = w.b1[0];
  check('one party: borrower 1 signed with the packet signer\'s own audit context, on the record handed in, no token', [r.status, r.body.ok, b1.recordKey, b1.signerEmail, b1.signerName, b1.ip, b1.ua, b1.geolocation, b1.envelopeId, b1.record && b1.record.clientId], [200, true, 'lo1@slacapital.com/c_1/l_1', 'k@x.com', 'Kandiah S. Lingan', '1.1.1.1', 'UA-K', '47,-117', 'env_1', 'c_1']);
  let envAfter = w.data.envelopes['lo1@slacapital.com/env_1'];
  check('...the loan advanced (auto-attach did the filing), so nothing filed twice; the envelope remembers', [w.attached.length, !!envAfter.application.signedAt, envAfter.application.signedKey, envAfter.application.filed, /signed as part of this packet/.test(envAfter.history[envAfter.history.length - 1].note)], [0, true, 'lo1@slacapital.com/c_1/l_1', { ok: true, via: 'advance' }, true]);
  r = await run(w);
  check('a second run is a no-op (idempotent)', [r.status, r.body.skipped, w.b1.length], [200, 'already-signed', 1]);
  w = mk({ record: RECORD2(), envelope: { signers: [
    { firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', audit: { signedAt: '2026-09-23T10:00:00Z', signerName: 'Kandiah Lingan', ipAddress: '1.1.1.1', userAgent: 'UA-K' } },
    { firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com', audit: { signedAt: '2026-09-23T10:05:00Z', signerName: 'Priya Lingan', ipAddress: '2.2.2.2', userAgent: 'UA-P' } },
  ] }, b1: { ok: true, signedKey: 'lo1@slacapital.com/c_1/l_1', secondaryTokens: [{ pos: 2, token: 'tok-2', email: 'p@x.com' }], advanceResult: null } });
  r = await run(w);
  check('two parties: the co-signer\'s signature applied with the token borrower 1 minted, with the CO-SIGNER\'s audit context', [r.status, w.b2.length, w.b2[0].token, w.b2[0].signerName, w.b2[0].ip, w.b2[0].ua, r.body.cosigners], [200, 1, 'tok-2', 'Priya Lingan', '2.2.2.2', 'UA-P', [{ pos: 2, email: 'p@x.com', ok: true, error: '', status: 'complete' }]]);
  w = mk({ b1: { ok: true, signedKey: 'lo1@slacapital.com/c_1/l_1', secondaryTokens: [], advanceResult: { ok: false, reason: 'already approved', loanUpdated: false } } });
  r = await run(w);
  check('a loan already in processing (nothing advanced): the signed application is filed into its tray here, once', [w.attached.length, w.attached[0].slug, w.attached[0].bytes, w.attached[0].filename], [1, 'loan_application', '%PDF-signed', 'Signed Loan Application - 1 Main St.pdf']);
  w = mk({ record: RECORD2() });
  r = await run(w);
  envAfter = w.data.envelopes['lo1@slacapital.com/env_1'];
  check('a party of the application who did not sign the packet: nothing applied, the envelope says who', [r.status, w.b1.length, /Priya Lingan <p@x\.com>/.test(envAfter.application.error)], [409, 0, true]);
  w = mk({ record: RECORD({ signedAt: '2026-09-20T00:00:00Z' }) });
  r = await run(w);
  check('an application signed on the long form meanwhile: left alone, noted', [r.status, r.body.skipped, w.b1.length], [200, 'application-already-signed', 0]);
  w = mk({ envelope: { status: 'partially_signed' } });
  r = await run(w);
  check('an envelope that is not completed: nothing happens', [r.body.skipped, w.b1.length], ['envelope-not-completed', 0]);
  w = mk({ envelope: { docs: [{ kind: 'rate_sheet', name: 'RS' }] } });
  r = await run(w);
  check('no application in the envelope: nothing happens', [r.body.skipped, w.b1.length], ['no-loan-app', 0]);
  w = mk({ b1: { ok: false, error: 'This application has already been signed.' } });
  r = await run(w);
  check('the long-form handler refusing is surfaced on the envelope, not swallowed', [r.status, /already been signed/.test(w.data.envelopes['lo1@slacapital.com/env_1'].application.error)], [500, true]);
}

// ── F. the long-form handler's internal path ───────────────────────────────
console.log('\nborrower-info-sign: the internal path keeps the handler, drops only the delivery');
{
  const mk = (record) => {
    const data = { borrower_info: {}, signed_applications: {}, clients: { 'lo1@slacapital.com/c_1': CLIENT }, borrower2_token_idx: {} };
    const w = { data, resolves: 0, rateLimits: 0, mails: [], tokens: 0, advances: 0 };
    w.fn = loadFunction('borrower-info-sign.mjs', {
      '@netlify/blobs': storesFrom(data),
      './_shared/auth.mjs': AUTH,
      './_shared/borrower-info-token-index.mjs': { resolveByToken: async () => { w.resolves++; return { record, recordKey: 'lo1@slacapital.com/c_1/l_1', timedOut: false }; } },
      './_shared/client-lookup.mjs': { findClientByEmail: async () => null },
      './_shared/borrower-info-sync.mjs': { syncPropertyFieldsToLoan: async () => {}, advanceQuoteToInProcessing: async () => { w.advances++; return { ok: true, loanUpdated: true }; }, refreshRecordBorrowerEmail: () => {} },
      './_shared/esign.mjs': { ESIGN_CONSENT_VERSION: 2, hashFormData: () => 'hash', sealAudit: () => 'seal', getClientIp: (r) => r.headers.get('x-nf-client-connection-ip'), getUserAgent: (r) => r.headers.get('user-agent'), generateBorrower2Token: () => 'tok-' + (++w.tokens) },
      './_shared/loan-application-pdf.mjs': { renderSignedApplicationWithPages: async () => ({ buffer: Buffer.from('%PDF-signed'), authPages: [], pageCount: 1 }) },
      './_shared/email.mjs': { getOwnerReplyTo: async () => 'lo1@slacapital.com', resolveOwnerEmail: async () => 'lo1@slacapital.com', logBorrowerSendFromResponse: async () => {} },
      './_shared/client-write.mjs': { writeClient: async () => {} },
      './_shared/rate-limit.mjs': { checkRateLimit: async () => { w.rateLimits++; return { allowed: true }; } },
      './_shared/loan-event-notify.mjs': { notifyDocSignedByIds: async () => {} },
    }, { fetch: async (url, o) => { try { const b = JSON.parse(o.body); w.mails.push({ to: b.to, subject: b.subject }); } catch (_) {} return { ok: true, status: 200, json: async () => ({ id: 'm' }), text: async () => '' }; } });
    return w;
  };
  let w = mk(RECORD());
  let M = await w.fn;
  let r = await M.signApplicationInternal({ record: RECORD(), recordKey: 'lo1@slacapital.com/c_1/l_1', signerName: 'Kandiah S. Lingan', signerEmail: 'k@x.com', ip: '1.1.1.1', ua: 'UA-K', geolocation: '47,-117', envelopeId: 'env_1' });
  const signed = w.data.signed_applications['lo1@slacapital.com/c_1/l_1'];
  const bi = w.data.borrower_info['lo1@slacapital.com/c_1/l_1'];
  check('one party: the signed record with the packet signer\'s audit, the record marked signed, the loan advanced -- with no token, no rate limit', [r.ok, r.status, r.signedKey, signed.borrower1.audit.signerName, signed.borrower1.audit.ipAddress, signed.borrower1.audit.userAgent, signed.borrower1.audit.geolocation, signed.borrower1.audit.seal, signed.status, bi.status, bi.signedBy, w.advances, w.resolves, w.rateLimits, r.secondaryTokens], [true, 'complete', 'lo1@slacapital.com/c_1/l_1', 'Kandiah S. Lingan', '1.1.1.1', 'UA-K', '47,-117', 'seal', 'complete', 'complete', 'Kandiah S. Lingan', 1, 0, 0, []]);
  check('...no courtesy copy to the borrower (the envelope emails the stamped packet); the LO is still notified', [w.mails.some((m) => (m.to || []).some((t) => /k@x\.com/.test(String(t)))), w.mails.some((m) => (m.to || []).some((t) => /lo1@slacapital\.com/.test(String(t))))], [false, true]);
  w = mk(RECORD2());
  M = await w.fn;
  r = await M.signApplicationInternal({ record: RECORD2(), recordKey: 'lo1@slacapital.com/c_1/l_1', signerName: 'Kandiah Lingan', signerEmail: 'k@x.com', ip: '1.1.1.1', ua: 'UA-K', envelopeId: 'env_1' });
  check('two parties: the co-signer\'s token is minted and returned, NOT emailed; the record waits for them', [r.ok, r.status, r.secondaryTokens, w.data.borrower2_token_idx['tok-1'] && w.data.borrower2_token_idx['tok-1'].pos, w.mails.some((m) => (m.to || []).some((t) => /p@x\.com/.test(String(t)))), w.advances], [true, 'awaiting_borrower2', [{ pos: 2, token: 'tok-1', email: 'p@x.com' }], 2, false, 0]);
  w = mk(RECORD({ signedAt: '2026-09-20T00:00:00Z' }));
  M = await w.fn;
  r = await M.signApplicationInternal({ record: RECORD({ signedAt: '2026-09-20T00:00:00Z' }), recordKey: 'k', signerName: 'X', signerEmail: 'k@x.com', envelopeId: 'env_1' });
  check('an already-signed application is refused on the internal path too', [r.ok, r.status], [false, 409]);
  w = mk(RECORD());
  M = await w.fn;
  const pub = await M.default(req('POST', 'https://x/api/borrower-info-sign', { 'x-nf-client-connection-ip': '3.3.3.3', 'user-agent': 'UA' }, { t: 'b1tok', signerName: 'Kandiah Lingan', consentAccepted: true, consentVersion: 2 }), {});
  check('the public path is unchanged: rate limited, token resolved, courtesy copy sent', [pub.status, w.rateLimits, w.resolves, w.mails.some((m) => (m.to || []).some((t) => /k@x\.com/.test(String(t))))], [200, 1, 1, true]);
}

// ── G. the co-signer handler's internal path ───────────────────────────────
console.log('\nborrower2-auth-sign: the internal path');
{
  const signedRec = { ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1', status: 'awaiting_borrower2', numBorrowers: 2,
    borrower1: { role: 'borrower1', name: 'Kandiah Lingan', email: 'k@x.com', audit: { signedAt: 'x', signerName: 'Kandiah Lingan' }, signedAuths: [] },
    borrower2: { role: 'borrower2', name: 'Priya Lingan', email: 'p@x.com', token: 'tok-2', tokenExpiresAt: null, audit: null, signedAuths: [] } };
  const data = { signed_applications: { 'lo1@slacapital.com/c_1/l_1': signedRec }, borrower2_token_idx: { 'tok-2': { signedKey: 'lo1@slacapital.com/c_1/l_1', pos: 2 } }, borrower_info: { 'lo1@slacapital.com/c_1/l_1': RECORD2({ status: 'awaiting_b2_signature', b1SignedAt: 'x' }) }, clients: { 'lo1@slacapital.com/c_1': CLIENT } };
  const w = { rateLimits: 0, advances: 0 };
  const M = await loadFunction('borrower2-auth-sign.mjs', {
    '@netlify/blobs': storesFrom(data),
    './_shared/auth.mjs': AUTH,
    './_shared/esign.mjs': { ESIGN_CONSENT_VERSION: 2, hashFormData: () => 'hash', sealAudit: () => 'seal', getClientIp: (r) => r.headers.get('x-nf-client-connection-ip'), getUserAgent: (r) => r.headers.get('user-agent') },
    './_shared/loan-application-pdf.mjs': { renderSignedApplicationWithPages: async () => ({ buffer: Buffer.from('%PDF-final'), authPages: [], pageCount: 1 }) },
    './_shared/borrower-info-sync.mjs': { syncPropertyFieldsToLoan: async () => {}, advanceQuoteToInProcessing: async () => { w.advances++; return { ok: true, loanUpdated: true }; } },
    './_shared/crypto.mjs': { encryptField: (v) => 'enc' },
    './_shared/email.mjs': { getOwnerReplyTo: async () => '', resolveOwnerEmail: async () => 'lo1@slacapital.com', logBorrowerSendFromResponse: async () => {} },
    './_shared/rate-limit.mjs': { checkRateLimit: async () => { w.rateLimits++; return { allowed: true }; } },
    './_shared/loan-event-notify.mjs': { notifyDocSignedByIds: async () => {} },
  });
  const r = await M.signCosignerInternal({ token: 'tok-2', signerName: 'Priya Lingan', ip: '2.2.2.2', ua: 'UA-P', envelopeId: 'env_1' });
  const rec = data.signed_applications['lo1@slacapital.com/c_1/l_1'];
  check('the co-signer\'s packet signature completes the application with THEIR audit context; no rate limit; the loan advances', [r.ok, r.status || rec.status, rec.status, rec.borrower2.audit.signerName, rec.borrower2.audit.ipAddress, rec.borrower2.audit.userAgent, rec.borrower2.token, rec.pdfBase64 === Buffer.from('%PDF-final').toString('base64'), data.borrower_info['lo1@slacapital.com/c_1/l_1'].status, w.rateLimits, w.advances], [true, 'complete', 'complete', 'Priya Lingan', '2.2.2.2', 'UA-P', null, true, 'complete', 0, 1]);
}

// ── H. the pages ───────────────────────────────────────────────────────────
console.log('\nThe signer page and the send modal');
{
  const TS = read('term-sheet-sign.html');
  assert('the signer page renders the application\'s four consents when the packet carries it', /packetHasApp\(\) && CONSENT\.application/.test(TS) && /class="appConsentCheck"/.test(TS));
  assert('...posts the application consent with the signature', /appConsentAccepted: packetHasApp\(\) \? true : undefined/.test(TS) && /appConsentVersion: packetHasApp\(\) && CONSENT\.application \? CONSENT\.application\.version : undefined/.test(TS));
  // updateBtn RUN: every application box must be ticked
  const lift = (src, start, end) => { const a = src.indexOf(start); if (a < 0) throw new Error('not found: ' + start.slice(0, 40)); const z = src.indexOf(end, a + start.length); return src.slice(a, z + end.length); };
  const code = lift(TS, 'function updateBtn() {', '\n}\n') + lift(TS, 'function packetHasApp() {', '\n}\n');
  const mkDoc = (esChecked, appStates, name) => {
    const btn = { disabled: null };
    const els = { signBtn: btn, esignCheck: { checked: esChecked }, sigName: { value: name } };
    return { btn, document: { getElementById: (id) => els[id] || null, querySelectorAll: () => appStates.map((c) => ({ checked: c })) } };
  };
  const runBtn = (esChecked, appStates, name, docs) => { const d = mkDoc(esChecked, appStates, name); const c = { document: d.document, INFO: { docs } }; vm.createContext(c); vm.runInContext(code + '\nupdateBtn();', c); return d.btn.disabled; };
  check('Sign is disabled until every application consent is ticked, enabled once they are', [runBtn(true, [true, false, true, true], 'Kandiah Lingan', [{ kind: 'loan_app' }]), runBtn(true, [true, true, true, true], 'Kandiah Lingan', [{ kind: 'loan_app' }]), runBtn(true, [], 'Kandiah Lingan', [{ kind: 'rate_sheet' }])], [true, false, false]);

  // 237.259 -- the step card, RUN
  const scode = lift(TS, 'function appStep() {', '\n}\n') + lift(TS, 'function appStepHtml(auto) {', '\n}\n');
  const runStep = (application, auto) => { const c = { INFO: { application }, escH: (x) => String(x) }; vm.createContext(c); return vm.runInContext(scode + '\nappStepHtml(' + (auto ? 'true' : 'false') + ');', c); };
  const MINE = { step: 'longform', forYou: true, done: false, url: '/borrower-info.html?t=apptok', started: false };
  check('the step card: the designated signer gets the live link, with the countdown after signing and without it on a revisit', [/href="\/borrower-info\.html\?t=apptok"/.test(runStep(MINE, true)), /appStepSecs/.test(runStep(MINE, true)), /appStepSecs/.test(runStep(MINE, false)), /Pick up where you left off/.test(runStep(Object.assign({}, MINE, { started: true }), false))], [true, true, false, true]);
  check('...nothing for another signer; "complete as well" once done; a plain notice when the link is gone', [runStep({ step: 'longform', forYou: false, url: '/x' }, true), /complete as well/.test(runStep({ step: 'longform', forYou: true, done: true }, true)), /has expired/.test(runStep({ step: 'longform', forYou: true, done: false, url: null, expired: true }, true)), runStep(null, true)], ['', true, true, '']);
  assert('the thank-you screen carries the step and starts the countdown; the already-signed screen carries it without one', /appStepHtml\(true\); \/\/ Deploy/.test(TS) && /appStepAutoGo\(\);\n\}/.test(TS) && /appStepHtml\(false\); \/\/ Deploy/.test(TS));
  assert('the header note and the document list name the step for its signer', /This packet also includes your <strong>Loan Application<\/strong>\. After you sign the Rate Sheet below, this page takes you to the application/.test(TS) && /completed online after signing/.test(TS));
  assert('the countdown goes to the link', /if \(secs <= 0\) \{ clearInterval\(tick\); window\.location\.href = a\.url; \}/.test(TS));

  const LD = read('loan-details.js');
  const mcode = lift(LD, '\nvar _esPacketParties = null;', '\nfunction _esOpenModal(signer) {').replace(/\nfunction _esOpenModal\(signer\) \{$/, '');
  const runModal = async (status, clientOver) => {
    const els = { esIncludeAppRow: { style: {} }, esIncludeApp: { checked: false, disabled: null }, esIncludeAppHint: { textContent: '' }, esPacketSigners: { style: {}, innerHTML: '' }, esTitle: { textContent: '' } };
    const c = { _client: Object.assign({ id: 'c_1', firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }, clientOver || {}), _loanId: 'l_1', _loEmail: null, _user: { email: 'lo1@x' }, escH: (s) => String(s),
      document: { getElementById: (id) => els[id] || null }, SLA: { BorrowerInfo: { status: async () => status } }, String, parseInt, Math, Array };
    c.window = c; vm.createContext(c); vm.runInContext(mcode + '\n_esLoadPacketOption();', c);
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    return { els, parties: vm.runInContext('_esPacketParties', c), mode: vm.runInContext('_esPacketMode', c), toggle: () => { els.esIncludeApp.checked = true; vm.runInContext('_esPacketToggled()', c); return els; } };
  };
  let m = await runModal({ exists: false });
  check('nothing on file (the normal case): ON, as the step after signing', [m.els.esIncludeAppRow.style.display, m.els.esIncludeApp.disabled, m.mode, m.parties, m.els.esIncludeAppHint.textContent], ['', false, 'longform', null, '(none on file yet — they complete it after signing, from the same link)']);
  let t = m.toggle();
  assert('...ticking it explains the step and retitles the modal', /signs the Rate Sheet, then completes and signs the Loan Application from the same link/.test(t.esPacketSigners.innerHTML) && /Rate Sheet \+ Loan Application/.test(t.esTitle.textContent));
  m = await runModal({ exists: true, status: 'in_progress', data: { guarantors: [{ email: 'k@x.com' }] } });
  check('started, unfinished: ON, as the step', [m.els.esIncludeApp.disabled, m.mode, m.els.esIncludeAppHint.textContent], [false, 'longform', '(started, not finished — they finish it after signing, from the same link)']);
  m = await runModal({ exists: true, status: 'complete', signedAt: '2026-09-20T00:00:00Z', data: { guarantors: [{ email: 'k@x.com' }] } });
  check('signed: off', [m.els.esIncludeApp.disabled, m.mode, m.els.esIncludeAppHint.textContent], [true, null, '(already signed)']);
  m = await runModal({ exists: true, status: 'complete', data: { numGuarantors: '2', guarantors: [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com' }, { firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com' }] } });
  check('finished, unsigned, two parties: ON, in the packet, both named as the signers', [m.els.esIncludeApp.disabled, m.mode, m.els.esIncludeAppHint.textContent, m.parties.map((p) => p.pos + ':' + p.email)], [false, 'packet', '(complete — goes in the packet, signed by all 2 people on it)', ['1:k@x.com', '2:p@x.com']]);
  t = m.toggle();
  assert('...ticking it lists the signers', /Kandiah Lingan/.test(t.esPacketSigners.innerHTML) && /p@x\.com/.test(t.esPacketSigners.innerHTML) && /Rate Sheet \+ Loan Application/.test(t.esTitle.textContent));
  m = await runModal({ exists: true, status: 'complete', borrowerEmail: '', data: { guarantors: [{ firstName: 'K', lastName: 'L' }] } }, { email: '' });
  check('finished with a party that has no email: off, with the reason', [m.els.esIncludeApp.disabled, m.mode, /no email/.test(m.els.esIncludeAppHint.textContent)], [true, null, true]);
  assert('the submit puts the application in the packet; the parties replace the typed signer only in packet mode', /docs\.push\(\{ kind: 'loan_app', name: 'Loan Application/.test(LD) && /if \(_esPacketMode === 'packet' && _esPacketParties\) \{\s*signers = _esPacketParties\.map\(function\(p\) \{ return \{ firstName: p\.firstName, lastName: p\.lastName, email: p\.email \}; \}\);/.test(LD));
  assert('...and lets the application through without bytes (it renders server-side or becomes the step)', /\.filter\(function\(d\) \{ return !!d\.pdfBase64 \|\| d\.kind === 'loan_app'; \}\)/.test(LD));
  assert('...and the sent message says what the borrower does next', /They sign the Rate Sheet, then complete the Loan Application from the same link\./.test(LD));
  assert('the feed names the step on the envelope', /names\.push\('Loan App \(from the same link\)'\)/.test(LD));
  const LDH = read('loan-details.html');
  assert('the modal has the option and is pinned to this deploy or newer', /id="esIncludeApp"/.test(LDH) && /id="esPacketSigners"/.test(LDH) && (() => { const mm = /loan-details\.js\?v=(\d+|@@PIN@@)/.exec(LDH); return !!mm && (mm[1] === '@@PIN@@' || parseInt(mm[1], 10) >= 237259); })());
}

// ── I. the signer page's data: the live link for the designated signer ─────
console.log('\n/api/envelope-signer-info: the step, with the record\'s CURRENT link, only for the signer it belongs to');
{
  check('envelope-signer-info imports everything it calls', declaredCheck('envelope-signer-info.mjs'), []);
  const mkInfo = (record, appMeta) => {
    const ENV = { id: 'env_1', ownerKey: 'lo1@slacapital.com', clientId: 'c_1', loanId: 'l_1', requesterEmail: 'lo1@slacapital.com', status: 'sent', docs: [{ kind: 'rate_sheet', name: 'Rate Sheet', pdfSize: 10, pdfHash: 'h' }], signers: [{ firstName: 'Kandiah', lastName: 'Lingan', email: 'k@x.com', token: 't0', audit: null }, { firstName: 'Priya', lastName: 'Lingan', email: 'p@x.com', token: 't1', audit: null }], application: appMeta === undefined ? { mode: 'longform', signerIndex: 0, signerEmail: 'k@x.com', token: 'stale' } : appMeta };
    const data = { envelopes: { 'lo1@slacapital.com/env_1': ENV }, 'envelope-signer-idx': { t0: { envelopeKey: 'lo1@slacapital.com/env_1', signerIndex: 0 }, t1: { envelopeKey: 'lo1@slacapital.com/env_1', signerIndex: 1 } }, clients: { 'lo1@slacapital.com/c_1': CLIENT }, profiles: {} };
    return loadFunction('envelope-signer-info.mjs', { '@netlify/blobs': storesFrom(data), './_shared/auth.mjs': AUTH, './_shared/rate-limit.mjs': { checkRateLimit: async () => ({ allowed: true }) }, './_shared/borrower-info-keys.mjs': { loadRecord: async () => record } });
  };
  const get = async (M, t) => (await M).default(req('GET', 'https://portal.slacapital.ai/api/envelope-signer-info?t=' + t, {}, null));
  let M = mkInfo(RECORD({ token: 'live-tok', status: 'in_progress', data: { a: 1 } }));
  let r = await get(M, 't0');
  check('the designated signer: the step is theirs, with the record\'s CURRENT token (not the envelope\'s snapshot), started', [r.status, r.body.application.step, r.body.application.forYou, r.body.application.done, r.body.application.url, r.body.application.started, r.body.application.status, r.body.docs.length], [200, 'longform', true, false, '/borrower-info.html?t=live-tok', true, 'in_progress', 1]);
  r = await get(M, 't1');
  check('the other signer: the step exists but is not theirs, no link', [r.body.application.forYou, r.body.application.url], [false, null]);
  M = mkInfo(RECORD({ token: 'live-tok', status: 'complete', signedAt: '2026-09-23T00:00:00Z' }));
  r = await get(M, 't0');
  check('once the application is signed: done, no link', [r.body.application.done, r.body.application.url], [true, null]);
  M = mkInfo(RECORD({ token: 'live-tok', expiresAt: '2020-01-01T00:00:00Z' }));
  r = await get(M, 't0');
  check('an expired application link is not handed out, and says so', [r.body.application.url, r.body.application.expired], [null, true]);
  M = mkInfo(null, null);
  r = await get(M, 't0');
  check('a plain rate-sheet envelope: no application block', [r.status, r.body.application], [200, null]);
  const SEND = readFn('envelopes-send.mjs');
  assert('the invitation names the step for its signer and says what the same link does after signing', /\['Loan Application \(completed online after you sign\)'\]/.test(SEND) && /isAppSigner \? 'After you sign, the same page takes you to your Loan Application to complete and sign\.' : ''/.test(SEND) && /String\(signer\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\) === String\(appStep\.signerEmail \|\| ''\)\.trim\(\)\.toLowerCase\(\)/.test(SEND));
}

// ── J. issuing the application link: one shared step for the LO's send and the packet ─
console.log('\nissueApplicationLink: the record, the token rules, the indexes -- shared by Send Full Loan Application and the packet');
{
  check('borrower-info-issue imports everything it calls', declaredCheck('_shared/borrower-info-issue.mjs'), []);
  check('borrower-info-request imports everything it calls', declaredCheck('borrower-info-request.mjs'), []);
  const mkIssue = (existing) => {
    const data = { clients: { 'lo1@slacapital.com/c_1': CLIENT }, borrower_info: {} };
    const w = { data, tokenIdx: [], tokenDel: [], idx: [], seeds: [] };
    let n = 0;
    w.fn = loadFunction('_shared/borrower-info-issue.mjs', {
      '@netlify/blobs': storesFrom(data),
      './crypto.mjs': { generateToken: () => 'fresh' + (++n) },
      './borrower-info-keys.mjs': { newRecordKey: (o, c, l) => o + '/' + c + '/' + l, loadRecord: async () => existing || null },
      './borrower-info-token-index.mjs': { writeTokenIndex: async (t, k, m) => { w.tokenIdx.push([t, k, m]); }, deleteTokenIndex: async (t) => { w.tokenDel.push(t); } },
      './borrower-info-index.mjs': { borrowerInfoIndex: { upsertRecord: async (o, r) => { w.idx.push([o, r.token]); } } },
      './borrower-prefill.mjs': { applyLoanPrefill: (pf, loan) => { pf.property = { address: loan.address }; }, clientActsAsBroker: () => false, buildBorrowerPrefill: (c) => ({ firstName: c.firstName, lastName: c.lastName, email: c.email }), seedGuarantorSSNsFromProfiles: async (a) => { w.seeds.push(a.recipientEmail); } },
    });
    return w;
  };
  const ARGS = { ownerKey: 'lo1@slacapital.com', ownerEmail: 'lo1@slacapital.com', client: CLIENT, loan: CLIENT.loans[0], loName: 'Lo One', recipientEmail: 'k@x.com', requestedBy: 'lo1@slacapital.com' };
  let w = mkIssue(null);
  let r = await (await w.fn).issueApplicationLink(ARGS);
  const rec = w.data.borrower_info['lo1@slacapital.com/c_1/l_1'];
  check('first issue: a fresh token; the record at the per-loan key (pending, 14-day expiry, prefilled, empty answers); both indexes; the link', [r.token, r.tokenReused, r.recordKey, rec && rec.status, rec && rec.token, rec && rec.borrowerEmail, rec && rec.ownerEmail, rec && rec.requestedBy, rec && rec.prefill.lo.name, rec && rec.prefill.borrower.email, rec && rec.prefill.property.address, JSON.stringify(rec && rec.data), Math.round((new Date(rec.expiresAt) - new Date(rec.sentAt)) / 86400000), w.tokenIdx[0] && w.tokenIdx[0][0], w.tokenIdx[0] && w.tokenIdx[0][2].loanId, w.tokenDel.length, w.idx[0] && w.idx[0][1], w.seeds[0], r.link], ['fresh1', false, 'lo1@slacapital.com/c_1/l_1', 'pending', 'fresh1', 'k@x.com', 'lo1@slacapital.com', 'lo1@slacapital.com', 'Lo One', 'k@x.com', '1 Main St, Spokane, WA', '{}', 14, 'fresh1', 'l_1', 0, 'fresh1', 'k@x.com', 'https://portal.slacapital.ai/borrower-info.html?t=fresh1']);
  const live = RECORD({ token: 'b1tok', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: '2026-09-01T00:00:00Z', data: { borrowerFirstName: 'Kandiah' } });
  w = mkIssue(live);
  r = await (await w.fn).issueApplicationLink(ARGS);
  check('re-issue over a live token: the token is REUSED (236.414), the answers survive, createdAt kept, no index delete', [r.token, r.tokenReused, w.data.borrower_info['lo1@slacapital.com/c_1/l_1'].data.borrowerFirstName, w.data.borrower_info['lo1@slacapital.com/c_1/l_1'].createdAt, w.tokenDel.length, w.tokenIdx[0][0]], ['b1tok', true, 'Kandiah', '2026-09-01T00:00:00Z', 0, 'b1tok']);
  w = mkIssue(RECORD({ token: 'oldtok', expiresAt: '2020-01-01T00:00:00Z' }));
  r = await (await w.fn).issueApplicationLink(ARGS);
  check('re-issue over an expired token: a fresh one, the old index entry dropped', [r.token, r.tokenReused, w.tokenDel, w.tokenIdx[0][0]], ['fresh1', false, ['oldtok'], 'fresh1']);

  // Send Full Loan Application, end to end, on top of the shared step
  const mkReq = () => {
    const data = { clients: { 'lo1@slacapital.com/c_1': CLIENT }, profiles: { 'lo1@slacapital.com': { fullName: 'Lo One' } } };
    const w = { data, issueCalls: [], emails: [], notes: [], writes: [] };
    w.fn = loadFunction('borrower-info-request.mjs', {
      '@netlify/blobs': storesFrom(data),
      './_shared/auth.mjs': AUTH,
      './_shared/borrower-info-issue.mjs': { issueApplicationLink: async (a) => { w.issueCalls.push(a); return { token: 'tok9', recordKey: 'k', expiresAt: '2026-10-07T00:00:00Z', link: 'https://portal.slacapital.ai/borrower-info.html?t=tok9', existing: null, tokenReused: false }; } },
      './_shared/email.mjs': { getOwnerReplyTo: async () => 'lo1@slacapital.com', logBorrowerSendFromResponse: async () => {} },
      './_shared/notes-log.mjs': { appendNoteEntry: (loan, e) => { w.notes.push(e); return e; } },
      './_shared/client-write.mjs': { writeClient: async (o) => { w.writes.push(o); } },
    }, { fetch: async (url, o) => { w.emails.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ id: 'em1' }), text: async () => '' }; } });
    return w;
  };
  w = mkReq();
  r = await (await w.fn).default(req('POST', 'https://portal.slacapital.ai/api/borrower-info-request', {}, { clientId: 'c_1', loanId: 'l_1', sendEmail: true, email: 'k@x.com' }), {});
  check('Send Full Loan Application: the shared step runs for this LO / client / loan / recipient; the email carries the link; the loan is noted; the response keeps its shape', [r.status, w.issueCalls.length, w.issueCalls[0].ownerKey, w.issueCalls[0].ownerEmail, w.issueCalls[0].client.id, w.issueCalls[0].loan.id, w.issueCalls[0].recipientEmail, w.issueCalls[0].loName, w.issueCalls[0].requestedBy, w.emails.length, w.emails[0].to[0], /t=tok9/.test(w.emails[0].text), w.notes[0] && w.notes[0].kind, w.writes.length, r.body.ok, r.body.token, r.body.url, r.body.link, r.body.expiresAt, r.body.emailed, r.body.borrowerEmail, r.body.reminder, !!r.body.entry], [200, 1, 'lo1@slacapital.com', 'lo1@slacapital.com', 'c_1', 'l_1', 'k@x.com', 'Lo One', 'lo1@slacapital.com', 1, 'k@x.com', true, 'app_sent', 1, true, 'tok9', 'https://portal.slacapital.ai/borrower-info.html?t=tok9', 'https://portal.slacapital.ai/borrower-info.html?t=tok9', '2026-10-07T00:00:00Z', true, 'k@x.com', false, true]);
  w = mkReq();
  r = await (await w.fn).default(req('POST', 'https://portal.slacapital.ai/api/borrower-info-request', {}, { clientId: 'c_1', loanId: 'l_1' }), {});
  check('link only: no email, no note, the link returned', [r.status, w.issueCalls.length, w.emails.length, w.notes.length, r.body.url, r.body.emailed], [200, 1, 0, 0, 'https://portal.slacapital.ai/borrower-info.html?t=tok9', false]);
  w = mkReq();
  r = await (await w.fn).default(req('POST', 'https://portal.slacapital.ai/api/borrower-info-request', {}, { clientId: 'c_1', loanId: 'nope' }), {});
  check('an unknown loan is still refused before anything is issued', [r.status, w.issueCalls.length], [404, 0]);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
