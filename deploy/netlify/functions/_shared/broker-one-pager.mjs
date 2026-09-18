/**
 * _shared/broker-one-pager.mjs — the broker product one-pager, personalized.
 *
 * Deploy 237.181 (Mike: "make it so the email and phone number fill with the
 * email and phone number of the user that downloads the document ... and at the
 * top if its one of the loan officers have it say Your Loan Officer is {name}").
 *
 * Built at download time (netlify/functions/broker-one-pager.mjs) so the copy a
 * broker receives carries the rep who sent it: their name in the header ribbon,
 * their email and direct line in the footer, and their own apply link + QR so a
 * borrower who scans it lands in THAT rep's pipeline. With no rep (or a rep with
 * no phone on file) every slot falls back to the company contact, so the sheet
 * is always sendable.
 *
 * EVERY PROGRAM NUMBER HERE IS THE PUBLISHED ONE, from the marketing site
 * (~/code/sla-capital-marketing) — the authority for external claims. Portal
 * engine floors are deliberately tighter, so never source this from *-pricing.js.
 * Multifamily 5+ has no public page, so its cells come from the internal
 * guideline matrix (deploy/guidelines-mf.html) and its rate reads "ask".
 *
 * scripts/broker-one-pager.mjs renders the same builder to a file for preview.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import qrcode from 'qrcode';

const _dir = dirname(fileURLToPath(import.meta.url));

// Marketing palette (assets/brand.css), not the portal's.
const PLUM = rgb(0x28 / 255, 0x1d / 255, 0x28 / 255);
const ORANGE = rgb(0xda / 255, 0x72 / 255, 0x38 / 255);
const PEACH = rgb(0xff / 255, 0xbc / 255, 0x7d / 255);
const INK = rgb(0.09, 0.07, 0.10);
const MUTED = rgb(0.42, 0.39, 0.44);
const LINE = rgb(0.88, 0.86, 0.86);
const WASH = rgb(0.972, 0.968, 0.962);
const WHITE = rgb(1, 1, 1);

export const COMPANY = {
  email: 'apply@slacapital.com',
  phone: '(509) 846-7349',
  site: 'slacapital.ai',
  legal1: 'Sir Lends A Lot LLC dba SLA Capital  ·  707 W Main Ave #31, Spokane, WA 99201  ·  NMLS ID #2863552',
  legal2: 'Idaho Mortgage Broker/Lender License #MBL-2082863552  ·  Certified Member, American Association of Private Lenders',
};

export const PRODUCTS = [
  { name: 'Fix & Flip / Bridge', tag: 'RTL · 1-4 unit',
    blurb: 'Purchase plus rehab on one short-term note, with the full rehab budget financed.',
    rows: [
      ['Rates', '9.5% - 12%, 1-4 points'],
      ['Leverage', 'Up to 92.5% LTC and 75% of ARV'],
      ['Credit', '680+ FICO, better terms at 700 and 740'],
      ['Rehab', '100% of the budget, drawn after inspection'],
      ['Term', '6 - 18 months'],
      ['Loan size', '$100K - $3M'],
      ['Speed', 'Close in as little as 72 hours'],
    ] },
  { name: 'New Construction', tag: 'GUC · ground-up',
    blurb: 'Land and vertical build on a single note, with interest only on what you have drawn.',
    rows: [
      ['Rates', 'From 10%'],
      ['Leverage', '85% of land + 85% of construction costs'],
      ['Credit', '680+ FICO'],
      ['Interest', 'Non-Dutch - you pay only on drawn funds'],
      ['Term', '18 or 24 months'],
      ['Loan size', '$100K - $7.5M'],
      ['Approval', 'Unpermitted land is eligible'],
    ] },
  { name: 'DSCR Rental', tag: '1-4 unit · 30-year',
    blurb: 'Long-term rental financing qualified on the property’s income, not the borrower’s.',
    rows: [
      ['Rates', 'From 6.75%'],
      ['Leverage', 'Up to 80% LTV purchase and rate/term, 75% cash-out'],
      ['Credit', '660+ FICO, 660-679 by pre-approval'],
      ['Structures', '30-yr fixed, 5-yr IO, 5/1 ARM, 7/1 ARM'],
      ['Qualifying', '1.00 DSCR minimum, no lease required'],
      ['Cash-out', 'Up to 75% LTV, 6-month seasoning'],
      ['Loan size', '$100K - $3M, portfolios of 2-10 on one note'],
    ] },
  { name: 'Multifamily DSCR', tag: '5+ units',
    blurb: 'Stabilized 5-30 unit apartments, underwritten on in-place net cash flow.',
    rows: [
      ['Rates', 'Ask your rep for current pricing'],
      ['Leverage', 'Up to 74.99% LTV purchase and refinance'],
      ['Credit', '700+ FICO'],
      ['Qualifying', '1.20x NCF DSCR in top and standard markets'],
      ['Structures', '30-yr fixed and ARM, interest-only available'],
      ['Loan size', '$350K - $5M'],
      ['Property', '5-30 units, $500K min value, $75K avg / unit'],
    ] },
];

// Licensing exclusions are company-wide (guidelines.html "Eligible States &
// Licensing"); IL / Newark / rural are the Colchis RTL + GUC overlay, and Idaho
// is excluded on Multifamily only (guidelines-mf.html).
const FOOTPRINT_LEAD = 'Where we lend:';
const FOOTPRINT = 'Nationwide except AZ, CA, MN, ND, NV, SD, UT, VT and US territories.  '
  + 'Fix & Flip and New Construction also exclude IL, the city of Newark NJ, and rural (RUCA) properties.  '
  + 'Multifamily 5+ also excludes ID.';

const WHY = [
  ['Term sheet in minutes', 'Our sizer prices the deal up front - rate, points, leverage and reserves.'],
  ['Draws that keep pace', 'Same-day draw approvals when the photos and invoices are clean.'],
  ['No app or appraisal fee', 'Nothing out of pocket to get a real quote and get under contract.'],
  ['Apply in one scan', 'The QR opens an application that routes straight to your rep.'],
];

/** The light wordmark, for the dark header band. Never fatal — no logo, no header image. */
export function loadLightLogo() {
  const names = ['sla-logo-light.png'];
  for (const n of names) {
    for (const p of [
      join(_dir, '..', '_templates', n),
      join(_dir, '_templates', n),
      join(process.cwd(), 'netlify', 'functions', '_templates', n),
      join(process.cwd(), 'deploy', 'netlify', 'functions', '_templates', n),
    ]) { try { return readFileSync(p); } catch (_) {} }
  }
  return null;
}

