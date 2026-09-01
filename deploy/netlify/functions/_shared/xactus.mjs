/**
 * _shared/xactus.mjs — Xactus360 integration core (Deploy 236.779).
 *
 * Credit Pulls (MISMO 2.3.1 XML) + Flood Certs (MISMO 2.4 XML), both
 * submitted as a synchronous HTTPS POST (Content-Type text/xml) to the
 * same base URL with operator credentials as URL parameters. Verified
 * live against the Xactus test environment 2026-08-28:
 *   - credit: scores per bureau in <CREDIT_SCORE _Value>, report PDF in
 *     <EMBEDDED_FILE _Type="PDF"><DOCUMENT>base64</DOCUMENT>.
 *   - flood:  zone in NFIPFloodZoneIdentifier, SFHDF PDF embedded the
 *     same way; product identifiers: "Basic" (guaranteed determination
 *     + SFHDF) and "life" (Life of Loan monitoring).
 *
 * Env (Netlify): XACTUS_BASE_URL, XACTUS_OPERATOR_ID, XACTUS_PASSWORD.
 * Test values: https://test.ultraamps.com/uaweb/mismo + slacap.test.
 * Production is US-IP-gated (Netlify egress qualifies).
 */

export function xactusConfigured() {
  return !!(process.env.XACTUS_BASE_URL && process.env.XACTUS_OPERATOR_ID && process.env.XACTUS_PASSWORD);
}

// Names (never values) of the missing env vars — surfaced in the 503 so a
// scope/typo problem in the Netlify dashboard is diagnosable from the UI.
export function xactusMissingVars() {
  return ['XACTUS_BASE_URL', 'XACTUS_OPERATOR_ID', 'XACTUS_PASSWORD']
    .filter((k) => !process.env[k]);
}

// Deploy 236.835 — Xactus issued SEPARATE credentials for soft pulls (the
// SoftCheck/PQx product lives on its own account). SoftCheck orders use
// XACTUS_SOFT_OPERATOR_ID / XACTUS_SOFT_PASSWORD (+ optional
// XACTUS_SOFT_BASE_URL, falling back to the main XACTUS_BASE_URL); Merge
// hard pulls + flood keep the main credentials.
export function xactusSoftConfigured() {
  return !!((process.env.XACTUS_SOFT_BASE_URL || process.env.XACTUS_BASE_URL) &&
    process.env.XACTUS_SOFT_OPERATOR_ID && process.env.XACTUS_SOFT_PASSWORD);
}
export function xactusSoftMissingVars() {
  const out = ['XACTUS_SOFT_OPERATOR_ID', 'XACTUS_SOFT_PASSWORD'].filter((k) => !process.env[k]);
  if (!process.env.XACTUS_SOFT_BASE_URL && !process.env.XACTUS_BASE_URL) out.push('XACTUS_BASE_URL');
  return out;
}

function _url(cred) {
  if (cred === 'soft') {
    return (process.env.XACTUS_SOFT_BASE_URL || process.env.XACTUS_BASE_URL) +
      '?LoginAccountIdentifier=' + encodeURIComponent(process.env.XACTUS_SOFT_OPERATOR_ID) +
      '&LoginAccountPassword=' + encodeURIComponent(process.env.XACTUS_SOFT_PASSWORD);
  }
  return process.env.XACTUS_BASE_URL +
    '?LoginAccountIdentifier=' + encodeURIComponent(process.env.XACTUS_OPERATOR_ID) +
    '&LoginAccountPassword=' + encodeURIComponent(process.env.XACTUS_PASSWORD);
}

export function xesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// opts.cred: 'soft' routes through the SoftCheck credentials (236.835).
export async function postXactus(xml, timeoutMs, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 22000);
  try {
    const resp = await fetch(_url(opts && opts.cred), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: xml,
      signal: ctl.signal,
    });
    const text = await resp.text();
    return { httpStatus: resp.status, text };
  } finally {
    clearTimeout(t);
  }
}

