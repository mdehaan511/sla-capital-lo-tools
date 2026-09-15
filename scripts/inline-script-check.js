#!/usr/bin/env node
// Parse-check every inline <script> block of the given HTML files (new Function()).
// Kept in the repo (Deploy 237.063) because /tmp copies kept disappearing.
const fs = require('fs');
let bad = 0;
for (const f of process.argv.slice(2)) {
  const html = fs.readFileSync(f, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    try { new Function(m[1]); } catch (e) { bad++; console.log('PARSE FAIL', f, 'block', n, e.message); }
  }
  console.log(f, n, 'inline blocks checked');
}
process.exit(bad ? 1 : 0);
