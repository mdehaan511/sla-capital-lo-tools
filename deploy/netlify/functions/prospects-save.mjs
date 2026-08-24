/**
 * prospects-save.js — POST /api/prospects-save
 *
 * PUBLIC endpoint (no auth required) — called by apply.html when a
 * borrower submits the loan application form. Writes the prospect to
 * Netlify Blobs under the LO's slug, then emails the LO so they
 * know a new application came in.
 *
 * Body: the full prospect object from apply.html.
 *
 * Basic abuse protection:
 *   - Rejects prospects without at least an email and a name.
 *   - Enforces a max body size.
 *   - Does not echo anything sensitive back to the caller.
 */
import { getStore } from '@netlify/blobs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398
import {
  handleOptions, json, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.5 (Brokers Phase 3b) — when a prospect carries broker
// fields (apply.html broker mode in Phase 3c), resolve or create the
// broker entity in the LO's book so the materialized loan lands with
// a brokerId already set.
import { linkOrCreateBroker } from './_shared/broker-link.mjs';
// Deploy 236.295 — Slack notification for every apply submission.
// Uses the admin-managed webhook URL (settings blob key 'slack_webhook')
// so operations can rotate it without redeploying.
import { postSlack } from './_shared/slack.mjs';
import { prospectsIndex } from './_shared/prospects-index.mjs'; // Deploy 236.343
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on the OPEN apply form.
import { checkRateLimit } from './_shared/rate-limit.mjs';
// Deploy 236.635 — broker submissions name the borrower they represent; link that
// borrower to the loan as a Guarantor client (shared dedupe-by-email helper).
import { linkGuarantorToLoan } from './_shared/guarantor-link.mjs';
import { logBorrowerSendFromResponse } from './_shared/email.mjs';

const MAX_BODY_BYTES = 32 * 1024; // 32 KB is plenty for a form payload

// Deploy 236.282 — House account for neutral /apply leads that match
// no existing broker/borrower relationship. Chance triages these so no
// lead falls on the floor. Constant (not a settings value) per the
// explicit product decision — change this one line if the triage owner
// ever changes.
const HOUSE_ACCOUNT_EMAIL = 'chance@slacapital.com';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  // Deploy 236.445 (F1) — the apply form is fully open (no token). Cap
  // submissions per IP so it can't be spammed. 10/min tolerates a real
  // applicant's retries while stopping bulk abuse. Fails open on a
  // storage blip (see rate-limit.mjs).
  const _rl = await checkRateLimit(req, context, { bucket: 'apply', max: 10, windowSec: 60 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many submissions. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  // Size guard
  const cl = req.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
    return json(413, { error: 'Payload too large' });
  }

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body) return json(400, { error: 'Empty body' });

  // Minimum viable prospect
  const email = normalizeEmail(body.email);
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const submitterType = String(body.submitterType || 'borrower').toLowerCase();
  const brokerEmail = normalizeEmail(body.brokerEmail);
  const brokerName  = String(body.brokerName || '').trim();
  // Deploy 236.272 — broker submissions send borrower fields empty by
  // design (client-side validation skipped in 236.227 for broker mode
  // because the borrower's contact info gets captured at Advance to
  // Approved, not at prospect submission). Server-side validation was
  // never updated to match, so broker submits hit "Valid email required"
  // and 400'd. Validate against the appropriate field set depending on
  // submitterType.
  if (submitterType === 'broker') {
    if (!brokerEmail || !brokerEmail.includes('@')) return json(400, { error: 'Valid broker email required' });
    if (!brokerName) return json(400, { error: 'Broker name required' });
    if (brokerEmail.length > 200) return json(400, { error: 'Invalid broker email' });
    // Deploy 236.635 — the borrower the broker represents. Their email must be
    // their OWN; matching the broker's email means the borrower email is missing.
    // (Lenient on absent fields so a stale cached form still submits — the
    // guarantor is only created when borrower info is present.)
    const _bbEmail = normalizeEmail(body.borrowerEmail);
    if (_bbEmail && _bbEmail === brokerEmail) {
      return json(400, { error: "The borrower's email is required — it can't be the same as the broker's email." });
    }
  } else {
    if (!email || !email.includes('@')) return json(400, { error: 'Valid email required' });
    if (!firstName && !lastName) return json(400, { error: 'Name required' });
    if (email.length > 200) return json(400, { error: 'Invalid email' });
  }

  // Build sanitized prospect record (don't trust anything from the client)
  const now = new Date().toISOString();
  const id = body.id || ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const loSlug = keySafe(String(body.loSlug || 'unassigned')) || 'unassigned';

  // Deploy 236.655 — Portfolio (multiple properties). This is a public,
  // unauthenticated endpoint, so hard-sanitize the array: cap at 10 items and
  // string-cap every field. propertyCount drives the number of tabs on Loan
  // Details even when the borrower didn't fill any detail in.
  const _isPortfolio = (String(body.propType || '') === 'portfolio');
  let _propertyCount = _isPortfolio ? (parseInt(body.propertyCount, 10) || 0) : 0;
  if (_propertyCount < 0) _propertyCount = 0;
  if (_propertyCount > 10) _propertyCount = 10;
  const _rawProps = (_isPortfolio && Array.isArray(body.properties)) ? body.properties : [];
  const _safeProperties = _rawProps.slice(0, 10).map(function (p) {
    p = (p && typeof p === 'object') ? p : {};
    return {
      address:          String(p.address || '').slice(0, 300),
      propType:         String(p.propType || '').slice(0, 40),
      bedrooms:         String(p.bedrooms || '').slice(0, 10),
      bathrooms:        String(p.bathrooms || '').slice(0, 10),
      sqft:             String(p.sqft || '').slice(0, 12),
      // Deploy 236.657 — per-property valuation (LO-entered on Loan Details;
      // blank from the borrower app, but kept for shape symmetry).
      propValue:        String(p.propValue || '').slice(0, 15),
      appraisedValue:   String(p.appraisedValue || '').slice(0, 15),
      existingDebt:     String(p.existingDebt || '').slice(0, 15),
      monthlyRent:      String(p.monthlyRent || '').slice(0, 15),
      monthlyTaxes:     String(p.monthlyTaxes || '').slice(0, 15),
      monthlyInsurance: String(p.monthlyInsurance || '').slice(0, 15),
      monthlyHoa:       String(p.monthlyHoa || '').slice(0, 15),
    };
  });

  const prospect = {
    id,
    submittedAt: now,
    loSlug,
    loDisplay: String(body.loDisplay || ''),
    firstName, lastName,
    email,
    phone: String(body.phone || ''),
    usCitizen: String(body.usCitizen || ''),
    creditScore: String(body.creditScore || ''),
    propAddress: String(body.propAddress || ''),
    propType: String(body.propType || ''),
    bedrooms: String(body.bedrooms || ''),
    bathrooms: String(body.bathrooms || ''),
    sqft: String(body.sqft || ''),
    // Deploy 236.655 — Portfolio (multiple properties). See sanitizer above.
    isPortfolio: _isPortfolio,
    propertyCount: _propertyCount,
    portfolioSubmitAll: String(body.portfolioSubmitAll || '').slice(0, 8),
    properties: _safeProperties,
    loanProduct: String(body.loanProduct || ''),
    loanPurpose: String(body.loanPurpose || ''),
    currentLoanAmt: String(body.currentLoanAmt || ''),
    projectDescription: String(body.projectDescription || ''),
    rentalType: String(body.rentalType || ''),
    purchasePrice: String(body.purchasePrice || ''),
    propertyValue: String(body.propertyValue || ''),
    rehabCost: String(body.rehabCost || ''),
    estimatedARV: String(body.estimatedARV || ''),
    flipsCompleted: String(body.flipsCompleted || ''),
    monthlyRent: String(body.monthlyRent || ''),
    monthlyTaxes: String(body.monthlyTaxes || ''),
    monthlyInsurance: String(body.monthlyInsurance || ''),
    monthlyHOA: String(body.monthlyHOA || ''),
    fundingDate: String(body.fundingDate || ''),
    status: 'new',
    // Deploy 236.14 — Phase 3c broker fields. The sanitized prospect
    // record previously DROPPED these fields because they weren't in
    // this allowlist. Downstream code (notifyLO, upsertClientFromProspect,
    // linkOrCreateBroker) all read from this prospect object, so
    // omitting them here meant Phase 3c was a silent no-op even though
    // apply.html was correctly POSTing the data.
    submitterType: String(body.submitterType || 'borrower'),
    brokerName:    String(body.brokerName    || ''),
    brokerCompany: String(body.brokerCompany || ''),
    brokerEmail:   String(body.brokerEmail   || '').toLowerCase().trim(),
    brokerPhone:   String(body.brokerPhone   || ''),
    // Deploy 236.635 — the borrower a broker is representing. MUST be allowlisted
    // here or it's silently dropped (see the broker-fields note above).
    // upsertClientFromProspect stamps these onto the loan + links the borrower as
    // a Guarantor client.
    borrowerFirstName: String(body.borrowerFirstName || '').trim().slice(0, 100),
    borrowerLastName:  String(body.borrowerLastName  || '').trim().slice(0, 100),
    borrowerEmail:     String(body.borrowerEmail     || '').toLowerCase().trim().slice(0, 200),
    // Deploy 236.464 — marketing referral source captured from ?ref= on
    // apply.html (links from slacapital.ai). MUST be in this allowlist or
    // it's silently dropped (see the broker-fields note above). Length-
    // capped since this is a public, unauthenticated endpoint.
    ref:           String(body.ref || '').slice(0, 200),
  };

  // Deploy 236.282 (neutral-apply auto-routing) — decide who owns this lead.
  // Four ways a lead arrives, in precedence order:
  //   1. Explicit ?lo= link (email OR slug form)  → route to that LO.
  //      Slug form resolves via profiles store so LO-specific links keep
  //      working even when they use a display-slug not a raw email.
  //   2. Broker email match  → auto-assign to that broker's LO.
  //      Broker wins over borrower per the product rule (the broker who
  //      brought the deal owns it).
  //   3. Borrower email match → auto-assign to that client's existing LO.
  //   4. No match at all → house account so a human (Chance) triages.
  //      Previously an unrouted submission became an "unassigned" prospect
  //      with no client/loan record and only a settings.submit_email note.
  //      Now every lead becomes a real client + loan under a real owner.
  const routing = await resolveOwner({
    incomingLoSlug: String(body.loSlug || ''),
    brokerEmail:    prospect.brokerEmail,
    borrowerEmail:  prospect.email,
  });
  const loEmail = routing.loEmail;
  const ownerKey = keySafe(loEmail);

  prospect.loEmail = loEmail;
  prospect.loSlug = ownerKey; // keep in sync with resolved owner
  prospect.assignmentSource = routing.source; // 'link' | 'broker' | 'borrower' | 'house'

  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const key = `${ownerKey}/${keySafe(id)}`;

  try {
    await store.setJSON(key, prospect);
    prospectsIndex.upsertRecord(ownerKey, prospect).catch(() => {});
  } catch (e) {
    console.error('prospects-save write error:', e);
    return json(500, { error: 'Failed to save application' });
  }

  // Auto-create a Client record under the LO so they see this in Clients.
  // Only when we have a valid LO email.
  let ids = null;
  if (loEmail && loEmail.includes('@')) {
    try {
      ids = await upsertClientFromProspect(prospect, loEmail);
    } catch (e) {
      console.warn('prospects-save: client upsert failed:', e);
    }
  }

  // Notify the LO by email — best-effort, don't fail the submission if email fails
  try {
    await notifyLO(prospect, ids);
  } catch (e) {
    console.error('prospects-save notify error:', e);
  }
  // Item #1: also send an applicant confirmation showing all the fields
  // that were submitted, so the person can double-check for mistakes.
  // Deploy 236.285 — for broker submits, this goes to the broker's email.
  try {
    await notifyApplicantOfSubmission(prospect);
  } catch (e) {
    console.error('prospects-save applicant notify error:', e);
  }
  // Deploy 236.295 — post to the team Slack channel so the whole team
  // sees each new lead in real time (in addition to the LO email). No-op
  // when the admin hasn't configured a webhook URL. Best-effort — never
  // throws, never blocks the submit response.
  try {
    await notifySlack(prospect, ids);
  } catch (e) {
    console.error('prospects-save slack notify error:', e);
  }

  return json(200, { ok: true, id });
};

