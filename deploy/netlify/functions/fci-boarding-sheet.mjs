/**
 * fci-boarding-sheet.mjs — POST /api/fci-boarding-sheet
 *
 * Deploy 236.890 (Mike) — generate the filled FCI Loan Boarding package
 * (Loan Servicing Compliance Form + Foreclosure Prevention Alternatives)
 * for one closed loan. FCI has no boarding API, so this reproduces the
 * sheet the team filled by hand in PandaDoc — see _shared/fci-boarding.mjs.
 *
 * Body: { owner, clientId, loanId }
 * Response: the PDF binary; X-Boarding-Missing lists anything the platform
 * could not fill (hand-write those before sending to FCI).
 *
 * Auth: processor/admin (the sheet carries TINs, DOBs, bank accounts).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { buildFciBoardingPdf } from './_shared/fci-boarding.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';
// Deploy 236.982 — generating the sheet stamps boardingStatus 'sent'.
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('fci-boarding-sheet error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId || !body.loanId) return json(400, { error: 'clientId + loanId required' });
  const ownerKey = keySafe(normalizeEmail(String(body.owner || user.email || '')));

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(String(body.clientId)), { type: 'json' });
  const loan = client && Array.isArray(client.loans)
    ? client.loans.find((l) => l && l.id === body.loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found' });

  const guarantors = [];
  for (const gid of (loan.guarantorClientIds || []).slice(0, 2)) {
    const gc = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' }).catch(() => null);
    if (gc) guarantors.push(gc);
  }

  const sla = deriveBaselineLoanId(loan);
  const { bytes, missing } = await buildFciBoardingPdf({ loan, client, guarantors, sla });

  // Deploy 236.982 (Mike) — producing the boarding package IS the "sent to
  // servicer" moment (or close enough that the Pending Boarding list should
  // reflect it). Stamp 'sent' unless the loan is already boarded; the
  // nightly FCI sync flips it to 'boarded' when FCI's book picks it up.
  // Best-effort — a stamp failure never blocks the PDF download.
  try {
    if (String(loan.boardingStatus || '') !== 'boarded') {
      loan.boardingStatus = 'sent';
      if (!loan.boardingSentAt) loan.boardingSentAt = new Date().toISOString().slice(0, 10);
      loan.updatedAt = new Date().toISOString();
      await writeClient(ownerKey, client, { clientsStore });
    }
  } catch (e) { console.warn('fci-boarding-sheet: boarding stamp failed (non-fatal):', e && e.message); }

  const dutch = String(loan.dutchInterest || '').toLowerCase() === 'dutch';
  const street = String(loan.address || '').split(',')[0].trim() || 'loan';
  const filename = ('New FCI Loan Boarding (' + (dutch ? 'Dutch' : 'Non Dutch') + ') - ' + street + '.pdf')
    .replace(/[^\w .()'-]/g, '_');

  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'X-Boarding-Missing': encodeURIComponent(missing.join(' | ')).slice(0, 3000),
    },
  });
}
