/**
 * scripts/attr-escape-test.mjs — Deploy 237.139
 *
 * Two production errors, one root cause: a document named with an apostrophe.
 *
 *   frontend  Uncaught SyntaxError: missing ) after argument list
 *             (loan-details doc review — "Owner's Rent Roll.pdf" inside an
 *             inline onclick argument)
 *   backend   500 loan-review-doc-get: Cannot convert argument to a ByteString
 *             because the character at index 38 has a value of 8217
 *             (a curly apostrophe in a Content-Disposition filename)
 *
 * This locks both in. Run: node scripts/attr-escape-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentDisposition, asciiFilename } from '../deploy/netlify/functions/_shared/content-disposition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };

// ── Pull the real escaping helpers out of the shipped frontend files ────────
function extract(src, names) {
  let out = '';
  for (const name of names) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('helper not found: ' + name);
    let depth = 0, i = src.indexOf('{', start);
    const from = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { i++; break; }
    }
    out += 'function ' + name + src.slice(src.indexOf('(', start), from) + src.slice(from, i) + '\n';
  }
  return out;
}
function helpersOf(file, names) {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8');
  // eslint-disable-next-line no-new-func
  return new Function(extract(src, names) + '\nreturn {' + names.join(',') + '};')();
}

// A browser decodes the entities escAttr produces BEFORE compiling the handler.
const htmlDecode = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const NASTY = [
  ["Owner's Rent Roll.pdf", 'straight apostrophe (the reported crash)'],
  ['Owner’s Rent Roll.pdf', 'curly apostrophe'],
  ['O’Brien Holdings LLC - Lease.pdf', 'entity name, curly'],
  ["O'Brien Holdings LLC - Lease.pdf", 'entity name, straight'],
  ['He said "hello".pdf', 'double quotes'],
  ['back\\slash.pdf', 'backslash'],
  ["both ' and \\ .pdf", 'both'],
  ['Ünïcodé — em dash.pdf', 'accents + em dash'],
  ['line\nbreak.pdf', 'newline'],
  ['</script><img src=x onerror=alert(1)>.pdf', 'markup injection'],
];

// ── 1. Inline handler arguments compile, and arrive intact ─────────────────
for (const [file, names] of [
  ['loan-doc-review.js', ['escHtml', 'escAttr', 'escJs']],
  ['loan-details.js', ['escH', 'escAttr', 'escJs']],
  ['saved-quotes.html', ['escH', 'escAttr', 'escJs']],
]) {
  const h = helpersOf(file, names);
  for (const [name, label] of NASTY) {
    const html = '<button class="small-btn" onclick="dr_downloadOneDoc(\'' + h.escJs('doc_123') + '\',\'' + h.escJs(name) + '\')">D</button>';
    const attr = /onclick="([^"]*)"/.exec(html);
    ok(!!attr, file + ': attribute stayed intact — ' + label);
    if (!attr) continue;
    const body = htmlDecode(attr[1]);
    let got = null, threw = null;
    try {
      // eslint-disable-next-line no-new-func
      new Function('dr_downloadOneDoc', body)((a, b) => { got = [a, b]; });
    } catch (e) { threw = e; }
    ok(!threw, file + ': handler compiles — ' + label + (threw ? ' [' + threw.message + ']' : ''));
    const want = name.replace(/\n/g, ' ');
    ok(got && got[1] === want, file + ': argument arrives intact — ' + label +
      (got ? ' [got ' + JSON.stringify(got[1]) + ']' : ' [handler never ran]'));
    // no unescaped markup escaped the attribute
    ok(!/[<>]/.test(attr[1]), file + ': no raw markup in the attribute — ' + label);
  }
  // escJs must be a no-op for ordinary slugs, or every existing handler changes shape
  ok(h.escJs('borrower_id__g1') === 'borrower_id__g1', file + ': plain slugs unchanged');
}

// The old helper is what broke: prove the test would have caught it.
{
  const h = helpersOf('loan-doc-review.js', ['escHtml', 'escAttr', 'escJs']);
  const body = htmlDecode('dr_downloadOneDoc(\'d\',\'' + h.escAttr("Owner's Rent Roll.pdf") + '\')');
  let threw = false;
  // eslint-disable-next-line no-new-func
  try { new Function('dr_downloadOneDoc', body); } catch (_) { threw = true; }
  ok(threw, 'escAttr alone still reproduces the SyntaxError (regression guard is real)');
}

// ── 2. Content-Disposition survives the ByteString conversion ──────────────
const latin1Safe = (v) => ![...v].some((c) => c.codePointAt(0) > 255);
for (const [name, label] of NASTY) {
  for (const type of ['inline', 'attachment']) {
    const v = contentDisposition(type, name);
    ok(latin1Safe(v), 'header is Latin-1 safe — ' + label);
    ok(v.startsWith(type + '; filename="'), 'header starts with ' + type + ' — ' + label);
    let threw = null;
    try { new Response(null, { headers: { 'Content-Disposition': v } }); } catch (e) { threw = e; }
    ok(!threw, 'Response accepts the header — ' + label + (threw ? ' [' + threw.message + ']' : ''));
    const star = /filename\*=UTF-8''(.+)$/.exec(v);
    if (star) ok(decodeURIComponent(star[1]) === name.replace(/[\r\n\t]+/g, ' ').trim(), 'filename* round-trips — ' + label);
    // the quoted fallback must not contain a quote that ends it early
    const quoted = /^[^"]*"([^"]*)"/.exec(v);
    ok(quoted && !quoted[1].includes('"'), 'quoted fallback is well formed — ' + label);
  }
}

// The exact reported failure, with the exact old code.
{
  const name = 'Rent Roll - Owner’s Statement.pdf';
  let threw = null;
  try { new Response(null, { headers: { 'Content-Disposition': 'inline; filename="' + name + '"' } }); } catch (e) { threw = e; }
  ok(threw && /ByteString/.test(threw.message), 'old header code still throws the reported error (regression guard is real)');
  ok(!(() => { try { new Response(null, { headers: { 'Content-Disposition': contentDisposition('inline', name) } }); return false; } catch (_) { return true; } })(),
    'new header code does not throw for the reported name');
}

// Readable fallbacks, extension preserved.
ok(asciiFilename('Owner’s Rent Roll.pdf') === "Owner's Rent Roll.pdf", 'curly apostrophe reads as a straight one in the fallback');
ok(asciiFilename('文書.pdf', 'document') === 'document.pdf', 'all-CJK name falls back but keeps the extension');
ok(asciiFilename('Café Lease.pdf') === 'Cafe Lease.pdf', 'accents fold to ASCII');
ok(asciiFilename('') === 'document', 'empty name has a fallback');

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
