/**
 * reminders-delete.mjs — POST /api/reminders-delete
 * Body: { reminderId, _owner? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.reminderId) return json(400, { error: 'reminderId required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);

  const store = getStore({ name: 'reminders', consistency: 'strong' });
  const key = `${keySafe(owner)}/${keySafe(body.reminderId)}`;

  try {
    await store.delete(key);
    return json(200, { ok: true });
  } catch (e) {
    console.error('reminders-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