// ── Credit (MISMO 2.3.1) ──────────────────────────────────────────
// subject: { firstName, lastName, ssn (9 digits), street, city, state, zip }
// opts: { reportType: 'Merge'|'SoftCheck', lenderCaseId }
export function buildCreditRequestXml(subject, opts) {
  const o = opts || {};
  const hard = String(o.reportType || 'Merge') !== 'SoftCheck';
  const typeAttrs = hard
    ? 'CreditReportType="Merge"'
    : 'CreditReportType="Other" CreditReportTypeOtherDescription="SoftCheck"';
  return `<?xml version="1.0" encoding="UTF-8"?>
<REQUEST_GROUP MISMOVersionID="2.3.1">
  <REQUESTING_PARTY _Name="SLA Capital"/>
  <SUBMITTING_PARTY _Name="SLA Capital"/>
  <REQUEST RequestDatetime="${new Date().toISOString().slice(0, 19)}">
    <REQUEST_DATA>
      <CREDIT_REQUEST MISMOVersionID="2.3.1" LenderCaseIdentifier="${xesc(o.lenderCaseId || '')}">
        <CREDIT_REQUEST_DATA CreditRequestID="SLA${Date.now()}" BorrowerID="B1"
          CreditReportRequestActionType="Submit" ${typeAttrs}
          CreditRequestType="Individual">
          <CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="Y" _ExperianIndicator="Y" _TransUnionIndicator="Y"/>
        </CREDIT_REQUEST_DATA>
        <LOAN_APPLICATION>
          <BORROWER BorrowerID="B1" _FirstName="${xesc(subject.firstName)}" _LastName="${xesc(subject.lastName)}" _SSN="${xesc(subject.ssn)}">
            <_RESIDENCE _StreetAddress="${xesc(subject.street)}" _City="${xesc(subject.city)}" _State="${xesc(subject.state)}" _PostalCode="${xesc(String(subject.zip || '').slice(0, 5))}" BorrowerResidencyType="Current"/>
          </BORROWER>
        </LOAN_APPLICATION>
      </CREDIT_REQUEST>
    </REQUEST_DATA>
  </REQUEST>
</REQUEST_GROUP>`;
}

export function parseCreditResponse(text) {
  const scores = {};
  const models = {};
  for (const m of text.matchAll(/<CREDIT_SCORE\b([^>]*)>/g)) {
    const a = m[1];
    const src = (a.match(/CreditRepositorySourceType="([^"]*)"/) || [])[1];
    const val = parseInt((a.match(/_Value="([^"]*)"/) || [])[1], 10);
    const model = (a.match(/_ModelNameType="([^"]*)"/) || [])[1] || '';
    if (src && isFinite(val) && val > 0) {
      const k = src.toLowerCase();
      // Keep the first (primary) score per bureau.
      if (!(k in scores)) { scores[k] = val; models[k] = model; }
    }
  }
  const vals = Object.values(scores).sort((a, b) => a - b);
  // Mid score: middle of 3, lower of 2, the one of 1.
  let mid = null;
  if (vals.length === 3) mid = vals[1];
  else if (vals.length === 2) mid = vals[0];
  else if (vals.length === 1) mid = vals[0];
  const reportId = (text.match(/CreditReportIdentifier="([^"]*)"/) || [])[1] || '';
  const pdf = extractEmbeddedPdf(text);
  const errors = [];
  // CREDIT_ERROR_MESSAGE carries its text in child <_Text> elements.
  for (const m of text.matchAll(/<CREDIT_ERROR_MESSAGE[^>]*>([\s\S]*?)<\/CREDIT_ERROR_MESSAGE>/g)) {
    for (const t of m[1].matchAll(/<_Text>([\s\S]*?)<\/_Text>/g)) errors.push(t[1].trim().slice(0, 300));
  }
  // _Condition can be "error" or "Error" — case-insensitive.
  for (const m of text.matchAll(/<STATUS[^>]*_Condition="error"[^>]*_Description="([^"]*)"/gi)) {
    errors.push(m[1].slice(0, 300));
  }
  return { scores, models, mid, reportId, pdfBase64: pdf, errors: [...new Set(errors.filter(Boolean))] };
}

