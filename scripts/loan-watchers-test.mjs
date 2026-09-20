#!/usr/bin/env node
/**
 * scripts/loan-watchers-test.mjs — Deploy 237.195
 *
 * Beth: "Would it be possible for the notification bell to only show notifications for
 * the loans we're working on? That way, the notif would be specific to each
 * processor/loan officer. For example: 'Mike/Borrower just uploaded PFS – Property
 * Address'"
 *
 * The scoping IS the feature. She opened by asking whether the bell "might get too busy",
 * so a borrower upload that pings every admin would technically satisfy "notify us" while
 * failing what she actually asked for — and a bell people stop reading is worse than no
 * bell. These checks pin who hears about a document, and who deliberately does not.
 *
 * Run: node scripts/loan-watchers-test.mjs
 */
import { loanWatchers, uploadNotice, streetOf } from '../deploy/netlify/functions/_shared/loan-watchers.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};

const LO = 'sara.s@slacapital.com';
const BETH = 'beth@slacapital.com';
const KEITH = 'keith@slacapital.com';
const ADMIN = 'mike@slacapital.com';
const BORROWER = 'ceo@monarcalegacygroup.com';

const loan = {
  id: 'l1', address: '5223 Ditman Street, Philadelphia, PA, 19124',
  assignedProcessors: [{ email: BETH, name: 'Beth', role: 'processor' },
                       { email: KEITH, name: 'Keith', role: 'closer' }],
};

console.log('\nWho hears about a document');
check('the LO who owns it, and everyone on its processing team',
  loanWatchers(loan, LO), [LO, BETH, KEITH]);
check('the LO comes first — it is their loan', loanWatchers(loan, LO)[0], LO);
check('an admin who is NOT on this loan hears nothing (Beth: "specific to each processor")',
  loanWatchers(loan, LO).indexOf(ADMIN), -1);
check('a loan with no processing team still tells the LO',
  loanWatchers({ id: 'l2' }, LO), [LO]);
check('a pre-team loan with only the single old assignment still works',
  loanWatchers({ assignedProcessor: { email: BETH } }, LO), [LO, BETH]);
check('a processor named on the review is included too',
  loanWatchers({ processorEmail: KEITH }, LO), [LO, KEITH]);

console.log('\nNobody is notified about their own upload');
check('the borrower is not on the list anyway, but is excluded explicitly',
  loanWatchers(loan, LO, { exclude: BORROWER }), [LO, BETH, KEITH]);
check('a PROCESSOR uploading on the borrower\'s behalf does not ping themselves',
  loanWatchers(loan, LO, { exclude: BETH }), [LO, KEITH]);
check('...nor does the LO uploading', loanWatchers(loan, LO, { exclude: LO }), [BETH, KEITH]);

console.log('\nThe list is clean');
check('the same person twice is once',
  loanWatchers({ assignedProcessors: [{ email: BETH }, { email: 'BETH@slacapital.com' }] }, LO), [LO, BETH]);
check('the LO also being a processor on their own loan is once',
  loanWatchers({ assignedProcessors: [{ email: LO }] }, LO), [LO]);
check('case and stray spaces do not make a second person',
  loanWatchers({ assignedProcessors: [{ email: '  Beth@SLACapital.com ' }] }, LO), [LO, BETH]);
check('blanks and junk are dropped, not notified',
  loanWatchers({ assignedProcessors: [{ email: '' }, { email: 'not-an-email' }, {}, null] }, LO), [LO]);
check('no loan at all still tells the LO', loanWatchers(null, LO), [LO]);
check('no LO and no team notifies nobody', loanWatchers(null, ''), []);

console.log('\nThe line Beth asked for');
check('"<who> uploaded <doc>" with the property under it',
  uploadNotice({ who: 'Nehemias Lopez', docLabel: 'Personal Financial Statement (PFS)', address: loan.address }),
  { title: 'Nehemias Lopez uploaded Personal Financial Statement (PFS)', text: '5223 Ditman Street' });
check('just the street, not the whole postal address', streetOf(loan.address), '5223 Ditman Street');
check('an unnamed uploader still reads like a sentence',
  uploadNotice({ docLabel: 'W-9', address: loan.address }).title, 'The borrower uploaded W-9');
check('an unnamed document too',
  uploadNotice({ who: 'Beth', address: loan.address }).title, 'Beth uploaded a document');
check('no address falls back to something useful rather than an empty line',
  uploadNotice({ who: 'Beth', docLabel: 'W-9', address: '' }).text, 'Open the loan to review it');

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
