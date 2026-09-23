#!/usr/bin/env node
/**
 * scripts/sizer-save-guard-test.mjs — Deploy 237.254 (Mike)
 *
 * Jeremy (9/23): four saves of a DSCR broker deal each showed "✓ Saved" and each died on a
 * ReferenceError before the loan write (237.215 → 237.251), leaving a "Loan record missing"
 * card and no red toast, because the throw was synchronous -- outside the promise chain the
 * failure handler is attached to. Every sizer's loan-save block now runs under one try whose
 * catch is the same failure handler. This guards that shape, and that nothing else changed:
 *   - the quote write still precedes the block (the immediate-feedback guarantee);
 *   - the try opens before saveFromSizer is called and closes after the legacy branches;
 *   - the catch calls a handler declared in the same function, and that handler shows the
 *     red toast and the red button.
 *
 * Run: node scripts/sizer-save-guard-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fail = 0;
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};
const DEPLOY = new URL('../deploy/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');

function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { i++; break; } }
  return src.slice(start, i);
}
const balanced = (s) => { let d = 0; for (const c of s) { if (c === '{') d++; else if (c === '}') d--; if (d < 0) return false; } return d === 0; };

for (const [f, handler] of [['dscr-sizer.html', 'handleDscrSaveFailure'], ['mf-dscr-sizer.html', 'handleDscrSaveFailure'], ['rtl-sizer.html', 'handleSaveFailure'], ['guc-sizer.html', 'handleSaveFailure']]) {
  console.log('\n' + f);
  const src = read(f);
  const fn = lift(src, 'saveCurrentQuote');
  assert('saveCurrentQuote found', fn.length > 1000);
  const iQuote = fn.indexOf('QuoteStore.saveQuote(');
  const iTry = fn.indexOf('    try {\n    if (window.SLA && SLA.Clients && SLA.Clients.saveFromSizer) {');
  const iCall = fn.indexOf('SLA.Clients.saveFromSizer(_payload)');
  const iCatch = fn.indexOf('} catch (_saveErr) { ' + handler + '(_saveErr); }');
  assert('the quote is written (and the green Saved shown) BEFORE the loan-save block, as designed', iQuote > 0 && iQuote < iTry);
  assert('the try opens before the loan save is called', iTry > 0 && iCall > iTry);
  assert('...and closes after the legacy branches, calling the failure handler', iCatch > iCall, String([iTry, iCall, iCatch]));
  const block = fn.slice(iTry + '    try {\n'.length, iCatch);
  assert('the guarded block is one balanced statement', balanced(block));
  assert('the handler is declared in the same function (hoisted, reachable from the catch)', fn.indexOf('function ' + handler + '(err)') > 0);

  // the handler itself: red toast + red button, and it never rethrows
  const h = lift(fn, handler);
  const ctx = { toasts: [], btn: { textContent: '', classList: { add(c) { this.added = c; }, remove() {} } }, console: { error() {} }, setTimeout() {} };
  ctx.showToast = (m) => ctx.toasts.push(m);
  vm.createContext(ctx);
  vm.runInContext('var btn = this.btn;\n' + h + '\n' + handler + '(new ReferenceError("loanRec is not defined"));', ctx);
  assert('a synchronous crash now shows the red toast with the reason', ctx.toasts.length === 1 && /Save did not reach the server: loanRec is not defined/.test(ctx.toasts[0]), JSON.stringify(ctx.toasts));
  assert('...and the red button', ctx.btn.textContent.indexOf('Save failed') > 0 && ctx.btn.classList.added === 'save-failed');
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
