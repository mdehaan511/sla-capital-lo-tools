/**
 * _shared/sla-rep.mjs — Deploy 236.870
 *
 * "Your Sir Lends A Lot Rep" — the person at SLA who owns a broker
 * relationship. Resolves an internal email to the name and phone a
 * BROKER may see.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * The rep is about to matter in three places — the box on the broker
 * sizer, the "who invited you" picker on registration, and the routing of
 * a submitted deal — and each of those is a different audience. The
 * internal /api/users-directory returns every staff member with email,
 * phone and roles; handing that to a broker leaks the whole team roster.
 * Everything here returns only what an external partner should see.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { createHash } from 'node:crypto';

/**
 * A genuinely opaque id for a staff member. Deploy 236.874.
 *
 * The first version used keySafe(email) — and keySafe PASSES EMAILS
 * THROUGH UNCHANGED (owner keys in this codebase are raw emails). So the
 * "names and opaque ids only" picker was shipping all 14 staff addresses
 * to anyone holding an invite link. Caught in live testing.
 *
 * A truncated SHA-256 is not reversible. Someone could hash an address
 * they already suspect and compare — but knowing the address is the thing
 * we were protecting, so that confirms nothing they didn't have.
 */
export function repId(email) {
  return createHash('sha256').update(normalizeEmail(email || '')).digest('hex').slice(0, 24);
}

// Who can be a broker's rep. Deliberately the client-facing tiers: a
// broker is invited by a loan officer or an admin, not by a processor
// who never speaks to them.
const REP_ROLES = ['admin', 'super_admin', 'senior_lo', 'loan_officer', 'user'];

function _profiles() {
  return getStore({ name: 'profiles', consistency: 'eventual' });
}

function nameOf(p) {
  if (!p) return '';
  const meta = p.user_metadata || {};
  return String(p.fullName || p.full_name || meta.full_name || meta.fullName || '').trim();
}

function phoneOf(p) {
  if (!p) return '';
  const meta = p.user_metadata || {};
  return String(p.phone || meta.phone || '').trim();
}

function rolesOf(p) {
  if (!p) return [];
  if (Array.isArray(p.roles)) return p.roles;
  if (p.app_metadata && Array.isArray(p.app_metadata.roles)) return p.app_metadata.roles;
  return [];
}

/**
 * One rep, broker-safe. Email IS included here — a broker needs to be able
 * to reach their own rep — but only ever for THEIR rep, never as a list.
 *
 * Returns null when there's no profile, so callers can fall back to
 * something generic rather than printing a blank name.
 */
export async function getRep(email) {
  const e = normalizeEmail(email || '');
  if (!e) return null;
  try {
    const p = await _profiles().get(keySafe(e), { type: 'json' });
    if (!p) return { email: e, name: '', phone: '' };
    return { email: e, name: nameOf(p), phone: phoneOf(p) };
  } catch (err) {
    console.warn('[sla-rep] lookup failed for ' + e + ':', err && err.message);
    return { email: e, name: '', phone: '' };
  }
}

/**
 * The pick-list for "who at SLA invited you?" on registration.
 *
 * NAMES AND OPAQUE IDS ONLY — no emails, no phones, no roles. A broker
 * picking their rep needs to recognise a name; they do not need the team's
 * contact sheet, and this endpoint is reachable by anyone mid-signup.
 */
export async function listRepsPublic() {
  const out = [];
  try {
    const store = _profiles();
    const { blobs } = await store.list();
    // Deploy 236.875 — READ IN PARALLEL. The sequential version took 41s
    // against the live profiles store (one network round-trip per blob,
    // and that store holds every account that has ever signed in, not
    // just staff), which made the signup page look broken. Mirrors the
    // Promise.all in users-directory.mjs.
    const profiles = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null))
    );
    for (const p of profiles) {
      if (!p || !p.email) continue;
      const roles = rolesOf(p).map((r) => String(r).toLowerCase());
      // A profile with no roles at all is a legacy/seeded record; treat it
      // as staff, since every real SLA login lands in this store.
      const eligible = !roles.length || roles.some((r) => REP_ROLES.includes(r));
      if (!eligible) continue;
      const name = nameOf(p);
      if (!name) continue; // don't offer a nameless option
      out.push({ id: repId(p.email), name });
    }
  } catch (err) {
    console.warn('[sla-rep] list failed:', err && err.message);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Resolve an opaque rep id from listRepsPublic back to an email. */
export async function repEmailFromId(id) {
  const want = String(id || '').trim();
  if (!want) return '';
  try {
    const store = _profiles();
    const { blobs } = await store.list();
    const profiles = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null))
    );
    for (const p of profiles) {
      if (!p || !p.email) continue;
      if (repId(p.email) === want) return normalizeEmail(p.email);
    }
  } catch (err) {
    console.warn('[sla-rep] id resolve failed:', err && err.message);
  }
  return '';
}
