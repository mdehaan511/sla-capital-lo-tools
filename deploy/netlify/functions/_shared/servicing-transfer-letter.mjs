/**
 * _shared/servicing-transfer-letter.mjs — Deploy 237.211 (Mike)
 *
 * "Can you add this as a document we can send from the Servicing Tab of a loan that auto
 * fills the appropriate items and asks for input on the items that it can't grab from the
 * loan itself."
 *
 * The document is SLA's NOTICE OF TRANSFER OF LOAN SERVICING (Mike's Word template,
 * reproduced here paragraph for paragraph). It has fifteen blanks. What the platform can
 * fill depends entirely on the loan: the two loans Mike needed it for first are Baseline
 * imports with an entity and an address and NOTHING else — no servicer on file, no
 * borrower name, no borrower email. So the split between "grabbed" and "asked" is decided
 * per loan at prefill time, never assumed, and resolveLetterFields() reports which is which
 * so the form can show the person exactly what it needs from them.
 *
 * ── The one rule ──
 * A notice with a hole in it never leaves. validateLetter() is the gate for preview AND
 * send: every required blank filled, each servicer reachable by at least a phone or an
 * email, dates real. A line whose OPTIONAL value is empty is omitted, never printed blank —
 * there is no code path that can put "[NEW SERVICER NAME]" in front of a borrower.
 *
 * Pure: no stores, no network. The endpoint does the I/O; this file can be run by a test.
 */
import PDFDocument from 'pdfkit';

const PLUM = '#261A36';
const GOLD = '#C8813A';
const TEXT = '#1A1520';
const MUTED = '#7A7488';

/** The lender block at the foot of the letter — from Mike's template, verbatim. */
export const SLA_BLOCK = {
  name: 'Sir Lends A Lot LLC',
  addr1: '707 W Main Ave #31',
  addr2: 'Spokane, WA 99201',
  phone: '509-846-7349',
  email: 'boarding@slacapital.com',
  tagline: 'Your Quest For Funding Ends Here.',
};

/**
 * Every blank in the letter. `required` means the letter cannot go out without it;
 * the two contact pairs are validated as "at least one of" below. The form on Loan
 * Details is drawn from this list, so the two cannot drift.
 */
