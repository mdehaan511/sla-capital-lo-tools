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

  return json(200, { ok: true, id });
};

// Auto-create or update a Client record + initial Loan from a prospect submission
async function upsertClientFromProspect(prospect, loEmail) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(normalizeEmail(loEmail));
  const borrowerEmailNorm = normalizeEmail(prospect.email);
  if (!borrowerEmailNorm) return;

  // Search this LO's clients for an existing match by borrower email
  let existing = null;
  let existingKey = null;
  try {
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (c && (c.email || '').toLowerCase() === borrowerEmailNorm) {
        existing = c;
        existingKey = key;
        break;
      }
    }
  } catch (e) {
    console.warn('client lookup failed:', e);
  }

  // Build a loan record from the application
  const isFF = prospect.loanProduct === 'fix_flip' || prospect.loanProduct === 'rtl';
  const loan = {
    id:          'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    toolType:    isFF ? 'rtl' : 'dscr',
    address:     prospect.propAddress || '',
    savedAt:     new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    status:      'active',
    loanType:    prospect.loanProduct || '',
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
    fromApplication: true,
  };

  const now = new Date().toISOString();
  let record;
  if (existing) {
    record = existing;
    if (!record.firstName && prospect.firstName) record.firstName = prospect.firstName;
    if (!record.lastName  && prospect.lastName)  record.lastName  = prospect.lastName;
    if (!record.phone     && prospect.phone)     record.phone     = prospect.phone;
    if (!record.usCitizen && prospect.usCitizen) record.usCitizen = prospect.usCitizen;
    record.loans = record.loans || [];
    record.loans.unshift(loan);
    record.updatedAt = now;
  } else {
    record = {
      id:        'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      email:     borrowerEmailNorm,
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

  const subject = `New loan application — ${name || prospect.email}`;

  const text = [
    `New loan application submitted ${new Date(prospect.submittedAt).toLocaleString('en-US')}`,
    '',
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
    reply_to: prospect.email || undefined,
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
