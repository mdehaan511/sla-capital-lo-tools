#!/usr/bin/env node
/**
 * scripts/town-crier-week-test.mjs — Deploy 237.279 (Mike)
 *
 * "I want to modify the town Crier to show: Closings from Last Week / Which LO pushed the most
 * volume to Approved (to the processing Pipeline) and how much / Which Processor had the most
 * closings and how many / How many loans we traded/sold and shout out Keith for that."
 *
 * Runs lastWeekRange + weekStats on a fixture shaped like the real week of Sep 21 (Sara
 * $528,750 over Carl $503,750; Beth 4 closings; 5 loans sold on the 25th), then builds a whole
 * issue through the stubbed-import harness: the four sections first, in Mike's order, and only
 * the closings on Slack (feedback: Slack = people milestones, no standings).
 *
 * Run: node scripts/town-crier-week-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}
let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const TE = await import('../deploy/netlify/functions/_shared/team-events.mjs');
const CB = await import('../deploy/netlify/functions/_shared/closing-bell.mjs');

async function loadModule(file, stubs) {
  const src = readFileSync(new URL(file, FN), 'utf8');
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, isFinite, URL, Intl });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const ex = {}; wanted.forEach((n) => { ex[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(ex), function () { Object.keys(ex).forEach((k) => this.setExport(k, ex[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace;
}

const profiles = [
  { email: 'sara.s@slacapital.com', name: 'Sara Smith' }, { email: 'carl.davis@slacapital.com', name: 'Carl Davis' },
  { email: 'keith@slacapital.com', name: 'Keith Lawson' }, { email: 'beth@slacapital.com', name: 'Beth' },
];
const P = (name, role, email) => ({ name, role, email: email || name.toLowerCase() + '@slacapital.com' });
const bell = (d, amt, procs, x) => Object.assign({ closedAt: d + 'T19:00:00Z', amount: amt, loName: 'Carl Davis', program: 'RTL', address: amt + ' Oak St, Macon, GA', processors: procs }, x || {});
const bells = [
  bell('2026-09-22', 100000, [P('Beth', 'processor'), P('Keith', 'closer')]),
  bell('2026-09-23', 200000, [P('Beth', 'processor')]),
  bell('2026-09-24', 300000, [P('Beth', 'processor'), P('Jessy Rimando', 'processor', 'jessy@slacapital.com')]),
  bell('2026-09-26', 400000, [P('Beth', 'processor')]),
  bell('2026-09-25', 150000, [P('Jessy Rimando', 'processor', 'jessy@slacapital.com'), P('Dee', 'underwriter')]),
  bell('2026-09-20', 999000, [P('Raissa', 'processor')]),                        // Sunday BEFORE the week
  bell('2026-09-28', 888000, [P('Raissa', 'processor')], { closedAt: '2026-09-28T16:00:00Z' }), // this Monday
];
const L = (owner, amount, welcomeAt, soldDate) => ({ owner, amount: String(amount), welcomeAt, soldDate, address: 'x' });
const loans = [
  L('sara.s@slacapital.com', 300000, '2026-09-22T17:00:00Z'), L('sara.s@slacapital.com', 228750, '2026-09-26T23:30:00Z'),
  L('carl.davis@slacapital.com', 503750, '2026-09-24T16:00:00Z'),
  L('chance@slacapital.com', 900000, '2026-09-21T06:00:00Z'),   // 11pm Sunday Pacific → the week BEFORE
  L('jeremy@slacapital.com', 254000, '2026-09-28T02:00:00Z'),   // Sunday 7pm Pacific → inside
  L('x@slacapital.com', 111000, null, '2026-09-25'), L('x@slacapital.com', 222000, null, '2026-09-25'), L('x@slacapital.com', 50000, null, '2026-09-27'),
  L('x@slacapital.com', 1, null, '2026-09-28'), L('x@slacapital.com', 1, null, '2026-12-08'),
];

console.log('\nThe week: the Monday to Sunday before the Monday it goes out, in Pacific days');
const ns = await loadModule('_shared/town-crier.mjs', { './team-events.mjs': TE, './closing-bell.mjs': CB });
const wk = ns.lastWeekRange('2026-09-28');
check('sent Monday Sep 28: Sep 21 up to (not including) Sep 28', [wk.from, wk.to], ['2026-09-21', '2026-09-28']);
check('...a resend later that week is still the same week', [ns.lastWeekRange('2026-10-02').from, ns.lastWeekRange('2026-10-04').from], ['2026-09-21', '2026-09-21']);
assert('...labelled Monday to Sunday', /21/.test(wk.label) && /27/.test(wk.label), wk.label);

console.log('\nThe four numbers');
const W = ns.weekStats({ bells, loans, profiles, week: wk });
check('closings from last week: the five inside, not the Sunday before or this Monday', [W.closings.length, W.closingsTotal], [5, 1150000]);
check('most volume to Approved: Sara, $528,750 over 2 loans (Carl\'s one loan is $503,750)', [W.approved.top.name, W.approved.top.volume, W.approved.top.count], ['Sara Smith', 528750, 2]);
check('...the team total counts a Sunday-evening push (Pacific), not the one the Sunday before', [W.approved.volume, W.approved.count], [528750 + 503750 + 254000, 4]);
check('most closings by a processor: Beth, 4 (a closer and an underwriter are not in this race)', W.processor, { names: ['Beth'], count: 4 });
check('traded / sold: 3 last week (not this Monday, not a mistyped December date), with Keith named', [W.sold.count, W.sold.volume, W.sold.keith], [3, 383000, 'Keith Lawson']);
const tie = ns.weekStats({ bells: [bell('2026-09-22', 1, [P('Beth', 'processor')]), bell('2026-09-23', 1, [P('Jessy', 'processor')])], loans: [], profiles, week: wk });
check('a tie names everyone tied', tie.processor, { names: ['Beth', 'Jessy'], count: 1 });
check('a quiet week: no leader, no processor, nothing sold, Keith still resolvable', (() => { const q = ns.weekStats({ bells: [], loans: [], profiles: [], week: wk }); return [q.approved.top, q.processor, q.sold.count, q.sold.keith]; })(), [null, null, 0, 'Keith']);

console.log('\nThe issue: last week first, standings off Slack');
{
  const rows = loans.map((l) => ({ owner_email: l.owner, address: l.address, loan_amt: l.amount, welcome_at: l.welcomeAt, sold_date: l.soldDate }));
  const stubs = {
    '@netlify/blobs': { getStore: () => ({ get: async () => null, list: async () => ({ blobs: [] }), setJSON: async () => {} }) },
    './slack.mjs': { postSlack: async () => {} },
    './armory.mjs': { listAllMonths: async () => ({}), legendsFrom: () => [], getEvents: async () => [], monthKey: () => '2026-09', monthLabel: () => 'September 2026', daysLeftInMonth: () => 2, questForMonth: () => ({ id: 'q', name: 'Coin Catch', href: '/coin-catch.html' }), touchPulse: async () => {} },
    './closing-bell.mjs': { listBells: async () => bells, fmtMoney: CB.fmtMoney },
    './team-events.mjs': Object.assign({}, TE, { loadTeamProfiles: async () => profiles, upcomingCelebrations: () => [] }),
    './achievements.mjs': { getAchievementsIndex: async () => null, DEEDS: [], RANKS: [] },
    './corkboard.mjs': { boardSince: async () => [] },
    './supabase-db.mjs': { db: { select: async (t, o) => (o.offset ? [] : rows) } },
  };
  const M = await loadModule('_shared/town-crier.mjs', stubs);
  const issue = await M.buildTownCrier(new Date('2026-09-28T15:00:00Z'));
  const heads = [...issue.html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  check('the first four sections are Mike\'s four, in his order, then the rest', heads.slice(0, 5).map((h) => h.replace(/ \(.*\)$/, '')), ['🔔 Closings from Last Week', '📈 Most Volume to Approved', '⚙ Most Closings by a Processor', '🤝 Traded &amp; Sold', '⚔ This month&#39;s quest: Coin Catch'.replace('&#39;', '\'')]);
  assert('the email says each number', /<b>Sara Smith<\/b> pushed <b>\$528,750<\/b> into the Processing Pipeline \(2 loans\)/.test(issue.html) && /<b>Beth<\/b> — 4 closings\./.test(issue.html) && /We traded <b>3 loans<\/b> \(\$383,000\) last week\. Shout-out to <b>Keith Lawson<\/b>/.test(issue.html) && /<b>5 loans · \$1,150,000<\/b>/.test(issue.html), issue.html.slice(issue.html.indexOf('Most Volume'), issue.html.indexOf('Most Volume') + 400));
  assert('Slack gets the closings (a people milestone)', /\*🔔 Closings from Last Week/.test(issue.slack) && /closed \$400,000 RTL at 400000 Oak St/.test(issue.slack));
  assert('...but not the standings: no volume leader, processor count or trade tally', !/pushed \$528,750|Beth — 4|We traded|Shout-out/.test(issue.slack), issue.slack);
  assert('the plain-text email has them too', /Sara Smith pushed \$528,750/.test(issue.text) && /Shout-out to Keith Lawson/.test(issue.text));
  check('the archive keeps the numbers', [issue.stats.approvedTop.name, issue.stats.processorTop.count, issue.stats.sold, issue.stats.closed], ['Sara Smith', 4, 3, 5]);
  assert('the old 7-day Closing Bell section is gone (it IS the first section now)', !/last 7 days/.test(issue.html.split('Cork Board')[0]));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
