/**
 * baseline-graphql-probe.mjs — POST /api/baseline-graphql-probe
 *
 * Deploy 237.013 — TEMPORARY super-admin, READ-ONLY diagnostic. The Baseline
 * loan UI shows a "Product" (e.g. "DIYA · DSCR Loan") that names the investor,
 * but the REST GET /loan/{id} detail omits it. This passes a GraphQL query (or
 * a REST GET path) through to Baseline so we can locate the Product field and
 * build the DSCR investor/sold-date backfill. Mutations are refused. Remove
 * once the backfill is built.
 *
 * Body: { query, variables? }  — GraphQL against /api/graph, OR
 *        { rest: "/path" }     — a REST GET.
 * Auth: super-admin only.
 */
import { handleOptions, json, requireAuth, readJsonBody, isSuperAdmin } from './_shared/auth.mjs';

const BASE = (process.env.BASELINE_BASE_URL || 'https://production.baselinesoftware.com/production/api').replace(/\/+$/, '');

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { console.error('baseline-graphql-probe error:', e); return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });
  if (!process.env.BASELINE_API_KEY) return json(400, { error: 'BASELINE_API_KEY not configured' });

  const body = (await readJsonBody(req)) || {};
  const headers = {
    'Authorization': 'Token ' + process.env.BASELINE_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // REST GET passthrough (for probing sub-resources like /loan/{id}/... )
  if (body.rest) {
    const path = String(body.rest);
    if (!path.startsWith('/')) return json(400, { error: 'rest path must start with /' });
    const resp = await fetch(BASE + path, { method: 'GET', headers });
    const text = await resp.text().catch(() => '');
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return json(200, { ok: resp.ok, status: resp.status, kind: 'rest', body: parsed !== null ? parsed : text.slice(0, 4000) });
  }

  // GraphQL passthrough — READ ONLY.
  const q = String(body.query || '');
  if (!q.trim()) return json(400, { error: 'query (GraphQL) or rest path required' });
  if (/\bmutation\b/i.test(q) || /\bsubscription\b/i.test(q)) return json(403, { error: 'read-only: only GraphQL queries are allowed' });
  const resp = await fetch(BASE + '/api/graph', { method: 'POST', headers, body: JSON.stringify({ query: q, variables: body.variables || undefined }) });
  const text = await resp.text().catch(() => '');
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
  return json(200, { ok: resp.ok, status: resp.status, kind: 'graphql', body: parsed !== null ? parsed : text.slice(0, 4000) });
}
