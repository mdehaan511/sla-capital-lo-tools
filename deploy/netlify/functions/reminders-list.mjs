/**
 * reminders-list.mjs — GET /api/reminders
 *
 * Returns reminders for the authenticated LO. Admins may pass ?all=1
 * to get every LO's reminders (grouped by owner).
 *
 * Reminder shape:
 *   { id, loanId, clientId, ownerKey, address, borrower, note,
 *     dueDate, completed, createdAt, completedAt }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.266

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const includeCompleted = url.searchParams.get('completed') === '1';
  const store = getStore({ name: 'reminders', consistency: 'strong' });

  try {
    if (wantAll && canListAllClients(user).ok) {
      const { blobs } = await store.list();
      const byOwner = {};
      await Promise.all(blobs.map(async ({ key }) => {
        const idx = key.indexOf('/');
        if (idx < 0) return;
        const owner = key.slice(0, idx);
        const r = await store.get(key, { type: 'json' });
        if (!r) return;
        if (!includeCompleted && r.completed) return;
        if (!byOwner[owner]) byOwner[owner] = [];
        byOwner[owner].push(r);
      }));
      Object.keys(byOwner).forEach((o) =>
        byOwner[o].sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')));
      return json(200, { byOwner });
    }

    const ownerKey = keySafe(normalizeEmail(user.email));
    const { blobs } = await store.list({ prefix: ownerKey + '/' });
    const reminders = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' })),
    );
    const filtered = reminders.filter((r) => r && (includeCompleted || !r.completed));
    filtered.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
    return json(200, { reminders: filtered });
  } catch (e) {
    console.error('reminders-list error:', e);
    return json(500, { error: 'Failed to load reminders' });
  }
};
