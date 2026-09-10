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
import { getStore } from '@netlify/blobs';
import { keySafe } from './_shared/auth.mjs';
import {
  WORKSHEET_DEFS, TRACK_FRESH_DAYS, SOW_DEFAULT_ITEMS, worksheetStore, trackKey, sowKey,
  parseUploadGrid, mapGridToRows, trackGrossProfit, sowTotal, trackAgeDays,
} from './_shared/worksheets.mjs';

// Deploy 236.954 (Mike) — loan context for the SOW page: suggested "Borrower
// Name" (vesting LLC → entity → guarantor / primary client name), address,
// and (236.955) the loan's REHAB BUDGET from the sizer, so the page can show
// it up top and warn when the line items don't add up to it. Location comes
// from the borrower's GRANT (trusted), never from the body; staff fall back
// to the indexed cross-namespace lookup.
async function sowLoanContext(grant, loanId, staffRef) {
  try {
    let client = null;
    const clients = getStore({ name: 'clients', consistency: 'strong' });
    if (grant && grant.ownerKey && grant.primaryClientId) {
      client = await clients.get(keySafe(grant.ownerKey) + '/' + keySafe(grant.primaryClientId), { type: 'json' });
    } else if (staffRef && staffRef.ownerKey && staffRef.clientId) {
      // Staff callers (Loan Details) pass the loan's clientId + owner.
      client = await clients.get(keySafe(staffRef.ownerKey) + '/' + keySafe(staffRef.clientId), { type: 'json' });
    }
    if (!client) return null;
    const loan = (client.loans || []).find((l) => l && l.id === loanId) || {};
    const g0 = (Array.isArray(loan.guarantors) && loan.guarantors[0]) || null;
    const borrowerName =
      (Array.isArray(loan.vestingLLCs) && loan.vestingLLCs[0] && loan.vestingLLCs[0].name) ||
      loan.entityName || client.entityName ||
      loan.borrowerName ||
      (g0 && ((g0.firstName || '') + ' ' + (g0.lastName || '')).trim()) ||
      ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || '';
    const rb = parseFloat(loan.rehabBudget);
    return {
      borrowerName: String(borrowerName).trim(),
      propertyAddress: String(loan.address || ''),
      rehabBudget: (isFinite(rb) && rb > 0) ? rb : null,
    };
  } catch (_) { return null; }
}

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
  // Deploy 236.954 — the grant record carries primaryClientId + ownerKey,
  // which the name-suggest uses. Best-effort.
  async function grantFor(loanId) {
    try {
      const { listAccessibleLoans } = await import('./_shared/loan-access-store.mjs');
      const grants = await listAccessibleLoans(selfEmail);
      return grants.find((g) => g && g.loanId === loanId) || null;
    } catch (_) { return null; }
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
    // Deploy 236.954/955 — loan context: suggested Borrower Name for a fresh
    // SOW, plus the sizer's rehab budget for the top-of-page figure and the
    // save-time mismatch warning. Best-effort.
    const grant = staff ? null : await grantFor(loanId);
    const ctx = await sowLoanContext(grant, loanId,
      staff ? { ownerKey: normalizeEmail(body.owner || ''), clientId: String(body.clientId || '') } : null);
    return json(200, {
      kind, loanId, def: WORKSHEET_DEFS.sow,
      data: rec,
      defaultItems: SOW_DEFAULT_ITEMS,
      suggest: (!rec || !(rec.items || []).length) ? ctx : null,
      loanRehabBudget: ctx ? ctx.rehabBudget : null,
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
      const priorT = (await store.get(trackKey(email), { type: 'json' }).catch(() => null)) || {};
      const rec = {
        rows, updatedAt: now, updatedBy: normalizeEmail(user.email),
        source: String(data.source || 'form').slice(0, 20),
        customPending: rows.length ? undefined : priorT.customPending, // 236.954
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
      description: String((it && it.description) || '').slice(0, 500), // 236.954
    })).filter((it) => it.item || it.budget !== '' || it.description);
    // Prior record's customPending flag survives a normal save only if the
    // borrower hasn't completed the tool (items present = reviewed).
    const prior = (await store.get(sowKey(loanId), { type: 'json' }).catch(() => null)) || {};
    const rec = {
      borrowerName: String(data.borrowerName || '').slice(0, 120),
      propertyAddress: String(data.propertyAddress || '').slice(0, 200),
      // Deploy 236.954 — square-footage change question.
      sqftChange: data.sqftChange === 'yes' ? 'yes' : (data.sqftChange === 'no' ? 'no' : ''),
      sqftCurrent: data.sqftChange === 'yes' ? String(data.sqftCurrent || '').slice(0, 12) : '',
      sqftPost: data.sqftChange === 'yes' ? String(data.sqftPost || '').slice(0, 12) : '',
      items, updatedAt: now, updatedBy: normalizeEmail(user.email),
      source: String(data.source || 'form').slice(0, 20),
      customPending: items.length ? undefined : prior.customPending,
    };
    await store.setJSON(sowKey(loanId), rec);
    // Deploy 236.956 (Mike) — a SAVED Scope of Work also lands in the loan's
    // Documents tab: build a real .xlsx behind the scenes and file it as the
    // SOW tray's current document (the App-generated-docs standing rule), so
    // processors review it exactly like an uploaded sheet and it's exportable
    // for trades. Best-effort — a tray failure never blocks the save.
    let filed = false;
    if (items.length) {
      try {
        const { buildXlsx } = await import('./_shared/xlsx-write.mjs');
        const { attachFileToReviewSlug } = await import('./_shared/loan-review-auto-attach.mjs');
        const sqftRow = rec.sqftChange === 'yes'
          ? ['Sq Ft change', (rec.sqftCurrent || '?') + ' -> ' + (rec.sqftPost || '?')]
          : ['Sq Ft change', rec.sqftChange === 'no' ? 'No' : ''];
        const rows = [
          ['Scope of Work - Rehab Budget'],
          ['Borrower Name', rec.borrowerName || ''],
          ['Property Address', rec.propertyAddress || ''],
          sqftRow,
          [],
          ['Repair item', 'Budget', 'Description'],
        ];
        for (const it of items) rows.push([it.item, it.budget === '' ? '' : it.budget, it.description || '']);
        rows.push(['Total', sowTotal(items)]);
        const xlsx = await buildXlsx([{ name: 'SOW', rows }]);
        const street = String(rec.propertyAddress || loanId).split(',')[0].trim() || loanId;
        const r = await attachFileToReviewSlug({
          loanId,
          address: rec.propertyAddress || '',
          slug: 'sow',
          bytes: Buffer.from(xlsx),
          filename: street + ' - Scope of Work - ' + now.slice(0, 10) + '.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sourceNote: 'borrower SOW tool',
          actorEmail: normalizeEmail(user.email),
          documentDate: now.slice(0, 10),
        });
        filed = !!(r && r.attached);
      } catch (e) { console.warn('borrower-worksheets: SOW tray attach failed (non-fatal):', e && e.message); }
    }
    return json(200, { ok: true, kind, loanId, items: items.length, total: sowTotal(items), updatedAt: now, filedToTray: filed });
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

  // Deploy 236.954 — a borrower attached a CUSTOM Excel/CSV that our parser
  // could not map. The raw file already landed in the loan's doc tray (the
  // page uploads it via borrower-intake-upload first); this stamps the
  // worksheet record so the staff summary on Loan Details says the sheet
  // needs a manual read instead of looking like nothing was submitted.
  if (action === 'flag-custom') {
    if (view.viewingAs) return json(403, { error: 'View-as is read-only' });
    const filename = String(body.filename || 'custom sheet').slice(0, 120);
    const now = new Date().toISOString();
    const flag = { filename, uploadedAt: now, by: normalizeEmail(user.email) };
    if (kind === 'track') {
      const email = (staff && body.email) ? normalizeEmail(body.email) : selfEmail;
      const rec = (await store.get(trackKey(email), { type: 'json' }).catch(() => null)) || { rows: [] };
      rec.customPending = flag;
      await store.setJSON(trackKey(email), rec);
      return json(200, { ok: true });
    }
    const loanId = String(body.loanId || '');
    if (!loanId) return json(400, { error: 'loanId required' });
    if (!(await assertLoanAccess(loanId))) return json(403, { error: 'No access to this loan' });
    const rec = (await store.get(sowKey(loanId), { type: 'json' }).catch(() => null)) || { items: [] };
    rec.customPending = flag;
    await store.setJSON(sowKey(loanId), rec);
    return json(200, { ok: true });
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
