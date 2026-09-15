/**
 * servicingpros-probe.mjs — GET /api/servicingpros-probe
 *
 * Deploy 237.066 (Mike) — admin-only look at the raw Servicing Pros loan feed: every
 * field NAME plus the values of fields whose name mentions ACH / autopay /
 * draft / debit (no borrower PII). Used to answer "can we see ACH status in
 * Servicing Pros too?" without guessing at their undocumented feed.
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { spConfiguredAccounts } from './_shared/servicingpros-api.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const out = { books: [] };
    for (const a of spConfiguredAccounts(process.env)) {
      const token = String(process.env[a.envVar] || '').trim();
      const r = await fetch('https://my.servicingpros.com/api/v2/lender/loans', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const rows = r.ok ? await r.json().catch(() => []) : [];
      const list = Array.isArray(rows) ? rows : [];
      const ours = list.filter((x) => String(x.LoanOrigVendorAccount || '') === 'SLA');
      const keys = new Set(); ours.forEach((x) => Object.keys(x).forEach((k) => keys.add(k)));
      const achKeys = Array.from(keys).filter((k) => /ach|auto|draft|debit|pay(ment)?method|recurring/i.test(k));
      const samples = {};
      achKeys.forEach((k) => { const vals = {}; ours.forEach((x) => { const v = x[k]; const s = (v == null ? 'null' : String(v)).slice(0, 40); vals[s] = (vals[s] || 0) + 1; }); samples[k] = vals; });
      out.books.push({ book: a.key, http: r.status, loans: ours.length, fieldCount: keys.size, fields: Array.from(keys).sort(), achLikeFields: samples });
    }
    return json(200, out);
  } catch (e) {
    return json(500, { error: (e && e.message) || 'probe failed' });
  }
};
