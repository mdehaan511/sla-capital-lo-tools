/**
 * xactus-verifications-list.mjs — GET /api/xactus-verifications-list
 *
 * Deploy 236.779 — list verification records (credit pulls / flood certs)
 * for a loan or a client, newest first. Feeds the Verifications panel on
 * Loan Details and the Client page's credit section.
 *
 * Query: ?clientId=...&loanId=...&owner=...   (either filter or both)
 * Auth: processor/admin (results contain score data).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('xactus-verifications-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId') || '';
  const loanId   = url.searchParams.get('loanId') || '';
  const owner    = url.searchParams.get('owner') || '';
  if (!clientId && !loanId) return json(400, { error: 'clientId or loanId required' });

  const ownerKey = owner ? keySafe(normalizeEmail(owner)) : keySafe(normalizeEmail(user.email));
  const store = getStore({ name: 'verifications', consistency: 'strong' });
  const out = [];
  const { blobs } = await store.list({ prefix: ownerKey + '/' });
  for (const { key } of blobs) {
    const v = await store.get(key, { type: 'json' }).catch(() => null);
    if (!v) continue;
    if (loanId && v.loanId !== loanId && !(clientId && v.subject && v.subject.clientId === clientId && !v.loanId)) continue;
    if (!loanId && clientId && !(v.subject && v.subject.clientId === clientId)) continue;
    out.push(v);
  }
  out.sort((a, b) => String(b.orderedAt || '').localeCompare(String(a.orderedAt || '')));
  return json(200, { ok: true, verifications: out.slice(0, 50) });
}
