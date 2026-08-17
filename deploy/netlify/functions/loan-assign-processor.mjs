/**
 * loan-assign-processor.mjs — POST /api/loan-assign-processor
 *
 * Deploy 236.559 — processing-team rollout, slice 1b. Assigns (or unassigns) a
 * PROCESSOR to a loan so the team can pull/distribute work on the Processing
 * Pipeline. Mirrors loan-processing-stage's auth + strict-write pattern.
 *
 * Body:
 *   { clientId, loanId, owner?, processorEmail, processorName }  → assign
 *   { clientId, loanId, owner?, unassign: true }                 → clear
 *
 * Auth: any authenticated staff member; cross-owner (a processor acting on
 * another LO's loan — the normal case) requires admin OR processor via
 * canOverrideOwner (Deploy 236.266). Writes the whole client via the PG-first
 * strict writeClient — no fire-and-forget (strict-write discipline).
 *
 * Stores loan.assignedProcessor = { email, name, at, by }.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-assign-processor error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  // Resolve owner. A processor working another LO's loan passes owner=<LO>;
  // canOverrideOwner allows admin OR processor. Otherwise it's own-owner only.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = client.loans[idx];

  const now = new Date().toISOString();
  const priorAssignee = (loan.assignedProcessor && loan.assignedProcessor.email)
    ? normalizeEmail(loan.assignedProcessor.email) : '';
  if (body.unassign === true || !body.processorEmail) {
    delete loan.assignedProcessor;
  } else {
    const email = normalizeEmail(body.processorEmail);
    const name  = String(body.processorName || '').trim() || email;
    loan.assignedProcessor = { email, name, at: now, by: selfEmail };
  }
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  // Deploy 236.575 — email the newly-assigned processor with a link to the
  // loan (parallels loan-assign-lo's LO-reassign email). Best-effort: a failure
  // never poisons the assign, which has already committed. Skips unassigns,
  // self-assigns (claiming your own), and no-op re-assigns to the same person.
  const newAssignee = loan.assignedProcessor && loan.assignedProcessor.email
    ? normalizeEmail(loan.assignedProcessor.email) : '';
  if (newAssignee && newAssignee !== priorAssignee && newAssignee !== selfEmail) {
    try {
      await _emailAssignedProcessor(req, user, loan, client, ownerKey, loan.assignedProcessor);
    } catch (e) {
      console.warn('loan-assign-processor: notify failed (non-fatal):', e && e.message);
    }
  }

  return json(200, { ok: true, assignedProcessor: loan.assignedProcessor || null });
}

// Deploy 236.575 — Resend email to a newly-assigned processor. ownerKey is the
// loan owner's email (keySafe leaves emails intact), so it doubles as the
// ?owner= param the link needs to resolve the loan under the LO's namespace.
async function _emailAssignedProcessor(req, user, loan, client, ownerKey, assignee) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = assignee && assignee.email;
  if (!apiKey || !toEmail) return;

  const proto = (req.headers.get ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto']) || 'https';
  const host  = (req.headers.get ? req.headers.get('host') : req.headers.host) || '';
  const base  = host ? `${proto}://${host}` : (process.env.URL || 'https://slaloantools.netlify.app');
  const ownerEmail = normalizeEmail(ownerKey);
  const loanLink = base + '/loan-details/' + encodeURIComponent(loan.id) +
    '?owner=' + encodeURIComponent(ownerEmail);

  const meta = (user && user.user_metadata) || {};
  const byName = meta.full_name || meta.fullName || user.email || 'A team member';
  const borrowerName = ((client.firstName || '') + ' ' + (client.lastName || '')).trim()
    || client.email || 'the borrower';
  const address = loan.address || '';
  const amtNum  = parseFloat(String(loan.loanAmt || '').replace(/[$,]/g, '')) || 0;
  const amtStr  = amtNum > 0 ? '$' + Math.round(amtNum).toLocaleString() : '';
  const firstName = String(assignee.name || '').trim().split(/\s+/)[0] || '';

  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const greeting = firstName ? ('Hi ' + firstName + ',') : 'Hi,';
  const subject = 'Loan assigned to you: ' + (borrowerName || address || 'new loan');
  const bodyLines = [
    greeting,
    '',
    byName + ' has assigned a loan to you for processing at SLA Capital.',
    '',
    'Borrower: ' + borrowerName,
    address ? ('Property: ' + address) : '',
    amtStr  ? ('Loan Amount: ' + amtStr) : '',
    '',
    'Open the loan:',
    loanLink,
    '',
    "It's also on your Processing Pipeline under “My Loans”.",
    '',
    '— SLA Capital',
  ].filter(Boolean);
  const text = bodyLines.join('\n');
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#261A36;line-height:1.55">' +
    bodyLines.map((ln) => {
      if (ln === loanLink) {
        return '<p><a href="' + escH(loanLink) + '" style="color:#C8813A;font-weight:600">Open the loan →</a></p>';
      }
      return '<p style="margin:0 0 8px 0">' + escH(ln) + '</p>';
    }).join('') +
    '</div>';

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject, text, html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.warn('loan-assign-processor: email failed', resp.status, t.slice(0, 200));
  }
}
