/**
 * loan-extension-servicer.mjs — POST /api/loan-extension-servicer
 *
 * Deploy 236.903 (Mike) — the servicer hand-off for an executed extension.
 *
 * "add a check box to confirm when the extension is sent to and accepted by
 * the servicer. Once it is accepted, update the Maturity Date and make sure
 * the extension email automation occurs again on that new date."
 *
 * Two independent marks, because they are two different facts:
 *   sent     — we forwarded the executed agreement to the servicer
 *   accepted — the servicer confirmed they have boarded it
 *
 * ACCEPTANCE IS WHAT MOVES THE MATURITY DATE. Until the servicer has it, the
 * loan's maturity is still whatever they are servicing to; the signed
 * agreement alone doesn't change what the servicer will do. That is also why
 * maturity was deliberately left alone before now (236.847: "it syncs from
 * FCI") — this gives it an explicit, human-confirmed moment to change on.
 *
 * The maturity reminder then re-arms BY ITSELF. maturity-reminder-cron keys
 * its ledger by the maturity date (`loan.maturityNotified[maturity]`), so a
 * new date simply has no entry yet and the one-month-out notice fires again
 * for it. Nothing here needs to schedule anything — but the ledger entry for
 * the OLD date is left in place, so the old notice can never re-fire.
 *
 * Body: {
 *   clientId, loanId, owner?,
 *   sent?: boolean, accepted?: boolean,
 *   newMaturityDate?: 'YYYY-MM-DD'   // defaults to the executed agreement's
 * }
 * Auth: processor tier.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-servicer error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const gate = canOverrideOwner(user);
  if (!gate.ok) return json(gate.status || 403, { error: gate.reason || 'Not authorized' });

  const body = await readJsonBody(req);
  if (!body || !body.loanId) return json(400, { error: 'loanId required' });
  if (body.sent === undefined && body.accepted === undefined) {
    return json(400, { error: 'Nothing to change — pass sent and/or accepted.' });
  }

  const selfEmail = normalizeEmail(user.email);
  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const found = await locateLoan({
    ownerKey, clientId: body.clientId, loanId: body.loanId, clientsStore,
  });
  if (!found) return json(404, { error: 'Loan not found' });
  const { client, loan } = found;

  const ext = loan.extensionEsign || null;
  if (!ext || ext.status !== 'completed') {
    return json(400, { error: 'This loan has no fully executed extension agreement yet.' });
  }

  const now = new Date().toISOString();
  const prev = (loan.extensionServicer && typeof loan.extensionServicer === 'object')
    ? loan.extensionServicer : {};
  const rec = { ...prev, envelopeId: ext.envelopeId || '' };
  const notes = [];

  if (body.sent !== undefined) {
    if (body.sent) {
      if (!prev.sentAt) { rec.sentAt = now; rec.sentBy = selfEmail; notes.push('sent to the servicer'); }
    } else {
      delete rec.sentAt; delete rec.sentBy;
      notes.push('un-marked as sent to the servicer');
    }
  }

  // ── Acceptance: the moment maturity actually moves ────────────────
  let maturityChanged = null;
  if (body.accepted !== undefined) {
    if (body.accepted) {
      if (!prev.acceptedAt) { rec.acceptedAt = now; rec.acceptedBy = selfEmail; }

      const newMaturity = String(body.newMaturityDate || ext.newMaturityDate || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newMaturity)) {
        return json(400, { error: 'No new maturity date on the executed agreement — pass newMaturityDate.' });
      }
      const oldMaturity = loan.maturityDate || '';
      if (oldMaturity !== newMaturity) {
        rec.priorMaturityDate = oldMaturity;
        loan.maturityDate = newMaturity;
        maturityChanged = { from: oldMaturity || '(none)', to: newMaturity };
        // The ledger entry for the OLD date stays put on purpose: it stops the
        // old notice re-firing, while the NEW date has no entry so the
        // one-month-out reminder arms itself for it.
        notes.push('accepted by the servicer — maturity moved ' +
          (oldMaturity || '(none)') + ' → ' + newMaturity);
      } else {
        notes.push('accepted by the servicer (maturity already ' + newMaturity + ')');
      }
    } else {
      delete rec.acceptedAt; delete rec.acceptedBy;
      notes.push('un-marked as accepted by the servicer');
      // Deliberately NOT reverting maturityDate. Un-ticking a box should not
      // silently rewrite a date the servicer may already be servicing to;
      // correct it in the servicing editor if it really was wrong.
      if (prev.priorMaturityDate) {
        notes.push('(maturity left at ' + (loan.maturityDate || '—') +
          ' — change it in the servicing editor if that is wrong)');
      }
    }
  }

  loan.extensionServicer = rec;
  loan.updatedAt = now;

  appendNoteEntry(loan, {
    kind: 'status',
    text: 'Loan extension ' + notes.join('; ') + '.',
    author: (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || user.email || '',
    authorEmail: selfEmail,
    meta: { via: 'loan_extension_servicer', envelopeId: ext.envelopeId || '' },
  });

  await writeClient(found.ownerKey, client, { clientsStore });

  return json(200, {
    ok: true,
    extensionServicer: rec,
    maturityDate: loan.maturityDate || '',
    maturityChanged,
    // Surfaced so the UI can say so plainly rather than the user wondering.
    reminderRearmed: !!maturityChanged,
  });
}
