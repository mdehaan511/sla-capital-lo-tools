#!/usr/bin/env node
/**
 * scripts/servicing-transfer-letter-test.mjs — Deploy 237.211 (Mike)
 *
 * The Notice of Transfer of Loan Servicing, sent from a loan's Servicing tab. It "auto
 * fills the appropriate items and asks for input on the items that it can't grab from the
 * loan itself."
 *
 * What would actually hurt, in order:
 *
 *   1. A NOTICE WITH A HOLE IN IT reaches a borrower — "[NEW SERVICER NAME]", a blank
 *      date, a servicer with no way to contact them. It is a legal-flavoured document
 *      telling someone where to send money. So the PDF builder REFUSES an incomplete
 *      letter, and this file proves no bracket placeholder can print.
 *
 *   2. A DATE THAT IS OFF BY ONE. `new Date('2026-10-01')` is UTC midnight and prints as
 *      September 30 in Spokane. Every date here is parsed by hand.
 *
 *   3. THE WRONG THINGS GET "GRABBED". The first two loans this was built for are Baseline
 *      imports: an entity and an address, and no servicer, no borrower name, no email.
 *      The resolver must say so rather than invent a salutation or a recipient.
 *
 * Run: node scripts/servicing-transfer-letter-test.mjs [--write <path.pdf>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import {
  LETTER_FIELDS, resolveLetterFields, validateLetter, normalizeLetterFields, buildTransferLetterPdf,
  nextDueOnOrAfter, fmtLongDate, parseIsoDate, findServicer, letterFilename, buildCoverEmail, SLA_BLOCK,
} from '../deploy/netlify/functions/_shared/servicing-transfer-letter.mjs';

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

const NOW = new Date(2026, 8, 21, 9, 0, 0);   // 21 Sep 2026, local
const DIRECTORY = [
  { id: 'v1', name: 'Jane at FCI', company: 'FCI Lender Services', phone: '800-931-2424', email: 'service@myfci.com' },
  { id: 'v2', name: '', company: 'Servicing Pros', phone: '509-555-0100', email: 'help@servicingpros.com' },
];

// ── 1. what the loan can and cannot supply ──────────────────────────────────
console.log('\nA Baseline import: an entity, an address, and nothing else');
// The exact shape of l_baseline_SLA-1646 on 2026-09-21.
const IMPORT = resolveLetterFields({
  loan: { id: 'l_baseline_SLA-1646', slaDisplayId: 'SLA-1646', entityName: 'HHS Ventures, LLC',
          address: '2113 E 5th Ave Spokane WA 99202', servicerName: '', _baselineRaw: { Due_Date: '1' } },
  client: { id: 'c_x', firstName: '', lastName: '', email: '', displayName: 'HHS Ventures, LLC (import)' },
  guarantors: [], servicers: DIRECTORY, fallbackLoanNumber: 'SLA-20250715-0001', now: NOW,
});
check('the entity is the borrower of record', IMPORT.fields.borrowerLine, 'HHS Ventures, LLC');
check('...and, with no person on file, the salutation too', IMPORT.fields.dearName, 'HHS Ventures, LLC');
check('the loan number is the one on the loan, not a derived one', IMPORT.fields.loanNumber, 'SLA-1646');
check('the property address', IMPORT.fields.propertyAddress, '2113 E 5th Ave Spokane WA 99202');
check('the letter is dated today', IMPORT.fields.date, '2026-09-21');
check('no servicer on file means no servicer is guessed', IMPORT.fields.currentServicer, '');
check('no email on file means no recipient is invented', IMPORT.recipients, []);
check('it ASKS for exactly what it could not grab', IMPORT.asked,
  ['currentServicer', 'newServicer', 'newServicerAddress', 'transferDate', 'nextPaymentDue', 'currentServicerPhone', 'newServicerPhone']);
check('the payment day comes from the servicing record', IMPORT.dueDay, 1);

console.log('\nA native loan: a person, a servicer in the directory, emails');
const NATIVE = resolveLetterFields({
  loan: { id: 'l_1', entityName: 'Ohana Home Pros LLC', address: '9 Elm Ave, Troy, MI 48083', servicerName: 'fci lender services' },
  client: { firstName: 'Jeremy', lastName: 'Wilson', email: 'JW@Example.com' },
  guarantors: [{ firstName: 'Ana', lastName: 'Wilson', email: 'ana@example.com' }, { email: 'jw@example.com' }],
  servicers: DIRECTORY, fallbackLoanNumber: 'SLA-20260101-0042', now: NOW,
});
check('entity on the Borrower line', NATIVE.fields.borrowerLine, 'Ohana Home Pros LLC');
check('a PERSON in the salutation when there is one', NATIVE.fields.dearName, 'Jeremy Wilson');
check('no display id falls back to the derived number', NATIVE.fields.loanNumber, 'SLA-20260101-0042');
check('the current servicer\'s contact comes from the Vendors directory, case-blind',
  [NATIVE.fields.currentServicerPhone, NATIVE.fields.currentServicerEmail], ['800-931-2424', 'service@myfci.com']);
check('recipients: borrower + guarantors, lower-cased, de-duplicated', NATIVE.recipients, ['jw@example.com', 'ana@example.com']);
check('a loan with no servicing record pays on the 1st', NATIVE.dueDay, 1);
check('the directory lookup is by company, then name', (findServicer(DIRECTORY, ' SERVICING  pros ') || {}).id, 'v2');
check('...and an unknown servicer is simply not found', findServicer(DIRECTORY, 'Nobody Servicing'), null);

// ── 2. dates ────────────────────────────────────────────────────────────────
console.log('\nDates do not drift');
check('Oct 1 prints as Oct 1 (not Sep 30, the UTC-midnight trap)', fmtLongDate('2026-10-01'), 'October 1, 2026');
check('not a date is not a date', [fmtLongDate(''), fmtLongDate('10/01/2026'), fmtLongDate('2026-02-30')], ['', '', '']);
check('Feb 29 exists only in a leap year', [!!parseIsoDate('2028-02-29'), !!parseIsoDate('2026-02-29')], [true, false]);

console.log('\nThe first payment due ON OR AFTER the transfer');
check('transfer on the due day itself: that payment', nextDueOnOrAfter('2026-10-01', 1), '2026-10-01');
check('transfer mid-month: the next 1st', nextDueOnOrAfter('2026-10-15', 1), '2026-11-01');
check('a 15th-of-the-month loan, transfer on the 1st', nextDueOnOrAfter('2026-10-01', 15), '2026-10-15');
check('December rolls into January', nextDueOnOrAfter('2026-12-02', 1), '2027-01-01');
check('a 31st due day lands on the last day of a short month', nextDueOnOrAfter('2027-02-05', 31), '2027-02-28');
check('a nonsense due day means the 1st', nextDueOnOrAfter('2026-10-15', 'abc'), '2026-11-01');
check('no transfer date, no suggestion', nextDueOnOrAfter('', 1), '');

// ── 3. the letter cannot go out with a hole in it ───────────────────────────
console.log('\nValidation');
const GOOD = normalizeLetterFields(Object.assign({}, IMPORT.fields, {
  currentServicer: 'FCI Lender Services', currentServicerPhone: '800-931-2424', currentServicerEmail: 'service@myfci.com',
  newServicer: 'Servicing Pros', newServicerAddress: 'PO Box 1234\nSpokane, WA 99210',
  newServicerPhone: '509-555-0100', newServicerEmail: 'help@servicingpros.com', newServicerPortal: 'https://pay.servicingpros.com',
  transferDate: '2026-10-01', nextPaymentDue: '2026-10-01',
}));
check('a complete letter has nothing wrong with it', validateLetter(GOOD), []);
LETTER_FIELDS.filter((d) => d.required).forEach((d) => {
  const broken = Object.assign({}, GOOD, { [d.key]: '' });
  assert('  blank "' + d.key + '" is caught', validateLetter(broken).some((p) => p.indexOf(d.label) === 0), JSON.stringify(validateLetter(broken)));
});
assert('a servicer nobody can reach is caught (current)',
  validateLetter(Object.assign({}, GOOD, { currentServicerPhone: '', currentServicerEmail: '' })).length === 1);
assert('...and (new)', validateLetter(Object.assign({}, GOOD, { newServicerPhone: '', newServicerEmail: '' })).length === 1);
assert('a phone alone is enough', validateLetter(Object.assign({}, GOOD, { newServicerEmail: '' })).length === 0);
assert('transferring a loan to the servicer it already has is caught',
  validateLetter(Object.assign({}, GOOD, { newServicer: 'fci lender services' })).length === 1);
assert('a first payment BEFORE the transfer is caught',
  validateLetter(Object.assign({}, GOOD, { nextPaymentDue: '2026-09-01' })).length === 1);
assert('a mistyped email is caught', validateLetter(Object.assign({}, GOOD, { newServicerEmail: 'help@' })).length === 1);
assert('the portal is optional', validateLetter(Object.assign({}, GOOD, { newServicerPortal: '' })).length === 0);

// ── 4. the PDF ──────────────────────────────────────────────────────────────
console.log('\nThe PDF');
/** What pdfkit drew, PER PAGE (one content stream each). Standard fonts are written as
 *  hex inside TJ arrays. */
