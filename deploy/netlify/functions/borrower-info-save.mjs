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
    // jumps to the "In Processing" pipeline column. Result is captured
    // and logged loudly when the auto-advance bailed — useful when LOs
    // report "borrower completed the app but the loan didn't move" so
    // we can see WHY in the function logs.
    let advanceResult = null;
    try {
      advanceResult = await advanceQuoteToInProcessing(record);
      if (advanceResult && !advanceResult.ok) {
        console.warn(
          'borrower-info-save: auto-advance bailed —',
          'token=' + (record.token || '').slice(0, 8),
          'reason=' + advanceResult.reason
        );
      }
    } catch (e) {
      console.warn('borrower-info-save: quote advance threw:', e);
      advanceResult = { ok: false, reason: 'exception: ' + (e.message || 'unknown') };
    }
    // Stamp the advance result on the borrower-info record itself so
    // we can audit later without grepping logs.
    record.advanceResult = advanceResult;
    try { await store.setJSON(recordKey, record); } catch (_) {}
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
  if (data.planDescription) loanUpdates.projectDescription = String(data.planDescription);
  // Item #10: long-app close date → loan record fundingDate (renamed Desired Close Date everywhere)
  if (data.dscrCloseDate) loanUpdates.fundingDate = String(data.dscrCloseDate);
  if (data.ffCloseDate)   loanUpdates.fundingDate = String(data.ffCloseDate);

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
  // Item #5: experience metrics — # of flips in last 36 months, # of rentals owned
  if (g0.flips !== undefined && g0.flips !== '')      clientUpdates.flips    = String(g0.flips);
  if (g0.rentals !== undefined && g0.rentals !== '')  clientUpdates.rentals  = String(g0.rentals);
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

// Try to auto-advance the matching quote(s) + client.loan record from
// `awaiting_app` → `approved` when the borrower submits the loan app.
//
// Failure modes this function defends against (Deploy 167):
//   1. record.loanId doesn't match any loan on the client → fall back to
//      address-matching across all loans, not just exactly-one-loan
//   2. Quote address has trailing ", USA"/", US" or "Street" vs "St" etc.
//      Use aggressive normalization rather than simple lowercase+trim
//   3. Quote status is not exactly 'awaiting_app' → only bump statuses
//      we know are valid pre-conditions; never downgrade
//
// Returns: { ok: bool, reason?: string, quotesUpdated: number, loanUpdated: bool }
// so the caller can surface diagnostic info if the auto-advance failed.
async function advanceQuoteToInProcessing(record) {
  if (!record.ownerKey || !record.clientId) {
    return { ok: false, reason: 'missing ownerKey or clientId on record', quotesUpdated: 0, loanUpdated: false };
  }
  // Find the loan address from the client record so we can match the quote
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${record.ownerKey}/${record.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client || !Array.isArray(client.loans)) {
    return { ok: false, reason: 'client not found or has no loans', quotesUpdated: 0, loanUpdated: false };
  }

  // Identify the target loan: prefer record.loanId; fall back to (in order):
  //   - the only loan, if there's exactly one
  //   - the only loan still in awaiting_app, if there's exactly one such
  //   - null (and we bail with a reason)
  let targetLoan = null;
  if (record.loanId) targetLoan = client.loans.find((l) => l.id === record.loanId);
  if (!targetLoan && client.loans.length === 1) targetLoan = client.loans[0];
  if (!targetLoan) {
    const awaiting = client.loans.filter((l) => l.status === 'awaiting_app');
    if (awaiting.length === 1) targetLoan = awaiting[0];
  }
  if (!targetLoan || !targetLoan.address) {
    return {
      ok: false,
      reason: record.loanId
        ? `no loan matched loanId="${record.loanId}" (client has ${client.loans.length} loans)`
        : `no targetable loan (client has ${client.loans.length} loans, ${client.loans.filter(l => l.status === 'awaiting_app').length} awaiting_app)`,
      quotesUpdated: 0,
      loanUpdated: false,
    };
  }

  // Aggressive address normalization. Tolerates ", USA" tails, "Street"
  // vs "St" variants, comma/period punctuation differences. Same algo
  // used by loan-advance-status.mjs.
  const aggrNorm = (s) => {
    let x = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    x = x.replace(/,\s*(usa|us|united states)\.?$/i, '');
    x = x.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
         .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
         .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
         .replace(/\bcourt\b/g, 'ct').replace(/\bcircle\b/g, 'cir')
         .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
         .replace(/\btrail\b/g, 'trl').replace(/\bterrace\b/g, 'ter');
    x = x.replace(/[.,]/g, '');
    return x.trim();
  };
  const target = aggrNorm(targetLoan.address);

  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  let quotesUpdated = 0;
  let quotesMatched = 0;
  try {
    const { blobs } = await quotesStore.list({ prefix: record.ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q || aggrNorm(q.address) !== target) continue;
      quotesMatched += 1;
      if (q.status === 'awaiting_app') {
        q.status = 'approved';
        q.updatedAt = new Date().toISOString();
        q.borrowerInfoCompletedAt = record.completedAt || new Date().toISOString();
        await quotesStore.setJSON(key, q);
        quotesUpdated += 1;
      }
    }
  } catch (e) {
    return { ok: false, reason: 'quote store error: ' + (e.message || 'unknown'), quotesUpdated, loanUpdated: false };
  }

  // Mirror the status into the client loan record(s) that match
  let loanUpdated = false;
  for (const l of client.loans) {
    if (aggrNorm(l.address) === target && l.status === 'awaiting_app') {
      l.status = 'approved';
      l.updatedAt = new Date().toISOString();
      l.borrowerInfoCompletedAt = record.completedAt || new Date().toISOString();
      loanUpdated = true;
    }
  }
  if (loanUpdated) {
    try {
      await clientsStore.setJSON(clientKey, client);
    } catch (e) {
      return { ok: false, reason: 'client save error: ' + (e.message || 'unknown'), quotesUpdated, loanUpdated: false };
    }
  }

  // If we matched a loan and updated it, that's the primary success signal.
  // Zero quote matches is suspect (we'd expect at least one per loan) but
  // not catastrophic if the loan record itself was updated correctly.
  if (loanUpdated) {
    return { ok: true, quotesUpdated, loanUpdated, quotesMatched };
  }
  // No loan record was in awaiting_app, but maybe it was already advanced
  // by something else. Distinguish from "nothing matched at all".
  const anyAwaiting = client.loans.some((l) => aggrNorm(l.address) === target && l.status === 'awaiting_app');
  if (!anyAwaiting && quotesMatched > 0) {
    return { ok: true, reason: 'loan was already past awaiting_app', quotesUpdated, loanUpdated: false, quotesMatched };
  }
  return {
    ok: false,
    reason: `no awaiting_app loan matched address "${targetLoan.address}" (normalized: "${target}"); ${quotesMatched} quote(s) matched address but none were in awaiting_app`,
    quotesUpdated,
    loanUpdated: false,
    quotesMatched,
  };
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
