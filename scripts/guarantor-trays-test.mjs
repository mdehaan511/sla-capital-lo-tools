/**
 * scripts/guarantor-trays-test.mjs — Deploy 237.106
 *
 * Gate for the per-guarantor tray split (_shared/guarantor-trays.mjs):
 * adoptGuarantorsFromLoan + expandGuarantorTrays, mirroring the portfolio
 * adopt gate. Pure module — no blob stub needed.
 *
 * Run: node scripts/guarantor-trays-test.mjs
 */
import { adoptGuarantorsFromLoan, expandGuarantorTrays, isMultiGuarantorReview } from '../deploy/netlify/functions/_shared/guarantor-trays.mjs';
import { GUARANTOR_PER_PERSON, guarantorPersonEntries, stripTraySuffix } from '../deploy/netlify/functions/_shared/loan-review-checklists.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
function tray(section, extra) { return Object.assign({ section, verdict: 'pending', currentDocId: '', documents: [], history: [], conditions: 'Base rubric.' }, extra || {}); }
function fixture() {
  return {
    id: 'r_test', loanType: 'rtl',
    docs: {
      guarantor_id:     tray('guarantor', { currentDocId: 'd_id', documents: [{ docId: 'd_id' }] }),
      credit_report:    tray('guarantor'),
      credit_authorization: tray('guarantor', { currentDocId: 'd_ca' }),
      other_123: tray('guarantor', { isCustom: true, label: 'Passport scan' }),
      loan_application: tray('loan', { currentDocId: 'd_app' }),
    },
  };
}
const NAMES = ['Jane Borrower', 'John Cosigner'];

console.log('guarantor trays gate\n');
{
  const review = fixture();
  const a = adoptGuarantorsFromLoan(review, NAMES);
  check('adopts two guarantors', [a.adopted, a.from, a.to], [true, 0, 2]);
  check('roster recorded primary-first', review.guarantors.map((g) => g.name), NAMES);
  check('multi-guarantor review', isMultiGuarantorReview(review), true);
  check('base ID + credit report migrated to Guarantor 1', a.migrated.sort(), ['credit_report', 'guarantor_id']);
  check('  guarantor_id__g0 keeps its document', [!!review.docs.guarantor_id, review.docs.guarantor_id__g0.currentDocId], [false, 'd_id']);
  check('  tagged with the guarantor', [review.docs.guarantor_id__g0.guarantorIndex, review.docs.guarantor_id__g0.guarantorName], [0, 'Jane Borrower']);
  check('  rubric says whose tray it is', /THIS TRAY IS FOR ONE GUARANTOR ONLY: Jane Borrower/.test(review.docs.guarantor_id__g0.conditions), true);
  check('  history notes the move', /guarantor/i.test(review.docs.guarantor_id__g0.history.slice(-1)[0].note), true);
  check('credit authorization stays shared', [!!review.docs.credit_authorization, review.docs.credit_authorization.currentDocId], [true, 'd_ca']);
  check('custom tray untouched', !!review.docs.other_123, true);

  const added = expandGuarantorTrays(review);
  const entries = guarantorPersonEntries('rtl').map((e) => e.slug);
  check('every per-person doc exists for guarantor 2', entries.filter((s) => !review.docs[s + '__g1']), []);
  check('guarantor 1 got the ones it lacked (not the migrated two)', added.filter((s) => /__g0$/.test(s)).indexOf('guarantor_id__g0') < 0 && added.some((s) => /__g0$/.test(s)), true);
  check('guarantor 2 tray carries the name', review.docs.credit_report__g1.guarantorName, 'John Cosigner');
  check('required flag mirrors the checklist', review.docs.credit_report__g1.required, true);
  check('optional stays optional', review.docs.pfs__g1.required, false);

  const again = adoptGuarantorsFromLoan(review, NAMES);
  check('second pass adopts nothing', [again.adopted, again.migrated, again.renamed], [false, [], 0]);
  check('second pass adds nothing', expandGuarantorTrays(review), []);

  const renamed = adoptGuarantorsFromLoan(review, ['Jane B. Borrower', 'John Cosigner']);
  check('a name change refreshes the tray', [renamed.renamed, review.docs.guarantor_id__g0.guarantorName], [1, 'Jane B. Borrower']);
  check('  and the rubric line', /Jane B\. Borrower/.test(review.docs.guarantor_id__g0.conditions) && !/Jane Borrower \(/.test(review.docs.guarantor_id__g0.conditions), true);

  const grown = adoptGuarantorsFromLoan(review, ['Jane B. Borrower', 'John Cosigner', 'Third Person']);
  check('a third guarantor grows the roster', [grown.adopted, grown.to], [true, 3]);
  check('  and gets trays', expandGuarantorTrays(review).filter((s) => /__g2$/.test(s)).length, entries.length);
  const shrunk = adoptGuarantorsFromLoan(review, ['Jane B. Borrower']);
  check('a removed guarantor keeps the roster (trays keep their docs)', [shrunk.adopted, review.guarantors.length], [false, 3]);
}
{
  const single = fixture();
  const r = adoptGuarantorsFromLoan(single, ['Only One']);
  check('single guarantor → untouched', [r.adopted, !!single.docs.guarantor_id, isMultiGuarantorReview(single)], [false, true, false]);
  check('single guarantor → no expansion', expandGuarantorTrays(single), []);
  check('null review never throws', adoptGuarantorsFromLoan(null, NAMES).adopted, false);
  const keep = fixture(); keep.docs.guarantor_id__g0 = tray('guarantor', { guarantorIndex: 0, currentDocId: 'd_keep' });
  const k = adoptGuarantorsFromLoan(keep, NAMES);
  check('an existing __g0 is never clobbered (base stays as inbox)', [k.migrated.indexOf('guarantor_id') < 0, !!keep.docs.guarantor_id, keep.docs.guarantor_id__g0.currentDocId], [true, true, 'd_keep']);
}
check('stripTraySuffix handles both suffixes', [stripTraySuffix('credit_report__g1'), stripTraySuffix('appraisal__p2'), stripTraySuffix('psa')], ['credit_report', 'appraisal', 'psa']);
check('per-person list is the seven guarantor docs', GUARANTOR_PER_PERSON.length, 7);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