function pdfPages(buf) {
  const s = buf.toString('latin1');
  const pages = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    let chunk = Buffer.from(m[1], 'latin1');
    try { chunk = zlib.inflateSync(chunk); } catch (_) { /* already plain */ }
    const body = chunk.toString('latin1');
    const out = [];
    const tj = /\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ/g;
    let t;
    while ((t = tj.exec(body))) {
      const hex = (t[1].match(/<([0-9a-fA-F]*)>/g) || []).map((h) => h.slice(1, -1)).join('');
      out.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
    if (out.length) pages.push(out.join(' ').replace(/\s+/g, ' '));
  }
  return pages;
}
const pdfText = (buf) => pdfPages(buf).join(' ');
/** Every font size set in the content streams (the `/F1 10.4 Tf` operators). */
function pdfSizes(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(s))) {
    let chunk = Buffer.from(m[1], 'latin1');
    try { chunk = zlib.inflateSync(chunk); } catch (_) {}
    const body = chunk.toString('latin1');
    const tf = /\/F\d+ ([\d.]+) Tf/g;
    let t;
    while ((t = tf.exec(body))) out.push(Math.round(Number(t[1]) * 10) / 10);
  }
  return out;
}

let refused = null;
try { await buildTransferLetterPdf(Object.assign({}, GOOD, { newServicer: '' })); } catch (e) { refused = e; }
assert('the builder REFUSES an incomplete letter — the backstop behind the form', !!refused && Array.isArray(refused.problems));

