/**
 * rate-sheet.mjs — POST /api/rate-sheet
 *
 * Generates a server-side rate sheet PDF for a saved loan. Uses the
 * pricingSnapshot stashed on the loan record at sizer save time, then
 * recomputes loan-amount-derived numbers (PI, fees) using the loan record's
 * current loanAmt — which carries any LO override.
 *
 * Body: { clientId, loanId, owner? }
 * Returns: PDF binary
 *
 * Architecture (Path B3):
 *   - Sizer saves pricing values onto the loan record (rate, base rate,
 *     adjustments breakdown, fees, monthly PI). These are NEVER recomputed
 *     server-side; the sizer is the single source of truth for pricing logic.
 *   - This generator pulls those values, applies the override loanAmt
 *     where applicable (to PI, points fee, total fees, cash-to-close),
 *     and lays out the PDF.
 *   - When loanAmtLocked is true, we recompute PI from rate + override amt.
 *     Rate itself is unchanged (rate doesn't depend on loanAmt within a tier).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('rate-sheet top-level error:', e);
    return json(500, {
      error: 'Server error: ' + (e.message || 'unknown'),
      stack: String(e.stack || '').slice(0, 800),
    });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId || !body.loanId) {
    return json(400, { error: 'clientId and loanId required' });
  }

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  // Load client + loan
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(`${ownerKey}/${keySafe(body.clientId)}`, { type: 'json' });
  if (!client) return json(404, { error: 'Client not found' });
  const loan = (client.loans || []).find((l) => l.id === body.loanId);
  if (!loan) return json(404, { error: 'Loan not found' });

  // Snapshot must exist (sizer was saved at least once)
  const snap = loan.pricingSnapshot;
  if (!snap) {
    return json(400, {
      error: 'No pricing snapshot on this loan. Open in the sizer and click Save Quote first to enable rate-sheet generation.',
    });
  }

  // Use the loan record's current loanAmt (override applies)
  const loanAmt = parseFloat(String(loan.loanAmt || snap.loanAmt || 0).replace(/[^0-9.]/g, '')) || 0;
  const isOverride = !!loan.loanAmtLocked;

  // Load LO profile for footer
  let loProfile = null;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
    loProfile = await profilesStore.get(ownerKey, { type: 'json' });
  } catch (_) {}

  const pdfBytes = await generateRateSheetPDF({
    snapshot: snap,
    loan,
    client,
    loProfile,
    loanAmt,
    isOverride,
  });

  const safeName = String(loan.address || (client.firstName + '_' + client.lastName) || 'rate_sheet')
    .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return new Response(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="SLA_Rate_Sheet_${safeName || 'loan'}.pdf"`,
    },
  });
}

// ── PDF generation ─────────────────────────────────────────────
async function generateRateSheetPDF({ snapshot, loan, client, loProfile, loanAmt, isOverride }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const helv     = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvItal = await doc.embedFont(StandardFonts.HelveticaOblique);

  // Color palette matching the app
  const GOLD    = rgb(0.784, 0.506, 0.227); // #C8813A
  const DARK    = rgb(0.149, 0.102, 0.212); // #261a36
  const TEXT    = rgb(0.102, 0.082, 0.125); // #1a1520
  const MUTED   = rgb(0.478, 0.455, 0.533); // #7a7488
  const BORDER  = rgb(0.867, 0.847, 0.816); // #ddd8d0
  const SUCCESS = rgb(0.145, 0.412, 0.251); // #256940
  const DANGER  = rgb(0.486, 0.122, 0.122); // #7c1f1f
  const BG      = rgb(0.941, 0.925, 0.898); // #f0ece5
  const GOLD_BG = rgb(0.985, 0.965, 0.929); // gold tint

  const { width: W, height: H } = page.getSize();
  const M = 50; // margin
  let y = H - M;

  // ── Header ──
  page.drawRectangle({ x: 0, y: H - 80, width: W, height: 80, color: DARK });
  page.drawText('SLA CAPITAL', {
    x: M, y: H - 38, size: 14, font: helvBold, color: rgb(1, 1, 1),
  });
  page.drawText('Rate Sheet', {
    x: M, y: H - 58, size: 22, font: helvBold, color: GOLD,
  });
  // Date right-aligned
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const dateW = helv.widthOfTextAtSize(today, 11);
  page.drawText(today, {
    x: W - M - dateW, y: H - 38, size: 11, font: helv, color: rgb(1, 1, 1),
  });
  // Tool tag
  const toolName = snapshot.tool === 'rtl' ? 'RTL / Fix & Flip' : 'DSCR — 1–4 Unit';
  const tagW = helv.widthOfTextAtSize(toolName, 10);
  page.drawText(toolName, {
    x: W - M - tagW, y: H - 58, size: 10, font: helv, color: GOLD,
  });
  y = H - 100;

  // ── Borrower / Property block ──
  const bName  = ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || (client.email || '—');
  const bAddr  = loan.address || '—';
  drawSection(page, M, y, W - 2*M, 'Borrower & Property', helvBold, GOLD);
  y -= 22;
  drawKeyVal(page, M, y, 'Borrower', bName, helv, helvBold, TEXT, MUTED);
  drawKeyVal(page, M + 270, y, 'Property', bAddr, helv, helvBold, TEXT, MUTED);
  y -= 18;
  drawKeyVal(page, M, y, 'Email', client.email || '—', helv, helvBold, TEXT, MUTED);
  drawKeyVal(page, M + 270, y, 'FICO', String(snapshot.fico || loan.fico || '—'), helv, helvBold, TEXT, MUTED);
  y -= 22;

  // ── Hero rate + loan amount block ──
  // Re-derive monthly PI using rate + override loanAmt (when override is active)
  const rateFraction = parseFloat(snapshot.finalRate) || 0;
  const ratePctStr   = (rateFraction * 100).toFixed(3) + '%';
  const points       = parseFloat(snapshot.points) || 1;
  const isIO         = snapshot.isIO === 'yes' || snapshot.isIO === true;

  // Recompute PI using current loanAmt (carries any override)
  let monthlyPI = isIO
    ? loanAmt * rateFraction / 12
    : pmt(rateFraction / 12, 360, loanAmt);
  if (!isFinite(monthlyPI) || monthlyPI < 0) monthlyPI = 0;

  // Hero box
  const heroH = 90;
  page.drawRectangle({ x: M, y: y - heroH, width: W - 2*M, height: heroH,
    color: GOLD_BG, borderColor: GOLD, borderWidth: 1 });
  // Loan Amount label + value
  page.drawText('LOAN AMOUNT' + (isOverride ? '  •  LO OVERRIDE' : ''), {
    x: M + 16, y: y - 22, size: 9, font: helvBold, color: GOLD,
  });
  page.drawText(fmtMoney(loanAmt), {
    x: M + 16, y: y - 52, size: 26, font: helvBold, color: TEXT,
  });
  // Rate big-text right
  const rText = ratePctStr;
  const rW = helvBold.widthOfTextAtSize(rText, 26);
  page.drawText('RATE', {
    x: W - M - 16 - rW + (rW - helvBold.widthOfTextAtSize('RATE', 9)), y: y - 22,
    size: 9, font: helvBold, color: GOLD,
  });
  page.drawText(rText, {
    x: W - M - 16 - rW, y: y - 52, size: 26, font: helvBold, color: TEXT,
  });
  // Sub line: points + monthly PI
  const subText = `${points.toFixed(2)} pts  ·  Monthly P&I: ${fmtMoney(monthlyPI)}` + (isIO ? ' (IO)' : '');
  page.drawText(subText, {
    x: M + 16, y: y - 76, size: 11, font: helv, color: MUTED,
  });
  y -= heroH + 22;

  // ── Pricing breakdown (adjustments) ──
  drawSection(page, M, y, W - 2*M, 'Rate Build-up', helvBold, GOLD);
  y -= 22;
  // Base rate row
  if (snapshot.baseRate != null) {
    drawAdjRow(page, M, y, W - 2*M, 'Base rate', fmtPct(snapshot.baseRate), helv, helvBold, TEXT, MUTED, BORDER, false);
    y -= 18;
  }
  // Each adjustment
  if (Array.isArray(snapshot.adjs)) {
    for (const adj of snapshot.adjs) {
      if (!adj || !adj.l) continue;
      let valStr;
      if (typeof adj.v === 'number') {
        const sign = adj.v > 0 ? '+' : '';
        valStr = sign + (adj.v * 100).toFixed(3) + '%';
      } else {
        valStr = String(adj.v || '');
      }
      const isPositive = (typeof adj.v === 'number') ? adj.v > 0 : /^\+/.test(valStr);
      const isNeg = (typeof adj.v === 'number') ? adj.v < 0 : /^[\-−]/.test(valStr);
      drawAdjRow(page, M, y, W - 2*M, adj.l, valStr, helv, helvBold,
        isPositive ? DANGER : (isNeg ? SUCCESS : TEXT), MUTED, BORDER, false);
      y -= 18;
      if (y < 200) { /* page break omitted for now */ }
    }
  }
  // Final rate total row
  page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 },
    thickness: 1, color: TEXT });
  y -= 4;
  drawAdjRow(page, M, y, W - 2*M, 'Final note rate', ratePctStr, helvBold, helvBold, TEXT, TEXT, BORDER, true);
  y -= 28;

  // ── Closing costs ──
  // Recompute fees against the (possibly overridden) loanAmt
  const origPct = points / 100;
  const origFee = loanAmt * origPct;
  let flatFees = 0;
  if (snapshot.tool === 'dscr') {
    flatFees = 995 + 700 + 500 + 120; // $2,315
  } else {
    flatFees = 600 + 900 + 500 + 150; // $2,150
  }
  const totalClosing = origFee + flatFees;

  drawSection(page, M, y, W - 2*M, 'Estimated Closing Costs', helvBold, GOLD);
  y -= 22;
  drawAdjRow(page, M, y, W - 2*M, `Origination (${points.toFixed(2)} pts)`, fmtMoney(origFee), helv, helvBold, TEXT, MUTED, BORDER, false);
  y -= 18;
  if (snapshot.tool === 'dscr') {
    drawAdjRow(page, M, y, W - 2*M, 'Underwriting Fee', fmtMoney(995), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Doc Prep Fee',     fmtMoney(700), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Legal Doc Fee',    fmtMoney(500), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Desktop Analysis', fmtMoney(120), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
  } else {
    drawAdjRow(page, M, y, W - 2*M, 'Underwriting Fee', fmtMoney(600), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Doc Prep Fee',     fmtMoney(900), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Servicing Fee',    fmtMoney(500), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Credit Fee',       fmtMoney(150), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
  }

  // For RTL with a down payment, add it
  let cashToClose = totalClosing;
  if (snapshot.tool === 'rtl' && snapshot.downPayment) {
    drawAdjRow(page, M, y, W - 2*M, 'Required Down Payment', fmtMoney(snapshot.downPayment), helv, helvBold, TEXT, MUTED, BORDER, false);
    y -= 18;
    cashToClose += snapshot.downPayment;
  }

  // For refis with current loan amount, this is a cashout calculation
  const isRefi = snapshot.tool === 'dscr'
    ? (snapshot.purpose === 'refi_co' || snapshot.purpose === 'refi_rt')
    : (snapshot.purpose === 'cashout' || snapshot.purpose === 'rateterm');
  if (isRefi && snapshot.currentLoanAmt > 0) {
    const cashout = loanAmt - snapshot.currentLoanAmt - totalClosing;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 1, color: TEXT });
    y -= 4;
    drawAdjRow(page, M, y, W - 2*M, 'Total Estimated Closing Costs', fmtMoney(totalClosing), helvBold, helvBold, TEXT, TEXT, BORDER, true);
    y -= 28;
    // Cashout breakdown
    drawSection(page, M, y, W - 2*M, snapshot.purpose === 'refi_co' || snapshot.purpose === 'cashout' ? 'Estimated Cashout' : 'Estimated Net to Borrower', helvBold, GOLD);
    y -= 22;
    drawAdjRow(page, M, y, W - 2*M, 'Requested Loan Amount', fmtMoney(loanAmt), helv, helvBold, TEXT, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Less: Current Loan Payoff', '−' + fmtMoney(snapshot.currentLoanAmt), helv, helvBold, DANGER, MUTED, BORDER, false); y -= 18;
    drawAdjRow(page, M, y, W - 2*M, 'Less: Total Closing Costs', '−' + fmtMoney(totalClosing), helv, helvBold, DANGER, MUTED, BORDER, false); y -= 18;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 1, color: TEXT });
    y -= 4;
    drawAdjRow(page, M, y, W - 2*M, 'Estimated Cashout *', fmtMoney(cashout), helvBold, helvBold,
      cashout >= 0 ? SUCCESS : DANGER, TEXT, BORDER, true);
    y -= 24;
    page.drawText('* Does not include standard title and escrow fees or required prepaid taxes and insurance.', {
      x: M, y: y, size: 8, font: helvItal, color: MUTED,
    });
    y -= 14;
  } else {
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 1, color: TEXT });
    y -= 4;
    drawAdjRow(page, M, y, W - 2*M, 'Total Estimated Cash to Close *', fmtMoney(cashToClose), helvBold, helvBold, TEXT, TEXT, BORDER, true);
    y -= 24;
    page.drawText('* Does not include standard title and escrow fees or required prepaid taxes and insurance.', {
      x: M, y: y, size: 8, font: helvItal, color: MUTED,
    });
    y -= 14;
  }

  // ── Footer (LO contact) ──
  const loName = (loProfile && loProfile.fullName) || 'SLA Capital';
  const loEmail = (loProfile && loProfile.email) || '';
  const loPhone = (loProfile && loProfile.user_metadata && loProfile.user_metadata.phone) || '';
  page.drawLine({ start: { x: M, y: M + 36 }, end: { x: W - M, y: M + 36 }, thickness: 0.5, color: BORDER });
  page.drawText(loName, { x: M, y: M + 20, size: 10, font: helvBold, color: TEXT });
  let footerLine = '';
  if (loEmail) footerLine += loEmail;
  if (loPhone) footerLine += (footerLine ? '  •  ' : '') + loPhone;
  if (footerLine) {
    page.drawText(footerLine, { x: M, y: M + 6, size: 9, font: helv, color: MUTED });
  }
  const disclaimer = 'Pricing is indicative only. Subject to full underwriting, appraisal, and investor approval.';
  const dW = helv.widthOfTextAtSize(disclaimer, 8);
  page.drawText(disclaimer, { x: W - M - dW, y: M + 12, size: 8, font: helvItal, color: MUTED });

  return await doc.save();
}

