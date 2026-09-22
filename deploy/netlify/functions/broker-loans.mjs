/**
 * broker-loans.mjs — GET /api/broker-loans
 *
 * Deploy 237.234 (Mike) — the Preferred Partner portal's home: "see their loans that
 * are in processing with borrowers ... a list of their quoted loans with the terms being
 * negotiated ... by clicking on one of the loans they have in processing it should go to a
 * version of that borrower's page that is for that broker."
 *
 * WHICH LOANS. A loan is the broker's when its `brokerId` points at a broker CLIENT record
 * (the `_isBroker` client an LO keeps in their book — 117 of them across 6 LOs, and one
 * broker can be a separate record under several LOs). So: every broker client record whose
 * email is the partner's, plus the partner record's own `clientId`, and every loan in the
 * Postgres mirror whose `broker_id` is one of those. The full loan is then read from the
 * owning LO's client blob (the mirror's summary is not the record the page needs), and
 * only a borrower-safe projection leaves — the same `_sanitize` shape the borrower portal
 * sends, plus the borrower's name, the review's document counts and the loan's terms.
 *
 * Auth: a signed-in Preferred Partner (role `broker`, record approved — the sizer's own
 * gate), or an admin with `?as=<email>` to see a partner's list exactly as they do.
 *
 * Response: { ok, mode, email, rep, groups: { processing: [...], quoted: [...], closed: [...] } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { isBrokerRole } from './_shared/access.mjs';
import { getPartner, checkPartnerAccess } from './_shared/broker-partners.mjs';
import { getRep } from './_shared/sla-rep.mjs';
import { db } from './_shared/supabase-db.mjs';
import { _borrowerStage, _deriveSlaDisplayId } from './borrower-portal-loans.mjs';
import { listAccessibleLoans, grantLoanAccess, revokeLoanAccess } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-loans error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const me = normalizeEmail(user.email || '');

  let email = me, mode = 'partner';
  if (isAdmin(user)) {
    let as = '';
    try { as = normalizeEmail(new URL(req.url).searchParams.get('as') || ''); } catch (_) {}
    if (!as) return json(400, { error: 'Admins preview a partner with ?as=<email>.' });
    email = as; mode = 'admin-preview';
  } else {
    if (!isBrokerRole(user)) return json(403, { error: 'This account is not a Preferred Partner.' });
    const access = await checkPartnerAccess(me);
    if (!access.ok) return json(403, { error: access.reason, code: 'partner_not_approved' });
  }
  const partner = await getPartner(email);
  if (!partner) return json(404, { error: 'No partner record for ' + email });

  const brokerIds = await brokerClientIdsFor(email, partner);
  const loans = brokerIds.length ? await loansForBrokerIds(brokerIds) : [];

  const groups = { processing: [], quoted: [], closed: [] };
  for (const row of loans) groups[bucketOf(row)].push(row);
  // The borrower's document page and its endpoints authorize on a loan-access GRANT
  // (canReadLoan → hasLoanGrant), the same record an invited borrower holds. A partner
  // holds one, role 'broker', for each loan in processing that is theirs -- and loses it
  // the moment a loan stops being theirs (broker cleared, moved, closed), so a bookmarked
  // link stops working too. Idempotent; a real partner only, never the admin preview.
  if (mode === 'partner') await syncGrants(email, groups.processing);
  const byRecent = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  groups.processing.sort(byRecent); groups.quoted.sort(byRecent); groups.closed.sort(byRecent);

  const rep = partner.ownerKey ? await getRep(partner.ownerKey) : null;
  // Deploy 237.235 -- the same broker can sit in several LOs' books, so a loan's rep is
  // not always the one who invited them. Resolve each owner on the list (their reps only,
  // never the roster) so the page can name the rep on each loan.
  const reps = {};
  for (const l of loans) {
    if (!l.ownerKey || reps[l.ownerKey]) continue;
    try { reps[l.ownerKey] = await getRep(l.ownerKey); } catch (_) { reps[l.ownerKey] = null; }
  }
  return json(200, {
    ok: true, mode, email, rep, repKey: normalizeEmail(partner.ownerKey || ''), reps,
    company: partner.company || '',
    name: ((partner.firstName || '') + ' ' + (partner.lastName || '')).trim(),
    phone: partner.phone || '',
    brokerIds, groups,
    counts: { processing: groups.processing.length, quoted: groups.quoted.length, closed: groups.closed.length },
  });
}

export async function syncGrants(email, processing) {
  try {
    const want = {};
    for (const l of processing) want[l.loanId] = l;
    const have = await listAccessibleLoans(email);
    for (const g of have || []) {
      const id = g && (g.loanId || g);
      if (!id || want[id]) continue;
      if (g && g.role && g.role !== 'broker') continue; // a grant somebody gave them on purpose is not ours to take
      await revokeLoanAccess({ email, loanId: id, revokedBy: 'broker-portal' });
    }
    const held = new Set((have || []).map((g) => g && (g.loanId || g)).filter(Boolean));
    for (const id of Object.keys(want)) {
      if (held.has(id)) continue;
      const l = want[id];
      await grantLoanAccess({ email, loanId: id, primaryClientId: l.clientId, ownerKey: l.ownerKey, role: 'broker', grantedBy: 'broker-portal' });
    }
  } catch (e) {
    console.warn('broker-loans: grant sync failed (list still served):', e && e.message);
  }
}

// Every broker client record that IS this partner: same email, flagged broker, under any LO
// (the mirror carries every LO's book), plus the partner record's own link.
export async function brokerClientIdsFor(email, partner) {
  const ids = new Set();
  if (partner && partner.clientId) ids.add(String(partner.clientId));
  try {
    const rows = await db.select('clients', { select: 'id,is_broker,email', ilike: { email: email } });
    for (const r of rows || []) if (r && r.is_broker && normalizeEmail(r.email) === email) ids.add(String(r.id));
  } catch (e) {
    console.warn('broker-loans: clients lookup failed (partner clientId only):', e && e.message);
  }
  return [...ids];
}

async function loansForBrokerIds(brokerIds) {
  let rows = [];
  try {
    rows = await db.select('loans', { select: 'id,client_id,owner_email,broker_id,updated_at', in: { broker_id: brokerIds } });
  } catch (e) {
    console.warn('broker-loans: loans lookup failed:', e && e.message);
    return [];
  }
  // Group by client blob so each is read once; the full loan record lives there.
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const byClient = {};
  for (const r of rows || []) {
    if (!r || !r.client_id || !r.owner_email) continue;
    const key = keySafe(normalizeEmail(r.owner_email)) + '/' + keySafe(r.client_id);
    (byClient[key] = byClient[key] || { ownerKey: keySafe(normalizeEmail(r.owner_email)), ids: new Set() }).ids.add(String(r.id));
  }
  const out = [];
  for (const key of Object.keys(byClient)) {
    let client = null;
    try { client = await clientsStore.get(key, { type: 'json' }); } catch (_) { client = null; }
    if (!client || !Array.isArray(client.loans)) continue;
    for (const loan of client.loans) {
      if (!loan || !byClient[key].ids.has(String(loan.id))) continue;
      if (!brokerIds.includes(String(loan.brokerId || ''))) continue; // the blob is the truth; a stale mirror row is not
      out.push(project(loan, client, byClient[key].ownerKey));
    }
  }
  return out;
}

function bucketOf(row) {
  const k = row.stage && row.stage.key;
  if (k === 'closed' || k === 'denied') return 'closed';
  return row.inProcessing ? 'processing' : 'quoted';
}

// Borrower-safe, broker-relevant. Nothing about pricing internals, other loans, or the LO's
// notes. The terms are what is being negotiated; the counts are what the documents page
// will show them.
function project(loan, client, ownerKey) {
  const stage = _borrowerStage(loan);
  const st = String(loan.status || '').toLowerCase();
  const inProcessing = !!String(loan.processingStage || '').trim() && stage.key !== 'closed' && stage.key !== 'denied' && st !== 'on_hold';
  // Deploy 237.238 -- on a broker-submitted application the PARENT client is the broker;
  // the borrower is the linked guarantor (flat guarantors[], mirrored from guarantorClientIds)
  // or the name the broker typed. The first cut named the broker as their own borrower and
  // offered the broker's company as the entity.
  const parentIsBroker = !!(client._isBroker && (loan._isBrokerLoan ||
    (client.email && normalizeEmail(client.email) === normalizeEmail(loan.brokerEmail || ''))));
  const g1 = parentIsBroker && Array.isArray(loan.guarantors)
    ? loan.guarantors.find((g) => g && (g.firstName || g.lastName || g.email)) || null : null;
  const nameOf = (p) => ((p.firstName || '') + ' ' + (p.lastName || '')).replace(/\s+/g, ' ').trim() || p.email || '';
  const borrower = parentIsBroker ? (g1 ? nameOf(g1) : String(loan.borrowerName || '').trim()) : nameOf(client);
  const borrowerEmail = parentIsBroker ? String((g1 && g1.email) || loan.borrowerEmail || '') : (client.email || '');
  const entity = entityOf(loan, parentIsBroker ? {} : client);
  return {
    loanId: loan.id, clientId: client.id, ownerKey,
    program: programLabel(loan), purposeLabel: purposeLabel(loan), // Deploy 237.235
    slaDisplayId: loan.slaDisplayId || _deriveSlaDisplayId(loan),
    address: loan.address || '',
    borrower, entity, borrowerEmail,
    stage, inProcessing, status: loan.status || 'active',
    toolType: loan.toolType || '', loanType: loan.loanType || '', loanPurpose: loan.loanPurpose || '',
    propType: loan.propType || '',
    loanAmt: loan.loanAmt || '', rate: loan.rate || '', points: loan.points || '',
    loanTerm: loan.loanTerm || loan.term || (loan.formData && loan.formData.loanTerm) || '',
    purchasePrice: loan.purchasePrice || '', rehabBudget: loan.rehabBudget || '', arv: loan.arv || '', propValue: loan.propValue || '',
    brokerFee: loan.brokerFee || '',
    fundingDate: loan.fundingDate || '', expectedCloseDate: loan.expectedCloseDate || '',
    docsActive: Number(loan.docsActive) || 0, docsCollected: Number(loan.docsCollected) || 0,
    docsApproved: Number(loan.docsApproved) || 0, openConditions: Number(loan.openConditions) || 0,
    createdAt: loan.createdAt || '', updatedAt: loan.updatedAt || '',
  };
}

// Deploy 237.235 -- the program as Loan Details prints it (its FIN_DROPDOWNS labels; a
// stored loanTypeLabel, captured by the sizer, wins). The first cut printed the raw code
// ("light", "bridge").
const RTL_TYPE_LABELS = { light: 'Light Rehab (<50% of Loan)', heavy: 'Heavy Rehab (>50% of Loan)', bridge: 'Bridge (No Rehab)', transactional: 'Transactional Funding (1-day)', construction: 'Construction' };
const DSCR_TYPE_LABELS = { '30Y Fixed': '30-Year Fixed', '10/6 ARM': '10/6 ARM', '7/6 ARM': '7/6 ARM', '5/6 ARM': '5/6 ARM' };
const PURPOSE_LABELS = { purchase: 'Purchase', cashout: 'Cash-Out Refinance', rateterm: 'Rate/Term Refinance', refinance: 'Refinance', refi: 'Refinance' };
export function programLabel(loan) {
  const fd = (loan && loan.formData) || {};
  const tt = String((loan && loan.toolType) || '').toLowerCase();
  const code = String((loan && loan.loanType) || fd.loanType || '').trim();
  const stored = String((loan && loan.loanTypeLabel) || fd.loanTypeLabel || '').trim();
  if (tt === 'guc') return 'Ground-Up Construction';
  if (tt === 'dscr') {
    const t = stored || DSCR_TYPE_LABELS[code] || '';
    return (loan && loan.mfProgram ? 'DSCR 5+ Unit' : 'DSCR') + (t ? ' \u00b7 ' + t : '');
  }
  return stored || RTL_TYPE_LABELS[code] || RTL_TYPE_LABELS[code.toLowerCase()] || 'Bridge / Rehab';
}
export function purposeLabel(loan) {
  const p = String((loan && loan.loanPurpose) || '').toLowerCase().trim();
  return PURPOSE_LABELS[p] || '';
}

function entityOf(loan, client) {
  const v = Array.isArray(loan.vestingLLCs) ? loan.vestingLLCs.find((x) => x && (typeof x === 'string' ? x.trim() : String(x.name || '').trim())) : null;
  const vest = typeof v === 'string' ? v.trim() : String((v && v.name) || '').trim();
  return vest || String(loan.entityName || client.entityName || '').trim();
}