const pdf = await buildTransferLetterPdf(GOOD);
const wi = process.argv.indexOf('--write');
if (wi > 0 && process.argv[wi + 1]) writeFileSync(process.argv[wi + 1], pdf);
const text = pdfText(pdf);
assert('it is a PDF', pdf.slice(0, 5).toString() === '%PDF-');
// LAYOUT, judged the way a reader would. Readable type comes first: one page only if it
// fits without shrinking into fine print, otherwise a DELIBERATE two-page letter.
const pg = pdfPages(pdf);
assert('one page, or a deliberate two', pg.length === 1 || pg.length === 2, 'got ' + pg.length + ' pages');
if (pg.length === 2) {
  assert('  page 2 opens a whole section — it is not a stray overflow',
    pg[1].indexOf('Questions Prior to Transfer') >= 0, pg[1].slice(0, 120));
  assert('  the signature is NOT orphaned: it shares page 2 with that section',
    pg[1].indexOf('Sincerely,') >= 0 && pg[1].indexOf('please contact') >= 0);
  assert('  page 2 says what it is a page of', /page 2/.test(pg[1]) && pg[1].indexOf('SLA-1646') >= 0);
}
// Whatever the page count: a contact block is never split across the break.
const withName = pg.filter((t) => t.indexOf('FCI Lender Services Phone: 800-931-2424') >= 0).length;
assert('the current servicer\'s name and phone are on the SAME page', withName === 1);
assert('...and so are the new servicer\'s', pg.some((t) => t.indexOf('PO Box 1234') >= 0 && t.indexOf('Phone: 509-555-0100') >= 0));
// BODY type = the size nearly every run is set in (the mode). The 8pt letterhead line and
// the 9pt footer tagline are furniture, and are not what a borrower has to read.
const allSizes = pdfSizes(pdf);
const tally = {};
allSizes.forEach((n) => { tally[n] = (tally[n] || 0) + 1; });
const bodySize = Number(Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0]);
assert('body type is never below 9.5pt — a notice about where to send money is not fine print',
  bodySize >= 9.5, 'body is set in ' + bodySize + 'pt; sizes used: ' + JSON.stringify(tally));
