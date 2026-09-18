/**
 * scripts/scan-fixes-test.mjs — Deploy 237.162
 *
 * Locks the two judgement calls in this batch:
 *
 *   1. prospects-list._alreadyWorked — a NEW application must not be hidden
 *      from its own LO just because an OLDER quote exists at that address.
 *      (Marianne: "nor am I able to find it anywhere in our system.
 *      Interestingly, Chance sees my portfolio app on his end.")
 *   2. financial-audit rowByKey — the verify controls address a row by its
 *      stable key, so they keep working when a filter hides rows from _rows.
 *
 * Both live inside modules that import Netlify Blobs or run in a browser, so
 * the functions are lifted out of the source and run against stubs.
 *
 * Run: node scripts/scan-fixes-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { i++; break; } }
  return src.slice(start, i);
}

// ── 1. Worked-address rule ────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions/prospects-list.mjs'), 'utf8');
  const normAddr = (a) => String(a || '').toLowerCase().replace(/,\s*usa$/, '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-new-func
  const alreadyWorked = new Function('normAddr', lift(src, '_alreadyWorked') + '\nreturn _alreadyWorked;')(normAddr);

  const ADDR = '2402 Auburn Terrace, Atlantic City, NJ 08401, USA';
  const quoted = (iso) => ({ [normAddr(ADDR)]: Date.parse(iso) });

  // Marianne's actual case: quote on file from 21 Aug, application on 18 Sep.
  ok(alreadyWorked({ propAddress: ADDR, submittedAt: '2026-09-18T17:45:00Z' }, quoted('2026-08-21T00:00:00Z')) === false,
    'a NEW application at an already-quoted address stays visible (the reported bug)');
  // A lead that was genuinely worked afterwards still drops off the board.
  ok(alreadyWorked({ propAddress: ADDR, submittedAt: '2026-08-01T00:00:00Z' }, quoted('2026-08-21T00:00:00Z')) === true,
    'a lead quoted AFTER it came in is still hidden');
  ok(alreadyWorked({ propAddress: ADDR, submittedAt: '2026-08-21T00:00:00Z' }, quoted('2026-08-21T00:00:00Z')) === true,
    'same instant counts as worked');
  ok(alreadyWorked({ propAddress: ADDR, submittedAt: '2026-09-18T17:45:00Z' }, {}) === false,
    'no quote at that address — always visible');
  ok(alreadyWorked({ propAddress: 'somewhere else', submittedAt: '2026-01-01T00:00:00Z' }, quoted('2026-08-21T00:00:00Z')) === false,
    'a different address is untouched');
  ok(alreadyWorked({ propAddress: ADDR }, quoted('2026-08-21T00:00:00Z')) === true,
    'an undated legacy prospect keeps the old behaviour (hidden)');
  ok(alreadyWorked({ propAddress: '2402 auburn terrace, atlantic city, nj 08401' }, quoted('2026-08-21T00:00:00Z')) === true,
    'address matching still normalizes');
  ok(alreadyWorked({}, {}) === false, 'a prospect with no address is never hidden');
}

// ── 2. Financial Audit verify controls ────────────────────────────────────
{
  const html = fs.readFileSync(path.join(ROOT, 'deploy/financial-audit.html'), 'utf8');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  // eslint-disable-next-line no-new-func
  const make = new Function('esc', 'state', `
    var _rows = state.rows, _data = state.data;
    ${lift(html, 'rowByKey')}
    ${lift(html, 'rowKeyArg')}
    return { rowByKey: rowByKey, rowKeyArg: rowKeyArg };
  `);

  const wire = { key: 'wire:l_1', kind: 'wire', address: '1 Main St', status: 'overdue' };
  const fee = { key: 'fee:l_1', kind: 'fee', address: '1 Main St', status: 'verified' };
  const trade = { key: 'trade:t_9', kind: 'trade', buyer: 'Colchis', status: 'due' };
  // The Closings tab reads the UNFILTERED ledger; _rows is whatever the filter left.
  const api = make(esc, { rows: [trade], data: { rows: [wire, fee, trade] } });

  ok(api.rowByKey('wire:l_1') === wire, 'a row hidden by the filter still resolves (the dead-button bug)');
  ok(api.rowByKey('fee:l_1') === fee, 'a second filtered-out row resolves');
  ok(api.rowByKey('trade:t_9') === trade, 'a visible row resolves');
  ok(api.rowByKey('nope') === null, 'an unknown key returns null rather than undefined');
  ok(api.rowKeyArg(wire) === "'wire:l_1'", 'the handler argument is the quoted key');
  ok(!/\bindexOf\b/.test(lift(html, 'verifyCell')), 'verifyCell no longer addresses rows by position');

  // A row present only in the filtered view (never in _data.rows) still works.
  const only = { key: 'x:1', kind: 'fee' };
  const api2 = make(esc, { rows: [only], data: { rows: [] } });
  ok(api2.rowByKey('x:1') === only, 'a row only in the filtered list still resolves');
  const api3 = make(esc, { rows: [], data: null });
  ok(api3.rowByKey('x:1') === null, 'no data loaded yet is handled');
}

// ── 3. The doc-move entry carries its naming flags ────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions/loan-review-doc-move.mjs'), 'utf8');
  ok(/_moved\.nameManual = true/.test(src), 'move keeps nameManual');
  ok(/_moved\.nameLocked = true/.test(src), 'move keeps nameLocked');
  ok(/_moved\.nameAuto = md\.nameAuto/.test(src), 'move keeps nameAuto');
  ok(/_moved\.nameVersion = md\.nameVersion/.test(src), 'move keeps nameVersion');
}

// ── 4. The long-hold review writers all go through the fresh-tray save ────
for (const f of ['loan-review-doc-upload-chunk.mjs', 'loan-review-ai-retry.mjs', 'loan-review-doc-upload.mjs']) {
  const src = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions', f), 'utf8');
  ok(/saveTrayFresh/.test(src), f + ' uses the fresh-read tray save');
}

// ── 5. Index writes are awaited ───────────────────────────────────────────
for (const [f, needle] of [['prospects-save.mjs', 'prospectsIndex.upsertRecord'], ['quotes-save.mjs', 'quotesIndex.upsertRecord']]) {
  const src = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions', f), 'utf8');
  const calls = src.split('\n').filter((l) => l.includes(needle));
  ok(calls.length > 0 && calls.every((l) => l.includes('await ' + needle)), f + ': every index write is awaited');
}

// ── 6. The anniversary cron stamps the record it writes ───────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions/followup-reminder-cron.mjs'), 'utf8');
  ok(/const target = loans\.find/.test(src), 'the cron stamps the loan inside the client it saves');
  ok(!/it\.loan\.anniversaryNotified = Object\.assign/.test(src), 'it no longer stamps the discarded copy');
}

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
