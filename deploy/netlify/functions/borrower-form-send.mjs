/**
 * borrower-form-send.mjs — POST /api/borrower-form-send   (processor tier)
 *
 * Deploy 236.945 (Mike: "in the document tray for these items is a button for
 * the processor to send them to the borrower and once they are completed they
 * are automatically put into the tray to review.")
 *
 * Body:
 *   { reviewId, slug, prepare: true }
 *       → { ok, form, recipient, staffFields[] }   (what the send modal needs)
 *   { reviewId, slug, email?, note?, staffValues? }
 *       → mints a token link, stamps the tray, emails the borrower
 *       → { ok, review, link, emailed }
 *   { reviewId, slug, preview: true, staffValues? }
 *       → { ok, pdfBase64, filename }   (Deploy 236.948 — the watermarked document
 *         exactly as the borrower will see it, prefill in, signature blank)
 *   { reviewId, slug, void: true }
 *       → voids the outstanding request → { ok, review }
 *
 * The request record lives in the `borrower_forms` store (id → record) with a
 * `borrower-forms-token-idx` (token → { id }) for the public page. The tray
 * carries `borrowerForm: { id, formId, status, sentAt, sentBy, to, link }`
 * so Doc Review can show "sent / awaiting borrower / completed".
 */
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { formForSlug, prefillFor, validateAnswers, renderFormPdf, filedName } from './_shared/borrower-forms.mjs';
import { profileName } from './_shared/task-enrich.mjs';
import { sendBorrowerEmail, escHtml } from './_shared/borrower-invite-core.mjs';
import { getOwnerReplyTo } from './_shared/email.mjs';

const PORTAL_ORIGIN = 'https://portal.slacapital.ai';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-form-send error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

// The slice of loan + client the public page and the renderer need — stored on
// the request at send time so the borrower's page never reads the client blob.
function _ctxSnapshot(loan, client) {
  const ha = (client && client.homeAddress && typeof client.homeAddress === 'object') ? client.homeAddress : {};
  return {
    loan: {
      id: loan.id, address: loan.address || '', entityName: loan.entityName || loan.vestingEntity || '',
      toolType: loan.toolType || '', loanType: loan.loanType || '',
      loanAmt: loan.loanAmt || '', finalLoanAmount: loan.finalLoanAmount || '',
      fundingDate: loan.fundingDate || loan.originationDate || loan.desiredCloseDate || '',
    },
    client: {
      id: client.id, firstName: client.firstName || '', lastName: client.lastName || '',
      entityName: client.entityName || client.companyName || '', email: client.email || '',
      homeAddress: { street: ha.street || '', city: ha.city || '', state: ha.state || '', zip: ha.zip || '' },
    },
  };
}

