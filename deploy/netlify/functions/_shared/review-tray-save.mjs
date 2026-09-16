/**
 * _shared/review-tray-save.mjs — Deploy 237.104 (Jessy: "starting a second upload
 * cancels the one currently in progress")
 *
 * The upload endpoints hold the review across a 10-20s AI call and then wrote
 * the WHOLE stale record back. Two uploads on the same review overlapping in
 * time meant the second save clobbered the first tray -- the earlier document
 * simply vanished, which is what "cancelled" looked like to the processor.
 *
 * saveTrayFresh(store, reviewId, slug, docState, topPatch) re-reads the review,
 * unions any document entries another writer added to THIS tray meanwhile
 * (by docId), assigns the tray, applies a top-level patch (object or fn), and
 * saves. Returns the merged review, or null when the review no longer exists
 * (caller falls back to its old whole-record write). Same idea as the
 * background reviewer's _saveTrayPatch (Deploy 236.762).
 */
import { keySafe } from './auth.mjs';

export async function saveTrayFresh(store, reviewId, slug, docState, topPatch) {
  const key = keySafe(reviewId);
  const fresh = await store.get(key, { type: 'json' }).catch(() => null);
  if (!fresh || !fresh.docs) return null;
  const theirs = fresh.docs[slug] || {};
  const mine = Array.isArray(docState.documents) ? docState.documents : [];
  const ids = new Set(mine.map((d) => d && d.docId).filter(Boolean));
  const extra = (Array.isArray(theirs.documents) ? theirs.documents : []).filter((d) => d && d.docId && !ids.has(d.docId));
  if (extra.length) docState.documents = mine.concat(extra);
  fresh.docs[slug] = docState;
  if (typeof topPatch === 'function') topPatch(fresh);
  else if (topPatch && typeof topPatch === 'object') Object.assign(fresh, topPatch);
  await store.setJSON(key, fresh);
  return fresh;
}
