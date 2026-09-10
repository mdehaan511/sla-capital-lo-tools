/**
 * borrower-worksheets.mjs — POST /api/borrower-worksheets
 *
 * Deploy 236.947 (Mike) — structured Track Record + Scope of Work, replacing
 * hand-filled Excel templates. See _shared/worksheets.mjs for the model.
 *
 * Actions (POST JSON { action, ... }):
 *   get   { kind:'track' }                      borrower: own record
 *         { kind:'track', email }               staff: any borrower's record
 *         { kind:'sow', loanId }                borrower (must hold a portal
 *                                               grant on the loan) or staff
 *   save  { kind:'track', data:{rows} }         borrower or staff-for-borrower
 *         { kind:'sow', loanId, data:{...} }    (staff saves stamp their email;
 *                                               admin view-as NEVER writes)
 *   parse { kind, filename, dataB64 }           parse an uploaded xlsx/csv and
 *                                               return mapped rows + warnings —
 *                                               a PREVIEW; nothing is stored.
 *
 * Auth: requireAuth covers both borrower (Supabase) and staff tokens.
 * Borrowers are scoped to their own email + their granted loans; staff
 * (isStaff) may read/save any. Admin ?viewAs= (portal view-as) renders
 * read-only — save refuses, matching the 236.895 contract.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail,
} from './_shared/auth.mjs';
import { roleOf } from './_shared/access.mjs';
import { resolveViewAs } from './_shared/portal-view-as.mjs';
import { hasLoanGrant } from './_shared/loan-access-store.mjs';
import {
  WORKSHEET_DEFS, TRACK_FRESH_DAYS, worksheetStore, trackKey, sowKey,
  parseUploadGrid, mapGridToRows, trackGrossProfit, sowTotal, trackAgeDays,
} from './_shared/worksheets.mjs';

const MAX_UPLOAD = 4 * 1024 * 1024; // matches the single-POST body ceiling

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-worksheets error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  const action = String(body.action || '');
  const kind = String(body.kind || '');
  if (action !== 'parse' && !WORKSHEET_DEFS[kind]) return json(400, { error: 'kind must be track or sow' });

  // Staff = any role that is not portal-side (borrower/viewer/broker). This
  // mirrors how the rest of the platform separates staff from portal logins.
  const staff = ['borrower', 'viewer', 'broker'].indexOf(roleOf(user)) < 0;
  const view = resolveViewAs(req, user); // staff may ?viewAs= a borrower (read-only)
  if (view.error) return view.error;
  const selfEmail = normalizeEmail(view.email || user.email);

  // A borrower may only touch a SOW for a loan their portal can see.
  async function assertLoanAccess(loanId) {
    if (staff && !view.viewingAs) return true;
    return hasLoanGrant(selfEmail, loanId);
  }

  const store = worksheetStore();

  if (action === 'get') {
    if (kind === 'track') {
      // Staff may read any borrower's track record by email.
      const email = (staff && body.email) ? normalizeEmail(body.email) : selfEmail;
      const rec = (await store.get(trackKey(email), { type: 'json' }).catch(() => null)) || null;
      const rows = (rec && rec.rows) || [];
      const age = trackAgeDays(rec);
      return json(200, {
        kind, email, def: WORKSHEET_DEFS.track,
        data: rec, rows,
        computed: rows.map((r) => ({ grossProfit: trackGrossProfit(r) })),
        ageDays: age, stale: age != null && age > TRACK_FRESH_DAYS, freshDays: TRACK_FRESH_DAYS,
        readOnly: !!view.viewingAs,
      });
    }
    const loanId = String(body.loanId || '');
    if (!loanId) return json(400, { error: 'loanId required for sow' });
    if (!(await assertLoanAccess(loanId))) return json(403, { error: 'No access to this loan' });
    const rec = (await store.get(sowKey(loanId), { type: 'json' }).catch(() => null)) || null;
    return json(200, {
      kind, loanId, def: WORKSHEET_DEFS.sow,
      data: rec,
      total: sowTotal(rec && rec.items),
      readOnly: !!view.viewingAs,
    });
  }

  if (action === 'save') {
    if (view.viewingAs) return json(403, { error: 'View-as is read-only' }); // 236.895 contract
    const data = body.data || {};
    const now = new Date().toISOString();
    if (kind === 'track') {
      const email = (staff && body.email) ? normalizeEmail(body.email) : selfEmail;
      const rows = (Array.isArray(data.rows) ? data.rows : []).slice(0, 500).map(cleanRow);
      const rec = {
        rows, updatedAt: now, updatedBy: normalizeEmail(user.email),
        source: String(data.source || 'form').slice(0, 20),
      };
      await store.setJSON(trackKey(email), rec);
      return json(200, { ok: true, kind, email, rows: rows.length, updatedAt: now });
    }
    const loanId = String(body.loanId || '');
    if (!loanId) return json(400, { error: 'loanId required for sow' });
    if (!(await assertLoanAccess(loanId))) return json(403, { error: 'No access to this loan' });
    const items = (Array.isArray(data.items) ? data.items : []).slice(0, 300).map((it) => ({
      item: String((it && it.item) || '').slice(0, 200),
      budget: (it && it.budget !== '' && it.budget != null && isFinite(parseFloat(it.budget))) ? Math.round(parseFloat(it.budget) * 100) / 100 : '',
    })).filter((it) => it.item || it.budget !== '');
    const rec = {
      borrowerName: String(data.borrowerName || '').slice(0, 120),
      propertyAddress: String(data.propertyAddress || '').slice(0, 200),
      items, updatedAt: now, updatedBy: normalizeEmail(user.email),
      source: String(data.source || 'form').slice(0, 20),
    };
    await store.setJSON(sowKey(loanId), rec);
    return json(200, { ok: true, kind, loanId, items: items.length, total: sowTotal(items), updatedAt: now });
  }

  if (action === 'parse') {
    if (!WORKSHEET_DEFS[kind]) return json(400, { error: 'kind must be track or sow' });
    const filename = String(body.filename || 'upload');
    const b64 = String(body.dataB64 || '');
    if (!b64) return json(400, { error: 'dataB64 required' });
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { return json(400, { error: 'Bad file data' }); }
    if (!buf.length || buf.length > MAX_UPLOAD) return json(400, { error: 'File must be under 4MB' });
    let grid;
    try { grid = await parseUploadGrid(buf, filename); }
    catch (e) { return json(400, { error: 'Could not read the file: ' + (e.message || 'unknown') }); }
    const { rows, warnings } = mapGridToRows(grid, kind);
    return json(200, {
      ok: true, kind, rows, warnings,
      computed: kind === 'track' ? rows.map((r) => ({ grossProfit: trackGrossProfit(r) })) : undefined,
      total: kind === 'sow' ? sowTotal(rows.map((r) => ({ budget: r.budget }))) : undefined,
    });
  }

  return json(400, { error: 'Unknown action' });
}

function cleanRow(r) {
  const out = {};
  for (const col of WORKSHEET_DEFS.track.columns) {
    if (col.derived) continue;
    const v = r && r[col.key];
    if (v === undefined || v === null || v === '') continue;
    out[col.key] = col.type === 'money'
      ? (isFinite(parseFloat(v)) ? Math.round(parseFloat(v) * 100) / 100 : '')
      : String(v).slice(0, 200);
  }
  return out;
}
