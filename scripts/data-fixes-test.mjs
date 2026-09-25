#!/usr/bin/env node
/**
 * scripts/data-fixes-test.mjs — Deploy 237.281
 *
 * The one-off correction runner: an entry applies ONCE, through writeClient, with an Audit Log
 * entry and a note; it is skipped (never forced) when the loan no longer holds the value it
 * expects; a failed write is retried on the next run; only whitelisted fields can be touched.
 * Plus the first entry: 2231 Flora St's sold date, 2026-12-08 -> 2025-12-08 (Mike: "Change that
 * Flora one that you noticed").
 *
 * Run: node scripts/data-fixes-test.mjs
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
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const DF = await import('../deploy/netlify/functions/_shared/data-fixes.mjs');

console.log('\nThe guarded apply');
const fix = { id: 'f1', ownerKey: 'chance@slacapital.com', clientId: 'c_1', loanId: 'l_1', field: 'soldDate', from: '2026-12-08', to: '2025-12-08', requestedBy: 'Mike', reason: 'typo' };
const client = () => ({ id: 'c_1', loans: [{ id: 'l_0', soldDate: '2026-12-08' }, { id: 'l_1', address: '2231 Flora St', soldDate: '2026-12-08', status: 'closed' }] });
let c = client(); let r = DF.applyFix(c, fix);
check('the expected value is there: changed, on that loan only', [r.result, c.loans[1].soldDate, c.loans[0].soldDate, r.before.soldDate], ['applied', '2025-12-08', '2026-12-08', '2026-12-08']);
c = client(); c.loans[1].soldDate = '2025-12-08';
check('already corrected: nothing to do', DF.applyFix(c, fix).result, 'already');
c = client(); c.loans[1].soldDate = '2026-11-30';
r = DF.applyFix(c, fix);
check('someone has since changed it: skipped, left alone', [r.result, c.loans[1].soldDate, /found 2026-11-30/.test(r.note)], ['skipped', '2026-11-30', true]);
check('a field outside the list cannot be touched', DF.applyFix(client(), Object.assign({}, fix, { field: 'loanAmt' })).result, 'skipped');
check('a loan that is not on the client', DF.applyFix(client(), Object.assign({}, fix, { loanId: 'l_nope' })).result, 'skipped');

console.log('\nThe first entry: 2231 Flora St');
const flora = DF.DATA_FIXES.find((f) => f.id === 'fix-2026-09-25-flora-solddate');
check('Flora\'s sold date, the year corrected, on the right loan', flora && [flora.ownerKey, flora.clientId, flora.loanId, flora.field, flora.from, flora.to, flora.requestedBy], ['chance@slacapital.com', 'c_bl_mr8mdovy_ellvgk', 'l_baseline_SLA-3472', 'soldDate', '2026-12-08', '2025-12-08', 'Mike']);
check('every entry has a unique id and a whitelisted field', [new Set(DF.DATA_FIXES.map((f) => f.id)).size === DF.DATA_FIXES.length, DF.DATA_FIXES.every((f) => DF.FIXABLE_FIELDS[f.field])], [true, true]);

// ── the runner, through the harness ─────────────────────────────────────────
async function loadModule(file, stubs) {
  const src = readFileSync(new URL(file, FN), 'utf8');
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, isFinite, URL, Response: globalThis.Response });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const ex = {}; wanted.forEach((n) => { ex[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(ex), function () { Object.keys(ex).forEach((k) => this.setExport(k, ex[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace;
}
function world(clientDoc, opts) {
  const w = { writes: [], logs: [], notes: [], stores: { clients: new Map([['chance@slacapital.com/c_1', clientDoc]]), 'data-fixes': new Map() } };
  const store = (name) => ({
    get: async (k) => (w.stores[name].has(k) ? JSON.parse(JSON.stringify(w.stores[name].get(k))) : null),
    setJSON: async (k, v) => { w.stores[name].set(k, JSON.parse(JSON.stringify(v))); },
  });
  let failures = (opts && opts.failWrites) || 0;
  w.stubs = {
    '@netlify/blobs': { getStore: ({ name }) => store(name) },
    './_shared/auth.mjs': { keySafe: (s) => String(s || '').replace(/[:/\\]/g, '_') },
    './_shared/client-write.mjs': { writeClient: async (ownerKey, cl) => { if (failures > 0) { failures--; throw new Error('PG unavailable'); } w.writes.push({ ownerKey, soldDate: cl.loans[1].soldDate }); } },
    './_shared/loan-change-log.mjs': { diffLoan: (a, b) => Object.keys(b).filter((k) => a[k] !== b[k]).map((k) => ({ field: k, from: a[k], to: b[k] })), recordLoanChanges: async (o) => { w.logs.push({ source: o.source, actorName: o.actorName, changes: o.changes.filter((x) => x.field === 'soldDate') }); } },
    './_shared/notes-log.mjs': { appendNoteEntry: (loan, e) => { w.notes.push(e.text); } },
    './_shared/data-fixes.mjs': DF,
  };
  return w;
}
console.log('\nThe runner');
{
  let w = world(client());
  let M = await loadModule('data-fixes-cron.mjs', w.stubs);
  let out = await M.runDataFixes({ fixes: [fix] });
  check('applied once, through writeClient, under the loan\'s owner', [out.map((x) => x.result), w.writes], [['applied'], [{ ownerKey: 'chance@slacapital.com', soldDate: '2025-12-08' }]]);
  check('...an Audit Log entry that says what and who asked', w.logs, [{ source: 'Data fix f1', actorName: 'Data fix (requested by Mike)', changes: [{ field: 'soldDate', from: '2026-12-08', to: '2025-12-08' }] }]);
  assert('...and a line in Notes & Activity', w.notes.length === 1 && /^Data correction: Sold Date 2026-12-08 → 2025-12-08 \(requested by Mike\)\. typo/.test(w.notes[0]), w.notes[0]);
  out = await M.runDataFixes({ fixes: [fix] });
  check('the next run does nothing (recorded as applied)', [out.length, w.writes.length], [0, 1]);

  const changed = client(); changed.loans[1].soldDate = '2026-11-30';
  w = world(changed); M = await loadModule('data-fixes-cron.mjs', w.stubs);
  out = await M.runDataFixes({ fixes: [fix] });
  check('a value someone has since changed: skipped, recorded, nothing written', [out[0].result, w.writes.length, w.logs.length, !!w.stores['data-fixes'].get('applied').f1], ['skipped', 0, 0, true]);

  w = world(client(), { failWrites: 1 }); M = await loadModule('data-fixes-cron.mjs', w.stubs);
  out = await M.runDataFixes({ fixes: [fix] });
  check('a failed write is NOT recorded, so it retries', [out[0].result, w.stores['data-fixes'].has('applied')], ['error', false]);
  out = await M.runDataFixes({ fixes: [fix] });
  check('...and the next run applies it', [out[0].result, w.writes.length], ['applied', 1]);
  const src = readFileSync(new URL('data-fixes-cron.mjs', FN), 'utf8');
  assert('it is a scheduled function (Netlify-only, no public route)', /export const config = \{ schedule: '\*\/10 \* \* \* \*' \};/.test(src));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
