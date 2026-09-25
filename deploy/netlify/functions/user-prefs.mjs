/**
 * user-prefs.mjs — GET / POST /api/user-prefs
 *
 * Deploy 237.271 (Mike): "Make it so that they can toggle on or off other processors loans
 * too if they like so they can see coworkers key dates. If they toggle anything on or off
 * save it so it doesnt default to just them every time."
 *
 * One small record per person (store `user-prefs`, key = their email), shared by every
 * device they sign in on — which is why this is not localStorage. Only the calendar lives
 * here today:
 *
 *   { calendar: { home: { people: [emails] | 'all', types: { closing, inspection, rate_lock } },
 *                 desk: { ... } } }
 *
 * GET  → { prefs }
 * POST { calendar: { <surface>: { people?, types? } } } → merged per surface → { ok, prefs }
 * Anyone signed in; always their own record (no owner override exists or is needed).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';

const SURFACES = { home: 1, desk: 1 };
const TYPES = ['closing', 'inspection', 'rate_lock'];

/** Clean one surface's calendar prefs. Pure. */
export function cleanCalendar(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  if (v.people === 'all') out.people = 'all';
  else if (Array.isArray(v.people)) {
    out.people = v.people.map((e) => normalizeEmail(String(e || ''))).filter((e) => e && e.indexOf('@') > 0).slice(0, 40)
      .filter((e, i, a) => a.indexOf(e) === i);
  }
  if (v.types && typeof v.types === 'object') {
    out.types = {};
    TYPES.forEach((t) => { if (typeof v.types[t] === 'boolean') out.types[t] = v.types[t]; });
  }
  return out;
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('user-prefs error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const self = normalizeEmail(user.email || '');
  if (!self) return json(400, { error: 'No email in token' });
  const store = getStore({ name: 'user-prefs', consistency: 'strong' });
  const key = keySafe(self);
  const cur = (await store.get(key, { type: 'json' }).catch(() => null)) || {};

  if (req.method === 'GET') return json(200, { prefs: cur });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = (await readJsonBody(req)) || {};
  const next = Object.assign({}, cur);
  if (body.calendar && typeof body.calendar === 'object') {
    next.calendar = Object.assign({}, cur.calendar || {});
    Object.keys(body.calendar).forEach((s) => {
      if (!SURFACES[s]) return;
      next.calendar[s] = Object.assign({}, next.calendar[s] || {}, cleanCalendar(body.calendar[s]));
    });
  }
  next.updatedAt = new Date().toISOString();
  await store.setJSON(key, next);
  return json(200, { ok: true, prefs: next });
}
