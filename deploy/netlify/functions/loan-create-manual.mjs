/**
 * loan-create-manual.mjs — POST /api/loan-create-manual
 *
 * Deploy 236.638 — manual loan creation for the processor migration off Baseline.
 * Creates a loan (and its borrower client if new) and drops it straight onto the
 * Processing pipeline. Unlike loan-create-on-client (needs an existing client) or
 * the sizer/apply flows (quote/prospect-driven), this is a from-scratch entry
 * point: a processor rebuilds a loan they're bringing over, then fills in the rest
 * on Loan Details. Because nothing here touches Baseline, these loans are
 * SLA-authoritative by construction (marked `_manualEntry`; no `_baselineLoanId`,
 * so the Baseline mirror never matches them).
 *
 * Body: {
 *   owner?:  'lo@x.com',                 // the LO who owns this deal (default: creator)
 *   borrower: { firstName, lastName, email, phone },   // find-or-create by email
 *   loanData: { address, toolType, loanAmt, rate, points, purchasePrice, propValue, loanType },
 *   processingStage?: 'new_loan'|'processing'|'underwriting'|'pp_approved'|'pp_closed',
 *   assignedProcessor?: { email, name },
 * }
 * Response: { ok, clientId, loanId, owner, matchedExistingClient }
 *
 * Auth: staff (processor OR admin) — cross-owner by nature.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { findClientByEmail } from './_shared/client-lookup.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { linkOrCreateBroker } from './_shared/broker-link.mjs';

const VALID_STAGES = ['new_loan', 'processing', 'underwriting', 'pp_approved', 'pp_closed'];
const VALID_TOOLS  = ['dscr', 'rtl', 'guc'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-create-manual error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  // Manual loan creation / migration is a staff (processor or admin) action.
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const b = body.borrower || {};
  const firstName = String(b.firstName || '').trim().slice(0, 100);
  const lastName  = String(b.lastName  || '').trim().slice(0, 100);
  const email     = normalizeEmail(b.email || '');
  const phone     = String(b.phone || '').trim().slice(0, 40);
  if (!firstName && !lastName) return json(400, { error: 'Borrower name required' });
  if (!email || !email.includes('@')) return json(400, { error: 'Valid borrower email required' });

  const selfEmail  = normalizeEmail(user.email);
  const ownerEmail = body.owner ? normalizeEmail(body.owner) : selfEmail;
  const ownerKey   = keySafe(ownerEmail);

  const ld = body.loanData || {};
  const address = String(ld.address || '').trim();
  if (!address) return json(400, { error: 'Property address required' });
  const toolType = VALID_TOOLS.indexOf(String(ld.toolType || '').toLowerCase()) >= 0
    ? String(ld.toolType).toLowerCase() : 'dscr';
  const stage = VALID_STAGES.indexOf(String(body.processingStage || '').toLowerCase()) >= 0
    ? String(body.processingStage).toLowerCase() : 'new_loan';

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const now = new Date().toISOString();

  // ── Find-or-create the borrower client under this owner ──
  let client = null, matchedExisting = false;
  try {
    const hit = await findClientByEmail(ownerKey, email, clientsStore);
    if (hit && hit.client) { client = hit.client; matchedExisting = true; }
  } catch (_) {}
  if (!client) {
    client = {
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      firstName, lastName, email, phone,
      createdAt: now, updatedAt: now, createdBy: user.email || '',
      loans: [], _manualEntry: true,
    };
  } else {
    // Fill blanks only — never overwrite an existing client's data.
    if (!client.firstName && firstName) client.firstName = firstName;
    if (!client.lastName  && lastName)  client.lastName  = lastName;
    if (!client.phone     && phone)     client.phone     = phone;
  }
  if (!Array.isArray(client.loans)) client.loans = [];

  // ── Build the loan — status 'approved' + a processingStage puts it on the
  // Processing board (columnFor reads processingStage; 'approved' == In Processing). ──
  const loanId = 'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  const loan = {
    id: loanId, createdAt: now, updatedAt: now, savedAt: now,
    status: 'approved',
    processingStage: stage,
    processingStageAt: now,       // aging baseline for the manager dashboard
    toolType,
    address,
    loanAmt:       String(ld.loanAmt       || ''),
    rate:          String(ld.rate          || ''),
    points:        String(ld.points        || ''),
    purchasePrice: String(ld.purchasePrice || ''),
    propValue:     String(ld.propValue     || ''),
    loanType:      String(ld.loanType      || ''),
    guarantors: [],
    fromApplication: false,
    _manualEntry: true,           // manually-created / migrated — never Baseline-synced
  };
  if (body.assignedProcessor && body.assignedProcessor.email) {
    const _pe = {
      email: normalizeEmail(body.assignedProcessor.email),
      name:  String(body.assignedProcessor.name || '').trim(),
      at: now, by: user.email || '',
    };
    loan.assignedProcessor = _pe;
    // Deploy 236.662 — also seed the multi-member team array (role = processor).
    loan.assignedProcessors = [{ email: _pe.email, name: _pe.name, role: 'processor', at: now, by: user.email || '' }];
  }
  appendNoteEntry(loan, {
    kind: 'status',
    text: 'Loan created manually into Processing (Baseline migration)',
    author: authorName, authorEmail: user.email || '',
    meta: { via: 'loan_create_manual', stage },
  });

  client.loans.unshift(loan);
  client.updatedAt = now;

  // Broker link only if broker fields were supplied (rare here; supported).
  try { await linkOrCreateBroker(ownerKey, loan); } catch (_) {}

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save loan: ' + ((e && e.message) || 'unknown') }); }

  return json(200, {
    ok: true, clientId: client.id, loanId, owner: ownerEmail,
    matchedExistingClient: matchedExisting,
  });
}