// Auto-create or update a Client record + initial Loan from a prospect submission
async function upsertClientFromProspect(prospect, loEmail) {
  // Deploy 236.287 — extensive logging + parallelized owner-scoped scan.
  // Prior version silently returned on any exception, making broker
  // submissions hard to diagnose when the loan didn't materialize.
  const tag = `[apply-upsert p=${prospect.id || '?'}]`;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(normalizeEmail(loEmail));
  const isBrokerSubmission = String(prospect.submitterType || '').toLowerCase() === 'broker';
  const lookupEmail = isBrokerSubmission
    ? normalizeEmail(prospect.brokerEmail)
    : normalizeEmail(prospect.email);
  if (!lookupEmail) {
    console.warn(`${tag} skipped: no lookup email (isBroker=${isBrokerSubmission}, brokerEmail=${!!prospect.brokerEmail}, email=${!!prospect.email})`);
    return;
  }
  console.log(`${tag} start owner=${ownerKey} lookup=${lookupEmail} isBroker=${isBrokerSubmission}`);

  // Search this LO's clients for an existing match by lookup email.
  // Deploy 236.387 — direct Postgres lookup (owner_email + email)
  // replaces the owner-prefix blob walk. Big books (the house account
  // especially) made that walk seconds-long on a PUBLIC endpoint. PG
  // only supplies the client id; the authoritative full record is
  // then fetched from the blob store by key, so the read-modify-write
  // below still operates on the blob source of truth. ilike with no
  // wildcards = case-insensitive equality (PG stores email verbatim,
  // mixed-case hand-typed records exist); `_` is a single-char LIKE
  // wildcard so exact normalized equality is re-verified in JS. Any
  // PG failure falls through with existing=null → creates a fresh
  // client, same as the old walk's failure path.
  let existing = null;
  let existingKey = null;
  try {
    const rows = await _pgFetch('clients',
      'select=' + encodeURIComponent('id,email') +
      '&owner_email=eq.' + encodeURIComponent(normalizeEmail(loEmail)) +
      '&email=ilike.' + encodeURIComponent(lookupEmail) +
      '&order=updated_at.desc&limit=10');
    const hit = (rows || []).find((r) => r && r.id && normalizeEmail(r.email || '') === lookupEmail);
    if (hit) {
      const key = ownerKey + '/' + keySafe(hit.id);
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (rec) { existing = rec; existingKey = key; }
      else console.warn(`${tag} PG matched client ${hit.id} but blob missing at ${key} — treating as new`);
    }
    console.log(`${tag} PG lookup done — existing=${!!existing}${existingKey ? ' key=' + existingKey : ''}`);
  } catch (e) {
    console.warn(`${tag} client lookup failed:`, e && e.message);
  }

  // Build a loan record from the application
  // RTL family covers fix_flip, bridge, and transactional — all route to
  // the RTL sizer (toolType=rtl). DSCR is the only non-RTL product today.
  const RTL_PRODUCTS = ['fix_flip', 'rtl', 'bridge', 'transactional'];
  const isRtl = RTL_PRODUCTS.indexOf(prospect.loanProduct) >= 0;
  // Map prospect.loanProduct → loan.loanType (the RTL sizer's sub-type
  // dropdown). 'bridge' and 'transactional' map directly. 'fix_flip' is
  // intentionally blank — the RTL sizer's auto-pick logic picks light vs
  // heavy from the rehab-to-loan ratio after the prospect lands.
  let loanTypeForRecord = '';
  if (prospect.loanProduct === 'bridge')        loanTypeForRecord = 'bridge';
  else if (prospect.loanProduct === 'transactional') loanTypeForRecord = 'transactional';
  // 'fix_flip', 'rtl', 'dscr' all leave loanType blank

  // Deploy 236.297 — DSCR PURCHASE default loanAmt = 80% of purchase
  // price (the standard max LTV on DSCR). Without this, the sizer
  // opens with loanAmt == purchasePrice → 100% LTV → immediately
  // errors out with "LTV exceeds 80% maximum" until the LO manually
  // types the loan amount. Doesn't apply to refi (uses currentLoanAmt),
  // and doesn't apply to RTL (Mike: RTL loans size off ARV + rehab,
  // not off purchase price, so this rule is DSCR-purchase-only).
  const isDscrPurchase = !isRtl
    && String(prospect.loanPurpose || '').toLowerCase() === 'purchase';
  const _pxNum = parseFloat(String(prospect.purchasePrice || '').replace(/[^\d.]/g, '')) || 0;
  const _defaultLoanAmt = isDscrPurchase && _pxNum > 0
    ? String(Math.round(_pxNum * 0.80))
    : (prospect.purchasePrice || prospect.propertyValue || '');

  const loan = {
    id:          'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    // Deploy 236.22 — stamp prospectId on the loan so the pipeline
    // dedup can match prospect→loan deterministically instead of by
    // (ownerKey, address). Address-based dedup silently breaks when
    // the LO corrects the address on the sizer: the loan/quote update
    // but the prospect's propAddress stays at the original value, so
    // it resurfaces as a duplicate tile in "New Application". The
    // prospectId reference doesn't drift on address edits.
    prospectId:  prospect.id || '',
    toolType:    isRtl ? 'rtl' : 'dscr',
    address:     prospect.propAddress || '',
    savedAt:     new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    status:      'active',
    loanType:    loanTypeForRecord,
    loanAmt:     _defaultLoanAmt,
    // Deploy 236.297 — DSCR purchase: default property value to the
    // purchase price when the borrower didn't provide one separately.
    // LTV can't compute without a denominator, so an empty propValue
    // meant the LO had to re-key the purchase price into propValue
    // before the sizer would price anything.
    propValue:   prospect.propertyValue
                 || prospect.estimatedARV
                 || (isDscrPurchase ? (prospect.purchasePrice || '') : ''),
    rent:        prospect.monthlyRent || '',
    taxes:       prospect.monthlyTaxes || '',
    insurance:   prospect.monthlyInsurance || '',
    hoa:         prospect.monthlyHOA || '',
    bedrooms:    prospect.bedrooms || '',
    bathrooms:   prospect.bathrooms || '',
    sqft:        prospect.sqft || '',
    propType:    prospect.propType || '',
    // Deploy 236.655 — Portfolio (multiple properties). propertyCount drives the
    // number of Property/Collateral tabs on Loan Details (even when properties[]
    // is empty, e.g. the borrower chose "submit the totals"). properties[] carries
    // the per-property detail when the borrower filled each one in.
    isPortfolio:   !!prospect.isPortfolio,
    propertyCount: prospect.propertyCount || 0,
    properties:    Array.isArray(prospect.properties) ? prospect.properties : [],
    usCitizen:   prospect.usCitizen || '',
    loanPurpose: prospect.loanPurpose || '',
    rentalType:  prospect.rentalType || '',
    fundingDate: prospect.fundingDate || '',
    purchasePrice: prospect.purchasePrice || '',
    rehabBudget: prospect.rehabCost || '',
    arv:         prospect.estimatedARV || '',
    experience:  prospect.flipsCompleted || '',
    currentLoanAmt: prospect.currentLoanAmt || '',
    projectDescription: prospect.projectDescription || '',
    // Carry the borrower's stated credit-score range onto the loan
    // record so the sizer can map it to its own FICO dropdown when the
    // LO opens this loan. Without this, application-sourced loans
    // landed in the sizer with FICO unset, forcing the LO to re-key it.
    creditScore: prospect.creditScore || '',
    // Deploy 236.5 — broker fields from apply.html broker mode. Empty
    // when the prospect was filed by the borrower themselves. Captured
    // even when blank so the loan record schema stays consistent.
    brokerName:    prospect.brokerName    || '',
    brokerCompany: prospect.brokerCompany || '',
    brokerEmail:   prospect.brokerEmail   || '',
    brokerPhone:   prospect.brokerPhone   || '',
    brokerFee:     prospect.brokerFee     || '',
    // Deploy 236.635 — for broker submissions, the borrower the broker named. The
    // primary client is the broker, so the Rate Sheet + Loan Application PDFs read
    // these to show the BORROWER (not the broker). The borrower is also linked as
    // a Guarantor client below.
    borrowerName:  isBrokerSubmission ? ((prospect.borrowerFirstName || '') + ' ' + (prospect.borrowerLastName || '')).trim() : '',
    borrowerEmail: isBrokerSubmission ? normalizeEmail(prospect.borrowerEmail || '') : '',
    fromApplication: true,
    // Deploy 236.465 — carry the marketing referral source (?ref= captured on
    // apply.html) onto the loan so it's visible on the deal, not just the
    // prospect record. Also stamped on the client below.
    ref:           prospect.ref || '',
    // Deploy 236.227 (Broker Phase D) — flag broker submissions so
    // the loan starts with guarantors[] empty and Loan Details knows
    // to require borrower info at Advance to Approved.
    _isBrokerLoan: isBrokerSubmission,
    _borrowerInfoPending: isBrokerSubmission,
    guarantors: [], // populated at Phase E's borrower-info capture
  };

  // Deploy 236.5 — resolve the broker entity in the LO's book and bind
  // the loan to it. Best-effort: if it fails, the loan still saves with
  // inline broker fields, and Phase 5 migration will catch it later.
  try {
    if (loan.brokerName || loan.brokerEmail) {
      const linked = await linkOrCreateBroker(ownerKey, loan);
      if (linked && linked.id) {
        loan.brokerId = linked.id;
        const b = linked.broker || {};
        // Canonicalize inline fields from the broker record when the
        // entity already exists (subsequent submissions from the same
        // broker reuse the entity's stored name/company/etc).
        if (b.name)    loan.brokerName    = b.name;
        if (b.company) loan.brokerCompany = b.company;
        if (b.email)   loan.brokerEmail   = b.email;
        if (b.phone)   loan.brokerPhone   = b.phone;
      }
    }
  } catch (e) {
    console.warn('prospects-save: broker auto-link failed (non-fatal):', e && e.message);
  }

  const now = new Date().toISOString();
  let record;
  if (existing) {
    record = existing;
    if (isBrokerSubmission) {
      // Ensure the existing contact is flagged as a broker (it may
      // have been a plain contact before). The unified model lets
      // the same record wear both hats.
      record._isBroker = true;
      if (!record._brokerCompany && prospect.brokerCompany) {
        record._brokerCompany = prospect.brokerCompany;
      }
      if (!record.entityName && prospect.brokerCompany) {
        record.entityName = prospect.brokerCompany;
      }
    } else {
      if (!record.firstName && prospect.firstName) record.firstName = prospect.firstName;
      if (!record.lastName  && prospect.lastName)  record.lastName  = prospect.lastName;
      if (!record.phone     && prospect.phone)     record.phone     = prospect.phone;
      if (!record.usCitizen && prospect.usCitizen) record.usCitizen = prospect.usCitizen;
    }
    record.loans = record.loans || [];
    record.loans.unshift(loan);
    record.updatedAt = now;
  } else if (isBrokerSubmission) {
    // Fresh client record for a broker who's never submitted before.
    // Split their full name into first/last for the standard client
    // shape; stamp _isBroker so they show up in the Broker Book too.
    const nameParts = String(prospect.brokerName || '').trim().replace(/\s+/g, ' ').split(' ');
    const brokerFirstName = nameParts.length === 1
      ? nameParts[0]
      : nameParts.slice(0, -1).join(' ');
    const brokerLastName = nameParts.length === 1 ? '' : nameParts[nameParts.length - 1];
    record = {
      id:         'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      email:      lookupEmail,
      firstName:  brokerFirstName,
      lastName:   brokerLastName,
      phone:      prospect.brokerPhone   || '',
      entityName: prospect.brokerCompany || '',
      displayName: prospect.brokerName   || '',
      _isBroker:  true,
      _brokerCompany: prospect.brokerCompany || '',
      createdAt:  now,
      updatedAt:  now,
      createdBy:  loEmail,
      loans:      [loan],
      fromApplication: true,
    };
    existingKey = ownerKey + '/' + keySafe(record.id);
  } else {
    record = {
      id:        'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      email:     lookupEmail,
      firstName: prospect.firstName || '',
      lastName:  prospect.lastName  || '',
      phone:     prospect.phone     || '',
      usCitizen: prospect.usCitizen || '',
      createdAt: now,
      updatedAt: now,
      createdBy: loEmail,
      loans:     [loan],
      fromApplication: true,
    };
    existingKey = ownerKey + '/' + keySafe(record.id);
  }
  // Deploy 236.465 — stamp the marketing referral source (?ref=) on the client
  // too, across all branches. First ref wins — don't overwrite an existing one
  // on a returning contact who came back through a different link.
  if (prospect.ref && !record.ref) record.ref = prospect.ref;

  // Deploy 236.635 — add the borrower the broker named as a Guarantor client on
  // this loan. Non-fatal: a link failure must not cost the LO the loan. The
  // dedupe-by-email helper mutates loan.guarantorClientIds on `loan` (which lives
  // in record.loans) + writes the guarantor client; the writeClient(record) below
  // then persists the primary (broker) client with the link in place.
  if (isBrokerSubmission && prospect.borrowerEmail) {
    const _bEmail = normalizeEmail(prospect.borrowerEmail);
    if (_bEmail && _bEmail !== lookupEmail) {
      try {
        await linkGuarantorToLoan({
          ownerKey,
          primaryClientId: record.id,
          loanId: loan.id,
          primary: record,
          loan,
          clientsStore,
          guarantor: {
            firstName: prospect.borrowerFirstName || '',
            lastName:  prospect.borrowerLastName  || '',
            email:     _bEmail,
          },
          createdVia: '_createdViaBrokerApply',
        });
        console.log(`${tag} linked borrower guarantor ${_bEmail} to loan ${loan.id}`);
      } catch (e) {
        console.warn(`${tag} borrower guarantor link failed (non-fatal):`, e && e.message);
      }
    }
  }

  try {
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
    await writeClient(ownerKey, record, { clientsStore });
    console.log(`${tag} saved client=${record.id} loan=${loan.id} loans=${record.loans.length}`);
  } catch (e) {
    console.error(`${tag} setJSON failed:`, e && e.message);
    throw e;
  }
  // Deploy 236.284 — return ids so the LO notify can deep-link to the
  // Loan Details page for this loan. Was previously fire-and-forget.
  return { clientId: record.id, loanId: loan.id };
}

