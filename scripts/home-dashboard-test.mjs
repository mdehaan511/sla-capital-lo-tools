#!/usr/bin/env node
/**
 * scripts/home-dashboard-test.mjs — Deploy 237.272 (Mike, MY DESK step 3)
 *
 * "I want to make it more of a dashboard that shows the Processing Pipeline and upcoming
 * things more than the wider company stuff like we have now. For Perfomance make a skinny box
 * that shows Active Pipeline Volume both dollar amount and loans, Closed YTD both dollar and
 * number of loans ... Below that have the upcoming closings tab that shows volume and type but
 * make it clickable so that it can drop down and show all of the loans scheduled each week
 * just like in the main dashboard page. Too the right I want a calendar ..."
 *
 * The page's own functions are lifted out of index.html and RUN on a fixture feed.
 * Run: node scripts/home-dashboard-test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const H = readFileSync(new URL('../deploy/index.html', import.meta.url), 'utf8');
const lift = (name) => {
  const start = H.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = H.indexOf('{', start);
  for (; i < H.length; i++) { if (H[i] === '{') depth++; else if (H[i] === '}' && --depth === 0) { i++; break; } }
  return H.slice(start, i);
};
const FNS = ['homePpCol', 'homeType', 'renderDashPerf', 'homeWeeks', 'renderDashUpcoming', 'toggleUpWeek', 'mountHomeCalendar',
  'dashIsWon', 'dashIsLiquidated', 'dashIsClosed', 'dashAmount', 'dashRawCloseDate', 'dashParseDate', 'dashCloseDate', 'dashInferLoanType', 'fmtMoneyShort', 'fmtDateShort', 'escH'];
function page(loans, extra) {
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '' }) };
  // eslint-disable-next-line no-new-func
  const api = new Function('document', 'window', 'SLA', 'SLA_CAL', 'loans', `
    var _dashLoans = loans;
    ${H.match(/var HOME_PP_ACTIVE = \{[^}]*\};/)[0]}
    var _upOpen = {};
    ${FNS.map(lift).join('\n')}
    return { homePpCol: homePpCol, renderDashPerf: renderDashPerf, renderDashUpcoming: renderDashUpcoming, toggleUpWeek: toggleUpWeek, mountHomeCalendar: mountHomeCalendar, homeWeeks: homeWeeks };
  `)(document, (extra && extra.window) || {}, (extra && extra.SLA) || {}, (extra && extra.SLA_CAL) || undefined, loans);
  return { api, els };
}
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
const Y = new Date().getFullYear();
const L = (id, status, stage, amt, date, x) => Object.assign({ Name: id + ' Oak St, Macon, GA', Status: status, Substatus: 'RTL', Loan_Amount: amt, Origination: date, _slaStatusRaw: status, _stageRaw: stage, _dispositionRaw: '', _slaLoanId: 'l_' + id, _ownerKey: 'carl.davis@slacapital.com', _borrower: 'Ann Lee' }, x || {});
const loans = [
  L('intake', 'approved', 'new_loan', 100000, inDays(10)),
  L('proc', 'active', 'processing', 250000, inDays(3), { Substatus: 'DSCR' }),
  L('ctc', 'approved', 'pp_approved', 400000, inDays(4)),
  L('hold', 'on_hold', 'processing', 999000, inDays(3)),
  L('lead', 'active', '', 777000, inDays(3)),
  L('past', 'active', 'processing', 50000, inDays(-20)),
  L('closedA', 'closed', 'pp_closed', 300000, Y + '-02-10'),
  L('soldB', 'sold', 'pp_closed', 200000, Y + '-05-01', { _dispositionRaw: 'sold' }),
  L('lastyr', 'closed', 'pp_closed', 5000000, (Y - 1) + '-12-20'),
  L('dead', 'cancelled', 'processing', 888000, inDays(5)),
];

console.log('\nWhat counts as the active pipeline (the main dashboard\'s rule)');
{
  const { api } = page(loans);
  check('Intake / Processing / Cleared to Close are on it; on hold, a lead, closed, sold and cancelled are not',
    ['intake', 'proc', 'ctc', 'hold', 'lead', 'closedA', 'soldB', 'dead'].map((id) => api.homePpCol(loans.find((l) => l._slaLoanId === 'l_' + id))),
    ['new_loan', 'processing', 'pp_approved', null, null, 'pp_closed', null, null]);
  assert('the same rule sla-dashboard.html uses for its Upcoming Closings', /function ppColumnFor\(loan\)/.test(readFileSync(new URL('../deploy/sla-dashboard.html', import.meta.url), 'utf8')) && /stage === 'processing' \|\| stage === 'underwriting' \|\| stage === 'pp_approved' \|\| stage === 'pp_closed' \|\| stage === 'new_loan'/.test(lift('homePpCol')));
}

console.log('\nPerformance: a skinny box, Active Pipeline Volume and Closed YTD, $ and # side by side');
{
  const { api, els } = page(loans);
  api.renderDashPerf();
  const h = els.dashPerfBody.innerHTML;
  const tiles = [...h.matchAll(/<div class="n">([^<]*)<\/div><div class="l">([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]);
  const heads = [...h.matchAll(/<div class="perf2-h">([^<]*)<\/div>/g)].map((m) => m[1]);
  check('two stacked sections, $ beside #', heads, ['Active Pipeline Volume', 'Closed YTD']);
  check('Active Pipeline Volume: $800K across 4 loans (Intake, Processing incl. one with a past date, Cleared to Close)', tiles.slice(0, 2), [['$800K', 'Volume'], ['4', 'Loans']]);
  check('Closed YTD: this year\'s closings only, sold ones included ($500K, 2 loans)', tiles.slice(2, 4), [['$500K', 'Volume'], ['2', 'Loans']]);
  assert('...in that order, stacked', h.indexOf('Active Pipeline Volume') < h.indexOf('Closed YTD'));
}

console.log('\nUpcoming Closings: by week, volume and type, click to drop down the loans');
{
  const { api, els } = page(loans);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weeks = api.homeWeeks(loans, today.getTime());
  const ids = weeks.map((w) => w.loans.map((x) => x.id).sort());
  check('only active-board loans closing from today on (no hold, lead, past, cancelled)', ids.flat().sort(), ['l_ctc', 'l_intake', 'l_proc']);
  assert('weeks run Monday to Friday, in order', weeks.every((w) => new Date(w.mondayMs).getDay() === 1) && weeks.every((w, i) => !i || w.mondayMs > weeks[i - 1].mondayMs));
  api.renderDashUpcoming();
  let h = els.dashUpcomingBody.innerHTML;
  assert('each week shows its count, volume and a DSCR / RTL split', /class="up2-tot">\d+ · \$\d+K</.test(h) && /up2-pill dscr">DSCR 1 · \$250K/.test(h) && /up2-pill rtl">RTL/.test(h));
  assert('collapsed to begin with: no loans listed', !/up2-loans/.test(h));
  const firstMs = weeks[0].mondayMs;
  assert('a week row is clickable', new RegExp('onclick="toggleUpWeek\\(' + firstMs + '\\)"').test(h));
  api.toggleUpWeek(firstMs);
  h = els.dashUpcomingBody.innerHTML;
  assert('clicking it drops down that week\'s loans, each a link to Loan Details, with date, type and amount', /class="up2-loans"/.test(h) && /<a href="\/loan-details\/l_[a-z]+\?owner=carl\.davis%40slacapital\.com"/.test(h) && /class="t">(RTL|DSCR) · Ann Lee</.test(h) && /class="a">\$\d+K</.test(h));
  api.toggleUpWeek(firstMs);
  assert('clicking again closes it', !/up2-loans/.test(els.dashUpcomingBody.innerHTML));
  const hostile = page([L('x', 'active', 'processing', 1, inDays(2), { Name: '<img src=x onerror=alert(1)>' })]);
  hostile.api.toggleUpWeek(hostile.api.homeWeeks(hostile.api && [L('x', 'active', 'processing', 1, inDays(2), { Name: '<img src=x onerror=alert(1)>' })], today.getTime())[0].mondayMs);
  assert('a hostile address is escaped', !/<img src=x/.test(hostile.els.dashUpcomingBody.innerHTML) && /&lt;img/.test(hostile.els.dashUpcomingBody.innerHTML));
}

console.log('\nThe calendar to the right');
{
  const mounts = [];
  const CAL = { mount: (el, o) => mounts.push([el.id, o]) };
  const role = (roles) => ({ isAdmin: (u) => roles.indexOf('admin') >= 0, isProcessor: (u) => roles.indexOf('admin') >= 0 || roles.indexOf('processor') >= 0 });
  for (const [who, roles] of [['mike@slacapital.com', ['admin']], ['jessy@slacapital.com', ['processor']], ['carl.davis@slacapital.com', []]]) {
    page([], { window: { SLA_CAL: CAL, SLA: role(roles) }, SLA: role(roles), SLA_CAL: CAL }).api.mountHomeCalendar({ email: who });
  }
  check('admin: Everyone by default; processor: their own, Everyone offered; LO: their own only',
    mounts.map(([id, o]) => [id, o.surface, o.me, o.canSeeAll, o.defaultAll]),
    [['homeCal', 'home', 'mike@slacapital.com', true, true], ['homeCal', 'home', 'jessy@slacapital.com', true, false], ['homeCal', 'home', 'carl.davis@slacapital.com', false, false]]);
  assert('mounted when the app shows, right after the dashboard loads', /loadDashboard\(\);\s*\n\s*mountHomeCalendar\(user\);/.test(H));
  assert('the page loads the calendar (pinned)', /<script src="\/sla-calendar\.js\?v=[0-9A-Za-z]+"><\/script>/.test(H));
}

console.log('\nThe layout');
{
  const m = H.match(/<div class="home-dash2">([\s\S]*?)<div class="home-dash2-right"><div id="homeCal"><\/div><\/div>\s*<\/div>/);
  assert('a skinny left column (Performance, then Upcoming Closings) and the calendar to its right', !!m && m[1].indexOf('id="dashPerfCard"') < m[1].indexOf('id="dashUpcomingCard"') && /grid-template-columns: minmax\(250px, 320px\) minmax\(0, 1fr\)/.test(H));
  assert('Loans by State is gone ("the wider company stuff"), nothing still points at it', !/Loans by State<\/h3>/.test(H) && !/dashStateBody|renderDashState|home-dash-row/.test(H));
  assert('the Loans table is still below', /<h3>Loans<\/h3>/.test(H) && /id="dashLoansBody"/.test(H) && /renderDashLoans\(\);/.test(H));
  assert('no arrow functions on the page (older browsers)', !/=>/.test(H.replace(/<!--[\s\S]*?-->/g, '')));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
