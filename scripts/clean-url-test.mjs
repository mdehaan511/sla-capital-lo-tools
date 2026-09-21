#!/usr/bin/env node
/**
 * scripts/clean-url-test.mjs — Deploy 237.220 (Mike)
 *
 * Mike: "Is it possible to get rid of the .html on all of the pages? I feel like that makes
 * it look cheap."
 *
 * Netlify already serves /pipeline from pipeline.html (all 69 pages, checked live before
 * this shipped). So ROUTING does not change, nothing is redirected, and no emailed link,
 * bookmark or borrower URL can break. Two things showed people ".html": the address bar
 * keeps whatever you arrived with, and the nav's links said it. The fix is a one-line
 * snippet at the top of every page's <head> that tidies the address bar, plus a nav that
 * renders clean links and still knows which page it is on.
 *
 * What would actually hurt, so what this guards:
 *   1. A page that lost its query or its #hash on the way — sign-in tokens arrive in the
 *      hash, apply links carry ?lo=, signing links carry ?t=. Dropping one breaks a login
 *      or an application, silently.
 *   2. A clean URL that RELOADS somewhere else: a page whose name is also a redirect rule
 *      pointing elsewhere, or a folder of the same name.
 *   3. A page added later without the snippet (it would be the one page that still says
 *      .html), or a second copy drifting from the first.
 *   4. The nav no longer highlighting the page you are on, because the bar now says
 *      /pipeline and the menu says /pipeline.html.
 *
 * Run: node scripts/clean-url-test.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
const pages = readdirSync(DEPLOY).filter((f) => f.endsWith('.html')).sort();

// ── 1. every page carries it, once, first ───────────────────────────────────
console.log('\nEvery page, once, and before anything else runs');
const RE = /<script>\/\* clean-url \(Deploy[\s\S]*?<\/script>/g;
const missing = [], many = [], late = [], bodies = new Set();
pages.forEach((f) => {
  const s = read(f);
  const hits = s.match(RE) || [];
  if (hits.length === 0) { missing.push(f); return; }
  if (hits.length > 1) many.push(f);
  bodies.add(hits[0].replace(/Deploy [^,]+,/, 'Deploy N,'));
  if (s.search(/<script\b/i) !== s.indexOf(hits[0])) late.push(f);
});
check('pages with no snippet (a new page must copy it from any other page)', missing, []);
check('pages with more than one', many, []);
check('pages where another script runs first and could read the old path', late, []);
check('one snippet, not ' + pages.length + ' slightly different ones', bodies.size, 1);
assert('no unfilled deploy placeholder shipped', !pages.some((f) => read(f).indexOf('@@' + 'DEPLOY@@') >= 0));

// ── 2. run it ───────────────────────────────────────────────────────────────
console.log('\nThe snippet, run against real URLs');
const js = (read('pipeline.html').match(RE) || [''])[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
const tidy = (href, opts) => {
  const u = new URL(href);
  const calls = [];
  const state = { keep: 'me' };
  const ctx = {
    window: { location: { protocol: u.protocol, pathname: u.pathname, search: u.search, hash: u.hash } },
    history: (opts && opts.noHistory) ? undefined : { state, replaceState: (st, t, url) => calls.push({ st, url }) },
  };
  ctx.window.history = ctx.history;
  vm.runInNewContext(js, ctx);
  return calls.length ? (calls[0].st === state ? calls[0].url : 'STATE LOST ' + calls[0].url) : null;
};
const P = 'https://portal.slacapital.ai';
check('a page', tidy(P + '/pipeline.html'), '/pipeline');
check('the home page becomes /', tidy(P + '/index.html'), '/');
check('an apply link keeps its loan officer', tidy(P + '/apply.html?lo=jeremy%40slacapital.com'), '/apply?lo=jeremy%40slacapital.com');
check('a signing link keeps its token', tidy(P + '/esign-sign.html?t=abc123'), '/esign-sign?t=abc123');
check('a sign-in landing keeps the token in its HASH', tidy(P + '/index.html#access_token=xyz&type=recovery'), '/#access_token=xyz&type=recovery');
check('query AND hash together', tidy(P + '/loan-details.html?loanId=l_1&owner=a%40b.com#servicing'), '/loan-details?loanId=l_1&owner=a%40b.com#servicing');
check('history.state is carried over, not reset', /^\//.test(tidy(P + '/esign.html#edit=esd_1')), true);
check('case does not matter', tidy(P + '/Pipeline.HTML'), '/Pipeline');
check('already clean: nothing is touched', [tidy(P + '/pipeline'), tidy(P + '/'), tidy(P + '/loan-details/l_123?owner=x')], [null, null, null]);
check('".html" in the middle of a path or a query is not a page name', [tidy(P + '/a.html/b'), tidy(P + '/x?next=/y.html')], [null, null]);
check('a file opened from disk is left alone', tidy('file:///C:/deploy/pipeline.html'), null);
let threw = false; try { tidy(P + '/pipeline.html', { noHistory: true }); } catch (e) { threw = true; }
assert('a browser with no history API is not broken by it', !threw);

// ── 3. a clean URL must reload to the SAME page ─────────────────────────────
console.log('\nA clean URL reloads to the same page');
const toml = read('netlify.toml');
const rules = [...toml.matchAll(/\[\[redirects\]\]\s*\n\s*from = "([^"]+)"\s*\n\s*to = "([^"]+)"/g)].map((m) => ({ from: m[1], to: m[2] }));
assert('the redirect table was read', rules.length > 50, 'found ' + rules.length);
const misroutes = [];
pages.forEach((f) => {
  const name = f.slice(0, -5);
  rules.filter((r) => r.from === '/' + name || r.from === '/' + name + '/').forEach((r) => {
    const target = r.to.split('?')[0];
    if (target !== '/' + f && target !== '/' + name) misroutes.push(r.from + ' -> ' + r.to);
  });
  const dir = new URL(name + '/', DEPLOY);
  if (existsSync(dir) && statSync(dir).isDirectory()) misroutes.push('folder shadows ' + f);
});
check('no page name is also a route to somewhere else, or a folder', misroutes, []);

// ── 4. the nav ──────────────────────────────────────────────────────────────
console.log('\nThe nav still knows where it is, and links clean');
const NAV = read('sla-nav.js');
const lift = (re) => { const m = NAV.match(re); if (!m) throw new Error('nav marker missing: ' + re); return m[0]; };
const navCtx = { window: { location: { pathname: '/' } }, String };
vm.createContext(navCtx);
vm.runInContext(lift(/function currentFile\(\) \{[\s\S]*?\n  \}/) + '\n' + lift(/function cleanHref\(h\) \{[\s\S]*?\n  \}/), navCtx);
const at = (path) => { navCtx.window.location.pathname = path; return vm.runInContext('currentFile()', navCtx); };
check('the clean bar and the old bar are the same page to the nav', [at('/pipeline'), at('/pipeline.html')], ['/pipeline.html', '/pipeline.html']);
check('home, and the loan short-URL, as before', [at('/'), at('/loan-details/l_abc')], ['/index.html', '/loan-details.html']);
const hrefs = [...new Set([...NAV.matchAll(/href: '([^']+)'/g)].map((m) => m[1]))];
assert('the menu was read', hrefs.length >= 20, 'found ' + hrefs.length);
const clean = (h) => vm.runInContext('cleanHref(' + JSON.stringify(h) + ')', navCtx);
check('every nav link is written into the page without .html', hrefs.filter((h) => /\.html/.test(clean(h))), []);
// The point of folding: landing on a nav link's CLEAN url must still highlight it.
check('every nav link still highlights when you land on its clean URL',
  hrefs.filter((h) => /^\/[a-z0-9_-]+\.html$/i.test(h)).filter((h) => at(clean(h)) !== h.toLowerCase()), []);
check('query and hash survive', [clean('/pipeline.html?focusLoan=l_1'), clean('/armory.html#news'), clean('/index.html')], ['/pipeline?focusLoan=l_1', '/armory#news', '/']);
assert('no link is still looked up by a .html href', !/\[href="\/[a-z-]+\.html"\]/.test(NAV));
assert('Home goes to /', /<a href="\/" class="nav-tools-btn">Home<\/a>/.test(NAV));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
