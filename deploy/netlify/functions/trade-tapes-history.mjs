/**
 * trade-tapes-history.mjs — Deploy 236.889 (Mike)
 *
 * Past trade tapes: every export (trade-tape-export.mjs) is persisted to the
 * `trade_tapes` blob store — files as base64 TEXT under file/<id>, metadata in
 * a single `index` doc (small, rarely written; newest first, capped at 300).
 *
 *   GET  /api/trade-tapes-history          → { tapes: [meta, ...] }
 *   GET  /api/trade-tapes-history?id=<id>  → the .xlsx binary (re-download)
 *   POST /api/trade-tapes-history          → { id, used: true|false }
 *        marks a tape as the one actually SENT (vs. a mistake/test export);
 *        stamps who/when so the list shows it.
 *
 * Auth: processor/admin — same gate as the export (tapes carry TINs + DOBs).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('trade-tapes-history error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const store = getStore({ name: 'trade_tapes', consistency: 'strong' });

  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    const idx = (await store.get('index', { type: 'json' }).catch(() => null)) || { tapes: [] };
    const tapes = Array.isArray(idx.tapes) ? idx.tapes : [];
    if (!id) return json(200, { tapes });

    const meta = tapes.find((t) => t && t.id === id);
    if (!meta) return json(404, { error: 'Tape not found' });
    const b64 = await store.get('file/' + id).catch(() => null);
    if (!b64) return json(404, { error: 'Tape file no longer stored' });
    const buf = Buffer.from(String(b64), 'base64');
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="' + String(meta.filename || 'Trade Tape.xlsx').replace(/"/g, '') + '"',
      },
    });
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || !body.id) return json(400, { error: 'id required' });
    const idx = (await store.get('index', { type: 'json' }).catch(() => null)) || { tapes: [] };
    const t = (Array.isArray(idx.tapes) ? idx.tapes : []).find((x) => x && x.id === body.id);
    if (!t) return json(404, { error: 'Tape not found' });
    if (body.used === true) {
      t.used = true;
      t.usedBy = user.email || '';
      t.usedAt = new Date().toISOString();
    } else if (body.used === false) {
      t.used = false;
      delete t.usedBy;
      delete t.usedAt;
    } else {
      return json(400, { error: 'used (true/false) required' });
    }
    await store.setJSON('index', idx);
    return json(200, { ok: true, tape: t });
  }

  return json(405, { error: 'Method not allowed' });
}
