/**
 * admin-store-indexes-rebuild.mjs — POST /api/admin-store-indexes-rebuild
 *
 * Deploy 236.343 — one-click rebuild for every materialized store
 * index (clients, quotes, prospects, borrower_info). Runs them
 * sequentially to avoid stampeding the primary stores; each rebuild
 * takes a few seconds at Mike's scale.
 *
 * Optionally pass ?store=<name> to rebuild just one:
 *   ?store=clients
 *   ?store=quotes
 *   ?store=prospects
 *   ?store=borrower_info
 *
 * Auth: admin only.
 * Response: { ok, results: { [store]: { ownerCount, recordCount|clientCount, ms } } }
 */
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { rebuildIndex as rebuildClients } from './_shared/clients-index.mjs';
import { quotesIndex }        from './_shared/quotes-index.mjs';
import { prospectsIndex }     from './_shared/prospects-index.mjs';
import { borrowerInfoIndex }  from './_shared/borrower-info-index.mjs';

const REBUILDS = {
  clients:       rebuildClients,
  quotes:        () => quotesIndex.rebuildIndex(),
  prospects:     () => prospectsIndex.rebuildIndex(),
  borrower_info: () => borrowerInfoIndex.rebuildIndex(),
};

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-store-indexes-rebuild error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const url = new URL(req.url);
  const single = url.searchParams.get('store') || '';
  const wanted = single ? [single] : Object.keys(REBUILDS);

  const results = {};
  for (const name of wanted) {
    const fn = REBUILDS[name];
    if (!fn) { results[name] = { error: 'unknown store' }; continue; }
    try {
      results[name] = await fn();
    } catch (e) {
      results[name] = { error: (e && e.message) || 'rebuild failed' };
    }
  }
  return json(200, { ok: true, results });
}
