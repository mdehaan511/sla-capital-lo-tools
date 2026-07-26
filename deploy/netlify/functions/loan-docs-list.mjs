/**
 * loan-docs-list.mjs — GET /api/loan-docs-list?loanId=...&owner=...
 *
 * Deploy 236.119 — list documents for a loan from the loan-docs
 * metadata store. Returns the metadata records only — bytes are
 * fetched on demand via /api/loan-docs-get.
 *
 * Response: { docs: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.266

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-docs-list top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId     = String(url.searchParams.get('loanId') || '').trim();
  const ownerParam = String(url.searchParams.get('owner') || '').trim();

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (ownerParam && ownerParam !== selfEmail && ownerParam !== selfKey) {
    // Deploy 236.266 — processors need cross-owner doc read for review.
    if (!canListAllClients(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(ownerParam));
  }

  const metaStore = getStore({ name: 'loan-docs', consistency: 'strong' });
  try {
    const { blobs } = await metaStore.list({ prefix: ownerKey + '/' });
    const docs = [];
    await Promise.all(blobs.map(async ({ key }) => {
      if (!key.endsWith('.json')) return;
      const d = await metaStore.get(key, { type: 'json' });
      if (!d) return;
      if (loanId && String(d.loanId || '') !== loanId) return;
      docs.push(d);
    }));
    docs.sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
    return json(200, { docs });
  } catch (e) {
    return json(500, { error: 'Failed to list docs: ' + (e.message || 'unknown') });
  }
}
