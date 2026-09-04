/**
 * _shared/broker-quotes.mjs — Deploy 236.870
 *
 * Every "Get Pricing" a broker runs is saved here (Mike). Two audiences
 * from one record:
 *
 *   the BROKER  — their own history, so they can come back to a scenario
 *                 they priced last week instead of rebuilding it
 *   SLA         — every quote every partner has run, so an LO can see what
 *                 a broker is working and reproduce exactly what they saw
 *
 * SEPARATE FROM broker-activity
 * -----------------------------
 * `broker_activity` collapses a sitting into ONE session row so the desk
 * stays readable — twelve scenarios on one property is one line with a
 * count. That's the right shape for "who is working something right now"
 * and the wrong shape for "show me the quote I ran on Tuesday". This store
 * keeps every individual quote; the two answer different questions and
 * should not be merged.
 *
 * Key: <brokerKey>/<quoteId> — quote ids sort lexically by time (they're
 * base36 timestamps), so a prefix list is already newest-last.
 *
 * Declines are saved too. "I priced this and it didn't fit" is history a
 * broker and an LO both want; dropping it would make the record lie about
 * what was tried.
 *
 * Zero-throw: pricing must never fail because history didn't save.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE = 'broker_quotes';

// Per-broker retention. A busy partner running 30 scenarios a day would
// otherwise accumulate without bound; 500 is comfortably more than anyone
// scrolls and keeps a prefix list fast.
const KEEP_PER_BROKER = 500;

function _store() {
  return getStore({ name: STORE, consistency: 'strong' });
}

function bk(email) {
  return keySafe(normalizeEmail(email || ''));
}

/**
 * Persist one quote. Returns the stored record, or null on failure.
 *
 * `snapshot` is everything needed to REPRODUCE the quote later: the exact
 * inputs, the program, the fee, and the result as the broker saw it. The
 * pricing effective date is stored with it, because "why is this different
 * now?" is answered by which rate sheet it came from — not by re-running
 * today's numbers.
 */
export async function saveQuote(ev) {
  if (!ev || !ev.brokerEmail || !ev.quoteId) return null;
  const now = new Date().toISOString();
  const rec = {
    quoteId:       ev.quoteId,
    brokerEmail:   normalizeEmail(ev.brokerEmail),
    ownerKey:      ev.ownerKey || '',
    program:       ev.program || '',
    programLabel:  ev.programLabel || '',
    address:       ev.address || '',
    effectiveDate: ev.effectiveDate || null,
    declined:      !!ev.declined,
    reason:        ev.reason || '',
    inputs:        ev.inputs || {},
    result:        ev.result || null,
    fee:           ev.fee || null,
    allIn:         ev.allIn || null,
    // Set when the broker later attaches a borrower to print a sheet, and
    // when they send it to their rep. Both are Phase 2b/4; the fields live
    // here now so a quote doesn't have to be migrated to gain them.
    borrower:      ev.borrower || null,
    submittedAt:   null,
    submittedTo:   '',
    createdAt:     now,
  };
  try {
    await _store().setJSON(bk(rec.brokerEmail) + '/' + rec.quoteId, rec);
    return rec;
  } catch (e) {
    console.warn('[broker-quotes] save failed (non-fatal):', e && e.message);
    return null;
  }
}

/** One quote by id, scoped to its broker. Null if absent. */
export async function getQuote(brokerEmail, quoteId) {
  if (!brokerEmail || !quoteId) return null;
  try {
    return await _store().get(bk(brokerEmail) + '/' + String(quoteId), { type: 'json' });
  } catch (_) { return null; }
}

/** Update a stored quote in place (borrower attached, submitted, …). */
export async function patchQuote(brokerEmail, quoteId, patch) {
  const rec = await getQuote(brokerEmail, quoteId);
  if (!rec) return null;
  Object.assign(rec, patch || {}, { updatedAt: new Date().toISOString() });
  try {
    await _store().setJSON(bk(brokerEmail) + '/' + String(quoteId), rec);
    return rec;
  } catch (e) {
    console.warn('[broker-quotes] patch failed:', e && e.message);
    return null;
  }
}

/**
 * A broker's quotes, newest first.
 * @param opts { limit }
 */
export async function listQuotes(brokerEmail, opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(500, opts.limit || 100));
  const out = [];
  try {
    const store = _store();
    const { blobs } = await store.list({ prefix: bk(brokerEmail) + '/' });
    for (const { key } of blobs) {
      const q = await store.get(key, { type: 'json' }).catch(() => null);
      if (q) out.push(q);
    }
  } catch (e) {
    console.warn('[broker-quotes] list failed:', e && e.message);
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out.slice(0, limit);
}

/** Every partner's quotes, newest first. Admin surfaces only. */
export async function listAllQuotes(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(1000, opts.limit || 200));
  const out = [];
  try {
    const store = _store();
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const q = await store.get(key, { type: 'json' }).catch(() => null);
      if (!q) continue;
      if (opts.brokerEmail && q.brokerEmail !== normalizeEmail(opts.brokerEmail)) continue;
      out.push(q);
    }
  } catch (e) {
    console.warn('[broker-quotes] list-all failed:', e && e.message);
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out.slice(0, limit);
}

/**
 * Drop the oldest quotes past the retention cap. Best-effort and fired
 * without awaiting from the price path — a slow trim must never delay a
 * broker's quote.
 */
export async function trimHistory(brokerEmail) {
  try {
    const store = _store();
    const { blobs } = await store.list({ prefix: bk(brokerEmail) + '/' });
    if (blobs.length <= KEEP_PER_BROKER) return 0;
    // Quote ids are base36 timestamps, so the key order is chronological.
    const sorted = blobs.map((b) => b.key).sort();
    const drop = sorted.slice(0, blobs.length - KEEP_PER_BROKER);
    for (const key of drop) await store.delete(key);
    return drop.length;
  } catch (e) {
    console.warn('[broker-quotes] trim failed:', e && e.message);
    return 0;
  }
}

/** Remove every quote for one broker — offboarding, and test cleanup. */
export async function purgeQuotes(brokerEmail) {
  let removed = 0;
  try {
    const store = _store();
    const { blobs } = await store.list({ prefix: bk(brokerEmail) + '/' });
    for (const { key } of blobs) { await store.delete(key); removed++; }
  } catch (e) {
    console.warn('[broker-quotes] purge failed:', e && e.message);
  }
  return removed;
}
