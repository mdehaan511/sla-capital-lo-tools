#!/usr/bin/env node
/**
 * scripts/guarantor-removal-test.mjs — Deploy 237.159
 *
 * Jessy: "Loan ID - SLA-20260930-4291 (621 Stewart Ave). 2nd guarantor (Marcus P.) has
 * been removed but still shows guarantor doc trays in documents."
 * Mike: "If a guarantor is removed we want their information still saved in case they
 * come back but the doc trays for that borrower should get hidden with the docs still
 * saved in them."
 *
 * Two things have to hold at once, and they pull against each other:
 *   KEEP  — the person, their slot, their trays and every document in them.
 *   HIDE  — the trays, so nobody is chasing documents for someone who left.
 *
 * And the slot must never be handed to a different human. The roster used to be matched
 * by POSITION, so removing guarantor 2 and adding someone else re-labelled Marcus's
 * documents with the new person's name — that is the case these checks care most about.
 *
 * Run: node scripts/guarantor-removal-test.mjs
 */
import {
  adoptGuarantorsFromLoan, expandGuarantorTrays, isMultiGuarantorReview,
  activeGuarantors, setGuarantorTraysHidden,
} from '../deploy/netlify/functions/_shared/guarantor-trays.mjs';
import { guarantorIndexFor, slugForSigner } from '../deploy/netlify/functions/_shared/credit-auth-split.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + String(why).slice(0, 240) : ''));
};

const JEREMY = 'Jeremy Wilson', MARCUS = 'Marcus Perez', SARAH = 'Sarah Jones';
const names = (r) => activeGuarantors(r).map((g) => g.name);

// A review with two guarantors, each holding a real document.
function twoGuarantorReview() {
  const r = { id: 'rev', loanType: 'dscr', guarantors: [], docs: {} };
  adoptGuarantorsFromLoan(r, [JEREMY, MARCUS]);
  expandGuarantorTrays(r);
  r.docs.guarantor_id__g0.currentDocId = 'd_jw';
  r.docs.guarantor_id__g0.currentFilename = 'Guarantor ID - Jeremy Wilson.png';
  r.docs.guarantor_id__g1.currentDocId = 'd_mp';
  r.docs.guarantor_id__g1.currentFilename = 'Guarantor ID - Marcus Perez.png';
  r.docs.credit_report__g1.currentDocId = 'd_mp_cr';
  return r;
}

console.log('\nJessy\'s case: the 2nd guarantor comes off the loan');
const r = twoGuarantorReview();
check('both guarantors start on the loan', names(r), [JEREMY, MARCUS]);
const g1Trays = Object.keys(r.docs).filter((s) => r.docs[s].guarantorIndex === 1);
assert('guarantor 2 has trays to begin with', g1Trays.length > 0);

const gone = adoptGuarantorsFromLoan(r, [JEREMY]);
check('only Jeremy is on the loan now', names(r), [JEREMY]);
check('...and Marcus was flagged removed, not deleted', [gone.removed, r.guarantors.length], [[1], 2]);
check('his name and slot are still on the record (Mike: "still saved in case they come back")',
  [r.guarantors[1].name, r.guarantors[1].index, !!r.guarantors[1].removedAt], [MARCUS, 1, true]);
assert('EVERY tray of his is hidden', g1Trays.every((s) => r.docs[s].hidden === true),
  JSON.stringify(g1Trays.map((s) => [s, !!r.docs[s].hidden])));
assert('...hidden without waiting on an underwriter to confirm it',
  g1Trays.every((s) => !!r.docs[s].hiddenConfirmedAt));
assert('...and marked as OUR hide, so un-hiding never clobbers a human\'s',
  g1Trays.every((s) => r.docs[s].hiddenByGuarantorRemoval === true));
check('THE DOCUMENTS ARE STILL THERE (Mike: "with the docs still saved in them")',
  [r.docs.guarantor_id__g1.currentDocId, r.docs.guarantor_id__g1.currentFilename, r.docs.credit_report__g1.currentDocId],
  ['d_mp', 'Guarantor ID - Marcus Perez.png', 'd_mp_cr']);
assert('the tray history says why it went away',
  (r.docs.guarantor_id__g1.history || []).some((h) => h.action === 'guarantor_removed' && /Marcus/.test(h.note || '')));
check('Jeremy\'s own trays are untouched',
  [r.docs.guarantor_id__g0.hidden, r.docs.guarantor_id__g0.currentDocId], [undefined, 'd_jw']);
