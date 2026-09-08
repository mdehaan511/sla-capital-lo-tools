/**
 * _shared/trade-tape-store.mjs — Deploy 236.893 (Mike)
 *
 * One place that owns the `trade_tapes` catalogue, because there are now two
 * ways a tape gets into it: we generate one (trade-tape-export.mjs), or a
 * processor uploads the FINAL tape that actually went to the investor
 * (trade-tape-upload.mjs).
 *
 * Layout (unchanged from 236.889):
 *   file/<id>   the bytes, base64 TEXT — the blob-store convention here
 *   index       one small JSON doc, newest first
 *
 * RETENTION — the reason this file exists.
 * The 236.889 prune dropped everything past the newest 300. Mike's ask for
 * uploads is "a long term catalogue of all the trade tapes for auditing
 * purposes", so a burst of generated tapes must never age out a final one.
 * Generated tapes are working output and stay capped; uploaded finals are the
 * audit record and are never pruned. Deleting one is a deliberate act
 * (trade-tape-upload.mjs DELETE), not a side effect of somebody exporting.
 */
import { getStore } from '@netlify/blobs';

/** How many GENERATED tapes to keep. Uploaded finals are exempt. */
export const KEEP_GENERATED = 300;

export function tapesStore() {
  return getStore({ name: 'trade_tapes', consistency: 'strong' });
}

export function newTapeId() {
  return 'tape_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

export async function readIndex(store) {
  const idx = (await store.get('index', { type: 'json' }).catch(() => null)) || { tapes: [] };
  if (!Array.isArray(idx.tapes)) idx.tapes = [];
  return idx;
}

/**
 * Add a tape to the catalogue. `meta` is stored as-is alongside the id and
 * filename, so each caller decides what's worth recording.
 *
 * @returns {Promise<string>} the tape id ('' if the save failed — callers
 *          treat history as best-effort and never fail the user's download
 *          over it).
 */
export async function saveTape({ buf, filename, meta }) {
  const store = tapesStore();
  const id = newTapeId();
  await store.set('file/' + id, buf.toString('base64'));

  const idx = await readIndex(store);
  idx.tapes.unshift(Object.assign({ id, filename }, meta || {}));
  await pruneGenerated(store, idx);
  await store.setJSON('index', idx);
  return id;
}

/**
 * Trim GENERATED tapes past the cap, deleting their files too. Uploaded
 * finals (`source === 'uploaded'`) are skipped entirely — they keep their
 * place in the index and their bytes on disk no matter how old they get.
 */
export async function pruneGenerated(store, idx) {
  const generated = idx.tapes.filter((t) => t && t.source !== 'uploaded');
  if (generated.length <= KEEP_GENERATED) return;

  const doomed = new Set(generated.slice(KEEP_GENERATED).map((t) => t.id));
  idx.tapes = idx.tapes.filter((t) => !(t && doomed.has(t.id)));
  for (const id of doomed) {
    try { await store.delete('file/' + id); } catch (e) { /* already gone */ }
  }
}

/**
 * Content-Type for a re-download. The catalogue is no longer all .xlsx — an
 * uploaded final can be .xls or .csv, and serving those as xlsx makes Excel
 * throw a repair prompt at whoever is auditing.
 */
export function contentTypeFor(filename) {
  const n = String(filename || '').toLowerCase();
  if (n.endsWith('.csv')) return 'text/csv';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (n.endsWith('.xlsm')) return 'application/vnd.ms-excel.sheet.macroEnabled.12';
  if (n.endsWith('.xlsb')) return 'application/vnd.ms-excel.sheet.binary.macroEnabled.12';
  if (n.endsWith('.pdf')) return 'application/pdf';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}
