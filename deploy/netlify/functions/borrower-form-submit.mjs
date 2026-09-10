/**
 * borrower-form-submit.mjs — POST /api/borrower-form-submit
 *
 * Deploy 236.945 — public, token-keyed. The borrower's answers + typed
 * signature come in; the filed PDF goes out — rendered here, attached to the
 * Doc Review tray the processor sent it from (attachPdfToReviewSlug, the same
 * path credit reports and rate sheets take), the tray + request stamped
 * completed, the processor emailed, a note on the loan.
 *
 * Body: { t, answers: {}, signerName, consentAccepted: true, consentVersion }
 * Returns: { ok, completedAt } | 400 { error, errors: {field: msg} } | 409 | 410
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody, keySafe } from './_shared/auth.mjs';
import { checkRateLimit } from './_shared/rate-limit.mjs';
import {
  formById, validateAnswers, scrubAnswers, renderFormPdf, filedName, ESIGN_CONSENT_VERSION,
} from './_shared/borrower-forms.mjs';
import { sealSignature, getClientIp, getUserAgent } from './_shared/native-esign.mjs';
import { attachPdfToReviewSlug } from './_shared/loan-review-auto-attach.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { sendBorrowerEmail, escHtml } from './_shared/borrower-invite-core.mjs';

const PORTAL_ORIGIN = 'https://portal.slacapital.ai';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-form-submit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const rl = await checkRateLimit(req, context, { bucket: 'bform-submit', max: 40, windowSec: 300 });
  if (!rl.allowed) return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: rl.retryAfterSec });

  const body = (await readJsonBody(req)) || {};
  const token = String(body.t || '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return json(400, { error: 'Missing or invalid link' });

  const idxStore = getStore({ name: 'borrower-forms-token-idx', consistency: 'strong' });
  const store = getStore({ name: 'borrower_forms', consistency: 'strong' });
  const idx = await idxStore.get(token, { type: 'json' }).catch(() => null);
  if (!idx || !idx.id) return json(404, { error: 'This link is no longer valid. Please ask your loan team for a new one.' });
  const rec = await store.get(keySafe(idx.id), { type: 'json' }).catch(() => null);
  if (!rec) return json(404, { error: 'This link is no longer valid.' });
  if (rec.status === 'completed') return json(409, { error: 'This form was already submitted on ' + new Date(rec.completedAt).toLocaleDateString('en-US') + '.' });
  if (rec.status === 'voided' || rec.status === 'superseded') return json(410, { error: 'This form request was cancelled. Please ask your loan team for a new link.' });
  const form = formById(rec.formId);
  if (!form) return json(500, { error: 'Unknown form' });

  // ── Answers + signature ─────────────────────────────────────────────────
  const v = validateAnswers(form.fields || [], body.answers || {});
  if (!v.ok) return json(400, { error: 'Please complete the highlighted fields.', errors: v.errors });
  const signerName = String(body.signerName || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (form.signature) {
    if (body.consentAccepted !== true) return json(400, { error: 'Please accept the electronic signature consent.' });
    if (Number(body.consentVersion) !== ESIGN_CONSENT_VERSION) return json(400, { error: 'This page is out of date — please refresh and try again.' });
    if (signerName.length < 3) return json(400, { error: 'Please type your full legal name to sign.' });
  }
  const now = new Date().toISOString();
  const audit = {
    envelopeId: rec.id, signerIndex: 0, signerName, signerEmail: rec.to || '', signedAt: now,
    consentVersion: String(ESIGN_CONSENT_VERSION), ipAddress: getClientIp(req), userAgent: getUserAgent(req), docHashes: [],
  };
  const seal = sealSignature(audit);
  if (form.signature && !seal) return json(500, { error: 'Electronic signing is not configured on the server (ESIGN_SEAL_SECRET). Please contact your loan team.' });
  const signature = { name: signerName, email: rec.to || '', signedAt: now, ip: audit.ipAddress, seal: seal || '', consentVersion: ESIGN_CONSENT_VERSION };

  // ── Render + file into the tray ─────────────────────────────────────────
  const pdf = await renderFormPdf(form, { answers: v.clean, staffValues: rec.staffValues || {}, ctx: rec.ctx || {}, signature });
  const filename = filedName(form, rec.ctx || {}, now);
  const attach = await attachPdfToReviewSlug({
    ownerKey: rec.ownerKey, clientId: rec.clientId, loanId: rec.loanId, address: rec.address,
    slug: rec.slug, bytes: Buffer.from(pdf), filename,
    sourceNote: 'borrower-form:' + rec.id, actorEmail: 'borrower:' + (rec.to || ''), documentDate: now.slice(0, 10),
  });
  if (!attach || !attach.ok || !attach.attached) {
    console.error('borrower-form-submit: attach failed', attach);
    return json(500, { error: 'Your form was signed but could not be filed (' + ((attach && (attach.reason || attach.error)) || 'unknown') + '). Please contact your loan team.' });
  }

  // Stamp the tray completed (attach saved the review; re-read to layer the stamp).
  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let docId = '';
  try {
    const review = await reviewStore.get(keySafe(rec.reviewId), { type: 'json' });
    const ds = review && review.docs && review.docs[rec.slug];
    if (ds) {
      docId = ds.currentDocId || '';
      ds.borrowerForm = Object.assign({}, ds.borrowerForm || {}, { id: rec.id, formId: form.id, status: 'completed', completedAt: now, docId, link: '' });
      ds.uploadedByBorrower = true;
      ds.history = Array.isArray(ds.history) ? ds.history.slice() : [];
      ds.history.push({ ts: now, action: 'borrower_form_completed', by: 'borrower:' + (rec.to || ''), note: form.label + ' completed and signed by ' + signerName + ' — filed for review.' });
      review.updatedAt = now; review.lastEditedBy = 'borrower:' + (rec.to || ''); review.lastEditedAt = now;
      await reviewStore.setJSON(keySafe(review.id), review);
    }
  } catch (e) { console.warn('borrower-form-submit: tray stamp failed:', e && e.message); }

  rec.status = 'completed'; rec.completedAt = now; rec.docId = docId;
  rec.answers = scrubAnswers(form, v.clean);
  rec.signer = Object.assign({}, audit, { seal: seal || '' });
  await store.setJSON(keySafe(rec.id), rec);

  // Best-effort: a note on the loan + an email to whoever sent it.
  try {
    const found = await locateLoan({ ownerKey: rec.ownerKey, clientId: rec.clientId, loanId: rec.loanId });
    if (found && found.loan && found.client) {
      appendNoteEntry(found.loan, { kind: 'system', text: form.label + ' completed and signed by the borrower (' + signerName + ') — filed to Documents.', author: 'SLA Platform', authorEmail: 'system@slacapital.com' });
      found.loan.updatedAt = now;
      await writeClient(found.ownerKey || rec.ownerKey, found.client, {});
    }
  } catch (e) { console.warn('borrower-form-submit: loan note failed:', e && e.message); }
  try {
    if (rec.sentBy && rec.sentBy.indexOf('@') > 0) {
      const link = PORTAL_ORIGIN + '/loan-details/' + encodeURIComponent(rec.loanId) + '?owner=' + encodeURIComponent(rec.ownerKey || '') + '#documents';
      const subject = 'Form completed: ' + form.label + (rec.address ? ' — ' + rec.address : '');
      const text = form.label + ' was completed and signed by ' + signerName + ' (' + (rec.to || '') + ') and filed to the Documents tab.\n\n' + link;
      const html = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1520"><strong>${escHtml(form.label)}</strong> was completed and signed by ${escHtml(signerName)} (${escHtml(rec.to || '')}) and filed to the Documents tab${rec.address ? ' for ' + escHtml(rec.address) : ''}.</p><p><a href="${escHtml(link)}">Open the loan</a></p>`;
      await sendBorrowerEmail(rec.sentBy, subject, text, html, '', null);
    }
  } catch (e) { console.warn('borrower-form-submit: notify failed:', e && e.message); }

  return json(200, { ok: true, completedAt: now });
}
