/**
 * scripts/borrower-forms-test.mjs — Deploy 236.945
 *
 * Gate for _shared/borrower-forms.mjs: every form maps to a real tray,
 * prefill / validation / scrubbing behave, and each renderer produces a PDF
 * (the W-9 on top of the bundled IRS template).
 *
 * Run: node scripts/borrower-forms-test.mjs
 */
import { PDFDocument } from '../deploy/node_modules/pdf-lib/cjs/index.js';
import {
  FORMS, formForSlug, formById, slugsWithForms, prefillFor, validateAnswers, scrubAnswers,
  renderFormPdf, filedName, commitmentLetterText, loadW9Template, ESIGN_CONSENT_VERSION,
} from '../deploy/netlify/functions/_shared/borrower-forms.mjs';
import { getChecklist } from '../deploy/netlify/functions/_shared/loan-review-checklists.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const slugsOf = (t) => getChecklist(t).map((e) => e.slug);

console.log('borrower forms gate\n');

// -- Every form files into a tray that exists on the checklist ---------------
check('four forms', Object.keys(FORMS).sort(), ['commitment_letter', 'draw_wire', 'pm_questionnaire', 'w9']);
check('W-9 → closing_w9 on DSCR and RTL', [slugsOf('dscr').includes('closing_w9'), slugsOf('rtl').includes('closing_w9')], [true, true]);
check('PM questionnaire → property_mgmt_questionnaire on DSCR', slugsOf('dscr').includes('property_mgmt_questionnaire'), true);
check('draw wire → draw_wire_form on RTL and GUC', [slugsOf('rtl').includes('draw_wire_form'), slugsOf('guc').includes('draw_wire_form')], [true, true]);
check('commitment letter → commitment_letter on DSCR, RTL, GUC', ['dscr', 'rtl', 'guc'].map((t) => slugsOf(t).includes('commitment_letter')), [true, true, true]);
check('new trays are storage-only + optional', getChecklist('rtl').filter((e) => ['draw_wire_form', 'commitment_letter'].includes(e.slug)).map((e) => [!!e.optional, !!e.noReview]), [[true, true], [true, true]]);
check('formForSlug resolves per-property slugs through the base', formForSlug('property_mgmt_questionnaire__p2').id, 'pm_questionnaire');
check('formForSlug is null for an ordinary tray', formForSlug('appraisal'), null);
check('slugsWithForms', slugsWithForms().sort(), ['closing_w9', 'commitment_letter', 'draw_wire_form', 'property_mgmt_questionnaire']);
check('formById', [formById('w9').slug, formById('nope')], ['closing_w9', null]);

// -- Prefill -------------------------------------------------------------------
const ctx = {
  loan: { address: '2524 Hawthorne Ave, Evansville, IN 47714', entityName: 'Hawthorne Holdings LLC', toolType: 'rtl', loanType: 'light', loanAmt: 206500, fundingDate: '2026-10-01' },
  client: { firstName: 'Jamie', lastName: 'Sample', email: 'jamie@example.com', homeAddress: { street: '108 E Maryland St', city: 'Evansville', state: 'IN', zip: '47711' } },
  sender: { name: 'Jessy Ortiz', title: 'Senior Loan Processor', phone: '(509) 555-0142', email: 'jessy@slacapital.com' },
  now: '2026-09-10T12:00:00.000Z',
};
{
  const p = prefillFor(FORMS.w9, ctx);
  check('W-9 prefill: entity name, home address, city/state/zip', [p.name, p.address, p.cityStateZip], ['Hawthorne Holdings LLC', '108 E Maryland St', 'Evansville, IN 47711']);
  check('W-9 prefill never guesses the TIN', 'tin' in p, false);
  const noEntity = prefillFor(FORMS.w9, { loan: {}, client: ctx.client });
  check('  falls back to the borrower name without an entity', noEntity.name, 'Jamie Sample');
  const c = prefillFor(FORMS.commitment_letter, ctx);
  check('letter prefill: dates, program, amount, rep', [c.letterDate, c.expirationDate, c.loanProgram, c.loanAmount, c.targetCloseDate, c.repName, c.repTitle, c.repEmail],
    ['2026-09-10', '2026-10-10', 'Fix & Flip', 206500, '2026-10-01', 'Jessy Ortiz', 'Senior Loan Processor', 'jessy@slacapital.com']);
  check('  DSCR loan → DSCR Rental', prefillFor(FORMS.commitment_letter, { loan: { toolType: 'dscr' } }).loanProgram, 'DSCR Rental');
  check('PM prefill: borrower + property', (() => { const q = prefillFor(FORMS.pm_questionnaire, ctx); return [q.borrowerName, q.propertyAddress]; })(), ['Jamie Sample', ctx.loan.address]);
}

