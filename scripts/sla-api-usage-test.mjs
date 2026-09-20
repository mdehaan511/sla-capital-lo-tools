#!/usr/bin/env node
/**
 * scripts/sla-api-usage-test.mjs — Deploy 237.200
 *
 * Mike, on the notifications page: "r.json is not a function".
 *
 * `SLA.api(method, path, body)` is NOT fetch. It reads the body itself and resolves to
 * PARSED JSON, throwing on a non-2xx with err.status / err.data. Three pages I wrote
 * treated it like fetch and called `.json()` on a plain object — so each one showed its
 * "could not load" state and nothing else. Two of them (client-details and investors, the
 * Signed Documents sections from 237.167) had been broken since Friday, and I had
 * reported that work as done having checked the endpoints and the markup but never the
 * data path.
 *
 * It is the `rateEl` class from CLAUDE.md: legal JavaScript, parses fine, fails only when
 * the promise resolves in a browser. node --check cannot see it and neither can the
 * inline-JS check, so this looks for the shape instead.
 *
 * Run: node scripts/sla-api-usage-test.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = join(root, 'deploy');

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};

const files = readdirSync(deploy)
  .filter((f) => /\.(html|js)$/.test(f))
  .filter((f) => statSync(join(deploy, f)).isFile());

/**
 * Flag `SLA.api(...)` whose result has .json() called on it. Whitespace is flattened so
 * the multi-line shapes read the same as the one-liners, and the window is kept short so
 * an unrelated fetch further down the file is not blamed on it.
 */
function offenders(src) {
  const flat = src.replace(/\s+/g, ' ');
  const hits = [];
  const re = /SLA\.api\s*\(/g;
  let m;
  while ((m = re.exec(flat))) {
    const window = flat.slice(m.index, m.index + 260);
    const next = window.indexOf('SLA.api(', 8);
    const scope = next > 0 ? window.slice(0, next) : window;
    if (/\.then\s*\(\s*(function\s*\([^)]*\)\s*\{[^}]*|\([^)]*\)\s*=>\s*)\.?[A-Za-z_$]*\.json\s*\(/.test(scope)
        || /\.then\s*\([^)]*\)\s*=>\s*[A-Za-z_$]+\.json\s*\(/.test(scope)
        || /\.json\s*\(\s*\)/.test(scope.slice(0, 160))) {
      hits.push(scope.slice(0, 90).trim());
    }
  }
  return hits;
}

console.log('\nNobody treats SLA.api as fetch');
const bad = [];
for (const f of files) {
  const hits = offenders(readFileSync(join(deploy, f), 'utf8'));
  hits.forEach((h) => bad.push(f + ' :: ' + h));
}
check('no page calls .json() on an SLA.api result', bad, []);

console.log('\nThe helper really does resolve to the parsed body');
// If this ever changes, the rule above changes with it — so assert the contract rather
// than trusting a comment.
const apiSrc = readFileSync(join(deploy, 'sla-api.js'), 'utf8');
const fn = apiSrc.slice(apiSrc.indexOf('function api(method, path, body)'));
const body = fn.slice(0, fn.indexOf('\n  }\n'));
check('it reads the body itself (r.text)', /r\.text\s*\(/.test(body), true);
check('it parses it (JSON.parse)', /JSON\.parse\(/.test(body), true);
check('it returns the parsed data, not the response', /return data;/.test(body), true);
check('and it throws on a non-2xx instead of handing back a failed response',
  /if \(!r\.ok\)[\s\S]{0,200}throw err;/.test(body), true);

// The three pages that were broken, named so a regression is obvious.
console.log('\nThe pages that had it wrong');
for (const f of ['notifications.html', 'client-details.html', 'investors.html']) {
  const src = readFileSync(join(deploy, f), 'utf8');
  check(f + ' reads the body directly', offenders(src), []);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
