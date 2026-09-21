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
import { handleOptions, json, readJsonBody, keySafe, requireAuth } from './_shared/auth.mjs';
import { resolvePortalForm } from './_shared/borrower-forms-portal.mjs';
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
import { primaryProcessor } from './_shared/team-roles.mjs'; // Deploy 237.216

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
  const store = getStore({ name: 'borrower_forms', consistency: 'strong' });
  let rec, form, portal = null;

  if (!token && body.loanId && body.form) {
    // Deploy 237.039 — PORTAL mode: the signed-in borrower (loan grant) submits
    // a self-serve form. A fresh request record is minted here (no token) so
    // the tray + the record read the same as a processor-sent one, and the
    // loan's LO gets the completion email. Re-submitting replaces the tray's
    // current copy (the prior one stays in the tray history).
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Please sign in to your portal to submit this form.' });
    const r = await resolvePortalForm({ req, user, loanId: body.loanId, formId: body.form, staffRef: { owner: body.owner || '', clientId: body.clientId || '' } });
    if (r.error) return r.error;
    if (r.viewingAs) return json(403, { error: 'View-as is read-only' });
    portal = r; form = r.form;
    if (r.seeded) {
      const reviewStore0 = getStore({ name: 'loan_reviews', consistency: 'strong' });
      await reviewStore0.setJSON(keySafe(r.review.id), r.review);
    }
    const now0 = new Date().toISOString();
    rec = {
      id: 'bf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), formId: form.id, slug: r.slug,
      ownerKey: r.ownerKey, clientId: r.clientId, loanId: r.loanId, address: r.address, reviewId: r.review.id,
      to: r.to, borrowerName: r.borrowerName, ctx: r.ctx, staffValues: {},
      source: 'portal', sentBy: r.ownerEmail || '', senderName: '', sentAt: now0, status: 'sent', token: '',
    };
  } else {
    if (!/^[a-f0-9]{48}$/.test(token)) return json(400, { error: 'Missing or invalid link' });
    const idxStore = getStore({ name: 'borrower-forms-token-idx', consistency: 'strong' });
    const idx = await idxStore.get(token, { type: 'json' }).catch(() => null);
    if (!idx || !idx.id) return json(404, { error: 'This link is no longer valid. Please ask your loan team for a new one.' });
    rec = await store.get(keySafe(idx.id), { type: 'json' }).catch(() => null);
    if (!rec) return json(404, { error: 'This link is no longer valid.' });
    if (rec.status === 'completed') return json(409, { error: 'This form was already submitted on ' + new Date(rec.completedAt).toLocaleDateString('en-US') + '.' });
    if (rec.status === 'voided' || rec.status === 'superseded') return json(410, { error: 'This form request was cancelled. Please ask your loan team for a new link.' });
    form = formById(rec.formId);
    if (!form) return json(500, { error: 'Unknown form' });
  }

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
    sourceNote: (portal ? 'borrower-portal-form:' : 'borrower-form:') + rec.id, actorEmail: 'borrower:' + (rec.to || ''), documentDate: now.slice(0, 10),
  });
  if (!attach || !attach.ok || !attach.attached) {
    console.error('borrower-form-submit: attach failed', attach);
    return json(500, { error: 'Your form was signed but could not be filed (' + ((attach && (attach.reason || attach.error)) || 'unknown') + '). Please contact your loan team.' });
  }

  // Stamp the tray completed (attach saved the review; re-read to layer the stamp).
  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let docId = '';
  let vomFollowUp = null;
  try {
    const review = await reviewStore.get(keySafe(rec.reviewId), { type: 'json' });
    const ds = review && review.docs && review.docs[rec.slug];
    if (ds) {
      docId = ds.currentDocId || '';
      ds.borrowerForm = Object.assign({}, ds.borrowerForm || {}, { id: rec.id, formId: form.id, status: 'completed', completedAt: now, docId, link: '', source: portal ? 'portal' : (ds.borrowerForm && ds.borrowerForm.source) || 'sent' });
      ds.uploadedByBorrower = true;
      // Deploy 237.042 (Mike) — a VOM back from the borrower is only Part I.
      // SLA still has to send it to the landlord / mortgage company for Part
      // II, so the tray carries an open follow-up until a processor marks it
      // sent (borrower-form-send { followUpDone }). A task is created below.
      if (form.id === 'vom') {
        vomFollowUp = {
          kind: 'vom_send', label: 'Send to the landlord / mortgage company for Part II',
          creditor: { name: v.clean.creditorName || '', address: v.clean.creditorAddress || '', phone: v.clean.creditorPhone || '', accountType: v.clean.accountType || '' },
          createdAt: now, done: false, doneAt: '', doneBy: '', taskId: '',
        };
        ds.followUp = vomFollowUp;
      }
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
  const followUpText = vomFollowUp
    ? ' STILL TO DO: send the VOM to ' + (vomFollowUp.creditor.name || 'the landlord / mortgage company') + ' for Part II — it must go lender-to-lender, not through the borrower.'
    : '';
  try {
    const found = await locateLoan({ ownerKey: rec.ownerKey, clientId: rec.clientId, loanId: rec.loanId });
    if (found && found.loan && found.client) {
      appendNoteEntry(found.loan, { kind: 'system', text: form.label + ' completed and signed by the borrower (' + signerName + ') — filed to Documents.' + followUpText, author: 'SLA Platform', authorEmail: 'system@slacapital.com' });
      found.loan.updatedAt = now;
      await writeClient(found.ownerKey || rec.ownerKey, found.client, {});
      // Deploy 237.042 — the VOM send-out lands on the processing queue: a
      // task for the loan's first assigned processor (else whoever sent the
      // form / the LO), due in two business-ish days.
      if (vomFollowUp) {
        try {
          const procs = Array.isArray(found.loan.assignedProcessors) ? found.loan.assignedProcessors : [];
          // Deploy 237.216 -- was "the first team member with an email", which is the
          // underwriter whenever she was added first. The VOM follow-up is processing work.
          const p0 = primaryProcessor(procs);
          const assignee = p0 ? { email: String(p0.email).toLowerCase(), name: p0.name || '' } : { email: String(rec.sentBy || '').toLowerCase(), name: rec.senderName || '' };
          const due = new Date(Date.now() + 2 * 86400000);
          const dueYmd = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
          const taskOwnerKey = found.ownerKey || rec.ownerKey;
          const task = {
            id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            clientId: found.clientId || rec.clientId, loanId: rec.loanId, ownerKey: taskOwnerKey,
            title: 'Send VOM to ' + (vomFollowUp.creditor.name || 'landlord / mortgage company') + ' (Part II)',
            dueDate: dueYmd, assignedTo: assignee.email, assignedToName: assignee.name,
            description: 'The borrower signed the Verification of Mortgage / Rent request. Send it to ' +
              [vomFollowUp.creditor.name, vomFollowUp.creditor.address, vomFollowUp.creditor.phone].filter(Boolean).join(', ') +
              ' for Part II — the form must go directly from SLA to them. Then mark it sent on the VOM tray in Documents.',
            completed: false, completedAt: '', completedBy: '', completedByName: '',
            createdAt: now, createdBy: 'system@slacapital.com', createdByName: 'SLA Platform', updatedAt: now, updatedBy: 'system@slacapital.com',
            source: 'vom_followup', reviewId: rec.reviewId, slug: rec.slug,
          };
          await getStore({ name: 'tasks', consistency: 'strong' }).setJSON(taskOwnerKey + '/' + keySafe(task.id), task);
          vomFollowUp.taskId = task.id;
          const rv = await reviewStore.get(keySafe(rec.reviewId), { type: 'json' });
          if (rv && rv.docs && rv.docs[rec.slug] && rv.docs[rec.slug].followUp) { rv.docs[rec.slug].followUp.taskId = task.id; await reviewStore.setJSON(keySafe(rv.id), rv); }
        } catch (e) { console.warn('borrower-form-submit: VOM task failed (non-fatal):', e && e.message); }
      }
    }
  } catch (e) { console.warn('borrower-form-submit: loan note failed:', e && e.message); }
  try {
    if (rec.sentBy && rec.sentBy.indexOf('@') > 0) {
      const link = PORTAL_ORIGIN + '/loan-details/' + encodeURIComponent(rec.loanId) + '?owner=' + encodeURIComponent(rec.ownerKey || '') + '#documents';
      const subject = 'Form completed: ' + form.label + (rec.address ? ' — ' + rec.address : '');
      const text = form.label + ' was completed and signed by ' + signerName + ' (' + (rec.to || '') + ') and filed to the Documents tab.' + followUpText + '\n\n' + link;
      const html = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1520"><strong>${escHtml(form.label)}</strong> was completed and signed by ${escHtml(signerName)} (${escHtml(rec.to || '')}) and filed to the Documents tab${rec.address ? ' for ' + escHtml(rec.address) : ''}.</p>` +
        (followUpText ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#7c1f1f;background:#fdf1ee;border:1px solid #f0c9c2;border-radius:8px;padding:10px 14px"><strong>Still to do:</strong> ${escHtml(followUpText.replace(/^ STILL TO DO: /, ''))}</p>` : '') +
        `<p><a href="${escHtml(link)}">Open the loan</a></p>`;
      await sendBorrowerEmail(rec.sentBy, subject, text, html, '', null);
    }
  } catch (e) { console.warn('borrower-form-submit: notify failed:', e && e.message); }

  return json(200, { ok: true, completedAt: now, mode: portal ? 'portal' : 'link' });
}
