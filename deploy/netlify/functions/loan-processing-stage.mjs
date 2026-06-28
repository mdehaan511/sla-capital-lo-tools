/**
 * loan-processing-stage.mjs — POST /api/loan-processing-stage
 *
 * Deploy 236.95 (Phase A.2) — set or clear a loan's processingStage
 * field. Drives column placement in processing-pipeline.html. Each
 * stage change is appended to the loan's notesLog as an audit entry
 * (kind: 'stage_change') so reviewers can see when a loan moved and
 * who moved it.
 *
 * Body:
 *   {
 *     clientId: 'c_...',
 *     loanId:   'l_...',
 *     newStage: '' | 'new_loan' | 'processing' | 'underwriting' |
 *               'pp_approved' | 'pp_closed',
 *     substatus?: string,    // optional, free-form, sub-column tag
 *                            // (Phase F admin editor governs the set)
 *     owner?: 'other@lo.com' // admin cross-LO override
 *   }
 *
 * Response: { ok: true, loan: <updated loan record> }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

const VALID_STAGES = ['', 'new_loan', 'processing', 'underwriting', 'pp_approved', 'pp_closed'];

const STAGE_LABELS = {
  '':              '(none)',
  'new_loan':      'New Loan',
  'processing':    'Processing',
  'underwriting':  'Underwriting',
  'pp_approved':   'Approved (Processing)',
  'pp_closed':     'Closed',
};

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-processing-stage top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const clientId  = body.clientId;
  const loanId    = body.loanId;
  const newStage  = String(body.newStage == null ? '' : body.newStage).toLowerCase().trim();
  const substatus = body.substatus != null ? String(body.substatus).trim() : undefined;

  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (VALID_STAGES.indexOf(newStage) < 0) {
    return json(400, { error: 'Invalid stage: ' + newStage + ' — must be one of ' + VALID_STAGES.join(',') });
  }

  // Resolve owner. Admin cross-LO override allowed; everyone else
  // can only touch loans under their own owner key.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client. clientId=' + clientId + ' loanId=' + loanId });

  const loan = client.loans[idx];
  const priorStage     = String(loan.processingStage || '').toLowerCase();
  const priorSubstatus = String(loan.processingSubstatus || '');

  loan.processingStage = newStage;
  if (substatus !== undefined) loan.processingSubstatus = substatus;
  loan.updatedAt = new Date().toISOString();

  // Audit log — only when something meaningful changed.
  const stageChanged = priorStage !== newStage;
  const subChanged   = substatus !== undefined && priorSubstatus !== substatus;

  if (stageChanged || subChanged) {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    const parts = [];
    if (stageChanged) {
      parts.push('stage: ' + (STAGE_LABELS[priorStage] || priorStage || '(none)') +
                 ' → ' + (STAGE_LABELS[newStage] || newStage));
    }
    if (subChanged) {
      parts.push('substatus: ' + (priorSubstatus || '(none)') + ' → ' + (substatus || '(none)'));
    }
    appendNoteEntry(loan, {
      kind:        'stage_change',
      text:        'Processing ' + parts.join(', '),
      author,
      authorEmail: user.email || '',
      meta: {
        fromStage: priorStage,
        toStage:   newStage,
        fromSubstatus: priorSubstatus,
        toSubstatus:   substatus,
      },
    });
  }

  client.loans[idx] = loan;
  client.updatedAt = new Date().toISOString();

  try { await clientsStore.setJSON(clientKey, client); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan, clientId: client.id });
}
