/**
 * _shared/loan-application-unsigned.mjs -- the loan application as a PDF to be signed.
 *
 * Deploy 237.256 (Mike: "send the current Rate Sheet and Loan Application together in a
 * single email for e-signing"). Lifted from loan-application-pdf-unsigned.mjs (Deploy 231)
 * so the e-sign envelope can render the application server-side when the LO includes it in
 * a packet: no application bytes travel through the browser, no 6 MB gateway cap, and the
 * copy the borrower signs is what is on file at that moment.
 *
 *   renderUnsignedApplicationForLoan({ ownerKey, clientId, loanId, enteredBy })
 *     -> { ok: true, pdfBuffer, record, client, loan, parties }
 *     -> { ok: false, status, error }
 *
 *   applicationParties(record, client)
 *     -> [{ pos, firstName, lastName, email }]   pos 1 = borrower 1, then every co-guarantor
 *        the application names WITH an email (the ones the long-form flow would ask to sign)
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { loadRecord } from './borrower-info-keys.mjs';
import { renderSignedApplicationPDF } from './loan-application-pdf.mjs';

export function applicationParties(record, client) {
  const data = (record && record.data) || {};
  const gs = Array.isArray(data.guarantors) ? data.guarantors : [];
  const num = Math.max(1, Math.min(4, parseInt(String(data.numGuarantors || '1'), 10) || 1));
  const out = [];
  const g0 = gs[0] || {};
  out.push({
    pos: 1,
    firstName: String(g0.firstName || (client && client.firstName) || '').trim(),
    lastName:  String(g0.lastName  || (client && client.lastName)  || '').trim(),
    email:     String(g0.email || record.borrowerEmail || (client && client.email) || '').toLowerCase().trim(),
  });
  for (let pos = 2; pos <= num; pos++) {
    const g = gs[pos - 1];
    if (!g || !String(g.email || '').trim()) continue;
    out.push({
      pos,
      firstName: String(g.firstName || '').trim(),
      lastName:  String(g.lastName  || '').trim(),
      email:     String(g.email || '').toLowerCase().trim(),
    });
  }
  return out;
}

export async function renderUnsignedApplicationForLoan({ ownerKey, clientId, loanId, enteredBy, clientsStore, biStore }) {
  if (!ownerKey || !clientId || !loanId) return { ok: false, status: 400, error: 'clientId and loanId required' };
  const cStore = clientsStore || getStore({ name: 'clients', consistency: 'strong' });
  let client = null;
  try { client = await cStore.get(`${ownerKey}/${keySafe(clientId)}`, { type: 'json' }); } catch (_) {}
  if (!client) return { ok: false, status: 404, error: 'Client not found' };
  const bStore = biStore || getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(bStore, ownerKey, clientId, loanId, client);
  if (!record) return { ok: false, status: 404, error: 'No long-form application data on file for this loan' };
  if (!record.data || Object.keys(record.data).length === 0) {
    return { ok: false, status: 409, error: 'The application on file has no data to sign yet.' };
  }
  if (record.signedAt || record.b1SignedAt) {
    return { ok: false, status: 409, error: 'This application has already been signed.' };
  }
  const parties = applicationParties(record, client);
  const signers = parties.map((p) => ({
    role: 'borrower' + p.pos,
    name: (p.firstName + ' ' + p.lastName).trim(),
    email: p.email,
    audit: null,
    signedAuths: [],
  }));
  const loan = Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
  let pdfBuffer;
  try {
    pdfBuffer = await renderSignedApplicationPDF({
      record, client, loan, signers,
      status: 'unsigned', unsigned: true,
      enteredBy: enteredBy || { name: '', email: '', at: new Date().toISOString() },
    });
  } catch (e) {
    return { ok: false, status: 500, error: 'Failed to render the application PDF: ' + ((e && e.message) || 'unknown') };
  }
  return { ok: true, pdfBuffer, record, client, loan, parties };
}
