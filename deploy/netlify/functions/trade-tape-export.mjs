/**
 * trade-tape-export.mjs — POST /api/trade-tape-export
 *
 * Deploy 236.885 (Mike) — generate an investor trade tape (.xlsx) straight
 * from the platform's loan records. Templates live in _shared/trade-tapes.mjs
 * (Colchis post-close trade + settlement now; Stride pre-funding next phase).
 *
 * Body: {
 *   tapeKey: 'colchis_trade' | 'colchis_settlement',
 *   loans: [{ owner, clientId, loanId }, ...],   // up to 60
 *   params?: { tradeDate?: 'YYYY-MM-DD', fundingBank?: string }
 * }
 * Response: the .xlsx binary (Content-Disposition attachment) with the
 * missing-required-cells summary in the X-Tape-Missing header (also fetched
 * by the UI to warn the processor what to hand-fill).
 *
 * Auth: processor/admin (tapes carry TINs + DOBs).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { TRADE_TAPES } from './_shared/trade-tapes.mjs';
import { buildXlsx } from './_shared/xlsx-write.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';
import { saveTape } from './_shared/trade-tape-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('trade-tape-export error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const tape = TRADE_TAPES[String(body.tapeKey || '')];
  if (!tape) return json(400, { error: 'Unknown tapeKey. Valid: ' + Object.keys(TRADE_TAPES).join(', ') });
  const reqs = Array.isArray(body.loans) ? body.loans.slice(0, 60) : [];
  if (!reqs.length) return json(400, { error: 'loans[] required' });
  const params = (body.params && typeof body.params === 'object') ? body.params : {};
  if (tape.params.indexOf('tradeDate') >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(String(params.tradeDate || ''))) {
    return json(400, { error: 'params.tradeDate (YYYY-MM-DD) required for this tape' });
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ctxs = [];
  const errors = [];
  const clientCache = {};
  const getClient = async (ownerKey, clientId) => {
    const key = ownerKey + '/' + keySafe(clientId);
    if (!(key in clientCache)) {
      clientCache[key] = await clientsStore.get(key, { type: 'json' }).catch(() => null);
    }
    return clientCache[key];
  };

  for (const r of reqs) {
    const ownerKey = keySafe(normalizeEmail(String(r.owner || '')));
    if (!ownerKey || !r.clientId || !r.loanId) { errors.push('bad request row'); continue; }
    const client = await getClient(ownerKey, r.clientId);
    const loan = client && Array.isArray(client.loans)
      ? client.loans.find((l) => l && l.id === r.loanId) : null;
    if (!loan) { errors.push(r.loanId + ': not found'); continue; }
    const guarantors = [];
    for (const gid of (loan.guarantorClientIds || []).slice(0, 3)) {
      const gc = await getClient(ownerKey, gid);
      if (gc) guarantors.push(gc);
    }
    ctxs.push({ loan, client, guarantors, ownerKey, params, sla: deriveBaselineLoanId(loan) });
  }
  if (!ctxs.length) return json(404, { error: 'No loans resolved: ' + errors.join('; ') });

  const built = tape.build(ctxs);
  const buf = await buildXlsx(built.sheets);
  const today = new Date().toISOString().slice(0, 10);
  const filename = (built.filenameBase + ' ' + today + '.xlsx').replace(/[^\w .()-]/g, '_');

  // Deploy 236.889 (Mike) — persist every generated tape so processors can
  // re-download past tapes (trade-tapes-history.mjs) and mark the one that
  // was actually sent — mistake tapes stay listed but unmarked. Files are
  // stored as base64 TEXT (the blob-store convention here). Best-effort: a
  // history-save failure never blocks the export itself.
  //
  // Deploy 236.893 — the write + the 300-tape prune moved into
  // _shared/trade-tape-store.mjs, which the upload endpoint shares. The prune
  // now counts GENERATED tapes only: uploaded final tapes are the audit
  // record and must not age out because somebody ran a batch of exports.
  let tapeId = '';
  try {
    tapeId = await saveTape({
      buf,
      filename,
      meta: {
        source: 'generated',
        tapeKey: tape.key,
        tapeLabel: tape.label,
        createdAt: new Date().toISOString(),
        createdBy: user.email || '',
        loanCount: ctxs.length,
        params: { tradeDate: String(params.tradeDate || ''), fundingBank: String(params.fundingBank || '') },
        missingCount: built.missing.length,
        used: false,
      },
    });
  } catch (e) {
    console.warn('trade-tape-export: history save failed (non-fatal):', e && e.message);
    tapeId = '';
  }

  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'X-Tape-Loans': String(ctxs.length),
      'X-Tape-Id': tapeId,
      'X-Tape-Missing': encodeURIComponent(built.missing.slice(0, 40).join(' | ')).slice(0, 3500),
      'X-Tape-Errors': encodeURIComponent(errors.join(' | ')).slice(0, 1000),
    },
  });
}