/**
 * QR modules for the given text, via the qrcode package (a hand-rolled encoder
 * is not worth the risk of a code that will not scan). Returns { size, dark(x,y) }.
 */
function qrMatrix(text) {
  try {
    const qr = qrcode.create(String(text), { errorCorrectionLevel: 'M' });
    const { size, data } = qr.modules;
    return { size, dark: (x, y) => data[y * size + x] === 1 };
  } catch (e) {
    console.warn('[broker-one-pager] QR failed (non-fatal):', e && e.message);
    return null;
  }
}

/**
 * Render the sheet. `rep` = { name, email, phone, applyUrl } — any field may be
 * blank and falls back to the company contact.
 */
export async function buildBrokerOnePager(rep = {}) {
  const repName = String(rep.name || '').trim();
  const email = String(rep.email || '').trim() || COMPANY.email;
  const phone = String(rep.phone || '').trim() || COMPANY.phone;
  const applyUrl = String(rep.applyUrl || '').trim() || ('https://' + COMPANY.site + '/apply/');

  const pdf = await PDFDocument.create();
  pdf.setTitle('SLA Capital - Investor Lending Programs');
  pdf.setAuthor('Sir Lends A Lot LLC dba SLA Capital');
  pdf.setSubject('Broker product guide: Fix & Flip, New Construction, DSCR, Multifamily 5+');
  const page = pdf.addPage([612, 792]); // 8.5 x 11 inches
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const obl = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const text = (s, x, y, size, font, color, opts = {}) =>
    page.drawText(String(s), { x, y, size, font, color, ...opts });
  const wrap = (s, x, y, size, font, color, maxW, lead = 1.32) => {
    const words = String(s).split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) {
        text(line, x, y, size, font, color); y -= size * lead; line = w;
      } else line = test;
    }
    if (line) { text(line, x, y, size, font, color); y -= size * lead; }
    return y;
  };

  // ── Header band ───────────────────────────────────────────────
  // Deploy 237.181 -- the rep line rides IN the header band: naming the rep costs
  // no body height, so the cards keep their room.
  const H = repName ? 108 : 96;
  page.drawRectangle({ x: 0, y: 792 - H, width: 612, height: H, color: PLUM });
  page.drawRectangle({ x: 0, y: 792 - H - 4, width: 612, height: 4, color: ORANGE });
  const logoBytes = loadLightLogo();
  if (logoBytes) {
    const logo = await pdf.embedPng(logoBytes);
    const logoH = 50, logoW = (logo.width / logo.height) * logoH;
    page.drawImage(logo, { x: 40, y: 792 - H + (H - logoH) / 2, width: logoW, height: logoH });
  }
  const hTitle = 'INVESTOR LENDING PROGRAMS';
  text(hTitle, 612 - 40 - bold.widthOfTextAtSize(hTitle, 13), 792 - 42, 13, bold, WHITE, { characterSpacing: 1.6 });
  const sub = 'Broker & partner product guide';
  text(sub, 612 - 40 - reg.widthOfTextAtSize(sub, 10.5), 792 - 60, 10.5, reg, PEACH);
  if (repName) {
    const ribbon = 'Your Loan Officer is ' + repName + '!';
    const rs = bold.widthOfTextAtSize(ribbon, 11.5) > 300 ? 10 : 11.5;
    text(ribbon, 612 - 40 - bold.widthOfTextAtSize(ribbon, rs), 792 - 82, rs, bold, ORANGE);
  }

  let y = 792 - H - 30;
  text('Four programs, one lender, one process.', 40, y, 13, bold, INK);
  y -= 15;
  wrap('We fund business-purpose real estate loans nationwide. Send us the deal and you get a real term sheet the same day - '
    + 'with the leverage, rate and reserve requirement spelled out before your borrower is under contract.',
    40, y, 9.5, reg, MUTED, 532);

  // ── Product cards (2 x 2) ─────────────────────────────────────
  const M = 40, GUT = 14;
  const CW = (612 - M * 2 - GUT) / 2;
  // The rep ribbon costs 34pt, so the cards give it back rather than push the
  // why-strip into the footer.
  const CH = repName ? 176 : 182;
  const top = 792 - H - 78;
  PRODUCTS.forEach((p, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + col * (CW + GUT);
    const yTop = top - row * (CH + GUT);
    page.drawRectangle({ x, y: yTop - CH, width: CW, height: CH, color: WHITE, borderColor: LINE, borderWidth: 1 });
    page.drawRectangle({ x, y: yTop - 32, width: CW, height: 32, color: PLUM });
    text(p.name, x + 12, yTop - 16, 12.5, bold, WHITE);
    const tw = reg.widthOfTextAtSize(p.tag, 8.5);
    text(p.tag, x + CW - 12 - tw, yTop - 15, 8.5, reg, PEACH);
    let cy = yTop - 47;
    cy = wrap(p.blurb, x + 12, cy, 8.8, obl, MUTED, CW - 24);
    cy -= 3;
    const labelW = 58;
    p.rows.forEach((r) => {
      text(r[0], x + 12, cy, 8.5, bold, ORANGE);
      const after = wrap(r[1], x + 12 + labelW, cy, 8.8, reg, INK, CW - 24 - labelW);
      cy = Math.min(cy - 12.4, after - 1.5);
    });
  });

  // ── Lending footprint ─────────────────────────────────────────
  const fpTop = top - 2 * (CH + GUT) - 4;
  const fpH = 40;
  page.drawRectangle({ x: M, y: fpTop - fpH, width: 612 - M * 2, height: fpH, color: rgb(1, 0.965, 0.93), borderColor: PEACH, borderWidth: 1 });
  text(FOOTPRINT_LEAD, M + 12, fpTop - 16, 8.5, bold, ORANGE);
  const fpX = M + 12 + bold.widthOfTextAtSize(FOOTPRINT_LEAD, 8.5) + 6;
  wrap(FOOTPRINT, fpX, fpTop - 16, 8.2, reg, INK, 612 - M * 2 - 24 - (fpX - M - 12), 1.34);

  // ── Why partner strip, with the apply QR on the right ─────────
  const wyTop = fpTop - fpH - 12;
  const wyH = 92;
  page.drawRectangle({ x: M, y: wyTop - wyH, width: 612 - M * 2, height: wyH, color: WASH, borderColor: LINE, borderWidth: 1 });
  text('WHY BROKERS SEND US DEALS', M + 12, wyTop - 17, 8.5, bold, PLUM, { characterSpacing: 1.2 });
  const qr = qrMatrix(applyUrl);
  const qrBox = qr ? 84 : 0;   // includes the 4-module quiet zone
  const colsW = 612 - M * 2 - 24 - (qrBox ? qrBox + 14 : 0);
  const colW = colsW / WHY.length;
  WHY.forEach((w, i) => {
    const x = M + 12 + i * colW;
    text(w[0], x, wyTop - 34, 8.6, bold, INK);
    wrap(w[1], x, wyTop - 45, 7.5, reg, MUTED, colW - 10, 1.3);
  });
  if (qr) {
    // A QR needs a 4-module quiet zone or scanners will not find it at all.
    const px = qrBox / (qr.size + 8);
    const quiet = px * 4;
    const qx = 612 - M - 12 - qrBox + quiet, qy = wyTop - wyH + 11 + quiet;
    page.drawRectangle({ x: qx - quiet, y: qy - quiet, width: qrBox, height: qrBox, color: WHITE });
    for (let gy = 0; gy < qr.size; gy++) {
      for (let gx = 0; gx < qr.size; gx++) {
        if (!qr.dark(gx, gy)) continue;
        page.drawRectangle({ x: qx + gx * px, y: qy + (qr.size - 1 - gy) * px, width: px, height: px, color: PLUM });
      }
    }
  }

  // ── Footer ────────────────────────────────────────────────────
  const fy = 54;
  page.drawLine({ start: { x: M, y: fy + 34 }, end: { x: 612 - M, y: fy + 34 }, thickness: 1, color: LINE });
  const contact = (repName ? repName + '  ·  ' : 'Submit a deal:  ') + email + '   ·   ' + phone + '   ·   ' + COMPANY.site;
  text(contact, (612 - bold.widthOfTextAtSize(contact, 10)) / 2, fy + 18, 10, bold, PLUM);
  text(COMPANY.legal1, (612 - reg.widthOfTextAtSize(COMPANY.legal1, 7.4)) / 2, fy + 2, 7.4, reg, MUTED);
  text(COMPANY.legal2, (612 - reg.widthOfTextAtSize(COMPANY.legal2, 7.4)) / 2, fy - 9, 7.4, reg, MUTED);
  const asOf = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const disc = 'For business-purpose real estate loans only; not for consumer or owner-occupied use. Terms are indicative and subject to underwriting, '
    + 'valuation and final approval. This is not a commitment to lend. Rates and terms current as of ' + asOf + ' and subject to change.';
  wrap(disc, M, fy - 24, 6.8, reg, MUTED, 612 - M * 2, 1.35);

  return pdf.save();
}