// ── Flood (MISMO 2.4) ─────────────────────────────────────────────
// loan: { address parts }, product: 'Basic' | 'life'
export function buildFloodRequestXml({ firstName, lastName, street, city, state, zip, lenderCaseId, product }) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<REQUEST_GROUP MISMOVersionID="2.4">
  <REQUESTING_PARTY _Name="SLA Capital"/>
  <SUBMITTING_PARTY _Name="SLA Capital"/>
  <REQUEST>
    <REQUEST_DATA>
      <FLOOD_REQUEST _ActionType="Original">
        <_PRODUCT><_NAME _Description="Residential" _Identifier="${xesc(product || 'Basic')}"/></_PRODUCT>
        <BORROWER _FirstName="${xesc(firstName)}" _LastName="${xesc(lastName)}"/>
        <MORTGAGE_TERMS LenderCaseIdentifier="${xesc(lenderCaseId || '')}"/>
        <PROPERTY _StreetAddress="${xesc(street)}" _City="${xesc(city)}" _State="${xesc(state)}" _PostalCode="${xesc(String(zip || '').slice(0, 5))}"/>
      </FLOOD_REQUEST>
    </REQUEST_DATA>
  </REQUEST>
</REQUEST_GROUP>`;
}

export function parseFloodResponse(text) {
  const zone = (text.match(/NFIPFloodZoneIdentifier="([^"]*)"/) || [])[1] || '';
  const mapNumber = (text.match(/\bMapNumber[^=]*="([^"]*)"/) || [])[1] || '';
  const certDate = (text.match(/FloodProductCertifyDate="([^"]*)"/) || [])[1] || '';
  const certId = (text.match(/FloodCertificationIdentifier="([^"]*)"/) || [])[1] || '';
  const requestId = (text.match(/request id:\s*(\d+)/) || [])[1] || '';
  const inSfha = (text.match(/SpecialFloodHazardAreaIndicator="([^"]*)"/) || [])[1] || '';
  const pdf = extractEmbeddedPdf(text);
  const errors = [];
  for (const m of text.matchAll(/<STATUS[^>]*_Condition="error"[^>]*_Description="([^"]*)"/gi)) {
    errors.push(m[1].replace(/&quot;/g, '"').slice(0, 300));
  }
  // "success" = completed instantly; a no-hit/manual order acks with
  // _Condition="Status" + "Request created" — accepted, result pending.
  const success = /_Condition="success"/i.test(text);
  const accepted = success || /Request created, request id/i.test(text);
  return { zone, mapNumber, certDate, certId, requestId, inSfha, pdfBase64: pdf, success, accepted, errors };
}

// Shared: pull the first embedded base64 PDF out of a MISMO response.
// Credit responses use <EMBEDDED_FILE _Type="PDF">…; flood responses use
// _Extension="pdf" with the base64 wrapped in CDATA — handle both.
export function extractEmbeddedPdf(text) {
  const m = text.match(/<EMBEDDED_FILE[^>]*(?:_Type="PDF"|_Extension="pdf")[^>]*>[\s\S]*?<DOCUMENT[^>]*>([\s\S]*?)<\/DOCUMENT>/i);
  if (!m) return '';
  let b64 = m[1];
  const cd = b64.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cd) b64 = cd[1];
  return b64.replace(/[\s\r\n]/g, '');
}

// ── FICO bucket helpers (sizer-FICO vs credit-report mismatch flag) ──
// RTL fico values are bucket floors ('740','720',…); DSCR are ranges
// ('740-759','780+'). Return the bucket label a mid-score maps to for
// the given toolType, or '' when unknown.
export function ficoBucketForScore(mid, toolType) {
  const s = parseInt(mid, 10);
  if (!isFinite(s) || s <= 0) return '';
  if (String(toolType).toLowerCase() === 'rtl' || String(toolType).toLowerCase() === 'guc') {
    const floors = [740, 720, 700, 680, 660, 640, 620, 550];
    for (const f of floors) if (s >= f) return String(f);
    return '550';
  }
  // DSCR-style ranges.
  if (s >= 780) return '780+';
  const lo = Math.floor(s / 20) * 20;
  return lo + '-' + (lo + 19);
}