export const LETTER_FIELDS = [
  { key: 'date',                 label: 'Letter date',                         required: true,  type: 'date' },
  { key: 'borrowerLine',         label: 'Borrower / borrowing entity',         required: true },
  { key: 'dearName',             label: 'Salutation name ("Dear ___:")',       required: true },
  { key: 'loanNumber',           label: 'Loan number',                         required: true },
  { key: 'propertyAddress',      label: 'Property address',                    required: true },
  { key: 'currentServicer',      label: 'Current servicer name',               required: true },
  { key: 'currentServicerPhone', label: 'Current servicer phone',              required: false },
  { key: 'currentServicerEmail', label: 'Current servicer email',              required: false },
  { key: 'newServicer',          label: 'New servicer name',                   required: true },
  { key: 'newServicerAddress',   label: 'New servicer payment / mailing address', required: true, multiline: true },
  { key: 'newServicerPhone',     label: 'New servicer phone',                  required: false },
  { key: 'newServicerEmail',     label: 'New servicer email',                  required: false },
  { key: 'newServicerPortal',    label: 'New servicer online payment portal',  required: false },
  { key: 'transferDate',         label: 'Effective date of transfer',          required: true,  type: 'date' },
  { key: 'nextPaymentDue',       label: 'First payment due to the new servicer', required: true, type: 'date' },
];

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const cleanMulti = (v) => String(v == null ? '' : v).split(/\r?\n/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

/** yyyy-mm-dd → { y, m, d } or null. Parsed by hand: `new Date('2026-10-01')` is UTC
 *  midnight, which prints as September 30 anywhere west of Greenwich. */
export function parseIsoDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "October 1, 2026" — how a date reads in a letter. '' when the input is not a date. */
export function fmtLongDate(iso) {
  const p = parseIsoDate(iso);
  return p ? (MONTHS[p.m - 1] + ' ' + p.d + ', ' + p.y) : '';
}
const pad2 = (n) => (n < 10 ? '0' : '') + n;
export function todayIso(now) {
  const d = now || new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/**
 * The first payment date ON OR AFTER the transfer: "Beginning with your payment due ___".
 * `dueDay` is the day of the month this loan's payment falls on (Baseline carries it as
 * Due_Date; SLA's own convention is the 1st). A due day past the end of a short month
 * lands on that month's last day, the way a servicer would bill it.
 */
export function nextDueOnOrAfter(transferIso, dueDay) {
  const t = parseIsoDate(transferIso);
  if (!t) return '';
  let day = Math.floor(Number(dueDay));
  if (!(day >= 1 && day <= 31)) day = 1;
  let y = t.y, m = t.m;
  for (let i = 0; i < 3; i++) {
    const d = Math.min(day, daysInMonth(y, m));
    if (y > t.y || m > t.m || d >= t.d) return y + '-' + pad2(m) + '-' + pad2(d);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return '';
}

/** A Note Servicer from the Vendors book, by display name. Case and spacing tolerant. */
export function findServicer(servicers, name) {
  const want = clean(name).toLowerCase();
  if (!want) return null;
  return (Array.isArray(servicers) ? servicers : []).find((s) =>
    s && clean(s.company || s.name).toLowerCase() === want) || null;
}

const personName = (c) => (c ? clean((c.firstName || '') + ' ' + (c.lastName || '')) : '');
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

/**
 * Fill what the loan can fill, and say plainly what it could not.
 *
 * @param loan, client           the records
 * @param guarantors             guarantor client records (may be empty)
 * @param servicers              the Note Servicers directory [{name, company, phone, email}]
 * @param fallbackLoanNumber     used when the loan carries no display id of its own
 * @param now                    injectable clock
 * @returns {
 *   fields      every LETTER_FIELDS key, '' where the loan had nothing to offer
 *   asked       keys the person must supply (required + empty, plus unreachable servicers)
 *   dueDay      the day of month payments fall on, for the next-due suggestion
 *   recipients  borrower-side email addresses found on file ([] is common on imports)
 * }
 */
export function resolveLetterFields({ loan, client, guarantors, servicers, fallbackLoanNumber, now }) {
  const l = loan || {}, c = client || {};
  const gs = Array.isArray(guarantors) ? guarantors : [];
  const person = personName(c) || personName(gs[0]);
  const entity = clean(l.entityName || c.entityName);
  const display = clean(c.displayName);
  const raw = (l._baselineRaw && typeof l._baselineRaw === 'object') ? l._baselineRaw : {};

  const current = clean(l.servicerName);
  const curHit = findServicer(servicers, current);

  const rawDue = Math.floor(Number(raw.Due_Date));
  const dueDay = (rawDue >= 1 && rawDue <= 31) ? rawDue : 1;

  const fields = {
    date: todayIso(now),
    // The entity is the borrower of record on a business-purpose loan; a person only
    // when there is no entity. The salutation prefers the person — "Dear HHS Ventures,
    // LLC:" is correct but stiff, so it is the fallback, not the default.
    borrowerLine: entity || person || display,
    dearName: person || entity || display,
    loanNumber: clean(l.slaDisplayId || l.slaNumber || fallbackLoanNumber),
    propertyAddress: clean(l.address),
    currentServicer: current,
    currentServicerPhone: clean(curHit && curHit.phone),
    currentServicerEmail: clean(curHit && curHit.email),
    newServicer: '',
    newServicerAddress: '',
    newServicerPhone: '',
    newServicerEmail: '',
    newServicerPortal: '',
    transferDate: '',
    nextPaymentDue: '',
  };

  const recipients = [];
  [c].concat(gs).forEach((p) => {
    const e = clean(p && p.email).toLowerCase();
    if (isEmail(e) && recipients.indexOf(e) < 0) recipients.push(e);
  });

  return { fields, asked: missingKeys(fields), dueDay, recipients };
}

/** Keys that still need a human. Required blanks, plus a servicer nobody can reach. */
function missingKeys(f) {
  const out = [];
  LETTER_FIELDS.forEach((d) => { if (d.required && !clean(f[d.key])) out.push(d.key); });
  if (!clean(f.currentServicerPhone) && !clean(f.currentServicerEmail)) out.push('currentServicerPhone');
  if (!clean(f.newServicerPhone) && !clean(f.newServicerEmail)) out.push('newServicerPhone');
  return out;
}

/** Normalize whatever the form sent into the exact shape the letter prints. */
export function normalizeLetterFields(input) {
  const src = input || {};
  const out = {};
  LETTER_FIELDS.forEach((d) => {
    out[d.key] = d.multiline ? cleanMulti(src[d.key]).slice(0, 400) : clean(src[d.key]).slice(0, 200);
  });
  return out;
}

/**
 * Why this letter cannot go out yet, as sentences a person can act on. [] = good to go.
 */
export function validateLetter(fields) {
  const f = fields || {};
  const problems = [];
  LETTER_FIELDS.forEach((d) => {
    if (d.required && !clean(f[d.key])) problems.push(d.label + ' is required');
    if (d.type === 'date' && clean(f[d.key]) && !parseIsoDate(f[d.key])) problems.push(d.label + ' is not a valid date');
  });
  if (!clean(f.currentServicerPhone) && !clean(f.currentServicerEmail)) {
    problems.push('Current servicer needs a phone or an email — the borrower is told to contact them before the transfer');
  }
  if (!clean(f.newServicerPhone) && !clean(f.newServicerEmail)) {
    problems.push('New servicer needs a phone or an email — the borrower is told to contact them after the transfer');
  }
  ['currentServicerEmail', 'newServicerEmail'].forEach((k) => {
    if (clean(f[k]) && !isEmail(f[k])) problems.push(LETTER_FIELDS.find((d) => d.key === k).label + ' does not look like an email address');
  });
  if (clean(f.currentServicer) && clean(f.currentServicer).toLowerCase() === clean(f.newServicer).toLowerCase()) {
    problems.push('The new servicer is the same as the current servicer');
  }
  const t = parseIsoDate(f.transferDate), n = parseIsoDate(f.nextPaymentDue);
  if (t && n && (n.y * 10000 + n.m * 100 + n.d) < (t.y * 10000 + t.m * 100 + t.d)) {
    problems.push('The first payment due to the new servicer is before the transfer date');
  }
  return problems;
}

export { isEmail };

/** "Notice of Servicing Transfer - 2113 E 5th Ave.pdf" */
export function letterFilename(fields) {
  const street = clean(fields && fields.propertyAddress).split(',')[0].replace(/\s+(Spokane|[A-Z]{2}\s+\d{5}).*$/, '').trim() || 'loan';
  return ('Notice of Servicing Transfer - ' + street + '.pdf').replace(/[^\w .()'#-]/g, '_');
}

// ── The PDF ─────────────────────────────────────────────────────────────────
// Mike's template, paragraph for paragraph. Runs are [text, bold?] pairs so the inline
// emphasis of the original survives ("is being transferred from **FCI** to **X**").

function letterBody(f) {
  const transfer = fmtLongDate(f.transferDate);
  const nextDue = fmtLongDate(f.nextPaymentDue);
  const B = (t) => [t, true], N = (t) => [t, false];
  const cur = f.currentServicer, nw = f.newServicer;

  // Contact blocks: a line only exists when it has something to say.
  const newBlock = [[B(nw)]];
  f.newServicerAddress.split('\n').forEach((ln) => newBlock.push([N(ln)]));
  if (f.newServicerPhone) newBlock.push([N('Phone: ' + f.newServicerPhone)]);
  if (f.newServicerEmail) newBlock.push([N('Email: ' + f.newServicerEmail)]);
  if (f.newServicerPortal) newBlock.push([N('Online Payment Portal: ' + f.newServicerPortal)]);

  const curBlock = [[B(cur)]];
  if (f.currentServicerPhone) curBlock.push([N('Phone: ' + f.currentServicerPhone)]);
  if (f.currentServicerEmail) curBlock.push([N('Email: ' + f.currentServicerEmail)]);

  return [
    { p: [N('Dear ' + f.dearName + ':')] },
    { p: [N('This letter is to notify you that the servicing of your business-purpose loan originated and/or held by '), B('Sir Lends A Lot LLC'), N(' is being transferred from '), B(cur), N(' to '), B(nw), N('.')] },
    { h: 'Effective Date of Transfer' },
    { p: [N('Effective '), B(transfer), N(', ' + cur + ' will no longer accept payments or service your loan. Beginning on that date, all loan payments and servicing-related correspondence should be directed to:')] },
    { block: newBlock },
    { p: [N('Your new servicer will provide you with any additional information necessary to establish access to its payment portal and manage your loan.')] },
    { h: 'Payment Instructions' },
    { p: [N('Beginning with your payment due '), B(nextDue), N(', please make all payments to '), B(nw), N(' using the payment instructions provided by the new servicer.')] },
    { p: [N('If you have already submitted a payment to ' + cur + ' that has not yet been processed as of the transfer date, the payment will be processed or transferred to the new servicer as appropriate.')] },
    { p: [N('If you currently have automatic payments established with the existing servicer, '), B('do not assume those payment instructions will automatically transfer.'), N(' Please follow the instructions provided by ' + nw + ' to establish or confirm automatic payments.')] },
    { h: 'Your Loan Terms Are Not Changing' },
    { p: [N('This servicing transfer '), B('does not modify the terms of your loan.'), N(' Your outstanding principal balance, interest rate, maturity date, payment obligations, collateral, guarantees, and all other terms and conditions contained in your loan documents remain unchanged unless separately modified in writing.')] },
    { p: [N('Only the party responsible for collecting payments and administering the loan is changing.')] },
    { h: 'Questions Prior to Transfer' },
    { p: [N('For questions regarding your loan before '), B(transfer), N(', please contact:')] },
    { block: curBlock },
    { p: [N('For questions on or after '), B(transfer), N(', please contact '), B(nw), N(' using the contact information above.')] },
    { p: [N('We appreciate your prompt attention to this servicing change. Please update your records and payment instructions accordingly.')] },
  ];
}

/**
 * Build the letter. REFUSES (rejects) on an invalid letter — callers validate first and
 * show the problems; this is the backstop that makes a holed notice impossible.
 *
 * LAYOUT: readable type comes first. The letter is tried on ONE page at full size, then a
 * touch smaller, never below ~9.6pt — past that a notice about where to send money starts
 * to look like fine print. If it still will not fit (Mike's own Word template runs past a
 * page at normal size), it becomes a deliberate TWO-page letter at full size with the
 * break placed before "Questions Prior to Transfer": page two is then a whole section and
 * the signature, never a sign-off sitting alone on an empty sheet.
 * @returns Promise<Buffer>
 */
export function buildTransferLetterPdf(rawFields, opts) {
  const f = normalizeLetterFields(rawFields);
  const problems = validateLetter(f);
  if (problems.length) {
    const err = new Error('Letter is incomplete: ' + problems.join('; '));
    err.problems = problems;
    return Promise.reject(err);
  }
  const ONE_PAGE_SCALES = [1, 0.96, 0.92];
  const attempt = (i) => {
    if (i >= ONE_PAGE_SCALES.length) return renderLetterOnce(f, opts, 1, true).then((r) => r.buffer);
    return renderLetterOnce(f, opts, ONE_PAGE_SCALES[i], false).then((r) => (r.pages > 1 ? attempt(i + 1) : r.buffer));
  };
  return attempt(0);
}

/** The heading a two-page letter breaks before. */
const SECOND_PAGE_STARTS_AT = 'Questions Prior to Transfer';

function renderLetterOnce(f, opts, scale, twoPage) {
  return new Promise((resolve, reject) => {
    try {
      const M = { top: 48, bottom: 46, left: 66, right: 66 };
      const doc = new PDFDocument({
        size: 'LETTER', margins: M,
        compress: !(opts && opts.uncompressed),
        info: { Title: 'Notice of Transfer of Loan Servicing', Author: SLA_BLOCK.name, Subject: f.loanNumber + ' - ' + f.propertyAddress },
      });
      const chunks = [];
      let pages = 1;
      doc.on('pageAdded', () => { pages++; });
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages }));
      doc.on('error', reject);

      const W = doc.page.width - M.left - M.right;
      const SIZE = 10.4 * scale, GAP = 2.1 * scale, PARA = 0.55;
      const LINE = SIZE * 1.16 + GAP;                    // one drawn line, near enough
      const rich = (runs, extra) => {
        runs.forEach((r, i) => {
          doc.font(r[1] ? 'Helvetica-Bold' : 'Helvetica').fontSize(SIZE).fillColor(TEXT)
            .text(r[0], Object.assign({ continued: i < runs.length - 1, lineGap: GAP, width: W }, extra || {}));
        });
      };
      // A contact block is a name and how to reach them. Half of one on each side of a
      // page break reads as two unrelated fragments, so a block that will not fit moves
      // whole. Same for a heading: it never dangles at the foot of a page.
      const keepTogether = (lines) => {
        if (doc.y + lines * LINE > doc.page.height - M.bottom) doc.addPage();
      };
      const pageTwoHeader = () => {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED)
          .text('Notice of Transfer of Loan Servicing  \u00b7  ' + f.loanNumber + '  \u00b7  ' + f.borrowerLine + '  \u00b7  page 2', { width: W });
        doc.moveDown(0.4);
        doc.moveTo(M.left, doc.y).lineTo(M.left + W, doc.y).lineWidth(0.6).strokeColor(GOLD).stroke();
        doc.moveDown(1.2);
      };

      // Letterhead — typographic, so the letter has no image dependency to go missing.
      doc.font('Times-Bold').fontSize(19).fillColor(GOLD).text('SLA CAPITAL', { characterSpacing: 1.5 });
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(SLA_BLOCK.name + '  \u00b7  ' + SLA_BLOCK.addr1 + ', ' + SLA_BLOCK.addr2);
      doc.moveDown(0.5);
      doc.moveTo(M.left, doc.y).lineTo(M.left + W, doc.y).lineWidth(1).strokeColor(GOLD).stroke();
      doc.moveDown(0.9);

      doc.font('Helvetica-Bold').fontSize(13 * scale).fillColor(PLUM).text('NOTICE OF TRANSFER OF LOAN SERVICING', { align: 'center', width: W });
      doc.moveDown(0.75);

      rich([['Date: ', true], [fmtLongDate(f.date), false]]);
      doc.moveDown(0.4);
      rich([['Borrower: ', true], [f.borrowerLine, false]]);
      rich([['Loan Number: ', true], [f.loanNumber, false]]);
      rich([['Property Address: ', true], [f.propertyAddress, false]]);
      doc.moveDown(0.65);

      letterBody(f).forEach((node) => {
        if (node.h) {
          if (twoPage && node.h === SECOND_PAGE_STARTS_AT) { doc.addPage(); pageTwoHeader(); }
          else keepTogether(3.2);
          doc.moveDown(0.15);
          doc.font('Helvetica-Bold').fontSize(SIZE + 0.6).fillColor(PLUM).text(node.h, { width: W, lineGap: GAP });
          doc.moveDown(0.28);
        } else if (node.block) {
          keepTogether(node.block.length + 0.3);
          node.block.forEach((runs) => rich(runs, { indent: 18 }));
          doc.moveDown(PARA);
        } else {
          rich(node.p, { align: 'left' });
          doc.moveDown(PARA);
        }
      });

      // "Sincerely," + the lender block: five lines with the gap. If it cannot stay with
      // the text above it, this attempt has failed as a one-page letter (pages > 1) and
      // the caller falls through to the deliberate two-page layout.
      keepTogether(5);
      doc.moveDown(0.2);
      rich([['Sincerely,', false]]);
      doc.moveDown(0.55);
      rich([[SLA_BLOCK.name, true]]);
      rich([[SLA_BLOCK.addr1 + ', ' + SLA_BLOCK.addr2, false]]);
      rich([[SLA_BLOCK.phone + '  \u00b7  ' + SLA_BLOCK.email, false]]);

      // The tagline is a footer, not a paragraph: pinned to the foot of the last page.
      // The bottom margin is dropped for this one draw so pdfkit does not answer a line
      // placed below it by starting a new page.
      doc.page.margins.bottom = 0;
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(GOLD)
        .text(SLA_BLOCK.tagline, M.left, doc.page.height - 32, { width: W, align: 'center', lineBreak: false });

      doc.end();
    } catch (e) { reject(e); }
  });
}

/** The cover email. Short on purpose: the notice is the attachment, not the email. */
export function buildCoverEmail(f) {
  const street = clean(f.propertyAddress);
  const subject = 'Notice of Transfer of Loan Servicing - ' + f.loanNumber + ' - ' + street.split(',')[0];
  const lines = [
    'Dear ' + f.dearName + ',',
    '',
    'Attached is a Notice of Transfer of Loan Servicing for your loan ' + f.loanNumber + ' on ' + street + '.',
    '',
    'Effective ' + fmtLongDate(f.transferDate) + ', servicing of your loan moves from ' + f.currentServicer + ' to ' + f.newServicer + '. Beginning with your payment due ' + fmtLongDate(f.nextPaymentDue) + ', please make payments to ' + f.newServicer + ' as described in the attached notice.',
    '',
    'The terms of your loan are not changing. If you have any questions, reply to this email or call us at ' + SLA_BLOCK.phone + '.',
    '',
    'Sincerely,',
    SLA_BLOCK.name,
    SLA_BLOCK.phone + ' · ' + SLA_BLOCK.email,
  ];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1A1520;line-height:1.6">' +
    lines.map((ln) => (ln ? '<p style="margin:0 0 10px 0">' + esc(ln) + '</p>' : '')).join('') + '</div>';
  return { subject, text: lines.join('\n'), html };
}
