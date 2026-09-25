/**
 * _shared/portfolio-properties.mjs -- Deploy 237.268
 *
 * Mike: "in portfolio loans on the loan app it asks for the information on all properties.
 * Address, Bedrooms, Bathrooms, sq footage, estimated property value, existing debt if any,
 * monthly rent, annual taxes, annual insurance, annual HOA. Those should all be put into the
 * property/collateral section for that property and then summed up in the Portfolio total."
 *
 * The long application (borrower-info.html) collects one row per property into
 * data.properties[] (data.propertyType === 'portfolio', data.propertyCount = N). This module is
 * the one place that turns those rows into the loan's Property / Collateral rows
 * (loan.properties[i] -- the numbered tabs on Loan Details, whose Portfolio Total tab sums them)
 * and into the totals the application shows and prints. The sync (at save / sign), the
 * signed-application PDF and the prefill all use it; borrower-info.html mirrors the same
 * arithmetic in ES5 (pfComputeTotals).
 *
 * Loan Details keeps taxes / insurance / HOA MONTHLY (monthlyTaxes ...) because the sizer prices
 * from those; the application asks ANNUAL (as the single-property form always has), so each row
 * carries both: the annual figure as typed, and the monthly figure derived from it (to the cent).
 */

export const APP_PROPERTY_FIELDS = ['address', 'bedrooms', 'bathrooms', 'sqft', 'propValue', 'existingDebt', 'monthlyRent', 'annualTaxes', 'annualInsurance', 'annualHoa'];
export const MAX_PORTFOLIO_PROPERTIES = 10;
const ANNUAL_TO_MONTHLY = [['annualTaxes', 'monthlyTaxes'], ['annualInsurance', 'monthlyInsurance'], ['annualHoa', 'monthlyHoa']];

export function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 40);

export function isPortfolioApplication(data) {
  return String((data || {}).propertyType || '') === 'portfolio';
}

/** The application's rows, sanitized: known fields only, strings capped, at most 10 rows. */
export function applicationProperties(data) {
  const rows = Array.isArray((data || {}).properties) ? data.properties : [];
  return rows.slice(0, MAX_PORTFOLIO_PROPERTIES).map((p) => {
    p = (p && typeof p === 'object') ? p : {};
    const out = {};
    APP_PROPERTY_FIELDS.forEach((k) => { out[k] = clean(p[k], k === 'address' ? 200 : 40); });
    return out;
  });
}

/** Sums across rows (application rows or loan rows; a field a row lacks counts 0). */
export function portfolioTotals(rows) {
  const t = { count: 0, bedrooms: 0, bathrooms: 0, sqft: 0, propValue: 0, existingDebt: 0, monthlyRent: 0, annualTaxes: 0, annualInsurance: 0, annualHoa: 0 };
  (rows || []).forEach((p) => {
    if (!p) return;
    t.count++;
    Object.keys(t).forEach((k) => { if (k !== 'count') t[k] += num(p[k]); });
  });
  Object.keys(t).forEach((k) => { t[k] = Math.round(t[k] * 100) / 100; });
  return t;
}

/** An annual figure as the loan keeps it: monthly, to the cent ('' stays ''). */
export function monthlyFromAnnual(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '';
  return String(Math.round((num(v) / 12) * 100) / 100);
}

/**
 * The loan's Property / Collateral rows after the application: each answer lands on the row in
 * the same position, a blank answer never clears what the LO typed, and the fields the
 * application does not ask (propType, appraisedValue, ...) are kept, as are any extra LO rows
 * beyond the application's count. Returns null when the application is not a portfolio.
 */
export function mergePortfolioIntoLoan(loan, data) {
  if (!isPortfolioApplication(data)) return null;
  const rows = applicationProperties(data);
  if (!rows.length) return null;
  const existing = (loan && Array.isArray(loan.properties)) ? loan.properties : [];
  const properties = [];
  const n = Math.max(rows.length, existing.length);
  for (let i = 0; i < n; i++) {
    const cur = Object.assign({}, (existing[i] && typeof existing[i] === 'object') ? existing[i] : {});
    const app = rows[i];
    if (app) {
      APP_PROPERTY_FIELDS.forEach((k) => { if (app[k] !== '') cur[k] = app[k]; });
      ANNUAL_TO_MONTHLY.forEach(([a, m]) => { if (app[a] !== '') cur[m] = monthlyFromAnnual(app[a]); });
    }
    properties.push(cur);
  }
  const count = Math.max(properties.length, parseInt((data || {}).propertyCount, 10) || 0, parseInt((loan || {}).propertyCount, 10) || 0);
  return { isPortfolio: true, propType: 'portfolio', propertyCount: Math.min(count, MAX_PORTFOLIO_PROPERTIES), properties };
}

/**
 * What a portfolio loan hands the application to prefill its cards: the loan's rows in the
 * application's shape. Annual taxes / insurance / HOA come from the MONTHLY figures Loan Details
 * edits (x12), falling back to an annual figure a previous application left on the row.
 * Returns null for a loan that is not a portfolio.
 */
export function loanPortfolioPrefill(loan) {
  if (!loan || !loan.isPortfolio) return null;
  const rows = (Array.isArray(loan.properties) ? loan.properties : []).slice(0, MAX_PORTFOLIO_PROPERTIES);
  const annual = (m, a) => (num(m) > 0 ? String(Math.round(num(m) * 12)) : clean(a));
  return {
    propertyCount: Math.min(parseInt(loan.propertyCount, 10) || rows.length || 0, MAX_PORTFOLIO_PROPERTIES),
    properties: rows.map((p) => {
      p = (p && typeof p === 'object') ? p : {};
      return {
        address: clean(p.address, 200), bedrooms: clean(p.bedrooms), bathrooms: clean(p.bathrooms), sqft: clean(p.sqft),
        propValue: clean(p.propValue), existingDebt: clean(p.existingDebt), monthlyRent: clean(p.monthlyRent),
        annualTaxes: annual(p.monthlyTaxes, p.annualTaxes), annualInsurance: annual(p.monthlyInsurance, p.annualInsurance), annualHoa: annual(p.monthlyHoa, p.annualHoa),
      };
    }),
  };
}
