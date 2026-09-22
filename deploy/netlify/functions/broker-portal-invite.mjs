/**
 * broker-portal-invite.mjs -- /api/broker-portal-invite
 *
 * Deploy 237.236 (Mike: "For brokers instead of invite to borrower portal it should be
 * invite to broker portal. In fact we need to completely diverge the borrowers and brokers.")
 * Deploy 237.241 -- the invite itself moved to _shared/broker-portal-invite-core.mjs so the
 * application form (prospects-save) sends the same one automatically. This file is the
 * staff-facing door: auth, owner, resolving the record, and the GET status.
 *
 *   POST { loanId, primaryClientId, owner? }      invite the broker ON a loan
 *   POST { brokerClientId, owner? }               invite a broker from their Broker Book page
 *   GET  ?brokerClientId=&owner=                  portal status for a broker record
 *
 * Auth: staff (never a borrower or broker login). A plain LO acts in their own book; a
 * processor or admin may pass `owner` (canOverrideOwner). Never sends to an address the
 * caller typed: the recipient is always what the record says.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { isBrokerRole, canOverrideOwner } from './_shared/access.mjs';
import { getPartner, markPortalInvite } from './_shared/broker-partners.mjs';
import { getSb, findUserIdByEmail, lastSignInByUserId } from './_shared/borrower-invite-core.mjs';
import { inviteBrokerToPortal, brokerFieldsOf } from './_shared/broker-portal-invite-core.mjs';

function _rolesOf(user) {
  const am = (user && user.app_metadata) || {};
  const r = Array.isArray(am.roles) ? am.roles : (am.role ? [am.role] : []);
  return r.map((x) => String(x).toLowerCase());
}
// Staff = anyone whose login is not a borrower's or a broker's.
function _isStaff(user) {
  if (!user || isBrokerRole(user)) return false;
  const roles = _rolesOf(user);
  return !(roles.length > 0 && roles.every((r) => r === 'borrower' || r === 'viewer'));
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-portal-invite error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST' && req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!_isStaff(user)) return json(403, { error: 'Staff only' });

  const selfEmail = normalizeEmail(user.email);
  const isGet = req.method === 'GET';
  const q = isGet ? new URL(req.url).searchParams : null;
  const body = isGet ? {} : ((await readJsonBody(req)) || {});
  const ownerParam = isGet ? (q.get('owner') || '') : (body.owner || '');

  // Owner: a plain LO always works in their own book; processors + admins may name one.
  let ownerEmail = selfEmail;
  if (ownerParam && normalizeEmail(ownerParam) !== selfEmail) {
    if (!canOverrideOwner(user).ok) {
      return json(403, { error: 'Only the loan officer who owns this loan, a processor, or an admin can invite its broker.' });
    }
    ownerEmail = normalizeEmail(ownerParam);
  }
  const ownerKey = keySafe(ownerEmail);
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── resolve the broker ────────────────────────────────────────────────────
  let loan = null, client = null, brokerClient = null;
  const brokerClientId = String((isGet ? q.get('brokerClientId') : body.brokerClientId) || '').trim();
  const loanId = String((isGet ? q.get('loanId') : body.loanId) || '').trim();
  const primaryClientId = String((isGet ? q.get('primaryClientId') : body.primaryClientId) || '').trim();

  if (brokerClientId) {
    brokerClient = await clientsStore.get(ownerKey + '/' + keySafe(brokerClientId), { type: 'json' }).catch(() => null);
    if (!brokerClient) return json(404, { error: 'Broker not found in this book' });
    if (!brokerClient._isBroker) {
      return json(400, { error: 'This is a borrower record, not a broker. Brokers are invited from the Broker Book, or from a loan they are the broker on.' });
    }
  } else if (loanId && primaryClientId) {
    client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' }).catch(() => null);
    loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
    if (!loan) return json(404, { error: 'Loan not found' });
  } else {
    return json(400, { error: 'brokerClientId, or loanId + primaryClientId, required' });
  }

  // ── GET: status ───────────────────────────────────────────────────────────
  if (isGet) {
    const email = normalizeEmail(brokerFieldsOf(loan, brokerClient).email || '');
    if (!email || email.indexOf('@') < 0) {
      return json(400, { error: loan ? 'No broker email on this loan. Add it in Broker Info first.' : 'This broker has no email on file. Add one first.' });
    }
    const partner = await getPartner(email);
    if (!partner) return json(200, { invited: false, email, hasPartner: false });
    const pi = partner.portalInvite || null;
    const sb = getSb();
    let userId = (pi && pi.userId) || '';
    // A claimed login has no stored user id (broker-claim minted it); look it up once and
    // keep it, so the "last login" line never pages the user list again.
    if (!userId && partner.inviteAcceptedAt && sb) {
      userId = await findUserIdByEmail(sb, email).catch(() => '');
      if (userId) { try { await markPortalInvite(email, { userId }); } catch (_) {} }
    }
    let lastSignInAt = '';
    if (userId && sb) { try { lastSignInAt = await lastSignInByUserId(sb, userId); } catch (_) {} }
    return json(200, {
      invited: !!pi, email, hasPartner: true, status: partner.status,
      mode: (pi && pi.mode) || '', via: (pi && pi.via) || '', sentAt: (pi && pi.at) || '', sentBy: (pi && pi.by) || '',
      emailed: pi ? pi.emailed !== false : false,
      claimedAt: partner.inviteAcceptedAt || '',
      hasLogin: !!userId || !!partner.inviteAcceptedAt,
      lastSignInAt: lastSignInAt || '',
    });
  }

  // ── POST: the invite (shared with the application form) ──────────────────
  const r = await inviteBrokerToPortal({
    ownerKey, loan, client, brokerClient, actorEmail: selfEmail, clientsStore,
    origin: new URL(req.url).origin, via: 'lo',
  });
  if (!r.ok) return json(r.status || 500, { error: r.error || 'Invite failed' });
  return json(200, r);
}
