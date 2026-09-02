/**
 * broker-partners-list.mjs — GET /api/broker-partners
 *
 * Deploy 236.859 — Broker Portal, Phase 1. Everything the Preferred
 * Partner desk needs in one call:
 *
 *   partners[]      the access records (status, programs, fee cap, owner)
 *   candidates[]    broker-flagged CLIENTS with no partner record yet —
 *                   the 117 brokers already in the book, so onboarding is
 *                   "promote this one" rather than retyping their details
 *   sessions[]      live pricing activity from Phase 0, joined by email
 *
 * The join matters: a desk that lists partners without showing what
 * they're pricing is an admin table, not a sales tool. This is the first
 * place the Phase 0 activity data actually surfaces.
 *
 * ADMIN ONLY.
 */
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail,
} from './_shared/auth.mjs';
import { listPartners } from './_shared/broker-partners.mjs';
import { listSessions } from './_shared/broker-activity.mjs';
import { db } from './_shared/supabase-db.mjs';

// Same projection brokers-list uses — broker-flagged clients live in
// Postgres since 236.387 (walking 2,800 blobs timed the function out).
const BROKER_SELECT = 'id,owner_email,first_name,last_name,email,phone,entity_name,is_broker';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-partners-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const partners = await listPartners();
  const byEmail = new Set(partners.map((p) => p.email));

  // Broker clients that aren't partners yet.
  let candidates = [];
  try {
    const rows = await db.select('clients', {
      select: BROKER_SELECT,
      eq: { is_broker: true },
      limit: 1000,
    });
    candidates = (rows || [])
      .filter((c) => c && c.email && !byEmail.has(normalizeEmail(c.email)))
      .map((c) => ({
        clientId:  c.id,
        email:     normalizeEmail(c.email),
        firstName: c.first_name || '',
        lastName:  c.last_name  || '',
        company:   c.entity_name || '',
        phone:     c.phone || '',
        ownerKey:  c.owner_email || '',
      }));
    // De-dupe: the same broker can exist under several LOs (that's the
    // 117 count). One row per email; keep the first owner we saw.
    const seen = new Set();
    candidates = candidates.filter((c) => {
      if (seen.has(c.email)) return false;
      seen.add(c.email); return true;
    });
    candidates.sort((a, b) =>
      String(a.company || a.lastName || a.email).localeCompare(String(b.company || b.lastName || b.email)));
  } catch (e) {
    console.warn('broker-partners-list: candidate lookup failed (non-fatal):', e && e.message);
  }

  // Pricing activity, newest first, joined onto partners by email.
  let sessions = [];
  try {
    sessions = await listSessions({ limit: 200 });
  } catch (e) {
    console.warn('broker-partners-list: activity lookup failed (non-fatal):', e && e.message);
  }
  const activityByEmail = {};
  for (const s of sessions) {
    const e = String(s.brokerEmail || '').toLowerCase();
    if (!activityByEmail[e]) activityByEmail[e] = { sessions: 0, scenarios: 0, lastAt: null, suspect: false };
    const a = activityByEmail[e];
    a.sessions += 1;
    a.scenarios += (s.scenarios || 0);
    if (!a.lastAt || (s.lastAtMs || 0) > (a.lastAtMs || 0)) { a.lastAt = s.lastAt; a.lastAtMs = s.lastAtMs; }
    if (s.enumerationSuspected) a.suspect = true;
  }

  return json(200, {
    ok: true,
    partners: partners.map((p) => Object.assign({}, p, {
      activity: activityByEmail[p.email] || null,
    })),
    candidates,
    sessions,
    counts: {
      partners:  partners.length,
      approved:  partners.filter((p) => p.status === 'approved').length,
      pending:   partners.filter((p) => p.status === 'pending').length,
      suspended: partners.filter((p) => p.status === 'suspended').length,
      candidates: candidates.length,
    },
  });
}
