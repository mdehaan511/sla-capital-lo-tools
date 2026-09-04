/**
 * broker-quotes-list.mjs — GET /api/broker-quotes
 *
 * Deploy 236.870. Every quote a broker has run.
 *
 *   a PARTNER gets their own history and nothing else
 *   an ADMIN gets every partner's, or one partner's with ?broker=<email>
 *
 * Scoping is by the CALLER's identity, never by a query parameter, so
 * there is no shape of this request that hands one broker another's book.
 *
 * ?limit=n  (default 100, max 500)
 * ?id=<quoteId>  one quote, for reloading a scenario back into the sizer
 */
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail,
} from './_shared/auth.mjs';
import { isBrokerRole } from './_shared/access.mjs';
import { checkPartnerAccess } from './_shared/broker-partners.mjs';
import { listQuotes, listAllQuotes, getQuote } from './_shared/broker-quotes.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-quotes-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  let url; try { url = new URL(req.url); } catch (_) { url = { searchParams: new Map() }; }
  const get = (k) => (url.searchParams.get ? url.searchParams.get(k) : '') || '';
  const limit = Math.max(1, Math.min(500, parseInt(get('limit'), 10) || 100));
  const id = get('id');

  const me = normalizeEmail(user.email || '');
  const admin = isAdmin(user);

  // ── Admin ───────────────────────────────────────────────────────
  if (admin) {
    const asBroker = normalizeEmail(get('broker'));
    if (id && asBroker) {
      const q = await getQuote(asBroker, id);
      return q ? json(200, { ok: true, quote: q }) : json(404, { error: 'Quote not found' });
    }
    const quotes = asBroker
      ? await listQuotes(asBroker, { limit })
      : await listAllQuotes({ limit });
    return json(200, { ok: true, scope: asBroker || 'all', quotes });
  }

  // ── Partner ─────────────────────────────────────────────────────
  if (!isBrokerRole(user)) return json(403, { error: 'Not a Preferred Partner account.' });
  const access = await checkPartnerAccess(me);
  if (!access.ok) return json(403, { error: access.reason, code: 'partner_not_approved' });

  if (id) {
    const q = await getQuote(me, id);
    return q ? json(200, { ok: true, quote: q }) : json(404, { error: 'Quote not found' });
  }
  return json(200, { ok: true, scope: me, quotes: await listQuotes(me, { limit }) });
}
