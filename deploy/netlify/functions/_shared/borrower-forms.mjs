/**
 * _shared/borrower-forms.mjs — Deploy 236.945
 *
 * Mike: "I have these forms that the processing team needs to be able to send
 * for the borrowers to fill out. Ideally what I want is in the document tray
 * for these items is a button for the processor to send them to the borrower
 * and once they are completed they are automatically put into the tray to
 * review."
 *
 * The four forms, each tied to the Doc Review tray it files into:
 *   w9                 → closing_w9                  (IRS W-9, overlaid on the official PDF)
 *   pm_questionnaire   → property_mgmt_questionnaire (self-managed PM questionnaire)
 *   draw_wire          → draw_wire_form              (construction draw wire information)
 *   commitment_letter  → commitment_letter           (SLA's letter; the borrower acknowledges)
 *
 * Flow: processor clicks the tray's "send form" button → borrower-form-send
 * mints a token link + emails it → the borrower completes + signs on
 * borrower-form.html → borrower-form-submit renders the PDF here and files it
 * into the tray via attachPdfToReviewSlug. Native eSign has no form fields (it
 * stamps signatures only), so the form itself is a web page and the signature
 * is the same typed-name + ESIGN-consent model term sheets use.
 *
 * Everything in this file is pure except renderFormPdf (pdf-lib) and the W-9
 * template read; gated by scripts/borrower-forms-test.mjs.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const PLUM  = rgb(0.149, 0.102, 0.212);   // #261A36
const GOLD  = rgb(0.784, 0.506, 0.227);   // #C8813A
const TEXT  = rgb(0.102, 0.082, 0.125);   // #1A1520
const MUTED = rgb(0.478, 0.455, 0.533);   // #7A7488
const LINE  = rgb(0.86, 0.84, 0.80);
const INK   = rgb(0.06, 0.06, 0.35);      // filled-in W-9 entries: a "pen" blue-black

export const ESIGN_CONSENT_VERSION = 1;
export const ESIGN_CONSENT_TEXT =
  'By typing my name below and submitting this form I agree that my electronic signature is the legal equivalent ' +
  'of my handwritten signature under the federal ESIGN Act (15 U.S.C. § 7001 et seq.) and the Uniform Electronic ' +
  'Transactions Act as adopted in my state, and I certify that the information I provided is true and correct.';

export const FORMS = {
  w9: {
    id: 'w9', slug: 'closing_w9', label: 'Form W-9',
    title: 'Form W-9 — Request for Taxpayer Identification Number and Certification',
    intro: 'SLA Capital needs a completed W-9 for the borrowing entity or individual. Your answers are placed onto the official IRS form and filed with your loan.',
    signature: true,
    fields: [
      { key: 'name', label: '1. Name of entity/individual (as shown on your income tax return)', type: 'text', required: true, prefill: 'entityOrBorrower', max: 90 },
      { key: 'businessName', label: '2. Business name / disregarded entity name, if different from above', type: 'text', max: 90 },
      { key: 'taxClass', label: '3a. Federal tax classification', type: 'select', required: true, options: [
        ['individual', 'Individual / sole proprietor'], ['c_corp', 'C corporation'], ['s_corp', 'S corporation'],
        ['partnership', 'Partnership'], ['trust', 'Trust/estate'], ['llc', 'LLC'], ['other', 'Other'] ] },
      { key: 'llcClass', label: 'LLC tax classification (C = C corporation, S = S corporation, P = Partnership)', type: 'select', options: [['', '—'], ['C', 'C'], ['S', 'S'], ['P', 'P']], showIf: { taxClass: 'llc' } },
      { key: 'otherClass', label: 'Other — describe', type: 'text', max: 60, showIf: { taxClass: 'other' } },
      { key: 'foreignPartners', label: '3b. Check if you are a partnership, trust/estate, or LLC taxed as a partnership AND have any foreign partners, owners, or beneficiaries', type: 'checkbox' },
      { key: 'address', label: '5. Address (number, street, and apt. or suite no.)', type: 'text', required: true, prefill: 'homeStreet', max: 80 },
      { key: 'cityStateZip', label: '6. City, state, and ZIP code', type: 'text', required: true, prefill: 'homeCityStateZip', max: 80 },
      { key: 'tinType', label: 'Taxpayer identification number type', type: 'select', required: true, options: [['ssn', 'Social Security Number (SSN)'], ['ein', 'Employer Identification Number (EIN)']] },
      { key: 'tin', label: 'Taxpayer identification number (9 digits)', type: 'tin', required: true, sensitive: true },
    ],
  },
  pm_questionnaire: {
    id: 'pm_questionnaire', slug: 'property_mgmt_questionnaire', label: 'Property Management Questionnaire',
    title: 'Property Management Questionnaire — For Self-Managed Properties',
    intro: 'Please answer the questions below about the properties you manage yourself.',
    signature: true,
    fields: [
      { key: 'borrowerName', label: 'Borrower Name', type: 'text', required: true, prefill: 'borrowerName', max: 90 },
      { key: 'propertyAddress', label: 'Property Address', type: 'text', required: true, prefill: 'propertyAddress', max: 120 },
      { key: 'yearsSelfManaged', label: 'How long have you self-managed properties?', type: 'text', required: true, max: 60 },
      { key: 'unitsSelfManaged', label: 'How many units do you currently self-manage?', type: 'text', required: true, max: 40 },
      { key: 'sameArea', label: 'Are the properties you currently self-manage in the same geographic area as the subject property?', type: 'select', required: true, options: [['yes', 'Yes'], ['no', 'No']] },
      { key: 'distance', label: 'What is the distance between the subject property and your personal residence?', type: 'text', required: true, max: 60 },
    ],
  },
  draw_wire: {
    id: 'draw_wire', slug: 'draw_wire_form', label: 'Construction Draw Wire Information Form',
    title: 'Construction Draw — Wire Information Form',
    intro: 'Please provide the bank account information where construction draw funds should be sent.',
    notice: 'IMPORTANT — WIRE ROUTING NUMBER: Banks often use a different routing number for receiving wire transfers than for ACH or other transactions. Please confirm directly with your bank that the routing number provided is the correct routing number for receiving wires.',
    signature: true,
    fields: [
      { key: 'accountName', label: 'Name on Account', type: 'text', required: true, prefill: 'entityOrBorrower', max: 90 },
      { key: 'bankName', label: 'Bank Name', type: 'text', max: 80 },
      { key: 'accountNumber', label: 'Bank Account Number', type: 'digits', required: true, sensitive: true, min: 4, max: 17 },
      { key: 'routingNumber', label: 'Routing Number (for incoming WIRES)', type: 'digits', required: true, min: 9, max: 9 },
      { key: 'routingConfirmed', label: 'I confirmed with my bank that this routing number is the correct one for receiving WIRE transfers.', type: 'checkbox', required: true },
    ],
  },
  commitment_letter: {
    id: 'commitment_letter', slug: 'commitment_letter', label: 'Loan Commitment Letter',
    title: 'Loan Commitment Letter — Financing Confirmation',
    intro: 'Please review SLA Capital\'s loan commitment letter below and sign to acknowledge receipt.',
    signature: true, acknowledge: true,
    fields: [],
    // Filled by the processor in the send modal (prefilled from the loan + their profile).
    staffFields: [
      { key: 'letterDate',      label: 'Letter date',                   type: 'date',  required: true, prefill: 'today' },
      { key: 'loanProgram',     label: 'Loan program',                  type: 'text',  required: true, prefill: 'loanProgram', max: 60 },
      { key: 'loanAmount',      label: 'Approved loan amount (up to $)', type: 'money', required: true, prefill: 'loanAmt' },
      { key: 'targetCloseDate', label: 'Target closing date',           type: 'date',  required: true, prefill: 'closingDate' },
      { key: 'expirationDate',  label: 'Commitment valid through',      type: 'date',  required: true, prefill: 'todayPlus30' },
      { key: 'repName',         label: 'Authorized representative',     type: 'text',  required: true, prefill: 'senderName', max: 80 },
      { key: 'repTitle',        label: 'Title',                         type: 'text',  required: true, prefill: 'senderTitle', max: 60 },
      { key: 'repPhone',        label: 'Phone',                         type: 'text',  prefill: 'senderPhone', max: 30 },
      { key: 'repEmail',        label: 'Email',                         type: 'text',  required: true, prefill: 'senderEmail', max: 80 },
    ],
  },
};

export function formForSlug(slug) {
  const base = String(slug || '').replace(/__p\d+$/, '');
  for (const id of Object.keys(FORMS)) if (FORMS[id].slug === base) return FORMS[id];
  return null;
}
export function formById(id) { return FORMS[String(id || '')] || null; }
export function slugsWithForms() { return Object.keys(FORMS).map((id) => FORMS[id].slug); }

// ── Prefill ───────────────────────────────────────────────────────────────
function _ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function _programLabel(loan) {
  const t = String((loan && loan.toolType) || '').toLowerCase();
  const lt = String((loan && loan.loanType) || '').toLowerCase();
  if (t === 'dscr') return 'DSCR Rental';
  if (t === 'guc') return 'Ground-Up Construction';
  if (t === 'rtl') return /bridge/.test(lt) ? 'Bridge' : 'Fix & Flip';
  return '';
}
/** Values for every field with a `prefill` source. ctx = { loan, client, sender: {name, title, phone, email}, now? } */
export function prefillFor(form, ctx) {
  const loan = (ctx && ctx.loan) || {}, client = (ctx && ctx.client) || {}, sender = (ctx && ctx.sender) || {};
  const now = (ctx && ctx.now) ? new Date(ctx.now) : new Date();
  const plus30 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  const ha = (client.homeAddress && typeof client.homeAddress === 'object') ? client.homeAddress : {};
  const borrowerName = [client.firstName, client.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  const entity = String(loan.entityName || loan.vestingEntity || client.entityName || client.companyName || '').trim();
  const src = {
    entityOrBorrower: entity || borrowerName,
    borrowerName,
    propertyAddress: String(loan.address || '').trim(),
    homeStreet: String(ha.street || client.address || '').trim(),
    homeCityStateZip: [ha.city || client.city, [ha.state || client.state, ha.zip || client.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ').trim(),
    today: _ymd(now),
    todayPlus30: _ymd(plus30),
    loanProgram: _programLabel(loan),
    loanAmt: Number(loan.finalLoanAmount || loan.loanAmt || 0) || '',
    closingDate: String(loan.fundingDate || loan.originationDate || loan.desiredCloseDate || '').slice(0, 10),
    senderName: String(sender.name || '').trim(),
    senderTitle: String(sender.title || 'Loan Processor').trim(),
    senderPhone: String(sender.phone || '').trim(),
    senderEmail: String(sender.email || '').trim(),
  };
  const out = {};
  for (const f of (form.fields || []).concat(form.staffFields || [])) {
    if (f.prefill && src[f.prefill] !== undefined && src[f.prefill] !== '') out[f.key] = src[f.prefill];
  }
  return out;
}

// ── Validation ────────────────────────────────────────────────────────────
function _visible(f, answers) {
  if (!f.showIf) return true;
  return Object.keys(f.showIf).every((k) => String(answers[k] || '') === String(f.showIf[k]));
}
/** Validate + normalise a set of answers against `fields`. Returns { ok, errors: {key: msg}, clean }. */
export function validateAnswers(fields, answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const errors = {}, clean = {};
  for (const f of fields || []) {
    if (!_visible(f, a)) continue;
    let v = a[f.key];
    if (f.type === 'checkbox') {
      v = !!(v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
      if (f.required && !v) errors[f.key] = 'Required';
      clean[f.key] = v; continue;
    }
    v = String(v == null ? '' : v).trim();
    if (f.type === 'tin' || f.type === 'digits') v = v.replace(/[^0-9]/g, '');
    if (f.type === 'money') v = v.replace(/[^0-9.]/g, '');
    if (!v) { if (f.required) errors[f.key] = 'Required'; continue; }
    if (f.type === 'select' && !(f.options || []).some((o) => o[0] === v)) { errors[f.key] = 'Choose one of the options'; continue; }
    if (f.type === 'tin' && v.length !== 9) { errors[f.key] = 'Enter all 9 digits'; continue; }
    if (f.type === 'digits' && ((f.min && v.length < f.min) || (f.max && v.length > f.max))) {
      errors[f.key] = (f.min === f.max) ? ('Must be exactly ' + f.min + ' digits') : ('Must be ' + f.min + '-' + f.max + ' digits'); continue;
    }
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { errors[f.key] = 'Enter a date'; continue; }
    if (f.type === 'money' && !(Number(v) > 0)) { errors[f.key] = 'Enter an amount'; continue; }
    if (f.max && f.type !== 'digits' && v.length > f.max) v = v.slice(0, f.max);
    clean[f.key] = v;
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}
/** What we keep on the request record after rendering: never a full TIN or account number. */
export function scrubAnswers(form, answers) {
  const out = {};
  for (const f of form.fields || []) {
    if (!(f.key in (answers || {}))) continue;
    const v = answers[f.key];
    if (f.sensitive) { out[f.key + 'Last4'] = String(v || '').slice(-4); continue; }
    out[f.key] = v;
  }
  return out;
}

// ── PDF rendering ─────────────────────────────────────────────────────────
function _fmtDate(ymdOrIso) {
  const s = String(ymdOrIso || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function _money(n) { const v = Number(n) || 0; return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function _wrap(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) <= maxWidth || !cur) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
async function _fonts(pdf) {
  return {
    helv: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    sig:  await pdf.embedFont(StandardFonts.TimesRomanItalic),
  };
}
// Deploy 236.950 (Mike: "make sure all of the documents have the company
// logo/letterhead at the top" — except the W-9, a government form). The logo
// is a 720px copy of SLA_Capital_Logo_2_1.png bundled at _templates/sla-logo.png;
// a missing file falls back to the wordmark so a document never fails to render.
export function loadLogo() {
  const candidates = [
    join(_funcDir, '..', '_templates', 'sla-logo.png'),
    join(_funcDir, '_templates', 'sla-logo.png'),
    join(process.cwd(), 'netlify', 'functions', '_templates', 'sla-logo.png'),
    join(process.cwd(), 'deploy', 'netlify', 'functions', '_templates', 'sla-logo.png'),
  ];
  for (const p of candidates) { try { return readFileSync(p); } catch (_) {} }
  return null;
}
const LOGO_H = 46;   // points; the mark is 2000x1609 so this is ~57pt wide
// Letterhead: logo top-left, gold rule, then the document title. Returns the
// y where body text may start. `logo` is the embedded PDFImage or null.
function _letterhead(page, F, logo, title) {
  const { width, height } = page.getSize();
  const top = height - 50;
  if (logo) {
    const w = LOGO_H * (logo.width / logo.height);
    page.drawImage(logo, { x: 54, y: top - LOGO_H, width: w, height: LOGO_H });
  } else {
    page.drawText('SLA Capital', { x: 54, y: top - 20, size: 18, font: F.bold, color: PLUM });
  }
  const rule = top - LOGO_H - 12;
  page.drawLine({ start: { x: 54, y: rule }, end: { x: width - 54, y: rule }, thickness: 1.2, color: GOLD });
  let y = rule - 26;
  if (title) {
    for (const ln of _wrap(title, F.bold, 13, width - 108)) { page.drawText(ln, { x: 54, y, size: 13, font: F.bold, color: TEXT }); y -= 17; }
    y -= 6;
  }
  return y;
}
async function _embedLogo(pdf) {
  try { const bytes = loadLogo(); return bytes ? await pdf.embedPng(bytes) : null; }
  catch (e) { console.warn('borrower-forms: logo embed failed:', e && e.message); return null; }
}
function _paragraph(page, F, text, x, y, size, maxWidth, color) {
  for (const ln of _wrap(text, F.helv, size, maxWidth)) { page.drawText(ln, { x, y, size, font: F.helv, color: color || TEXT }); y -= size * 1.45; }
  return y;
}
function _signatureBlock(page, F, y, signature, caption) {
  const { width } = page.getSize();
  const name = String((signature && signature.name) || '').trim();
  const when = signature && signature.signedAt ? _fmtDate(signature.signedAt) : '';
  page.drawText(caption || 'Signature', { x: 54, y: y, size: 9, font: F.helv, color: MUTED });
  page.drawText('Date', { x: 400, y: y, size: 9, font: F.helv, color: MUTED });
  page.drawLine({ start: { x: 54, y: y - 26 }, end: { x: 380, y: y - 26 }, thickness: 0.8, color: TEXT });
  page.drawLine({ start: { x: 400, y: y - 26 }, end: { x: width - 54, y: y - 26 }, thickness: 0.8, color: TEXT });
  if (name) page.drawText(name, { x: 60, y: y - 22, size: 16, font: F.sig, color: PLUM });
  if (when) page.drawText(when, { x: 406, y: y - 22, size: 10, font: F.helv, color: TEXT });
  return y - 40;
}
function _auditLine(page, F, signature) {
  if (!signature || !signature.name) return;
  const bits = ['Electronically signed by ' + signature.name];
  if (signature.email) bits.push(signature.email);
  if (signature.signedAt) bits.push(new Date(signature.signedAt).toUTCString());
  if (signature.ip) bits.push('IP ' + signature.ip);
  if (signature.seal) bits.push('seal ' + String(signature.seal).slice(0, 12));
  bits.push('ESIGN consent v' + (signature.consentVersion || ESIGN_CONSENT_VERSION));
  const text = bits.join(' · ');
  let y = 40;
  for (const ln of _wrap(text, F.helv, 7.5, page.getSize().width - 108).reverse()) { page.drawText(ln, { x: 54, y, size: 7.5, font: F.helv, color: MUTED }); y += 10; }
}

// Generic labelled-answer layout (PM questionnaire, draw wire form).
async function _renderSimpleForm(form, answers, ctx, signature) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const F = await _fonts(pdf);
  let y = _letterhead(page, F, await _embedLogo(pdf), form.title);
  const loan = (ctx && ctx.loan) || {};
  if (loan.address) { page.drawText('Loan: ' + loan.address, { x: 54, y, size: 9.5, font: F.helv, color: MUTED }); y -= 16; }
  if (form.intro) y = _paragraph(page, F, form.intro, 54, y, 10, 504, TEXT) - 8;
  for (const f of form.fields) {
    if (!_visible(f, answers)) continue;
    let v = answers[f.key];
    if (f.type === 'checkbox') v = v ? 'Yes' : 'No';
    else if (f.type === 'select') { const o = (f.options || []).find((x) => x[0] === v); v = o ? o[1] : v; }
    v = String(v == null ? '' : v);
    const labelLines = _wrap(f.label, F.helv, 9, 504);
    for (const ln of labelLines) { page.drawText(ln, { x: 54, y, size: 9, font: F.helv, color: MUTED }); y -= 12; }
    page.drawText(v || '—', { x: 54, y: y - 2, size: 11.5, font: F.bold, color: TEXT });
    page.drawLine({ start: { x: 54, y: y - 7 }, end: { x: 558, y: y - 7 }, thickness: 0.6, color: LINE });
    y -= 26;
  }
  if (form.notice) {
    y -= 4;
    const lines = _wrap(form.notice, F.helv, 9, 484);
    const boxH = lines.length * 12.5 + 16;
    page.drawRectangle({ x: 54, y: y - boxH + 10, width: 504, height: boxH, borderColor: GOLD, borderWidth: 0.8, color: rgb(0.984, 0.957, 0.90) });
    let yy = y - 4;
    for (const ln of lines) { page.drawText(ln, { x: 64, y: yy, size: 9, font: F.helv, color: TEXT }); yy -= 12.5; }
    y = y - boxH - 4;
  }
  y = Math.min(y - 10, 200);
  _signatureBlock(page, F, y, signature, 'Signature');
  _auditLine(page, F, signature);
  return pdf.save();
}

// SLA's commitment letter: staff values fill the placeholders; the borrower acknowledges.
async function _renderCommitmentLetter(form, staffValues, ctx, signature) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const F = await _fonts(pdf);
  const loan = (ctx && ctx.loan) || {}, client = (ctx && ctx.client) || {};
  const sv = staffValues || {};
  const borrower = String(loan.entityName || loan.vestingEntity || client.entityName || '').trim() ||
    [client.firstName, client.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ') || 'Borrower';
  const address = String(loan.address || '').trim() || '[property address]';
  const { width, height } = page.getSize();
  let y = _letterhead(page, F, await _embedLogo(pdf), '');
  page.drawText('LOAN COMMITMENT LETTER', { x: 54, y, size: 14, font: F.bold, color: TEXT });
  page.drawText('Financing Confirmation', { x: 54, y: y - 16, size: 10.5, font: F.helv, color: MUTED });
  y -= 42;
  const P = (t, gap) => { y = _paragraph(page, F, t, 54, y, 10, 504) - (gap == null ? 7 : gap); };
  P('Date: ' + _fmtDate(sv.letterDate), 4);
  P('To: Borrower, Seller, Listing Agent, and/or Other Interested Parties', 4);
  P('Re: Financing commitment for ' + address, 12);
  P('SLA Capital is pleased to confirm its commitment to provide financing to ' + borrower + ' for the property referenced above. ' +
    'Based on our review of the information provided, the loan has been approved to proceed toward closing. The customary lender due diligence and closing requirements are summarized below.', 12);
  const rows = [
    ['Borrower', borrower], ['Property', address], ['Loan Program', String(sv.loanProgram || '')],
    ['Approved Loan Amount', 'Up to ' + _money(sv.loanAmount)], ['Target Closing Date', _fmtDate(sv.targetCloseDate)],
  ];
  const boxTop = y + 4, rowH = 18;
  page.drawRectangle({ x: 54, y: boxTop - rows.length * rowH - 8, width: 504, height: rows.length * rowH + 8, borderColor: LINE, borderWidth: 0.8 });
  for (const [k, v] of rows) {
    page.drawText(k, { x: 62, y: y - 10, size: 9.5, font: F.bold, color: MUTED });
    page.drawText(v, { x: 220, y: y - 10, size: 10, font: F.helv, color: TEXT });
    y -= rowH;
  }
  y -= 22;
  P('Our lending team is prepared to move forward with this transaction and work toward the target closing date shown above.', 12);
  page.drawText('Closing Requirements', { x: 54, y, size: 11, font: F.bold, color: TEXT }); y -= 16;
  P('This commitment is based on the information currently provided and remains subject to satisfactory completion of customary lender due diligence and closing requirements, including property valuation/appraisal, acceptable title and lien position, insurance, required borrower or entity documentation, funds to close, and execution of final loan documents. A material change to the borrower, property, or transaction may require reevaluation.', 10);
  P('This letter confirms SLA Capital\'s current lending commitment for the transaction described above and is not a substitute for the definitive loan documents executed at closing.', 10);
  P('This commitment is valid through ' + _fmtDate(sv.expirationDate) + ', unless extended by SLA Capital in writing.', 12);
  page.drawText('Sincerely,', { x: 54, y, size: 10, font: F.helv, color: TEXT }); y -= 24;
  page.drawText(String(sv.repName || ''), { x: 54, y, size: 13, font: F.sig, color: PLUM }); y -= 14;
  page.drawText([String(sv.repTitle || ''), 'SLA Capital'].filter(Boolean).join(' | '), { x: 54, y, size: 9.5, font: F.helv, color: TEXT }); y -= 12;
  page.drawText([String(sv.repPhone || ''), String(sv.repEmail || '')].filter(Boolean).join(' | '), { x: 54, y, size: 9.5, font: F.helv, color: MUTED }); y -= 24;
  y = Math.min(y - 4, 140);
  _signatureBlock(page, F, y, signature, 'Acknowledged and accepted by Borrower');
  _auditLine(page, F, signature);
  return pdf.save();
}

// The official IRS W-9 (Rev. March 2024) with the answers written into its boxes.
// Coordinates are PDF points, origin bottom-left, measured from the template's
// own label positions (see scripts/borrower-forms-test.mjs for the layout QA).
const _funcDir = dirname(fileURLToPath(import.meta.url));
export function loadW9Template() {
  const candidates = [
    join(_funcDir, '..', '_templates', 'fw9.pdf'),
    join(_funcDir, '_templates', 'fw9.pdf'),
    join(process.cwd(), 'netlify', 'functions', '_templates', 'fw9.pdf'),
    join(process.cwd(), 'deploy', 'netlify', 'functions', '_templates', 'fw9.pdf'),
  ];
  for (const p of candidates) { try { return readFileSync(p); } catch (_) {} }
  throw new Error('W-9 template (fw9.pdf) not found in the function bundle');
}
const W9 = {
  line1: { x: 76, y: 666 }, line2: { x: 76, y: 639 },
  boxes: { individual: 77, c_corp: 184, s_corp: 256, partnership: 328, trust: 392 }, boxRowY: 604.5,
  llcBox: { x: 77, y: 591.5 }, llcCode: { x: 426, y: 591.5 },
  otherBox: { x: 77, y: 554.5 }, otherText: { x: 166, y: 554.5 },
  foreignBox: { x: 441, y: 521.5 },
  address: { x: 76, y: 495 }, city: { x: 76, y: 471 }, requester: { x: 396, y: 496 },
  ssn: { y: 404, xs: [431, 443, 455, 481.5, 497, 523.5, 536.5, 549.5, 562.5] },
  ein: { y: 356, xs: [433, 445, 469, 484.5, 500, 515.5, 531, 546.5, 562] },
  sig: { x: 125, y: 199 }, date: { x: 405, y: 199 },
};
async function _renderW9(form, answers, ctx, signature) {
  const pdf = await PDFDocument.load(loadW9Template(), { ignoreEncryption: true });
  const page = pdf.getPage(0);
  const F = await _fonts(pdf);
  const T = (s, x, y, size, font) => { if (s) page.drawText(String(s), { x, y, size: size || 10, font: font || F.helv, color: INK }); };
  const X = (x, y) => page.drawText('X', { x, y, size: 9, font: F.bold, color: INK });
  T(answers.name, W9.line1.x, W9.line1.y);
  T(answers.businessName, W9.line2.x, W9.line2.y);
  const tc = String(answers.taxClass || '');
  if (W9.boxes[tc] != null) X(W9.boxes[tc], W9.boxRowY);
  if (tc === 'llc') { X(W9.llcBox.x, W9.llcBox.y); T(String(answers.llcClass || '').toUpperCase(), W9.llcCode.x, W9.llcCode.y, 9, F.bold); }
  if (tc === 'other') { X(W9.otherBox.x, W9.otherBox.y); T(answers.otherClass, W9.otherText.x, W9.otherText.y, 8); }
  if (answers.foreignPartners) X(W9.foreignBox.x, W9.foreignBox.y);
  T(answers.address, W9.address.x, W9.address.y);
  T(answers.cityStateZip, W9.city.x, W9.city.y);
  T('SLA Capital', W9.requester.x, W9.requester.y, 8);
  const digits = String(answers.tin || '').replace(/[^0-9]/g, '').slice(0, 9);
  const slots = answers.tinType === 'ein' ? W9.ein : W9.ssn;
  digits.split('').forEach((d, i) => {
    const cx = slots.xs[i]; if (cx == null) return;
    const w = F.helv.widthOfTextAtSize(d, 11);
    page.drawText(d, { x: cx - w / 2, y: slots.y, size: 11, font: F.helv, color: INK });
  });
  if (signature && signature.name) {
    page.drawText(signature.name, { x: W9.sig.x, y: W9.sig.y, size: 13, font: F.sig, color: PLUM });
    page.drawText(_fmtDate(signature.signedAt || new Date().toISOString()), { x: W9.date.x, y: W9.date.y, size: 9.5, font: F.helv, color: INK });
  }
  // Certificate line at the foot of page 1 (the template's own footer sits at y≈20).
  if (signature && signature.name) {
    const bits = ['Electronically signed by ' + signature.name, signature.email, signature.signedAt ? new Date(signature.signedAt).toUTCString() : '', signature.ip ? 'IP ' + signature.ip : '', signature.seal ? 'seal ' + String(signature.seal).slice(0, 12) : '', 'ESIGN consent v' + (signature.consentVersion || ESIGN_CONSENT_VERSION)].filter(Boolean);
    page.drawText(bits.join(' · ').slice(0, 170), { x: 36, y: 30, size: 6.5, font: F.helv, color: MUTED });
  }
  return pdf.save();
}

/**
 * Render the filed PDF. `signature` = { name, email, signedAt, ip, seal, consentVersion }.
 * Returns a Uint8Array.
 */
export async function renderFormPdf(form, { answers, staffValues, ctx, signature, preview }) {
  if (!form) throw new Error('unknown form');
  let bytes;
  if (form.id === 'w9') bytes = await _renderW9(form, answers || {}, ctx, signature);
  else if (form.id === 'commitment_letter') bytes = await _renderCommitmentLetter(form, staffValues || {}, ctx, signature);
  else bytes = await _renderSimpleForm(form, answers || {}, ctx, signature);
  return preview ? _watermarkPreview(bytes) : bytes;
}
// Deploy 236.948 (Mike: "Do the Processors get to see the document before it's
// sent just to make sure it's correct?") — the send panel previews exactly what
// the borrower will get, stamped so a preview can never pass for the filed copy.
async function _watermarkPreview(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    page.drawText('PREVIEW — NOT SENT', { x: width * 0.12, y: height * 0.32, size: 54, font, color: rgb(0.78, 0.5, 0.23), opacity: 0.22, rotate: degrees(32) });
  }
  return pdf.save();
}

/** The filename the tray shows. */
export function filedName(form, ctx, whenIso) {
  const loan = (ctx && ctx.loan) || {}, client = (ctx && ctx.client) || {};
  const who = String(loan.entityName || client.entityName || [client.firstName, client.lastName].filter(Boolean).join(' ') || 'Borrower').trim();
  return (who + ' - ' + form.label + ' - ' + String(whenIso || new Date().toISOString()).slice(0, 10) + '.pdf').replace(/[\\/:*?"<>|]+/g, '-');
}

/** Plain-text version of the commitment letter for the on-screen review before signing. */
export function commitmentLetterText(staffValues, ctx) {
  const loan = (ctx && ctx.loan) || {}, client = (ctx && ctx.client) || {}; const sv = staffValues || {};
  const borrower = String(loan.entityName || loan.vestingEntity || client.entityName || '').trim() ||
    [client.firstName, client.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ') || 'Borrower';
  const address = String(loan.address || '').trim();
  return [
    'Date: ' + _fmtDate(sv.letterDate),
    'To: Borrower, Seller, Listing Agent, and/or Other Interested Parties',
    'Re: Financing commitment for ' + address,
    '',
    'SLA Capital is pleased to confirm its commitment to provide financing to ' + borrower + ' for the property referenced above. Based on our review of the information provided, the loan has been approved to proceed toward closing. The customary lender due diligence and closing requirements are summarized below.',
    '',
    'Borrower: ' + borrower, 'Property: ' + address, 'Loan Program: ' + String(sv.loanProgram || ''),
    'Approved Loan Amount: Up to ' + _money(sv.loanAmount), 'Target Closing Date: ' + _fmtDate(sv.targetCloseDate),
    '',
    'Our lending team is prepared to move forward with this transaction and work toward the target closing date shown above.',
    '',
    'Closing Requirements',
    'This commitment is based on the information currently provided and remains subject to satisfactory completion of customary lender due diligence and closing requirements, including property valuation/appraisal, acceptable title and lien position, insurance, required borrower or entity documentation, funds to close, and execution of final loan documents. A material change to the borrower, property, or transaction may require reevaluation.',
    '',
    'This letter confirms SLA Capital\'s current lending commitment for the transaction described above and is not a substitute for the definitive loan documents executed at closing.',
    '',
    'This commitment is valid through ' + _fmtDate(sv.expirationDate) + ', unless extended by SLA Capital in writing.',
    '',
    'Sincerely,', String(sv.repName || ''), [String(sv.repTitle || ''), 'SLA Capital'].filter(Boolean).join(' | '),
    [String(sv.repPhone || ''), String(sv.repEmail || '')].filter(Boolean).join(' | '),
  ];
}
