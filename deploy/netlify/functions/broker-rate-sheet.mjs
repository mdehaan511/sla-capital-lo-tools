/**
 * broker-rate-sheet.mjs — POST /api/broker-rate-sheet
 *
 * Deploy 236.872. The document a Preferred Partner hands their borrower.
 *
 * TWO RULES FROM MIKE SHAPE THIS WHOLE FILE
 * -----------------------------------------
 * 1. BRAND AGNOSTIC. Brokers don't want to show SLA to their borrowers, so
 *    nothing on this PDF says SLA Capital — no logo, no name, no LO
 *    contact, no slacapital.ai. The header is the BROKER's uploaded logo,
 *    or a neutral "Loan Quote" title when they haven't uploaded one.
 *
 * 2. ONE FEE NUMBER. The borrower sees a single combined origination
 *    figure — our points and the broker's compensation added together.
 *    Splitting them on this sheet would show the borrower exactly what
 *    their broker is making. The split is preserved everywhere on OUR
 *    side (the quote record, the desk, the eventual loan) and is never
 *    computed away; it is simply not printed here.
 *
 * BORROWER NAME + EMAIL ARE REQUIRED. Mike: a sheet only prints once the
 * broker has told us who it's for, and the name prints on it. That also
 * gives us the borrower contact on the quote record — which is the
 * "capture the client, hold the loan" rule from the spec.
 *
 * Body: { quoteId, borrowerName, borrowerEmail, as? }
 * Returns: application/pdf
 */
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, normalizeEmail,
} from './_shared/auth.mjs';
import { isBrokerRole } from './_shared/access.mjs';
import { checkPartnerAccess, getPartner } from './_shared/broker-partners.mjs';
import { getQuote, patchQuote } from './_shared/broker-quotes.mjs';
import { getLogo } from './_shared/broker-assets.mjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const INK   = rgb(0.10, 0.08, 0.13);
const MUTED = rgb(0.48, 0.45, 0.53);
const LINE  = rgb(0.87, 0.85, 0.82);

function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return '$' + Math.round(v).toLocaleString('en-US');
}
function pct(n, d) {
  const v = Number(n);
  return isFinite(v) ? v.toFixed(d == null ? 3 : d) + '%' : '—';
}
function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim().toLowerCase());
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-rate-sheet error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  const me = normalizeEmail(user.email || '');
  const admin = isAdmin(user);

  // Whose quote? Admins may print on a partner's behalf (support, preview).
  let subject = me;
  if (admin && body.as) subject = normalizeEmail(body.as);
  else if (!admin) {
    if (!isBrokerRole(user)) return json(403, { error: 'Not a Preferred Partner account.' });
    const access = await checkPartnerAccess(me);
    if (!access.ok) return json(403, { error: access.reason });
  }

  // ── Borrower is required, and it prints ─────────────────────────
  const borrowerName  = String(body.borrowerName || '').trim();
  const borrowerEmail = String(body.borrowerEmail || '').trim().toLowerCase();
  if (borrowerName.length < 2) {
    return json(400, { error: 'Enter the borrower\'s name — it prints on the rate sheet.' });
  }
  if (!isEmail(borrowerEmail)) {
    return json(400, { error: 'Enter a valid borrower email.' });
  }

  const quote = await getQuote(subject, String(body.quoteId || ''));
  if (!quote) return json(404, { error: 'That quote is no longer available. Run the pricing again.' });
  if (quote.declined) {
    return json(422, { error: 'This scenario didn\'t fit the program, so there\'s nothing to print.' });
  }

  // Record the borrower on the quote. This is the capture point: we now
  // know who the deal is for, without creating a loan.
  await patchQuote(subject, quote.quoteId, {
    borrower: { name: borrowerName, email: borrowerEmail, capturedAt: new Date().toISOString() },
  });

  const partner = await getPartner(subject);
  const logo = await getLogo(subject);

  const pdfBytes = await renderSheet({ quote, partner, logo, borrowerName, borrowerEmail });

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + fileNameFor(quote) + '"',
      'Cache-Control': 'no-store',
    },
  });
}