function _formEmail(name, address, formLabel, link, note, senderName) {
  const hi = name ? ('Hi ' + name + ',') : 'Hi there,';
  const forLoan = address ? (' for your loan at ' + address) : ' for your loan';
  const text = [
    hi, '',
    'Your SLA Capital loan team needs you to complete and sign the ' + formLabel + forLoan + '.', '',
    note ? ('Note from ' + (senderName || 'your loan team') + ': ' + note) : '', note ? '' : '',
    'Open the form here (it takes a few minutes; your typed name is your signature):', link, '',
    'Once you submit it, it goes straight to your loan file — nothing to print or scan.', '',
    '— SLA Capital',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">${escHtml(hi)}</p>
      <p style="font-size:15px;line-height:1.55">Your SLA Capital loan team needs you to complete and sign the <strong>${escHtml(formLabel)}</strong>${escHtml(forLoan)}.</p>
      ${note ? `<p style="font-size:14px;line-height:1.55;background:#fff;border:1px solid #e4dfd4;border-radius:8px;padding:10px 14px"><strong>Note from ${escHtml(senderName || 'your loan team')}:</strong> ${escHtml(note)}</p>` : ''}
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(link)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Complete the ${escHtml(formLabel)} &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">It takes a few minutes and your typed name is your signature. Once you submit it, it goes straight to your loan file — nothing to print or scan.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${escHtml(link)}</p>
    </div></body></html>`;
  return { subject: 'SLA Capital — please complete: ' + formLabel + (address ? ' (' + address + ')' : ''), text, html };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = (await readJsonBody(req)) || {};
  if (!body.reviewId || !body.slug) return json(400, { error: 'reviewId and slug required' });
  const slug = String(body.slug);
  const form = formForSlug(slug);
  if (!form) return json(400, { error: 'No borrower form is defined for this document category' });

  const self = normalizeEmail(user.email);
  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(String(body.reviewId)), { type: 'json' }).catch(() => null);
  if (!review) return json(404, { error: 'Review not found' });
  if (!review.docs || !review.docs[slug]) return json(404, { error: 'No such document category on this review' });
  const tray = review.docs[slug];
  const src = review.source || {};
  if (!src.loanId) return json(400, { error: 'This review is not attached to a loan' });

  const store = getStore({ name: 'borrower_forms', consistency: 'strong' });
  const idx = getStore({ name: 'borrower-forms-token-idx', consistency: 'strong' });
  const now = new Date().toISOString();

  // ── Void ────────────────────────────────────────────────────────────────
  if (body.void === true) {
    const cur = tray.borrowerForm;
    if (cur && cur.id) {
      const rec = await store.get(keySafe(cur.id), { type: 'json' }).catch(() => null);
      if (rec && rec.status !== 'completed') {
        rec.status = 'voided'; rec.voidedAt = now; rec.voidedBy = self;
        await store.setJSON(keySafe(cur.id), rec);
        if (rec.token) { try { await idx.delete(rec.token); } catch (_) {} }
      }
      if (cur.status !== 'completed') {
        tray.borrowerForm = Object.assign({}, cur, { status: 'voided', voidedAt: now, voidedBy: self, link: '' });
        tray.history = Array.isArray(tray.history) ? tray.history.slice() : [];
        tray.history.push({ ts: now, action: 'borrower_form_voided', by: self, note: form.label + ' request to the borrower was cancelled.' });
        review.updatedAt = now; review.lastEditedBy = self; review.lastEditedAt = now;
        await reviewStore.setJSON(keySafe(review.id), review);
      }
    }
    return json(200, { ok: true, review });
  }

  // ── Loan + client (the prefill source) ──────────────────────────────────
  const found = await locateLoan({ ownerKey: src.ownerKey ? keySafe(src.ownerKey) : '', clientId: src.clientId || '', loanId: src.loanId });
  if (!found || !found.loan || !found.client) return json(404, { error: 'Loan not found for this review' });
  const ownerKey = found.ownerKey || (src.ownerKey ? keySafe(src.ownerKey) : '');
  const loan = found.loan, client = found.client;

  let sender = { name: '', title: 'Loan Processor', phone: '', email: self };
  try {
    const p = await getStore({ name: 'profiles', consistency: 'eventual' }).get(keySafe(self), { type: 'json' });
    const meta = (p && p.user_metadata) || {};
    sender.name = profileName(p) || self.split('@')[0];
    sender.phone = String((p && (p.phone || p.phoneNumber)) || meta.phone || '').trim();
    sender.title = String((p && (p.title || p.jobTitle)) || meta.title || 'Loan Processor').trim();
  } catch (_) { sender.name = self.split('@')[0]; }

  const ctx = Object.assign(_ctxSnapshot(loan, client), { sender });
  const prefill = prefillFor(form, ctx);
  const borrowerName = [client.firstName, client.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');

  // ── Preview (Deploy 236.948) ──────────────────────────────────────────────────
  if (body.preview === true) {
    // Partial staff values are fine for a look: valid ones are normalised,
    // anything else renders as typed so the processor sees what they entered.
    const svRaw = Object.assign({}, prefill, body.staffValues || {});
    const sv = Object.assign({}, svRaw, validateAnswers(form.staffFields || [], svRaw).clean);
    const pdf = await renderFormPdf(form, { answers: prefill, staffValues: sv, ctx, signature: null, preview: true });
    return json(200, { ok: true, pdfBase64: Buffer.from(pdf).toString('base64'), filename: filedName(form, ctx, now) });
  }

  // ── Prepare (what the modal shows) ──────────────────────────────────────
  if (body.prepare === true) {
    return json(200, {
      ok: true,
      form: { id: form.id, label: form.label, title: form.title, acknowledge: !!form.acknowledge },
      recipient: { email: String(client.email || '').toLowerCase(), name: borrowerName },
      staffFields: (form.staffFields || []).map((f) => ({ key: f.key, label: f.label, type: f.type, required: !!f.required, value: prefill[f.key] != null ? prefill[f.key] : '' })),
      current: tray.borrowerForm || null,
    });
  }

  // ── Send ────────────────────────────────────────────────────────────────
  const to = String(body.email || client.email || '').trim().toLowerCase();
  if (!to || to.indexOf('@') < 1) return json(400, { error: 'A borrower email address is required' });
  const note = String(body.note || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  let staffValues = {};
  if ((form.staffFields || []).length) {
    const v = validateAnswers(form.staffFields, Object.assign({}, prefill, body.staffValues || {}));
    if (!v.ok) return json(400, { error: 'Please complete the letter details', errors: v.errors });
    staffValues = v.clean;
  }

  // An earlier outstanding request for this tray is superseded.
  const prev = tray.borrowerForm;
  if (prev && prev.id && prev.status === 'sent') {
    try {
      const old = await store.get(keySafe(prev.id), { type: 'json' });
      if (old && old.status === 'sent') { old.status = 'superseded'; old.supersededAt = now; await store.setJSON(keySafe(prev.id), old); if (old.token) await idx.delete(old.token).catch(() => {}); }
    } catch (_) {}
  }

  const id = 'bf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const token = crypto.randomBytes(24).toString('hex');
  const link = PORTAL_ORIGIN + '/borrower-form.html?t=' + token;
  const record = {
    id, token, formId: form.id, slug, reviewId: review.id,
    loanId: loan.id, clientId: client.id, ownerKey, address: loan.address || '',
    to, borrowerName, note, staffValues, prefill, ctx: _ctxSnapshot(loan, client),
    status: 'sent', sentAt: now, sentBy: self, senderName: sender.name,
    answers: null, completedAt: '', docId: '',
  };
  await store.setJSON(keySafe(id), record);
  await idx.setJSON(token, { id, createdAt: now });

  tray.borrowerForm = { id, formId: form.id, status: 'sent', sentAt: now, sentBy: self, to, link };
  tray.history = Array.isArray(tray.history) ? tray.history.slice() : [];
  tray.history.push({ ts: now, action: 'borrower_form_sent', by: self, note: form.label + ' sent to the borrower (' + to + ') to complete and sign.' });
  review.updatedAt = now; review.lastEditedBy = self; review.lastEditedAt = now;
  await reviewStore.setJSON(keySafe(review.id), review);

  let emailed = false;
  try {
    let replyTo = '';
    try { replyTo = await getOwnerReplyTo(ownerKey); } catch (_) {}
    const mail = _formEmail(borrowerName, loan.address || '', form.label, link, note, sender.name);
    emailed = await sendBorrowerEmail(to, mail.subject, mail.text, mail.html, replyTo, { kind: 'borrower_form', ownerKey, loanId: loan.id, formId: form.id });
  } catch (e) { console.warn('borrower-form-send: email failed:', e && e.message); }

  return json(200, { ok: true, review, link, emailed });
}
