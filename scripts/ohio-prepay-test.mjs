#!/usr/bin/env node
/**
 * scripts/ohio-prepay-test.mjs — Deploy 237.277 (Mike)
 *
 * "On the DSCR Sizer if a loan is in Ohio make it so the prepayment penalties are all 1 point
 * as that is Ohio state law. So its 1-1-1-1-1, 1-1-1-1, 1-1-1, 1-1, 1"
 *
 * What would hurt: an Ohio loan quoted (or saved, or printed on a term sheet) with a 5-4-3-2-1
 * stepdown; an Ohio structure priced at zero adjustment because the sheet does not list it; a
 * saved Ohio code silently dropped when the form reloads; a raw "111" on a term sheet or tape.
 * Runs the real pricing module and the sizer's own sync function against the real <select>.
 *
 * Run: node scripts/ohio-prepay-test.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const read = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');

// ── 1. pricing ──────────────────────────────────────────────────────────────
console.log('\nPricing: each Ohio structure prices as the sheet\'s structure of the same length');
const E = require('../deploy/dscr-pricing.js');
const golden = require('./fixtures/dscr-golden.json');
const base = (Array.isArray(golden) ? golden : golden.scenarios)[0].inputs;
const price = (prepay, addr) => E.priceDSCR(Object.assign({}, base, { prepay, propAddress: addr || '12 Elm St, Columbus, OH 43215' }));
const rate = (p) => price(p).finalRate;
check('1-1-1-1-1 = 54321, 1-1-1 = 321, 1-1 = 320, 1 = 300', [rate('11111'), rate('111'), rate('11'), rate('1')], [rate('54321'), rate('321'), rate('320'), rate('300')]);
check('1-1-1-1 (no 4-year on the sheet) prices as the 3-year, the conservative choice', rate('1111'), rate('321'));
const adj = price('111').adjs.find((a) => /Prepay/.test(a.label));
check('the adjustment says what it priced as', [adj.label, adj.value], ['Prepay penalty (111, priced as 321)', E.DIYA.ppp['321']]);
check('no Ohio code is left at a zero adjustment', ['11111', '1111', '111', '11', '1'].map((c) => price(c).adjs.find((a) => /Prepay/.test(a.label)).value === 0), [false, false, false, false, false]);
check('the rate sheet itself is untouched (no new keys in DIYA.ppp)', Object.keys(E.DIYA.ppp).sort(), ['300', '320', '321', '54321', '5y6m', 'none']);
check('a historical sheet prices Ohio loans too (the lookup survives setPricingAsOf)', (E.setPricingAsOf('2026-08-04'), [rate('111') === rate('321'), rate('11111') === rate('54321')]), [true, true]);
E.setPricingAsOf('');
check('the address helper the sizer uses', [E.extractStateFromAddress('12 Elm St, Columbus, OH 43215, USA'), E.extractStateFromAddress('9 Oak Rd, Spokane, WA 99208')], ['OH', 'WA']);

// ── 2. the sizer ────────────────────────────────────────────────────────────
console.log('\nThe DSCR sizer: Ohio + Admin Mode offers both sets; otherwise the standard set (237.283)');

const H = read('dscr-sizer.html');
const selHtml = H.match(/<select id="prepay">([\s\S]*?)<\/select>/)[1];
const lift = (name) => {
  const start = H.indexOf('function ' + name + '(');
  let depth = 0, i = H.indexOf('{', start);
  for (; i < H.length; i++) { if (H[i] === '{') depth++; else if (H[i] === '}' && --depth === 0) { i++; break; } }
  return H.slice(start, i);
};
function page(addr, value, admin) {
  const options = [...selHtml.matchAll(/<option ([^>]*)>([^<]*)<\/option>/g)].map((m) => {
    const attrs = m[1];
    return { value: /value="([^"]*)"/.exec(attrs)[1], text: m[2], hidden: /\bhidden\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs),
      getAttribute: (k) => { const r = new RegExp(k + '="([^"]*)"').exec(attrs); return r ? r[1] : null; } };
  });
  const sel = { options, _v: value, get value() { return this._v; }, set value(v) { if (options.some((o) => o.value === v)) this._v = v; else this._v = ''; } };
  const note = { style: { display: 'none' } };
  const els = { prepay: sel, propAddress: { value: addr }, ohioPrepayNote: note };
  // eslint-disable-next-line no-new-func
  const run = new Function('$', 'window', 'SLA_DSCR', H.match(/var OHIO_PREPAY_BACK = \{[^}]*\};/)[0] + '\n' + lift('_syncOhioPrepay') + '\nreturn _syncOhioPrepay;')((id) => els[id], { SLA_DSCR: E, _dscrAdminMode: admin === undefined ? true : !!admin }, E);
  return { sel, note, sync: run, shown: () => options.filter((o) => !o.hidden).map((o) => o.value) };
}
// Deploy 237.283 (Mike): "Admin mode needs to be able to do both of those for Ohio since sometimes
// they do Admin mode and its a DIYA loan"
const STD = ['5y6m', '54321', '321', '320', '300', 'none'];
const BOTH = ['5y6m', '54321', '321', '320', '300', '11111', '1111', '111', '11', '1', 'none'];
let P = page('12 Elm St, Columbus, OH 43215, USA', '54321', true);
check('before the sync runs: the standard choices', P.shown(), STD);
P.sync();
check('Ohio + Admin Mode: BOTH sets are offered, and the Ohio note shows', [P.shown(), P.note.style.display], [BOTH, '']);
check('...nothing is switched for the admin (a DIYA loan keeps 54321)', P.sel.value, '54321');
P = page('1 A St, Dayton, OH 45402', '111', true); P.sync();
check('...and a 1% choice stays a 1% choice', P.sel.value, '111');
assert('...every option is pickable (none disabled)', P.sel.options.every((o) => !o.disabled && !o.hidden));
P = page('12 Elm St, Columbus, OH 43215, USA', '54321', false); P.sync();
check('Ohio, Admin Mode OFF (a DIYA loan): the standard set only', [P.shown(), P.sel.value, P.note.style.display], [STD, '54321', 'none']);
assert('...the 1% set hidden AND disabled', P.sel.options.filter((o) => o.getAttribute('data-ohio')).every((o) => o.hidden && o.disabled));
check('...a leftover 1% code maps back to the same length (1-1-1-1 → the 5-year)', ['11111', '1111', '111', '11', '1', 'none'].map((v) => { const x = page('1 A St, Dayton, OH 45402', v, false); x.sync(); return x.sel.value; }), ['54321', '54321', '321', '320', '300', 'none']);
P = page('9 Oak Rd, Spokane, WA 99208', '111', true);
check('a saved 1% code loads before the sync (both sets are always in the list)', P.sel.value, '111');
P.sync();
check('not Ohio, even in Admin Mode: the standard set; the 1% code maps back', [P.shown(), P.sel.value, P.note.style.display], [STD, '321', 'none']);
P = page('', '54321', true); P.sync();
check('no address yet: the standard choices, untouched', [P.sel.value, P.shown()], ['54321', STD]);
assert('the 1% set sits under its own label in the list', /<optgroup id="ohioPrepayGroup" label="Ohio 1% \(investors other than DIYA\)" hidden disabled>[\s\S]*value="11111"[\s\S]*value="1"[\s\S]*<\/optgroup>/.test(selHtml));
assert('the note says when to use which', /state law caps a prepayment penalty at 1% — pick a 1% structure for a loan priced off another investor; a DIYA loan keeps the standard ones/.test(H));
assert('toggling Admin Mode reprices, and every reprice runs the sync first', /function onAdminModeToggle\(\)[\s\S]*?try \{ run\(\); \} catch/.test(H) && /function calculate\(\) \{\s*\n\s*_syncOhioPrepay\(\);/.test(H));
assert('nothing switches TO a 1% structure on its own any more', !/OHIO_PREPAY_FROM/.test(H));
assert('the sizer loads the pricing module that exports the helper (pin moved)', /<script src="\/?dscr-pricing\.js\?v=[0-9A-Za-z]+"><\/script>/.test(H) && !/dscr-pricing\.js\?v=237261/.test(H));
assert('no arrow functions added to the sizer', !/=>/.test(lift('_syncOhioPrepay')));

// ── 3. everywhere the code is read back ─────────────────────────────────────
console.log('\nEverywhere a prepay code is printed or mapped');
const has = (file, re) => re.test(read(file));
assert('term sheet (sizer PDF): "5-Year (1-1-1-1-1)" …', has('dscr-sizer.html', /'11111':'5-Year \(1-1-1-1-1\)','1111':'4-Year \(1-1-1-1\)','111':'3-Year \(1-1-1\)','11':'2-Year \(1-1\)','1':'1-Year \(1\)'/));
assert('eSign term sheet: "1-1-1-1-1" …', has('netlify/functions/termsheet.mjs', /p === '11111' \? '1-1-1-1-1'[\s\S]*p === '1'     \? '1'/));
for (const f of ['netlify/functions/sizer-save-loan.mjs', 'netlify/functions/loan-update-from-sizer.mjs']) assert(f + ': the sizer-history label', has(f, /'11111': '5-Year 1%', '1111': '4-Year 1%', '111': '3-Year 1%', '11': '2-Year 1%', '1': '1-Year 1%'/));
assert('Loan Details: "5yr (1-1-1-1-1)" …', has('loan-details.js', /prepay==='11111'\?'5yr \(1-1-1-1-1\)'/));
assert('the loan application PDF, on the exact code only', has('netlify/functions/_shared/loan-application-pdf.mjs', /if \(OHIO\[String\(raw\)\.trim\(\)\]\) return OHIO\[String\(raw\)\.trim\(\)\];/));
const T = await import('../deploy/netlify/functions/_shared/trade-tapes.mjs');
assert('the Stride DSCR tape: term months and type', /'1111':  \{ term: 48, type: '1-1-1-1' \}/.test(read('netlify/functions/_shared/trade-tapes.mjs')) && !!T.TRADE_TAPES.stride_dscr);
assert('the DSCR guidelines page says so', has('guidelines.html', /<strong>Ohio:<\/strong> state law caps a prepayment penalty at 1%/));
const LD = read('loan-details.html');
const pin = (n) => (LD.match(new RegExp(n.replace('.', '\\.') + '\\?v=([0-9A-Za-z@]+)')) || [])[1];
assert('Loan Details\' coupled scripts moved together', pin('loan-details.js') === pin('loan-uw-metrics.js') && pin('loan-uw-metrics.js') === pin('loan-doc-review.js') && pin('loan-uw-tab.js') === pin('loan-details.js'));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
