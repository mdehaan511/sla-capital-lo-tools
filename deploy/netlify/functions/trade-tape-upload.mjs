/**
 * trade-tape-upload.mjs — Deploy 236.893 (Mike)
 *
 * Upload the FINAL trade tape into the same catalogue as the generated ones.
 *
 * Mike: "make it so that final trade tapes can be uploaded in that Trade Tape
 * menu … add that to the log of Past Tapes with the name being the name of the
 * tape as its uploaded then look at the doc during upload to see how many
 * loans there are. The goal is to keep a long term catelogue of all the trade
 * tapes for auditing purposes."
 *
 *   POST /api/trade-tape-upload  { filename, dataB64 }
 *        → { ok, tape }                    catalogued
 *        → { ok, duplicate:true, tape }     these exact bytes are already in
 *                                           the catalogue — no second entry
 *   POST /api/trade-tape-upload  { id, remove:true }   (admin) delete a mistake
 *
 * Three deliberate choices:
 *   1. The tape's NAME is the uploaded filename, per Mike — no picker, no
 *      template key to choose. Rename the file before uploading to rename it
 *      here.
 *   2. `used: true` on arrival. The "used" mark separates a tape that was
 *      really sent from a mistake export; a final tape coming back from the
 *      investor is by definition the real one. Toggleable either way.
 *   3. Exact-duplicate uploads return the EXISTING entry instead of adding a
 *      second one. An audit catalogue with the same tape logged three times
 *      because someone double-clicked is a worse record, not a better one.
 *
 * Auth: processor/admin — same gate as the export and the history, since
 * tapes carry borrower TINs and DOBs.
 */
import { createHash } from 'node:crypto';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, isAdmin,
} from './_shared/auth.mjs';
import { tapesStore, readIndex, saveTape } from './_shared/trade-tape-store.mjs';
import { countTapeLoans } from './_shared/tape-row-count.mjs';

/** Formats we can store AND say something honest about. */
const ALLOWED_EXT = /\.(xlsx|xlsm|xlsb|xls|csv|txt)$/i;

/**
 * ~4.2MB is the real single-POST ceiling here (6MB body ÷ base64 inflation).
 * A 500-loan, 61-column tape is well under 1MB, so this only ever catches a
 * wrong file — and says so rather than failing as a generic 502.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_B64_CHARS = Math.ceil(MAX_FILE_BYTES * 4 / 3) + 1024;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('trade-tape-upload error:', e);
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
  if (!body) return json(400, { error: 'Body required' });

  if (body.remove) return removeTape(body, user);

  // ── Filename ──────────────────────────────────────────────────────────
  // Browsers send a bare name, but strip path segments anyway — the value
  // ends up in a Content-Disposition header on the way back out.
  const filename = String(body.filename || '')
    .split(/[\\/]/).pop()
    .replace(/[\r\n"]/g, '')
    .trim()
    .slice(0, 180);
  if (!filename) return json(400, { error: 'filename required' });
  if (!ALLOWED_EXT.test(filename)) {
    return json(400, { error: 'Upload a .xlsx, .xlsm, .xlsb, .xls or .csv file — got "' + filename + '"' });
  }

  // ── Bytes ─────────────────────────────────────────────────────────────
  // Accept a bare base64 string or a data: URL (what FileReader produces).
  const raw = String(body.dataB64 || '');
  const b64 = raw.includes(',') && raw.slice(0, 60).includes('base64,')
    ? raw.slice(raw.indexOf(',') + 1)
    : raw;
  if (!b64) return json(400, { error: 'dataB64 required' });
  if (b64.length > MAX_B64_CHARS) {
    return json(413, { error: 'That file is too large to upload here (limit ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + 'MB).' });
  }

  let buf;
  try { buf = Buffer.from(b64, 'base64'); }
  catch (e) { return json(400, { error: 'Could not decode the uploaded file' }); }
  if (!buf.length) return json(400, { error: 'The uploaded file is empty' });
  if (buf.length > MAX_FILE_BYTES) {
    return json(413, { error: 'That file is too large to upload here (limit ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + 'MB).' });
  }

  // ── Already catalogued? ───────────────────────────────────────────────
  const sha = createHash('sha256').update(buf).digest('hex');
  const store = tapesStore();
  const idx = await readIndex(store);
  const dup = idx.tapes.find((t) => t && t.sha256 === sha);
  if (dup) return json(200, { ok: true, duplicate: true, tape: dup });

  // ── How many loans? ───────────────────────────────────────────────────
  // Never fatal: a tape we can't count is still worth keeping, which is the
  // whole point of an audit catalogue.
  let count = { loanCount: null, headerRow: 0, sheetName: '', reason: 'not attempted' };
  try { count = await countTapeLoans(buf, filename); }
  catch (e) { count = { loanCount: null, headerRow: 0, sheetName: '', reason: 'could not read the file: ' + ((e && e.message) || 'unknown') }; }

  const now = new Date().toISOString();
  const meta = {
    source: 'uploaded',
    tapeKey: 'uploaded',
    // Mike's rule: the tape is named by the file. Extension trimmed for the
    // list; `filename` keeps the real one for the re-download.
    tapeLabel: filename.replace(ALLOWED_EXT, ''),
    createdAt: now,
    createdBy: user.email || '',
    loanCount: count.loanCount,
    // Which row the counter took as the header — the one number that makes a
    // surprising loan count explainable months later without the file open.
    headerRow: count.headerRow || 0,
    countNote: count.reason || '',
    sheetName: count.sheetName || '',
    sizeBytes: buf.length,
    sha256: sha,
    // A final tape is, by definition, the one that was sent.
    used: true,
    usedBy: user.email || '',
    usedAt: now,
  };

  let id = '';
  try {
    id = await saveTape({ buf, filename, meta });
  } catch (e) {
    console.error('trade-tape-upload: save failed:', e && e.message);
    return json(500, { error: 'Could not save the tape: ' + ((e && e.message) || 'unknown') });
  }

  return json(200, { ok: true, tape: Object.assign({ id, filename }, meta) });
}

/**
 * Delete a catalogued tape. Uploaded finals are exempt from the automatic
 * prune, so a misclick would otherwise sit in the audit log forever — but
 * removing an audit record is an admin decision, not a processor one.
 */
async function removeTape(body, user) {
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });
  const id = String(body.id || '');
  if (!id) return json(400, { error: 'id required' });

  const store = tapesStore();
  const idx = await readIndex(store);
  const i = idx.tapes.findIndex((t) => t && t.id === id);
  if (i < 0) return json(404, { error: 'Tape not found' });

  const [gone] = idx.tapes.splice(i, 1);
  await store.setJSON('index', idx);
  try { await store.delete('file/' + id); } catch (e) { /* index is the record of truth */ }
  console.log('trade-tape-upload: ' + (user.email || '?') + ' deleted tape ' + id + ' (' + (gone && gone.filename) + ')');
  return json(200, { ok: true, removed: id });
}