check('the loan stops being a multi-guarantor review, so the page drops the per-person groups',
  isMultiGuarantorReview(r), false);
check('and no new trays are minted for him', expandGuarantorTrays(r).filter((s) => /__g1$/.test(s)), []);

console.log('\nHe comes back');
const back = adoptGuarantorsFromLoan(r, [JEREMY, MARCUS]);
check('restored to the SAME slot', [back.restored, names(r)], [[1], [JEREMY, MARCUS]]);
check('...with his documents exactly where he left them',
  [r.docs.guarantor_id__g1.hidden, r.docs.guarantor_id__g1.currentDocId], [undefined, 'd_mp']);
check('the review is multi-guarantor again', isMultiGuarantorReview(r), true);

console.log('\nA hide a processor made themselves is not ours to undo');
const r2 = twoGuarantorReview();
r2.docs.pfs__g1.hidden = true;                     // a human hid this one, before any removal
r2.docs.pfs__g1.hiddenConfirmedAt = '2026-09-01T00:00:00Z';
adoptGuarantorsFromLoan(r2, [JEREMY]);
adoptGuarantorsFromLoan(r2, [JEREMY, MARCUS]);
check('their hide survives the guarantor leaving and coming back',
  [r2.docs.pfs__g1.hidden, r2.docs.pfs__g1.hiddenByGuarantorRemoval], [true, undefined]);
check('...while the ones we hid came back', r2.docs.guarantor_id__g1.hidden, undefined);

console.log('\nThe slot is never handed to a different person');
const r3 = twoGuarantorReview();
const swap = adoptGuarantorsFromLoan(r3, [JEREMY, SARAH]);
check('Marcus leaving and Sarah joining is a REMOVAL plus an ADDITION, not a rename',
  [swap.removed, swap.renamed, r3.guarantors.length], [[1], 0, 3]);
check('Marcus keeps slot 1 and his documents; Sarah gets a slot of her own',
  [r3.guarantors[1].name, r3.docs.guarantor_id__g1.currentDocId, r3.guarantors[2].name],
  [MARCUS, 'd_mp', SARAH]);
assert('Sarah\'s trays are hers alone', (() => {
  expandGuarantorTrays(r3);
  return !r3.docs.guarantor_id__g2.currentDocId && r3.docs.guarantor_id__g2.guarantorName === SARAH;
})());

console.log('\nA misspelling is still a correction, not a new person');
const r4 = twoGuarantorReview();
const fixed = adoptGuarantorsFromLoan(r4, [JEREMY, 'Marcus Perezz']);
check('a name sharing a word with the old one is a rename, in place',
  [fixed.renamed, fixed.removed, r4.guarantors.length, r4.guarantors[1].name],
  [1, [], 2, 'Marcus Perezz']);
check('...the old spelling is kept, so nothing is silently lost',
  r4.guarantors[1].previousNames, [MARCUS]);
check('...and his documents never moved', r4.docs.guarantor_id__g1.currentDocId, 'd_mp');

console.log('\nRefusals');
const r5 = twoGuarantorReview();
const empty = adoptGuarantorsFromLoan(r5, []);
check('an EMPTY roster changes nothing (a failed lookup must not empty the loan)',
  [empty.removed, names(r5)], [[], [JEREMY, MARCUS]]);
assert('...and no tray was hidden', !r5.docs.guarantor_id__g1.hidden);

const r6 = twoGuarantorReview();
adoptGuarantorsFromLoan(r6, [JEREMY]);
check('setGuarantorTraysHidden is idempotent', setGuarantorTraysHidden(r6, 1, true, MARCUS), []);

console.log('\nA departed guarantor is handed no new documents');
const roster = [{ index: 0, name: JEREMY }, { index: 1, name: MARCUS, removed: true }];
check('a signed credit auth never resolves to someone off the loan',
  guarantorIndexFor({ name: MARCUS }, roster, 1), -1);
check('...and the person still on it resolves fine', guarantorIndexFor({ name: JEREMY }, roster, 0), 0);
check('a nameless removed slot does not win on position either',
  guarantorIndexFor({ name: 'Nobody Known' }, [{ name: JEREMY }, { name: '', removed: true }], 1), -1);
check('no tray is offered for a removed guarantor',
  slugForSigner({ guarantors: roster, docs: { credit_authorization__g1: {} } }, 1), '');
check('...while the active one still gets theirs',
  slugForSigner({ guarantors: roster, docs: { credit_authorization__g0: {} } }, 0), 'credit_authorization__g0');

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
