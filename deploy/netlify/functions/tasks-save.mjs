/**
 * tasks-save.mjs — POST /api/tasks-save
 *
 * Deploy 236.105 (Phase C — Tasks) — create or update a task on a loan.
 *
 * Tasks live in their own Netlify blob store, keyed by the loan's
 * owner key + task id. That keeps the existing clients store small
 * (a busy loan could accumulate dozens of tasks) and lets the
 * tasks-list scan be a single prefix lookup.
 *
 * Body:
 *   {
 *     clientId: 'c_...',
 *     loanId:   'l_...',
 *     taskId?:  't_...',         // omit to create; provide to update
 *     title:    'Order title',
 *     dueDate?: '2026-07-15',    // YYYY-MM-DD or empty
 *     assignedTo?:     'sara@slacapital.com',
 *     assignedToName?: 'Sara Smith',
 *     description?:    '',
 *     completed?:      true/false,  // toggle done state
 *     owner?:   'other@lo.com'    // admin cross-LO override
 *   }
 *
 * Response: { ok: true, task: <full task record> }
 *
 * Permission: any authenticated user can create/edit tasks on any
 * loan they can see. Cross-LO writes require admin (same gate as
 * other endpoints).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('tasks-save top-level error:', e);
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

  const clientId = String(body.clientId || '').trim();
  const loanId   = String(body.loanId   || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  // Resolve loan owner. Admin cross-LO override allowed.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
  const now = new Date().toISOString();
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';

  let task;
  if (body.taskId) {
    // UPDATE existing.
    const key = ownerKey + '/' + keySafe(body.taskId);
    try { task = await tasksStore.get(key, { type: 'json' }); }
    catch (e) { return json(500, { error: 'Failed to read task: ' + (e.message || 'unknown') }); }
    if (!task) return json(404, { error: 'Task not found: ' + body.taskId });
    // Apply patches — only the fields the caller explicitly sent.
    if (body.title !== undefined)          task.title          = String(body.title || '').trim();
    if (body.dueDate !== undefined)        task.dueDate        = String(body.dueDate || '').trim();
    if (body.assignedTo !== undefined)     task.assignedTo     = String(body.assignedTo || '').trim().toLowerCase();
    if (body.assignedToName !== undefined) task.assignedToName = String(body.assignedToName || '').trim();
    if (body.description !== undefined)    task.description    = String(body.description || '').trim();
    if (body.completed !== undefined) {
      const wasCompleted = !!task.completed;
      task.completed = !!body.completed;
      if (task.completed && !wasCompleted) {
        task.completedAt = now;
        task.completedBy = user.email || '';
        task.completedByName = authorName;
      } else if (!task.completed && wasCompleted) {
        task.completedAt = '';
        task.completedBy = '';
        task.completedByName = '';
      }
    }
    task.updatedAt = now;
    task.updatedBy = user.email || '';
  } else {
    // CREATE new.
    if (!String(body.title || '').trim()) return json(400, { error: 'title required to create a task' });
    task = {
      id:              't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      clientId,
      loanId,
      ownerKey,
      title:           String(body.title || '').trim(),
      dueDate:         String(body.dueDate || '').trim(),
      assignedTo:      String(body.assignedTo || '').trim().toLowerCase(),
      assignedToName:  String(body.assignedToName || '').trim(),
      description:     String(body.description || '').trim(),
      completed:       !!body.completed,
      completedAt:     body.completed ? now : '',
      completedBy:     body.completed ? (user.email || '') : '',
      completedByName: body.completed ? authorName : '',
      createdAt:       now,
      createdBy:       user.email || '',
      createdByName:   authorName,
      updatedAt:       now,
      updatedBy:       user.email || '',
    };
  }

  const key = ownerKey + '/' + keySafe(task.id);
  try { await tasksStore.setJSON(key, task); }
  catch (e) { return json(500, { error: 'Failed to save task: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, task });
}
