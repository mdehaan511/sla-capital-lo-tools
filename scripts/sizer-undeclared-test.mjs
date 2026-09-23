#!/usr/bin/env node
/**
 * scripts/sizer-undeclared-test.mjs — Deploy 237.251
 *
 * The `rateEl is not defined` class (CLAUDE.md gotcha #1): `node --check` and the inline-JS
 * checker both pass an identifier that was never declared, because JavaScript only fails it
 * at runtime — inside a button's onclick, in production, for whichever LO takes that branch.
 * 237.193 was `rateEl` in the RTL save; 237.250 was `loanRec` in the two DSCR sizers' save
 * (the RTL sizer's name pasted into files whose variable is `loanRecord`), which only fired
 * on a broker deal saved without a borrower name.
 *
 * This lifts `saveCurrentQuote` from each sizer and checks every identifier used as the ROOT
 * of a member access (`foo.bar`, `foo[...]`) or called (`foo(`) is declared somewhere the
 * function can see it: its own `var`/params, the file's top-level `var`/`function`, a
 * `window.foo =` assignment anywhere in the page's scripts, or a browser / library global.
 * Conservative on purpose (roots and calls only), so a miss here is a real ReferenceError.
 *
 * Run: node scripts/sizer-undeclared-test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const DEPLOY = new URL('../deploy/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');

// Browser + library globals a sizer may reach for without declaring.
const GLOBALS = new Set(['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'history', 'console',
  'JSON', 'Math', 'String', 'Number', 'Boolean', 'Date', 'Array', 'Object', 'Promise', 'Error', 'RegExp', 'Map', 'Set', 'Symbol',
  'parseFloat', 'parseInt', 'isFinite', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'alert', 'confirm', 'prompt', 'fetch', 'URLSearchParams', 'URL', 'FormData', 'Blob', 'FileReader',
  'requestAnimationFrame', 'Intl', 'arguments', 'this', 'undefined', 'NaN', 'Infinity', 'Function', 'Event', 'CustomEvent',
  'SLA', 'SLA_DSCR', 'SLA_RTL', 'SLA_GUC', 'SLARateSheet', 'ClientBook', 'QuoteStore', 'netlifyIdentity', 'jspdf', 'jsPDF', 'google', 'SLAForms', 'SLANav', 'SLANotify']);

// Strip comments and string/regex-ish literals so identifiers inside them do not count.
function stripLiterals(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++; out += q;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += q; continue;
    }
    out += c; i++;
  }
  return out;
}
// The function body: from `function saveCurrentQuote(` to its balanced closing brace.
function liftFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found');
  const clean = stripLiterals(src.slice(start));
  let depth = 0, i = clean.indexOf('{');
  for (; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') { depth--; if (depth === 0) break; }
  }
  return clean.slice(0, i + 1);
}
const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'var', 'let', 'const', 'function',
  'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw', 'void', 'true', 'false', 'null', 'this', 'class', 'super', 'async', 'await', 'yield']);

function undeclaredRoots(fileSrc, fnSrc) {
  // declared inside the function: var/let/const, params, inner function names, catch params
  const local = new Set();
  const params = /function\s+\w*\s*\(([^)]*)\)/.exec(fnSrc);
  if (params) params[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => local.add(p));
  let m;
  const decl = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*(?:\s*=\s*[^,;]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*=\s*[^,;]*)?)*)/g;
  while ((m = decl.exec(fnSrc))) m[1].split(',').map((s) => s.trim().split(/[\s=]/)[0]).filter(Boolean).forEach((v) => local.add(v));
  // named AND anonymous inner functions: `function name(a, b)` / `function (card)`
  const inner = /\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g;
  while ((m = inner.exec(fnSrc))) { if (m[1]) local.add(m[1]); m[2].split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => local.add(p)); }
  const arrowParams = /\(([^()]*)\)\s*=>|\b([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = arrowParams.exec(fnSrc))) (m[1] || m[2] || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => local.add(p));
  const catches = /catch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = catches.exec(fnSrc))) local.add(m[1]);
  // declared in the file (any script block): top-level-ish var/function, and window.X =.
  // Scanned RAW: a regex literal with a lone quote (e.g. /'/) would make the stripper swallow
  // real declarations; a declaration-shaped string is harmless leniency by comparison.
  const fileClean = fileSrc;
  const fileDecl = new Set();
  const fd = /\b(?:var|let|const|function)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = fd.exec(fileClean))) fileDecl.add(m[1]);
  const wd = /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = wd.exec(fileClean))) fileDecl.add(m[1]);
  // roots: `name.` / `name[` / `name(` not preceded by `.` (so obj.method is not a root)
  const roots = new Set();
  const use = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\.|\[|\()/g;
  while ((m = use.exec(fnSrc))) {
    const id = m[1];
    if (KEYWORDS.has(id) || GLOBALS.has(id) || local.has(id) || fileDecl.has(id)) continue;
    roots.add(id);
  }
  return [...roots].sort();
}

for (const page of ['dscr-sizer.html', 'mf-dscr-sizer.html', 'rtl-sizer.html', 'guc-sizer.html']) {
  console.log('\n' + page);
  const src = read(page);
  let fn;
  try { fn = liftFunction(src, 'saveCurrentQuote'); } catch (e) { fail++; console.log('  FAIL ' + e.message); continue; }
  check('saveCurrentQuote uses no identifier it never declared', undeclaredRoots(src, fn), []);
  const declared = (/var (loanRec|loanRecord) = ClientBook\.buildLoanFromSizer\(/.exec(src) || [])[1] || '';
  // on the RAW source (the lifted body has its string contents stripped)
  const rawFn = src.slice(src.indexOf('function saveCurrentQuote('));
  const stamped = (/(\w+)\.borrowerName = 'TBD'/.exec(rawFn) || [])[1] || '';
  check('the TBD placeholder lands on the loan record the page declares', stamped, declared);
}
// the scanner itself: a planted undeclared root is reported
{
  const planted = 'function saveCurrentQuote() { var a = 1; b.c = a; d(); e[0] = 2; String(a); window.f = 1; f.g = 1; }';
  check('the scanner reports planted undeclared roots', undeclaredRoots(planted, planted), ['b', 'd', 'e']);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
