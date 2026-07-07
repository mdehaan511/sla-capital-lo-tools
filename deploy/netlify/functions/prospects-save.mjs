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
import {
  handleOptions, json, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.5 (Brokers Phase 3b) — when a prospect carries broker
// fields (apply.html broker mode in Phase 3c), resolve or create the
// broker entity in the LO's book so the materialized loan lands with
// a brokerId already set.
import { linkOrCreateBroker } from './_shared/broker-link.mjs';

const MAX_BODY_BYTES = 32 * 1024; // 32 KB is plenty for a form payload

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

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
  if (!email || !email.includes('@')) return json(400, { error: 'Valid email required' });
  if (!firstName && !lastName) return json(400, { error: 'Name required' });
  if (email.length > 200) return json(400, { error: 'Invalid email' });

  // Build sanitized prospect record (don't trust anything from the client)
  const now = new Date().toISOString();
  const id = body.id || ('p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
  const loSlug = keySafe(String(body.loSlug || 'unassigned')) || 'unassigned';
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
  };

  // The loSlug is the LO's email address (URL-encoded). The storage key
  // is keySafe(email-lowercased), which matches what prospects-list reads.
  const loEmail = String(body.loSlug || '').toLowerCase().trim();
  const ownerKey = loEmail && loEmail.includes('@') ? keySafe(loEmail) : keySafe(loSlug);

  prospect.loEmail = loEmail.includes('@') ? loEmail : '';

  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const key = `${ownerKey}/${keySafe(id)}`;

  try {
    await store.setJSON(key, prospect);
  } catch (e) {
    console.error('prospects-save write error:', e);
    return json(500, { error: 'Failed to save application' });
  }

  // Auto-create a Client record under the LO so they see this in Clients.
  // Only when we have a valid LO email.
  if (loEmail && loEmail.includes('@')) {
    try {
      await upsertClientFromProspect(prospect, loEmail);
    } catch (e) {
      console.warn('prospects-save: client upsert failed:', e);
    }
  }

  // Notify the LO by email — best-effort, don't fail the submission if email fails
  try {
    await notifyLO(prospect);
  } catch (e) {
    console.error('prospects-save notify error:', e);
  }
  // Item #1: also send a borrower confirmation showing all the fields they
  // submitted, so they can double-check for mistakes.
  try {
    await notifyBorrowerOfSubmission(prospect);
  } catch (e) {
    console.error('prospects-save borrower notify error:', e);
  }

  return json(200, { ok: true, id });
};

// Auto-create or update a Client record + initial Loan from a prospect submission
async function upsertClientFromProspect(prospect, loEmail) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(normalizeEmail(loEmail));
  // Deploy 236.227 (Broker Phase D) — for broker submissions the
  // "client" IS the broker; there is no borrower record to look up
  // yet. Match on brokerEmail instead. The loan will land under the
  // broker's client with _isBrokerLoan: true and guarantors[] empty;
  // Phase E captures borrower info at Advance to Approved.
  const isBrokerSubmission = String(prospect.submitterType || '').toLowerCase() === 'broker';
  const lookupEmail = isBrokerSubmission
    ? normalizeEmail(prospect.brokerEmail)
    : normalizeEmail(prospect.email);
  if (!lookupEmail) return;

  // Search this LO's clients for an existing match by lookup email.
  let existing = null;
  let existingKey = null;
  try {
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (c && (c.email || '').toLowerCase() === lookupEmail) {
        existing = c;
        existingKey = key;
        break;
      }
    }
  } catch (e) {
    console.warn('client lookup failed:', e);
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
    loanAmt:     prospect.purchasePrice || prospect.propertyValue || '',
    propValue:   prospect.propertyValue || prospect.estimatedARV || '',
    rent:        prospect.monthlyRent || '',
    taxes:       prospect.monthlyTaxes || '',
    insurance:   prospect.monthlyInsurance || '',
    hoa:         prospect.monthlyHOA || '',
    bedrooms:    prospect.bedrooms || '',
    bathrooms:   prospect.bathrooms || '',
    sqft:        prospect.sqft || '',
    propType:    prospect.propType || '',
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
    fromApplication: true,
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
  await clientsStore.setJSON(existingKey, record);
}

