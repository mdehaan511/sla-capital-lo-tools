/**
 * xactus-flood-order.mjs — POST /api/xactus-flood-order
 *
 * Deploy 236.779 — order a flood zone determination (SFHDF cert) from
 * Xactus through the MISMO 2.4 flood API. Loan-specific: the property
 * address comes off the LOAN; borrower name from the client.
 *
 * Products (verified against the test env): 'Basic' = guaranteed
 * determination + SFHDF cert (usually instant, PDF embedded); 'life' =
 * Life-of-Loan monitoring. A manual-research order returns an ack with
 * a request id — stored as status 'pending' (the LO re-orders/status-
 * checks later; certs have no expiry so no cron pressure).
 *
 * On success: verification record + PDF into verification-docs + PDF
 * auto-attached to the loan review's flood_certificate tray + the
 * loan's floodZone / floodCertDate / floodCertId stamped.
 *
 * Body: { clientId, loanId, owner?, product?: 'Basic'|'life' }
 * Auth: processor/admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { attachPdfToReviewSlug } from './_shared/loan-review-auto-attach.mjs';
import {
  xactusConfigured, xactusMissingVars, buildFloodRequestXml, postXactus, parseFloodResponse,
} from './_shared/xactus.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('xactus-flood-order error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _parseAddress(full) {
  // "123 Main St, Spokane, WA 99208" → parts. Best-effort; callers
  // validate the pieces before ordering.
  const s = String(full || '').replace(/,?\s*(USA|United States)\s*$/i, '').trim();
  const m = s.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})[,\s]+(\d{5})(?:-\d{4})?$/i);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
  return null;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });
  if (!xactusConfigured()) return json(503, { error: 'Xactus credentials not configured — missing env var(s): ' + xactusMissingVars().join(', ') + '. Check names + that the "Functions" scope is enabled on each in Netlify.' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanId) return json(400, { error: 'loanId required (flood certs are loan-specific)' });
  const product = body.product === 'life' ? 'life' : 'Basic';

  const selfEmail = normalizeEmail(user.email);
  const ownerKey = body.owner ? keySafe(normalizeEmail(body.owner)) : keySafe(selfEmail);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(body.clientId), { type: 'json' });
  if (!client) return json(404, { error: 'Client not found' });
  const loan = Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === body.loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found on client' });

  const addr = _parseAddress(loan.address);
  if (!addr) return json(400, { error: 'Loan address could not be parsed into street/city/state/zip: "' + (loan.address || '') + '". Fix the address on the loan first.' });

  const lenderCaseId = loan.slaDisplayId || loan.id;
  const xml = buildFloodRequestXml({
    firstName: client.firstName || 'Borrower', lastName: client.lastName || (client.entityName || 'Entity'),
    street: addr.street, city: addr.city, state: addr.state, zip: addr.zip,
    lenderCaseId, product,
  });
  let resp;
  try { resp = await postXactus(xml); }
  catch (e) { return json(502, { error: 'Xactus request failed: ' + ((e && e.message) || 'network') }); }
  const parsed = parseFloodResponse(resp.text || '');
  if (parsed.errors.length) {
    return json(422, { error: 'Flood order failed: ' + parsed.errors.join(' · ') });
  }
  if (!parsed.accepted) {
    return json(422, { error: 'Flood order was not accepted (HTTP ' + resp.httpStatus + ')' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const vId = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const isPending = !parsed.zone && !parsed.pdfBase64; // manual-research ack
  const verification = {
    id: vId, kind: 'flood', status: isPending ? 'pending' : 'complete',
    orderedAt: nowIso, orderedBy: selfEmail,
    subject: { clientId: body.clientId, name: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() },
    loanId: body.loanId, address: loan.address || '',
    product,
    xactusRequestId: parsed.requestId, certId: parsed.certId,
    zone: parsed.zone, mapNumber: parsed.mapNumber, certDate: parsed.certDate, inSfha: parsed.inSfha,
    hasPdf: !!parsed.pdfBase64,
  };
  const vStore = getStore({ name: 'verifications', consistency: 'strong' });
  await vStore.setJSON(ownerKey + '/' + vId, verification);

  let attachedToReview = false;
  if (parsed.pdfBase64) {
    try {
      const dStore = getStore({ name: 'verification-docs', consistency: 'strong' });
      await dStore.set(ownerKey + '/' + vId, Buffer.from(parsed.pdfBase64, 'base64'), {
        metadata: { kind: 'flood', filename: addr.street + ' - Flood Cert - ' + nowIso.slice(0, 10) + '.pdf', mimeType: 'application/pdf' },
      });
    } catch (e) { console.warn('xactus-flood-order: pdf store failed:', e && e.message); }
    const r = await attachPdfToReviewSlug({
      ownerKey, clientId: body.clientId, loanId: body.loanId, address: loan.address,
      slug: 'flood_certificate', bytes: Buffer.from(parsed.pdfBase64, 'base64'),
      // Deploy 236.862 (Mike) — matches the credit-report naming convention.
      filename: addr.street + ' - Flood Cert - ' + nowIso.slice(0, 10) + '.pdf',
      sourceNote: 'xactus:flood:' + (parsed.certId || parsed.requestId), actorEmail: selfEmail,
      documentDate: parsed.certDate || nowIso.slice(0, 10),
    });
    attachedToReview = !!(r && r.attached);
  }

  // Stamp the loan (floodZone is an existing loan field the Property tab edits).
  if (parsed.zone) loan.floodZone = parsed.zone;
  loan.floodCertDate = parsed.certDate || nowIso.slice(0, 10);
  if (parsed.certId) loan.floodCertId = parsed.certId;
  appendNoteEntry(loan, {
    kind: 'system',
    text: isPending
      ? 'Flood determination ordered (' + (product === 'life' ? 'Life of Loan' : 'Basic') + ') — manual research required; Xactus request id ' + (parsed.requestId || '?') + '.'
      : 'Flood determination completed (' + (product === 'life' ? 'Life of Loan' : 'Basic') + ') — zone ' + (parsed.zone || '?') +
        (parsed.mapNumber ? ', map ' + parsed.mapNumber : '') + '. Cert attached to Loan Documents.',
    author: selfEmail, authorEmail: selfEmail,
    meta: { verificationId: vId, requestId: parsed.requestId },
  });
  loan.updatedAt = nowIso;
  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { console.warn('xactus-flood-order: loan stamp save failed:', e && e.message); }

  return json(200, { ok: true, verification, attachedToReview, pending: isPending });
}
