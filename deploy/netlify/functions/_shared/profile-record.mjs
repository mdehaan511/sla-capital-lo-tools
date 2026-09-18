/**
 * _shared/profile-record.mjs — Deploy 237.153 (Chance: "Camelot asks me for my
 * birthday every time I log in — I have input it already")
 *
 * THE BUG: three places mirror a user's identity into the `profiles` blob —
 * identity-login.mjs (every login), identity-signup.mjs (first signup) and
 * profile-ping.mjs (every page load). The two identity-event handlers built a
 * fresh object and called setJSON() with NO merge, so every login threw away
 * every field the APP owns on that same record:
 *
 *   birthday, birthYear  — the login prompt asks again, forever (reported)
 *   startDate            — the work anniversary, incl. Dan's seeded dates
 *   avatar               — the chosen Armory character
 *   phone                — promoted for users-directory + proof-of-funds
 *
 * The seed that filled the start dates is a one-shot (marker in the armory
 * store), so a wiped start date never came back on its own.
 *
 * THE RULE: the identity provider owns identity fields; everything else on the
 * record belongs to the app and must survive. An identity field is also never
 * allowed to overwrite a good stored value with a blank or a default — a login
 * payload with no name must not erase the name, and one with no roles must not
 * downgrade the stored roles to ['user'].
 *
 * Every writer that mirrors identity into `profiles` must go through here.
 */
import { normalizeEmail } from './auth.mjs';

/** Fields the APP writes to a profile record. Never sourced from identity. */
export const APP_OWNED_PROFILE_FIELDS = ['birthday', 'birthYear', 'startDate', 'avatar', 'phone'];

/** The display name an identity payload carries, or '' when it carries none. */
export function nameFromIdentity(meta) {
  const m = meta || {};
  return String(
    m.full_name || m.fullName || m.name ||
    ((m.firstName || '') + ' ' + (m.lastName || '')).trim() || ''
  ).trim();
}

/**
 * Merge an identity payload onto the stored profile record.
 *
 * existing — what's in the blob today (null for a brand-new record)
 * u        — the identity user (Netlify event payload, or a decoded token)
 * opts.lastSeen — false to leave last_seen_at alone (signup: never seen yet)
 */
export function mergeIdentityProfile(existing, u, opts) {
  const o = opts || {};
  const user = u || {};
  const meta = user.user_metadata || {};
  const app = user.app_metadata || {};
  const prev = (existing && typeof existing === 'object') ? existing : {};

  // Start from the stored record: app-owned fields survive by construction.
  const out = Object.assign({}, prev);

  out.email = normalizeEmail(user.email || prev.email || '');

  const id = user.id || user.sub || '';
  if (id) out.id = id;
  else if (out.id === undefined) out.id = null;

  // A blank name from identity must not erase a name the user set on Profile.
  const fullName = nameFromIdentity(meta);
  if (fullName) out.fullName = fullName;
  else if (typeof out.fullName !== 'string') out.fullName = '';

  // Same for roles: only take them when the payload actually carried some.
  const rolesIn = Array.isArray(app.roles) ? app.roles : (app.roles ? [app.roles] : []);
  if (rolesIn.length) out.roles = rolesIn;
  else if (!Array.isArray(prev.roles) || !prev.roles.length) out.roles = ['user'];

  if (user.confirmed_at) out.confirmed_at = user.confirmed_at;
  else if (out.confirmed_at === undefined) out.confirmed_at = null;

  // created_at is the fallback work anniversary (Deploy 237.088), so the FIRST
  // value we ever recorded wins — a later login must not move someone's date.
  out.created_at = prev.created_at || user.created_at || new Date().toISOString();

  // Identity wins per key, but keys only the app set (phone via profile-update)
  // are kept rather than dropped.
  out.user_metadata = Object.assign({}, prev.user_metadata || {}, meta);

  out.last_seen_at = o.lastSeen === false
    ? (prev.last_seen_at || null)
    : new Date().toISOString();

  return out;
}
