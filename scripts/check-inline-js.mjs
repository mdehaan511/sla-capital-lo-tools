#!/usr/bin/env node
/**
 * scripts/check-inline-js.mjs — concatenate every inline <script>
 * block of an HTML page and node --check the result. Catches syntax
 * errors that per-file node --check can't see (inline blocks) —
 * the "rateEl is not defined" CLASS still needs runtime testing, but
 * parse errors die here. Usage: node scripts/check-inline-js.mjs deploy/dscr-sizer.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file) { console.error('usage: check-inline-js.mjs <file.html>'); process.exit(1); }
const html = readFileSync(file, 'utf8');
const blocks = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html)) !== null) blocks.push(m[1]);
const out = '/tmp/inline-' + process.pid + '.js';
writeFileSync(out, blocks.join('\n;\n'));
try {
  execFileSync('node', ['--check', out], { stdio: 'inherit' });
  console.log('INLINE-JS-OK (' + blocks.length + ' blocks, ' + file + ')');
} catch (e) {
  process.exit(1);
}
