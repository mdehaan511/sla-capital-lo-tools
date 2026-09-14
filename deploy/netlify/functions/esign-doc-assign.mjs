/**
 * esign-doc-assign.mjs — POST /api/esign-doc-assign
 *
 * Deploy 237.028 (Mike): files a COMPLETED e-sign document onto a loan.
 *
 * Body: { id, owner?, loanId, clientId, loanOwner, slug, note? }
 *   - loanOwner is the LO email that owns the loan (from the picker)
 *   - slug is the Doc Review tray ("document type"); when the loan has a
 *     review with that tray the executed PDF lands there (same path the
 *     Mail Room uses: attachFileToReviewSlug). When the loan has no review
 *     yet, or no such tray, the PDF is stored in the loan's simple docs
 *     store (loan-docs) so nothing is lost, and the response says which.
 *   - A loan note is written either way so the Activity feed shows it.
 * Body: { id, owner?, unassign: true } → clears the assignment record only
 *   (the filed copy on the loan is left alone — deleting loan docs is a
 *   processor action on the loan itself).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { attachFileToReviewSlug } from './_shared/loan-review-auto-attach.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';
import { findCategory } from './_shared/loan-review-checklists.mjs';
import {
  readDoc, writeDoc, sanitizeDoc, docKey, docFinalStore, pushHistory, fullName, safeFilename, docTypeOptions,
} from './_shared/esign-docs.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const body = await readJsonBody(req);
    if (!body || !body.id) return json(400, { error: 'id required' });

    const selfEmail = normalizeEmail(user.email);
    const actorName = fullName(user) || selfEmail;
    let ownerKey = keySafe(selfEmail);
    if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
      if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
      ownerKey = keySafe(normalizeEmail(body.owner));
    }
    const doc = await readDoc(ownerKey, body.id);
    if (!doc) return json(404, { error: 'Document not found' });

    if (body.unassign) {
      doc.assignment = null;
      pushHistory(doc, 'unassigned', 'Loan assignment cleared', selfEmail);
      await writeDoc(doc);
      return json(200, { ok: true, doc: sanitizeDoc(doc) });
    }

    if (doc.status !== 'completed') return json(409, { error: 'Only a completed document can be filed to a loan' });
    const loanId = String(body.loanId || '');
    const clientId = String(body.clientId || '');
    const loanOwnerEmail = normalizeEmail(body.loanOwner || '');
    if (!loanId || !clientId || !loanOwnerEmail) return json(400, { error: 'loanId, clientId and loanOwner required' });
    // An LO may file onto her own loans; cross-LO filing is staff only.
    if (loanOwnerEmail !== selfEmail && !staff(user)) return json(403, { error: 'Filing onto another LO\'s loan requires admin or processor' });

    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const located = await locateLoan({ ownerKey: keySafe(loanOwnerEmail), clientId, loanId, clientsStore, allowScan: false });
    if (!located) return json(404, { error: 'Loan not found — search for it again and re-pick it' });
    const { client, loan } = located;
    const loanOwnerKey = located.ownerKey;
    const resolvedClientId = located.clientId;

    const slug = String(body.slug || '').slice(0, 80);
    const cat = findCategory(slug) || docTypeOptions().find((d) => d.slug === slug) || null;
    const slugLabel = String(body.slugLabel || (cat && cat.label) || slug || 'Signed document').slice(0, 120);
    // Deploy 237.035 (Mike) — slug 'other' = not a Doc Review tray. Skips the
    // tray attach and lands in the loan's documents under the typed description.
    const isOther = slug === 'other';

    const finalB64 = await docFinalStore().get(docKey(ownerKey, doc.id), { type: 'text' }).catch(() => null);
    if (!finalB64) return json(404, { error: 'Executed PDF not on file' });
    const bytes = Buffer.from(finalB64, 'base64');
    const filename = safeFilename(doc.title) + ' - signed ' + String(doc.completedAt || '').slice(0, 10) + '.pdf';

    // 1. Doc Review tray (the Documents tab) when it exists.
    let filed = { where: 'none' };
    if (slug && !isOther) {
      const r = await attachFileToReviewSlug({
        ownerKey: loanOwnerKey, clientId: resolvedClientId, loanId, address: loan.address || '',
        slug, bytes, filename, mimeType: 'application/pdf',
        sourceNote: 'esign', actorEmail: selfEmail,
        documentDate: String(doc.completedAt || '').slice(0, 10),
      });
      if (r && r.attached) filed = { where: 'review', reviewId: r.reviewId, slug, slugLabel };
      else filed = { where: 'none', reason: (r && (r.reason || r.error)) || 'unknown' };
    }
    // 2. Fallback: the loan's simple document store, so the executed copy is
    //    on the loan even before a processor starts its Doc Review.
    if (filed.where !== 'review') {
      const now = new Date().toISOString();
      const docId = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const rec = {
        id: docId, clientId: resolvedClientId, loanId, ownerKey: loanOwnerKey,
        category: isOther ? 'other' : 'closing', filename, mimeType: 'application/pdf', sizeBytes: bytes.length,
        notes: 'E-Sign: ' + slugLabel + (slug ? ' (' + slug + ')' : ''), uploadedAt: now, uploadedBy: selfEmail,
        uploadedByName: actorName, updatedAt: now, esignDocId: doc.id, esignSlug: slug,
      };
      const metaStore = getStore({ name: 'loan-docs', consistency: 'strong' });
      const bytesStore = getStore({ name: 'loan-docs-files', consistency: 'strong' });
      await bytesStore.set(loanOwnerKey + '/' + docId, bytes, { metadata: { filename, mimeType: 'application/pdf', loanId, clientId: resolvedClientId } });
      await metaStore.setJSON(loanOwnerKey + '/' + docId + '.json', rec);
      filed = Object.assign({ where: 'loan-docs', docId, slug, slugLabel }, filed.reason ? { reviewReason: filed.reason } : {});
    }

    // 3. Loan note so the Activity feed shows the filing.
    const sla = (loan.slaDisplayId && String(loan.slaDisplayId).trim()) || deriveBaselineLoanId(loan);
    appendNoteEntry(loan, {
      kind: 'status',
      text: 'E-Sign document filed: "' + doc.title + '" as ' + slugLabel + ' — signed by ' +
        (doc.signers || []).map((s) => s.name || s.email).join(', ') + ' — filed by ' + actorName +
        (filed.where === 'review' ? ' (Documents → ' + slugLabel + ')' : ' (loan documents)') +
        (body.note ? ' · ' + String(body.note).slice(0, 300) : ''),
      author: actorName, authorEmail: selfEmail,
      meta: { via: 'esign', esignDocId: doc.id, slug, filed: filed.where },
    });
    loan.updatedAt = new Date().toISOString();
    try { await writeClient(loanOwnerKey, client, { clientsStore }); }
    catch (e) { console.warn('esign-doc-assign: loan note write failed (non-fatal):', e && e.message); }

    const borrower = ((client.firstName || '') + ' ' + (client.lastName || '')).replace(/\s+/g, ' ').trim() || loan.entityName || client.entityName || '';
    const sug = doc.suggestion || {};
    doc.assignment = {
      loanId, clientId: resolvedClientId, ownerKey: loanOwnerEmail, address: loan.address || '', borrower, slaNumber: sla,
      slug, slugLabel, by: selfEmail, byName: actorName, at: new Date().toISOString(), filed,
      aiSuggestedLoanId: sug.loanId || '', aiAgreed: !!(sug.loanId && sug.loanId === loanId),
      aiSuggestedSlug: sug.slug || '', aiSlugAgreed: !!(sug.slug && sug.slug === slug),
    };
    pushHistory(doc, 'assigned', 'Filed to ' + sla + ' — ' + (loan.address || '') + ' as ' + slugLabel, selfEmail);
    await writeDoc(doc);
    return json(200, { ok: true, doc: sanitizeDoc(doc), filed });
  } catch (e) {
    console.error('esign-doc-assign error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
