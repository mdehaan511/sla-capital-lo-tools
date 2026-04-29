/**
 * loan-application.mjs — POST /api/loan-application
 *
 * Generates a populated SLA Loan Application DOCX from a completed
 * borrower-info record. Mirrors the term-sheet populator architecture:
 * load template, walk XML, replace [merge tags] with real values, return
 * the generated DOCX as a binary download.
 *
 * Body: { clientId, owner? }
 *
 * Returns: DOCX binary with proper Content-Type/Content-Disposition headers.
 *
 * Field mapping (template tag → data path):
 *   [Person full name (person name)]            → guarantor[0] firstName + lastName
 *   [Person email (person email)]               → guarantor[0] email
 *   [Person phone (person phone)]               → guarantor[0] phone
 *   [Person Date of Birth (person custom)]      → guarantor[0] dob
 *   [Person Estimated Credit Score ...]         → guarantor[0] fico
 *   [Person Marital Status (person custom)]     → guarantor[0] marital
 *   [Person Home Address (person custom)]       → guarantor[0] address+city+state+zip
 *   [Person Mailing Address (person custom)]    → same as home (no separate mailing field today)
 *   [Deal 2nd Borrower XXX]                     → guarantor[1] equivalents
 *   [Deal title (deal title)]                   → property address
 *   [Deal value (deal value)]                   → loan amount
 *   [Deal Loan Term (deal custom)]              → loan type label
 *   [Deal Loan Type (deal custom)]              → DSCR / Fix and Flip / Construction / Bridge
 *   [Deal Property Type (deal custom)]          → propertyType
 *   [Deal Number of Units (deal custom)]        → numUnits (or 1 default)
 *   [Deal Flood Zone Status - DSCR ...]         → floodZone
 *   [Deal Purchase or Refi? (deal custom)]      → dscrPurchaseRefi or loanPurpose
 *   [Deal Required Close Date (deal custom)]    → dscrCloseDate or ffCloseDate
 *   [Deal Original Purchase Date (deal custom)] → originalPurchaseDate
 *   [Deal Project Summary - F&F (deal custom)]  → planDescription
 *   [Deal Exit Strategy - F&F (deal custom)]    → exitStrategy
 *   [Deal Purchase Price - F&F (deal custom)]   → purchasePrice
 *   [Deal Property ARV F&F (deal custom)]       → arv
 *   [Deal Amount of Rehab Funds F&F]            → renoCost
 *   [Deal Market Value - DSCR (deal custom)]    → currentValue
 *   [Deal Monthly Rent - DSCR (deal custom)]    → currentRent
 *   [Deal Annual Taxes - DSCR (deal custom)]    → annualTaxes
 *   [Deal Annual Insurance (deal custom)]       → annualInsurance
 *   [Deal Annual HOA Fee - DSCR (deal custom)]  → annualHOA
 *   [Deal Are all units rented? (deal custom)]  → allRented
 *   [Deal Kind of Rental - DSCR (deal custom)]  → rentalKind label
 *   [Deal Lease Length (deal custom)]           → (not collected; leave blank)
 *   [Deal Name of LLC (deal custom)]            → llcName
 *   [Deal State LLC is Registered (deal custom)] → llcState
 *   [Deal LLC EIN (deal custom)]                → llcEIN
 *   [Deal LLC Registered Address (deal custom)] → llcAddress+city+state+zip
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { decryptField } from './_shared/crypto.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import JSZip from 'jszip';

const _funcDir = dirname(fileURLToPath(import.meta.url));

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-application top-level error:', e);
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
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  // Load the borrower-info record
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const recordKey = `${ownerKey}/${keySafe(body.clientId)}`;
  let record = null;
  try { record = await biStore.get(recordKey, { type: 'json' }); } catch (e) {
    return json(500, { error: 'Failed to load borrower record' });
  }
  if (!record) return json(404, { error: 'No borrower information on file for this client' });

  // Decrypt SSNs in-memory for the doc only
  const data = decryptSSNs(record.data || {});

  // Load the client record (for borrower name fallback + entity name fallback)
  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(`${ownerKey}/${keySafe(body.clientId)}`, { type: 'json' });
  } catch (_) {}

  // Find the template
  const candidates = [
    join(_funcDir, '_templates', 'Loan_Application.docx'),
    join(_funcDir, '..', '_templates', 'Loan_Application.docx'),
    join(process.cwd(), 'netlify', 'functions', '_templates', 'Loan_Application.docx'),
    join(process.cwd(), '_templates', 'Loan_Application.docx'),
  ];
  let tplBuffer = null;
  let triedPaths = [];
  for (const p of candidates) {
    triedPaths.push(p);
    try { tplBuffer = readFileSync(p); break; } catch (_) {}
  }
  if (!tplBuffer) {
    return json(500, { error: 'Template not found', tried: triedPaths, cwd: process.cwd(), _funcDir });
  }

  // Build the value map from the borrower-info data + record prefill
  const ctx = buildContext(data, record, client);

  let outBuffer;
  try {
    outBuffer = await populateDocx(tplBuffer, ctx);
  } catch (e) {
    console.error('loan-application populate error:', e);
    return json(500, { error: 'Failed to populate template: ' + (e.message || 'unknown') });
  }

  const safeName = String(
    (data.borrowerLastName || '') + '_' + (data.borrowerFirstName || '')
  ).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const filename = `SLA_Loan_Application_${safeName || 'borrower'}.docx`;

  return new Response(outBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ── Decrypt SSN_enc into plaintext ssn for in-memory use only ─────
function decryptSSNs(data) {
  const out = JSON.parse(JSON.stringify(data));
  if (Array.isArray(out.guarantors)) {
    out.guarantors = out.guarantors.map((g) => {
      const copy = Object.assign({}, g);
      if (copy.ssn_enc && !copy.ssn) {
        try { copy.ssn = decryptField(copy.ssn_enc); }
        catch (_) { copy.ssn = ''; }
      }
      delete copy.ssn_enc;
      return copy;
    });
  }
  return out;
}

// ── Build the context object used for tag substitution ────────────
function buildContext(data, record, client) {
  const g0 = (data.guarantors && data.guarantors[0]) || {};
  const g1 = (data.guarantors && data.guarantors[1]) || {};
  const prefill = record.prefill || {};

  // Borrower name with fallbacks: g0 → top-level borrower → client record
  const borrowerFirst = g0.firstName || data.borrowerFirstName || (client && client.firstName) || '';
  const borrowerLast  = g0.lastName  || data.borrowerLastName  || (client && client.lastName)  || '';
  const borrowerName  = (borrowerFirst + ' ' + borrowerLast).trim();
  const borrowerEmail = g0.email || data.borrowerEmail || (client && client.email) || '';
  const borrowerPhone = g0.phone || data.borrowerPhone || (client && client.phone) || '';

  // Property
  const propertyAddress =
    [data.propertyAddress, data.propertyAddress2, data.propertyCity, data.propertyState, data.propertyZip]
      .filter(Boolean).join(', ');
  const propAddrShort = data.propertyAddress
    || (prefill.property && prefill.property.address)
    || '';

  // Loan type / purpose readable labels
  const loanTypeLabel = (() => {
    const lt = data.loanType || (prefill.loan && prefill.loan.toolType) || '';
    if (lt === 'fix_flip')    return 'Fix and Flip Loan';
    if (lt === 'rtl')         return 'Fix and Flip Loan';
    if (lt === 'dscr')        return 'DSCR (Rental)';
    if (lt === 'construction')return 'New Construction';
    if (lt === 'dscr_2nd')    return 'DSCR 2nd Position';
    return lt || '';
  })();

  const purchaseOrRefi = (() => {
    if (data.dscrPurchaseRefi === 'refinance') return 'Refinance';
    if (data.dscrPurchaseRefi === 'purchase')  return 'Purchase';
    if (data.purchaseOrRefi) return data.purchaseOrRefi;
    return '';
  })();

  const rentalKindLabel = (() => {
    const rk = data.rentalKind || '';
    if (rk === 'ltr')   return 'Long Term Rental (6+ Month leases)';
    if (rk === 'str')   return 'Short Term Rental (AirBNB or Leases under 6 months)';
    if (rk === 'other') return 'Other';
    return '';
  })();

  // Property type readable
  const propertyTypeLabel = (() => {
    const pt = data.propertyType || (prefill.property && prefill.property.propType) || '';
    const map = {
      sfr:'Single Family', sfh:'Single Family', '2-4':'2-4 Unit Residential',
      condo:'Condo', condo_w:'Condo', condo_nw:'Non-Warrantable Condo',
      nw_condo:'Non-Warrantable Condo', townhome:'Townhome', portfolio:'Portfolio',
      mfr:'Multi-Family', '5+':'5+ Unit Multifamily',
    };
    return map[pt] || pt;
  })();

  // Marital readable
  const maritalLabel = (m) => {
    if (m === 'married') return 'Married';
    if (m === 'single' || m === 'not_married') return 'Not Married';
    return m || '';
  };

  // Address composer for guarantor + LLC
  const composeAddr = (street, city, state, zip) =>
    [street, city, state, zip].filter(Boolean).join(', ');

  return {
    // Person (= primary borrower / Guarantor 1)
    'Person full name (person name)':                 borrowerName,
    'Person email (person email)':                    borrowerEmail,
    'Person phone (person phone)':                    borrowerPhone,
    'Person Date of Birth (person custom)':           g0.dob || '',
    'Person Estimated Credit Score (person custom)':  g0.fico || '',
    'Person Marital Status (person custom)':          maritalLabel(g0.marital),
    'Person Home Address (person custom)':            composeAddr(g0.address, g0.city, g0.state, g0.zip),
    'Person Mailing Address (person custom)':         composeAddr(g0.address, g0.city, g0.state, g0.zip),

    // Deal — primary identifiers
    'Deal title (deal title)':                        propAddrShort,
    'Deal value (deal value)':                        fmtMoney(data.requestedLoanDSCR || data.requestedLoanFF || data.purchasePrice || ''),
    'Deal Loan Type (deal custom)':                   loanTypeLabel,
    'Deal Loan Term (deal custom)':                   loanTypeLabel,
    'Deal Property Type (deal custom)':               propertyTypeLabel,
    'Deal Number of Units (deal custom)':             String(data.numUnits || data.bedrooms || '1'),
    'Deal Flood Zone Status - DSCR (deal custom)':    data.floodZone === 'yes' ? 'Yes' : data.floodZone === 'no' ? 'No' : '',

    // Deal — purpose, dates
    'Deal Purchase or Refi? (deal custom)':           purchaseOrRefi,
    'Deal Required Close Date (deal custom)':         data.dscrCloseDate || data.ffCloseDate || '',
    'Deal Original Purchase Date (deal custom)':      data.originalPurchaseDate || '',
    'Deal Project Summary - F&amp;F (deal custom)':       data.planDescription || '',
    'Deal Exit Strategy - F&amp;F (deal custom)':         data.exitStrategy || '',

    // Deal — F&F amounts
    'Deal Purchase Price - F&amp;F (deal custom)':        fmtMoney(data.purchasePrice || ''),
    'Deal Property ARV F&amp;F (deal custom)':            fmtMoney(data.arv || ''),
    'Deal Amount of Rehab Funds F&amp;F (deal custom)':   fmtMoney(data.renoCost || ''),

    // Deal — DSCR amounts
    'Deal Market Value - DSCR (deal custom)':         fmtMoney(data.currentValue || ''),
    'Deal Monthly Rent - DSCR (deal custom)':         fmtMoney(data.currentRent || ''),
    'Deal Annual Taxes - DSCR (deal custom)':         fmtMoney(data.annualTaxes || ''),
    'Deal Annual Insurance (deal custom)':            fmtMoney(data.annualInsurance || ''),
    'Deal Annual HOA Fee - DSCR (deal custom)':       fmtMoney(data.annualHOA || ''),
    'Deal Are all units rented? (deal custom)':       data.allRented === 'yes' ? 'Yes' : data.allRented === 'no' ? 'No' : '',
    'Deal Kind of Rental - DSCR (deal custom)':       rentalKindLabel,
    'Deal Lease Length (deal custom)':                data.leaseLength || '',

    // Deal — LLC vesting
    'Deal Name of LLC (deal custom)':                 data.llcName || '',
    'Deal State LLC is Registered (deal custom)':     data.llcState || '',
    'Deal LLC EIN (deal custom)':                     data.llcEIN || '',
    'Deal LLC Registered Address (deal custom)':      composeAddr(data.llcAddress, data.llcCity, data.llcAddrState, data.llcZip),

    // Deal — second borrower
    'Deal 2nd Borrower Name (deal custom)':           ((g1.firstName || '') + ' ' + (g1.lastName || '')).trim(),
    'Deal 2nd Borrower Email (deal custom)':          g1.email || '',
    'Deal 2nd Borrower Phone Number (deal custom)':   g1.phone || '',
    'Deal 2nd Borrower DOB (deal custom)':            g1.dob || '',
    'Deal 2nd Borrower Credit Score (deal custom)':   g1.fico || '',
    'Deal 2nd Borrower Marital Status (deal custom)': maritalLabel(g1.marital),
    'Deal 2nd Borrower Home Address (deal custom)':   composeAddr(g1.address, g1.city, g1.state, g1.zip),
  };
}

// ── DOCX populator ───────────────────────────────────────────────
async function populateDocx(tplBuffer, ctx) {
  const zip = await JSZip.loadAsync(tplBuffer);
  // Replace tags in document.xml AND any header/footer parts
  const targets = ['word/document.xml', 'word/header1.xml', 'word/header2.xml', 'word/footer1.xml', 'word/footer2.xml'];
  for (const path of targets) {
    const file = zip.file(path);
    if (!file) continue;
    let xml = await file.async('string');
    Object.keys(ctx).forEach((tag) => {
      const value = String(ctx[tag] == null ? '' : ctx[tag]);
      const escaped = xmlEsc(value);
      // Tag is already in the XML's encoded form (e.g. "F&amp;F" tags)
      const find = '[' + tag + ']';
      // Use split/join because string.replaceAll isn't available everywhere
      xml = xml.split(find).join(escaped);
    });
    zip.file(path, xml);
  }
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function fmtMoney(v) {
  if (v === '' || v == null) return '';
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n)) return String(v);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
