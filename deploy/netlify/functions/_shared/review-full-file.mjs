/**
 * _shared/review-full-file.mjs — Deploy 237.072 (Mike, UW simplification item 8)
 *
 * "The underwriter needs to know how close to a full file they are and to get
 * notified when a full file is completed."
 *
 *   fullFileStatus(review) — { required, have, missing[], complete } over the
 *     review's REQUIRED trays (docs[slug].required, stamped at review creation
 *     from the checklist: !optional && !investor). Hidden trays don't count;
 *     a tray counts as "in" when it holds a live document or is N/A.
 *     The Documents tab computes the same thing client-side for its tracker —
 *     keep the two in step.
 *   checkFullFile(reviewId) — re-reads the review; when it just became
 *     complete (and hasn't been announced) stamps fullFileNotifiedAt and
 *     notifies the review's processor + every admin (Mike's call): bell
 *     (user-notifications, kind 'full_file') + email. Once per review.
 *     Best-effort: never throws into the upload that called it.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { db } from './supabase-db.mjs';
import { pushUserNotification } from './user-notifications.mjs';
import { notifyFullFile } from './email.mjs';

export function fullFileStatus(review) {
  const docs = (review && review.docs) || {};
  let required = 0, have = 0;
  const missing = [];
  for (const slug of Object.keys(docs)) {
    const d = docs[slug] || {};
    if (d.required !== true || d.hidden) continue;
    required++;
    const hasDoc = !!(d.currentDocId || (Array.isArray(d.documents) && d.documents.some((x) => x && !x.hidden)));
    if (hasDoc || d.verdict === 'na') have++;
    else missing.push(slug);
  }
  return { required, have, missing, complete: required > 0 && have === required };
}

async function _adminEmails() {
  const out = [];
  try {
    const rows = await db.select('sla_user_roles', { select: 'email,roles' });
    for (const row of (rows || [])) {
      const roles = Array.isArray(row.roles) ? row.roles : String(row.roles || '').split(',');
      const r = roles.map((x) => String(x || '').trim().toLowerCase());
      if (row.email && (r.includes('admin') || r.includes('super_admin'))) out.push(normalizeEmail(row.email));
    }
  } catch (e) { console.warn('[review-full-file] roles read failed:', e && e.message); }
  return out;
}

export async function checkFullFile(reviewId) {
  try {
    if (!reviewId) return { ok: false };
    const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const review = await store.get(keySafe(reviewId), { type: 'json' });
    if (!review) return { ok: false };
    const st = fullFileStatus(review);
    if (!st.complete || review.fullFileNotifiedAt) return { ok: true, complete: st.complete, notified: false };

    const recipients = new Set();
    if (review.processorEmail) recipients.add(normalizeEmail(review.processorEmail));
    for (const a of await _adminEmails()) recipients.add(a);
    const src = review.source || {};
    const owner = String(src.ownerKey || review.loEmail || '');
    const loanUrl = src.loanId
      ? 'https://portal.slacapital.ai/loan-details/' + encodeURIComponent(src.loanId) + (owner ? '?owner=' + encodeURIComponent(owner) : '')
      : 'https://portal.slacapital.ai/processing-pipeline.html';
    const address = String(review.address || '').trim();
    const borrower = String(review.borrowerName || '').trim();
    const snippet = 'All ' + st.required + ' required documents are in — ready for underwriting.';

    // Stamp first (fresh read) so a concurrent upload can't announce it twice.
    const fresh = await store.get(keySafe(reviewId), { type: 'json' });
    if (!fresh || fresh.fullFileNotifiedAt) return { ok: true, complete: true, notified: false };
    fresh.fullFileNotifiedAt = new Date().toISOString();
    fresh.fullFileNotifiedTo = Array.from(recipients);
    fresh.updatedAt = fresh.fullFileNotifiedAt;
    await store.setJSON(keySafe(reviewId), fresh);

    let notified = 0;
    await Promise.all(Array.from(recipients).map(async (email) => {
      try {
        await pushUserNotification(email, {
          kind: 'full_file', loanId: src.loanId || '', clientId: src.clientId || '', owner,
          address, borrower, reviewId, snippet,
        });
        notified++;
      } catch (e) { console.warn('[review-full-file] bell push failed for', email, e && e.message); }
      try { await notifyFullFile({ toEmail: email, address, borrower, loanUrl, required: st.required }); }
      catch (e) { console.warn('[review-full-file] email failed for', email, e && e.message); }
    }));
    console.log('[review-full-file] full file announced', reviewId, 'to', notified, 'user(s)');
    return { ok: true, complete: true, notified: notified > 0 };
  } catch (e) {
    console.warn('[review-full-file] check failed (non-fatal):', e && e.message);
    return { ok: false };
  }
}