// ── Layout helpers ─────────────────────────────────────────────
function drawSection(page, x, y, w, label, font, color) {
  page.drawText(label, { x: x, y: y - 4, size: 11, font, color });
  page.drawLine({ start: { x: x, y: y - 8 }, end: { x: x + w, y: y - 8 }, thickness: 0.5, color });
}

function drawKeyVal(page, x, y, key, val, regular, bold, textColor, mutedColor) {
  page.drawText(key, { x, y, size: 9, font: regular, color: mutedColor });
  page.drawText(String(val).slice(0, 50), { x: x + 60, y, size: 10, font: bold, color: textColor });
}

function drawAdjRow(page, x, y, w, label, value, labelFont, valueFont, valueColor, labelColor, borderColor, total) {
  page.drawText(label, { x, y, size: total ? 11 : 10, font: labelFont, color: total ? labelColor : labelColor });
  const valW = valueFont.widthOfTextAtSize(value, total ? 12 : 10);
  page.drawText(value, { x: x + w - valW, y, size: total ? 12 : 10, font: valueFont, color: valueColor });
  if (!total) {
    page.drawLine({ start: { x, y: y - 4 }, end: { x: x + w, y: y - 4 }, thickness: 0.25, color: borderColor });
  }
}

// ── Math helpers ───────────────────────────────────────────────
function pmt(rateMonth, n, pv) {
  if (!rateMonth) return pv / n;
  return (pv * rateMonth) / (1 - Math.pow(1 + rateMonth, -n));
}
function fmtMoney(v) {
  const n = Number(v) || 0;
  return '$' + Math.round(n).toLocaleString('en-US');
}
function fmtPct(v) {
  return ((Number(v) || 0) * 100).toFixed(3) + '%';
}
