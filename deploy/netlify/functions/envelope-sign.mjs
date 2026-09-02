/**
 * envelope-sign.mjs — POST /api/envelope-sign
 *
 * Public endpoint (token-based). Records a signer\u2019s e-signature event.
 * If THIS signer was the last one needing to sign, the envelope is
 * marked complete: each original PDF is stamped with an appended
 * Signatures page and the final PDFs are emailed to every signer (and
 * the LO is notified). Otherwise the envelope stays in
 * `partially_signed` state and the remaining signers continue to have
 * working links.
 *
 * Body: {
 *   t: TOKEN,
 *   signerName,
 *   consentAccepted: true,
 *   consentVersion,
 *   geolocation?,
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody, keySafe } from './_shared/auth.mjs';
import {
  TERMSHEET_CONSENT_VERSION, sealSignature,
  getClientIp, getUserAgent, appendSignaturePageToPdf, hashPdf,
} from './_shared/native-esign.mjs';
import { lookupEnvelopeByToken } from './envelope-signer-info.mjs';
// Deploy 223 — reply_to = LO who owns the lead.
import { getOwnerReplyTo } from './_shared/email.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';
// Deploy 236.847 — loan_extension envelopes mirror their signing progress onto
// loan.extensionEsign (status chip on the closed-loans servicing rows).
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req) => {
  try { return await handle(req); }
  catch (e) {
    console.error('envelope-sign error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, null, { bucket: 'env-sign', max: 30, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const body = await readJsonBody(req);
  if (body === null)        return json(400, { error: 'Invalid JSON' });
  if (!body.t)              return json(400, { error: 'Missing token' });
  if (!body.signerName || !String(body.signerName).trim())
                            return json(400, { error: 'Signer name is required' });
  if (!body.consentAccepted) return json(400, { error: 'Consent must be accepted' });
  if (body.consentVersion !== TERMSHEET_CONSENT_VERSION) {
    return json(409, {
      error: 'Consent text has been updated. Please refresh and review the latest version.',
      currentVersion: TERMSHEET_CONSENT_VERSION,
    });
  }

  const found = await lookupEnvelopeByToken(body.t);
  if (!found) return json(404, { error: 'Signing link not found' });
  const { envelope, envelopeKey, signerIndex } = found;
  const signer = envelope.signers[signerIndex];

  if (signer.tokenExpiresAt && new Date(signer.tokenExpiresAt) < new Date()) {
    return json(410, { error: 'This signing link has expired. Ask your loan officer to send a new one.' });
  }
  if (signer.audit && signer.audit.signedAt) {
    return json(409, { error: 'You have already signed.' });
  }
  if (envelope.status === 'voided') {
    return json(410, { error: 'This envelope has been voided.' });
  }

  // Build the audit event for this signer
  const signedAt = new Date().toISOString();
  const docHashes = (envelope.docs || []).map((d) => d.pdfHash || '');
  const auditPre = {
    envelopeId: envelope.id,
    signerIndex,
    signerName: String(body.signerName).trim().slice(0, 200),
    signerEmail: signer.email,
    signedAt,
    consentVersion: TERMSHEET_CONSENT_VERSION,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req).slice(0, 500),
    geolocation: typeof body.geolocation === 'string' ? body.geolocation.slice(0, 200) : '',
    docHashes,
  };
  const seal = sealSignature(auditPre);
  if (!seal) {
    return json(500, { error: 'ESIGN_SEAL_SECRET is not configured on the server.' });
  }
  const audit = Object.assign({}, auditPre, { seal });

  // Update the signer block
  envelope.signers[signerIndex] = {
    ...signer,
    audit,
    signedAt,
    // Clear the token so it can\u2019t be replayed.
    token: null,
  };

  // Determine if anyone is still outstanding
  const stillPending = envelope.signers.some((s) => !s.audit || !s.audit.signedAt);
  envelope.status = stillPending ? 'partially_signed' : 'completed';
  envelope.statusUpdatedAt = signedAt;
  envelope.history.push({
    ts: signedAt,
    status: envelope.status,
    note: `${signer.firstName} ${signer.lastName} <${signer.email}> signed.`,
  });

  // Persist the updated envelope BEFORE doing the (potentially slow)
  // PDF stamping work. If stamping fails the envelope state is still
  // correct and we can re-trigger from a finalization endpoint later.
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  try { await envStore.setJSON(envelopeKey, envelope); }
  catch (e) {
    console.error('envelope-sign setJSON failed:', e);
    return json(500, { error: 'Failed to save signature' });
  }

  // Drop the spent token from the index (replay protection)
  try {
    const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
    await idx.delete(body.t);
  } catch (_) {}

  // If still waiting on other signers, we\u2019re done for this turn.
  if (stillPending) {
    // Deploy 236.843 \u2014 SEQUENTIAL envelopes (loan extensions): the next
    // unsigned signer is only invited NOW, after the current signer
    // completed. The lender reviews + signs the filled agreement before
    // the borrower ever receives a link. Best-effort: an email failure
    // leaves the envelope partially_signed with its history note, and the
    // per-signer "Resend signing link" path still works.
    if (envelope.sequential) {
      try {
        const nextIdx = envelope.signers.findIndex((s) => !s.audit || !s.audit.signedAt);
        const next = nextIdx >= 0 ? envelope.signers[nextIdx] : null;
        const apiKey = process.env.RESEND_API_KEY;
        if (next && next.token && apiKey) {
          const { sendInvitationEmail } = await import('./envelopes-send.mjs');
          const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
          const link = `${base}/term-sheet-sign.html?t=${encodeURIComponent(next.token)}`;
          const ok = await sendInvitationEmail({
            apiKey, signer: next, envelope: envelope, link,
            loName: envelope.requesterEmail || envelope.ownerEmail || 'SLA Capital',
            propertyAddress: envelope.propertyAddress || '',
            ownerKey: envelope.ownerKey,
          });
          envelope.signers[nextIdx].invitedAt = new Date().toISOString();
          envelope.history.push({
            ts: new Date().toISOString(), status: envelope.status,
            note: ok
              ? `Sequential: invited next signer ${next.email}.`
              : `Sequential: invitation email to ${next.email} FAILED \u2014 use Resend signing link.`,
          });
          try { await envStore.setJSON(envelopeKey, envelope); } catch (_) {}
        }
      } catch (e) {
        console.warn('envelope-sign: sequential next-signer invite failed (non-fatal):', e && e.message);
      }
    }
    // Deploy 236.847 — for loan extensions the only partial state is "lender
    // signed, borrower's turn" (lender always signs first). Feeds the chip.
    await syncExtensionMarker(envelope, 'lender_signed', null);
    return json(200, {
      ok: true, signedAt, status: 'partially_signed',
      remainingSigners: envelope.signers.filter((s) => !s.audit || !s.audit.signedAt).length,
    });
  }

  // ── ALL SIGNERS DONE \u2014 stamp PDFs + email everyone ────────────
  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  const finalStore = getStore({ name: 'envelope-final-pdfs', consistency: 'strong' });

  const stampedPdfs = [];
  let stampingError = null;
  for (let i = 0; i < (envelope.docs || []).length; i++) {
    try {
      const origB64 = await pdfStore.get(`${envelope.ownerKey}/${envelope.id}/${i}`);
      if (!origB64) {
        stampingError = `Doc ${i}: original PDF missing from envelope-pdfs`;
        break;
      }
      const stampedB64 = await appendSignaturePageToPdf({
        pdfBase64: origB64,
        envelope,
        doc: envelope.docs[i],
      });
      await finalStore.set(`${envelope.ownerKey}/${envelope.id}/${i}`, stampedB64);
      stampedPdfs.push({ idx: i, b64: stampedB64, name: envelope.docs[i].name });
    } catch (e) {
      console.error('stamp doc', i, 'failed:', e);
      stampingError = `Doc ${i}: ${(e && e.message) || 'unknown'}`;
      break;
    }
  }

  if (stampingError) {
    envelope.status = 'completed_stamping_failed';
    envelope.statusUpdatedAt = new Date().toISOString();
    envelope.sendError = stampingError;
    envelope.history.push({
      ts: envelope.statusUpdatedAt,
      status: envelope.status,
      note: 'All signers signed, but PDF stamping failed: ' + stampingError,
    });
    try { await envStore.setJSON(envelopeKey, envelope); } catch (_) {}
    // All signatures ARE in — the chip goes green even though stamping needs a re-run.
    await syncExtensionMarker(envelope, 'completed', _extensionDoneNote(envelope));
    return json(200, {
      ok: true, signedAt, status: 'completed_stamping_failed',
      error: stampingError,
    });
  }

  // Email each signer + the LO with the final stamped PDFs
  let emailedCount = 0;
  try {
    emailedCount = await sendFinalCopiesEmail({
      envelope, stampedPdfs,
    });
  } catch (e) {
    console.warn('final-copy email failed:', e && e.message);
  }

  // Mark fully done
  envelope.status = 'completed';
  envelope.statusUpdatedAt = new Date().toISOString();
  envelope.history.push({
    ts: envelope.statusUpdatedAt,
    status: 'completed',
    note: `All signers signed. Final stamped PDFs stored + emailed to ${emailedCount} recipient(s).`,
  });
  try { await envStore.setJSON(envelopeKey, envelope); } catch (_) {}

  // Clean up the original (unstamped) PDFs to free space \u2014 we have the
  // stamped versions in envelope-final-pdfs now.
  for (let i = 0; i < (envelope.docs || []).length; i++) {
    try { await pdfStore.delete(`${envelope.ownerKey}/${envelope.id}/${i}`); }
    catch (_) {}
  }

  // Deploy 236.847 — flip the servicing-row chip to executed + loan note.
  await syncExtensionMarker(envelope, 'completed', _extensionDoneNote(envelope));

  // Deploy 236.849 (Mike) — a fully signed RATE SHEET files itself into the
  // loan's Doc Review Term Sheet tray (stamped copy) and gets its AI review
  // queued. Before this, the review-create attach read the unsigned stash
  // that the cleanup below deletes, so signed sheets never mapped.
  await _attachSignedRateSheet(envelope, stampedPdfs);

  return json(200, {
    ok: true, signedAt, status: 'completed',
    emailedCount,
  });
}

// Best-effort: attach each completed rate-sheet doc to the review's term_sheet
// tray. Zero-throw — a failure here must not break the signing response.
async function _attachSignedRateSheet(envelope, stampedPdfs) {
  try {
    if (!envelope.clientId || !envelope.loanId) return;
    const hasRateSheet = (envelope.docs || []).some((d) => d && d.kind === 'rate_sheet');
    if (!hasRateSheet) return;
    const { attachPdfToReviewSlug, queueAiReviews } = await import('./_shared/loan-review-auto-attach.mjs');
    for (const sp of stampedPdfs || []) {
      const doc = (envelope.docs || [])[sp.idx];
      if (!doc || doc.kind !== 'rate_sheet') continue;
      const street = String(envelope.propertyAddress || '').split(',')[0].trim() || 'loan';
      const res = await attachPdfToReviewSlug({
        ownerKey: envelope.ownerKey,
        clientId: envelope.clientId,
        loanId: envelope.loanId,
        address: envelope.propertyAddress || '',
        slug: 'term_sheet',
        bytes: Buffer.from(sp.b64, 'base64'),
        filename: 'Signed Rate Sheet - ' + street + '.pdf',
        sourceNote: 'auto-attached on eSign completion (envelope ' + envelope.id + ')',
        actorEmail: 'auto:esign-complete',
      });
      if (res && res.attached && res.reviewId) {
        await queueAiReviews(res.reviewId, ['term_sheet']);
      }
    }
  } catch (e) {
    console.warn('envelope-sign: signed rate-sheet attach failed (non-fatal):', e && e.message);
  }
}

// ── Loan extension status mirror (Deploy 236.847) ──────────────────
// The closed-loans servicing rows show a chip driven by loan.extensionEsign.
// loan-extension-send stamps it 'sent'; this advances it as signatures land.
// The loan's maturityDate is deliberately NOT touched — it syncs from FCI;
// the completion note tells staff to expect the new date there.
function _extensionDoneNote(envelope) {
  const nm = (envelope.extensionTerms && envelope.extensionTerms.newMaturityDate) || '';
  return 'Loan Extension Agreement fully executed by all parties' +
    (nm ? ' — new maturity ' + nm + ' per the agreement' : '') +
    '. Maturity on this record is not auto-updated (it syncs from FCI).';
}
async function syncExtensionMarker(envelope, status, noteText) {
  if (envelope.envelopeKind !== 'loan_extension' || !envelope.clientId || !envelope.loanId) return;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const client = await clientsStore.get(`${envelope.ownerKey}/${envelope.clientId}`, { type: 'json' });
    const loan = client && (client.loans || []).find((l) => l.id === envelope.loanId);
    if (!loan) return;
    const cur = loan.extensionEsign;
    // A newer extension envelope owns the chip — don't let a stale one clobber it.
    if (cur && cur.envelopeId && cur.envelopeId !== envelope.id) return;
    loan.extensionEsign = {
      envelopeId: envelope.id,
      status,
      sentAt: (cur && cur.sentAt) || envelope.createdAt || '',
      newMaturityDate: (envelope.extensionTerms && envelope.extensionTerms.newMaturityDate) ||
        (cur && cur.newMaturityDate) || '',
      updatedAt: new Date().toISOString(),
    };
    if (noteText) {
      appendNoteEntry(loan, {
        kind: 'status', text: noteText,
        author: 'eSign', authorEmail: envelope.requesterEmail || '',
        meta: { via: 'envelope_sign', envelopeId: envelope.id },
      });
    }
    loan.updatedAt = new Date().toISOString();
    await writeClient(envelope.ownerKey, client, { clientsStore });
  } catch (e) {
    console.warn('envelope-sign: extension marker sync failed (non-fatal):', e && e.message);
  }
}

// ── Email helper ───────────────────────────────────────────────
async function sendFinalCopiesEmail({ envelope, stampedPdfs }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('sendFinalCopiesEmail: RESEND_API_KEY not set');
    return 0;
  }

  // Look up LO name + email
  const loEmail = envelope.requesterEmail;
  let loName = loEmail;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });
    const p = await profilesStore.get(keySafe(loEmail), { type: 'json' });
    if (p) {
      const n = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
      if (n) loName = n;
    }
  } catch (_) {}

  // Property address for the email body
  let propertyAddress = '';
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });
    const client = await clientsStore.get(`${envelope.ownerKey}/${envelope.clientId}`, { type: 'json' });
    const loan = client && (client.loans || []).find((l) => l.id === envelope.loanId);
    if (loan) propertyAddress = loan.propertyAddress || '';
  } catch (_) {}

  // Build attachments — one per stamped doc
  const attachments = stampedPdfs.map((sp) => ({
    filename: ((sp.name || 'Document') + '_Signed.pdf').replace(/[^a-zA-Z0-9._-]/g, '_'),
    content: sp.b64,
  }));

  // List of all recipients = every signer + the LO
  const recipients = [
    ...envelope.signers.map((s) => ({ email: s.email, name: `${s.firstName} ${s.lastName}` })),
    { email: loEmail, name: loName, isLO: true },
  ];
  // Deploy 236.848 (Mike) — every fully executed extension agreement goes to
  // the post-close mailbox, whoever sent it.
  if (envelope.envelopeKind === 'loan_extension' &&
      !recipients.some((r) => String(r.email || '').toLowerCase() === 'post-close@slacapital.com')) {
    recipients.push({ email: 'post-close@slacapital.com', name: 'SLA Post-Close', isLO: true });
  }

  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = 'Signed: ' + (envelope.docs || []).map((d) => d.name).join(', ');

  let sent = 0;
  for (const r of recipients) {
    const text = [
      `Hi ${r.name},`,
      '',
      r.isLO
        ? `All signers have completed the e-signature for envelope ${envelope.id}. Signed copies are attached.`
        : 'All signers have completed the e-signature on the document(s) below. Signed copies are attached for your records.',
      '',
      propertyAddress ? `Property: ${propertyAddress}` : '',
      `Documents: ${(envelope.docs || []).map((d) => d.name).join(', ')}`,
      '',
      'Sir Lends A Lot LLC dba SLA Capital',
    ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

    const html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
      '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
        '<div style="background:#261A36;padding:24px">' +
          '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital \u2014 Signed Copy</h1>' +
        '</div>' +
        '<div style="padding:24px;color:#1A1520">' +
          `<p style="font-size:14px;line-height:1.6">Hi ${escH(r.name)},</p>` +
          `<p style="font-size:14px;line-height:1.6">` +
          (r.isLO
            ? `All signers have completed the e-signature for envelope <code>${escH(envelope.id)}</code>. Signed copies are attached.`
            : 'All signers have completed the e-signature on the document(s) below. Signed copies are attached for your records.') +
          `</p>` +
          (propertyAddress ? `<p style="font-size:14px"><strong>Property:</strong> ${escH(propertyAddress)}</p>` : '') +
          `<p style="font-size:14px"><strong>Documents:</strong> ${escH((envelope.docs || []).map((d) => d.name).join(', '))}</p>` +
          `<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital.</p>` +
        '</div>' +
      '</div>' +
      '</body></html>';

    const replyTo = await getOwnerReplyTo(envelope.ownerKey);
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'SLA Capital <noreply@leads.slacapital.com>',
          to: [r.email],
          subject, text, html,
          attachments,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
      if (resp.ok) sent++;
      else console.warn('final-copy email failed for', r.email, resp.status);
    } catch (e) {
      console.warn('final-copy email threw for', r.email, e && e.message);
    }
  }
  return sent;
}
