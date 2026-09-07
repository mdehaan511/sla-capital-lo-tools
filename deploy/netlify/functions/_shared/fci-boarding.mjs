/**
 * _shared/fci-boarding.mjs — Deploy 236.890 (Mike)
 *
 * Fills the FCI Loan Boarding package (Loan Servicing Compliance Form +
 * Foreclosure Prevention Alternatives form) straight from the loan record.
 * FCI's API has no boarding endpoint, so this reproduces the sheet the team
 * fills by hand — same template, values drawn at the exact coordinates the
 * historical PandaDoc packages used (reverse-engineered from the completed
 * Dutch + Non-Dutch samples; the two differ by exactly ONE checkbox).
 *
 * Dutch loans:      "Set up Loan at Full Amount"    + payment on the TOTAL.
 * Non-Dutch loans:  "Set up Loan at initially Disbursed Amount" + payment on
 *                   (total − rehab holdback); Current Principal Balance shows
 *                   the disbursed amount (Dutch leaves it blank, per samples).
 *
 * Signature LINES stay blank — print names are filled, the signing itself is
 * done by humans (or a future eSign envelope).
 *
 * buildFciBoardingPdf(ctx) → { bytes: Uint8Array, missing: string[] }
 *   ctx = { loan, client, guarantors[], sla }
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { FCI_BOARDING_TEMPLATE_B64 } from './fci-boarding-template.mjs';

// ── SLA constants (the Broker/Originator + contact block on page 1). ──────
// These are what every historical boarding sheet carried.
const SLA_BROKER = {
  company: 'Sir Lends A Lot, LLC',
  contact: 'Dan Austin',
  street: '1804 W Westover Ln',
  city: 'Spokane',
  state: 'Washington',
  zip: '99208',
  workPhone: '5094758745',
  email: 'dan@slacapital.com',
  otherContacts: 'mike@slacapital.com, ella@slacapital.com',
  bank: 'Numerica Credit Union',
  taxId: '88-3581729',
  routing: '325182690',
  account: '10102114000106',
};

// ── Lender of record, by funding source. Both historical samples boarded
// under Pacific RBLF Funding Trust (FCI client 210678), so that is the
// default; a loan whose fundingSource names something else gets blank
// lender fields + a line in the missing report for hand-fill.
const LENDERS = [
  {
    match: /pacific|rblf/i,
    isDefault: true,
    acct: '210678',
    company: 'Pacific RBLF Funding Trust',
    first: 'Andres',
    last: 'Pizarro',
    // The FPA page historically says "Lending" — kept verbatim.
    fpaCompany: 'Pacific RBLF Lending Trust',
  },
];

const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
const stateName = (ab) => STATE_NAMES[String(ab || '').toUpperCase()] || String(ab || '');

// ── small helpers (kept local — this module must stand alone) ─────────────
const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : null;
};
const rateFrac = (v) => {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n > 1 ? n / 100 : n;
};
const money2 = (n) => (n == null ? '' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pctStr = (frac) => {
  if (frac == null) return '';
  const p = Math.round(frac * 100000) / 1000; // e.g. 10.875
  return String(p);
};
const dparts = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').slice(0, 10));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
};
const mdY = (v, sep) => { // ISO → MM/DD/YYYY (or MM-DD-YYYY)
  const p = dparts(v);
  if (!p) return '';
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return [pad(p.m), pad(p.d), p.y].join(sep || '/');
};
function parseAddr(addr) {
  const parts = String(addr || '').split(',').map((p) => p.trim()).filter(Boolean);
  const out = { street: parts[0] || '', city: '', state: '', zip: '' };
  for (const p of parts.slice(1)) {
    const m = /^([A-Z]{2})\s*(\d{5})?/.exec(p);
    if (m && p.length <= 12) { out.state = m[1]; if (m[2]) out.zip = m[2]; continue; }
    const z = /^\d{5}(-\d{4})?$/.exec(p);
    if (z) { out.zip = p.slice(0, 5); continue; }
    if (/^(USA|US|United States)$/i.test(p)) continue;
    if (!out.city) out.city = p;
  }
  return out;
}
const uwVal = (loan, key) => {
  const e = loan && loan.uwData && loan.uwData[key];
  const v = e && e.value;
  return (v == null || v === '') ? null : v;
};
// First of (funding month + 2) — FCI's Next Payment Due on both samples.
const firstDueOf = (l) => {
  if (l.firstPaymentDate) return mdY(l.firstPaymentDate);
  const f = dparts(l.fundingDate);
  if (!f) return '';
  let m = f.m + 2, y = f.y;
  if (m > 12) { m -= 12; y += 1; }
  return (m < 10 ? '0' : '') + m + '/01/' + y;
};
// Maturity on the sheet = the loan's maturity, else 1st of the month AFTER
// funding + term (matches both samples: 07/10/26 + 12mo → 08/01/2027).
const maturityOf = (l) => {
  if (l.maturityDate) return mdY(l.maturityDate);
  const f = dparts(l.fundingDate);
  if (!f) return '';
  const t = num(l.term) || 12;
  let m = f.m + t, y = f.y;
  while (m > 12) { m -= 12; y += 1; }
  if (f.d > 1) { m += 1; if (m > 12) { m -= 12; y += 1; } }
  return (m < 10 ? '0' : '') + m + '/01/' + y;
};

export async function buildFciBoardingPdf(ctx) {
  const { loan, client, guarantors, sla } = ctx;
  const missing = [];
  const need = (label, v) => { if (v === '' || v == null) missing.push(label); return v == null ? '' : v; };

  const dutchRaw = String(loan.dutchInterest || '').toLowerCase();
  const dutch = dutchRaw === 'dutch';
  if (!dutchRaw) missing.push('Dutch/Non-Dutch (loan record) — holdback checkbox left blank');

  const total = num(loan.finalLoanAmount) || num(loan.loanAmt);
  const rehab = num(loan.rehabBudget) || 0;
  const disbursed = total != null ? total - rehab : null;
  const noteFrac = rateFrac(loan.rate);
  const soldFrac = rateFrac(loan.soldRate);
  const payBasis = dutch ? total : disbursed;
  const payment = (payBasis != null && noteFrac != null) ? Math.round(payBasis * noteFrac / 12 * 100) / 100 : null;

  const fs = String(loan.fundingSource || '');
  let lender = LENDERS.find((L) => L.match.test(fs)) || (!fs ? LENDERS.find((L) => L.isDefault) : null);
  if (!lender) {
    missing.push('Lender of record ("' + fs + '" is not a known FCI client) — page 1 lender block left blank');
    lender = { acct: '', company: '', first: '', last: '', fpaCompany: '' };
  }

  const prop = parseAddr(loan.address);
  const home = (client && client.homeAddress) || {};
  const g1 = (guarantors && guarantors[0]) || client || {};
  const tin = uwVal(loan, 'entityTin')
    || (((client && client.companies) || []).find((co) => co && co.ein) || {}).ein
    || '';
  const entityName = loan.entityName || (client && client.entityName)
    || (((client && client.firstName) || '') + ' ' + ((client && client.lastName) || '')).trim();
  const today = new Date();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const todayStr = pad(today.getMonth() + 1) + '-' + pad(today.getDate()) + '-' + today.getFullYear();

  const doc = await PDFDocument.load(Buffer.from(FCI_BOARDING_TEMPLATE_B64, 'base64'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const ink = rgb(0.1, 0.1, 0.35); // subtle blue-black, reads as "typed in"

  const text = (pg, x, y, s, size) => {
    if (s === '' || s == null) return;
    pages[pg].drawText(String(s), { x, y, size: size || 9, font, color: ink });
  };
  // Checkbox / radio mark: X centered on the 10×10 mark box the historical
  // packages used (coordinates are the box's lower-left corner).
  const mark = (pg, x, y) => {
    pages[pg].drawText('X', { x: x + 1.8, y: y + 1.6, size: 9, font: bold, color: ink });
  };

  // ── Page 1 — programs, lender, SLA broker block ─────────────────────────
  text(0, 516, 724.5, todayStr);
  [[282.0, 678.6], [485.7, 663.5], [314.7, 620.6], [217.7, 478.9], [101.0, 64.5]]
    .forEach(([x, y]) => mark(0, x, y));
  text(0, 130, 582, need('Lender FCI account #', lender.acct));
  text(0, 402, 582, lender.company);
  text(0, 136, 563, lender.first);
  text(0, 392, 563, lender.last);
  text(0, 108, 234, SLA_BROKER.company);
  text(0, 370, 234, SLA_BROKER.contact);
  text(0, 66, 218, SLA_BROKER.street);
  text(0, 291, 218, SLA_BROKER.city);
  text(0, 438, 216, SLA_BROKER.state);
  text(0, 548, 218, SLA_BROKER.zip);
  text(0, 83, 197, SLA_BROKER.workPhone);
  text(0, 57, 179, SLA_BROKER.email);
  text(0, 323, 179, SLA_BROKER.otherContacts);
  text(0, 132, 84, SLA_BROKER.bank);
  text(0, 427, 67, SLA_BROKER.taxId);
  text(0, 107, 50, SLA_BROKER.routing);
  text(0, 376, 50, SLA_BROKER.account);

  // ── Page 2 — borrower + loan info ───────────────────────────────────────
  text(1, 134, 730.5, need('Borrower entity name', entityName));
  text(1, 335, 730.5, (client && client.email) || '');
  text(1, 510, 730.5, mdY(g1.dob));
  text(1, 380, 713.2, (client && client.phone) || '');
  text(1, 526, 713.2, need('Entity TIN (EIN letter → UW tab)', tin));
  text(1, 110, 696, home.street || '');
  text(1, 330, 696, home.city || '');
  text(1, 451, 696, stateName(home.state));
  text(1, 551, 696, home.zip || '');
  text(1, 126, 501.7, need('Property address', prop.street));
  text(1, 332, 502, prop.city);
  text(1, 445, 502, stateName(prop.state));
  text(1, 556, 502, prop.zip);
  // constant checkboxes (business purpose, secured, income 1-4, vacant,
  // 1st TD, No×4, monthly, short-first-payment No…) — identical on every
  // historical sheet; the ONE per-loan difference is the holdback row.
  [[567.2, 202.0], [358.0, 409.1], [564.5, 260.0], [567.3, 184.3], [191.9, 378.4],
   [24.6, 446.0], [103.1, 586.0], [79.7, 145.8], [228.5, 393.1], [116.3, 627.5],
   [355.6, 481.0], [438.7, 566.8]].forEach(([x, y]) => mark(1, x, y));
  if (dutchRaw) mark(1, dutch ? 250.1 : 403.9, 317.7);
  text(1, 466.5, 280.5, need('Lender Loan Number', sla));
  text(1, 100, 243.7, need('Funding Date', mdY(loan.fundingDate)));
  text(1, 324, 243.7, firstDueOf(loan));
  text(1, 136, 226.5, need('Original Loan Amount', money2(total)));
  if (!dutch && disbursed != null) text(1, 430.5, 226.5, money2(disbursed));
  text(1, 72, 206, '10%'); text(1, 133, 206, '10');
  text(1, 257, 206, '24%'); text(1, 318, 206, '30');
  text(1, 121, 168.7, need('Amount of Payment', money2(payment)));
  text(1, 382, 168.7, money2(payment));
  text(1, 100, 129, need('Maturity Date', maturityOf(loan)));

  // ── Page 3 — rates, fee splits, authorizations, print names ────────────
  text(2, 109, 758.2, need('Note Rate', pctStr(noteFrac)));
  text(2, 316, 758.2, need('SOLD Rate (loan.soldRate)', pctStr(soldFrac)));
  if (noteFrac != null && soldFrac != null) {
    text(2, 509, 758.2, pctStr(Math.round((noteFrac - soldFrac) * 100000) / 100000));
  }
  [[444.6, 740.4], [432.0, 724.6],
   [155.8, 615.8], [108.2, 615.8], [452.5, 615.8], [500.1, 615.8],
   [148.2, 598.1], [195.8, 598.1], [452.5, 596.8], [500.1, 596.8],
   [392.2, 375.2], [122.5, 358.7]].forEach(([x, y]) => mark(2, x, y));
  text(2, 185, 690, '50'); text(2, 266, 690, '50'); text(2, 340, 690, '50');
  text(2, 185, 675, '50'); text(2, 266, 675, '50');
  text(2, 185, 659, '50'); text(2, 266, 659, '50');
  // print names (signature LINES intentionally left blank for real signing)
  text(2, 108, 99.7, (lender.first + ' ' + lender.last).trim());
  text(2, 72, 63, SLA_BROKER.company);
  text(2, 476, 63, SLA_BROKER.contact);

  // ── Page 4 — Foreclosure Prevention Alternatives (Option 1) ────────────
  text(3, 516, 724.5, todayStr);
  text(3, 214, 678, sla);
  text(3, 145, 663.7, lender.fpaCompany);
  text(3, 130.5, 643.5, (lender.first + ' ' + lender.last).trim());
  mark(3, 63.5, 404.5);
  text(3, 70, 60.7, (lender.first + ' ' + lender.last).trim());
  text(3, 388, 63, SLA_BROKER.company);

  const bytes = await doc.save();
  return { bytes, missing };
}
