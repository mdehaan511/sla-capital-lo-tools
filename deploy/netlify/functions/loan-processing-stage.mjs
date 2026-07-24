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
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

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
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
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
  if (substatus !== undefined) {
    loan.processingSubstatus = substatus;
  } else if (String(loan.processingStage || '') !== priorStage) {
    // Deploy 236.379 — substatuses are per-column tags. Moving a card
    // to a NEW column without an explicit substatus clears the old
    // one; otherwise a leftover like "Inspection Scheduled" from the
    // Underwriting column renders as "Closed · Inspection Scheduled"
    // on Loan Details after the card lands in Closed. (Substatus-only
    // updates still pass substatus explicitly, so this never fires
    // for those.)
    loan.processingSubstatus = '';
  }
  loan.updatedAt = new Date().toISOString();

  // Deploy 236.378 — keep loan.status coherent with the stage. Moving
  // a card to the Processing Pipeline's Closed column previously set
  // ONLY processingStage='pp_closed'; loan.status stayed at its old
  // value, so the Kanban said Closed while Loan Details (which renders
  // loan.status) still said In Processing. Mike's bug report:
  // "I marked this loan as closed in the Processing Pipeline and it
  // did not move to CLOSED status."
  //
  //   → pp_closed: promote status to 'closed'. Runs even when the
  //     stage is unchanged (re-dropping a card into Closed becomes an
  //     idempotent repair for loans already in the incoherent state).
  //     No financials collected here — the Mark Closed flow on the
  //     Leads board (quotes-close) remains the money path; an admin
  //     can add final amount + commission via closed.html later.
  //   → leaving pp_closed: revert status to 'approved' ONLY when the
  //     loan has no finalLoanAmount (i.e. it was closed by a stage
  //     drag, not the money flow). A financially-closed loan keeps
  //     its status even if the card is dragged out — quotes-close is
  //     authoritative for those.
  const priorStatus = String(loan.status || '');
  let statusChanged = false;
  if (newStage === 'pp_closed' && priorStatus !== 'closed') {
    loan.status = 'closed';
    loan.closedAt = loan.closedAt || new Date().toISOString();
    loan.closedBy = loan.closedBy || (user.email || '');
    statusChanged = true;
  } else if (priorStage === 'pp_closed' && newStage !== 'pp_closed'
             && priorStatus === 'closed' && !loan.finalLoanAmount) {
    loan.status = 'approved';
    statusChanged = true;
  }
  if (statusChanged) {
    const _meta = (user && user.user_metadata) || {};
    appendNoteEntry(loan, {
      kind:        'status',
      text:        'Status ' + priorStatus + ' → ' + loan.status + ' (via Processing Pipeline stage move)',
      author:      _meta.full_name || _meta.fullName || user.email || '',
      authorEmail: user.email || '',
      meta: { from: priorStatus, to: loan.status, via: 'processing_stage' },
    });
  }

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

  // Deploy 236.116 (Phase C) — auto-create tasks from the per-
  // stage templates configured in settings.task_templates. Fires
  // only on stage transitions (not substatus-only changes) and
  // dedups via the _templatesAppliedFor marker so re-entering a
  // stage doesn't pile on duplicate tasks. Failure is non-fatal:
  // a missing settings store or bad template entry shouldn't
  // block the stage move.
  let autoTasks = [];
  if (stageChanged && newStage) {
    try {
      autoTasks = await _autoCreateStageTasks({
        loan, clientId: client.id, ownerKey, newStage,
        actorEmail: user.email || '',
        actorName:  (user && user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || user.email || '',
      });
    } catch (e) {
      console.warn('loan-processing-stage: auto-task creation failed (non-fatal):', e && e.message);
    }
  }

  client.loans[idx] = loan;
  client.updatedAt = new Date().toISOString();

  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  // Deploy 236.426 (D3): quote sweep retired — /api/quotes renders from
  // loans (D2), so store copies no longer need freshening.
  // (quotesUpdated hard-coded below; the pp_closed status promotion on
  // the LOAN above is untouched — that's the authoritative record.)

  // D3 (236.426): quote sweeps retired — display reads loans
  return json(200, { ok: true, loan, clientId: client.id, autoTasks, statusChanged, quotesUpdated: 0 });
}

// Auto-task creator. Reads settings.task_templates[stage] and
// creates one task per template entry on the loan. Mutates the loan
// in place to stamp _templatesAppliedFor[stage] = ISO timestamp so
// subsequent moves back into this stage skip re-creation. Returns
// the array of created task records.
async function _autoCreateStageTasks(args) {
  const { loan, clientId, ownerKey, newStage, actorEmail, actorName } = args;

  loan._templatesAppliedFor = loan._templatesAppliedFor || {};
  if (loan._templatesAppliedFor[newStage]) return []; // already applied once

  const settingsStore = getStore({ name: 'settings', consistency: 'strong' });
  let templates = null;
  try { templates = await settingsStore.get('task_templates', { type: 'json' }); }
  catch (_) { return []; }
  const stageTemplates = templates && Array.isArray(templates[newStage]) ? templates[newStage] : [];
  if (!stageTemplates.length) return [];

  const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
  const now = new Date();
  const nowIso = now.toISOString();
  const created = [];

  for (const tpl of stageTemplates) {
    if (!tpl || !tpl.title) continue;
    const days = Number.isFinite(parseInt(tpl.daysFromStage, 10)) ? parseInt(tpl.daysFromStage, 10) : 0;
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    const ymd = due.getFullYear() + '-' +
                String(due.getMonth() + 1).padStart(2, '0') + '-' +
                String(due.getDate()).padStart(2, '0');
    const task = {
      id:              't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      clientId, loanId: loan.id, ownerKey,
      title:           String(tpl.title).trim(),
      dueDate:         days > 0 || days < 0 ? ymd : '',
      assignedTo:      String(tpl.assignedTo || '').toLowerCase(),
      assignedToName:  String(tpl.assignedToName || '').trim(),
      description:     'Auto-created when loan entered ' + (STAGE_LABELS[newStage] || newStage) + ' stage.',
      completed:       false,
      completedAt:     '',
      completedBy:     '',
      completedByName: '',
      createdAt:       nowIso,
      createdBy:       'system@slacapital.com',
      createdByName:   'SLA Platform (auto-task)',
      updatedAt:       nowIso,
      updatedBy:       actorEmail || 'system@slacapital.com',
      autoFromStage:   newStage,
    };
    try {
      await tasksStore.setJSON(ownerKey + '/' + task.id.replace(/[^a-zA-Z0-9_-]/g, '_'), task);
      created.push(task);
    } catch (e) {
      console.warn('loan-processing-stage: failed to create auto-task:', e && e.message);
    }
  }

  loan._templatesAppliedFor[newStage] = nowIso;
  // Also log the auto-creation as a note entry so the audit trail
  // shows what happened automatically.
  if (created.length) {
    appendNoteEntry(loan, {
      kind:        'system',
      text:        'Auto-created ' + created.length + ' task' + (created.length === 1 ? '' : 's') +
                   ' from the ' + (STAGE_LABELS[newStage] || newStage) + ' template.',
      author:      'SLA Platform',
      authorEmail: 'system@slacapital.com',
      meta:        { stage: newStage, taskIds: created.map((t) => t.id) },
    });
  }
  return created;
}