// ── LO notification via Resend ───────────────────────────────────────
async function notifyLO(prospect, ids) {
  // Deploy 236.285 — log tag makes it easy to grep Netlify function
  // logs and see exactly why an LO didn't receive their notification
  // (missing key, no email resolved, or Resend rejection).
  const tag = `[apply-notify LO p=${prospect.id || '?'} src=${prospect.assignmentSource || '?'}]`;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(`${tag} skipped: RESEND_API_KEY not set`);
    return;
  }

  // Send directly to the LO whose email is on the prospect (resolved from
  // the URL slug). Fall back to settings.submit_email or env default if
  // for some reason loEmail isn't set.
  let toEmail = prospect.loEmail || '';
  if (!toEmail) {
    const settings = getStore({ name: 'settings', consistency: 'strong' });
    try {
      const fallback = await settings.get('submit_email', { type: 'json' });
      if (fallback && fallback.value) toEmail = fallback.value;
    } catch (_) { /* ignore */ }
  }
  if (!toEmail) toEmail = process.env.DEFAULT_SUBMIT_EMAIL || '';
  if (!toEmail) {
    console.warn(`${tag} skipped: no LO email available`);
    return;
  }
  console.log(`${tag} sending → ${toEmail}`);

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const name = `${prospect.firstName} ${prospect.lastName}`.trim();
  const fmtMoney = (v) => v ? '$' + Number(v).toLocaleString() : '';

  // Deploy 236.6 — flag broker-submitted apps in the subject so the LO
  // sees the source at a glance. apply.html Phase 3c sets submitterType
  // to 'broker' when a broker is filling out on behalf of a borrower.
  // Deploy 236.272 — broker submissions send borrower name/email empty,
  // so fall back to broker name/property address so the subject line
  // isn't left with a trailing "— " and no context.
  const isBrokerApp = prospect.submitterType === 'broker';
  const brokerHint  = prospect.brokerName || prospect.brokerCompany || prospect.brokerEmail || '';
  const propHint    = prospect.propAddress || '';
  const isUnrouted  = prospect.assignmentSource === 'house';
  const routedTag   = isUnrouted ? '[UNROUTED] ' : '';
  const subject = isBrokerApp
    ? `${routedTag}New loan application (via broker) — ${brokerHint || propHint || 'new prospect'}`
    : `${routedTag}New loan application — ${name || prospect.email || propHint || 'new prospect'}`;

  // Deploy 236.282 — tell the recipient HOW this lead routed to them.
  // Explicit ?lo= link → no banner (unchanged).
  // Auto-matched     → green banner explaining the match.
  // House account    → red banner asking for triage.
  const routingLine =
    prospect.assignmentSource === 'broker'   ? 'Auto-assigned to you — matched an existing broker in your book.' :
    prospect.assignmentSource === 'borrower' ? 'Auto-assigned to you — matched an existing client of yours.' :
    prospect.assignmentSource === 'house'    ? 'Unassigned website lead — no existing broker or client matched. Please triage / reassign.' :
    '';

  // Deploy 236.284 — deep-link to Loan Details for this specific loan.
  // The auto-created loan lives under the assigned LO's clients store,
  // so opening the link resolves to the LO's own loan (no ?owner=
  // override needed). Absent when upsert didn't run (rare — only if
  // no LO email was resolvable, but the routing fallback to Chance
  // means that's now vanishingly unlikely).
  //
  // Deploy 236.285 — append &fresh=1 so loan-details.js bypasses the
  // 5-min SWR cache in sla-api.js's SLA.Clients.list(). Without this,
  // the recipient's stale cached client list wouldn't include the loan
  // that was just created — the loan showed as "not found" for up to
  // 5 minutes until the background refresh finally repainted.
  //
  // Deploy 236.298 — include ?owner=<lo> so the link works even if the
  // recipient isn't the owning LO (forwarded emails, admin bcc, house-
  // account triage). loan-details.js checks for the owner param and
  // switches to all-scope search when it's present.
  const _ownerParam = prospect.loEmail
    ? `&owner=${encodeURIComponent(prospect.loEmail)}`
    : '';
  const detailsLink = (ids && ids.loanId)
    ? `https://portal.slacapital.ai/loan-details/${encodeURIComponent(ids.loanId)}?fresh=1${_ownerParam}`
    : '';

  // Deploy 236.284 — build the plain-text body as an array of entries,
  // dropping any field the applicant didn't fill out. `push` is verbose
  // but keeps the emitted section order obvious and lets each field
  // decide independently whether it renders.
  const bbSqft = [prospect.bedrooms, prospect.bathrooms, prospect.sqft].filter(v => v && String(v).trim()).length;
  const textLines = [];
  textLines.push(`New loan application submitted ${fmtDateTime(prospect.submittedAt)}`);
  if (routingLine) textLines.push(routingLine);
  textLines.push('');
  if (isBrokerApp) {
    textLines.push(`Submitted by Broker: ${prospect.brokerName || ''}`.trim());
    if (prospect.brokerCompany) textLines.push(`  Company: ${prospect.brokerCompany}`);
    if (prospect.brokerEmail)   textLines.push(`  Email:   ${prospect.brokerEmail}`);
    if (prospect.brokerPhone)   textLines.push(`  Phone:   ${prospect.brokerPhone}`);
    textLines.push('');
  }
  if (name)                    textLines.push(`Borrower: ${name}`);
  if (prospect.email)          textLines.push(`Email:    ${prospect.email}`);
  if (prospect.phone)          textLines.push(`Phone:    ${prospect.phone}`);
  if (prospect.creditScore)    textLines.push(`Credit:   ${prospect.creditScore}`);
  if (prospect.usCitizen)      textLines.push(`US Citizen: ${prospect.usCitizen}`);
  if (prospect.propAddress || prospect.propType || bbSqft) textLines.push('');
  if (prospect.propAddress)    textLines.push(`Property: ${prospect.propAddress}`);
  if (prospect.propType)       textLines.push(`Type:     ${prospect.propType}`);
  if (bbSqft) {
    const b = prospect.bedrooms  || '?';
    const ba = prospect.bathrooms || '?';
    const sq = prospect.sqft      || '?';
    textLines.push(`Beds/Baths/SqFt: ${b}/${ba}/${sq}`);
  }
  const hasLoanSection = prospect.loanProduct || prospect.loanPurpose || prospect.purchasePrice
    || prospect.propertyValue || prospect.currentLoanAmt || prospect.rehabCost || prospect.estimatedARV
    || prospect.flipsCompleted || prospect.monthlyRent || prospect.fundingDate || prospect.projectDescription;
  if (hasLoanSection) textLines.push('');
  if (prospect.loanProduct)    textLines.push(`Product:  ${prospect.loanProduct}`);
  if (prospect.loanPurpose)    textLines.push(`Purpose:  ${prospect.loanPurpose}`);
  if (prospect.purchasePrice)  textLines.push(`Purchase: ${fmtMoney(prospect.purchasePrice)}`);
  if (prospect.propertyValue)  textLines.push(`Value:    ${fmtMoney(prospect.propertyValue)}`);
  if (prospect.currentLoanAmt) textLines.push(`Current Loan: ${fmtMoney(prospect.currentLoanAmt)}`);
  if (prospect.rehabCost)      textLines.push(`Rehab:    ${fmtMoney(prospect.rehabCost)}`);
  if (prospect.estimatedARV)   textLines.push(`ARV:      ${fmtMoney(prospect.estimatedARV)}`);
  if (prospect.flipsCompleted) textLines.push(`Flips Completed (36mo): ${prospect.flipsCompleted}`);
  if (prospect.monthlyRent)    textLines.push(`Rent:     ${fmtMoney(prospect.monthlyRent)}`);
  if (prospect.fundingDate)    textLines.push(`Funding:  ${fmtDate(prospect.fundingDate)}`);
  if (prospect.projectDescription) textLines.push(`Project:  ${prospect.projectDescription}`);
  if (detailsLink) {
    textLines.push('');
    textLines.push(`Open Loan Details: ${detailsLink}`);
  }
  const text = textLines.join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — New Loan Application</h1>' +
    `<p style="color:rgba(255,255,255,.5);font-size:12px;margin:4px 0 0">Submitted ${esc(fmtDateTime(prospect.submittedAt))}</p></div>` +
    '<div style="padding:24px">' +
    // Deploy 236.282 — routing banner (auto-assigned / triage). Only shown
    // when the lead didn't arrive via an explicit ?lo= link.
    (routingLine
      ? '<div style="background:' + (isUnrouted ? 'rgba(124,31,31,0.08)' : 'rgba(37,105,64,0.08)') + ';border:1px solid ' + (isUnrouted ? 'rgba(124,31,31,0.28)' : 'rgba(37,105,64,0.28)') + ';border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#1a1520">' + esc(routingLine) + '</div>'
      : '') +
    (isBrokerApp && (prospect.brokerName || prospect.brokerEmail || prospect.brokerCompany || prospect.brokerPhone)
      ? '<div style="background:rgba(200,129,58,0.10);border:1px solid rgba(200,129,58,0.28);border-radius:8px;padding:12px 14px;margin-bottom:16px">' +
          '<div style="font-size:10px;font-weight:600;color:#b5712d;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Submitted by Broker</div>' +
          (prospect.brokerName
            ? `<div style="font-size:13px;font-weight:600;color:#1a1520">${esc(prospect.brokerName)}` +
                (prospect.brokerCompany ? ` <span style="font-weight:400;color:#7a7488">· ${esc(prospect.brokerCompany)}</span>` : '') +
              '</div>'
            : (prospect.brokerCompany ? `<div style="font-size:13px;font-weight:600;color:#1a1520">${esc(prospect.brokerCompany)}</div>` : '')) +
          ((prospect.brokerEmail || prospect.brokerPhone)
            ? `<div style="font-size:12px;color:#7a7488;margin-top:2px">${esc([prospect.brokerEmail, prospect.brokerPhone].filter(Boolean).join(' · '))}</div>`
            : '') +
        '</div>'
      : '') +
    (name || prospect.email
      ? `<h2 style="font-size:15px;margin:0 0 12px">${esc(name || prospect.email)}</h2>`
      : '') +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    row('Email', esc(prospect.email)) +
    row('Phone', esc(prospect.phone)) +
    row('Credit Score', esc(prospect.creditScore)) +
    row('US Citizen', esc(prospect.usCitizen)) +
    row('Property', esc(prospect.propAddress)) +
    row('Property Type', esc(prospect.propType)) +
    row('Beds / Baths / SqFt', bbSqft ? `${esc(prospect.bedrooms || '?')} / ${esc(prospect.bathrooms || '?')} / ${esc(prospect.sqft || '?')}` : '') +
    row('Loan Product', esc(prospect.loanProduct)) +
    row('Purpose', esc(prospect.loanPurpose)) +
    row('Purchase Price', fmtMoney(prospect.purchasePrice)) +
    row('Property Value', fmtMoney(prospect.propertyValue)) +
    row('Current Loan', fmtMoney(prospect.currentLoanAmt)) +
    row('Rehab Cost', fmtMoney(prospect.rehabCost)) +
    row('ARV', fmtMoney(prospect.estimatedARV)) +
    row('Flips Completed (36mo)', esc(prospect.flipsCompleted)) +
    row('Monthly Rent', fmtMoney(prospect.monthlyRent)) +
    row('Funding Date', esc(fmtDate(prospect.fundingDate))) +
    row('Project Description', esc(prospect.projectDescription)) +
    '</table>' +
    // Deploy 236.284 — CTA button. When we have IDs (client + loan), the
    // recipient can jump straight into Loan Details for this prospect.
    (detailsLink
      ? `<p style="margin-top:22px"><a href="${detailsLink}" style="display:inline-block;background:#DA7238;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;font-size:13px;font-family:Arial,sans-serif">Open Loan Details →</a></p>`
      : '<p style="margin-top:20px;font-size:12px;color:#666">View in Prospects to import to a loan sizer.</p>') +
    '</div></div></body></html>';

  const payload = JSON.stringify({
    from: 'SLA Capital <noreply@leads.slacapital.com>',
    to: [toEmail],
    subject,
    text,
    html,
    // Deploy 236.6 — reply_to. For broker-submitted apps we lead with
    // the broker (they're the active contact), but include the borrower
    // too so the LO can reply-all. For self-submitted apps, just the
    // borrower as before.
    reply_to: isBrokerApp
      ? [prospect.brokerEmail, prospect.email].filter(Boolean)
      : (prospect.email || undefined),
  });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: payload,
  });
  const respBody = await resp.text().catch(() => '');
  console.log(`${tag} Resend ${resp.status}: ${respBody.slice(0, 200)}`);
  if (!resp.ok) {
    throw new Error(`Resend ${resp.status}: ${respBody.slice(0, 200)}`);
  }
}

