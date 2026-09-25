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
console.log('\nThe DSCR sizer switches the choices for an Ohio address -- in Admin Mode only (237.282)');

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
  const run = new Function('$', 'window', 'SLA_DSCR', H.match(/var OHIO_PREPAY_FROM = \{[^}]*\};/)[0] + '\n' + H.match(/var OHIO_PREPAY_BACK = \{[^}]*\};/)[0] + '\n' + lift('_syncOhioPrepay') + '\nreturn _syncOhioPrepay;')((id) => els[id], { SLA_DSCR: E, _dscrAdminMode: admin === undefined ? true : !!admin }, E);
  return { sel, note, sync: run, shown: () => options.filter((o) => !o.hidden).map((o) => o.value) };
}
let P = page('12 Elm St, Columbus, OH 43215, USA', '54321');
check('before an Ohio address: the standard choices', P.shown(), ['5y6m', '54321', '321', '320', '300', 'none']);
P.sync();
check('an Ohio address: only the 1% structures (and none) are offered', P.shown(), ['11111', '1111', '111', '11', '1', 'none']);
check('...the default 5-year stepdown becomes 1-1-1-1-1, and the Ohio note shows', [P.sel.value, P.note.style.display], ['11111', '']);
assert('...the stepdowns are hidden AND disabled (cannot be picked)', P.sel.options.filter((o) => o.getAttribute('data-std')).every((o) => o.hidden && o.disabled));
check('each stepdown maps to the 1% structure of the same length', ['5y6m', '54321', '321', '320', '300', 'none'].map((v) => { const x = page('1 A St, Dayton, OH 45402', v); x.sync(); return x.sel.value; }), ['11111', '11111', '111', '11', '1', 'none']);
P = page('9 Oak Rd, Spokane, WA 99208', '111');
check('a saved Ohio code loads even before the address is checked (both sets are in the list)', P.sel.value, '111');
P.sync();
check('moved out of Ohio: back to the stepdowns, same length; 1-1-1-1 comes back as the 5-year', [P.sel.value, P.shown(), (() => { const x = page('9 Oak Rd, Spokane, WA', '1111'); x.sync(); return x.sel.value; })(), P.note.style.display], ['321', ['5y6m', '54321', '321', '320', '300', 'none'], '54321', 'none']);
P = page('', '54321'); P.sync();
check('no address yet: the standard choices, untouched', [P.sel.value, P.shown().length], ['54321', 6]);
assert('it runs at the top of every calculate()', /function calculate\(\) \{\s*\n\s*_syncOhioPrepay\(\);/.test(H));
assert('the sizer loads the pricing module that exports the helper (pin moved)', /<script src="\/?dscr-pricing\.js\?v=[0-9A-Za-z]+"><\/script>/.test(H) && !/dscr-pricing\.js\?v=237261/.test(H));
assert('no arrow functions added to the sizer', !/=>/.test(lift('_syncOhioPrepay')));

// Deploy 237.282 -- Admin Mode only
{
  // Mike: "make it so that Ohio PPP change only happens in Admin mode since if its a DIYA loan its still the same PPP"
  const d = page('12 Elm St, Columbus, OH 43215, USA', '54321', false); d.sync();
  check('Admin Mode OFF (a DIYA loan): an Ohio address keeps the standard structures', [d.shown(), d.sel.value, d.note.style.display], [['5y6m', '54321', '321', '320', '300', 'none'], '54321', 'none']);
  const back = page('12 Elm St, Columbus, OH 43215, USA', '111', false); back.sync();
  check('...and an Ohio code left over maps back to the standard one', back.sel.value, '321');
  const on = page('12 Elm St, Columbus, OH 43215, USA', '54321', true); on.sync();
  check('Admin Mode ON: the 1% structures', [on.shown(), on.sel.value], [['11111', '1111', '111', '11', '1', 'none'], '11111']);
  const H2 = read('dscr-sizer.html');
  assert('turning Admin Mode on or off reprices, and the reprice runs the sync', /function onAdminModeToggle\(\)[\s\S]*?try \{ run\(\); \} catch/.test(H2) && /function calculate\(\) \{\s*\n\s*_syncOhioPrepay\(\);/.test(H2));
  assert('the note says Admin Mode and that DIYA keeps the standard ones', /Ohio property, Admin Mode: prepayment penalties are capped at 1% by state law \(DIYA loans keep the standard structures\)/.test(H2));
}

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
