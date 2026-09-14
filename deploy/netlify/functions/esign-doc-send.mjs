/**
 * esign-doc-send.mjs — POST /api/esign-doc-send
 *
 * Deploy 237.022 (Mike): sends a draft for signature, or re-sends one signer.
 *
 * Body: { id, owner?, skipEmail? }            → send. Mints a token for every
 *       signer whose turn it is (all of them when parallel; the first order
 *       group when sequential) and emails them unless skipEmail (link-only —
 *       the LO copies the sign URL from the response and sends it herself).
 * Body: { id, owner?, signerId, skipEmail? }  → resend: rotate that signer's
 *       token (+30 days), email again. Works on a SENT document only.
 *
 * Returns { ok, doc, emailResults:[{signerId, to, ok, error?}] }. The doc
 * carries a signUrl per live signer.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  readDoc, writeDoc, sanitizeDoc, pendingSigners, signerFields, mintToken, sendInviteEmail,
  pushHistory, baseUrl, signUrl,
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
    let ownerKey = keySafe(selfEmail);
    if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
      if (!staff(user)) return json(403, { error: 'Owner override requires admin' });
      ownerKey = keySafe(normalizeEmail(body.owner));
    }
    const doc = await readDoc(ownerKey, body.id);
    if (!doc) return json(404, { error: 'Document not found' });
    const base = baseUrl(req);
    const skipEmail = !!body.skipEmail;
    const emailResults = [];

    // ── Resend one signer ──
    if (body.signerId) {
      if (doc.status !== 'sent') return json(409, { error: 'Document is ' + doc.status + ' — nothing to resend' });
      const signer = (doc.signers || []).find((s) => s.id === body.signerId);
      if (!signer) return json(404, { error: 'Signer not found' });
      if (signer.signedAt) return json(409, { error: signer.name + ' has already signed' });
      if (!pendingSigners(doc).some((s) => s.id === signer.id)) return json(409, { error: 'It is not ' + signer.name + '\'s turn yet (signing order)' });
      await mintToken(doc, signer);
      signer.resendCount = (signer.resendCount || 0) + 1;
      if (!skipEmail) {
        try {
          await sendInviteEmail({ doc, signer, link: signUrl(base, signer.token), reminder: true });
          signer.invitedAt = new Date().toISOString();
          emailResults.push({ signerId: signer.id, to: signer.email, ok: true });
        } catch (e) {
          emailResults.push({ signerId: signer.id, to: signer.email, ok: false, error: e && e.message });
        }
      }
      pushHistory(doc, 'resent', 'Link ' + (skipEmail ? 'regenerated' : 're-sent') + ' for ' + (signer.name || signer.email), selfEmail);
      await writeDoc(doc);
      return json(200, { ok: true, doc: sanitizeDoc(doc, { includeSignUrls: true, base }), emailResults });
    }

    // ── Initial send ──
    if (doc.status !== 'draft') return json(409, { error: 'Document already ' + doc.status });
    if (!doc.pdf || !doc.pdf.pageCount) return json(400, { error: 'No PDF on this document' });
    const signers = doc.signers || [];
    if (!signers.length) return json(400, { error: 'Add at least one signer' });
    const problems = [];
    signers.forEach((s) => {
      if (!s.name) problems.push('Signer ' + s.id + ' needs a name');
      if (!s.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) problems.push((s.name || s.id) + ' needs a valid email');
      if (!signerFields(doc, s.id).length) problems.push((s.name || s.id) + ' has no fields to complete — place at least one');
    });
    (doc.fields || []).forEach((f) => {
      if (f.signerId === 'sender' && f.required && (f.value === undefined || f.value === '' || f.value === null || f.value === false)) {
        problems.push('Sender field "' + (f.label || f.type) + '" on page ' + f.page + ' is empty');
      }
    });
    if (problems.length) return json(400, { error: problems[0], problems });

    doc.status = 'sent';
    doc.sentAt = new Date().toISOString();
    pushHistory(doc, 'sent', 'Sent to ' + signers.length + ' signer' + (signers.length === 1 ? '' : 's') + (doc.sequential ? ' (in order)' : '') + (skipEmail ? ' — links only, no email' : ''), selfEmail);

    for (const signer of pendingSigners(doc)) {
      await mintToken(doc, signer);
      if (skipEmail) continue;
      try {
        await sendInviteEmail({ doc, signer, link: signUrl(base, signer.token) });
        signer.invitedAt = new Date().toISOString();
        emailResults.push({ signerId: signer.id, to: signer.email, ok: true });
      } catch (e) {
        console.warn('esign-doc-send: invite failed for', signer.email, e && e.message);
        emailResults.push({ signerId: signer.id, to: signer.email, ok: false, error: e && e.message });
      }
    }
    await writeDoc(doc);
    return json(200, { ok: true, doc: sanitizeDoc(doc, { includeSignUrls: true, base }), emailResults });
  } catch (e) {
    console.error('esign-doc-send error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
