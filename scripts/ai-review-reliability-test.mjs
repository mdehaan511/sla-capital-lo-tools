#!/usr/bin/env node
/**
 * scripts/ai-review-reliability-test.mjs — Deploy 237.221 (Mike)
 *
 * Mike: "I also noticed on some after the BPO was reviewed the BPO AIV and ARV aren't
 * reviewed."
 *
 * Measured on production before this shipped: 55 of 1,176 AI-reviewed trays (4.7%) were
 * stored as `malformed_verdict`. The raw answer was PROSE -- "I need to analyze this
 * 401(k) statement..." -- because thinking is off on this model, so on a hard document it
 * reasons in its visible answer, and max_tokens was 2,048: the JSON never finished. A
 * review that does not parse loses everything, the extracted fields included, which is
 * how a reviewed BPO ends up with no AIV / ARV on the loan.
 *
 * Second cause, separate: an RTL loan has TWO valuation trays (BPO / Valuation and
 * Appraisal) and only the first asked for AIV / ARV.
 *
 * What would hurt, so what this guards:
 *   1. extractJson handing back the WRONG object, or nothing, when the model talks around
 *      its answer. It is RUN here against the shapes production actually produced.
 *   2. A cut-off answer being reported as "malformed" (different problem, different fix).
 *   3. An assistant-prefill "fix": current models reject it with a 400 -- every review
 *      would fail, not 4.7% of them.
 *   4. The RTL-only appraisal fields leaking onto a DSCR loan, where aivBpo is a pricing
 *      input that product does not use.
 *   5. The valuation alert existing as three copies again.
 *
 * Run: node scripts/ai-review-reliability-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fieldsForSlug } from '../deploy/netlify/functions/_shared/uw-field-map.mjs';

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
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, FN), 'utf8');
// Comments explain the bugs this guards, in the bugs' own words. Checks that look for a
// bad pattern must not trip on the explanation.
// ORDER MATTERS. The reviewer has a line comment reading "image/*  -> ..." -- strip block
// comments greedily first and that "/*" swallows 430 lines of real code up to the next
// "*/", after which every "this bad pattern is absent" check passes on an empty file.
// So: doc blocks that START a line, then line comments, then one-line inline blocks.
const code = (s) => s
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
  .replace(/\/\*[^\n]*?\*\//g, '');

// ── 1. extractJson, run ─────────────────────────────────────────────────────
console.log('\nextractJson, run against what the model actually sends');
const REV = read('_shared/anthropic-doc-review.mjs');
const a = REV.indexOf('export function extractJson(text) {');
const b = REV.indexOf('\nfunction normalizeFinding(f) {');
assert('extractJson was found in the reviewer', a > 0 && b > a);
const ctx = {};
vm.createContext(ctx);
vm.runInContext(REV.slice(a, b).replace('export function', 'function') + '\nthis.extractJson = extractJson;', ctx);
const ex = (t) => { const r = ctx.extractJson(t); return r == null ? null : JSON.parse(JSON.stringify(r)); };

const V = { verdict: 'approved', summary: 'ok', findings: [], extractedFields: { aivBpo: 410000, arvBpo: 565000 } };
const VS = JSON.stringify(V);
check('a clean answer', ex(VS), V);
check('a fenced answer', ex('```json\n' + VS + '\n```'), V);
check('PROSE FIRST, the production failure', ex('I need to analyze this 401(k) statement carefully.\n\nThe balance is $84,000.\n\n' + VS), V);
check('a note AFTER the answer', ex(VS + '\n\nNote: the ARV is labeled "Subject To Completion".'), V);
// The old code was one greedy regex, first "{" to LAST "}". These two are what it got wrong.
const braceBefore = 'The entity name {as written} differs slightly.\n' + VS;
const braceAfter = VS + '\nLet me know if the {entity} should be re-checked.';
check('prose with a brace of its own BEFORE the answer', ex(braceBefore), V);
check('prose with a brace of its own AFTER the answer', ex(braceAfter), V);
const oldExtract = (t) => { const m = String(t).match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } };
check('...and the old regex really did lose both (this test has teeth)', [oldExtract(braceBefore), oldExtract(braceAfter)], [null, null]);
const tricky = { verdict: 'issues', summary: 'Name reads "ACME {Holdings} LLC" with a \\ and a } in it', findings: [{ severity: 'high', text: 'a "quoted {brace}" inside' }] };
check('braces, quotes and backslashes INSIDE strings do not end the object early', ex('Here you go: ' + JSON.stringify(tricky)), tricky);
check('two objects: the one that is a VERDICT wins, not the first', ex('{"note":"thinking"}\n' + VS), V);
check('a lone non-verdict object is still returned (caller normalizes it)', ex('{"summary":"x"}'), { summary: 'x' });
check('a CUT-OFF answer is not invented into one', ex('I will check each page.\n{"verdict":"approved","summary":"The BPO conclu'), null);
check('prose with no JSON at all', ex('I was unable to read this document.'), null);
check('empty', [ex(''), ex(null)], [null, null]);

