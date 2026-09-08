/**
 * loan-extension-resync.mjs — POST /api/loan-extension-resync
 *
 * Deploy 236.904 (Mike) — put back the servicing-row markers that were never
 * written.
 *
 * The marker is what the Closed Loans chip renders, and it is also the only
 * way to REACH an extension from the UI (the chip opens the manage panel). Any
 * extension whose marker went missing is therefore invisible and uncancellable
 * — which is where 634 E Walnut Pl sat: sent for signature, borrower decided to
 * pay off instead, and no chip to cancel it from.
 *
 * Markers went missing for the reason fixed in 236.897: they were addressed by
 * (clientId, loanId), and a client merge between send and signing left the
 * envelope pointing at an id that no longer exists. This walks the extension
 * envelopes and re-derives each marker from the envelope's own state, finding
 * the loan by LOAN id.
 *
 * The envelope is the source of truth here, not the loan — its signer audit
 * says exactly how far the signing got.
 *
 * Body: { owner?, dryRun? }   owner defaults to every owner with envelopes.
 * Auth: ADMIN — it rewrites markers across other people's books.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-extension-resync error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

/** How far did this envelope actually get? Read it off the signers. */
function statusOf(envelope) {
  if (envelope.status === 'voided') return 'cancelled';
  const signers = envelope.signers || [];
  const signed = signers.filter((s) => s && s.audit && s.audit.signedAt);
  if (signed.length && signed.length === signers.length) return 'completed';
  if (signed.some((s) => s.role === 'lender')) return 'lender_signed';
  return 'sent';
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = !!body.dryRun;
  const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  const prefix = body.owner ? keySafe(normalizeEmail(body.owner)) + '/' : undefined;
  let keys = [];
  try {
    const listing = await envStore.list(prefix ? { prefix } : undefined);
    keys = (listing.blobs || []).map((b) => b.key);
  } catch (e) {
    return json(500, { error: 'Could not list envelopes: ' + (e && e.message) });
  }

  const results = [];
  let scanned = 0, repaired = 0, alreadyOk = 0, unresolved = 0;

  for (const key of keys) {
    let envelope;
    try { envelope = await envStore.get(key, { type: 'json' }); }
    catch (_) { continue; }
    if (!envelope || envelope.envelopeKind !== 'loan_extension' || !envelope.loanId) continue;
    scanned++;

    const want = statusOf(envelope);
    const found = await locateLoan({
      ownerKey: envelope.ownerKey, clientId: envelope.clientId,
      loanId: envelope.loanId, clientsStore,
    });
    if (!found) {
      unresolved++;
      results.push({ envelopeId: envelope.id, address: envelope.propertyAddress || '', outcome: 'loan not found' });
      continue;
    }

    const { client, loan } = found;
    const cur = loan.extensionEsign || null;
    // A NEWER envelope owns the row — never let an older one clobber it.
    if (cur && cur.envelopeId && cur.envelopeId !== envelope.id &&
        String(cur.sentAt || '') > String(envelope.createdAt || '')) {
      alreadyOk++;
      results.push({ envelopeId: envelope.id, address: envelope.propertyAddress || '', outcome: 'superseded by a newer extension' });
      continue;
    }
    if (cur && cur.envelopeId === envelope.id && cur.status === want) {
      alreadyOk++;
      continue;
    }

    const marker = {
      envelopeId: envelope.id,
      status: want,
      sentAt: (cur && cur.sentAt) || envelope.createdAt || '',
      newMaturityDate: (envelope.extensionTerms && envelope.extensionTerms.newMaturityDate) ||
        (cur && cur.newMaturityDate) || '',
      updatedAt: new Date().toISOString(),
    };
    if (want === 'cancelled') {
      marker.cancelledAt = envelope.cancelledAt || envelope.statusUpdatedAt || '';
      marker.cancelledBy = envelope.cancelledBy || '';
    }

    results.push({
      envelopeId: envelope.id,
      address: envelope.propertyAddress || '',
      loanId: envelope.loanId,
      movedClient: found.moved ? (envelope.clientId + ' → ' + found.clientId) : null,
      from: cur ? cur.status : '(none)',
      to: want,
      outcome: dryRun ? 'would repair' : 'repaired',
    });

    if (!dryRun) {
      loan.extensionEsign = marker;
      loan.updatedAt = new Date().toISOString();
      try {
        await writeClient(found.ownerKey, client, { clientsStore });
        repaired++;
      } catch (e) {
        results[results.length - 1].outcome = 'write failed: ' + ((e && e.message) || 'unknown');
      }
    } else {
      repaired++;
    }
  }

  return json(200, { ok: true, dryRun, scanned, repaired, alreadyOk, unresolved, results });
}
