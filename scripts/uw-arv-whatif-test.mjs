#!/usr/bin/env node
/**
 * scripts/uw-arv-whatif-test.mjs — Deploy 237.246 (Mike)
 *
 * "In the underwriting block can you make the ARV temporarily editable meaning it can be
 * changed but not saved without confirmation so that the underwriter can see what all the
 * metrics look like with different ARVs. They do this in cases where the appraisals or
 * BPOs aren't convincing."
 *
 * What would hurt, so what this guards:
 *   1. A what-if that SAVES. The ARV click must never reach the field editor or any
 *      endpoint; only the confirmed Save does, and it posts exactly one thing.
 *   2. A what-if that lies. The ratios and the guideline flags under a what-if ARV must be
 *      the engine's own figures for that ARV, and the loan object must stay untouched.
 *   3. A saved ARV that is silently undone. A Retry on the same BPO re-reads the same
 *      figure; the underwriter's decision must survive it. A NEW figure must win.
 *   4. The save endpoint writing anything but the two allowed keys, or for anyone.
 *
 * The real files are loaded and RUN (page scripts in a VM; the two functions through the
 * stubbed-import harness). Needs --experimental-vm-modules; re-launches itself with it.
 * Run: node scripts/uw-arv-whatif-test.mjs
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
const plain = (x) => JSON.parse(JSON.stringify(x));
const flat = (b) => b.sections.reduce((a, s) => a.concat(s.rows), []);
const row = (b, key) => flat(b).filter((r) => r.key === key)[0];

// ── a page: the real files, as loan-details.html loads them (rtl-pricing.js first: the
//    guideline caps come from its Colchis matrix, so a what-if can actually trip a flag) ──
function page(opts) {
  opts = opts || {};
  const w = {
    console: { warn() {}, log() {} },
    setTimeout: (fn) => 1, clearTimeout() {},
    JSON, Math, Object, Array, String, Number, isFinite, isNaN, parseInt, parseFloat, Date, Promise, Error,
    toasts: [], showToast(m) { w.toasts.push(m); },
  };
  w.window = w;
  w.document = opts.document || { getElementById: () => null, querySelector: () => { throw new Error('document.querySelector used'); }, createElement: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: (t) => t, head: { appendChild() {} }, body: { appendChild() {} } };
  vm.createContext(w);
  ['rtl-pricing.js', 'loan-uw-fields.js', 'loan-uw-calc.js', 'loan-uw-tab.js', 'loan-uw-metrics.js'].forEach((f) => vm.runInContext(read(f), w, { filename: f }));
  return w;
}
const RTL = () => ({
  id: 'l_1', toolType: 'rtl', loanType: 'Light Rehab', loanAmt: '648750', rate: '10.625', points: '2', brokerFee: '0',
  purchasePrice: '865000', rehabBudget: '0', arv: '865000', fico: '760', experience: '5', propType: 'sfr',
  arvBpo: '900000', arvBpoFromBpo: true, aivBpo: '700000', aivBpoFromBpo: true, uwData: {},
});

// ── 1. the what-if changes every metric, and nothing else ───────────────────
console.log('\nA what-if ARV runs through the engine; the loan is untouched');
{
  const w = page();
  const M = w.SLA_UW_METRICS, T = w.SLA_UW_TAB;
  const loan = RTL();
  T.mount({ loan, clientId: 'c_1', loanId: 'l_1' });
  const before = M.build(loan);
  check('to begin with: the valuation\'s ARV, LTARV on it, inside the 75% cap', [row(before, 'arv').display, row(before, 'arv').from, row(before, 'ltarv').display, row(before, 'ltarv').flag, before.whatIf], ['$900,000', 'BPO / Valuation', '72.08%', false, null]);
  const baseChecks = before.checks.length;
  assert('the ARV row is clickable, into the WHAT-IF editor and never the field editor', row(before, 'arv').editable && row(before, 'arv').tryArv && /data-key="arv"[^>]*onclick="SLA_UW_METRICS\._tryArv\(\)"/.test(M.html(loan)) && !/_edit\('uw','arv'/.test(M.html(loan)));

  M._applyArv('$700,000');
  const b = M.build(loan);
  check('the ARV row IS the what-if, and says what the valuation reads', [row(b, 'arv').display, row(b, 'arv').from, row(b, 'arv').prov, row(b, 'arv').whatIf], ['$700,000', 'What-if', 'Not saved — the valuation reads $900,000', true]);
  check('LTARV is the engine\'s figure for THAT ARV, labelled as unsaved', [row(b, 'ltarv').display, row(b, 'ltarv').prov], ['92.68%', 'Loan ÷ the what-if ARV (not saved)']);
  check('the banner has the numbers: what-if, baseline, the ratio then and now, the flag it added', plain(b.whatIf), { arv: 700000, base: 900000, baseFrom: 'valuation', ltarv: '92.68%', ltarvBase: '72.08%', checks: baseChecks + 1, checksBase: baseChecks });
  check('...because LTARV is now over the cap: flagged on the row and in the checks', [row(b, 'ltarv').flag, b.checks.some((c) => c.key === 'ltarv'), before.checks.some((c) => c.key === 'ltarv')], [true, true, false]);
  check('the loan object was NOT modified', [loan.arv, loan.arvBpo, loan.arvBpoFromBpo], ['865000', '900000', true]);
  check('a toast said so', w.toasts, ['Trying ARV $700,000 — nothing is saved']);
  const h = M.html(loan);
  assert('the panel draws the what-if bar with Save… and Back, and the amber cell', /uwm-wi-bar/.test(h) && /What-if ARV \$700,000<\/b> — the valuation reads \$900,000\. LTARV 92\.68% \(was 72\.08%\); \d+ out of guideline \(was \d+\)\. Nothing is saved\./.test(h) && /_saveArv\(\)">Save \$700,000 as the ARV…</.test(h) && /_resetArv\(\)">Back to \$900,000</.test(h) && /uw-r-value uw-editable uwm-wi" data-key="arv"/.test(h), h.match(/uwm-wi-bar[\s\S]{0,300}/) && h.match(/uwm-wi-bar[\s\S]{0,300}/)[0]);

  // a what-if that stays inside the cap adds no flag, and the bar does not claim one
  M._applyArv('870000');
  check('a what-if inside the cap adds no flag', [row(M.build(loan), 'ltarv').display, row(M.build(loan), 'ltarv').flag, M.build(loan).whatIf.checks === M.build(loan).whatIf.checksBase], ['74.57%', false, true]);
  assert('...and the bar does not mention flags then', !/out of guideline \(was/.test(M.html(loan)));

  M._resetArv();
  check('Back: everything as it was', [row(M.build(loan), 'arv').display, M.build(loan).whatIf], ['$900,000', null]);
  M._applyArv('900,000');
  check('typing the valuation\'s own figure is not a what-if', M.build(loan).whatIf, null);
  M._applyArv('');
  check('blank clears it', M.build(loan).whatIf, null);
  M._applyArv('abc');
  check('nonsense clears it', M.build(loan).whatIf, null);

  // the what-if belongs to ONE loan
  M._applyArv('700000');
  const other = RTL(); other.id = 'l_OTHER';
  check('another loan on the same page does not inherit it', M.build(other).whatIf, null);
  // no valuation yet: the term sheet is the baseline
  const noBpo = RTL(); delete noBpo.arvBpo; delete noBpo.arvBpoFromBpo;
  T.mount({ loan: noBpo, clientId: 'c_1', loanId: 'l_1' });
  M._applyArv('700000');
  const nb = M.build(noBpo);
  check('no valuation read: the baseline is the term sheet, and the row says so', [nb.whatIf.base, nb.whatIf.baseFrom, row(nb, 'arv').prov], [865000, 'term sheet', 'Not saved — the term sheet reads $865,000']);
  M._resetArv();
  // DSCR has no ARV
  const d = M.build({ id: 'l_2', toolType: 'dscr', loanAmt: '300000', rate: '7', propValue: '400000', rent: '3000', uwData: {} });
  check('a DSCR loan has no what-if and no ARV hint', [d.whatIf, /try a different one/.test(M.html({ id: 'l_2', toolType: 'dscr', loanAmt: '300000', rate: '7', propValue: '400000', rent: '3000', uwData: {} }))], [null, false]);
}

// ── 2. the ARV cell editor: Enter tries, Escape reverts, nothing saves ──────
console.log('\nThe cell editor');
{
  const w = page();
  const M = w.SLA_UW_METRICS, T = w.SLA_UW_TAB;
  const loan = RTL();
  const posted = [];
  w.SLA = { api: (m, p, body) => { posted.push([p, body]); return Promise.resolve({ ok: true }); } };
  T.mount({ loan, clientId: 'c_1', loanId: 'l_1' });
  let inp = null;
  const vspan = { set innerHTML(v) { inp = { html: v, value: '', focus() {}, select() {}, tagName: 'INPUT' }; }, querySelector: (s) => (s === '.uw-edit-input' ? inp : null) };
  const cell = { querySelector: (s) => (s === '.uw-v' ? vspan : null) };
  const root = { querySelector: (s) => (s === '.uw-r-value[data-key="arv"]' ? cell : null) };
  w.document = { getElementById: (id) => (id === 'uwMetricsPanel' ? root : null), querySelector: () => null, body: { appendChild() {} }, createElement: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: (t) => t, head: { appendChild() {} } };
  M._tryArv();
  assert('a money input appears in the ARV cell, seeded with the current ARV', inp && /class="uw-edit-input"[^>]*inputmode="decimal"[^>]*value="900000"/.test(inp.html), inp && inp.html);
  inp.value = '750000';
  inp.onkeydown({ key: 'Enter', preventDefault() {} });
  check('Enter tries the number', M.build(loan).whatIf && M.build(loan).whatIf.arv, 750000);
  check('...and NOTHING was posted', posted, []);
  inp = null; M._tryArv();
  assert('opening it again seeds the what-if, not the record', /value="750000"/.test(inp.html));
  inp.value = '1';
  inp.onkeydown({ key: 'Escape' });
  check('Escape keeps the previous what-if', M.build(loan).whatIf.arv, 750000);
  inp = null; M._tryArv(); inp.value = '760000'; inp.onblur();
  check('blur tries too (like every other cell)', M.build(loan).whatIf.arv, 760000);
  check('still nothing posted', posted.length, 0);
}

// ── 3. Save: a confirmation, then exactly one post ──────────────────────────
console.log('\nSave is a confirmed step');
{
  const w = page();
  const M = w.SLA_UW_METRICS, T = w.SLA_UW_TAB;
  const loan = RTL();
  const posted = [];
  const saved = RTL(); saved.arvBpo = '700000'; saved.arvBpoFromBpo = false; saved.arvBpoUwOverride = { value: '700000', replaced: '900000', replacedFromBpo: true, by: 'dee@slacapital.com', byName: 'Dee', at: '2026-09-22T15:00:00Z' };
  w.SLA = { api: (m, p, body) => { posted.push([m, p, body]); return Promise.resolve({ ok: true, loan: saved }); } };
  T.mount({ loan, clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com' });
  M._applyArv('700000');
  const modals = [];
  const mkEl = () => {
    const el = { className: '', innerHTML: '', handlers: {}, remove() { el.removed = true; }, querySelector(s) { const h = {}; el.handlers[s] = h; return h; } };
    return el;
  };
  w.document = { getElementById: () => null, querySelector: () => null, createElement: () => { const el = mkEl(); modals.push(el); return el; }, createTextNode: (t) => t, head: { appendChild() {} }, body: { appendChild(el) { el.attached = true; } } };
  M._saveArv();
  const modal = modals[modals.length - 1];
  assert('a confirmation card is shown with the exact change', modal && modal.attached && modal.className === 'uw-hist-bg' && /Save this ARV\?/.test(modal.innerHTML) && /becomes <b>\$700,000<\/b> in place of the valuation’s \$900,000\. LTARV goes to <b>92\.68%<\/b> from 72\.08%\./.test(modal.innerHTML), modal && modal.innerHTML);
  assert('...that says what it touches and what happens to a later valuation', /Loan Financials and the trade tapes will use this figure/.test(modal.innerHTML) && /if a valuation later reads a different figure, that figure takes over/.test(modal.innerHTML));
  check('nothing posted before a click', posted.length, 0);
  modal.handlers['[data-act="cancel"]'].onclick();
  check('Cancel: the card closes, nothing posted, the what-if is still on', [modal.removed, posted.length, M.build(loan).whatIf.arv], [true, 0, 700000]);
  M._saveArv();
  const modal2 = modals[modals.length - 1];
  modal2.handlers['[data-act="save"]'].onclick();
  await new Promise((r) => setTimeout(r, 10));
  check('Save: ONE post, to the field-save endpoint, dataset loan / key arvBpo, as this owner', posted.map((p) => [p[0], p[1], p[2].dataset, p[2].key, p[2].value, p[2].owner, p[2].clientId, p[2].loanId]), [['POST', '/api/loan-uw-field-save', 'loan', 'arvBpo', 700000, 'chance@slacapital.com', 'c_1', 'l_1']]);
  assert('the note says where it came from and what the valuation read', /what-if on the key metrics — the valuation read \$900,000/.test(posted[0][2].sourceNote), posted[0][2].sourceNote);
  check('after the save: what-if off, the fresh loan folded IN PLACE (same object), the row is underwriting\'s and says who / what the valuation read',
    [M.build(loan).whatIf, T.ctx().loan === loan, loan.arvBpo, loan.arvBpoFromBpo, row(M.build(loan), 'arv').from, row(M.build(loan), 'arv').prov, row(M.build(loan), 'ltarv').display],
    [null, true, '700000', false, 'Underwriting', 'Set by Dee Sep 22 — the valuation read $900,000', '92.68%']);
  check('the toast', w.toasts[w.toasts.length - 1], 'ARV saved: $700,000');
  // the marker only speaks while the loan still carries its figure
  loan.arvBpo = '820000';
  check('a NEW valuation figure on the loan: the row is the valuation\'s again', [row(M.build(loan), 'arv').from, row(M.build(loan), 'arv').prov], ['BPO / Valuation', 'Read from the valuation']);
  assert('FRESH_KEYS carries the marker so a refresh brings it too', /'arvBpoUwOverride', 'aivBpoUwOverride'\]/.test(read('loan-uw-tab.js')));
}

// ── the harness: a function file, its imports stubbed, run for real ─────────
async function loadModule(file, stubs, log) {
  const src = readFn(file);
  const ctx = vm.createContext({ console: { log() {}, warn: (...a) => log.push(['warn', a.join(' ')]), error: (...a) => log.push(['error', a.join(' ')]) }, Buffer, setTimeout, process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, isFinite, Map });
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

// ── 4. loan-uw-field-save, dataset 'loan' ───────────────────────────────────
console.log('\nloan-uw-field-save: the confirmed write');
{
  const world = (loanInit, user) => {
    const w = { client: { id: 'c_1', loans: [{ id: 'l_0' }, Object.assign({ id: 'l_1' }, loanInit)] }, writes: [], logs: [], truth: [], log: [] };
    w.stubs = {
      '@netlify/blobs': { getStore: () => ({ get: async () => JSON.parse(JSON.stringify(w.client)) }) },
      './_shared/auth.mjs': {
        handleOptions: () => null, json: (status, body) => ({ status, body }),
        requireAuth: async () => (user === undefined ? { email: 'dee@slacapital.com', user_metadata: { full_name: 'Dee' } } : user),
        readJsonBody: async (req) => req.body, isAdmin: () => false,
        keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_'), normalizeEmail: (s) => String(s || '').trim().toLowerCase(),
      },
      './_shared/access.mjs': { canOverrideOwner: (u) => ({ ok: !!(u && u.role === 'processor') }) },
      './_shared/client-write.mjs': { writeClient: async (ownerKey, client) => { w.writes.push({ ownerKey, client: JSON.parse(JSON.stringify(client)) }); } },
      './_shared/loan-change-log.mjs': { diffLoan: (a, b) => Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => ({ field: k })), recordLoanChanges: async (o) => { w.logs.push(o); } },
      './_shared/review-truth.mjs': { queueTruthRefreshIfMaterial: async (o) => { w.truth.push(o); } },
    };
    w.post = async (body) => (await loadModule('loan-uw-field-save.mjs', w.stubs, w.log)).default(({ method: 'POST', headers: { get: () => '' }, body }), {});
    return w;
  };
  let w = world({ toolType: 'rtl', arvBpo: '800000', arvBpoFromBpo: true, arvBpoBpoAt: 'T0', uwAudit: [] });
  let r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'loan', key: 'arvBpo', value: 700000, source: 'manual', sourceNote: 'Set from a what-if on the key metrics — the valuation read $800,000' });
  check('200 with the loan and the marker', [r.status, r.body.ok, r.body.entry.value, r.body.entry.replaced, r.body.entry.replacedFromBpo, r.body.entry.by, r.body.entry.byName], [200, true, '700000', '800000', true, 'dee@slacapital.com', 'Dee']);
  const L = w.writes[0].client.loans[1];
  check('the loan carries the figure, unlocked, with the marker', [L.arvBpo, L.arvBpoFromBpo, L.arvBpoUwOverride.value, L.arvBpoUwOverride.replaced, L.arvBpoUwOverride.note], ['700000', false, '700000', '800000', 'Set from a what-if on the key metrics — the valuation read $800,000']);
  check('...written under the right owner, the other loan untouched', [w.writes[0].ownerKey, w.writes[0].client.loans[0]], ['dee_slacapital_com', { id: 'l_0' }]);
  check('a uwAudit entry says who and from what', plain([L.uwAudit.length, L.uwAudit[0].key, L.uwAudit[0].action, L.uwAudit[0].from, L.uwAudit[0].to, L.uwAudit[0].byName, L.uwAudit[0].isAI]), [1, 'arvBpo', 'override', '800000', '700000', 'Dee', false]);
  check('the Audit Log and the doc review\'s point of truth both hear about it, after the write', [w.logs.length, w.logs[0].source, w.logs[0].changes.map((c) => c.field).sort(), w.truth.length, w.truth[0].reason], [1, 'Key metrics (ARV set by underwriting)', ['arvBpo', 'arvBpoFromBpo', 'arvBpoUwOverride', 'updatedAt'], 1, 'ARV set by underwriting']);

  w = world({ toolType: 'rtl', arvBpo: '800000' });
  r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'loan', key: 'loanAmt', value: 1 });
  check('only ARV / AIV may be set this way (loanAmt is the sizer\'s)', [r.status, w.writes.length], [400, 0]);
  r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'loan', key: 'arvBpo', value: 'abc' });
  check('a non-number is refused', [r.status, /number above zero/.test(r.body.error), w.writes.length], [400, true, 0]);
  r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'loan', key: 'arvBpo', value: 0 });
  check('zero is refused', [r.status, w.writes.length], [400, 0]);
  r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'loan', key: 'arvBpo', value: '750,000', owner: 'chance@slacapital.com' });
  check('an owner override needs processor / admin', [r.status, w.writes.length], [403, 0]);
  w = world({ toolType: 'rtl', arvBpo: '800000' }, { email: 'dee@slacapital.com', role: 'processor', user_metadata: { full_name: 'Dee' } });
  r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'loan', key: 'arvBpo', value: '750,000', owner: 'chance@slacapital.com' });
  check('...and lands under that owner, the money string parsed', [r.status, w.writes[0].ownerKey, w.writes[0].client.loans[1].arvBpo], [200, 'chance_slacapital_com', '750000']);
  w = world({ toolType: 'rtl', uwData: { emd: { value: '1' } }, uwAudit: [] });
  r = await w.post({ clientId: 'c_1', loanId: 'l_1', dataset: 'uw', key: 'emd', value: '2' });
  check('the uw / lightning path is exactly what it was', [r.status, w.writes[0].client.loans[1].uwData.emd.value, w.writes[0].client.loans[1].arvBpoUwOverride], [200, '2', undefined]);
}

// ── 5. uw-field-write: the AI honours an adopted figure ────────────────────
console.log('\nuw-field-write: a re-read of the same figure does not undo the underwriter');
{
  const world = (loanInit) => {
    const w = { client: { id: 'c_1', loans: [Object.assign({ id: 'l_1' }, loanInit)] }, writes: [], log: [] };
    w.stubs = {
      '@netlify/blobs': { getStore: () => ({ get: async () => JSON.parse(JSON.stringify(w.client)) }) },
      './auth.mjs': { keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_') },
      './client-write.mjs': { writeClient: async (ownerKey, client) => { w.writes.push(JSON.parse(JSON.stringify(client.loans[0]))); } },
      './loan-change-log.mjs': { diffLoan: () => [], recordLoanChanges: async () => {} },
    };
    w.run = async (value) => {
      const ns = await loadModule('_shared/uw-field-write.mjs', w.stubs, w.log);
      return ns.writeFieldProposals({ ownerKey: 'chance@slacapital.com', clientId: 'c_1', loanId: 'l_1' }, [{ dataset: 'loan', key: 'arvBpo', value, aiNote: 'BPO — p.1' }], 'ai');
    };
    return w;
  };
  const adopted = { toolType: 'rtl', arvBpo: '700000', arvBpoFromBpo: false, arvBpoUwOverride: { value: '700000', replaced: '800000', replacedFromBpo: true, by: 'dee@slacapital.com', byName: 'Dee', at: 'T1' } };
  let w = world(adopted);
  let n = await w.run('800000');
  const L1 = w.writes[0];
  check('the SAME reading again (a Retry): the figure is not written (only the BPO flags, as always), the marker stays', [n, L1.arvBpo, L1.arvBpoFromBpo, !!L1.arvBpoUwOverride], [1, '700000', false, true]);
  w = world(adopted);
  n = await w.run('825,000');
  const L2 = w.writes[0];
  check('a NEW figure from a valuation: it takes over, locked again, marker gone', [n, L2.arvBpo, L2.arvBpoFromBpo, L2.arvBpoUwOverride], [2, '825000', true, undefined]);
  w = world({ toolType: 'rtl', arvBpo: '800000', arvBpoFromBpo: true });
  n = await w.run('800000');
  check('no marker: exactly the old behaviour (same value → only the flags, still locked)', [n, w.writes[0].arvBpo, w.writes[0].arvBpoFromBpo], [1, '800000', true]);
  w = world({ toolType: 'rtl', arvBpo: '800000', arvBpoFromBpo: true });
  n = await w.run('810000');
  check('no marker, new value: written and locked', [n, w.writes[0].arvBpo, w.writes[0].arvBpoFromBpo], [2, '810000', true]);
}

// ── 6. the page ─────────────────────────────────────────────────────────────
console.log('\nloan-details');
{
  const LD = read('loan-details.html');
  const pin = (name) => (LD.match(new RegExp(name.replace('.', '\\.') + '\\?v=([0-9A-Za-z@]+)')) || [])[1];
  check('the coupled scripts carry one pin, and loan-details.js moved with them', [pin('loan-uw-tab.js') === pin('loan-uw-metrics.js'), pin('loan-uw-metrics.js') === pin('loan-doc-review.js'), pin('loan-details.js') === pin('loan-uw-metrics.js')], [true, true, true]);
  const JS = read('loan-details.js');
  assert('the Property tab says "(set by underwriting)" on an adopted figure, and only when the BPO lock is off', /_arvBpoLocked \? ' <span[^']*\(from BPO\)<\/span>' :\s*\(l\.arvBpoUwOverride \? ' <span[^']*\(set by underwriting\)<\/span>' : ''\)\)/.test(JS));
  assert('the confirmation card reuses the history modal\'s styles (they live on this page)', /\.uw-hist-bg \{/.test(LD) && /\.uw-hist-card \{/.test(LD));
  const M = read('loan-uw-metrics.js');
  assert('the what-if never reaches the sizer-owned term-sheet ARV or the field editor', !/_edit\('uw','arv'/.test(M) && !/key: 'arv',\s*value/.test(M) && /key: 'arvBpo'/.test(M));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