['NOTICE OF TRANSFER OF LOAN SERVICING', 'September 21, 2026', 'HHS Ventures, LLC', 'SLA-1646', '2113 E 5th Ave',
 'FCI Lender Services', 'Servicing Pros', 'October 1, 2026', 'PO Box 1234', 'Phone: 509-555-0100', 'Email: help@servicingpros.com',
 'Online Payment Portal: https://pay.servicingpros.com', 'Your Loan Terms Are Not Changing', 'do not assume',
 'Phone: 800-931-2424', SLA_BLOCK.addr1, SLA_BLOCK.email, SLA_BLOCK.tagline,
].forEach((needle) => assert('  prints "' + needle.slice(0, 44) + '"', text.indexOf(needle) >= 0, 'not found in the drawn text'));
assert('NO bracket placeholder survives anywhere in the letter', !/\[[A-Z][A-Z /]+\]/.test(text), (text.match(/\[[A-Z][A-Z /]+\]/) || [''])[0]);

const lean = pdfText(await buildTransferLetterPdf(Object.assign({}, GOOD, { newServicerPortal: '', newServicerEmail: '', currentServicerEmail: '' })));
assert('an empty optional line is OMITTED, never printed blank',
  lean.indexOf('Online Payment Portal') < 0 && lean.indexOf('Email: help@') < 0 && lean.indexOf('Email: service@') < 0);
assert('...and SLA\'s own email is still there', lean.indexOf(SLA_BLOCK.email) >= 0);

console.log('\nFilename and cover email');
check('named for the street', letterFilename(GOOD), 'Notice of Servicing Transfer - 2113 E 5th Ave.pdf');
const cover = buildCoverEmail(GOOD);
assert('the subject carries the loan and the street', /SLA-1646/.test(cover.subject) && /2113 E 5th Ave/.test(cover.subject));
assert('the email says the two things that matter: who, and from when',
  /from FCI Lender Services to Servicing Pros/.test(cover.text) && /October 1, 2026/.test(cover.text));
assert('...and that the loan terms are not changing', /terms of your loan are not changing/.test(cover.text));

// ── 5. the form on the Servicing tab, RUN, not read ─────────────────────────
// loan-details.js is a browser script with no exports. node --check cannot see an
// undeclared identifier or a number treated as a Date (237.208) — only running it can. So
// the letter block is lifted out and executed against a stub DOM.
console.log('\nThe form (executed against a stub DOM)');
import vm from 'node:vm';
const LD = readFileSync(new URL('../deploy/loan-details.js', import.meta.url), 'utf8');
const a0 = LD.indexOf('// ── Servicing Transfer Letter (Deploy 237.');
const a1 = LD.indexOf('// Deploy 236.890 — generate + download the filled FCI boarding package.');
assert('the letter block can be lifted from loan-details.js', a0 > 0 && a1 > a0);
const els = {};
const mkEl = (id) => (els[id] = els[id] || {
  id, value: '', attrs: {}, style: {}, innerHTML: '', disabled: false, textContent: '',
  setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; },
  removeAttribute(k) { delete this.attrs[k]; }, remove() { delete els[id]; },
});
let appended = null;
const toasts = [];
const ctx = {
  console, URL, setTimeout, Date, Math, Number, String, Object, JSON, Error,
  _loan: { id: 'l_baseline_SLA-1646' }, _client: { id: 'c_x' }, _loanId: 'l_baseline_SLA-1646',
  _closingOwner: () => 'chance@slacapital.com',
  showToast: (m) => toasts.push(m),
  escH: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  escAttr: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  fmtDateTime: (iso) => 'on ' + String(iso).slice(0, 10),
  confirm: () => true,
  SLA: { api: () => Promise.resolve({}), getToken: () => Promise.resolve('t') },
  document: {
    getElementById: (id) => els[id] || null,
    createElement: () => ({ className: '', id: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, remove() {} }),
    body: { appendChild: (el) => { appended = el; } },
  },
};
vm.createContext(ctx);
vm.runInContext(LD.slice(a0, a1), ctx, { filename: 'loan-details.js#stl' });