// Deploy 236.284 — emit a row only when the value is present. Emails now
// show only fields the applicant filled out; empty fields disappear
// entirely instead of showing an em-dash placeholder.
function row(label, value) {
  const v = value == null ? '' : String(value).trim();
  if (!v || v === '—') return '';
  return `<tr><td style="padding:6px 0;color:#666;width:160px">${label}</td><td style="padding:6px 0;color:#1a1520">${v}</td></tr>`;
}

// Deploy 236.284 — date formatting. Form date inputs come as YYYY-MM-DD;
// ISO timestamps come with time. Output MM/DD/YYYY (dates) and
// MM/DD/YYYY h:mm AM/PM PT (timestamps). Times are rendered in Pacific
// because the team is in Spokane and Netlify functions run in UTC.
function fmtDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' PT';
}

// Item #1: confirmation email back to the borrower with everything they
// submitted, so they can double-check for mistakes before pricing.
async function notifyApplicantOfSubmission(prospect) {
  // Deploy 236.285 — routes to broker or borrower depending on who
  // submitted. Broker mode: sends to brokerEmail with a "thanks for
  // submitting on behalf of your borrower" greeting. Borrower mode
  // (self-submit): sends to prospect.email as before. Same body shape
  // in both cases so the audit trail is consistent.
  const tag = `[apply-notify APPLICANT p=${prospect.id || '?'}]`;
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn(`${tag} skipped: RESEND_API_KEY not set`); return; }

  const isBroker = String(prospect.submitterType || '').toLowerCase() === 'broker';
  const toEmail = isBroker ? prospect.brokerEmail : prospect.email;
  if (!toEmail || !String(toEmail).includes('@')) {
    console.warn(`${tag} skipped: no applicant email (isBroker=${isBroker})`);
    return;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtMoney = (v) => v ? '$' + Number(v).toLocaleString() : '';
  const borrowerName = `${prospect.firstName || ''} ${prospect.lastName || ''}`.trim() || prospect.email;
  const brokerFullName = String(prospect.brokerName || '').trim();
  const brokerFirst = brokerFullName ? brokerFullName.split(/\s+/)[0] : '';

  const greetingName = isBroker ? (brokerFirst || 'there') : (prospect.firstName || 'there');
  const subject = isBroker
    ? `Application received — ${prospect.propAddress || (borrowerName ? `for ${borrowerName}` : 'SLA Capital')}`
    : `Application received — ${prospect.propAddress || 'SLA Capital'}`;
  const introLine = isBroker
    ? `Thanks for submitting a loan application with SLA Capital${borrowerName && borrowerName !== prospect.email ? ` on behalf of ${borrowerName}` : ''}. Here's a copy of what you submitted — please review and let your loan officer know if anything is incorrect.`
    : `Thanks for submitting your application with SLA Capital. Here's a copy of what you submitted — please review and let your loan officer know if anything is incorrect.`;

  // Deploy 236.284 — filter empty fields, format dates MM/DD/YYYY.
  const bbSqft = [prospect.bedrooms, prospect.bathrooms, prospect.sqft].filter(v => v && String(v).trim()).length;
  const textLines = [];
  textLines.push(`Hi ${greetingName},`);
  textLines.push('');
  textLines.push(introLine);
  textLines.push('');
  if (isBroker) {
    textLines.push('--- BROKER ---');
    if (brokerFullName)          textLines.push(`Name:     ${brokerFullName}`);
    if (prospect.brokerCompany)  textLines.push(`Company:  ${prospect.brokerCompany}`);
    if (prospect.brokerEmail)    textLines.push(`Email:    ${prospect.brokerEmail}`);
    if (prospect.brokerPhone)    textLines.push(`Phone:    ${prospect.brokerPhone}`);
    if (borrowerName && borrowerName !== prospect.email) {
      textLines.push('');
      textLines.push('--- BORROWER ---');
      textLines.push(`Name:     ${borrowerName}`);
      if (prospect.email)       textLines.push(`Email:    ${prospect.email}`);
      if (prospect.phone)       textLines.push(`Phone:    ${prospect.phone}`);
      if (prospect.creditScore) textLines.push(`Credit:   ${prospect.creditScore}`);
      if (prospect.usCitizen)   textLines.push(`US Citizen: ${prospect.usCitizen}`);
    }
  } else {
    textLines.push('--- YOUR INFO ---');
    textLines.push(`Name:     ${borrowerName}`);
    textLines.push(`Email:    ${prospect.email}`);
    if (prospect.phone)       textLines.push(`Phone:    ${prospect.phone}`);
    if (prospect.creditScore) textLines.push(`Credit:   ${prospect.creditScore}`);
    if (prospect.usCitizen)   textLines.push(`US Citizen: ${prospect.usCitizen}`);
  }
  if (prospect.propAddress || prospect.propType || bbSqft) {
    textLines.push('');
    textLines.push('--- PROPERTY ---');
    if (prospect.propAddress) textLines.push(`Address:  ${prospect.propAddress}`);
    if (prospect.propType)    textLines.push(`Type:     ${prospect.propType}`);
    if (bbSqft) {
      const b = prospect.bedrooms  || '?';
      const ba = prospect.bathrooms || '?';
      const sq = prospect.sqft      || '?';
      textLines.push(`Beds/Baths/SqFt: ${b}/${ba}/${sq}`);
    }
  }
  const hasLoanSection = prospect.loanProduct || prospect.loanPurpose || prospect.purchasePrice
    || prospect.propertyValue || prospect.currentLoanAmt || prospect.rehabCost || prospect.estimatedARV
    || prospect.flipsCompleted || prospect.monthlyRent || prospect.fundingDate || prospect.projectDescription;
  if (hasLoanSection) {
    textLines.push('');
    textLines.push('--- LOAN ---');
    if (prospect.loanProduct)    textLines.push(`Product:  ${prospect.loanProduct}`);
    if (prospect.loanPurpose)    textLines.push(`Purpose:  ${prospect.loanPurpose}`);
    if (prospect.purchasePrice)  textLines.push(`Purchase: ${fmtMoney(prospect.purchasePrice)}`);
    if (prospect.propertyValue)  textLines.push(`Value:    ${fmtMoney(prospect.propertyValue)}`);
    if (prospect.currentLoanAmt) textLines.push(`Current Loan: ${fmtMoney(prospect.currentLoanAmt)}`);
    if (prospect.rehabCost)      textLines.push(`Rehab:    ${fmtMoney(prospect.rehabCost)}`);
    if (prospect.estimatedARV)   textLines.push(`ARV:      ${fmtMoney(prospect.estimatedARV)}`);
    if (prospect.flipsCompleted) textLines.push(`Flips Completed (36mo): ${prospect.flipsCompleted}`);
    if (prospect.monthlyRent)    textLines.push(`Rent:     ${fmtMoney(prospect.monthlyRent)}`);
    if (prospect.fundingDate)    textLines.push(`Funding:  ${fmtDate(prospect.fundingDate)}`);
    if (prospect.projectDescription) textLines.push(`Project Description: ${prospect.projectDescription}`);
  }
  textLines.push('');
  textLines.push('If anything looks wrong, just reply to this email or contact your loan officer.');
  textLines.push('');
  textLines.push('— SLA Capital');
  const text = textLines.join('\n');

  // HTML — sections/tables are auto-suppressed when their row() calls all
  // return empty strings (see Deploy 236.284 row() helper).
  const propertyTable =
    row('Address', esc(prospect.propAddress)) +
    row('Property Type', esc(prospect.propType)) +
    row('Beds / Baths / SqFt', bbSqft ? `${esc(prospect.bedrooms || '?')} / ${esc(prospect.bathrooms || '?')} / ${esc(prospect.sqft || '?')}` : '');
  const loanTable =
    row('Product', esc(prospect.loanProduct)) +
    row('Purpose', esc(prospect.loanPurpose)) +
    row('Purchase Price', fmtMoney(prospect.purchasePrice)) +
    row('Property Value', fmtMoney(prospect.propertyValue)) +
    row('Current Loan', fmtMoney(prospect.currentLoanAmt)) +
    row('Rehab Cost', fmtMoney(prospect.rehabCost)) +
    row('ARV', fmtMoney(prospect.estimatedARV)) +
    row('Flips Completed (36mo)', esc(prospect.flipsCompleted)) +
    row('Monthly Rent', fmtMoney(prospect.monthlyRent)) +
    row('Funding Date', esc(fmtDate(prospect.fundingDate))) +
    row('Project Description', esc(prospect.projectDescription));

  // Deploy 236.285 — broker mode header block. When submitted by a broker
  // on behalf of a borrower, show broker fields first, then the borrower's
  // limited info (if any was provided at submit time).
  const brokerBlock = isBroker
    ? '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Broker</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      row('Name', esc(brokerFullName)) +
      row('Company', esc(prospect.brokerCompany)) +
      row('Email', esc(prospect.brokerEmail)) +
      row('Phone', esc(prospect.brokerPhone)) +
      '</table>'
    : '';
  const borrowerBlock = isBroker
    ? (borrowerName && borrowerName !== prospect.email
        ? '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Borrower</h3>' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
          row('Name', esc(borrowerName)) +
          row('Email', esc(prospect.email)) +
          row('Phone', esc(prospect.phone)) +
          row('Credit Score', esc(prospect.creditScore)) +
          row('US Citizen', esc(prospect.usCitizen)) +
          '</table>'
        : '')
    : '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Your Info</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      row('Name', esc(borrowerName)) +
      row('Email', esc(prospect.email)) +
      row('Phone', esc(prospect.phone)) +
      row('Credit Score', esc(prospect.creditScore)) +
      row('US Citizen', esc(prospect.usCitizen)) +
      '</table>';

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Application Received</h1>' +
    `<p style="color:rgba(255,255,255,.5);font-size:12px;margin:4px 0 0">Submitted ${esc(fmtDateTime(prospect.submittedAt))}</p></div>` +
    '<div style="padding:24px">' +
    '<div style="display:inline-block;padding:5px 12px;border-radius:18px;background:#256940;color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:14px">RECEIVED</div>' +
    `<p style="font-size:14px;color:#1a1520;line-height:1.6">Hi ${esc(greetingName)},</p>` +
    `<p style="font-size:14px;color:#1a1520;line-height:1.6">${esc(introLine)}</p>` +
    brokerBlock +
    borrowerBlock +
    (propertyTable
      ? '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Property</h3>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px">' + propertyTable + '</table>'
      : '') +
    (loanTable
      ? '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Loan</h3>' +
        '<table style="width:100%;border-collapse:collapse;font-size:13px">' + loanTable + '</table>'
      : '') +
    '<p style="margin-top:24px;font-size:13px;color:#666">If anything looks wrong, just reply to this email or contact your loan officer directly.</p>' +
    '<p style="margin-top:8px;font-size:13px;color:#666">— SLA Capital</p>' +
    '</div></div></body></html>';

  console.log(`${tag} sending → ${toEmail}`);
  const payload = JSON.stringify({
    from: 'SLA Capital <noreply@leads.slacapital.com>',
    to: [toEmail],
    subject,
    text,
    html,
    reply_to: prospect.loEmail || undefined,
  });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: payload,
  });
  // Deploy 236.685 — track delivery so the LO is alerted if the applicant confirmation bounces.
  await logBorrowerSendFromResponse(resp, { kind: 'apply_confirmation', to: toEmail, loEmail: prospect.loEmail });
  const respBody = await resp.text().catch(() => '');
  console.log(`${tag} Resend ${resp.status}: ${respBody.slice(0, 200)}`);
  if (!resp.ok) {
    console.warn(`${tag} failed: Resend ${resp.status}: ${respBody.slice(0, 200)}`);
  }
}