// -- Validation ----------------------------------------------------------------
{
  const v = validateAnswers(FORMS.w9.fields, { name: 'X LLC', taxClass: 'llc', llcClass: 'P', address: '1 Main', cityStateZip: 'Spokane, WA 99201', tinType: 'ein', tin: '12-3456789' });
  check('W-9 valid set passes; TIN digits normalised', [v.ok, v.clean.tin, v.clean.llcClass], [true, '123456789', 'P']);
  const bad = validateAnswers(FORMS.w9.fields, { taxClass: 'llc', tinType: 'ssn', tin: '123' });
  check('W-9 missing/short fields are named', Object.keys(bad.errors).sort(), ['address', 'cityStateZip', 'name', 'tin']);
  const hidden = validateAnswers(FORMS.w9.fields, { name: 'A', taxClass: 'individual', address: 'x', cityStateZip: 'y', tinType: 'ssn', tin: '123456789', llcClass: 'zzz' });
  check('a hidden conditional field is ignored', [hidden.ok, 'llcClass' in hidden.clean], [true, false]);
  check('select rejects an unknown option', validateAnswers(FORMS.w9.fields, { taxClass: 'nonsense' }).errors.taxClass, 'Choose one of the options');
  const dw = validateAnswers(FORMS.draw_wire.fields, { accountName: 'X', accountNumber: '12-34', routingNumber: '12345678', routingConfirmed: 'on' });
  check('routing number must be 9 digits; account digits kept; checkbox coerced', [dw.errors.routingNumber, dw.clean.accountNumber, dw.clean.routingConfirmed], ['Must be exactly 9 digits', '1234', true]);
  check('required checkbox unchecked is an error', validateAnswers(FORMS.draw_wire.fields, { accountName: 'X', accountNumber: '1234', routingNumber: '123456789' }).errors.routingConfirmed, 'Required');
  const sf = validateAnswers(FORMS.commitment_letter.staffFields, { letterDate: '2026-09-10', loanProgram: 'Bridge', loanAmount: '$206,500', targetCloseDate: '2026-10-01', expirationDate: 'soon', repName: 'J', repTitle: 'T', repEmail: 'j@x.com' });
  check('letter staff fields: money normalised, bad date flagged', [sf.clean.loanAmount, sf.errors.expirationDate], ['206500', 'Enter a date']);
}

// -- Scrubbing: no TIN / account number survives on the request record --------
{
  const s = scrubAnswers(FORMS.w9, { name: 'X', tin: '123456789', tinType: 'ein' });
  check('W-9 record keeps last4 only', [s.tinLast4, 'tin' in s, s.name], ['6789', false, 'X']);
  const d = scrubAnswers(FORMS.draw_wire, { accountName: 'X', accountNumber: '0011223344', routingNumber: '086300012' });
  check('draw wire record keeps account last4, full routing', [d.accountNumberLast4, 'accountNumber' in d, d.routingNumber], ['3344', false, '086300012']);
}

// -- Rendering -----------------------------------------------------------------
{
  const sig = { name: 'Jamie Q. Sample', email: 'jamie@example.com', signedAt: '2026-09-10T18:22:00.000Z', ip: '203.0.113.7', seal: 'abcdef0123456789', consentVersion: ESIGN_CONSENT_VERSION };
  check('W-9 template is in the bundle', loadW9Template().length > 40000, true);
  const answers = {
    w9: { name: 'Hawthorne Holdings LLC', taxClass: 'llc', llcClass: 'P', foreignPartners: true, address: '108 E Maryland St', cityStateZip: 'Evansville, IN 47711', tinType: 'ein', tin: '123456789' },
    pm_questionnaire: { borrowerName: 'Jamie Sample', propertyAddress: ctx.loan.address, yearsSelfManaged: '6 years', unitsSelfManaged: '14', sameArea: 'yes', distance: 'About 4 miles' },
    draw_wire: { accountName: 'Hawthorne Holdings LLC', bankName: 'Old National Bank', accountNumber: '0011223344', routingNumber: '086300012', routingConfirmed: true },
    commitment_letter: {},
  };
  const staffValues = Object.assign(prefillFor(FORMS.commitment_letter, ctx), { loanAmount: '206500' });
  for (const id of Object.keys(FORMS)) {
    const bytes = await renderFormPdf(FORMS[id], { answers: answers[id], staffValues, ctx, signature: sig });
    const head = Buffer.from(bytes.slice(0, 5)).toString();
    const doc = await PDFDocument.load(bytes);
    check(id + ' renders a one-page PDF', [head, doc.getPageCount()], ['%PDF-', 1]);
  }
  const unsigned = await renderFormPdf(FORMS.pm_questionnaire, { answers: answers.pm_questionnaire, ctx, signature: null });
  check('renders without a signature too', Buffer.from(unsigned.slice(0, 5)).toString(), '%PDF-');
  check('filed name is safe + descriptive', filedName(FORMS.w9, ctx, '2026-09-10T18:22:00Z'), 'Hawthorne Holdings LLC - Form W-9 - 2026-09-10.pdf');
  const letter = commitmentLetterText(staffValues, ctx).join('\n');
  check('letter text carries the key terms', [/Up to \$206,500/.test(letter), /October 1, 2026/.test(letter), /valid through October 10, 2026/.test(letter), /Jessy Ortiz/.test(letter)], [true, true, true, true]);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
