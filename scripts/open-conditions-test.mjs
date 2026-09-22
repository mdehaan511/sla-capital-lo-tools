#!/usr/bin/env node
/**
 * scripts/open-conditions-test.mjs — Deploy 237.244 / 237.248
 *
 * Mike: "Let me add a page that shows all open conditions for all loans. Make it
 * look like the closed loans page that has the address that has a drop down menu
 * that can then show all the conditions." Then: "Make it a tab at the top of the
 * processing pipeline by Team Overview."
 *
 * This is a worklist, so the ways it can quietly lie are the ways that matter:
 * showing a condition somebody already cleared, hiding one that is outstanding,
 * or — on a page a loan officer can also open — listing another LO's loans.
 *
 * Run: node scripts/open-conditions-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { openConditionsOf, openTraysOf } from '../deploy/netlify/functions/conditions-open.mjs';

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
const S = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');

const cond = (id, title, status, priorTo, createdAt) => ({ id, title, status, priorTo, createdAt, createdBy: 'raissa@slacapital.com' });

console.log('what counts as open\n');
{
  const review = {
    id: 'r1', address: '5909 Cates Ave', borrowerName: 'Donato Callahan',
    docs: {
      title_commitment: { label: 'Title Commitment', conditions: [
        cond('c1', 'Remove exception 12', 'outstanding', 'docs', '2026-09-10T00:00:00Z'),
        cond('c2', 'Mortgagee clause corrected', 'cleared', 'docs', '2026-09-09T00:00:00Z'),
      ] },
      evidence_of_insurance: { label: 'Evidence of Insurance', conditions: [
        cond('c3', 'Raise dwelling coverage to the loan amount', 'received', 'funding', '2026-09-14T00:00:00Z'),
      ] },
      // a hidden tray is out of the review, so its items are nobody's work
      condo_insurance: { label: 'Condo Insurance', hidden: true, conditions: [
        cond('c4', 'HO-6 needed', 'outstanding', 'docs', '2026-09-01T00:00:00Z'),
      ] },
      psa: { label: 'PSA', conditions: [] },
      appraisal: { label: 'Appraisal' },
    },
  };
  const open = openConditionsOf(review);
  check('cleared items are gone; outstanding AND received are open',
    open.map((c) => [c.id, c.status]), [['c1', 'outstanding'], ['c3', 'received']]);
  check('a hidden tray contributes nothing', open.some((c) => c.id === 'c4'), false);
  check('each one says which document it is on', open.map((c) => c.docLabel), ['Title Commitment', 'Evidence of Insurance']);
  check('prior to DOCS sorts above prior to funding — that is the order they get worked',
    open.map((c) => c.priorTo), ['docs', 'funding']);
  check('a tray with no conditions, and one with no conditions key at all, are both fine',
    openConditionsOf({ docs: { a: { conditions: [] }, b: {} } }), []);
  assert('an empty or malformed review does not throw',
    openConditionsOf(null).length === 0 && openConditionsOf({}).length === 0 && openConditionsOf({ docs: { x: { conditions: 'nope' } } }).length === 0);
  const aged = openConditionsOf({ docs: { t: { conditions: [cond('c', 'x', 'outstanding', 'docs', new Date(Date.now() - 3 * 86400000).toISOString())] } } });
  check('age is counted from when it was added', aged[0].ageDays, 3);
  check('a condition with no date has no age rather than a wrong one',
    openConditionsOf({ docs: { t: { conditions: [cond('c', 'x', 'outstanding', 'docs', '')] } } })[0].ageDays, null);
}

console.log('\ngrouped by document tray, with its notes (237.248)');
{
  const review = {
    docs: {
      title_commitment: {
        label: 'Title Commitment',
        conditions: [
          cond('c1', 'Remove exception 12', 'outstanding', 'docs', '2026-09-10T00:00:00Z'),
          cond('c2', 'Mortgagee clause', 'outstanding', 'funding', '2026-09-12T00:00:00Z'),
        ],
        noteLog: [
          { id: 'n1', ts: '2026-09-18T15:00:00Z', author: 'Raissa Dalimocon', authorEmail: 'raissa@slacapital.com', text: 'emailed the borrower 9/18' },
          { id: 'n2', ts: '2026-09-19T15:00:00Z', author: 'Dee', authorEmail: 'dee@slacapital.com', text: '' },
        ],
      },
      // a tray that only ever had the old free-text field
      sow: { label: 'Statement of Work (SOW)', processorNotes: 'square footage mismatch, asked Dee', aiReviewedAt: '2026-09-20T00:00:00Z',
        conditions: [cond('c3', 'SOW total does not match', 'received', 'docs', '2026-09-20T00:00:00Z')] },
      // conditions all cleared → the tray is not on the list at all
      psa: { label: 'PSA', noteLog: [{ id: 'x', ts: '', author: 'A', text: 'note' }],
        conditions: [cond('c4', 'done', 'cleared', 'docs', '2026-09-01T00:00:00Z')] },
    },
  };
  const trays = openTraysOf(review);
  check('one entry per tray, and only trays with something open',
    trays.map((t) => [t.slug, t.open]), [['title_commitment', 2], ['sow', 1]]);
  check('a tray blocking the docs outranks one that does not, then the oldest',
    trays.map((t) => t.label), ['Title Commitment', 'Statement of Work (SOW)']);
  check('the tray counts what is prior to docs and what is prior to funding',
    trays.map((t) => [t.priorToDocs, t.priorToFunding]), [[1, 1], [1, 0]]);
  check('its notes come with it, newest last, empty ones dropped',
    trays[0].notes.map((n) => [n.author, n.text]), [['Raissa Dalimocon', 'emailed the borrower 9/18']]);
  check('a tray that only has the old free-text note still shows it, labelled as earlier',
    trays[1].notes.map((n) => [n.author, n.text]), [['Earlier note', 'square footage mismatch, asked Dee']]);
  check('a tray whose conditions are all cleared brings no notes either',
    trays.some((t) => t.slug === 'psa'), false);
  check('the flat list is still the same items, for the counts',
    openConditionsOf(review).map((c) => c.id), ['c1', 'c2', 'c3']);
  assert('a malformed noteLog does not throw',
    openTraysOf({ docs: { t: { conditions: [cond('c', 'x', 'outstanding', 'docs', '')], noteLog: [null, 'nope', {}] } } })[0].notes.length === 0);
}

console.log('\nwho can see what');
{
  const F = S('netlify/functions/conditions-open.mjs');
  assert('the caller is authenticated first', /const user = await requireAuth\(context, req\);\s*\n\s*if \(!user\) return json\(401/.test(F));
  assert('a loan officer is scoped by the REVIEW\'s own ownerKey, never by anything they sent',
    /if \(!staff && \(\(r\.source && r\.source\.ownerKey\) \|\| ''\) !== mine\) continue;/.test(F));
  assert('nothing on the query string can widen the scope', !/searchParams/.test(F));
  assert('the store is read in parallel, not one await at a time',
    /await Promise\.all\(blobs\.map\(/.test(F));
  const T = S('netlify.toml');
  assert('the endpoint is routed', /from = "\/api\/conditions-open"[\s\S]{0,120}to = "\/\.netlify\/functions\/conditions-open"/.test(T));
}

console.log('\nthe tab');
{
  const P = S('processing-pipeline.html');
  assert('it sits beside Team Overview', /data-view="overview"[\s\S]{0,400}data-view="conditions"/.test(P));
  assert('the view switch accepts it', /view === 'conditions'/.test(P) && /if \(_view === 'conditions'\) \{ renderConditions\(\); return; \}/.test(P));
  assert('the count rides on the tab', /id="ppCondCount"/.test(P) && /function updateCondBadge/.test(P));
  assert('the conditions are fetched once and re-used', /if \(_condData && !force\) return;/.test(P));
  assert('the fetch never blocks the board', /try \{ loadConditions\(false\); \} catch/.test(P));
  assert('SLA.api\'s parsed JSON is used directly (it is not a Response)', !/conditions-open'\)[\s\S]{0,80}\.json\(\)/.test(P));

  // Render it for real: the row, the drop-down, the escaping.
  const a = P.indexOf('var _condData = null;');
  const b = P.indexOf('// ── Deploy 236.562 — Team Overview');
  assert('the tab code is where the gate expects it', a > 0 && b > a);
  const el = { innerHTML: '', value: '', textContent: '', style: {} };
  const ctx = {
    console, String, Array, Object, Math, JSON, Date, isFinite, parseInt, parseFloat,
    escH: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escAttr: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    programBucket: () => 'rtl',
    document: { getElementById: (id) => (id === 'boardWrap' ? el : { value: '', textContent: '', style: {} }) },
    SLA: { api: () => ({ then: () => ({ catch: () => {} }) }) },
    _items: {}, _user: { email: 'me@slacapital.com' },
    _loFilterValue: '', _myLoansOnly: false, _programFilter: 'all', _view: 'conditions',
  };
  vm.createContext(ctx);
  vm.runInContext(P.slice(a, b), ctx);
  const data = {
    totals: { open: 3, loans: 2 },
    loans: [
      { reviewId: 'rev1', address: '5909 Cates Ave, St. Louis, MO', borrowerName: 'Donato Callahan', open: 2, oldestDays: 12, href: '/loan-details/l_1#documents', source: { loanId: 'l_1' },
        conditions: [
          { id: 'c1', title: 'Remove exception 12', slug: 'title_commitment', priorTo: 'docs', status: 'outstanding', docLabel: 'Title Commitment', ageDays: 12, createdBy: 'raissa@slacapital.com' },
          { id: 'c3', title: 'Raise dwelling coverage', slug: 'evidence_of_insurance', priorTo: 'funding', status: 'received', docLabel: 'Evidence of Insurance', ageDays: 8, createdBy: '' },
        ],
        trays: [
          { slug: 'title_commitment', label: 'Title Commitment', open: 1, priorToDocs: 1, priorToFunding: 0, oldestDays: 12,
            conditions: [{ id: 'c1', title: 'Remove exception 12', priorTo: 'docs', status: 'outstanding', docLabel: 'Title Commitment', ageDays: 12, createdBy: 'raissa@slacapital.com' }],
            notes: [
              { id: 'n1', ts: '2026-09-18T15:00:00Z', author: 'Raissa Dalimocon', text: 'emailed the borrower 9/18, title says Thursday' },
              { id: 'n2', ts: '', author: 'Earlier note', text: 'ordered 9/12' },
            ] },
          { slug: 'evidence_of_insurance', label: 'Evidence of Insurance', open: 1, priorToDocs: 0, priorToFunding: 1, oldestDays: 8,
            conditions: [{ id: 'c3', title: 'Raise dwelling coverage', priorTo: 'funding', status: 'received', docLabel: 'Evidence of Insurance', ageDays: 8, createdBy: '' }],
            notes: [] },
        ] },
      { reviewId: 'rev2', address: '<img src=x onerror=alert(1)>', borrowerName: 'X', open: 1, oldestDays: 0, href: '', source: { loanId: 'l_2' },
        conditions: [{ id: 'c9', title: '<b>hax</b>', slug: 'psa', priorTo: 'docs', status: 'outstanding', docLabel: 'PSA', ageDays: 0, createdBy: '' }],
        trays: [{ slug: 'psa', label: '<i>PSA</i>', open: 1, priorToDocs: 1, priorToFunding: 0, oldestDays: 0,
          conditions: [{ id: 'c9', title: '<b>hax</b>', priorTo: 'docs', status: 'outstanding', docLabel: 'PSA', ageDays: 0, createdBy: '' }],
          notes: [{ id: 'n9', ts: '', author: '<u>who</u>', text: '<script>alert(1)</script>' }] }] },
    ],
  };
  const render = (d) => { ctx._condData = d; ctx._condState = ''; vm.runInContext('renderConditions()', ctx); return el.innerHTML; };

  let h = render(data);
  assert('collapsed: one row per loan, addresses and counts, no condition text yet',
    /5909 Cates Ave/.test(h) && /2 open/.test(h) && !/Remove exception 12/.test(h), h.slice(0, 300));
  assert('the header counts the whole list', /<b>3<\/b> open conditions across <b>2<\/b> loans/.test(h), h.slice(0, 300));
  assert('it splits prior-to-docs from prior-to-funding', /2 prior to docs · 1 prior to funding/.test(h));
  assert('a hostile address is escaped', h.indexOf('<img src=x') < 0 && h.indexOf('&lt;img src=x') > 0);

  // Deploy 237.248 (Mike: "the same form of the Conditions tab in the loan, with
  // the Document Tray that you can click down and see the conditions and notes
  // inside"). Two levels: loan → tray → the items and the notes.
  vm.runInContext("toggleCondRow('rev1')", ctx);
  h = el.innerHTML;
  assert('opening a LOAN shows its document trays, not the condition text yet',
    /Title Commitment/.test(h) && /Evidence of Insurance/.test(h) && !/Remove exception 12/.test(h), h.slice(0, 900));
  assert('a tray says how many are open and how many notes it carries',
    /pc-tray[\s\S]{0,400}1 open[\s\S]{0,300}pc-badge note">2 notes/.test(h), h.slice(0, 1200));
  assert('the row offers the way through to the loan', /href="\/loan-details\/l_1#documents"/.test(h));
  assert('the OTHER loan stays collapsed', h.indexOf('&lt;b&gt;hax&lt;/b&gt;') < 0);

  vm.runInContext("toggleCondTray('rev1','title_commitment')", ctx);
  h = el.innerHTML;
  assert('opening the TRAY shows the condition inside it', /Remove exception 12/.test(h), h.slice(0, 1200));
  assert('…and the notes on that tray, with who wrote them',
    /Notes<\/div>[\s\S]{0,400}Raissa[\s\S]{0,400}emailed the borrower/.test(h), h.slice(0, 1600));
  assert('the OTHER tray on the same loan stays closed', h.indexOf('Raise dwelling coverage') < 0);
  vm.runInContext("toggleCondTray('rev1','evidence_of_insurance')", ctx);
  h = el.innerHTML;
  assert('a received item says it is waiting on sign-off, not that it is done', /received, awaiting sign-off/.test(h));
  assert('a tray with no notes simply has none', h.indexOf('pc-badge note">1 note') < 0 || !/Evidence of Insurance[\s\S]{0,200}pc-badge note/.test(h));
  vm.runInContext("toggleCondTray('rev1','title_commitment')", ctx);
  assert('clicking a tray again closes it', el.innerHTML.indexOf('Remove exception 12') < 0);
  vm.runInContext("toggleCondRow('rev1')", ctx);
  assert('clicking the loan again closes the whole thing', el.innerHTML.indexOf('Title Commitment') < 0);

  // An answer cached before 237.248 has conditions but no trays; it must still
  // render rather than showing an opened loan with nothing in it.
  ctx._condOpenRows = {}; ctx._condOpenTrays = {};
  const legacy = JSON.parse(JSON.stringify(data));
  legacy.loans.forEach(function(L) { delete L.trays; });
  render(legacy);
  vm.runInContext("toggleCondRow('rev1')", ctx);
  assert('a pre-237.248 response is grouped into trays on the fly',
    /Title Commitment/.test(el.innerHTML) && /Evidence of Insurance/.test(el.innerHTML), el.innerHTML.slice(0, 700));
  vm.runInContext("toggleCondTray('rev1','title_commitment')", ctx);
  assert('…and its conditions still open', /Remove exception 12/.test(el.innerHTML));
  ctx._condOpenRows = {}; ctx._condOpenTrays = {};

  ctx._condData = null; ctx._condState = 'error'; ctx._condError = 'Server error: nope';
  vm.runInContext('renderConditions()', ctx);
  assert('a failed load says so and offers a retry, instead of an empty list',
    /Server error: nope/.test(el.innerHTML) && /loadConditions\(true\)/.test(el.innerHTML));
  ctx._condState = '';
  assert('nothing outstanding reads as good news, not as an error',
    /Everything asked for has been cleared/.test(render({ totals: { open: 0 }, loans: [] })));
  ctx._myLoansOnly = true;
  assert('with an assignment filter on, a loan that is not on the board is left out rather than guessed at',
    /No open conditions match the current filters/.test(render(data)));
}

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks pass');
process.exit(fail ? 1 : 0);
