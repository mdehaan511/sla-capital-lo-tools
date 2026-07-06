/**
 * baseline-borrower-probe.mjs — POST /api/baseline-borrower-probe
 *
 * Deploy 236.200 — diagnostic probe. Runs the same four paths our
 * borrower fetcher uses (GET /borrower, GET /borrowers, POST
 * /api/graph {borrowers}, POST /api/graph {people}) and returns the
 * status + body preview for each. No writes, no state changes.
 *
 * Use to see exactly what Baseline is saying on a 403 so we can hand
 * that off to Baseline support and ask them to enable the correct
 * scope on the API key.
 *
 * Auth: admin only.
 */
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { fetchAllBorrowerList } from './_shared/baseline-borrowers.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    const r = await fetchAllBorrowerList();
    return json(200, {
      ok: true,
      succeeded: r.ok,
      envelopeShape: r.envelopeShape || '',
      resultCount: (r.borrowers || []).length,
      probesTried: r.probesTried || [],
    });
  } catch (e) {
    console.error('baseline-borrower-probe error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
