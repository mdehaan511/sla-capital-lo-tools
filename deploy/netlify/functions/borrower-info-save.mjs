/**
 * borrower-info-save.mjs — POST /api/borrower-info-save
 *
 * Public endpoint. Body: { t: TOKEN, data: {...form data...}, complete?: bool }
 *
 * Persists the borrower's submitted data. SSN fields in any guarantor get
 * encrypted at rest. If complete=true, status flips to 'complete', the
 * completedAt timestamp is set, and the LO is notified by email.
 *
 * Returns: { ok, status }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody } from './_shared/auth.mjs';
import { encryptField } from './_shared/crypto.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-save error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.t) return json(400, { error: 'Missing token' });

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });
  const { blobs } = await store.list();
  let recordKey = null;
  let record = null;
  for (const { key } of blobs) {
    const r = await store.get(key, { type: 'json' });
    if (r && r.token === body.t) { record = r; recordKey = key; break; }
  }
  if (!record) return json(404, { error: 'Link not found or expired' });
  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    return json(410, { error: 'This link has expired' });
  }
  if (record.status === 'complete' && !body.allowReedit) {
    return json(409, { error: 'This information has already been submitted' });
  }

  const incoming = body.data || {};
  const merged = mergeData(record.data || {}, incoming);

  record.data = merged;
  record.lastSavedAt = new Date().toISOString();
  record.updatedAt = record.lastSavedAt;
  if (record.status === 'pending') record.status = 'in_progress';
  if (body.complete) {
    record.status = 'complete';
    record.completedAt = new Date().toISOString();
  }

  await store.setJSON(recordKey, record);

  // Item #3: write property field edits (beds/baths/sqft, plus loan-purpose
  // and current loan amount for refis) back to the matching client loan record
  // so the LO sees the latest values everywhere. Best-effort, runs on every
  // save (not just complete).
  try {
    await syncPropertyFieldsToLoan(record);
  } catch (e) {
    console.warn('borrower-info-save: property-field sync failed:', e);
  }

  // Notify LO + borrower on completion (best-effort)
  if (body.complete) {
    try {
      await notifyLO(record);
    } catch (e) {
      console.warn('borrower-info-save: LO notify failed:', e);
    }
    try {
      await notifyBorrower(record);
    } catch (e) {
      console.warn('borrower-info-save: borrower notify failed:', e);
    }
    // Bump the matching quote from `awaiting_app` → `approved` so the loan
    // jumps to the "In Processing" pipeline column.
    try {
      await advanceQuoteToInProcessing(record);
    } catch (e) {
      console.warn('borrower-info-save: quote advance failed:', e);
    }
  }

  return json(200, { ok: true, status: record.status });
}

// Map long-form property-type codes to loan-record codes used elsewhere.
// Long form may emit: sfh, sfr, 2-4, 5+, condo_w, condo_nw, townhome,
// manufactured, rural, portfolio. Loan-record/sizer uses: sfr, 2-4, condo,
// nw_condo, multi, portfolio.
function normalizePropType(pt) {
  if (!pt) return '';
  const map = {
    sfh: 'sfr', sfr: 'sfr',
    '2-4': '2-4',
    '5+': 'multi', mfr: 'multi', multi: 'multi',
    condo: 'condo', condo_w: 'condo',
    nw_condo: 'nw_condo', condo_nw: 'nw_condo',
    townhome: 'sfr',     // loan-record has no townhome → bucket as sfr
    manufactured: 'sfr',
    rural: 'sfr',
    portfolio: 'portfolio',
  };
  return map[String(pt).toLowerCase()] || String(pt);
}

async function syncPropertyFieldsToLoan(record) {
  if (!record.ownerKey || !record.clientId) return;
  const data = record.data || {};

  // Property-level fields (live on the loan record)
  const loanUpdates = {};
  if (data.bedrooms)        loanUpdates.bedrooms       = String(data.bedrooms);
  if (data.bathrooms)       loanUpdates.bathrooms      = String(data.bathrooms);
  if (data.sqft)            loanUpdates.sqft           = String(data.sqft);
  if (data.propertyType)    loanUpdates.propType       = normalizePropType(data.propertyType);
  if (data.currentLoanAmt)  loanUpdates.currentLoanAmt = String(data.currentLoanAmt);
  if (data.currentLoanAmount) loanUpdates.currentLoanAmt = String(data.currentLoanAmount);
  if (data.purchaseOrRefi)  loanUpdates.purchaseOrRefi = String(data.purchaseOrRefi);
  if (data.dscrPurchaseRefi) loanUpdates.purchaseOrRefi = String(data.dscrPurchaseRefi);

  // Borrower-level fields (live on the CLIENT record, reused across loans — item #6)
  // The form packs these into data.guarantors[0] (with sub-fields like
  // firstName, dob, fico, etc.) — NOT as top-level g1_* fields.
  const g0 = (Array.isArray(data.guarantors) && data.guarantors[0]) || {};
  const clientUpdates = {};
  if (data.borrowerFirstName) clientUpdates.firstName = String(data.borrowerFirstName);
  if (data.borrowerLastName)  clientUpdates.lastName  = String(data.borrowerLastName);
  if (data.borrowerEmail)     clientUpdates.email     = String(data.borrowerEmail).toLowerCase().trim();
  if (data.borrowerPhone)     clientUpdates.phone     = String(data.borrowerPhone);
  // Pull DOB/FICO/marital/citizenship/address from Guarantor 1 (primary borrower).
  if (g0.dob)        clientUpdates.dob           = String(g0.dob);
  if (g0.fico)       clientUpdates.fico          = String(g0.fico);
  if (g0.marital)    clientUpdates.maritalStatus = String(g0.marital);
  if (g0.usCitizen)  clientUpdates.usCitizen     = String(g0.usCitizen);
  if (g0.address || g0.city || g0.state || g0.zip) {
    clientUpdates.homeAddress = {
      street: g0.address || '',
      city:   g0.city    || '',
      state:  g0.state   || '',
      zip:    g0.zip     || '',
    };
  }
  // SSN — keep encrypted on the client record so future loans can use it.
  // We pull from g0.ssn_enc which the merge step set from incoming SSN.
  if (g0.ssn_enc) clientUpdates.ssn_enc = g0.ssn_enc;

  // Companies/entities (item #8) — extract from data.companies if present.
  // Borrower form will provide this as an array. We never overwrite the
  // existing companies array unless new data came in.
  let companiesUpdate = null;
  if (Array.isArray(data.companies) && data.companies.length > 0) {
    companiesUpdate = data.companies
      .filter((c) => c && (c.name || c.ein))
      .map((c) => ({
        id:      c.id || ('co_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
        name:    String(c.name  || ''),
        state:   String(c.state || ''),
        ein:     String(c.ein   || ''),
        address: String(c.address || ''),
        city:    String(c.city    || ''),
        addrState: String(c.addrState || ''),
        zip:     String(c.zip || ''),
      }));
  }

  if (Object.keys(loanUpdates).length === 0
      && Object.keys(clientUpdates).length === 0
      && !companiesUpdate) return;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${record.ownerKey}/${record.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client) return;
  if (!Array.isArray(client.loans)) client.loans = [];

  let changed = false;

  // Apply client-level updates
  Object.keys(clientUpdates).forEach((k) => {
    const incoming = clientUpdates[k];
    // For nested objects (homeAddress), check stringified equality
    const existing = client[k];
    const same = (typeof incoming === 'object')
      ? (JSON.stringify(existing) === JSON.stringify(incoming))
      : (existing === incoming);
    if (!same) {
      client[k] = incoming;
      changed = true;
    }
  });

  // Merge companies — preserve existing entries by id, add new.
  // Safety net: also dedupe by name+EIN so repeated autosaves with different
  // generated ids don't pile up duplicate entities.
  if (companiesUpdate) {
    const existing = Array.isArray(client.companies) ? client.companies : [];
    const merged = [];
    const seenIds = new Set();
    const norm = (s) => String(s || '').trim().toLowerCase();
    const ed = (s) => String(s || '').replace(/\D/g, '');
    const matchKey = (c) => norm(c.name) + '|' + ed(c.ein);
    const seenKeys = new Set();

    companiesUpdate.forEach((c) => {
      const k = matchKey(c);
      // Skip if we already merged an equivalent entity by name+EIN
      if ((c.name || c.ein) && seenKeys.has(k)) return;
      const match = existing.find((e) => e.id === c.id) ||
                    existing.find((e) => matchKey(e) === k && (c.name || c.ein));
      if (match) {
        merged.push(Object.assign({}, match, c, { id: match.id }));
        seenIds.add(match.id);
      } else {
        merged.push(c);
        seenIds.add(c.id);
      }
      if (c.name || c.ein) seenKeys.add(k);
    });
    // Keep any prior companies that the borrower didn't touch this round
    existing.forEach((e) => {
      const k = matchKey(e);
      if (!seenIds.has(e.id) && !seenKeys.has(k)) {
        merged.push(e);
        seenIds.add(e.id);
        if (e.name || e.ein) seenKeys.add(k);
      }
    });
    if (JSON.stringify(client.companies) !== JSON.stringify(merged)) {
      client.companies = merged;
      changed = true;
    }
  }

  // Apply loan-level updates
  if (Object.keys(loanUpdates).length > 0) {
    let targetLoan = null;
    if (record.loanId) targetLoan = client.loans.find((l) => l.id === record.loanId);
    if (!targetLoan && client.loans.length === 1) targetLoan = client.loans[0];
    if (targetLoan) {
      Object.keys(loanUpdates).forEach((k) => {
        if (targetLoan[k] !== loanUpdates[k]) {
          targetLoan[k] = loanUpdates[k];
          changed = true;
        }
      });
      if (changed) targetLoan.updatedAt = new Date().toISOString();
    }
  }

  if (changed) {
    client.updatedAt = new Date().toISOString();
    await clientsStore.setJSON(clientKey, client);
  }
}

async function advanceQuoteToInProcessing(record) {
  if (!record.ownerKey || !record.clientId) return;
  // Find the loan address from the client record so we can match the quote
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${record.ownerKey}/${record.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client || !Array.isArray(client.loans)) return;

  // Identify the target loan: prefer record.loanId; otherwise the first loan
  let targetLoan = null;
  if (record.loanId) targetLoan = client.loans.find((l) => l.id === record.loanId);
  if (!targetLoan && client.loans.length === 1) targetLoan = client.loans[0];
  if (!targetLoan || !targetLoan.address) return;

  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(targetLoan.address);

  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const { blobs } = await quotesStore.list({ prefix: record.ownerKey + '/' });
  for (const { key } of blobs) {
    const q = await quotesStore.get(key, { type: 'json' });
    if (!q || norm(q.address) !== target) continue;
    if (q.status === 'awaiting_app') {
      q.status = 'approved';
      q.updatedAt = new Date().toISOString();
      q.borrowerInfoCompletedAt = record.completedAt || new Date().toISOString();
      await quotesStore.setJSON(key, q);
    }
  }

  // Mirror the status into the client loan record too
  let changed = false;
  for (const l of client.loans) {
    if (norm(l.address) === target && l.status === 'awaiting_app') {
      l.status = 'approved';
      l.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await clientsStore.setJSON(clientKey, client);
}

// Merge incoming data with existing. SSN values in guarantors get
// encrypted into a separate ssn_enc field; the plaintext never lands in
// stored JSON. If the incoming SSN is empty/unchanged ("***-**-1234" mask),
// we keep whatever we already had.
function mergeData(existing, incoming) {
  const out = Object.assign({}, existing, incoming);

  if (Array.isArray(incoming.guarantors)) {
    const existingGs = Array.isArray(existing.guarantors) ? existing.guarantors : [];
    out.guarantors = incoming.guarantors.map((g, i) => {
      const exG = existingGs[i] || {};
      const merged = Object.assign({}, exG, g);
      // SSN handling — only replace if a real SSN value came in (not a mask)
      const incomingSSN = String(g.ssn || '').trim();
      const looksLikeMask = /^\*{3}-?\*{2}-?\d{4}$/.test(incomingSSN) || incomingSSN.startsWith('***');
      if (incomingSSN && !looksLikeMask) {
        merged.ssn_enc = encryptField(incomingSSN);
      }
      // Never persist plaintext SSN
      delete merged.ssn;
      return merged;
    });
  }
  return out;
}

async function notifyBorrower(record) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const toEmail = record.borrowerEmail;
  if (!toEmail) return false;

  const propAddr = (record.prefill && record.prefill.property && record.prefill.property.address) || '';
  const borrowerName = (record.prefill && record.prefill.borrower)
    ? ((record.prefill.borrower.firstName || '') + ' ' + (record.prefill.borrower.lastName || '')).trim()
    : '';
  const loName = (record.prefill && record.prefill.lo && record.prefill.lo.name) || 'Your loan officer';
  const subject = propAddr
    ? `Application received: ${propAddr}`
    : 'Application received — SLA Capital';
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = [
    `Hi ${borrowerName || 'there'},`,
    '',
    `Thank you for completing your loan application${propAddr ? ' for ' + propAddr : ''}.`,
    '',
    `${loName} has been notified and will be in touch shortly with next steps.`,
    '',
    'If you have questions, just reply to this email.',
    '',
    '— SLA Capital',
  ].filter(Boolean).join('\n');
  const html =
    '<!DOCTYPE html><html><body style="font-family:Georgia,serif">' +
    '<div style="max-width:560px;margin:0 auto">' +
      '<div style="background:#261a36;padding:18px"><h2 style="color:#C8813A;margin:0;font-size:16px">SLA Capital — Application Received</h2></div>' +
      '<div style="padding:18px">' +
        '<div style="display:inline-block;padding:5px 12px;border-radius:18px;background:#256940;color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:14px">RECEIVED</div>' +
        `<p style="font-size:14px;color:#1a1520;line-height:1.55">Hi ${esc(borrowerName) || 'there'},</p>` +
        `<p style="font-size:14px;color:#1a1520;line-height:1.55">Thank you for completing your loan application${propAddr ? ' for <strong>' + esc(propAddr) + '</strong>' : ''}.</p>` +
        `<p style="font-size:14px;color:#1a1520;line-height:1.55"><strong>${esc(loName)}</strong> has been notified and will be in touch shortly with next steps.</p>` +
        '<p style="font-size:13px;color:#7a7488;margin-top:18px">If you have questions, just reply to this email.</p>' +
      '</div>' +
    '</div></body></html>';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject, text, html,
    }),
  });
  return true;
}

async function notifyLO(record) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const toEmail = record.ownerEmail || record.requestedBy;
  if (!toEmail) return false;

  const propAddr = (record.prefill && record.prefill.property && record.prefill.property.address) || '';
  const borrowerName = (record.prefill && record.prefill.borrower)
    ? ((record.prefill.borrower.firstName || '') + ' ' + (record.prefill.borrower.lastName || '')).trim()
    : record.borrowerEmail || '';
  const subject = `Borrower info complete: ${borrowerName || propAddr || 'submission'}`;
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = [
    `${borrowerName || record.borrowerEmail} has completed their borrower information form.`,
    propAddr ? `Property: ${propAddr}` : '',
    '',
    'Open the loan in your Pipeline to review the submission and generate the Loan Application document.',
  ].filter(Boolean).join('\n');
  const html =
    '<!DOCTYPE html><html><body style="font-family:Georgia,serif">' +
    '<div style="max-width:560px;margin:0 auto">' +
      '<div style="background:#261a36;padding:18px"><h2 style="color:#C8813A;margin:0;font-size:16px">SLA Capital — Borrower Info Complete</h2></div>' +
      '<div style="padding:18px">' +
        `<div style="display:inline-block;padding:5px 12px;border-radius:18px;background:#256940;color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;margin-bottom:14px">COMPLETE</div>` +
        `<h3 style="font-size:15px;margin:0 0 6px">${esc(borrowerName) || esc(record.borrowerEmail)}</h3>` +
        (propAddr ? `<div style="font-size:12px;color:#7a7488;font-family:monospace;margin-bottom:14px">${esc(propAddr)}</div>` : '') +
        '<p style="font-size:13px;color:#1a1520;line-height:1.5">The borrower has completed their information form. You can now generate the Loan Application document.</p>' +
        '<p style="font-size:12px;color:#7a7488;margin-top:16px">Open the loan in your Pipeline → Loan Details → Generate Loan Application.</p>' +
      '</div>' +
    '</div></body></html>';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject, text, html,
    }),
  });
  return true;
}
