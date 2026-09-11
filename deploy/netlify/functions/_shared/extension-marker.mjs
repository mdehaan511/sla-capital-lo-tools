/**
 * extension-marker.mjs — loan.extensionEsign, the status marker behind a loan
 * extension (the chip on the Closed Loans servicing rows + the Loan Extension
 * box on Loan Details).
 *
 * Deploy 236.974 — moved out of envelope-sign.mjs so that everything that
 * changes who still has to sign (envelope-sign, loan-extension-send,
 * loan-extension-add-signer) writes the SAME marker. It now also records WHO
 * is up next (pendingSigner) and every signer's state (signers[]), because an
 * extension can carry extra guarantor signers since 236.974 (Mike: "extensions
 * can be sent to both of the guarantors") — "lender signed, borrower next" is
 * no longer the only partial state.
 *
 * Marker shape:
 *   { envelopeId, status: 'sent' | 'lender_signed' | 'completed' | 'cancelled',
 *     sentAt, newMaturityDate, updatedAt,
 *     pendingSigner: { name, email, role } | null,
 *     signers: [{ name, email, role, signed, signedAt }],
 *     executedAt }            // first time it reached completed (survives a
 *                             // later added signer, so the executed copy stays
 *                             // downloadable while they sign)
 */
import { getStore } from '@netlify/blobs';
import { locateLoan } from './loan-locate.mjs';
import { appendNoteEntry } from './notes-log.mjs';
import { writeClient } from './client-write.mjs';

export function signerName(s) {
  return (((s && s.firstName) || '') + ' ' + ((s && s.lastName) || '')).replace(/\s*—\s*$/, '').trim();
}
export function isSigned(s) {
  return !!(s && s.audit && s.audit.signedAt);
}
/** The first signer who still has to sign (sequential order), or null. */
export function pendingSignerOf(envelope) {
  const s = ((envelope && envelope.signers) || []).find((x) => x && !isSigned(x));
  return s ? { name: signerName(s), email: s.email || '', role: s.role || '' } : null;
}
export function signerProgress(envelope) {
  return ((envelope && envelope.signers) || []).map((s) => ({
    name: signerName(s), email: (s && s.email) || '', role: (s && s.role) || '',
    signed: isSigned(s), signedAt: (s && s.audit && s.audit.signedAt) || (s && s.signedAt) || null,
  }));
}
export function markerFields(envelope) {
  return { pendingSigner: pendingSignerOf(envelope), signers: signerProgress(envelope) };
}

/**
 * Write the marker onto the loan the envelope belongs to. Finds the loan by
 * LOAN id (236.897 — the client can be merged away between send and sign).
 * Best-effort: never throws into the caller.
 */
export async function syncExtensionMarker(envelope, status, noteText, opts) {
  if (!envelope || envelope.envelopeKind !== 'loan_extension' || !envelope.loanId) return false;
  try {
    const clientsStore = (opts && opts.clientsStore) || getStore({ name: 'clients', consistency: 'strong' });
    const found = await locateLoan({
      ownerKey: envelope.ownerKey,
      clientId: envelope.clientId,
      loanId: envelope.loanId,
      clientsStore,
    });
    if (!found) return false;
    const { client, loan } = found;
    if (found.moved) {
      console.log('[extension-marker] loan ' + envelope.loanId + ' moved from client ' + envelope.clientId + ' to ' + found.clientId);
    }
    const cur = loan.extensionEsign;
    // A newer extension envelope owns the chip — don't let a stale one clobber it.
    if (cur && cur.envelopeId && cur.envelopeId !== envelope.id) return false;
    const now = new Date().toISOString();
    loan.extensionEsign = {
      envelopeId: envelope.id,
      status,
      sentAt: (cur && cur.sentAt) || envelope.createdAt || '',
      newMaturityDate: (envelope.extensionTerms && envelope.extensionTerms.newMaturityDate) ||
        (cur && cur.newMaturityDate) || '',
      updatedAt: now,
      executedAt: (cur && cur.executedAt) || (status === 'completed' ? now : ''),
      ...markerFields(envelope),
      ...((opts && opts.extra) || {}),
    };
    if (noteText) {
      appendNoteEntry(loan, {
        kind: 'status', text: noteText,
        author: (opts && opts.author) || 'eSign', authorEmail: (opts && opts.authorEmail) || envelope.requesterEmail || '',
        meta: { via: (opts && opts.via) || 'envelope_sign', envelopeId: envelope.id },
      });
    }
    loan.updatedAt = now;
    await writeClient(found.ownerKey, client, { clientsStore });
    return true;
  } catch (e) {
    console.warn('[extension-marker] sync failed (non-fatal):', e && e.message);
    return false;
  }
}
