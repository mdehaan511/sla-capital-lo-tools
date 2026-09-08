/**
 * loan-extension-cancel.mjs — POST /api/loan-extension-cancel
 *
 * Deploy 236.903 (Mike) — withdraw an extension that is out for signature.
 *
 * "We sent an extension for signing but the borrower decided to pay off the
 * loan instead. We need a way to cancel the extension request email asking
 * them to sign."
 *
 * Three things have to happen, and the order matters:
 *   1. Kill the LINKS. Every outstanding signer token is removed from the
 *      signer index and cleared on the envelope, so the link in the email the
 *      borrower already has stops working immediately. This is the part that
 *      actually cancels the request — an email cannot be recalled.
 *   2. Void the envelope, so the eSign reminder cron stops chasing it and
 *      nobody can re-open it.
 *   3. Clear the servicing-row marker, so Closed Loans stops showing an
 *      extension in flight.
 *
 * Optionally tells the borrower it was withdrawn (`notify`, default true when
 * they had actually been invited) — someone who was asked to sign should hear
 * that they no longer need to, rather than finding a dead link.
 *
 * Body: { envelopeId, owner?, reason?, notify? }
 * Auth: processor tier — the same people who send extensions. (isAdmin alone
 * would have locked out the processors who do this work; see 236.880.)
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
    console.error('loan-extension-cancel error:', e);
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
  if (!body || !body.envelopeId) return json(400, { error: 'envelopeId required' });

  const selfEmail = normalizeEmail(user.email);
  const ownerKey = keySafe(normalizeEmail(body.owner || user.email));
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const envKey = ownerKey + '/' + body.envelopeId;

  const envelope = await envStore.get(envKey, { type: 'json' }).catch(() => null);
  if (!envelope) return json(404, { error: 'Envelope not found' });
  if (envelope.envelopeKind !== 'loan_extension') {
    return json(400, { error: 'That envelope is not a loan extension.' });
  }
  if (envelope.status === 'completed') {
    return json(400, { error: 'That extension is already fully executed — it cannot be cancelled.' });
  }
  if (envelope.status === 'voided') {
    return json(400, { error: 'That extension request was already cancelled.' });
  }

  const now = new Date().toISOString();
  const reason = String(body.reason || '').slice(0, 300);

  // ── 1. Kill every outstanding signing link ────────────────────────
  const idx = getStore({ name: 'envelope-signer-idx', consistency: 'strong' });
  const invited = [];
  envelope.signers = (envelope.signers || []).map((s) => {
    const alreadySigned = !!(s && s.audit && s.audit.signedAt);
    if (s && s.token) {
      try { idx.delete(s.token).catch(() => {}); } catch (_) {}
      if (!alreadySigned && s.invitedAt) invited.push(s);
    }
    return { ...s, token: null, tokenExpiresAt: null };
  });

  // ── 2. Void the envelope ──────────────────────────────────────────
  envelope.status = 'voided';
  envelope.statusUpdatedAt = now;
  envelope.cancelledBy = selfEmail;
  envelope.cancelledAt = now;
  envelope.history = envelope.history || [];
  envelope.history.push({
    ts: now, status: 'voided',
    note: 'Extension request cancelled by ' + selfEmail +
      (reason ? ' — ' + reason : '') + '. All signing links invalidated.',
  });
  await envStore.setJSON(envKey, envelope);

  // Stashed originals are no longer needed; the agreement was never executed.
  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  for (let i = 0; i < (envelope.docs || []).length; i++) {
    try { await pdfStore.delete(ownerKey + '/' + envelope.id + '/' + i); } catch (_) {}
  }

  // ── 3. Clear the servicing-row marker + leave a note ───────────────
  let markerCleared = false, markerError = '';
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const found = await locateLoan({
      ownerKey: envelope.ownerKey, clientId: envelope.clientId,
      loanId: envelope.loanId, clientsStore,
    });
    if (found) {
      const { client, loan } = found;
      // Only clear OUR marker — a newer extension owns the row otherwise.
      if (!loan.extensionEsign || loan.extensionEsign.envelopeId === envelope.id) {
        loan.extensionEsign = {
          envelopeId: envelope.id,
          status: 'cancelled',
          sentAt: (loan.extensionEsign && loan.extensionEsign.sentAt) || envelope.createdAt || '',
          newMaturityDate: (envelope.extensionTerms && envelope.extensionTerms.newMaturityDate) || '',
          cancelledAt: now,
          cancelledBy: selfEmail,
          updatedAt: now,
        };
      }
      appendNoteEntry(loan, {
        kind: 'status',
        text: 'Loan Extension Agreement request CANCELLED' + (reason ? ' — ' + reason : '') +
          '. The signing links have been invalidated' +
          (invited.length ? ' and ' + invited.map((s) => s.email).join(', ') + ' notified.' : '.'),
        author: (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || user.email || '',
        authorEmail: selfEmail,
        meta: { via: 'loan_extension_cancel', envelopeId: envelope.id },
      });
      loan.updatedAt = now;
      await writeClient(found.ownerKey, client, { clientsStore });
      markerCleared = true;
    }
  } catch (e) {
    console.error('loan-extension-cancel: loan write failed:', e && e.message);
    markerError = (e && e.message) || 'unknown';
  }

  // ── 4. Tell whoever was mid-signature ─────────────────────────────
  let notified = 0;
  const wantNotify = body.notify !== false;
  if (wantNotify && invited.length && process.env.RESEND_API_KEY) {
    for (const s of invited) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'SLA Capital <noreply@slacapital.com>',
            to: [s.email],
            subject: 'Withdrawn: Loan Extension Agreement — ' + (envelope.propertyAddress || 'your loan'),
            text: [
              'Hi ' + (s.firstName || '') + ',',
              '',
              'The Loan Extension Agreement we sent you for ' +
                (envelope.propertyAddress || 'your loan') + ' has been withdrawn, so there is nothing further for you to sign. ' +
                'The signing link in our earlier email no longer works.',
              '',
              reason ? ('Reason: ' + reason) : '',
              '',
              'If you have questions, just reply to this email.',
              '',
              'SLA Capital',
            ].filter(Boolean).join('\n'),
          }),
        });
        if (r.ok) notified++;
      } catch (e) {
        console.warn('loan-extension-cancel: notify failed for ' + s.email + ':', e && e.message);
      }
    }
  }

  return json(200, {
    ok: true,
    envelopeId: envelope.id,
    linksInvalidated: (envelope.signers || []).length,
    notified,
    pendingSigners: invited.map((s) => s.email),
    markerCleared,
    markerError: markerError || undefined,
  });
}
