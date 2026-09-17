/**
 * admin-loan-tape-export-status.mjs — GET /api/admin-loan-tape-export-status?year=2025[&download=1]
 *
 * Deploy 237.030 — progress + download for the auditor loan tape built by
 * admin-loan-tape-export-background. Auth: admin or processor.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, isProcessor } from './_shared/auth.mjs';
import { contentDisposition } from './_shared/content-disposition.mjs'; // Deploy 237.139

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user) && !isProcessor(user)) return json(403, { error: 'Admin or processor only' });
    const url = new URL(req.url);
    const year = parseInt(url.searchParams.get('year'), 10);
    if (!(year >= 2015 && year <= 2100)) return json(400, { error: 'year required' });
    const store = getStore({ name: 'loan_tapes_export', consistency: 'strong' });
    const rec = await store.get(String(year), { type: 'json' }).catch(() => null);
    if (!rec) return json(200, { ok: true, meta: null });
    if (url.searchParams.get('download') === '1') {
      if (!rec.xlsxB64 || !rec.meta || rec.meta.status !== 'done') return json(409, { error: 'Tape not ready yet' });
      return new Response(Buffer.from(rec.xlsxB64, 'base64'), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': contentDisposition('attachment', rec.meta.filename || ('SLA ' + year + ' Loan Tape.xlsx')),
          'Cache-Control': 'no-store',
        },
      });
    }
    return json(200, { ok: true, meta: rec.meta || null });
  } catch (e) {
    console.error('admin-loan-tape-export-status error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
