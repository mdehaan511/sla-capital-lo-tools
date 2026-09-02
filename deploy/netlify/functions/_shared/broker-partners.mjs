/**
 * _shared/broker-partners.mjs — Deploy 236.859 (Broker Portal, Phase 1)
 *
 * The Preferred Partner record: who is allowed into the broker portal,
 * what they may price, and who at SLA owns the relationship.
 *
 * DELIBERATELY SEPARATE FROM THE BROKER CLIENT RECORD
 * ---------------------------------------------------
 * There are already 117 broker-flagged `clients` (`_isBroker: true`) owned
 * by 6 LOs. Those are CRM records — a name and a phone number on a deal.
 * A partner record is an ACCESS record: a login, a status, a permission
 * set. Conflating them would mean every broker we've ever written on a
 * loan is implicitly a portal user, which is not the same thing at all.
 *
 * The two are linked by `clientId`, and a partner is created FROM an
 * existing broker client wherever one matches on email — so approving
 * someone doesn't fork their history into a second record. (Same trap
 * the borrower portal hit; see project_borrower_guarantor_linkage.)
 *
 * STATUS IS THE GATE
 * ------------------
 *   pending    applied or invited, cannot price
 *   approved   can sign in and price, within `programs` and `feeCapPoints`
 *   suspended  login survives, pricing is refused — the kill switch
 *
 * Suspension deliberately does NOT delete the record or the login: we want
 * the history, and a suspended partner who calls their LO should be
 * recoverable with one click rather than a re-registration.
 *
 * Zero-throw on reads. Writes throw, so a caller can report a real failure
 * (strict-write discipline).
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE = 'broker_partners';

export const PARTNER_STATUSES = ['pending', 'approved', 'suspended'];

// Which sizers a partner may price against. Defaults to the two mature
// programs; GUC and MF are opt-in per partner until Mike says otherwise
// (an open decision in the spec — the field is here so the answer is a
// data change, not a code change).
export const ALL_PROGRAMS = ['dscr', 'rtl', 'guc', 'mf'];
export const DEFAULT_PROGRAMS = ['dscr', 'rtl'];

function _store() {
  return getStore({ name: STORE, consistency: 'strong' });
}

export function partnerKey(email) {
  return keySafe(normalizeEmail(email || ''));
}

function _token() {
  // 32 hex chars of randomness. Only used to claim an invite, and only
  // valid while the record says pending, so it is a one-shot claim check
  // rather than a bearer credential.
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.random().toString(16).slice(2, 10);
  return s.slice(0, 32);
}

/** One partner, or null. Never throws. */
export async function getPartner(email) {
  const e = normalizeEmail(email || '');
  if (!e) return null;
  try {
    return await _store().get(partnerKey(e), { type: 'json' });
  } catch (err) {
    console.warn('[broker-partners] read failed for ' + e + ':', err && err.message);
    return null;
  }
}

/** Every partner record. Never throws; returns [] on failure. */
export async function listPartners() {
  const out = [];
  try {
    const store = _store();
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const p = await store.get(key, { type: 'json' }).catch(() => null);
      if (p && p.email) out.push(p);
    }
  } catch (err) {
    console.warn('[broker-partners] list failed:', err && err.message);
  }
  out.sort((a, b) => String(a.company || a.lastName || a.email).localeCompare(String(b.company || b.lastName || b.email)));
  return out;
}

/**
 * Create or update a partner. Throws on write failure.
 *
 * Only the fields present in `patch` are changed, so a status flip can't
 * accidentally blank a fee cap set on another screen.
 */
export async function savePartner(email, patch, actorEmail) {
  const e = normalizeEmail(email || '');
  if (!e || !e.includes('@')) throw new Error('A valid email is required');
  const now = new Date().toISOString();
  const store = _store();
  const key = partnerKey(e);

  const existing = await store.get(key, { type: 'json' }).catch(() => null);
  const rec = existing || {
    email: e,
    status: 'pending',
    clientId: '',
    ownerKey: '',
    company: '', firstName: '', lastName: '', phone: '', nmls: '',
    programs: DEFAULT_PROGRAMS.slice(),
    feeCapPoints: null,
    notes: '',
    appliedAt: now,
    createdAt: now,
    createdBy: actorEmail || '',
  };

  const ASSIGNABLE = ['clientId', 'ownerKey', 'company', 'firstName', 'lastName',
    'phone', 'nmls', 'notes', 'feeCapPoints'];
  for (const f of ASSIGNABLE) {
    if (patch[f] !== undefined) rec[f] = patch[f];
  }

  if (patch.programs !== undefined) {
    const want = Array.isArray(patch.programs) ? patch.programs : [];
    rec.programs = want.filter((p) => ALL_PROGRAMS.includes(p));
  }

  if (patch.status !== undefined) {
    if (!PARTNER_STATUSES.includes(patch.status)) {
      throw new Error('status must be one of: ' + PARTNER_STATUSES.join(', '));
    }
    if (rec.status !== patch.status) {
      rec.status = patch.status;
      if (patch.status === 'approved') {
        rec.approvedAt = now; rec.approvedBy = actorEmail || '';
        rec.suspendedAt = null; rec.suspendedBy = null;
      } else if (patch.status === 'suspended') {
        rec.suspendedAt = now; rec.suspendedBy = actorEmail || '';
      }
    }
  }

  rec.updatedAt = now;
  rec.updatedBy = actorEmail || '';
  await store.setJSON(key, rec);
  return rec;
}

/**
 * Mint an invite token so a partner can claim a login.
 *
 * Phase 1 does NOT email it — the admin copies the link and sends it
 * however they like. That keeps a half-built portal from mailing 117
 * brokers, and it matches the "Generate Link" option the eSign flow
 * already offers.
 */
export async function mintInvite(email, actorEmail) {
  const rec = await getPartner(email);
  if (!rec) throw new Error('No partner record for ' + email);
  const now = new Date().toISOString();
  rec.inviteToken = _token();
  rec.inviteCreatedAt = now;
  rec.inviteCreatedBy = actorEmail || '';
  rec.inviteAcceptedAt = null;
  rec.updatedAt = now;
  await _store().setJSON(partnerKey(email), rec);
  return rec;
}

/** Delete a partner record outright. Used for mistakes, not for offboarding
 *  (that's `suspended`, which keeps the history). */
export async function deletePartner(email) {
  await _store().delete(partnerKey(email));
}

/**
 * THE gate the broker-facing endpoints ask. One place, so widening access
 * later is a change here rather than in every endpoint.
 *
 * @returns {{ok:boolean, reason?:string, partner?:object}}
 */
export async function checkPartnerAccess(email, program) {
  const rec = await getPartner(email);
  if (!rec) return { ok: false, reason: 'No partner record' };
  if (rec.status === 'pending')   return { ok: false, reason: 'Partner application is still pending approval' };
  if (rec.status === 'suspended') return { ok: false, reason: 'Partner access is suspended' };
  if (rec.status !== 'approved')  return { ok: false, reason: 'Partner is not approved' };
  if (program && Array.isArray(rec.programs) && !rec.programs.includes(program)) {
    return { ok: false, reason: 'Not approved for this program', partner: rec };
  }
  return { ok: true, partner: rec };
}
