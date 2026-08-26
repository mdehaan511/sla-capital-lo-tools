/**
 * loan-rate-lock-reset.mjs — POST /api/loan-rate-lock-reset
 *
 * Deploy 236.763 — DSCR rate lock: 45 days from the day the loan
 * application is signed (rateLockStart, stamped by borrower-info-sync;
 * legacy loans fall back to borrowerInfoCompletedAt for display). This
 * endpoint is the "Reset Rate Lock" action in the Loan Details Actions
 * menu: restarts the clock at 45 days from NOW, clears the reminder
 * ledger (rateLockNotified) so the 30/15/10/5-day emails re-arm, and
 * logs a note entry for the audit trail.
 *
 * Body: { clientId, loanId, owner? }
 * Auth: the loan's OWNER may reset their own; cross-owner requires
 * processor/admin (standard owner-override pattern).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

const LOCK_DAYS = 45;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-rate-lock-reset error:', e);
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

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && normalizeEmail(body.owner) !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires processor or admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);
  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found' });
  if (!Array.isArray(client.loans)) client.loans = [];

  const loan = client.loans.find((l) => l && l.id === loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });
  if (String(loan.toolType || '').toLowerCase() !== 'dscr') {
    return json(400, { error: 'Rate locks apply to DSCR loans only' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expires = new Date(now.getTime() + LOCK_DAYS * 86400000);
  const prevStart = loan.rateLockStart || loan.borrowerInfoCompletedAt || '';

  loan.rateLockStart = nowIso;
  // Re-arm the 30/15/10/5-day reminder emails for the new period.
  delete loan.rateLockNotified;
  loan.updatedAt = nowIso;
  appendNoteEntry(loan, {
    kind:        'rate_lock',
    text:        'Rate lock RESET to ' + LOCK_DAYS + ' days (expires ' + expires.toISOString().slice(0, 10) + ')' +
                 (prevStart ? ' — previous lock started ' + String(prevStart).slice(0, 10) : '') + '.',
    author:      selfEmail,
    authorEmail: selfEmail,
    meta:        { rateLockStart: nowIso, previousStart: prevStart },
  });

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, {
    ok: true,
    rateLockStart: nowIso,
    rateLockExpires: expires.toISOString(),
  });
}
