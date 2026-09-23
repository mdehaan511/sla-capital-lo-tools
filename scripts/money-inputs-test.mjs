#!/usr/bin/env node
/**
 * scripts/money-inputs-test.mjs — Deploy 237.252 (Mike)
 *
 * "Make it so that all inputs that are used for financial items in the sizer and
 * throughout the app are formatted to be currencies meaning they show the dollar sign and
 * commas where appropriate." — "Do this for all future input fields as well."
 *
 * Two halves:
 *   1. sla-money.js RUNS against a small fake DOM: a bound input shows "$650,000", reads
 *      back "650000", keeps the caret while typing, formats a programmatic set, converts a
 *      type="number", and picks up inputs added later.
 *   2. THE CONVENTION, enforced for the future: every <input> in deploy/ whose id, name or
 *      placeholder looks like money carries data-money (or is in the allowlist below with
 *      a reason), and every page that has a data-money input loads /sla-money.js.
 *
 * Run: node scripts/money-inputs-test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

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
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');

// ── a fake DOM just big enough ──────────────────────────────────────────────
function makeDom() {
  const inputs = [];
  function HTMLInputElement() {}
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    configurable: true, enumerable: true,
    get() { return this._v == null ? '' : this._v; },
    set(v) { this._v = String(v); if (this._sel == null || this._sel > this._v.length) this._sel = this._v.length; },
  });
  function input(attrs) {
    const el = new HTMLInputElement();
    el.attrs = Object.assign({}, attrs || {});
    el.type = el.attrs.type || 'text';
    el._v = el.attrs.value || '';
    el.nodeType = 1;
    el.handlers = {};
    el.getAttribute = (k) => (k in el.attrs ? el.attrs[k] : null);
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.addEventListener = (t, fn) => { (el.handlers[t] = el.handlers[t] || []).push(fn); };
    el.fire = (t) => { (el.handlers[t] || []).forEach((fn) => fn.call(el, { type: t })); };
    el.matches = (sel) => sel === 'input[data-money]' && 'data-money' in el.attrs;
    el.querySelectorAll = () => [];
    Object.defineProperty(el, 'selectionStart', { get() { return el._sel; }, set(v) { el._sel = v; } });
    el.setSelectionRange = (a) => { el._sel = a; };
    // what a person does: type one character at the caret, then the page's input event
    el.typeChar = (ch) => { const t = HTMLInputElement.prototype.__lookupGetter__('value').call(el); const p = el._sel; HTMLInputElement.prototype.__lookupSetter__('value').call(el, t.slice(0, p) + ch + t.slice(p)); el._sel = p + 1; el.fire('input'); };
    el.text = () => HTMLInputElement.prototype.__lookupGetter__('value').call(el);
    inputs.push(el);
    return el;
  }
  let observer = null;
  const document = {
    readyState: 'complete', documentElement: { nodeType: 1 },
    querySelectorAll: (sel) => (sel === 'input[data-money]' ? inputs.filter((e) => 'data-money' in e.attrs) : []),
    matches: () => false, addEventListener() {},
  };
  const w = {
    HTMLInputElement, document, console,
    MutationObserver: function (cb) { observer = { cb }; this.observe = () => {}; },
    Object, String, Number, parseFloat, isFinite, RegExp, Array,
  };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(read('sla-money.js'), w, { filename: 'sla-money.js' });
  return { w, input, added: (el) => observer && observer.cb([{ addedNodes: [el] }]) };
}

// ── 1. the formatter ────────────────────────────────────────────────────────
console.log('\nsla-money.js: the number and its currency face');
{
  const { w } = makeDom();
  const M = w.SLA_MONEY;
  check('fmt: whole dollars get a sign and commas', ['650000', 650000, '1234567', '0', '5'].map(M.fmt), ['$650,000', '$650,000', '$1,234,567', '$0', '$5']);
  check('fmt: cents only when there are any, then two', ['1234.5', '1234.50', '1234.567', '1234.00', '.5'].map(M.fmt), ['$1,234.50', '$1,234.50', '$1,234.56', '$1,234', '$0.50']);
  check('fmt: already formatted, pasted with junk, negative, empty', ['$1,234', '$ 12,345 USD', '-2500', '', '-', '.', 'abc', null].map(M.fmt), ['$1,234', '$12,345', '-$2,500', '', '', '', '', '']);
  check('num / raw: the plain number behind the text', [M.num('$650,000'), M.num('$1,234.56'), M.num(''), M.num('-$2,500'), M.raw('$1,234.5')], [650000, 1234.56, 0, -2500, '1234.5']);
}

// ── 2. a bound input ────────────────────────────────────────────────────────
console.log('\nA bound input');
{
  const { w, input, added } = makeDom();
  const M = w.SLA_MONEY;
  const el = input({ id: 'loanAmt', type: 'number', value: '650000', 'data-money': '' });
  M.sweep(w.document);
  check('a type="number" becomes text + decimal keypad, shows currency, READS the plain number', [el.type, el.attrs.inputmode, el.text(), el.value], ['text', 'decimal', '$650,000', '650000']);
  check('parseFloat(el.value) — every existing reader — still works', parseFloat(el.value), 650000);
  el.value = 725000;
  check('a programmatic set (sizer load, prefill) displays formatted and reads back plain', [el.text(), el.value], ['$725,000', '725000']);
  el.value = '';
  check('clearing clears', [el.text(), el.value], ['', '']);
  el.value = '$1,234.5';
  check('setting an already-formatted string is fine', [el.text(), el.value], ['$1,234.50', '1234.50']);

  // typing "1234567" from empty, caret at the end each time
  el.value = ''; el.fire('focus'); el._sel = 0;
  '1234567'.split('').forEach((c) => el.typeChar(c));
  check('while typing: commas and the sign appear as you go, caret stays at the end', [el.text(), el._sel, el.value], ['$1,234,567', 10, '1234567']);
  // insert a digit in the middle: "$1,234,567" → put caret after "$1,2" (index 4) and type "9"
  el._sel = 4; el.typeChar('9');
  check('a digit typed in the middle lands where the caret was, and the caret follows it', [el.text(), el._sel], ['$12,934,567', 5]);
  // a trailing dot / a single cent digit survive while typing
  el.value = ''; el._sel = 0; '1234.'.split('').forEach((c) => el.typeChar(c));
  check('a trailing "." is kept while typing', el.text(), '$1,234.');
  el.typeChar('5');
  check('...and one cent digit', [el.text(), el.value], ['$1,234.5', '1234.5']);
  el.fire('blur');
  check('blur settles it to two cents', [el.text(), el.value, el._slaTyping], ['$1,234.50', '1234.50', false]);
  // a page's own mask setting this.value while focused (apply.html applyMoneyMask) is harmless
  el.fire('focus'); el.value = '1,234';
  check('a page-side mask that sets a comma string while focused: still currency, still plain to read', [el.text(), el.value], ['$1,234', '1234']);
  el.fire('blur');

  // inputs rendered later are bound by the observer; a non-money input is untouched
  const later = input({ id: 'sv-upb', value: '98765.4', 'data-money': '' });
  const plain = input({ id: 'fico', type: 'number', value: '740' });
  added(later); added(plain);
  check('an input rendered later is picked up', [later.text(), later.value], ['$98,765.40', '98765.40']);
  check('an input without data-money is left alone', [plain.type, plain.value, plain._slaMoney], ['number', '740', undefined]);
  check('binding twice is a no-op', (M.bind(later), later.handlers.input.length), 1);
}

// ── 3. the convention, for every input in the app ───────────────────────────
console.log('\nEvery money-looking input carries data-money; every such page loads the script');
{
  const MONEYISH = /(amt|amount|price|value|rent|tax|insur|hoa|fee|budget|balance|payoff|income|cost|reserve|escrow|deposit|emd|arv|aiv|cash|salary|wire|draw|holdback|upb|principal|assets|liquid|networth|revenue|proceeds|payment|debt)/i;
  // ids that match the pattern but are NOT dollar amounts — each with its reason
  const ALLOW = {
    loanSearch: 'search box', dashLoanSearch: 'search box', pd_loanId: 'an id', mLoan: 'loan picker (address text)',
    closingCostPct: 'a percent', co_tpoSpread: 'basis points', editBps: 'basis points', brokerFee: 'points', edFeeCap: 'points cap',
    adminTpoInput: 'a percent', adminRateInput: 'a rate', adminPointsInput: 'points', 'fp-pricing': 'a rate/points text',
    pValue: 'E-Sign field value (text)', sqftCurrent: 'square feet', sqftPost: 'square feet', 'pc-lotSize': 'square feet',
    slaBdayYear: 'a year', vacancyPct: 'a percent', 'mfx-vacancyPct': 'a percent', points: 'points', portfolioCount: 'a count',
    aL4: 'last four of an account', 'uw-acct-last4': 'last four', 'sv-soldRate': 'a rate', 'lt-loanTerm': 'months',
    'pf-rentals': 'a count of rentals owned', f_rentals: 'a count of rentals owned',
  };
  const files = readdirSync(DEPLOY).filter((f) => /\.(html|js)$/.test(f));
  const TAG = /<input\b[^>]*>/g;
  const untagged = [], pagesMissingScript = [], numberMoney = [];
  let tagged = 0;
  for (const f of files) {
    const s = read(f);
    let m, hasMoney = false;
    while ((m = TAG.exec(s))) {
      const tag = m[0];
      const id = (tag.match(/\bid="([^"]*)"/) || [])[1] || (tag.match(/\bname="([^"]*)"/) || [])[1] || '';
      const cls = (tag.match(/\bclass="([^"]*)"/) || [])[1] || '';
      const phv = (tag.match(/\bplaceholder="([^"]*)"/) || [])[1] || '';
      const key = id || cls;
      const looks = MONEYISH.test(id) || MONEYISH.test(cls) || /^\$/.test(phv);
      if (/\bdata-money\b/.test(tag)) { tagged++; hasMoney = true; if (/type="number"/.test(tag) && !/\? 'type="text"/.test(tag)) numberMoney.push(f + ': ' + key); continue; }
      if (!looks) continue;
      if (/type="(checkbox|radio|date|email|file|hidden|password|search|tel|url)"/.test(tag)) continue;
      const bare = key.replace(/'.*?'/g, '').replace(/\+/g, '');
      if (ALLOW[key] || ALLOW[bare] || Object.keys(ALLOW).some((k) => bare.indexOf(k) >= 0 && ALLOW[k])) continue;
      untagged.push(f + ': ' + (key || tag.slice(0, 60)));
    }
    if (hasMoney && f.endsWith('.html') && !/<script src="\/sla-money\.js\?v=\d+"><\/script>/.test(s)) pagesMissingScript.push(f);
  }
  check('every money-looking input is a currency input (add data-money, or allowlist it here WITH a reason)', untagged, []);
  check('every page with a currency input loads /sla-money.js (pinned)', pagesMissingScript, []);
  check('no currency input is still type="number"', numberMoney, []);
  assert('the sweep found the app\'s money inputs (' + tagged + ')', tagged >= 80, String(tagged));
  // the JS modules that render money inputs are only ever loaded by pages that load the script
  const LD = read('loan-details.html');
  assert('loan-details.html loads the script (its JS renders money inputs)', /<script src="\/sla-money\.js\?v=\d+"><\/script>/.test(LD));
  const pin = (name) => (LD.match(new RegExp(name.replace('.', '\\.') + '\\?v=([0-9A-Za-z@]+)')) || [])[1];
  check('the coupled Loan Details scripts still carry one pin', [pin('loan-uw-tab.js') === pin('loan-uw-metrics.js'), pin('loan-uw-metrics.js') === pin('loan-doc-review.js'), pin('loan-details.js') === pin('loan-uw-metrics.js')], [true, true, true]);
  const src = read('sla-money.js');
  assert('sla-money.js is ES5 (field offices, borrowers\' phones)', !/^\s*(let|const)\s|=>/m.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
  assert('CLAUDE.md records the convention for the next developer', /data-money/.test(readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8')));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
