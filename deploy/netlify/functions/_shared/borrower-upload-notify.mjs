/**
 * _shared/borrower-upload-notify.mjs — Deploy 237.195 (Beth, via Mike)
 *
 * Beth: "is there a way for us to receive notifications when a borrower uploads or sends
 * new documents? ... the notif would be specific to each processor/loan officer.
 * For example: 'Mike/Borrower just uploaded PFS – Property Address'"
 *
 * One place that turns a borrower upload into bell notifications, so every borrower
 * upload path says the same thing to the same people. It rides the per-user notification
 * doc the bell already polls (237.050), which means no new poll and no new store.
 *
 * WHO: only the people working the loan — the LO who owns it and its assigned processors
 * (see loan-watchers). Not the admins. Beth asked for exactly this, and she was right to:
 * a bell that fires for every upload on every loan is a bell nobody reads.
 *
 * The uploader is never notified about their own upload — which also means a PROCESSOR
 * uploading on a borrower's behalf does not ping themselves.
 *
 * Zero-throw. A notification is a courtesy; it must never be the reason a borrower's
 * document fails to save.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { pushUserNotification } from './user-notifications.mjs';
import { loanWatchers, uploadNotice } from './loan-watchers.mjs';

/**
 * @param a.review        the loan review (source + snapshots)
 * @param a.docLabel      what was uploaded, in the tray's words ("Personal Financial Statement")
 * @param a.uploaderEmail who uploaded it — excluded from the recipients
 * @param a.uploaderName  their display name, for the notification's first words
 * @returns { notified, recipients } — never throws
 */
export async function notifyBorrowerUpload({ review, docLabel, uploaderEmail, uploaderName }) {
  try {
    const src = (review && review.source) || {};
    const ownerKey = String(src.ownerKey || '');
    const loanId = String(src.loanId || '');
    const clientId = String(src.clientId || '');
    if (!ownerKey || !loanId) return { notified: 0, recipients: [] };

    // Read the loan for its CURRENT processing team — the review's snapshot can predate
    // the assignment, and "who is working this loan" is the whole point of the feature.
    let loan = null;
    let client = null;
    try {
      const clients = getStore({ name: 'clients', consistency: 'strong' });
      client = await clients.get(keySafe(ownerKey) + '/' + keySafe(clientId), { type: 'json' });
      if (client && Array.isArray(client.loans)) loan = client.loans.find((l) => l && l.id === loanId) || null;
    } catch (e) {
      console.warn('[borrower-upload-notify] loan read failed:', e && e.message);
    }
    // Fall back to the review's own snapshot rather than notifying nobody.
    const forTeam = loan || review.sourceLoanSnapshot || {};
    if (review && review.processorEmail && !forTeam.processorEmail) forTeam.processorEmail = review.processorEmail;

    const recipients = loanWatchers(forTeam, ownerKey, { exclude: uploaderEmail });
    if (!recipients.length) return { notified: 0, recipients: [] };

    const address = (loan && loan.address) || (review && review.address) || '';
    const who = String(uploaderName || '').trim()
      || ((client && ((client.firstName || '') + ' ' + (client.lastName || '')).trim()) || '')
      || String(uploaderEmail || '').split('@')[0]
      || 'The borrower';
    const notice = uploadNotice({ who, docLabel, address });
    const href = '/loan-details/' + encodeURIComponent(loanId) +
      (ownerKey ? '?owner=' + encodeURIComponent(ownerKey) : '') + '#documents';

    let notified = 0;
    await Promise.all(recipients.map(async (email) => {
      try {
        await pushUserNotification(email, {
          kind: 'borrower_upload',
          title: notice.title,
          text: notice.text,
          href,
          loanId, clientId, owner: normalizeEmail(ownerKey),
          address,
          borrower: who,
          docLabel: String(docLabel || ''),
        });
        notified++;
      } catch (e) {
        console.warn('[borrower-upload-notify] push failed for', email, e && e.message);
      }
    }));
    return { notified, recipients };
  } catch (e) {
    console.warn('[borrower-upload-notify] failed (non-fatal):', e && e.message);
    return { notified: 0, recipients: [] };
  }
}
