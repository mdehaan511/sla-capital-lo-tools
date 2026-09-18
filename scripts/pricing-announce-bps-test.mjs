/**
 * scripts/pricing-announce-bps-test.mjs — Deploy 237.146
 *
 * Mike: "for the armory alerts for rates, instead of saying like 0.050 say bps.
 * That is more our language."
 *
 * Base rates are percentage points, so a move converts × 100 — the same
 * convention the commission plans already use (50 bps = 0.50% of the loan).
 * The last five DSCR sheets moved 0.050 / 0.075 a day, i.e. 5 and 7.5 bps.
 *
 * buildMessage is pure, but the module it lives in imports @netlify/blobs and
 * both pricing engines, so the functions under test are lifted out of the
 * source and run against a stub PRODUCTS list. Run:
 *   node scripts/pricing-announce-bps-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions/_shared/pricing-announce.mjs'), 'utf8');

let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

// Lift `export function buildMessage` and the two formatters out of the module.
function lift(name, kw) {
  const start = SRC.indexOf(kw + name);
  if (start < 0) throw new Error('not found: ' + name);
  if (kw === 'const ') { const end = SRC.indexOf('\n', SRC.indexOf('};', start) >= 0 && SRC.indexOf('};', start) < SRC.indexOf('\n\n', start) ? SRC.indexOf('};', start) : start); return SRC.slice(start, end + 1); }
  let depth = 0, i = SRC.indexOf('{', start);
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) { i++; break; } }
  return SRC.slice(start, i);
}
const fmtRateSrc = /const fmtRate = [^\n]+\n/.exec(SRC)[0];
const fmtBpsSrc = /const fmtBps = [\s\S]*?\n};\n/.exec(SRC);
ok(!!fmtBpsSrc, 'fmtBps exists (fmtDelta is gone)');
ok(!/fmtDelta/.test(SRC), 'no fmtDelta left behind');
const buildSrc = lift('buildMessage', 'export function ').replace('export function', 'function');

const PRODUCTS_STUB = "const PRODUCTS = [{ key: 'dscr', label: 'DSCR 1-4' }, { key: 'mf', label: 'Multifamily 5+' }];\n";
// eslint-disable-next-line no-new-func
const buildMessage = new Function(PRODUCTS_STUB + fmtRateSrc + fmtBpsSrc[0] + buildSrc + '\nreturn buildMessage;')();

const sheet = (fixed, arm) => ({ dscr: { fixed, arm, effective: '2026-09-17' }, mf: { fixed, arm, effective: '2026-09-17' } });

// ── The moves SLA actually ships ───────────────────────────────────────────
const CASES = [
  [6.825, 6.875, '5 bps', 'the real 9/12 → 9/15 move'],
  [6.750, 6.825, '7.5 bps', 'the real 9/11 → 9/12 move'],
  [6.875, 6.750, '12.5 bps', 'an eighth'],
  [6.875, 7.375, '50 bps', 'half a point — the only move that is 50 bps'],
  [6.875, 6.885, '1 bps', 'a single bp'],
  [7.000, 6.750, '25 bps', 'a quarter'],
];
for (const [from, to, want, label] of CASES) {
  const text = buildMessage(sheet(to, to - 0.1), sheet(from, from - 0.1));
  ok(text && text.includes('by ' + want + '.'), label + ' reads "' + want + '" [' + (text || '').slice(0, 90) + ']');
  ok(text && !/by 0\.\d/.test(text), label + ': no bare decimal delta');
}

// Direction words still work, and floor rates stay percentages.
{
  const up = buildMessage(sheet(6.875, 6.775), sheet(6.825, 6.725));
  ok(up.includes('increased by 5 bps'), 'an increase reads "increased by 5 bps"');
  ok(up.includes('6.875%') && up.includes('6.775%'), 'floor rates stay percentages, not bps');
  ok(up.includes('<!channel>'), 'still pings the channel');
  const down = buildMessage(sheet(6.825, 6.725), sheet(6.875, 6.775));
  ok(down.includes('decreased by 5 bps'), 'a decrease reads "decreased by 5 bps"');
  ok(/re-locking/.test(down), 'the lower-pricing tail still rides along');
}

// Mixed moves (per-product bullets) carry the sign and the unit.
{
  const cur = { dscr: { fixed: 6.875, arm: 6.775, effective: '2026-09-17' }, mf: { fixed: 7.000, arm: 6.900, effective: '2026-09-17' } };
  const prev = { dscr: { fixed: 6.825, arm: 6.725 }, mf: { fixed: 7.075, arm: 6.975 } };
  const text = buildMessage(cur, prev);
  ok(/\+5 bps/.test(text), 'mixed: the riser shows +5 bps');
  ok(/−7\.5 bps/.test(text), 'mixed: the faller shows −7.5 bps');
  ok(!/[+−]0\.\d/.test(text), 'mixed: no bare decimal deltas');
}

// Nothing moved → nothing posted.
ok(buildMessage(sheet(6.875, 6.775), sheet(6.875, 6.775)) === null, 'an unchanged sheet still posts nothing');

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
