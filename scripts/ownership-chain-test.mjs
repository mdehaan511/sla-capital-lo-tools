#!/usr/bin/env node
/**
 * scripts/ownership-chain-test.mjs — Deploy 237.242
 *
 * Mike, on 5909 Cates: "the borrower had a bunch of LLCs with ownership interests
 * in the others … lets do the one where it reads the chain of ownership."
 *
 * The number this produces decides whether a loan meets the 51% guarantor-control
 * guideline, so what it must NOT do matters more than what it does:
 *   - never invent a percent nobody wrote down,
 *   - never quietly answer over a branch whose agreement is missing,
 *   - never loop on a circular ownership statement,
 *   - never stop at the first level because the AI called an LLC a "person".
 *
 * Run: node scripts/ownership-chain-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildOwnershipChain, parentOf, nameKey, borrowingEntity } from '../deploy/netlify/functions/_shared/ownership-chain.mjs';
import { renameTrayDocuments } from '../deploy/netlify/functions/_shared/doc-naming.mjs';

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

// One operating agreement as it sits on the review: a document entry carrying the
// ownership block the AI transcribed off it.
let n = 0;
const oa = (entity, members, at) => ({
  docId: 'oa' + (++n), filename: 'Operating Agreement - ' + entity + '.pdf', hidden: false,
  aiReviewedAt: at || '2026-09-2' + (n % 10) + 'T00:00:00Z',
  ownership: { entity, members },
});
const person = (name, percent, role) => ({ name, percent, kind: 'person', role: role || '' });
const entity = (name, percent, role) => ({ name, percent, kind: 'entity', role: role || '' });

function review(agreements, opts) {
  const o = opts || {};
  return {
    id: 'r1', address: '5909 Cates Ave, St. Louis, MO, 63112',
    guarantors: o.guarantors || [{ index: 0, name: 'Donato Callahan' }, { index: 1, name: 'Tyson Cobb' }],
    docs: {
      articles_of_organization: { aiReviewedAt: '2026-09-18T00:00:00Z', aiExtractedEntities: { llcName: o.root || '5909 Cates Ave LLC' }, documents: [] },
      operating_agreement: { section: 'borrower', currentDocId: 'oa1', documents: agreements },
    },
  };
}

console.log('the 5909 Cates shape: a stack of LLCs\n');
{
  // 5909 Cates Ave LLC is owned by two companies; one of those is owned by a
  // partnership; the partnership is owned by the two guarantors.
  const r = review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 60, 'Manager'), entity('Treeline Capital LLC', 40)]),
    oa('Kalahari Capital LLC', [entity('Deer Trail RE Holdings Limited Partnership', 100)]),
    oa('Treeline Capital LLC', [person('Tyson Cobb', 100, 'Managing Member')]),
    oa('DEER TRAIL RE HOLDINGS LIMITED PARTNERSHIP', [person('Donato Callahan', 75), person('Tyson Cobb', 25)]),
  ]);
  const c = buildOwnershipChain(r);
  check('the root is the entity of record, and its agreement is on file', [c.root.name, c.root.resolved], ['5909 Cates Ave LLC', true]);
  check('it walks all three levels', c.depth, 3);
  check('the people come out multiplied down the chain, largest first',
    c.people.map((p) => [p.name, p.percent]),
    [['Tyson Cobb', 55], ['Donato Callahan', 45]]);
  // 60% x 100% x 75% = 45 to Donato; Tyson gets 60 x 100 x 25 = 15 through the
  // partnership plus 40 direct through Treeline = 55. They sum to 100.
  check('nothing is lost or double-counted', c.people.reduce((a, p) => a + p.percent, 0), 100);
  check('the guarantors hold all of it, with no holes in the chain',
    [c.guarantors.percent, c.guarantors.complete, c.unresolved.length, c.unstated.length], [100, true, 0, 0]);
  check('every company is a node and every membership an edge', [c.nodes.length, c.edges.length], [4, 6]);
  check('the parent of a company is the one the documents name',
    ['Kalahari Capital LLC', 'Treeline Capital LLC', 'Deer Trail RE Holdings LP', '5909 Cates Ave LLC'].map((e) => parentOf(c, e)),
    // the ROOT is named as the loan spells it (the Articles), not as its own
    // agreement happened to punctuate it -- the same rule the file namer follows.
    ['5909 Cates Ave LLC', '5909 Cates Ave LLC', 'Kalahari Capital LLC', '']);
}

console.log('\nwhat it refuses to answer');
{
  // One branch's agreement is not in the file.
  const r = review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 60), entity('Treeline Capital LLC', 40)]),
    oa('Treeline Capital LLC', [person('Tyson Cobb', 100)]),
  ]);
  const c = buildOwnershipChain(r);
  check('the branch with no agreement is named, not assumed',
    c.unresolved.map((u) => [u.entity, u.percent, u.reason]), [['Kalahari Capital LLC', 60, 'no_agreement']]);
  check('what IS proven still adds up, and the answer is marked incomplete',
    [c.people.map((p) => [p.name, p.percent]), c.guarantors.percent, c.guarantors.complete],
    [[['Tyson Cobb', 40]], 40, false]);
}
{
  // A member the document lists with no percent.
  const r = review([
    oa('5909 Cates Ave, LLC', [person('Donato Callahan', 50), person('Tyson Cobb', null)]),
  ]);
  const c = buildOwnershipChain(r);
  check('a percent nobody wrote down stays null — the remainder is NOT split',
    c.people.map((p) => [p.name, p.percent, p.partial]), [['Donato Callahan', 50, false], ['Tyson Cobb', null, true]]);
  check('…and it is listed as unstated, and the total is not called complete',
    [c.unstated, c.guarantors.percent, c.guarantors.complete],
    [[{ entity: '5909 Cates Ave LLC', member: 'Tyson Cobb' }], 50, false]);
}
{
  // A circular statement: A owns B, B owns A.
  const r = review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 100)]),
    oa('Kalahari Capital LLC', [entity('5909 Cates Ave LLC', 100)]),
  ]);
  const c = buildOwnershipChain(r);
  assert('a cycle stops instead of looping', c.unresolved.some((u) => u.reason === 'circular'));
  check('…and says so rather than returning a number', c.guarantors.complete, false);
}
{
  // The AI calls an LLC a "person" — the mistake that silently truncates a chain.
  const r = review([
    oa('5909 Cates Ave, LLC', [{ name: 'Treeline Capital LLC', percent: 100, kind: 'person' }]),
    oa('Treeline Capital LLC', [person('Tyson Cobb', 100)]),
  ]);
  const c = buildOwnershipChain(r);
  check('a name that carries a company suffix is an entity whatever the AI said',
    [c.depth, c.people.map((p) => [p.name, p.percent])], [2, [['Tyson Cobb', 100]]]);
}
{
  const r = review([], { root: '5909 Cates Ave LLC' });
  const c = buildOwnershipChain(r);
  check('no operating agreement at all: no chain, no number, no crash',
    [c.root.resolved, c.people.length, c.guarantors.percent, c.unresolved.length], [false, 0, null, 1]);
  assert('an empty review does not throw', !!buildOwnershipChain({}) && !!buildOwnershipChain(null));
}

console.log('\none company, however each document spells it');
{
  check('the suffix and the punctuation do not make a second company',
    ['5909 Cates Ave, LLC', '5909 CATES AVE LLC', '5909 Cates Ave, L.L.C.'].map(nameKey),
    ['5909 cates ave', '5909 cates ave', '5909 cates ave']);
  const r = review([
    oa('5909 CATES AVE LLC', [entity('KALAHARI CAPITAL, L.L.C.', 100)]),
    oa('Kalahari Capital LLC', [person('Donato Callahan', 100)]),
  ]);
  const c = buildOwnershipChain(r);
  check('so the chain joins up across spellings', [c.depth, c.people.map((p) => [p.name, p.percent])],
    [2, [['Donato Callahan', 100]]]);
}
{
  // Two agreements for one company (an original and a restatement): the most
  // recently reviewed reading wins, and the company is counted once.
  const r = review([
    oa('5909 Cates Ave, LLC', [person('Donato Callahan', 100)], '2026-09-01T00:00:00Z'),
    oa('5909 Cates Ave LLC', [person('Donato Callahan', 50), person('Tyson Cobb', 50)], '2026-09-20T00:00:00Z'),
  ]);
  const c = buildOwnershipChain(r);
  check('a restated agreement replaces the original rather than doubling it',
    c.people.map((p) => [p.name, p.percent]), [['Donato Callahan', 50], ['Tyson Cobb', 50]]);
}

console.log('\nthe file name says which company this is');
{
  // Mike's own example: "Operating Agreement - Treeline Capital LLC (member of
  // 5909 Cates Ave LLC)". The parenthetical comes from the chain, so it only ever
  // appears where the agreements themselves establish the relationship.
  const r = review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 60), entity('Treeline Capital LLC', 40)]),
    oa('Kalahari Capital LLC', [person('Donato Callahan', 100)]),
    oa('Treeline Capital LLC', [person('Tyson Cobb', 100)]),
  ]);
  r.docs.operating_agreement.documents.forEach((d) => { d.nameAuto = true; d.filename = 'x.pdf'; });
  r.docs.operating_agreement.currentDocId = r.docs.operating_agreement.documents[0].docId;
  // Each document's own reading is what names it.
  r.docs.operating_agreement.documents.forEach((d) => { d.aiExtractedEntities = { llcName: d.ownership.entity }; });
  renameTrayDocuments(r, 'operating_agreement');
  check('a member company carries the company it is a member of; the borrower does not',
    r.docs.operating_agreement.documents.map((d) => d.filename), [
      'Operating Agreement - 5909 Cates Ave LLC.pdf',
      'Operating Agreement - Kalahari Capital LLC (member of 5909 Cates Ave LLC).pdf',
      'Operating Agreement - Treeline Capital LLC (member of 5909 Cates Ave LLC).pdf']);
  // A company the chain does not place gets no invented parent.
  const lone = review([oa('Somebody Else LLC', [person('A Person', 100)])]);
  lone.docs.operating_agreement.documents.forEach((d) => {
    d.nameAuto = true; d.filename = 'y.pdf'; d.aiExtractedEntities = { llcName: 'Somebody Else LLC' };
  });
  lone.docs.operating_agreement.documents.push({ docId: 'z', filename: 'z.pdf', nameAuto: true, aiExtractedEntities: { llcName: 'Somebody Else LLC' } });
  renameTrayDocuments(lone, 'operating_agreement');
  check('a company nothing places gets no parent invented for it',
    lone.docs.operating_agreement.documents[0].filename, 'Operating Agreement - Somebody Else LLC.pdf');
}

console.log('\nthe card the processor actually sees');
{
  // renderOwnershipCard is lifted out of the page and RUN, so a card that throws
  // or prints the wrong percentage fails here rather than on a loan file.
  const SRC = readFileSync(new URL('../deploy/loan-doc-review.js', import.meta.url), 'utf8');
  const a = SRC.indexOf('  function _ocPct(');
  const b = SRC.indexOf('  // Deploy 236.533', a);
  assert('the card code is where the gate expects it', a > 0 && b > a);
  const ctx = { console, String, Array, Object, Math, escHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(a, b), ctx);
  const card = (chain) => vm.runInContext('renderOwnershipCard(' + JSON.stringify({ ownershipChain: chain }) + ')', ctx);

  const full = buildOwnershipChain(review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 60, 'Manager'), entity('Treeline Capital LLC', 40)]),
    oa('Kalahari Capital LLC', [person('Donato Callahan', 100)]),
    oa('Treeline Capital LLC', [person('Tyson Cobb', 100)]),
  ]));
  const h = card(full);
  assert('it draws every company and both people', ['5909 Cates Ave LLC', 'Kalahari Capital LLC', 'Treeline Capital LLC', 'Donato Callahan', 'Tyson Cobb'].every((s) => h.indexOf(s) >= 0), h.slice(0, 400));
  assert('it prints the effective percents, not the raw ones', h.indexOf('>60%<') > 0 && h.indexOf('>40%<') > 0, h);
  assert('a complete chain over 51% reads as met, and is not flagged', /Guarantors 100%/.test(h) && /dr-cc-badge ok/.test(h) && !/has-mismatch/.test(h));
  assert('the indentation is by depth', /padding-left:16px/.test(h) && /padding-left:32px/.test(h));

  const holed = card(buildOwnershipChain(review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 60), person('Tyson Cobb', 40)]),
  ])));
  assert('a chain with a hole says FLOOR, names the hole, and does not claim a total',
    /FLOOR/.test(holed) && /No operating agreement on file for Kalahari Capital LLC/.test(holed) && /at least 40%/.test(holed), holed);

  const short = card(buildOwnershipChain(review([
    oa('5909 Cates Ave, LLC', [person('Donato Callahan', 30), person('Tyson Cobb', 70)]),
  ], { guarantors: [{ index: 0, name: 'Donato Callahan' }] })));
  assert('a complete chain UNDER 51% is flagged red', /has-mismatch/.test(short) && /dr-cc-badge fail/.test(short) && /Guarantors 30%/.test(short), short);

  const none = card(buildOwnershipChain(review([])));
  assert('no agreements yet: the card explains itself instead of showing an empty tree',
    /awaiting operating agreements/.test(none) && !/dr-oc-tree/.test(none));
  assert('no chain at all renders nothing', card(null) === '' && card({ root: { name: '' } }) === '');

  const nasty = card(buildOwnershipChain(review([
    oa('<img src=x onerror=alert(1)> LLC', [person('<b>hax</b>', 100)]),
  ], { root: '<img src=x onerror=alert(1)> LLC' })));
  assert('a hostile entity name is escaped', nasty.indexOf('<img src=x') < 0 && nasty.indexOf('&lt;img src=x') > 0);

  // A cycle must not hang the renderer.
  const loop = card(buildOwnershipChain(review([
    oa('5909 Cates Ave, LLC', [entity('Kalahari Capital LLC', 100)]),
    oa('Kalahari Capital LLC', [entity('5909 Cates Ave LLC', 100)]),
  ])));
  assert('a circular chain draws and stops', /already above in this chain/.test(loop));
}

console.log('\nthe review carries what the AI read');
{
  const S = (p) => readFileSync(new URL('../deploy/netlify/functions/' + p, import.meta.url), 'utf8');
  const PROMPT = S('_shared/anthropic-doc-review.mjs');
  assert('the ownership block is asked for on operating agreements only',
    /=== 'operating_agreement'\) \{[\s\S]{0,400}_ownershipSchema =/.test(PROMPT));
  assert('the AI is told never to infer a percent',
    /never split the remainder evenly, never infer/.test(PROMPT));
  assert('a percent out of range or unparseable is dropped, not coerced',
    /if \(!isFinite\(n\) \|\| n <= 0 \|\| n > 100\) return null;/.test(PROMPT));
  for (const f of ['loan-review-ai-background.mjs', 'loan-review-ai-retry.mjs', 'loan-review-doc-upload.mjs']) {
    assert(f + ' persists it', /if \(aiResult\.ownership\)|if \(docState\.ownership\)/.test(S(f)));
  }
  assert('a re-review that reads nothing does not wipe the chain',
    /if \(aiResult\.ownership\) _ok\.ownership = aiResult\.ownership;/.test(S('loan-review-ai-background.mjs')));
  // The chain is assembled ACROSS trays — the operating agreements, which an LO may
  // see, and the Articles, whose entity name of record an LO may not. A derived
  // object that mixes both is not covered by the tray allowlist, so it goes to
  // processors only until someone decides otherwise: the same direction
  // LO_VISIBLE_SLUGS fails in (add deliberately, never expose by side effect).
  const GET = S('loan-reviews-get.mjs');
  const iProc = GET.indexOf('if (isProcessor(user))');
  const iChain = GET.indexOf('r.ownershipChain = buildOwnershipChain(r);');
  const iLo = GET.indexOf('filterReviewForUser(r, user)');
  assert('the chain is attached for processors only', iProc > 0 && iChain > iProc && iChain < iLo);
  const VIS = S('_shared/loan-review-visibility.mjs');
  assert('…and the Articles it reads the entity of record from are not LO-visible',
    !/'articles_of_organization'/.test(VIS));
}

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks pass');
process.exit(fail ? 1 : 0);
