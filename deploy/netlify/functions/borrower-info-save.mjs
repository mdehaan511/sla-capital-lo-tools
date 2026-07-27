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
import { resolveByToken } from './_shared/borrower-info-token-index.mjs';
import { syncPropertyFieldsToLoan, advanceQuoteToInProcessing } from './_shared/borrower-info-sync.mjs';
// Deploy 223 — reply_to = LO who owns the lead.
import { getOwnerReplyTo } from './_shared/email.mjs';
// Deploy 228 — parse single-line Google formatted_address to fill
// city/state/zip on guarantor home + company addresses.
import { fillAddressBlanks } from './_shared/address.mjs';
import { borrowerInfoIndex } from './_shared/borrower-info-index.mjs'; // Deploy 236.343
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';

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
  const _rl = await checkRateLimit(req, null, { bucket: 'binfo-save', max: 300, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.t) return json(400, { error: 'Missing token' });

  const store = getStore({ name: 'borrower_info', consistency: 'strong' });

  // Deploy 172: try the token index first (O(1) lookup), fall back to
  // a full store walk for legacy tokens that pre-date the index. After
  // a successful walk-fallback we write the index entry so subsequent
  // lookups for the same token use the fast path.
  // Deploy 236.414 — shared bounded resolver (index fast path, budgeted
  // chunked walk, self-heal). Replaces the unbounded sequential walk
  // that could 504 on stale/rotated tokens — and this endpoint fires
  // on every autosave, so a borrower with an unindexed token was
  // paying the walk cost every few SECONDS while filling the form.
  const resolved = await resolveByToken(store, body.t);
  const record = resolved.record;
  const recordKey = resolved.recordKey;
  if (!record) {
    return json(404, {
      error: 'This application link is no longer active — it may have been replaced by a newer email. ' +
             'Please open the MOST RECENT application email from your loan officer and use that link.',
    });
  }
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

  // Deploy 168: per-loan storage. If this record is currently at a
  // legacy per-client key (no `/loanId` segment), migrate it forward
  // on save. We still keep the legacy key around as a safety duplicate
  // until we're confident nothing in the system depends on it; future
  // reads prefer the new key.
  const isLegacyKey = recordKey && recordKey.split('/').length < 3;
  if (isLegacyKey && record.loanId) {
    const newKey = `${record.ownerKey}/${recordKey.split('/')[1]}/${record.loanId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    // Write to new key first
    await store.setJSON(newKey, record);
    // Update legacy in place too (so already-cached references still
    // resolve correctly until the legacy gets pruned in a later deploy)
    await store.setJSON(recordKey, record);
  } else {
    await store.setJSON(recordKey, record);
  }
  // Deploy 236.343 — write-through the borrower-info index.
  borrowerInfoIndex.upsertRecord(record.ownerKey, record).catch(() => {});

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

// Merge incoming data with existing. SSN values in guarantors get
// encrypted into a separate ssn_enc field; the plaintext never lands in
// stored JSON. If the incoming SSN is empty/unchanged ("***-**-1234" mask),
// we keep whatever we already had.
//
// Deploy 228 — also parse the single-line Google formatted_address that
// the long app stores in g.address / company.address. If the borrower
// picked from autocomplete, g.address holds the full string but the
// separate g.city / g.state / g.zip fields are blank. Without this
// parse pass: (1) Client Profile saves an empty home-address city/
// state/zip; (2) Baseline borrower-create gets a partial address and
// 500s server-side; (3) the LO loses structured data for reporting.
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
      // Deploy 228 — parse the home address single-line string to fill
      // city/state/zip if they're blank. Also parses the optional
      // previous-address + mailing-address fields collected post-
      // Deploy 182. Non-destructive: never overwrites an explicit value.
      fillAddressBlanks(merged);
      if (merged.prevAddress || merged.prevCity || merged.prevState || merged.prevZip) {
        // Treat the prev-address bundle as its own object so the parser
        // can refill its companion city/state/zip without colliding
        // with the home address fields.
        const prev = { address: merged.prevAddress, city: merged.prevCity, state: merged.prevState, zip: merged.prevZip };
        fillAddressBlanks(prev);
        merged.prevCity  = prev.city;
        merged.prevState = prev.state;
        merged.prevZip   = prev.zip;
      }
      if (merged.mailingAddress || merged.mailingCity || merged.mailingState || merged.mailingZip) {
        const mail = { address: merged.mailingAddress, city: merged.mailingCity, state: merged.mailingState, zip: merged.mailingZip };
        fillAddressBlanks(mail);
        merged.mailingCity  = mail.city;
        merged.mailingState = mail.state;
        merged.mailingZip   = mail.zip;
      }
      return merged;
    });
  }

  // Deploy 228 — same address-parse pass for companies (LLC vesting
  // entities). The long app collects company.address as a single Google
  // formatted_address; without parsing, Client Profile companies and
  // Baseline entity-create both miss city/state.
  if (Array.isArray(incoming.companies)) {
    const existingCo = Array.isArray(existing.companies) ? existing.companies : [];
    out.companies = incoming.companies.map((c, i) => {
      const exC = existingCo[i] || {};
      const merged = Object.assign({}, exC, c);
      fillAddressBlanks(merged);
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

  const replyTo = await getOwnerReplyTo(record.ownerKey);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject, text, html,
      ...(replyTo ? { reply_to: replyTo } : {}),
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

  const replyTo = await getOwnerReplyTo(record.ownerKey);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject, text, html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  return true;
}
