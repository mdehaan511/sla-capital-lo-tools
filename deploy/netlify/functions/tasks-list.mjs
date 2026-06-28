/**
 * tasks-list.mjs — GET /api/tasks-list
 *
 * Deploy 236.105 (Phase C — Tasks) — list tasks. Three modes:
 *
 *   ?loanId=l_...&clientId=c_...&owner?=other@lo.com
 *       Per-loan list. Owner defaults to the auth user; admin can
 *       pass owner= for cross-LO read.
 *
 *   ?assignedTo=me  (default when no loanId)
 *       Cross-loan list of tasks assigned to the current user.
 *       Scans the user's own owner prefix only — covers the common
 *       case (LO assigned tasks on their own loans) without an
 *       expensive all-owners scan.
 *
 *   ?all=1
 *       Admin only. Scans every owner prefix and returns the full
 *       task set. Used by tasks.html admin view (Phase C.2).
 *
 * Response: { tasks: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('tasks-list top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId       = String(url.searchParams.get('loanId') || '').trim();
  const ownerParam   = String(url.searchParams.get('owner') || '').trim();
  const assignedTo   = String(url.searchParams.get('assignedTo') || '').trim().toLowerCase();
  const all          = url.searchParams.get('all') === '1';

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });

  // Resolve effective ownerKey for non-all queries.
  let ownerKey = selfKey;
  if (ownerParam && ownerParam !== selfEmail && ownerParam !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(ownerParam));
  }

  if (all) {
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    try {
      const out = [];
      const { blobs } = await tasksStore.list();
      await Promise.all(blobs.map(async ({ key }) => {
        const t = await tasksStore.get(key, { type: 'json' });
        if (t) out.push(t);
      }));
      return json(200, { tasks: out });
    } catch (e) {
      return json(500, { error: 'Failed to list tasks: ' + (e.message || 'unknown') });
    }
  }

  try {
    const { blobs } = await tasksStore.list({ prefix: ownerKey + '/' });
    const tasks = [];
    await Promise.all(blobs.map(async ({ key }) => {
      const t = await tasksStore.get(key, { type: 'json' });
      if (!t) return;
      // Per-loan filter.
      if (loanId && String(t.loanId || '') !== loanId) return;
      // Cross-loan "my tasks" filter.
      if (assignedTo === 'me') {
        const asn = String(t.assignedTo || '').toLowerCase();
        if (asn !== selfEmail) return;
      } else if (assignedTo) {
        const asn = String(t.assignedTo || '').toLowerCase();
        if (asn !== assignedTo) return;
      }
      tasks.push(t);
    }));
    return json(200, { tasks });
  } catch (e) {
    return json(500, { error: 'Failed to list tasks: ' + (e.message || 'unknown') });
  }
}
