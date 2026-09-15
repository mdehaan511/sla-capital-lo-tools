/**
 * fci-loan-charge.mjs — POST /api/fci-loan-charge
 *
 * Deploy 237.068 (Mike) — add a charge (late fee, inspection, legal, NSF fee…)
 * to a loan at FCI straight from the Closed Loans Servicing row, so servicing
 * problems can be handled here instead of in FCI's portal.
 *
 * Body: { loanId, clientId, owner, chargeCode, amount, date (YYYY-MM-DD),
 *         comments?, paidBy? ('Borrower' default), invoiceNumber?,
 *         isBorrowerRecoverable? (true default), interestRate? }
 *
 * Flow: locate the loan (needs servicerName FCI + servicerLoanNumber), resolve
 * FCI's lender account (stamped by the sync as fciLenderAccount; falls back to
 * one portfolio lookup), call insertLoanCharge, then write a Notes & Activity
 * entry + audit-log line and invalidate the cached FCI charges for the loan.
 *
 * Auth: processor or admin.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe, isAdmin, isProcessor } from './_shared/auth.mjs';
import { fciConfigured, fciInsertCharge, fciPortfolio, fciAccount } from './_shared/fci-api.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { recordLoanChanges } from './_shared/loan-change-log.mjs';
import { fetchAndCache } from './_shared/payment-history.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user) && !isProcessor(user)) return json(403, { error: 'Processor or admin only' });
    if (!fciConfigured()) return json(503, { error: 'FCI_API_TOKEN is not set' });

    const body = (await readJsonBody(req)) || {};
    const loanId = String(body.loanId || '').trim();
    const clientId = String(body.clientId || '').trim();
    const owner = normalizeEmail(body.owner || user.email);
    const amount = Number(String(body.amount == null ? '' : body.amount).replace(/[$,\s]/g, ''));
    const chargeCode = String(body.chargeCode || '').trim().slice(0, 40);
    const date = String(body.date || '').trim();
    if (!loanId || !clientId) return json(400, { error: 'loanId and clientId required' });
    if (!chargeCode) return json(400, { error: 'Charge code required (FCI\'s code for the fee type)' });
    if (!(amount > 0)) return json(400, { error: 'Amount must be greater than zero' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'Charge date must be YYYY-MM-DD' });

    const ownerKey = keySafe(owner);
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
    const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) : null;
    if (!loan) return json(404, { error: 'Loan not found' });
    if (!/fci/i.test(String(loan.servicerName || '')) || !String(loan.servicerLoanNumber || '').trim()) return json(400, { error: 'This loan is not linked to an FCI account' });
    const account = fciAccount(loan.servicerLoanNumber);

    let lenderAccount = String(loan.fciLenderAccount || '').trim();
    if (!lenderAccount) {
      const rows = await fciPortfolio();
      const hit = rows.find((r) => fciAccount(r.loanAccount) === account);
      lenderAccount = hit ? String(hit.lenderAccount || '').trim() : '';
      if (!lenderAccount) return json(400, { error: 'FCI did not return a lender account for this loan' });
    }

    const result = await fciInsertCharge({
      loanNumber: account, investorAccountNumber: lenderAccount, chargeCode,
      chargeDate: date, chargeAmount: amount,
      interestRate: body.interestRate != null && body.interestRate !== '' ? Number(body.interestRate) : 0,
      paidBy: String(body.paidBy || 'Borrower').slice(0, 40),
      invoiceNumber: String(body.invoiceNumber || '').slice(0, 60),
      comments: String(body.comments || '').slice(0, 500),
      isBorrowerRecoverable: body.isBorrowerRecoverable !== false,
    });

    const actorName = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || user.email || '';
    const now = new Date().toISOString();
    appendNoteEntry(loan, {
      kind: 'status',
      text: 'FCI charge added: ' + chargeCode + ' $' + amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' dated ' + date + (body.comments ? ' — ' + String(body.comments).slice(0, 200) : ''),
      author: actorName, authorEmail: normalizeEmail(user.email), meta: { via: 'fci_charge', account, chargeCode, amount },
    });
    loan.updatedAt = now; client.updatedAt = now;
    await writeClient(ownerKey, client, { clientsStore });
    await recordLoanChanges({ ownerKey, clientId, loanId, actor: normalizeEmail(user.email), actorName, source: 'FCI charge',
      changes: [{ field: 'fciCharge', label: 'FCI charge', from: '', to: chargeCode + ' $' + amount + ' (' + date + ')' }] }).catch(() => {});
    // Refresh the cached charges/ledger so the row shows it right away.
    let refreshed = null;
    try { refreshed = await fetchAndCache('FCI', account); } catch (_) {}
    return json(200, { ok: true, fci: result, cached: refreshed });
  } catch (e) {
    console.error('fci-loan-charge error:', e);
    return json(500, { error: 'FCI charge failed: ' + ((e && e.message) || 'unknown') });
  }
};