// Deploy 236.282 (neutral-apply auto-routing) — decide which LO owns
// an incoming lead. Precedence: explicit ?lo= link → broker match →
// borrower match → house account. Returns { loEmail, source }.
//
// Defensive throughout: any lookup failure falls through to the next
// tier rather than throwing, so a bad scan can't 500 a public submit.
//
// Cost note: tiers 2/3 scan the whole brokers/clients store (list all
// blobs, GET each). Website submissions are human-paced and low-volume,
// so this is fine at current scale. If the record set grows into the
// tens of thousands, add an email→owner index blob and consult it first.
async function resolveOwner({ incomingLoSlug, brokerEmail, borrowerEmail }) {
  const rawSlug = String(incomingLoSlug || '').toLowerCase().trim();

  // Tier 1a: explicit ?lo=<email> — the standard LO-tagged apply link.
  if (rawSlug && rawSlug.includes('@')) {
    return { loEmail: rawSlug, source: 'link' };
  }

  // Load profiles once — used for slug-to-email resolution AND for
  // ownerKey → LO email translation in tiers 2/3.
  const ownerEmailByKey = {};
  try {
    const profiles = getStore({ name: 'profiles', consistency: 'eventual' });
    const { blobs } = await profiles.list();
    await Promise.all(blobs.map(async ({ key }) => {
      try {
        const p = await profiles.get(key, { type: 'json' });
        if (p && p.email) ownerEmailByKey[key] = String(p.email).toLowerCase().trim();
      } catch (_) { /* skip broken records */ }
    }));
  } catch (e) {
    console.warn('resolveOwner: profiles load failed:', e && e.message);
  }

  // Tier 1b: explicit ?lo=<slug> — resolve slug against profiles store
  // (matches keySafe(profile.email) → profile.email).
  if (rawSlug) {
    if (ownerEmailByKey[rawSlug]) {
      return { loEmail: ownerEmailByKey[rawSlug], source: 'link' };
    }
    const safeSlug = keySafe(rawSlug);
    if (ownerEmailByKey[safeSlug]) {
      return { loEmail: ownerEmailByKey[safeSlug], source: 'link' };
    }
  }

  const brokerNeedle   = normalizeEmail(brokerEmail   || '');
  const borrowerNeedle = normalizeEmail(borrowerEmail || '');

  // Deploy 236.288 — brokers live in the `clients` blob store with
  // `_isBroker: true`, not the legacy `brokers` store. brokers-save.mjs
  // writes to `clients` and best-effort DELETES the legacy `brokers`
  // key on every save (Broker Phase A). Prior resolveOwner scanned the
  // legacy `brokers` store, which was empty for every broker resaved
  // since Phase A shipped — that's why brokeremail@broker.com routed
  // to Chance despite Mike having that broker in his book.
  //
  // Deploy 236.387 — the "walk every client blob" single-pass scan is
  // replaced with direct Postgres lookups by email. At 2,800+ client
  // blobs the walk threatened the public submit's function timeout.
  // Broker-priority is preserved by query order: broker lookup first,
  // borrower lookup only when no broker matched. ilike with no
  // wildcards = the same case-insensitive compare the old
  // normalizeEmail() walk did (PG stores email verbatim; `_` is a
  // single-char LIKE wildcard, so exact normalized equality is
  // re-verified in JS). Defensive throughout: a PG failure warns and
  // leaves the hit null, so routing falls to the legacy brokers store
  // and then the house account — never a 500 on a public submit.
  // Hit shape: { ownerKey, createdBy }.
  let brokerHit = null;
  let borrowerHit = null;

  const ROUTING_SELECT = 'select=' + encodeURIComponent('id,owner_email,created_by,email,is_broker');
  if (brokerNeedle) {
    try {
      const rows = await _pgFetch('clients',
        ROUTING_SELECT +
        '&email=ilike.' + encodeURIComponent(brokerNeedle) +
        '&is_broker=eq.true&order=updated_at.desc&limit=10');
      const row = (rows || []).find((r) => r && normalizeEmail(r.email || '') === brokerNeedle && r.is_broker === true);
      if (row) {
        brokerHit = {
          ownerKey:  keySafe(normalizeEmail(row.owner_email || '')),
          createdBy: row.created_by || '',
        };
      }
    } catch (e) {
      console.warn('resolveOwner: PG broker lookup failed:', e && e.message);
    }
  }
  if (!brokerHit && borrowerNeedle) {
    try {
      // No is_broker filter here — the old walk treated ANY falsy
      // _isBroker as a borrower record, so filter in JS the same way.
      const rows = await _pgFetch('clients',
        ROUTING_SELECT +
        '&email=ilike.' + encodeURIComponent(borrowerNeedle) +
        '&order=updated_at.desc&limit=10');
      const row = (rows || []).find((r) => r && normalizeEmail(r.email || '') === borrowerNeedle && !r.is_broker);
      if (row) {
        borrowerHit = {
          ownerKey:  keySafe(normalizeEmail(row.owner_email || '')),
          createdBy: row.created_by || '',
        };
      }
    } catch (e) {
      console.warn('resolveOwner: PG borrower lookup failed:', e && e.message);
    }
  }

  // Legacy brokers store fallback — a broker record predating Phase A
  // (or one that fell off the migration for any reason) still routes.
  // Small store, blob walk is fine here.
  if (!brokerHit && brokerNeedle) {
    const legacyHit = await findEmailMatch('brokers', brokerNeedle);
    if (legacyHit) {
      const slash = legacyHit.key.indexOf('/');
      brokerHit = {
        ownerKey:  slash > 0 ? legacyHit.key.slice(0, slash) : '',
        createdBy: (legacyHit.rec && legacyHit.rec.createdBy) || '',
      };
    }
  }

  const pickedHit = brokerHit || borrowerHit;
  if (pickedHit) {
    const owner = pickedHit.ownerKey;
    const loEmail = normalizeEmail(pickedHit.createdBy || '') || ownerEmailByKey[owner];
    const source = brokerHit ? 'broker' : 'borrower';
    if (loEmail && loEmail.includes('@')) {
      console.log(`resolveOwner: matched ${source} → ${loEmail} (ownerKey=${owner})`);
      return { loEmail, source };
    }
    console.warn(`resolveOwner: matched ${source} in ownerKey=${owner} but no routable LO email (createdBy=${pickedHit.createdBy || '(empty)'})`);
  }

  // Tier 4: no match — house account for triage.
  return { loEmail: HOUSE_ACCOUNT_EMAIL, source: 'house' };
}

