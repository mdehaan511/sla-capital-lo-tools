#!/usr/bin/env node
/**
 * scripts/client-merge-rekey-test.mjs — Deploy 237.258
 *
 * The client merge re-keys the loser's borrower_info + signed_applications records under the
 * winner's client id. When both clients carried the SAME loan id (the David Starkweather
 * pair, 2026-09-23: a guarantor-link shell kept a stale copy of the winner's loan, each side
 * with its own signed application), the old loop wrote the loser's copy ON TOP of the
 * winner's live record. What would hurt, so what this guards — the real helper is loaded
 * with its imports stubbed and RUN:
 *   1. A record the winner already holds being overwritten by the loser's copy.
 *   2. The loser's copy being dropped instead of parked (audit trail).
 *   3. The ordinary move (target free) changing: re-keyed, rewritten, old key gone.
 *   4. The handler no longer calling the helper for every source, or the response losing
 *      the parked counts.
 *
 * Run: node scripts/client-merge-rekey-test.mjs
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
const keySafe = (s) => String(s || '').replace(/[:/\\]/g, '_').replace(/^\.+/, '').slice(0, 128);

async function loadFunction(file, stubs) {
  const src = readFn(file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, parseInt, parseFloat, isFinite, encodeURIComponent });
  const namesFor = (spec) => {
    const wanted = new Set();
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m;
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + esc + '[\'"]', 'g');
    // the EXPORTED name links (`import { removeClient as indexRemoveClient }` -> removeClient)
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

const SRC = readFn('clients-merge-manual.mjs');
const LOSER = 'c_1787355617179_nzqfeg', WINNER = 'c_lo_1788375942940_mk12zt', OWNER = 'chance@slacapital.com', LOAN = 'l_1786992692545_jn5t';
const K = (cid, lid) => OWNER + '/' + cid + (lid ? '/' + lid : '');

console.log('\nThe merge re-key: the winner keeps what it has, the loser\'s copy is parked, everything else moves');
{
  const run = async (seed) => {
    const data = JSON.parse(JSON.stringify(seed));
    const M = await loadFunction('clients-merge-manual.mjs', { '@netlify/blobs': storesFrom(data), './_shared/auth.mjs': { keySafe } });
    const mk = (n) => storesFrom(data).getStore({ name: n });
    const r = await M.rekeyApplicationRecords({
      biStore: mk('borrower_info'), appStore: mk('signed_applications'),
      biParkStore: mk('borrower_info-merged'), appParkStore: mk('signed_applications-merged'),
      sources: [{ fromOwnerKey: OWNER, fromClientId: LOSER, loanIds: [LOAN] }], resultOwnerKey: OWNER, winnerId: WINNER,
    });
    return { r, data };
  };
  const winnerBi = { clientId: WINNER, ownerKey: OWNER, loanId: LOAN, status: 'complete', signedAt: '2026-09-02T20:28:29.599Z', data: { n: 38 } };
  const loserBi  = { clientId: LOSER,  ownerKey: OWNER, loanId: LOAN, status: 'complete', signedAt: '2026-08-25T23:59:58.897Z', data: { n: 38 } };
  const winnerSa = { clientId: WINNER, ownerKey: OWNER, loanId: LOAN, pdfBase64: 'WINNER-PDF' };
  const loserSa  = { clientId: LOSER,  ownerKey: OWNER, loanId: LOAN, pdfBase64: 'LOSER-PDF' };

  // 1 + 2: the Starkweather shape -- both sides hold a record for the SAME loan id.
  let { r, data } = await run({ borrower_info: { [K(WINNER, LOAN)]: winnerBi, [K(LOSER, LOAN)]: loserBi }, signed_applications: { [K(WINNER, LOAN)]: winnerSa, [K(LOSER, LOAN)]: loserSa } });
  check('same loan id on both sides: the winner\'s application record is untouched', data.borrower_info[K(WINNER, LOAN)], winnerBi);
  check('...and the winner\'s signed application too', data.signed_applications[K(WINNER, LOAN)].pdfBase64, 'WINNER-PDF');
  check('...the loser\'s copies leave the live stores', [K(LOSER, LOAN) in data.borrower_info, K(LOSER, LOAN) in data.signed_applications], [false, false]);
  const parkedBi = data['borrower_info-merged'][K(LOSER, LOAN)], parkedSa = data['signed_applications-merged'][K(LOSER, LOAN)];
  check('...and are parked under their old key, marked with where they would have gone', [parkedBi && parkedBi.signedAt, parkedBi && parkedBi._mergedInto, !!(parkedBi && parkedBi._mergedAt), parkedSa && parkedSa.pdfBase64, parkedSa && parkedSa._mergedInto], ['2026-08-25T23:59:58.897Z', K(WINNER, LOAN), true, 'LOSER-PDF', K(WINNER, LOAN)]);
  check('...counted as parked, not moved, and named', [r.biMoved, r.appsMoved, r.biParked, r.appsParked, r.parked], [0, 0, 1, 1, [K(LOSER, LOAN), K(LOSER, LOAN)]]);

  // 3: the ordinary merge -- the loser's loan is new to the winner.
  ({ r, data } = await run({ borrower_info: { [K(LOSER, LOAN)]: loserBi }, signed_applications: { [K(LOSER, LOAN)]: loserSa } }));
  check('target free: moved under the winner, rewritten, old key gone, nothing parked', [data.borrower_info[K(WINNER, LOAN)].clientId, data.borrower_info[K(WINNER, LOAN)].ownerKey, data.borrower_info[K(WINNER, LOAN)].signedAt, K(LOSER, LOAN) in data.borrower_info, data.signed_applications[K(WINNER, LOAN)].pdfBase64, Object.keys(data['borrower_info-merged'] || {}).length, r.biMoved, r.appsMoved, r.biParked], [WINNER, OWNER, '2026-08-25T23:59:58.897Z', false, 'LOSER-PDF', 0, 1, 1, 0]);

  // the legacy per-client key keeps its rule: only into a free slot
  ({ r, data } = await run({ borrower_info: { [K(LOSER)]: { clientId: LOSER, legacy: true }, [K(WINNER)]: { clientId: WINNER, legacy: 'winner' } } }));
  check('legacy per-client record: the winner\'s stays when it has one', [data.borrower_info[K(WINNER)].legacy, K(LOSER) in data.borrower_info], ['winner', true]);
  ({ r, data } = await run({ borrower_info: { [K(LOSER)]: { clientId: LOSER, legacy: true } } }));
  check('...and moves when the winner has none', [data.borrower_info[K(WINNER)] && data.borrower_info[K(WINNER)].clientId, K(LOSER) in data.borrower_info], [WINNER, false]);

  // a record only on one store still works
  ({ r, data } = await run({ borrower_info: { [K(LOSER, LOAN)]: loserBi, [K(WINNER, LOAN)]: winnerBi } }));
  check('an application record with no signed PDF beside it: parked alone', [r.biParked, r.appsParked, r.appsMoved], [1, 0, 0]);
}

console.log('\nThe handler wiring');
{
  assert('the handler runs the helper over the re-key sources with both park stores', /rekeyApplicationRecords\(\{[\s\S]*?biParkStore:\s*getStore\(\{ name: 'borrower_info-merged'[\s\S]*?appParkStore:\s*getStore\(\{ name: 'signed_applications-merged'[\s\S]*?sources: reKeySources, resultOwnerKey, winnerId: winner\.id,/.test(SRC));
  assert('...its counts feed the old response fields', /biMoved = reKeyed\.biMoved; appsMoved = reKeyed\.appsMoved;/.test(SRC));
  assert('...and the response says what was parked', /^\s*biParked: reKeyed\.biParked,/m.test(SRC) && /^\s*appsParked: reKeyed\.appsParked,/m.test(SRC) && /^\s*parkedKeys: reKeyed\.parked,/m.test(SRC));
  assert('the inline loop is gone (one implementation)', !/rec\.clientId = winner\.id;\s*rec\.ownerKey = resultOwnerKey;\s*await biStore\.setJSON\(newK, rec\);/.test(SRC));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