// What prefill returns for l_baseline_SLA-1646: see section 1.
ctx._stl = {
  defs: LETTER_FIELDS, fields: IMPORT.fields, asked: IMPORT.asked, dueDay: IMPORT.dueDay, recipients: [],
  servicers: [{ name: 'FCI Lender Services', phone: '800-931-2424', email: 'service@myfci.com' }],
  remembered: [{ name: 'Servicing Pros', address: 'PO Box 1234\nSpokane, WA 99210', phone: '509-555-0100', email: 'help@servicingpros.com', portal: 'https://pay.servicingpros.com' }],
  lastSent: null, alwaysCc: 'boarding@slacapital.com', nextDueTouched: false,
};
let threw = null;
try { vm.runInContext('_stlRender()', ctx); } catch (e) { threw = e; }
assert('the form renders without throwing', !threw, threw && threw.stack);
const html = (appended && appended.innerHTML) || '';
LETTER_FIELDS.forEach((d) => assert('  draws "' + d.key + '"', html.indexOf('id="stl_' + d.key + '"') >= 0));
check('the header counts what it filled and what it needs', (html.match(/Filled from the loan: <b>(\d+)<\/b>[^<]*Needs your input: <b[^>]*>(\d+)</) || []).slice(1), ['5', '7']);
IMPORT.asked.forEach((k) => assert('  "' + k + '" is marked as needing input',
  new RegExp('id="stl_' + k + '" style="border-left:3px solid').test(html)));
assert('  ...and a field the loan DID fill is not', /id="stl_loanNumber" style=""/.test(html));
assert('a loan with no borrower email says so, at the recipient box', /no borrower email on file/.test(html));
assert('both servicer pickers share one list: the directory + servicers used before',
  /<datalist id="stlServicerList"><option value="FCI Lender Services"><\/option><option value="Servicing Pros"><\/option><\/datalist>/.test(html));
assert('nothing in the form can submit without the person pressing a button', !/<form/i.test(html));

// Picking a servicer fills its contact block — but never over something a person typed.
LETTER_FIELDS.forEach((d) => { mkEl('stl_' + d.key).value = IMPORT.fields[d.key] || ''; });
mkEl('stl_currentServicer').value = 'fci lender services';
vm.runInContext("_stlOnInput('currentServicer')", ctx);
check('picking the current servicer fills its phone and email from Vendors',
  [els.stl_currentServicerPhone.value, els.stl_currentServicerEmail.value], ['800-931-2424', 'service@myfci.com']);
mkEl('stl_newServicer').value = 'Servicing Pros';
vm.runInContext("_stlOnInput('newServicer')", ctx);
check('picking a servicer used BEFORE brings back the whole block — the second loan types nothing',
  [els.stl_newServicerAddress.value, els.stl_newServicerPhone.value, els.stl_newServicerPortal.value],
  ['PO Box 1234\nSpokane, WA 99210', '509-555-0100', 'https://pay.servicingpros.com']);
els.stl_newServicerPhone.value = '509-555-9999'; vm.runInContext("_stlOnInput('newServicerPhone')", ctx);   // a person typed this
els.stl_newServicer.value = 'Servicing Pros'; vm.runInContext("_stlOnInput('newServicer')", ctx);
check('a phone the person typed is NOT overwritten by a re-pick', els.stl_newServicerPhone.value, '509-555-9999');

// The next-due suggestion follows the transfer date until the person takes it over.
els.stl_transferDate.value = '2026-10-15'; vm.runInContext("_stlOnInput('transferDate')", ctx);
check('the transfer date suggests the first payment due on or after it', els.stl_nextPaymentDue.value, '2026-11-01');
els.stl_nextPaymentDue.value = '2026-12-01'; vm.runInContext("_stlOnInput('nextPaymentDue')", ctx);
els.stl_transferDate.value = '2026-10-20'; vm.runInContext("_stlOnInput('transferDate')", ctx);
check('...and stops suggesting once the person has set it themselves', els.stl_nextPaymentDue.value, '2026-12-01');

