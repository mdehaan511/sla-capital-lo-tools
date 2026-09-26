/**
 * broker-one-pager.mjs — GET /api/broker-one-pager  (any signed-in staff user)
 *
 * Deploy 237.181 (Mike) — the broker product sheet, personalized to whoever
 * downloads it: "Your Loan Officer is {name}!" across the top, their email and
 * phone in the footer, and a QR that opens THEIR apply link so a borrower who
 * scans it lands in their pipeline.
 *
 * The profile is read BY KEY (never a store walk — see the profiles-store note:
 * a full scan takes ~40 seconds). Anything missing falls back to the company
 * contact, so the sheet always renders and is always sendable.
 *
 * ?generic=1 returns the unpersonalized company copy.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, keySafe, normalizeEmail, getRoles } from './_shared/auth.mjs';
import { buildBrokerOnePager } from './_shared/broker-one-pager.mjs';

const SITE = 'https://slacapital.ai';

/**
 * Deploy 237.284 (Sara: "the broker pdf is not personalizing the phone number")
 * -- the rep's phone, from wherever this user's record actually carries it.
 *
 * 237.181 read only the top-level `profile.phone`, but that field is only
 * written by profile-update / the admin editor (promoted in 236.578). The
 * identity mirror (profile-record.mjs, every login) copies the phone into
 * `profile.user_metadata.phone` and never top-level, and records saved before
 * the promotion only ever had it there -- so for those reps the sheet fell back
 * to the company line. termsheet, rate-sheet, users-directory and sla-rep all
 * already read user_metadata.phone; this matches them, then falls back to the
 * phone on the signed-in token itself.
 */
function repPhone(profile, user) {
  const p = profile || {};
  const pm = p.user_metadata || {};
  const um = (user && user.user_metadata) || {};
  return String(p.phone || pm.phone || p.phoneNumber || um.phone || '').trim();
}

/** Borrowers never get the staff handout; everyone else does. */
function canDownload(user) {
  const roles = getRoles(user);
  return !(roles.length === 1 && roles[0] === 'borrower');
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!canDownload(user)) return json(403, { error: 'Staff only' });

    const url = new URL(req.url);
    const generic = url.searchParams.get('generic') === '1';

    let rep = {};
    if (!generic) {
      const email = normalizeEmail(user.email || '');
      let profile = null;
      try {
        // Deploy 237.284 -- strong: one keyed read, and the usual sequence is
        // "add my phone on Profile, then download", which eventual can miss.
        const store = getStore({ name: 'profiles', consistency: 'strong' });
        profile = await store.get(keySafe(email), { type: 'json' });
      } catch (e) {
        console.warn('[broker-one-pager] profile read failed (non-fatal):', e && e.message);
      }
      const name = String((profile && (profile.fullName || profile.name)) || user.user_metadata?.full_name || user.name || '').trim();
      rep = {
        name,
        email,
        phone: repPhone(profile, user),
        // The rep short link (slacapital.ai/a/jeremy), which redirects to
        // /apply/?lo=<email>. Short enough to text, and low-density as a QR --
        // the full query-string form pushed the code to a version that phone
        // cameras struggle with at this size.
        applyUrl: email ? SITE + '/a/' + encodeURIComponent(email.split('@')[0]) : '',
      };
    }

    const bytes = await buildBrokerOnePager(rep);
    const slug = String(rep.name || 'SLA Capital').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename = 'SLA-Capital-Product-Guide' + (rep.name ? '-' + slug : '') + '.pdf';
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        // Personalized per user: never let a shared cache serve one rep's copy
        // to another.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    console.error('broker-one-pager error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
