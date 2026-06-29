/**
 * loan-contacts-list.mjs — GET /api/loan-contacts-list?loanId=...&owner=...
 *
 * Deploy 236.113 — list additional contacts for a loan.
 *
 * Response: { contacts: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-contacts-list top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId     = String(url.searchParams.get('loanId') || '').trim();
  const ownerParam = String(url.searchParams.get('owner') || '').trim();
  // Deploy 236.115 (Phase E.2) — ?all=1 for admin cross-LO scans
  // used by contacts.html central view.
  const all        = url.searchParams.get('all') === '1';

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);

  const store = getStore({ name: 'loan-contacts', consistency: 'strong' });

  if (all) {
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    try {
      const { blobs } = await store.list();
      const contacts = [];
      await Promise.all(blobs.map(async ({ key }) => {
        const c = await store.get(key, { type: 'json' });
        if (!c) return;
        if (loanId && String(c.loanId || '') !== loanId) return;
        contacts.push(c);
      }));
      return json(200, { contacts });
    } catch (e) {
      return json(500, { error: 'Failed to list contacts: ' + (e.message || 'unknown') });
    }
  }

  let ownerKey = selfKey;
  if (ownerParam && ownerParam !== selfEmail && ownerParam !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(ownerParam));
  }

  try {
    const { blobs } = await store.list({ prefix: ownerKey + '/' });
    const contacts = [];
    await Promise.all(blobs.map(async ({ key }) => {
      const c = await store.get(key, { type: 'json' });
      if (!c) return;
      if (loanId && String(c.loanId || '') !== loanId) return;
      contacts.push(c);
    }));
    return json(200, { contacts });
  } catch (e) {
    return json(500, { error: 'Failed to list contacts: ' + (e.message || 'unknown') });
  }
}
