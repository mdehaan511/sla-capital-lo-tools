/**
 * tasks-delete.mjs — POST /api/tasks-delete
 *
 * Deploy 236.105 (Phase C — Tasks) — delete a task.
 *
 * Body: { taskId, owner?: 'other@lo.com' }
 *
 * Response: { ok: true, deletedId }
 *
 * Permission: creator, assignee, or admin. Anyone else gets 403.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.880

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('tasks-delete top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const taskId = String(body.taskId || '').trim();
  if (!taskId) return json(400, { error: 'taskId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.880 - was isAdmin-only; processors work other LOs loans (Beth cancelling Randy's loan got a 403)
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(taskId);

  let task;
  try { task = await tasksStore.get(key, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read task: ' + (e.message || 'unknown') }); }
  if (!task) return json(404, { error: 'Task not found: ' + taskId });

  // Permission: creator, assignee, or admin.
  const isCreator  = String(task.createdBy || '').toLowerCase() === selfEmail;
  const isAssignee = String(task.assignedTo || '').toLowerCase() === selfEmail;
  if (!isCreator && !isAssignee && !isAdmin(user)) {
    return json(403, { error: 'Only the task creator, assignee, or an admin can delete this task' });
  }

  try { await tasksStore.delete(key); }
  catch (e) { return json(500, { error: 'Failed to delete task: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, deletedId: taskId });
}