function fileNameFor(q) {
  const street = String(q.address || 'Loan Quote').split(',')[0]
    .replace(/[<>:"|?*\\/\x00-\x1F]/g, '').trim().slice(0, 60);
  return (street || 'Loan Quote') + ' - Loan Quote.pdf';
}

async function renderSheet({ quote, partner, logo, borrowerName, borrowerEmail }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const reg  = await pdf.embedFont(StandardFonts.Helvetica);

  const lm = 54, rm = 558, W = rm - lm;
  let y = 742;

  const text = (s, x, yy, size, font, color) =>
    page.drawText(String(s == null ? '' : s), { x, y: yy, size, font: font || reg, color: color || INK });
  const right = (s, xr, yy, size, font, color) => {
    const f = font || reg;
    const w = f.widthOfTextAtSize(String(s), size);
    page.drawText(String(s), { x: xr - w, y: yy, size, font: f, color: color || INK });
  };
  const rule = (yy) => page.drawLine({
    start: { x: lm, y: yy }, end: { x: rm, y: yy }, thickness: 0.7, color: LINE,
  });

  // ── Header: the BROKER's mark, or a neutral title ───────────────
  // Nothing here identifies SLA. That is the whole point of the sheet.
  let headerDrawn = false;
  if (logo && logo.dataB64) {
    try {
      const bytes = Buffer.from(logo.dataB64, 'base64');
      const img = logo.mime === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const maxW = 200, maxH = 56;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: lm, y: y - h + 10, width: w, height: h });
      y -= (h + 18);
      headerDrawn = true;
    } catch (e) {
      // A corrupt stored logo must not cost the broker their rate sheet.
      console.warn('broker-rate-sheet: logo embed failed, falling back to title:', e && e.message);
    }
  }
  if (!headerDrawn) {
    text('Loan Quote', lm, y, 24, bold);
    y -= 30;
  }

  // Property — the subject of the quote, and the fallback title's subtitle.
  text(quote.address || 'Property address not specified', lm, y, 13, bold);
  y -= 16;
  text('Prepared for ' + borrowerName + '  ·  ' + borrowerEmail, lm, y, 10, reg, MUTED);
  y -= 20;
  rule(y); y -= 24;

  // ── Headline rate ───────────────────────────────────────────────
  const fee = quote.fee || {};
  const all = quote.allIn || {};
  const res = quote.result || {};
  const isDscr = (quote.program === 'dscr' || quote.program === 'mf');

  text('INTEREST RATE', lm, y, 8.5, bold, MUTED);
  right('LOAN AMOUNT', rm, y, 8.5, bold, MUTED);
  y -= 26;
  text(pct(fee.slaRate), lm, y, 30, bold);
  right(money(all.loanAmount), rm, y, 30, bold);
  y -= 22;
  text(quote.programLabel || '', lm, y, 10, reg, MUTED);
  y -= 22;
  rule(y); y -= 26;

  // ── Terms ───────────────────────────────────────────────────────
  const rows = [];
  if (isDscr) {
    if (res.ltv != null)          rows.push(['Loan-to-Value', pct(res.ltv, 1)]);
    if (res.dscr != null)         rows.push(['DSCR', (Number(res.dscr) || 0).toFixed(2) + 'x']);
    if (res.loanType)             rows.push(['Product', String(res.loanType)]);
    if (res.isIO)                 rows.push(['Interest Only', String(res.isIO).toLowerCase() === 'yes' ? 'Yes' : 'No']);
    if (res.pi != null)           rows.push(['Principal & Interest', money(res.pi) + ' / mo']);
    if (res.totalPayment != null) rows.push(['Total Payment (PITIA)', money(res.totalPayment) + ' / mo']);
  } else {
    if (res.bLabel)               rows.push(['Maximum Loan Limited By', String(res.bLabel)]);
    if (res.dp != null)           rows.push(['Down Payment', money(res.dp)]);
    if (res.initAdv != null)      rows.push(['Initial Advance', money(res.initAdv)]);
    if (res.mo != null)           rows.push(['Monthly Interest', money(res.mo) + ' / mo']);
    if (res.progLabel)            rows.push(['Program', String(res.progLabel)]);
  }

  text('TERMS', lm, y, 8.5, bold, MUTED); y -= 16;
  for (const [k, v] of rows) {
    text(k, lm, y, 10.5, reg, MUTED);
    right(v, rm, y, 10.5, bold);
    y -= 18;
    if (y < 200) break;
  }
  y -= 8; rule(y); y -= 26;

  // ── Cost: ONE combined number ───────────────────────────────────
  // all.points / all.dollars are SLA's origination plus the broker's
  // compensation, already summed upstream. Printing them separately would
  // show the borrower their broker's margin.
  text('ORIGINATION', lm, y, 8.5, bold, MUTED); y -= 18;
  text('Origination & Points', lm, y, 11, reg, MUTED);
  right((Number(all.points) || 0).toFixed(2) + ' pts   ' + money(all.dollars), rm, y, 12, bold);
  y -= 20;
  text('Third-party costs (title, escrow, appraisal, recording) are additional.', lm, y, 9, reg, MUTED);
  y -= 24; rule(y); y -= 24;

  // ── Who this is from — the BROKER, never us ─────────────────────
  const brokerCompany = (partner && partner.company) || '';
  const brokerName = partner ? ((partner.firstName || '') + ' ' + (partner.lastName || '')).trim() : '';
  const contact = [brokerName, partner && partner.phone, partner && partner.email].filter(Boolean).join('  ·  ');
  if (brokerCompany || contact) {
    text('PREPARED BY', lm, y, 8.5, bold, MUTED); y -= 16;
    if (brokerCompany) { text(brokerCompany, lm, y, 12, bold); y -= 15; }
    if (contact)       { text(contact, lm, y, 10, reg, MUTED); y -= 15; }
    y -= 10;
  }

  // ── Footer ──────────────────────────────────────────────────────
  const prepared = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  let fy = 92;
  rule(fy + 22);
  const disclosure =
    'This is an estimate of available loan terms based on the information provided. It is not a ' +
    'commitment to lend. Terms are subject to underwriting, appraisal, title review and final ' +
    'approval, and may change. Rates and terms are subject to change without notice.';
  for (const ln of wrap(disclosure, reg, 8, W)) {
    text(ln, lm, fy, 8, reg, MUTED); fy -= 10;
  }
  fy -= 4;
  const stamp = 'Prepared ' + prepared +
    (quote.effectiveDate ? '   ·   Pricing effective ' + quote.effectiveDate : '') +
    '   ·   Ref ' + quote.quoteId;
  text(stamp, lm, fy, 8, reg, MUTED);

  return await pdf.save();
}

/** Greedy wrap against real glyph widths, so nothing runs off the page. */
function wrap(s, font, size, maxWidth) {
  const words = String(s).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line); line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