// Deploy 236.387 — zero-dep PostgREST GET (same pattern as
// search-pg.mjs's _pgSelect). Built manually rather than via the
// shared supabase-db helper because the email lookups above need the
// `ilike` operator, which the shared _qs() can't express. Throws on
// missing env / non-OK response — callers catch + fall through.
async function _pgFetch(table, qs) {
  const url = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const resp = await fetch(url + '/rest/v1/' + table + '?' + qs, {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : []; }
  catch (_) { data = []; }
  if (!resp.ok) {
    const err = new Error('PostgREST GET ' + table + ' → HTTP ' + resp.status +
      (data && data.message ? ': ' + data.message : ''));
    err.status = resp.status;
    throw err;
  }
  return data || [];
}

// Deploy 236.283 — parallel-batched scan of a keyed store for the first
// record whose lowercased .email field equals `needle`. Replaces the
// previous sequential `for...await get()` loop, which took ~30ms per
// record and could push a 500-record scan past 15 seconds (observed on
// the first neutral submission after ship). Chunk size caps concurrent
// blob GETs so a large store can't overrun the function's socket pool.
// Deploy 236.387 — now only used for the small legacy `brokers` store;
// the clients-store lookups moved to Postgres (_pgFetch above).
async function findEmailMatch(storeName, needle) {
  const CHUNK = 40;
  try {
    const store = getStore({ name: storeName, consistency: 'strong' });
    const { blobs } = await store.list();
    for (let i = 0; i < blobs.length; i += CHUNK) {
      const chunk = blobs.slice(i, i + CHUNK).filter(({ key }) => key.indexOf('/') >= 0);
      const results = await Promise.all(chunk.map(async ({ key }) => {
        try {
          const rec = await store.get(key, { type: 'json' });
          if (!rec) return null;
          if (normalizeEmail(rec.email || '') !== needle) return null;
          return { key, rec };
        } catch (_) { return null; }
      }));
      const hit = results.find(Boolean);
      if (hit) return hit;
    }
  } catch (e) {
    console.warn(`findEmailMatch(${storeName}): scan failed:`, e && e.message);
  }
  return null;
}

// Deploy 236.295 — Slack notification for every apply submission.
// Deploy 236.296 — reformatted to a tidy label-value layout: bold
// section headers, one field per line, empty fields hidden. Matches
// the shape Mike likes from the Pipedrive integration on the current
// site — easier to scan than the two-column Block Kit fields grid.
async function notifySlack(prospect, ids) {
  const tag = `[apply-slack p=${prospect.id || '?'}]`;
  const isBroker = String(prospect.submitterType || '').toLowerCase() === 'broker';
  const src = prospect.assignmentSource || 'link';

  const fmtMoney = (v) => v ? '$' + Number(v).toLocaleString() : '';
  const fmtDate  = (v) => {
    if (!v) return '';
    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
    return s;
  };
  const humanizeLocalpart = (email) => {
    const local = String(email || '').split('@')[0];
    return local.split(/[._-]+/).filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };
  const humanizeProduct = (code) => {
    const c = String(code || '').toLowerCase();
    if (c === 'dscr')          return 'DSCR (Rental Purchase or Refi)';
    if (c === 'fix_flip')      return 'Fix & Flip';
    if (c === 'bridge')        return 'Bridge';
    if (c === 'transactional') return 'Transactional Funding';
    if (c === 'rtl')           return 'RTL (Bridge / Fix & Flip)';
    if (c === 'new_construction' || c === 'nc') return 'New Construction';
    return code || '';
  };
  const humanizePurpose = (code) => {
    const c = String(code || '').toLowerCase();
    if (c === 'purchase')  return 'Purchase';
    if (c === 'refinance' || c === 'refi_rt' || c === 'rateterm') return 'Rate & Term Refinance';
    if (c === 'refi_co'   || c === 'cashout')                     return 'Cash-Out Refinance';
    return code || '';
  };
  const humanizePropType = (code) => {
    const c = String(code || '').toLowerCase();
    if (c === 'sfr')       return 'Single Family Residence';
    if (c === 'multi'    || c === '2-4' || c === '2_4' || c === 'multifamily') return '2-4 Unit Residential';
    if (c === 'condo')     return 'Condo';
    if (c === 'townhome' || c === 'townhouse') return 'Townhouse';
    if (c === 'portfolio') return 'Portfolio';
    if (c === 'mixed')     return 'Mixed-Use';
    if (c === '5+' || c === 'multi5')          return '5+ Unit Multifamily';
    return code || '';
  };

  // Look up the assigned LO's display name from the profiles store.
  // Falls back to humanized email localpart when the profile lookup
  // fails or doesn't have a fullName set.
  async function loDisplay(loEmail) {
    if (!loEmail) return 'Unassigned';
    try {
      const profiles = getStore({ name: 'profiles', consistency: 'eventual' });
      const p = await profiles.get(keySafe(loEmail), { type: 'json' });
      if (p && p.fullName && String(p.fullName).trim()) return String(p.fullName).trim();
    } catch (_) { /* fall through */ }
    return humanizeLocalpart(loEmail) || loEmail;
  }

  const borrowerName = `${prospect.firstName || ''} ${prospect.lastName || ''}`.trim();
  const brokerFullName = String(prospect.brokerName || '').trim();
  const loName = await loDisplay(prospect.loEmail);
  const isUnrouted = src === 'house';

  // Title: mirror the current-site format Mike likes.
  //   "New Website DSCR Loan Application:"
  //   "New Website Broker Application:"
  const productLabel = humanizeProduct(prospect.loanProduct) || '';
  const productShort = String(prospect.loanProduct || '').toLowerCase() === 'dscr'  ? 'DSCR'
                     : String(prospect.loanProduct || '').toLowerCase() === 'fix_flip' ? 'Fix & Flip'
                     : String(prospect.loanProduct || '').toLowerCase() === 'bridge'   ? 'Bridge'
                     : String(prospect.loanProduct || '').toLowerCase() === 'transactional' ? 'Transactional'
                     : String(prospect.loanProduct || '').toLowerCase() === 'new_construction' ? 'New Construction'
                     : '';
  let title;
  if (isBroker) {
    title = `New Website Broker Loan Application${productShort ? ` (${productShort})` : ''}:`;
  } else {
    title = productShort
      ? `New Website ${productShort} Loan Application:`
      : 'New Website Loan Application:';
  }
  if (isUnrouted) title = '[UNROUTED] ' + title;

  // Line helpers — return null when the value is empty so the caller
  // can filter cleanly.
  const line = (label, value) => {
    const v = value == null ? '' : String(value).trim();
    if (!v) return null;
    return `${label}: ${v}`;
  };
  const filterLines = (arr) => arr.filter(l => l != null && l !== '');

  // ── Section 1: contact ─────────────────────────────────────
  const contactLines = [];
  if (isBroker) {
    contactLines.push(line('Broker', brokerFullName));
    contactLines.push(line('Company', prospect.brokerCompany));
    contactLines.push(line('Email',   prospect.brokerEmail));
    contactLines.push(line('Phone',   prospect.brokerPhone));
    if (borrowerName) contactLines.push(line('Borrower', borrowerName));
    if (prospect.email) contactLines.push(line('Borrower Email', prospect.email));
    if (prospect.phone) contactLines.push(line('Borrower Phone', prospect.phone));
  } else {
    contactLines.push(line('Name',  borrowerName || prospect.email));
    contactLines.push(line('Email', prospect.email));
    contactLines.push(line('Phone', prospect.phone));
    // A broker may still be on a borrower-submitted deal (borrower-mode
    // apply.html with brokerName filled in). Surface it below the
    // borrower's own contact so the routing story is clear.
    if (prospect.brokerName || prospect.brokerEmail) {
      contactLines.push(line('Broker', prospect.brokerName));
      contactLines.push(line('Broker Company', prospect.brokerCompany));
      contactLines.push(line('Broker Email',   prospect.brokerEmail));
      contactLines.push(line('Broker Phone',   prospect.brokerPhone));
    }
  }
  contactLines.push(line('Assigned Loan Officer', loName));

  // ── Section 2: deal details ─────────────────────────────────
  const dealLines = filterLines([
    line('Address',                       prospect.propAddress),
    line('Loan Type',                     productLabel),
    line('Purchasing or Refinancing',     humanizePurpose(prospect.loanPurpose)),
    line('Property Type',                 humanizePropType(prospect.propType)),
    line('Beds / Baths / SqFt',           (prospect.bedrooms || prospect.bathrooms || prospect.sqft)
      ? `${prospect.bedrooms || '?'} / ${prospect.bathrooms || '?'} / ${prospect.sqft || '?'}`
      : ''),
    line('Requested Loan Amount',         fmtMoney(prospect.purchasePrice)),
    line('Current Loan Amount',           fmtMoney(prospect.currentLoanAmt)),
    line('Current Value of the Property', fmtMoney(prospect.propertyValue)),
    line('Rehab Budget',                  fmtMoney(prospect.rehabCost)),
    line('ARV',                           fmtMoney(prospect.estimatedARV)),
    line('Rental Rate',                   fmtMoney(prospect.monthlyRent)),
    line('Monthly Taxes',                 fmtMoney(prospect.monthlyTaxes)),
    line('Monthly Insurance',             fmtMoney(prospect.monthlyInsurance)),
    line('Monthly HOA',                   fmtMoney(prospect.monthlyHOA)),
    line('Funding Date',                  fmtDate(prospect.fundingDate)),
  ]);

  // ── Section 3: borrower qualifications ──────────────────────
  const qualLines = filterLines([
    line('Estimated Credit',        prospect.creditScore),
    line('Flips Completed (36mo)',  prospect.flipsCompleted),
    line('US Citizen',              prospect.usCitizen),
  ]);

  // Deploy 236.298 — include ?owner=<lo> in the Slack link so anyone
  // in the channel who isn't the loan's owning LO (an admin, another
  // LO, or Chance viewing a routed lead) triggers the all-scope path
  // in loan-details.js's fetchLoan(). Without this, the link resolved
  // to "Loan Not Found" for viewers whose own SLA.Clients.list() didn't
  // include the loan's owner namespace.
  const _ownerParam = prospect.loEmail
    ? `&owner=${encodeURIComponent(prospect.loEmail)}`
    : '';
  const detailsLink = (ids && ids.loanId)
    ? `https://portal.slacapital.ai/loan-details/${encodeURIComponent(ids.loanId)}?fresh=1${_ownerParam}`
    : '';

  // Build the message body as a single mrkdwn text block per section.
  // Slack accepts up to ~3000 chars per section text; well under that
  // for any realistic apply submission.
  const blocks = [];
  const contactBody = filterLines(contactLines).join('\n');
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${title}*\n${contactBody}` },
  });
  if (dealLines.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Deal Details:*\n${dealLines.join('\n')}` },
    });
  }
  if (qualLines.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Borrower Qualifications*\n${qualLines.join('\n')}` },
    });
  }
  if (prospect.projectDescription) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Project Description:*\n${prospect.projectDescription}` },
    });
  }
  if (detailsLink) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `Link to Deal: <${detailsLink}|${detailsLink}>` },
    });
  }

  const fallbackText = `${title} · owner ${prospect.loEmail || 'unassigned'}`;
  console.log(`${tag} posting to slack — owner=${prospect.loEmail || '?'} source=${src}`);
  // Deploy 236.311 — route to the 'apply' channel so applications and
  // in-processing submissions can land in different Slack channels.
  // Falls back to the default `slack_webhook` if the apply-specific
  // one isn't configured.
  const result = await postSlack({ text: fallbackText, blocks }, { channel: 'apply' });
  if (result && result.skipped) {
    console.log(`${tag} skipped: ${result.reason}`);
  } else if (result && result.ok) {
    console.log(`${tag} delivered (${result.status})`);
  } else {
    console.warn(`${tag} failed:`, result && (result.error || result.status));
  }
}