// ── LO notification via Resend ───────────────────────────────────────
async function notifyLO(prospect) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('RESEND_API_KEY not set — skipping LO notification');
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
    console.warn('No LO email available for prospect notification');
    return;
  }

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const name = `${prospect.firstName} ${prospect.lastName}`.trim();
  const fmtMoney = (v) => v ? '$' + Number(v).toLocaleString() : '—';
  const fmtText = (v) => v || '—';

  // Deploy 236.6 — flag broker-submitted apps in the subject so the LO
  // sees the source at a glance. apply.html Phase 3c sets submitterType
  // to 'broker' when a broker is filling out on behalf of a borrower.
  const isBrokerApp = prospect.submitterType === 'broker';
  const subject = isBrokerApp
    ? `New loan application (via broker) — ${name || prospect.email}`
    : `New loan application — ${name || prospect.email}`;

  const text = [
    `New loan application submitted ${new Date(prospect.submittedAt).toLocaleString('en-US')}`,
    '',
    ...(isBrokerApp ? [
      `Submitted by Broker: ${fmtText(prospect.brokerName)}`,
      `  Company: ${fmtText(prospect.brokerCompany)}`,
      `  Email:   ${fmtText(prospect.brokerEmail)}`,
      `  Phone:   ${fmtText(prospect.brokerPhone)}`,
      '',
    ] : []),
    `Borrower: ${name}`,
    `Email:    ${prospect.email}`,
    `Phone:    ${fmtText(prospect.phone)}`,
    `Credit:   ${fmtText(prospect.creditScore)}`,
    `US Citizen: ${fmtText(prospect.usCitizen)}`,
    '',
    `Property: ${fmtText(prospect.propAddress)}`,
    `Type:     ${fmtText(prospect.propType)}`,
    `Beds/Baths/SqFt: ${fmtText(prospect.bedrooms)}/${fmtText(prospect.bathrooms)}/${fmtText(prospect.sqft)}`,
    '',
    `Product:  ${fmtText(prospect.loanProduct)}`,
    `Purpose:  ${fmtText(prospect.loanPurpose)}`,
    `Purchase: ${fmtMoney(prospect.purchasePrice)}`,
    `Value:    ${fmtMoney(prospect.propertyValue)}`,
    prospect.currentLoanAmt ? `Current Loan: ${fmtMoney(prospect.currentLoanAmt)}` : '',
    `Rehab:    ${fmtMoney(prospect.rehabCost)}`,
    `ARV:      ${fmtMoney(prospect.estimatedARV)}`,
    `Flips Completed (36mo): ${fmtText(prospect.flipsCompleted)}`,
    `Rent:     ${fmtMoney(prospect.monthlyRent)}`,
    `Funding:  ${fmtText(prospect.fundingDate)}`,
  ].join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — New Loan Application</h1>' +
    `<p style="color:rgba(255,255,255,.5);font-size:12px;margin:4px 0 0">Submitted ${esc(new Date(prospect.submittedAt).toLocaleString('en-US'))}</p></div>` +
    '<div style="padding:24px">' +
    (isBrokerApp
      ? '<div style="background:rgba(200,129,58,0.10);border:1px solid rgba(200,129,58,0.28);border-radius:8px;padding:12px 14px;margin-bottom:16px">' +
          '<div style="font-size:10px;font-weight:600;color:#b5712d;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Submitted by Broker</div>' +
          `<div style="font-size:13px;font-weight:600;color:#1a1520">${esc(prospect.brokerName || '—')}` +
            (prospect.brokerCompany ? ` <span style="font-weight:400;color:#7a7488">· ${esc(prospect.brokerCompany)}</span>` : '') +
          '</div>' +
          `<div style="font-size:12px;color:#7a7488;margin-top:2px">${esc(prospect.brokerEmail || '—')} · ${esc(prospect.brokerPhone || '—')}</div>` +
        '</div>'
      : '') +
    `<h2 style="font-size:15px;margin:0 0 12px">${esc(name || prospect.email)}</h2>` +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    row('Email', esc(prospect.email)) +
    row('Phone', esc(prospect.phone)) +
    row('Credit Score', esc(prospect.creditScore)) +
    row('US Citizen', esc(prospect.usCitizen)) +
    row('Property', esc(prospect.propAddress)) +
    row('Property Type', esc(prospect.propType)) +
    row('Beds / Baths / SqFt', `${esc(prospect.bedrooms)} / ${esc(prospect.bathrooms)} / ${esc(prospect.sqft)}`) +
    row('Loan Product', esc(prospect.loanProduct)) +
    row('Purpose', esc(prospect.loanPurpose)) +
    row('Purchase Price', fmtMoney(prospect.purchasePrice)) +
    row('Property Value', fmtMoney(prospect.propertyValue)) +
    row('Rehab Cost', fmtMoney(prospect.rehabCost)) +
    row('ARV', fmtMoney(prospect.estimatedARV)) +
    row('Flips Completed (36mo)', esc(prospect.flipsCompleted)) +
    row('Monthly Rent', fmtMoney(prospect.monthlyRent)) +
    row('Funding Date', esc(prospect.fundingDate)) +
    '</table>' +
    '<p style="margin-top:20px;font-size:12px;color:#666">View in Prospects to import to a loan sizer.</p>' +
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
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${txt.slice(0, 200)}`);
  }
}

function row(label, value) {
  return `<tr><td style="padding:6px 0;color:#666;width:160px">${label}</td><td style="padding:6px 0;color:#1a1520">${value || '—'}</td></tr>`;
}

// Item #1: confirmation email back to the borrower with everything they
// submitted, so they can double-check for mistakes before pricing.
async function notifyBorrowerOfSubmission(prospect) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const toEmail = prospect.email;
  if (!toEmail || !String(toEmail).includes('@')) return;

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtMoney = (v) => v ? '$' + Number(v).toLocaleString() : '—';
  const fmtText = (v) => v || '—';
  const name = `${prospect.firstName || ''} ${prospect.lastName || ''}`.trim() || prospect.email;

  const subject = `Application received — ${prospect.propAddress || 'SLA Capital'}`;

  const text = [
    `Hi ${prospect.firstName || 'there'},`,
    '',
    `Thanks for submitting your application with SLA Capital. Here's a copy of what you submitted — please review and let your loan officer know if anything is incorrect.`,
    '',
    `--- YOUR INFO ---`,
    `Name:     ${name}`,
    `Email:    ${prospect.email}`,
    `Phone:    ${fmtText(prospect.phone)}`,
    `Credit:   ${fmtText(prospect.creditScore)}`,
    `US Citizen: ${fmtText(prospect.usCitizen)}`,
    '',
    `--- PROPERTY ---`,
    `Address:  ${fmtText(prospect.propAddress)}`,
    `Type:     ${fmtText(prospect.propType)}`,
    `Beds/Baths/SqFt: ${fmtText(prospect.bedrooms)}/${fmtText(prospect.bathrooms)}/${fmtText(prospect.sqft)}`,
    '',
    `--- LOAN ---`,
    `Product:  ${fmtText(prospect.loanProduct)}`,
    `Purpose:  ${fmtText(prospect.loanPurpose)}`,
    `Purchase: ${fmtMoney(prospect.purchasePrice)}`,
    `Value:    ${fmtMoney(prospect.propertyValue)}`,
    prospect.currentLoanAmt ? `Current Loan: ${fmtMoney(prospect.currentLoanAmt)}` : '',
    `Rehab:    ${fmtMoney(prospect.rehabCost)}`,
    `ARV:      ${fmtMoney(prospect.estimatedARV)}`,
    `Flips Completed (36mo): ${fmtText(prospect.flipsCompleted)}`,
    `Rent:     ${fmtMoney(prospect.monthlyRent)}`,
    `Funding:  ${fmtText(prospect.fundingDate)}`,
    prospect.projectDescription ? `Project Description: ${fmtText(prospect.projectDescription)}` : '',
    '',
    `If anything looks wrong, just reply to this email or contact your loan officer.`,
    '',
    `— SLA Capital`,
  ].filter(Boolean).join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Application Received</h1>' +
    `<p style="color:rgba(255,255,255,.5);font-size:12px;margin:4px 0 0">Submitted ${esc(new Date(prospect.submittedAt).toLocaleString('en-US'))}</p></div>` +
    '<div style="padding:24px">' +
    '<div style="display:inline-block;padding:5px 12px;border-radius:18px;background:#256940;color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:14px">RECEIVED</div>' +
    `<p style="font-size:14px;color:#1a1520;line-height:1.6">Hi ${esc(prospect.firstName || 'there')},</p>` +
    '<p style="font-size:14px;color:#1a1520;line-height:1.6">Thanks for submitting your application. Below is a copy of everything you submitted — please review and let your loan officer know if anything is incorrect.</p>' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Your Info</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    row('Name', esc(name)) +
    row('Email', esc(prospect.email)) +
    row('Phone', esc(prospect.phone)) +
    row('Credit Score', esc(prospect.creditScore)) +
    row('US Citizen', esc(prospect.usCitizen)) +
    '</table>' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Property</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    row('Address', esc(prospect.propAddress)) +
    row('Property Type', esc(prospect.propType)) +
    row('Beds / Baths / SqFt', `${esc(prospect.bedrooms)} / ${esc(prospect.bathrooms)} / ${esc(prospect.sqft)}`) +
    '</table>' +
    '<h3 style="font-size:13px;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488;margin-top:20px">Loan</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
    row('Product', esc(prospect.loanProduct)) +
    row('Purpose', esc(prospect.loanPurpose)) +
    row('Purchase Price', fmtMoney(prospect.purchasePrice)) +
    row('Property Value', fmtMoney(prospect.propertyValue)) +
    (prospect.currentLoanAmt ? row('Current Loan', fmtMoney(prospect.currentLoanAmt)) : '') +
    row('Rehab Cost', fmtMoney(prospect.rehabCost)) +
    row('ARV', fmtMoney(prospect.estimatedARV)) +
    row('Flips Completed (36mo)', esc(prospect.flipsCompleted)) +
    row('Monthly Rent', fmtMoney(prospect.monthlyRent)) +
    row('Funding Date', esc(prospect.fundingDate)) +
    (prospect.projectDescription ? row('Project Description', esc(prospect.projectDescription)) : '') +
    '</table>' +
    '<p style="margin-top:24px;font-size:13px;color:#666">If anything looks wrong, just reply to this email or contact your loan officer directly.</p>' +
    '<p style="margin-top:8px;font-size:13px;color:#666">— SLA Capital</p>' +
    '</div></div></body></html>';

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
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    console.warn(`Borrower confirmation email failed (Resend ${resp.status}): ${txt.slice(0, 200)}`);
  }
}