console.log('\nThe browser and the server agree on the next-due rule');
[['2026-10-01', 1], ['2026-10-15', 1], ['2026-10-01', 15], ['2026-12-02', 1], ['2027-02-05', 31], ['2026-10-15', 'abc'], ['', 1], ['2028-02-10', 30]]
  .forEach(([t, d]) => check('  ' + JSON.stringify([t, d]), vm.runInContext('_stlNextDue(' + JSON.stringify(t) + ',' + JSON.stringify(d) + ')', ctx), nextDueOnOrAfter(t, d)));

const collected = vm.runInContext('_stlCollect()', ctx);
check('what the form sends is exactly the letter\'s field list', Object.keys(collected).sort(), LETTER_FIELDS.map((d) => d.key).sort());

// ── 6. wiring ───────────────────────────────────────────────────────────────
console.log('\nWiring');
const EP = readFileSync(new URL('../deploy/netlify/functions/servicing-transfer-letter.mjs', import.meta.url), 'utf8');
const TOML = readFileSync(new URL('../deploy/netlify.toml', import.meta.url), 'utf8');
const LDH = readFileSync(new URL('../deploy/loan-details.html', import.meta.url), 'utf8');
assert('the Servicing tab has the button', /id="stlBtn" onclick="openServicingTransferLetter\(\)"/.test(LD));
assert('...inside the Servicing Info section, under Save Changes',
  LD.indexOf('saveServicingFields()">Save Changes') < LD.indexOf('id="stlBtn"') && LD.indexOf('id="stlBtn"') < LD.indexOf('_buildExtensionSectionHtml(l)'));
assert('the route exists', /from = "\/api\/servicing-transfer-letter"\s*\n\s*to = "\/\.netlify\/functions\/servicing-transfer-letter"/.test(TOML));
assert('the page is pinned to a loan-details.js that HAS the form (a cached copy does not)',
  Number((LDH.match(/loan-details\.js\?v=(\d+)/) || [])[1]) >= 237211, 'feedback_guard_the_function');
assert('processor / admin only', /if \(!isProcessor\(user\)\) return json\(403/.test(EP));
assert('the hole check runs BEFORE the PDF is built, for preview and send alike',
  EP.indexOf('const problems = validateLetter(fields);') < EP.indexOf('const pdf = await buildTransferLetterPdf(fields);') &&
  EP.indexOf('const pdf = await buildTransferLetterPdf(fields);') < EP.indexOf("if (action === 'pdf') return pdfResponse"));
assert('a preview writes nothing: the PDF returns before any store is touched',
  EP.indexOf("if (action === 'pdf') return pdfResponse") < EP.indexOf('await lettersStore().setJSON'));
assert('boarding@ is copied on every send', /const cc = \[SLA_BLOCK\.email\]\.concat\(emailList\(body\.cc\)\)/.test(EP));
assert('an address that is not an email stops the send rather than being dropped quietly',
  /const bad = rawList\(body\.to\)\.concat\(rawList\(body\.cc\)\)\.filter\(\(e\) => !isEmail\(e\)\);\s*\n\s*if \(bad\.length\) return json\(422/.test(EP));
// The email is the act; filing, remembering and logging are the record of it. Once the
// borrower has the letter, a failed note must not tell the sender it did not go.
const afterSend = EP.slice(EP.indexOf('const emailId = await sendWithAttachment'));
check('everything after the email is wrapped — the record can never un-send the letter',
  (afterSend.slice(0, afterSend.indexOf('return json(200')).match(/\n  try \{/g) || []).length, 3);
assert('the letter is kept EXACTLY as sent', /pdfB64: pdf\.toString\('base64'\)/.test(EP) && /action === 'download'/.test(EP));
assert('the send is logged to the loan', /kind: 'servicing_transfer_notice'/.test(EP) && /await writeClient\(ownerKey, client/.test(EP));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
