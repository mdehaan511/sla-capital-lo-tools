/**
 * desk-backfill.mjs — POST /api/desk-backfill   (admin)
 *
 * Deploy 237.269 (Mike): "You can backfill for loans in Intake, Processing, or
 * Underwriting Status. But for Underwriting and Processing check off the Send Welcome
 * Outreach and Submit Borrower Credit tasks automatically since those will already be
 * done." And: "backfill any loans that already have a BPO or Appraisal uploaded then
 * check off that task as well."
 *
 * Gives every loan already in those stages the four desk tasks it would have got on the
 * way in, with Mike's check-offs applied. Idempotent: a kind already on file for a loan
 * is never created twice, so a second run only fills gaps.
 *
 * Writes ONLY task records -- never a loan -- so a run cannot cause a database write
 * storm. Sends no notifications: fifty loans' worth of "task assigned to you" at once
 * would bury the bell; the desks show the result.
 *
 * Body: { dryRun?: true }   → { ok, dryRun, loansScanned, targets, created, completed,
 *                               byStage, byAssignee, loans: [...] }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { planDeskBackfill, isDeskTask } from './_shared/desk-tasks.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('desk-backfill error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

/** PG loan rows → the plain shape planDeskBackfill takes. Pure. */
export function rowToLoan(r) {
  const x = (r && r.extra && typeof r.extra === 'object') ? r.extra : {};
  return {
    id: r.id, clientId: r.client_id, ownerKey: keySafe(normalizeEmail(r.owner_email || '')),
    status: r.status || x.status || '', processingStage: r.processing_stage || x.processingStage || '',
    assignedProcessors: x.assignedProcessors, assignedProcessor: x.assignedProcessor,
    valuationOrder: x.valuationOrder || null,
  };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });
  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;

  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await db.select('loans', { select: 'id,client_id,owner_email,status,processing_stage,extra', limit: 1000, offset });
    rows.push(...(page || []));
    if (!page || page.length < 1000 || offset > 100000) break;
  }
  const loans = rows.map(rowToLoan);

  const reviews = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const rKeys = (await reviews.list()).blobs || [];
  const rRecs = await Promise.all(rKeys.map((b) => reviews.get(b.key, { type: 'json' }).catch(() => null)));
  // A loan can have more than one review; any of them carrying a BPO / Appraisal counts,
  // so keep the one that does (valuationDocOnFile is asked per loan in the plan).
  const reviewsByLoan = {};
  rRecs.forEach((r) => {
    const id = r && r.source && r.source.loanId;
    if (!id) return;
    const docs = Object.assign({}, (reviewsByLoan[id] && reviewsByLoan[id].docs) || {}, r.docs || {});
    reviewsByLoan[id] = { docs };
  });

  const tasks = getStore({ name: 'tasks', consistency: 'strong' });
  const tKeys = (await tasks.list()).blobs || [];
  const tRecs = await Promise.all(tKeys.map((b) => tasks.get(b.key, { type: 'json' }).catch(() => null)));
  const existing = {};
  tRecs.forEach((t) => { if (isDeskTask(t)) { (existing[t.loanId] = existing[t.loanId] || {})[t.deskKind] = true; } });

  const plan = planDeskBackfill({ loans, reviewsByLoan, existing });
  if (!dryRun) {
    for (let i = 0; i < plan.tasks.length; i += 25) {
      await Promise.all(plan.tasks.slice(i, i + 25).map((t) => tasks.setJSON(keySafe(t.ownerKey) + '/' + keySafe(t.id), t)));
    }
  }
  const byStage = {}, byAssignee = {};
  plan.loans.forEach((l) => { byStage[l.stage] = (byStage[l.stage] || 0) + 1; });
  plan.tasks.forEach((t) => { if (!t.completed) { const k = t.assignedTo || '(unassigned)'; byAssignee[k] = (byAssignee[k] || 0) + 1; } });
  return json(200, {
    ok: true, dryRun, loansScanned: loans.length, targets: plan.loans.length,
    created: plan.tasks.length, completed: plan.tasks.filter((t) => t.completed).length,
    byStage, openByAssignee: byAssignee, loans: plan.loans,
  });
}
