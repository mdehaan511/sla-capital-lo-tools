/**
 * loan-set-broker-flag.mjs — POST /api/loan-set-broker-flag
 *
 * Deploy 236.327 — flip a loan's `_isBrokerLoan` flag from Loan
 * Details, and (on convert-to-standard) clear the broker contact
 * fields so downstream views (Pipeline tile broker badge, term-sheet
 * "Submitted via Broker" line, etc.) stop showing broker data on a
 * non-broker deal. Owner override allowed for admin / processor.
 *
 * Body: { clientId, loanId, isBroker, owner? }
 *   isBroker=false → strip broker flag + brokerName / brokerCompany /
 *                     brokerEmail / brokerPhone / brokerFee / brokerId.
 *   isBroker=true  → just set the flag; broker contact fields are the
 *                     caller's responsibility (usually captured via
 *                     the sizer's Broker Deal toggle instead of this
 *                     endpoint — but shipped for completeness).
 *
 * Response: { ok: true, loan }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-set-broker-flag top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = String(body.clientId || '').trim();
  const loanId   = String(body.loanId   || '').trim();
  const isBroker = !!body.isBroker;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

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
  let primaryKey = ownerKey + '/' + keySafe(clientId);
  let primary;
  try { primary = await clientsStore.get(primaryKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client record: ' + (e.message || 'unknown') }); }

  // Same cross-namespace recovery as loan-add-guarantor (236.317) —
  // if the derived key misses AND the caller can override owner, scan
  // for the client id under any namespace.
  if (!primary && canOverrideOwner(user).ok) {
    try {
      const { blobs } = await clientsStore.list();
      const wantSuffix = '/' + keySafe(clientId);
      for (const { key } of blobs) {
        if (!key.endsWith(wantSuffix)) continue;
        const rec = await clientsStore.get(key, { type: 'json' });
        if (rec && rec.id === clientId) {
          primary = rec;
          primaryKey = key;
          const slash = key.indexOf('/');
          if (slash > 0) ownerKey = key.slice(0, slash);
          break;
        }
      }
    } catch (_) {}
  }
  if (!primary) return json(404, { error: 'Client not found' });
  if (!Array.isArray(primary.loans)) return json(404, { error: 'Client has no loans array' });

  const loanIdx = primary.loans.findIndex((l) => l && l.id === loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = primary.loans[loanIdx];

  const now = new Date().toISOString();
  const prev = !!loan._isBrokerLoan;
  const clearedBroker = (prev && !isBroker)
    ? {
        name:    loan.brokerName    || '',
        company: loan.brokerCompany || '',
        email:   loan.brokerEmail   || '',
        phone:   loan.brokerPhone   || '',
        fee:     loan.brokerFee     || '',
        id:      loan.brokerId      || '',
      }
    : null;

  loan._isBrokerLoan = isBroker;
  if (!isBroker) {
    // Wipe broker contact fields — the section shouldn't render them
    // on a non-broker deal.
    loan.brokerName    = '';
    loan.brokerCompany = '';
    loan.brokerEmail   = '';
    loan.brokerPhone   = '';
    loan.brokerFee     = '';
    loan.brokerId      = '';
  }
  loan.updatedAt = now;

  // Audit entry.
  const meta = (user && user.user_metadata) || {};
  const author = meta.full_name || meta.fullName || user.email || '';
  appendNoteEntry(loan, {
    kind: isBroker ? 'broker_flag_on' : 'broker_flag_off',
    text: isBroker
      ? 'Marked as broker deal.'
      : ('Converted to standard (non-broker) deal.' +
         (clearedBroker && (clearedBroker.name || clearedBroker.company || clearedBroker.email)
           ? ' Cleared broker: ' + [clearedBroker.name, clearedBroker.company, clearedBroker.email].filter(Boolean).join(' · ')
           : '')),
    author,
    authorEmail: user.email || '',
    meta: {
      prev,
      next: isBroker,
      clearedBroker,
    },
  });

  primary.loans[loanIdx] = loan;
  primary.updatedAt = now;
  try { await clientsStore.setJSON(primaryKey, primary); }
  catch (e) { return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan });
}
