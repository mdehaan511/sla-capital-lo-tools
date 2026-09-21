#!/usr/bin/env node
/**
 * scripts/esign-editor-test.mjs — Deploy 237.209 (Keith, via Mike)
 *
 * Keith: "how do I save the final draft version of the updated PDF? Also, is there a way
 * to build in where there is a + symbol so we can add a document(s) anywhere within the
 * draft doc and not just after the last page?"
 *
 * esign.html is one inline script with no exports, so the pieces that can run are lifted
 * out and run, and the wiring is asserted against the source. The two things worth
 * catching: an insertion point that opens the modal on the wrong page (Keith would put
 * his signed W-9 page in the wrong place and not notice until it was sent), and a
 * Download button that fetches the EXECUTED copy, which a draft does not have.
 *
 * Run: node scripts/esign-editor-test.mjs
 */
import { readFileSync } from 'node:fs';

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

const PAGE = readFileSync(new URL('../deploy/esign.html', import.meta.url), 'utf8');

// ── the rail: a + before every page ─────────────────────────────────────────
console.log('\nA + before every page');
// Lift the tile loop and run it against a 3-page stub.
const loopSrc = (PAGE.match(/for \(var i = 1; i <= _pdfDoc\.numPages; i\+\+\) \{\s*var shot = _pmShots\[i\];[\s\S]*?\n    \}\n    list\.innerHTML = html;/) || [''])[0];
assert('the rail loop can be lifted', loopSrc.length > 0, 'renderPageRail changed shape');
const html = new Function('_pdfDoc', '_pmShots', '_railActive',
  'var html = ""; var list = { innerHTML: "" }; ' + loopSrc + ' return html;')({ numPages: 3 }, {}, 1);
check('three pages, three insertion points', (html.match(/class="pgr-gap/g) || []).length, 3);
check('...each opening Add pages BEFORE its own page',
  (html.match(/openAddPages\((\d)\)/g) || []), ['openAddPages(1)', 'openAddPages(2)', 'openAddPages(3)']);
assert('the gap comes BEFORE its tile, not after',
  html.indexOf('openAddPages(2)') < html.indexOf('data-p="2"') && html.indexOf('data-p="1"') < html.indexOf('openAddPages(2)'),
  'a + that sits after page 2 but inserts before page 2 puts pages in the wrong place');
assert('the first gap is reachable above the first page', /pgr-gap first/.test(html));
assert('the button under the rail still adds AT THE END (no position)', /class="pgr-add" onclick="openAddPages\(\)"/.test(PAGE));
assert('a gap click cannot also select the tile', /pgr-gap[^>]*onclick="event\.stopPropagation\(\);openAddPages\(/.test(PAGE));

console.log('\nThe modal lands on the chosen position');
assert('openAddPages takes the position', /function openAddPages\(before\)/.test(PAGE));
assert('...and preselects it only when it is a real page',
  /sel\.value = \(before && before >= 1 && before <= n\) \? String\(before\) : '';/.test(PAGE),
  'an out-of-range position must fall back to the end, not a blank select');
assert('...and says so in the title', /id="addPagesTitle"/.test(PAGE) && /'Add pages before page ' \+ sel\.value/.test(PAGE));
assert('the request still sends the chosen position', /at: at \? Number\(at\) : undefined,/.test(PAGE));

// ── download without sending ────────────────────────────────────────────────
console.log('\nDownload PDF, no signature required');
assert('the editor toolbar has the button', /onclick="downloadDraft\(\)"/.test(PAGE));
assert('it fetches the ASSEMBLED draft, not the executed copy',
  /function downloadDraft\(\)[\s\S]*?which=original/.test(PAGE) &&
  !/function downloadDraft\(\)[\s\S]*?which=final[\s\S]*?\n\}\nfunction downloadFinal/.test(PAGE),
  'which=final is a 409 on a draft');
assert('...with a cache-buster, so a page change a second ago is what you get',
  /function downloadDraft\(\)[\s\S]*?'&v=' \+ Date\.now\(\)/.test(PAGE));
assert('...and refuses while the rail is mid-change',
  /if \(_railBusy \|\| _addingPages\) \{ showToast/.test(PAGE),
  'downloading during a page move races the rebuild');
assert('the filename falls back to the title with unsafe characters stripped',
  /a\.download = m \? m\[1\] : \(title \+ '\.pdf'\);/.test(PAGE));
assert('the executed-copy download is untouched', /function downloadFinal\(\)[\s\S]*?which=final/.test(PAGE));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
