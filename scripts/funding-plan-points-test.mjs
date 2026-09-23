#!/usr/bin/env node
/**
 * scripts/funding-plan-points-test.mjs — Deploy 237.250
 *
 * Mike: "Can we move the Broker Points from the Broker Box on contacts to the
 * Funding Plan box in Closing. Exact same functionality just to a different
 * location. Then also add the total points which shows the sum of the SLA
 * origination and the Broker Points."
 *
 * The total is the part that can be quietly wrong. On a DSCR the sizer saves
 * loan.points as the TOTAL the borrower pays — origination plus the buy-down that
 * goes to the end investor — so "SLA origination" is not loan.points, and the rule
 * for when to subtract is the one 237.214 / 237.215 already worked out the hard
 * way. This checks the page uses that rule rather than a second copy of it.
 *
 * Run: node scripts/funding-plan-points-test.mjs
 */
import { readFileSync } from 'node:fs';
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
const D = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');

// The real helper, run with the real SLA_COMP beside it.
const LD = D('loan-details.js');
const a = LD.indexOf('function _fpPointsParts(l) {');
const b = LD.indexOf('function _acHtml(l, onDocs) {', a);
assert('the helper is where the gate expects it', a > 0 && b > a);
const ctx = { console, String, Number, Math, parseFloat, isFinite, JSON, Object, Array, Date, window: {} };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(D('lo-comp.js'), ctx, { filename: 'lo-comp.js' });
vm.runInContext(LD.slice(a, b), ctx, { filename: 'loan-details.js#_fpPointsParts' });
const parts = (loan) => vm.runInContext('_fpPointsParts(' + JSON.stringify(loan) + ')', ctx);

console.log('\nthe points on the Funding Plan box\n');
{
  // An RTL: no buy-down exists on the product, so the points pass through.
  const rtl = parts({ toolType: 'rtl', points: 2, brokerFee: 1 });
  check('RTL: SLA origination, broker, and the sum of the two',
    [rtl.sla, rtl.broker, rtl.total, rtl.totalText], [2, 1, 3, '3.00 pts']);
  check('the hint spells out the arithmetic', rtl.hint, '2.00 SLA origination + 1.00 broker');

  // A DSCR whose points are the sizer TOTAL (1.00 origination + 1.00 buy-down).
  const dscr = parts({ toolType: 'dscr', points: 2, buydown: 1, brokerFee: 0.5, formData: { _points: 2 } });
  check('DSCR: the buy-down is NOT counted as SLA origination',
    [dscr.sla, dscr.broker, dscr.total], [1, 0.5, 1.5]);
  assert('…and the page says so rather than leaving a gap to wonder about',
    /1\.00 buy-down pts excluded \(paid to the investor\)/.test(dscr.hint), dscr.hint);

  // The 237.215 trap: a Baseline-enriched loan whose top-level points were
  // rewritten to origination ONLY while the buy-down field stayed set.
  const enriched = parts({ toolType: 'dscr', points: 1, buydown: 1, brokerFee: 1, formData: { _points: 2 } });
  check('an already-net points field is not netted a second time',
    [enriched.sla, enriched.total, enriched.excluded], [1, 2, 0]);
  assert('…and no exclusion is claimed that was not made', enriched.hint.indexOf('excluded') < 0, enriched.hint);
}

console.log('\nwhat it says when there is nothing to say');
{
  check('no broker at all', parts({ toolType: 'rtl', points: 2 }).brokerText, 'None — no broker on this loan');
  check('a broker on the loan but no fee set yet — the same words the broker box used',
    parts({ toolType: 'rtl', points: 2, brokerName: 'Jeremy' }).brokerText, 'Not set — open sizer to add');
  check('a fee that is set reads as points', parts({ points: 2, brokerFee: 1.25 }).brokerText, '1.25 pts');
  check('an unpriced loan does not read as 0.00 pts', parts({}).totalText, 'Not priced yet');
  assert('a malformed loan does not throw', !!parts({ points: 'abc', brokerFee: null }) && parts({}).total === 0);
}

console.log('\nwhere it lives now');
{
  assert('the broker box on Contacts no longer carries the points',
    !/Broker Fee <span[^>]*>· Set on sizer/.test(LD), 'the old read-only Broker Fee field is still in the broker box');
  assert('and its leftover variable went with it', !/var brokerFeePts =/.test(LD));
  const fp = LD.slice(LD.indexOf("html += '<div class=\"section\" id=\"fundingPlanSection\">"), LD.indexOf('_acHtml(l, _fpOnDocs)'));
  assert('Funding Plan carries Broker Points', /Broker Points/.test(fp) && /_fpPts\.brokerText/.test(fp), fp.slice(0, 200));
  assert('…and Total Points, labelled as the sum', /Total Points/.test(fp) && /SLA origination \+ broker/.test(fp));
  assert('both stay read-only — pricing is sizer-owned', (fp.match(/readonly/g) || []).length >= 2);
  assert('neither is wired into saveFundingPlan',
    !/fp-brokerPoints|fp-totalPoints/.test(LD), 'a read-only field must not be collected by the save');

  const H = D('loan-details.html');
  assert('lo-comp.js is served to the page', /<script src="\/lo-comp\.js\?v=\d+">/.test(H));
  assert('…before loan-details.js, which calls it', H.indexOf('/lo-comp.js') < H.indexOf('/loan-details.js'));
  const pin = (n) => (H.match(new RegExp(n.replace('.', '\\.') + '\\?v=(\\d+)')) || [])[1];
  check('the two move together, so a stale cache cannot give the page a copy without SLA_COMP',
    pin('lo-comp.js'), pin('loan-details.js'));
  // The page must not fall over if it IS served a stale pair.
  // Delete it INSIDE the vm: `window` there is the context's global proxy, so a
  // host-side delete on the sandbox object would not be what the helper reads.
  vm.runInContext('delete window.SLA_COMP; delete this.SLA_COMP;', ctx);
  const bare = parts({ toolType: 'dscr', points: 2, buydown: 1, brokerFee: 1 });
  check('without SLA_COMP it uses the raw points rather than breaking', [bare.sla, bare.total], [2, 3]);
  assert('…and claims no exclusion it cannot compute', bare.hint.indexOf('excluded') < 0);
}

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks pass');
process.exit(fail ? 1 : 0);
