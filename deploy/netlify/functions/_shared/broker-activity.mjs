/**
 * _shared/broker-activity.mjs — Deploy 236.856 (Broker Portal, Phase 0)
 *
 * Every broker pricing call writes here. Two jobs:
 *
 *   1. Feed the Broker Desk (Phase 3) so an LO can see a partner working
 *      a deal while they're still working it.
 *   2. Detect enumeration — someone sweeping a grid to rebuild our
 *      pricing matrix.
 *
 * SESSIONS, NOT EVENTS
 * --------------------
 * A broker pricing twelve scenarios on one property over twenty minutes
 * is ONE row that updates with a scenario count, not twelve alerts. That
 * collapse is the difference between a desk LOs check and one they mute
 * in a week, so it lives in the storage layer rather than being left to
 * whatever renders it later.
 *
 * A session is (broker, property). It stays open while calls keep
 * arriving within SESSION_GAP_MS; a longer pause archives it and the next
 * call starts a fresh one.
 *
 * ENUMERATION DETECTION
 * ---------------------
 * Volume alone is a weak signal — a patient script stays under any rate
 * limit. SHAPE is the strong one. A human prices one property and varies
 * one or two knobs; a script sweeps a grid, so several inputs take many
 * distinct values inside a single session. We count distinct values per
 * field and flag a session once enough fields have gone wide. See
 * `suspicionOf` for the thresholds and why they're set where they are.
 *
 * Zero-throw by design: pricing must never 500 because an activity write
 * blipped. The caller gets its quote either way.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';

const STORE = 'broker_activity';

// A pause longer than this ends the session. 45 minutes: long enough that
// a broker who steps away from one property and comes back is still on
// the same row, short enough that tomorrow's work is a new one.
export const SESSION_GAP_MS = 45 * 60 * 1000;

// Inputs worth watching for a sweep. Deliberately the pricing knobs —
// not the property, not contact details.
const WATCHED = [
  'fico', 'fr', 'ltv', 'loanAmt', 'propValue', 'pp', 'arv', 'rb',
  'loanType', 'lt', 'propType', 'pt', 'term', 'loanPurpose', 'purp',
  'rent', 'isIO', 'prepay', 'buydown', 'exp', 'dscr', 'state',
];

// A field counts as "swept" once it has taken this many distinct values
// in one session. Four is comfortably above what a broker exploring a
// real deal does to any single input, and far below a grid sweep.
const WIDE_FIELD_VALUES = 4;
// This many swept fields at once is a grid, not a person.
const WIDE_FIELDS_FOR_SUSPICION = 3;

function _store() {
  return getStore({ name: STORE, consistency: 'strong' });
}

/** Group scenarios by property. No address is its own bucket — and an
 *  abstract sweep with no property is exactly what we want to notice. */
function addrKey(address) {
  const a = String(address || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return a ? a.slice(0, 60) : '_noaddress';
}

export function sessionKey(brokerEmail, address) {
  return 'sessions/' + keySafe(String(brokerEmail || '').toLowerCase()) + '/' + addrKey(address);
}

/**
 * How suspicious does this session look? Returns { suspect, wideFields,
 * reason } — recorded on the session so the Broker Desk can surface it
 * and an admin can act. Phase 0 records; Phase 3 alerts.
 */
export function suspicionOf(session) {
  const variance = (session && session.fieldValues) || {};
  const wide = Object.keys(variance).filter((f) => (variance[f] || []).length >= WIDE_FIELD_VALUES);
  const noAddress = !session || session.addrKey === '_noaddress';
  // No property at all is itself a signal: real pricing is about a house.
  const suspect = wide.length >= WIDE_FIELDS_FOR_SUSPICION || (noAddress && wide.length >= 2);
  let reason = '';
  if (suspect) {
    reason = wide.length + ' pricing inputs swept in one session'
      + (noAddress ? ', with no property attached' : ' on a single property');
  }
  return { suspect, wideFields: wide, reason };
}

/**
 * Record one pricing call. Returns the updated session (with suspicion),
 * or null if storage was unavailable.
 *
 * @param {object} ev
 *   brokerEmail, ownerKey, address, program, inputs, quoteId,
 *   summary { rate, points, loanAmount }, ip, ua
 */
export async function recordPricing(ev) {
  if (!ev || !ev.brokerEmail) return null;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const key = sessionKey(ev.brokerEmail, ev.address);

  try {
    const store = _store();
    let s = await store.get(key, { type: 'json' }).catch(() => null);

    // Archive and restart when the gap is long enough to be a new sitting.
    if (s && s.lastAtMs && (now - s.lastAtMs) > SESSION_GAP_MS) {
      try {
        await store.setJSON('archive/' + keySafe(ev.brokerEmail) + '/' + s.startedAtMs + '_' + s.addrKey, s);
      } catch (_) { /* archiving is best-effort */ }
      s = null;
    }

    if (!s) {
      s = {
        brokerEmail:  String(ev.brokerEmail).toLowerCase(),
        ownerKey:     ev.ownerKey || '',
        address:      ev.address || '',
        addrKey:      addrKey(ev.address),
        program:      ev.program || '',
        startedAtMs:  now,
        startedAt:    nowIso,
        scenarios:    0,
        fieldValues:  {},
        quoteIds:     [],
      };
    }

    s.scenarios += 1;
    s.lastAtMs = now;
    s.lastAt   = nowIso;
    s.program  = ev.program || s.program;
    if (ev.ip) s.lastIp = ev.ip;
    if (ev.ua) s.lastUa = String(ev.ua).slice(0, 200);
    if (ev.summary) s.lastResult = ev.summary;
    if (ev.quoteId) {
      s.quoteIds.push(ev.quoteId);
      // Keep the tail — a long session shouldn't grow the blob without bound.
      if (s.quoteIds.length > 200) s.quoteIds = s.quoteIds.slice(-200);
    }

    // Distinct values per watched field. Capped so a genuine sweep can't
    // inflate the record it's being caught by.
    const inputs = ev.inputs || {};
    for (const f of WATCHED) {
      const v = inputs[f];
      if (v === undefined || v === null || v === '') continue;
      const sv = String(v);
      const seen = s.fieldValues[f] || (s.fieldValues[f] = []);
      if (seen.indexOf(sv) < 0 && seen.length < 25) seen.push(sv);
    }

    const sus = suspicionOf(s);
    s.enumerationSuspected = sus.suspect;
    s.suspicionReason      = sus.reason;
    s.wideFieldCount       = sus.wideFields.length;

    await store.setJSON(key, s);
    return s;
  } catch (e) {
    console.warn('[broker-activity] record failed (non-fatal):', e && e.message);
    return null;
  }
}

/**
 * Open sessions, newest first. Phase 3's Broker Desk reads this; exported
 * now so the shape is settled before anything renders it.
 */
export async function listSessions(opts) {
  opts = opts || {};
  const limit = Math.max(1, Math.min(500, opts.limit || 100));
  const out = [];
  try {
    const store = _store();
    const { blobs } = await store.list({ prefix: 'sessions/' });
    for (const { key } of blobs) {
      const s = await store.get(key, { type: 'json' }).catch(() => null);
      if (!s) continue;
      if (opts.brokerEmail && s.brokerEmail !== String(opts.brokerEmail).toLowerCase()) continue;
      if (opts.ownerKey && s.ownerKey !== opts.ownerKey) continue;
      out.push(s);
    }
  } catch (e) {
    console.warn('[broker-activity] list failed:', e && e.message);
  }
  out.sort((a, b) => (b.lastAtMs || 0) - (a.lastAtMs || 0));
  return out.slice(0, limit);
}
