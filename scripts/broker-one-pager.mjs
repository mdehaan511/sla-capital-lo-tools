/**
 * scripts/broker-one-pager.mjs — broker-facing product one-pager (8.5x11 PDF)
 *
 * Mike, 2026-09-18: "a quick one pager PDF that looks at our products for RTL,
 * DSCR, GUC, and 5+ MF that I can send to brokers ... branded and have our
 * appropriate company info on it."
 *
 * EVERY NUMBER HERE IS THE PUBLISHED ONE. The three consumer-facing programs
 * come from the marketing site (~/code/sla-capital-marketing), which is the
 * authority for external claims -- portal engine floors are deliberately
 * tighter than the advertised ones, so never source this from *-pricing.js:
 *   Fix & Flip      /fix-n-flip/     DSCR  /rental/     New Construction  /new-construction/
 * Multifamily 5+ has no public page yet, so its cells come from the internal
 * guideline matrix (deploy/guidelines-mf.html, matrix 6/7/26) and the rate is
 * deliberately left as "ask" until Mike publishes one.
 *
 * Run: node scripts/broker-one-pager.mjs [outfile.pdf]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('../deploy/node_modules/pdf-lib');

const MARKETING = '/home/mdehaan51/code/sla-capital-marketing';
const OUT = process.argv[2] || '/home/mdehaan51/code/sla-closed-loans/SLA-Capital-Broker-Product-Guide.pdf';

// Marketing palette (assets/brand.css), not the portal's.
const PLUM = rgb(0x28 / 255, 0x1d / 255, 0x28 / 255);
const ORANGE = rgb(0xda / 255, 0x72 / 255, 0x38 / 255);
const PEACH = rgb(0xff / 255, 0xbc / 255, 0x7d / 255);
const INK = rgb(0.09, 0.07, 0.10);
const MUTED = rgb(0.42, 0.39, 0.44);
const LINE = rgb(0.88, 0.86, 0.86);
const WASH = rgb(0.972, 0.968, 0.962);
const WHITE = rgb(1, 1, 1);

const PRODUCTS = [
  {
    name: 'Fix & Flip / Bridge',
    tag: 'RTL · 1-4 unit',
    blurb: 'Purchase plus rehab on one short-term note, with the full rehab budget financed.',
    rows: [
      ['Rates', '9.5% - 12%, 1-4 points'],
      ['Leverage', 'Up to 92.5% LTC and 75% of ARV'],
      ['Credit', '680+ FICO, better terms at 700 and 740'],
      ['Rehab', '100% of the budget, drawn after inspection'],
      ['Term', '6 - 18 months'],
      ['Loan size', '$100K - $3M'],
      ['Speed', 'Close in as little as 72 hours'],
    ],
  },
  {
    name: 'New Construction',
    tag: 'GUC · ground-up',
    blurb: 'Land and vertical build on a single note, with interest only on what you have drawn.',
    rows: [
      ['Rates', 'From 10%'],
      ['Leverage', '85% of land + 85% of construction costs'],
      ['Credit', '680+ FICO'],
      ['Interest', 'Non-Dutch - you pay only on drawn funds'],
      ['Term', '18 or 24 months'],
      ['Loan size', '$100K - $7.5M'],
      ['Approval', 'Unpermitted land is eligible'],
    ],
  },
  {
    name: 'DSCR Rental',
    tag: '1-4 unit · 30-year',
    blurb: 'Long-term rental financing qualified on the property’s income, not the borrower’s.',
    rows: [
      ['Rates', 'From 6.75%'],
      ['Leverage', 'Up to 80% LTV purchase and rate/term, 75% cash-out'],
      ['Credit', '660+ FICO, 660-679 by pre-approval'],
      ['Structures', '30-yr fixed, 5-yr IO, 5/1 ARM, 7/1 ARM'],
      ['Qualifying', '1.00 DSCR minimum, no lease required'],
      ['Cash-out', 'Up to 75% LTV, 6-month seasoning'],
      ['Loan size', '$100K - $3M, portfolios of 2-10 on one note'],
    ],
  },
  {
    name: 'Multifamily DSCR',
    tag: '5+ units',
    blurb: 'Stabilized 5-30 unit apartments, underwritten on in-place net cash flow.',
    rows: [
      ['Rates', 'Ask your rep for current pricing'],
      ['Leverage', 'Up to 74.99% LTV purchase and refinance'],
      ['Credit', '700+ FICO'],
      ['Qualifying', '1.20x NCF DSCR in top and standard markets'],
      ['Structures', '30-yr fixed and ARM, interest-only available'],
      ['Loan size', '$350K - $5M'],
      ['Property', '5-30 units, $500K min value, $75K avg / unit'],
    ],
  },
];

// Licensing exclusions are company-wide (guidelines.html "Eligible States &
// Licensing"); IL / Newark are the Colchis RTL + GUC overlay, and Idaho is
// excluded on Multifamily only (guidelines-mf.html).
const FOOTPRINT_LEAD = 'Where we lend:';
const FOOTPRINT = 'Nationwide except AZ, CA, MN, ND, NV, SD, UT, VT and US territories.  '
  + 'Fix & Flip and New Construction also exclude IL, the city of Newark NJ, and rural (RUCA) properties.  '
  + 'Multifamily 5+ also excludes ID.';

const WHY = [
  ['Term sheet in minutes', 'Our sizer prices the deal up front - rate, points, leverage and reserves.'],
  ['Draws that keep pace', 'Same-day draw approvals when the photos and invoices are clean.'],
  ['No app or appraisal fee', 'Nothing out of pocket to get a real quote and get under contract.'],
  ['Your own partner portal', 'Price and submit your own deals, and track them start to finish.'],
];

const main = async () => {
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
  /** Word-wrap within a width; returns the y after the last line. */
  const wrap = (s, x, y, size, font, color, maxW, lead = 1.32) => {
    const words = String(s).split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) {
        text(line, x, y, size, font, color);
        y -= size * lead;
        line = w;
      } else line = test;
    }
    if (line) { text(line, x, y, size, font, color); y -= size * lead; }
    return y;
  };

  // ── Header band ───────────────────────────────────────────────
  const H = 96;
  page.drawRectangle({ x: 0, y: 792 - H, width: 612, height: H, color: PLUM });
  page.drawRectangle({ x: 0, y: 792 - H - 4, width: 612, height: 4, color: ORANGE });
  const logoBytes = fs.readFileSync(path.join(MARKETING, 'assets/logo-alt.png')); // light mark, for dark bands
  const logo = await pdf.embedPng(logoBytes);
  const logoH = 50;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: 40, y: 792 - H + (H - logoH) / 2, width: logoW, height: logoH });
  text('INVESTOR LENDING PROGRAMS', 612 - 40 - bold.widthOfTextAtSize('INVESTOR LENDING PROGRAMS', 13), 792 - 44, 13, bold, WHITE, { characterSpacing: 1.6 });
  const sub = 'Broker & partner product guide';
  text(sub, 612 - 40 - reg.widthOfTextAtSize(sub, 10.5), 792 - 62, 10.5, reg, PEACH);

  // ── Intro line ────────────────────────────────────────────────
  let y = 792 - H - 30;
  text('Four programs, one lender, one process.', 40, y, 13, bold, INK);
  y -= 15;
  wrap('We fund business-purpose real estate loans nationwide. Send us the deal and you get a real term sheet the same day - '
    + 'with the leverage, rate and reserve requirement spelled out before your borrower is under contract.',
    40, y, 9.5, reg, MUTED, 532);

  // ── Product cards (2 x 2) ─────────────────────────────────────
  const M = 40, GUT = 14;
  const CW = (612 - M * 2 - GUT) / 2;
  const CH = 182;
  const top = 792 - H - 78;
  PRODUCTS.forEach((p, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = M + col * (CW + GUT);
    const yTop = top - row * (CH + GUT);
    page.drawRectangle({ x, y: yTop - CH, width: CW, height: CH, color: WHITE, borderColor: LINE, borderWidth: 1 });
    // Title strip
    page.drawRectangle({ x, y: yTop - 34, width: CW, height: 34, color: PLUM });
    text(p.name, x + 12, yTop - 17, 12.5, bold, WHITE);
    const tw = reg.widthOfTextAtSize(p.tag, 8.5);
    text(p.tag, x + CW - 12 - tw, yTop - 16, 8.5, reg, PEACH);
    // Blurb
    let cy = yTop - 50;
    cy = wrap(p.blurb, x + 12, cy, 8.8, obl, MUTED, CW - 24);
    cy -= 4;
    // Spec rows
    const labelW = 58;
    p.rows.forEach((r) => {
      text(r[0], x + 12, cy, 8.5, bold, ORANGE);
      const after = wrap(r[1], x + 12 + labelW, cy, 8.8, reg, INK, CW - 24 - labelW);
      cy = Math.min(cy - 12.6, after - 1.5);
    });
  });

  // ── Lending footprint ─────────────────────────────────────────
  const fpTop = top - 2 * (CH + GUT) - 4;
  const fpH = 40;
  page.drawRectangle({ x: M, y: fpTop - fpH, width: 612 - M * 2, height: fpH, color: rgb(1, 0.965, 0.93), borderColor: PEACH, borderWidth: 1 });
  text(FOOTPRINT_LEAD, M + 12, fpTop - 16, 8.5, bold, ORANGE);
  const fpX = M + 12 + bold.widthOfTextAtSize(FOOTPRINT_LEAD, 8.5) + 6;
  wrap(FOOTPRINT, fpX, fpTop - 16, 8.2, reg, INK, 612 - M * 2 - 24 - (fpX - M - 12), 1.34);

  // ── Why partner strip ─────────────────────────────────────────
  const wyTop = fpTop - fpH - 12;
  const wyH = 80;
  page.drawRectangle({ x: M, y: wyTop - wyH, width: 612 - M * 2, height: wyH, color: WASH, borderColor: LINE, borderWidth: 1 });
  text('WHY BROKERS SEND US DEALS', M + 12, wyTop - 17, 8.5, bold, PLUM, { characterSpacing: 1.2 });
  const colW = (612 - M * 2 - 24) / 4;
  WHY.forEach((w, i) => {
    const x = M + 12 + i * colW;
    text(w[0], x, wyTop - 34, 8.8, bold, INK);
    wrap(w[1], x, wyTop - 46, 7.8, reg, MUTED, colW - 10, 1.3);
  });

  // ── Footer ────────────────────────────────────────────────────
  const fy = 60;
  page.drawLine({ start: { x: M, y: fy + 34 }, end: { x: 612 - M, y: fy + 34 }, thickness: 1, color: LINE });
  const contact = 'Submit a deal:  apply@slacapital.com   ·   (509) 846-7349   ·   slacapital.ai';
  text(contact, (612 - bold.widthOfTextAtSize(contact, 10)) / 2, fy + 18, 10, bold, PLUM);
  const legal1 = 'Sir Lends A Lot LLC dba SLA Capital  ·  707 W Main Ave #31, Spokane, WA 99201  ·  NMLS ID #2863552';
  const legal2 = 'Idaho Mortgage Broker/Lender License #MBL-2082863552  ·  Certified Member, American Association of Private Lenders';
  text(legal1, (612 - reg.widthOfTextAtSize(legal1, 7.4)) / 2, fy + 2, 7.4, reg, MUTED);
  text(legal2, (612 - reg.widthOfTextAtSize(legal2, 7.4)) / 2, fy - 9, 7.4, reg, MUTED);
  const asOf = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const disc = 'For business-purpose real estate loans only; not for consumer or owner-occupied use. Terms are indicative and subject to underwriting, '
    + 'valuation and final approval. This is not a commitment to lend. Rates and terms current as of ' + asOf + ' and subject to change.';
  wrap(disc, M, fy - 24, 6.8, reg, MUTED, 612 - M * 2, 1.35);

  fs.writeFileSync(OUT, await pdf.save());
  console.log('wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
};
main().catch((e) => { console.error(e); process.exit(1); });
