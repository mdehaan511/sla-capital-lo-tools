/**
 * tasks-auto-sweep.mjs — POST /api/tasks-auto-sweep   (admin only)
 *
 * Deploy 236.930 — one pass over every open auto-task in the company: close
 * the ones whose loan already shows the work done (the rule lives in
 * _shared/auto-task-complete.mjs). Clears the backlog the live hooks
 * couldn't have caught; safe to re-run.
 *
 * Body: { dryRun?: true }   (report only, write nothing)
 * Returns { ok, dryRun, open, closed: [{ id, who, title, address, reason }],
 *           left: [{ id, who, title, address, dueDate, why }] }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe } from './_shared/auth.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';
import { AUTO_KINDS, autoCompleteReason, markCompleted } from './_shared/auto-task-complete.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('tasks-auto-sweep error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });
  const body = (await readJsonBody(req)) || {};
  const dryRun = !!body.dryRun;

  // Every task in the store, read in parallel (a serial walk is a timeout).
  const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
  const { blobs } = await tasksStore.list();
  const tasks = (await Promise.all(blobs.map(async ({ key }) => {
    const t = await tasksStore.get(key, { type: 'json' }).catch(() => null);
    return t ? { key, t } : null;
  }))).filter(Boolean);
  const open = tasks.filter(({ t }) => !t.completed && t.autoFromStage && AUTO_KINDS.includes(t.autoFromStage));

  // Doc Reviews indexed by loan id — a Credit Report tray holding a document
  // counts as credit pulled even when Xactus never stamped the loan.
  const reviewByLoan = {};
  try {
    const rs = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const rl = await rs.list();
    const reviews = await Promise.all(rl.blobs.map(({ key }) => rs.get(key, { type: 'json' }).catch(() => null)));
    for (const r of reviews) {
      const lid = r && r.source && r.source.loanId;
      if (lid && !reviewByLoan[lid]) reviewByLoan[lid] = r;
    }
  } catch (e) { console.warn('tasks-auto-sweep: review index failed:', e && e.message); }

  const closed = [], left = [];
  const loanCache = {};
  for (const { key, t } of open) {
    const ck = String(t.ownerKey || '') + '|' + String(t.loanId || '');
    if (!(ck in loanCache)) {
      try {
        const f = await locateLoan({ ownerKey: keySafe(String(t.ownerKey || '')), clientId: t.clientId || '', loanId: t.loanId });
        loanCache[ck] = (f && f.loan) || null;
      } catch (_) { loanCache[ck] = null; }
    }
    const loan = loanCache[ck];
    const row = { id: t.id, who: t.assignedTo || '', title: t.title || '', address: (loan && loan.address) || '', dueDate: t.dueDate || '' };
    const reason = loan ? autoCompleteReason(loan, reviewByLoan[t.loanId]) : '';
    if (!reason) {
      left.push(Object.assign(row, { why: loan ? 'nothing on the loan says it is done' : 'loan not found' }));
      continue;
    }
    if (!dryRun) { markCompleted(t, reason); await tasksStore.setJSON(key, t); }
    closed.push(Object.assign(row, { reason }));
  }
  return json(200, { ok: true, dryRun, open: open.length, closed, left });
}