// ── 2. the request + the failure it reports ─────────────────────────────────
console.log('\nThe request, and what a failure is called');
const C = code(REV);
assert('the comment stripper left the code standing (or every "absent" check below is vacuous)',
  /await logAiUsage\(/.test(C) && /function normalizeFinding\(/.test(C) && C.length > REV.length * 0.35, 'kept ' + C.length + ' of ' + REV.length);
const mt =C.match(/const MAX_OUTPUT_TOKENS = (\d+);/);
assert('the output ceiling leaves room for prose AND the JSON', mt && Number(mt[1]) >= 8192, 'is ' + (mt && mt[1]));
assert('stop_reason is read', /data\.stop_reason/.test(C));
assert('a cut-off answer is called "truncated", not "malformed"', /error: truncated \? 'truncated' : 'malformed_verdict'/.test(C));
assert('stop reason rides along on success too (it is how the next 4.7% gets diagnosed)', (C.match(/stopReason/g) || []).length >= 5);
assert('NO assistant prefill -- current models answer it with a 400', !/role:\s*['"]assistant['"]/.test(C));
assert('the model Mike chose is unchanged', /const MODEL = process\.env\.DOC_REVIEW_MODEL \|\| 'claude-sonnet-4-6';/.test(C));
assert('thinking was not switched on as a side effect (cost + latency on every review)', !/thinking\s*:/.test(C));
const tail = REV.slice(REV.indexOf('_integrityRule,\n'), REV.indexOf("].join('\\n');", REV.indexOf('_integrityRule,\n')));
assert('the LAST line of the prompt is the JSON-only instruction', /first character you write must be \{/.test(tail) && /no analysis, reasoning, preamble/.test(tail), tail.slice(-200));

// ── 3. RTL appraisals carry AIV / ARV; DSCR ones must not ───────────────────
console.log('\nWhich trays are asked for AIV / ARV');
const keys = (slug, lt) => (fieldsForSlug(slug, lt) || []).map((f) => f.key);
const has = (slug, lt) => ['aivBpo', 'arvBpo'].map((k) => keys(slug, lt).indexOf(k) >= 0);
check('BPO tray: every loan type, as before', [has('bpo_valuation', 'rtl'), has('bpo_valuation', 'dscr'), has('bpo_valuation')], [[true, true], [true, true], [true, true]]);
check('Appraisal tray on RTL and GUC: now asked', [has('appraisal', 'rtl'), has('appraisal', 'guc'), has('appraisal', 'RTL')], [[true, true], [true, true], [true, true]]);
check('Appraisal tray on DSCR: NOT asked', has('appraisal', 'dscr'), [false, false]);
check('a caller that forgets the loan type gets the safe set', has('appraisal'), [false, false]);
check('a portfolio property tray (__p1) is the same tray', has('appraisal__p1', 'rtl'), [true, true]);
assert('the appraisal still reads what it always read', keys('appraisal', 'dscr').indexOf('asIsPrice') >= 0);
check('nothing else in the map changed shape for callers without a loan type',
  Object.keys({ bank_stmt_current: 1, purchase_contract: 1, entity_background_check: 1 }).map((s) => (fieldsForSlug(s) || []).length === (fieldsForSlug(s, 'rtl') || []).length), [true, true, true]);
const callers = ['borrower-intake-upload.mjs', 'loan-review-ai-background.mjs', 'loan-review-ai-retry.mjs', 'loan-review-doc-upload.mjs'];
check('every review path passes the loan type', callers.filter((f) => !/fieldsForSlug\((?:body\.)?slug, review\.loanType\)/.test(code(read(f)))), []);

// ── 4. the valuation alert: one helper, worded for its document ─────────────
console.log('\nThe under-purchase-price alert');
const W = read('_shared/uw-field-write.mjs');
const wa = W.indexOf('export function bpoAlertFor(');
const wb = W.indexOf('\n}\n', wa) + 3;
const wctx = {};
vm.createContext(wctx);
vm.runInContext(W.slice(wa, wb).replace('export function', 'function') + '\nthis.bpoAlertFor = bpoAlertFor;', wctx);
const alertFor = (slug, aiv, pp) => wctx.bpoAlertFor(slug, aiv == null ? [] : [{ key: 'aivBpo', value: aiv }], { purchasePrice: pp });
assert('a BPO under the purchase price', /^BPO as-is value \(\$380,000\) is BELOW the purchase price \(\$400,000\).*due to the BPO\.$/.test(alertFor('bpo_valuation', 380000, 400000)));
assert('an APPRAISAL under it says appraisal, not BPO', /^Appraisal as-is value .*due to the appraisal\.$/.test(alertFor('appraisal', '380,000', '$400,000')));
check('a clean read clears a stale alert', [alertFor('bpo_valuation', 450000, 400000), alertFor('appraisal', 450000, 400000)], ['', '']);
check('no value read: leave whatever is there', [alertFor('bpo_valuation', null, 400000), alertFor('appraisal', null, 400000)], [null, null]);
assert('a portfolio property tray alerts too', /BELOW/.test(alertFor('bpo_valuation__p0', 100, 200) || ''));
check('any other tray has nothing to say', [alertFor('purchase_contract', 100, 200), alertFor('', 100, 200)], [null, null]);
const copies = ['loan-review-doc-upload.mjs', 'loan-review-ai-background.mjs', 'loan-review-ai-retry.mjs', 'borrower-intake-upload.mjs']
  .filter((f) => /is BELOW the purchase price/.test(code(read(f))));
check('the sentence lives in ONE place (it was three)', copies, []);
check('all three staff review paths call the helper', ['loan-review-doc-upload.mjs', 'loan-review-ai-background.mjs', 'loan-review-ai-retry.mjs'].filter((f) => !/bpoAlertFor\(/.test(code(read(f)))), []);

// ── 5. the AI chip opens the AI review ──────────────────────────────────────
console.log('\nThe AI chip');
const DR = readFileSync(new URL('../deploy/loan-doc-review.js', import.meta.url), 'utf8');
const LD = readFileSync(new URL('../deploy/loan-details.html', import.meta.url), 'utf8');
const chipBlock = DR.slice(DR.indexOf('var _aiChipAttrs ='), DR.indexOf('var _aiChipAttrs =') + 1400);
check('all three chips (✓ ✗ ?) are clickable', (chipBlock.match(/"' \+ _aiChipAttrs \+ '/g) || []).length, 3);
// onclick specifically: the keydown handler carries the same words, and matching either
// one let a click that ALSO toggled the header through.
assert('the click does not also toggle the tray header underneath it', /onclick="event\.stopPropagation\(\);dr_openAi\(/.test(chipBlock) && !/onclick="dr_openAi\(/.test(chipBlock));
assert('keyboard reaches it too', /tabindex="0"/.test(chipBlock) && /onkeydown=/.test(chipBlock));
assert('the slug goes through escJs (names with punctuation have broken inline handlers before)', /dr_openAi\(\\'' \+ escJs\(slug\) \+ '\\'\)/.test(chipBlock));
const oa = DR.indexOf('global.dr_openAi = function(slug) {');
const ob = DR.indexOf('\n  };', oa) + 5;
assert('dr_openAi exists', oa > 0);
const mk = () => {
  const c = { _expanded: {}, _aiOpenTray: {}, renders: 0, scrolled: [], global: {} };
  c.render = () => { c.renders++; };
  c.document = { getElementById: (id) => ({ scrollIntoView: () => c.scrolled.push(id) }) };
  vm.createContext(c);
  vm.runInContext(DR.slice(oa, ob), c);
  return c;
};
let c = mk();
c.global.dr_openAi('bpo_valuation');
check('first click: tray open, review open, drawn, scrolled to', [c._expanded.bpo_valuation, c._aiOpenTray.bpo_valuation, c.renders, c.scrolled], [true, true, 1, ['dr-ai_bpo_valuation']]);
c.global.dr_openAi('bpo_valuation');
check('second click: review folds away, the tray stays open', [c._expanded.bpo_valuation, c._aiOpenTray.bpo_valuation, c.renders, c.scrolled.length], [true, false, 2, 1]);
c = mk(); c._aiOpenTray.x = true; c._expanded.x = false;   // review flagged open but the tray was collapsed by hand
c.global.dr_openAi('x');
check('chip on a COLLAPSED tray always opens (never a click that appears to do nothing)', [c._expanded.x, c._aiOpenTray.x], [true, true]);
assert('the folded review on Underwriting opens from that flag', /<details class="dr-ai-collapse" id="dr-ai_' \+ escAttr\(slug\) \+ '"' \+ \(_aiOpenTray\[slug\] \? ' open' : ''\)/.test(DR));
assert('...all the way: findings, not a second "Details" click', /var _compact = !\(_aiDetailsOpen\[_dkey\] \|\| _aiOpenTray\[slug\]\);/.test(DR));
assert('the flag is reset with the other per-loan view state', /_aiDetailsOpen = \{\}; \/\/ Deploy 237\.070\n\s+_aiOpenTray = \{\};/.test(DR));
const pin = (LD.match(/loan-doc-review\.js\?v=([0-9A-Za-z@.]+)/) || [])[1] || '';
const stamp = (DR.match(/_aiOpenTray = \{\};\s+\/\/ Deploy (?:237\.)?([0-9@A-Z]+)/) || [])[1] || '';
assert('the page pins a loan-doc-review.js that HAS dr_openAi (guard the function, not the namespace)',
  pin.replace(/\D/g, '') !== '' ? pin.replace(/\D/g, '').endsWith(stamp.replace(/\D/g, '')) : pin === stamp || /DEPLOY/.test(pin), 'pin ' + pin + ' vs deploy ' + stamp);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
