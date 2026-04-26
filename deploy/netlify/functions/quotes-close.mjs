/**
 * quotes-close.mjs — POST /api/quotes-close
 *
 * Admin-only. Marks a quote 'closed' with finalized financials.
 *
 * Body: {
 *   ownerKey:         storage prefix the quote lives under (LO email)
 *   quoteId:          the quote id
 *   finalLoanAmount:  number — admin can override the original loanAmt
 *   commissionRate:   number — basis points (e.g. 50 = 0.50%)
 *   notes?:           optional admin note
 * }
 *
 * The function computes commissionAmount = finalLoanAmount × commissionRate / 10000.
 * Mirrors the close into the matching loan in the client record so the
 * Loan Details page reflects it.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const { ownerKey, quoteId, finalLoanAmount, commissionRate, notes } = body || {};
  if (!ownerKey || !quoteId) return json(400, { error: 'ownerKey and quoteId required' });

  const finalAmt = Number(finalLoanAmount);
  const rateBps  = Number(commissionRate);
  if (!isFinite(finalAmt) || finalAmt <= 0) return json(400, { error: 'finalLoanAmount must be a positive number' });
  if (!isFinite(rateBps)  || rateBps  < 0)  return json(400, { error: 'commissionRate must be a non-negative number (basis points)' });

  const cleanOwner = keySafe(String(ownerKey).toLowerCase());
  const cleanId    = keySafe(String(quoteId));
  const key = `${cleanOwner}/${cleanId}`;

  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  let quote;
  try {
    quote = await quotesStore.get(key, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load quote' });
  }
  if (!quote) return json(404, { error: 'Quote not found' });

  const commissionAmount = Math.round(finalAmt * rateBps) / 10000;
  const now = new Date().toISOString();

  // Preserve a backup of the original financials the first time we close
  if (!quote.originalLoanAmt) {
    quote.originalLoanAmt = quote.loanAmt || (quote.formData && quote.formData.loanAmt) || '';
  }

  quote.status            = 'closed';
  quote.finalLoanAmount   = finalAmt;
  quote.commissionRate    = rateBps;
  quote.commissionAmount  = commissionAmount;
  quote.closedAt          = quote.closedAt || now;
  quote.closedBy          = quote.closedBy || (user.email || '');
  quote.lastEditedAt      = now;
  quote.lastEditedBy      = user.email || '';
  quote.updatedAt         = now;
  if (notes != null && String(notes).trim()) {
    quote.closeNotes = String(notes).trim();
  }

  try {
    await quotesStore.setJSON(key, quote);
  } catch (e) {
    return json(500, { error: 'Failed to save closed loan' });
  }

  // Mirror status into client record's matching loan
  try {
    await syncToClientLoan(cleanOwner, quote);
  } catch (e) {
    console.warn('quotes-close: client sync failed:', e);
  }

  return json(200, { ok: true, quote });
};

async function syncToClientLoan(ownerKey, quote) {
  if (!quote.address) return;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(quote.address);

  const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
  for (const { key } of blobs) {
    const c = await clientsStore.get(key, { type: 'json' });
    if (!c || !c.loans) continue;
    let changed = false;
    for (const l of c.loans) {
      if (norm(l.address) === target) {
        l.status            = 'closed';
        l.finalLoanAmount   = quote.finalLoanAmount;
        l.commissionRate    = quote.commissionRate;
        l.commissionAmount  = quote.commissionAmount;
        l.closedAt          = quote.closedAt;
        l.closedBy          = quote.closedBy;
        l.updatedAt         = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await clientsStore.setJSON(key, c);
  }
}
