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
import { PDFDocument, StandardFonts, PDFName } from 'pdf-lib';
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
  // Deploy 236.914 (Mike) — term from servicing `term`, else Loan Terms
  // `loanTerm`, else the sizer's formData.loanTerm bucket (13 = "13 – 18
  // months" → 18, 19 = "19 – 24 months" → 24), else 12.
  const fdT = num(l.formData && l.formData.loanTerm);
  const t = num(l.term) || num(l.loanTerm)
    || (fdT === 13 ? 18 : fdT === 19 ? 24 : fdT) || 12;
  let m = f.m + t, y = f.y;
  while (m > 12) { m -= 12; y += 1; }
  if (f.d > 1) { m += 1; if (m > 12) { m -= 12; y += 1; } }
  return (m < 10 ? '0' : '') + m + '/01/' + y;
};

// ── Deploy 236.892 (Mike) — EVERY blank on the form is fillable, not just
// the pre-filled ones. These are the template's own field underlines and
// printed checkbox/radio positions, extracted from the form's vector
// geometry (scratchpad pdf_geom.py + gen_blank_fields.py — regenerate from
// the template if FCI ever revises the form). At build time each entry
// becomes an empty text field / unchecked checkbox UNLESS a pre-filled
// field already covers that spot.
// BLANK_LINES: [page(1-based), x, y, width] of a field underline.
const BLANK_LINES = [
  [1,515.1,720.1,74.1], [1,127,577.8,121.1], [1,399.8,577.8,188.9], [1,133.4,559.6,182],
  [1,389.6,559.6,199.1], [1,93,541.3,186.5], [1,306.9,541.3,98.9], [1,546.9,541.3,41.8],
  [1,433.8,537.8,93.4], [1,81.4,519.6,138.5], [1,467.6,519.6,121.1], [1,366.3,518.7,68],
  [1,231.8,497.9,84.1], [1,504.6,497.9,84.1], [1,387.7,497.3,84.1], [1,77.6,496.7,84.1],
  [1,499.2,478.4,89.5], [1,72,438.8,144.5], [1,282.2,438.8,144.5], [1,541.3,438.8,47.4],
  [1,63.1,424.3,76.1], [1,161.1,424.3,31.6], [1,251.2,424.3,65.3], [1,359.8,424.3,228.9],
  [1,71.7,405.4,144.5], [1,281.9,405.4,144.5], [1,541,405.4,47.4], [1,62.8,390.9,76.1],
  [1,161.1,390.9,31.2], [1,251.2,390.9,65.3], [1,359.3,390.9,229.1],
  [1,121.8,324.4,156.5], [1,103.3,307.5,175], [1,384.9,307.5,203.8],
  [1,105.3,230.3,193.1], [1,367.9,230.3,219.7], [1,64,214.2,198.8], [1,288.5,214.2,111.9],
  [1,545.8,214.2,41.8], [1,432.7,210.7,92.7], [1,78.1,191.1,84.1], [1,232.3,191.1,84.1],
  [1,388.2,191.1,84.1], [1,505.1,191.1,84.1], [1,54.7,175,154.2], [1,320.7,175,266.8],
  [1,139.9,130.7,80.9], [1,380.8,130.7,161.1], [1,129.5,80.2,458.1],
  [1,424.6,63.2,163], [1,104.7,46.2,177.6], [1,373.3,46.2,214.3], [2,331.3,727.6,141.9],
  [2,113.2,727.4,185.8], [2,504,726.9,82.3], [2,521.8,711.1,67.3], [2,76.5,707.6,88.3],
  [2,222.8,707.6,88.3], [2,373,707.6,88.3], [2,97.5,691.2,184.3], [2,312.2,691.2,95.2],
  [2,547.3,691.2,41.8], [2,434.2,687.7,92.7], [2,504,671.7,82.3], [2,83.2,671.3,239],
  [2,389.2,670.8,82.5], [2,101.2,499.3,196.3], [2,322.4,499.3,85.6], [2,547.3,499.3,41.8],
  [2,434.2,495.9,92.7], [2,511.7,480.7,77.4], [2,481.1,427.9,111.5], [2,180.9,361.6,149.4],
  [2,458.7,361.6,132.1], [2,360.3,358.1,68.5], [2,215.5,338.8,114.8], [2,458.7,338.8,132.1],
  [2,360.3,335.4,68.5], [2,254.8,298.1,89.3], [2,496.1,298.1,95.3], [2,195,278.8,126.4],
  [2,450.5,278.8,140.9], [2,136.4,259.6,98.1], [2,330.6,259.6,86.9], [2,85.4,240.1,72.5],
  [2,312.7,240.1,72.5], [2,518.3,240.1,72.5], [2,126.3,220.9,168.5], [2,411.3,220.9,179.5],
  [2,69.6,201.6,36.8], [2,130.7,201.6,23], [2,254.6,201.6,36.8], [2,315.7,201.6,23],
  [2,114.7,164.7,68.5], [2,265,164.7,70.8], [2,368.4,164.7,57.8], [2,457.2,164.7,53.9],
  [2,539.3,164.7,51.5], [2,239.4,145.4,169.5], [2,521.9,145.4,68.9], [2,88.7,125.9,121.9],
  [2,443.4,125.9,147.4], [2,201.7,106.7,79.5], [2,455.5,106.7,115.4], [2,201.7,88,79.5],
  [2,409.5,88,161.4], [2,178.5,72,79], [2,432.2,72,54.6], [2,516.2,72,54.7],
  [3,107.2,754.7,34.4], [3,312.4,754.7,34.8], [3,505.7,754.7,29], [3,402.6,686.9,181.9],
  [3,170.5,686.7,35.6], [3,252.3,686.7,36.5], [3,325,686.7,37.1], [3,328.8,671.2,255.7],
  [3,170.5,671,35.6], [3,252.3,671,36.5], [3,330.1,655.4,254.4], [3,170.5,655.2,35.6],
  [3,252.3,655.2,36.5], [3,242.6,374.8,87.6], [3,22.5,126.4,252],
  [3,333.3,126.4,255.4], [3,22.5,94.2,252], [3,333.3,94.2,255.4], [3,22.5,58.4,179.4],
  [3,215.9,58.4,179.4], [3,409.2,58.4,179.5], [4,512.2,717.3,64.5], [4,202.7,675.9,360.2],
  [4,133.7,658.1,429.2], [4,118,640.2,444.9],
  [4,36.5,89.9,252], [4,323.5,89.9,252], [4,36.5,55.7,252],
  [4,323.5,55.7,252],
];
// BLANK_MARKS: [page(1-based), x, y, size] of a printed checkbox/radio.
const BLANK_MARKS = [
  [1,282.2,678.9,9.5], [1,455.4,678.9,9.5], [1,392.7,663.7,9.5], [1,485.9,663.7,9.5], [1,322.7,637.9,9.5],
  [1,451.3,637.9,9.5], [1,315,620.9,9.5], [1,460.5,620.9,9.5], [1,217.9,479.1,9.5], [1,259.5,478.9,9.5],
  [1,52.4,343.6,9.5], [1,396.9,325,9.5], [1,487.9,325,9.5], [1,52.4,273.1,9.5], [1,101.3,64.7,9.5],
  [1,171.9,63.1,9.5], [2,116.5,627.8,9.5], [2,372.3,627.8,9.5], [2,103.3,586.3,9.5], [2,243.9,586.3,9.5],
  [2,164.8,567.1,9.5], [2,290.4,567.1,9.5], [2,439,567.1,9.5], [2,24.9,550.7,9.5], [2,124.2,550.7,9.5],
  [2,207.3,550.7,9.5], [2,252.4,550.7,9.5], [2,333.5,550.7,9.5], [2,412.4,550.7,9.5], [2,486.6,550.7,9.5],
  [2,24.9,534.3,9.5], [2,470,481.1,10], [2,203.2,481,10], [2,296.6,481,10], [2,355.6,481,10],
  [2,408.8,481,10], [2,24.6,446,10], [2,104.6,446,10], [2,184.9,446,10], [2,239.9,446,10],
  [2,297,446,10], [2,355.2,446,10], [2,437.5,446,10], [2,484.4,446,10], [2,544,446,10],
  [2,24.6,428.3,10], [2,104.6,428.3,10], [2,184.9,428.3,10], [2,297.2,428.3,10], [2,355.2,428.3,10],
  [2,437.5,428.3,10], [2,311.6,409.3,9.5], [2,358.2,409.3,9.5], [2,182.1,393.4,9.5], [2,228.7,393.4,9.5],
  [2,446.1,393.4,9.5], [2,492.7,393.4,9.5], [2,145.5,378.6,9.5], [2,192.1,378.6,9.5], [2,250.4,318,9.5],
  [2,404.1,318,9.5], [2,518.1,260.2,9.5], [2,564.7,260.2,9.5], [2,520.8,202.3,9.5], [2,567.4,202.3,9.5],
  [2,520.9,184.6,9.5], [2,567.5,184.6,9.5], [2,80,146.1,9.5], [2,200.8,146.1,9.5], [2,137.6,145.8,9.5],
  [3,444.9,740.6,9.5], [3,510.4,740.6,9.5], [3,383.5,724.8,9.5], [3,432.3,724.8,9.5], [3,108.2,615.8,10],
  [3,155.8,615.8,10], [3,204.2,615.8,10], [3,452.5,615.8,10], [3,500.1,615.8,10], [3,548.5,615.8,10],
  [3,148.2,598.1,10], [3,195.8,598.1,10], [3,244.2,598.1,10], [3,452.5,596.8,10], [3,500.1,596.8,10],
  [3,548.5,596.8,10], [3,392.4,375.5,9.5], [3,504.9,375.5,9.5], [3,19.9,359,9.5], [3,122.8,359,9.5],
  [3,395.9,359,9.5], [3,448.6,359,9.5], [3,20.1,341.3,9.5], [4,59.9,404.2,10], [4,59.9,361.6,10],
  [4,60.1,291.5,10], [4,60.1,272.5,10], [4,60.1,253.5,10], [4,60.1,234.4,10], [4,60.1,215.4,10],
  [4,60.1,196.4,10], [4,60.1,177.4,10], [4,60.1,158.4,10], [4,60.1,139.4,10],
];

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
  const pages = doc.getPages();

  // Deploy 236.891 (Mike) — every value is a real AcroForm field, pre-filled
  // but EDITABLE/clickable in any PDF viewer before printing, and blanks the
  // platform can't fill are empty typeable fields. Checkboxes are toggleable.
  const form = doc.getForm();
  let seq = 0;
  // Widgets must be TRANSPARENT — pdf-lib's default white background paints
  // over the template's printed labels wherever a field rect grazes one.
  const clearBg = (f) => {
    f.acroField.getWidgets().forEach((w) => {
      const ac = w.getAppearanceCharacteristics && w.getAppearanceCharacteristics();
      if (ac && ac.dict) { ac.dict.delete(PDFName.of('BG')); ac.dict.delete(PDFName.of('BC')); }
    });
  };
  // Debug aid: FCI_DEBUG_FIELDS=1 renders every widget with a visible tint
  // so field coverage can be eyeballed on a rendered PNG. Never set in prod.
  const debug = typeof process !== 'undefined' && process.env && process.env.FCI_DEBUG_FIELDS === '1';
  const used = [];
  const overlaps = (pg, x, y, w, h) => used.some((u) =>
    u.pg === pg && x < u.x + u.w && u.x < x + w && y < u.y + u.h && u.y < y + h);
  const text = (pg, x, y, s, w) => {
    const f = form.createTextField('fci.f' + (++seq));
    f.addToPage(pages[pg], {
      x, y: y - 3.5, width: w || 140, height: 14.5,
      borderWidth: 0,
    });
    if (!debug) clearBg(f);
    if (s !== '' && s != null) f.setText(String(s));
    f.setFontSize(9);
    used.push({ pg, x, y: y - 3.5, w: w || 140, h: 14.5 });
  };
  // Checkbox / radio mark over the form's printed box (coordinates are the
  // 10×10 box's lower-left corner). Unchecked boxes stay invisible widgets.
  const checkboxes = [];
  const mark = (pg, x, y, checked) => {
    const cb = form.createCheckBox('fci.c' + (++seq));
    cb.addToPage(pages[pg], { x: x - 0.5, y: y - 0.5, width: 11, height: 11, borderWidth: 0 });
    if (!debug) clearBg(cb);
    if (checked !== false) cb.check();
    checkboxes.push(cb);
    used.push({ pg, x: x - 0.5, y: y - 0.5, w: 11, h: 11 });
  };

  // ── Page 1 — programs, lender, SLA broker block ─────────────────────────
  text(0, 516, 724.5, todayStr, 70);
  [[282.0, 678.6], [485.7, 663.5], [314.7, 620.6], [217.7, 478.9], [101.0, 64.5]]
    .forEach(([x, y]) => mark(0, x, y));
  text(0, 130, 582, need('Lender FCI account #', lender.acct), 115);
  text(0, 402, 582, lender.company, 180);
  text(0, 136, 563, lender.first, 120);
  text(0, 392, 563, lender.last, 160);
  text(0, 108, 234, SLA_BROKER.company, 165);
  text(0, 370, 234, SLA_BROKER.contact, 175);
  text(0, 66, 218, SLA_BROKER.street, 165);
  text(0, 291, 218, SLA_BROKER.city, 105);
  text(0, 438, 216, SLA_BROKER.state, 80);
  text(0, 548, 218, SLA_BROKER.zip, 45);
  text(0, 83, 197, SLA_BROKER.workPhone, 90);
  text(0, 57, 179, SLA_BROKER.email, 155);
  text(0, 323, 179, SLA_BROKER.otherContacts, 230);
  text(0, 132, 84, SLA_BROKER.bank, 175);
  text(0, 427, 67, SLA_BROKER.taxId, 120);
  text(0, 107, 50, SLA_BROKER.routing, 135);
  text(0, 376, 50, SLA_BROKER.account, 170);

  // ── Page 2 — borrower + loan info ───────────────────────────────────────
  text(1, 134, 730.5, need('Borrower entity name', entityName), 180);
  text(1, 335, 730.5, (client && client.email) || '', 140);
  text(1, 510, 730.5, mdY(g1.dob), 70);
  text(1, 380, 713.2, (client && client.phone) || '', 105);
  text(1, 526, 713.2, need('Entity TIN (EIN letter → UW tab)', tin), 70);
  text(1, 110, 696, home.street || '', 175);
  text(1, 330, 696, home.city || '', 100);
  text(1, 451, 696, stateName(home.state), 85);
  text(1, 551, 696, home.zip || '', 45);
  text(1, 126, 501.7, need('Property address', prop.street), 180);
  text(1, 332, 502, prop.city, 95);
  text(1, 445, 502, stateName(prop.state), 90);
  text(1, 556, 502, prop.zip, 45);
  // constant checkboxes (business purpose, secured, income 1-4, vacant,
  // 1st TD, No×4, monthly, short-first-payment No…) — identical on every
  // historical sheet; the ONE per-loan difference is the holdback row.
  [[567.2, 202.0], [358.0, 409.1], [564.5, 260.0], [567.3, 184.3], [191.9, 378.4],
   [24.6, 446.0], [103.1, 586.0], [79.7, 145.8], [228.5, 393.1], [116.3, 627.5],
   [355.6, 481.0], [438.7, 566.8]].forEach(([x, y]) => mark(1, x, y));
  // Both holdback options are toggleable; the right one starts checked.
  mark(1, 250.1, 317.7, dutchRaw ? dutch : false);
  mark(1, 403.9, 317.7, dutchRaw ? !dutch : false);
  text(1, 466.5, 280.5, need('Lender Loan Number', sla), 125);
  text(1, 100, 243.7, need('Funding Date', mdY(loan.fundingDate)), 75);
  text(1, 324, 243.7, firstDueOf(loan), 80);
  text(1, 136, 226.5, need('Original Loan Amount', money2(total)), 130);
  text(1, 430.5, 226.5, (!dutch && disbursed != null) ? money2(disbursed) : '', 130);
  text(1, 72, 206, '10%', 32); text(1, 133, 206, '10', 25);
  text(1, 257, 206, '24%', 32); text(1, 318, 206, '30', 25);
  text(1, 121, 168.7, need('Amount of Payment', money2(payment)), 90);
  text(1, 382, 168.7, money2(payment), 90);
  text(1, 100, 129, need('Maturity Date', maturityOf(loan)), 120);

  // ── Page 3 — rates, fee splits, authorizations, print names ────────────
  text(2, 109, 758.2, need('Note Rate', pctStr(noteFrac)), 45);
  text(2, 316, 758.2, need('SOLD Rate (loan.soldRate)', pctStr(soldFrac)), 42);
  text(2, 509, 758.2, (noteFrac != null && soldFrac != null)
    ? pctStr(Math.round((noteFrac - soldFrac) * 100000) / 100000) : '', 40);
  [[444.6, 740.4], [432.0, 724.6],
   [155.8, 615.8], [108.2, 615.8], [452.5, 615.8], [500.1, 615.8],
   [148.2, 598.1], [195.8, 598.1], [452.5, 596.8], [500.1, 596.8],
   [392.2, 375.2], [122.5, 358.7]].forEach(([x, y]) => mark(2, x, y));
  text(2, 185, 690, '50', 28); text(2, 266, 690, '50', 28); text(2, 340, 690, '50', 28);
  text(2, 185, 675, '50', 28); text(2, 266, 675, '50', 28);
  text(2, 185, 659, '50', 28); text(2, 266, 659, '50', 28);
  // print names (signature LINES intentionally left blank for real signing)
  text(2, 108, 99.7, (lender.first + ' ' + lender.last).trim(), 160);
  text(2, 72, 63, SLA_BROKER.company, 155);
  text(2, 476, 63, SLA_BROKER.contact, 130);

  // ── Page 4 — Foreclosure Prevention Alternatives (Option 1) ────────────
  text(3, 516, 724.5, todayStr, 70);
  text(3, 214, 678, sla, 200);
  text(3, 145, 663.7, lender.fpaCompany, 220);
  text(3, 130.5, 643.5, (lender.first + ' ' + lender.last).trim(), 180);
  mark(3, 63.5, 404.5);
  text(3, 70, 60.7, (lender.first + ' ' + lender.last).trim(), 170);
  text(3, 388, 63, SLA_BROKER.company, 175);

  // ── Deploy 236.892 — every remaining blank becomes an empty fillable
  // field; every remaining printed checkbox becomes a toggleable one.
  // (Skips spots a pre-filled field already covers.)
  BLANK_LINES.forEach(([p, x, y, w]) => {
    if (overlaps(p - 1, x, y - 1, w, 13)) return;
    text(p - 1, x + 2, y + 3, '', Math.max(w - 4, 12));
  });
  BLANK_MARKS.forEach(([p, x, y, s]) => {
    if (overlaps(p - 1, x, y, s, s)) return;
    mark(p - 1, x + s / 2 - 5, y + s / 2 - 5, false);
  });

  form.updateFieldAppearances(font);

  // pdf-lib paints checkbox OFF states with an opaque background that erases
  // the form's printed circles/squares underneath. Point every Off state at
  // one shared EMPTY appearance so unchecked widgets are truly invisible.
  if (!debug) {
    const emptyAp = doc.context.register(
      doc.context.stream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 11, 11] })
    );
    const OFF = PDFName.of('Off');
    checkboxes.forEach((cb) => {
      cb.acroField.getWidgets().forEach((w) => {
        const ap = w.dict.lookup(PDFName.of('AP'));
        if (!ap) return;
        [PDFName.of('N'), PDFName.of('D')].forEach((k) => {
          const st = ap.lookup(k);
          if (st && st.set && st.lookup && st.lookup(OFF)) st.set(OFF, emptyAp);
        });
      });
    });
  }

  const bytes = await doc.save();
  return { bytes, missing };
}
