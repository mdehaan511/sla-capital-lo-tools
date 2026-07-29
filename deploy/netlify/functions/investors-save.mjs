/**
 * investors-save.mjs — POST /api/investors-save
 *
 * Deploy 236.475 — the Investors admin book (Phase 1). Org-wide list of the
 * primary investors SLA sells loans to. Managed by ADMINS; read by everyone
 * (LOs pick an investor on a loan's Funding Plan — see investors-list).
 *
 * Unlike clients, investors are NOT owner-scoped — they're a single shared
 * namespace in the `investors` blob store, keyed by the investor id.
 *
 * Body: { id?, name, company?, pocName?, pocEmail?, pocPhone?, criteria?, notes? }
 *   id present  → update that investor
 *   id absent   → create (id = inv_<ts>_<rand>)
 *
 * v1 stores name + company + point-of-contact + free-text criteria/notes. The
 * record shape is intentionally roomy so pricing-sheet uploads and per-investor
 * KPIs can slot in later without a rewrite. Returns { ok, investor }.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, keySafe } from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { console.error('investors-save error:', e); return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = await req.json().catch(() => null);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const name    = String(body.name    || '').trim();
  const company = String(body.company || '').trim();
  if (!name && !company) return json(400, { error: 'Investor name or company is required' });

  const store = getStore({ name: 'investors', consistency: 'strong' });
  const now = new Date().toISOString();

  const fields = {
    name,
    company,
    pocName:  String(body.pocName  || '').trim(),
    pocEmail: String(body.pocEmail || '').trim().toLowerCase(),
    pocPhone: String(body.pocPhone || '').trim(),
    criteria: String(body.criteria || '').trim(),
    notes:    String(body.notes    || '').trim(),
  };

  let investor;
  if (body.id) {
    const key = keySafe(String(body.id));
    investor = await store.get(key, { type: 'json' }).catch(() => null);
    if (!investor) return json(404, { error: 'Investor not found: ' + body.id });
    Object.assign(investor, fields);
    investor.updatedAt = now;
    investor.updatedBy = user.email || '';
  } else {
    investor = Object.assign({
      id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    }, fields, {
      createdAt: now,
      updatedAt: now,
      createdBy: user.email || '',
    });
  }

  try {
    await store.setJSON(keySafe(investor.id), investor);
  } catch (e) {
    return json(500, { error: 'Failed to save investor: ' + (e.message || 'unknown') });
  }
  return json(200, { ok: true, investor });
}
