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

  // Notify LO on completion (best-effort)
  if (body.complete) {
    try {
      await notifyLO(record);
    } catch (e) {
      console.warn('borrower-info-save: LO notify failed:', e);
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
