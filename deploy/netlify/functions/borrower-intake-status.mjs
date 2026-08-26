/**
 * borrower-intake-status.mjs — GET /api/borrower-intake-status
 *
 * Deploy 236.518 — returns the borrower's document checklist for a loan plus
 * the live state of each item (from the shared loan_review). Accepted items
 * are flagged so the portal can drop them off the borrower's list.
 *
 * Query: ?loanId=&primaryClientId=&ownerKey=
 * Auth:  canReadLoan (borrower grant; LO/admin short-circuit).
 * Returns: { ok, loanType, address, items:[{ slug,label,hint,optional,multi,
 *            templateUrl, status, accepted, uploaded, uploadedCount,
 *            manualReviewRequested, aiVerdict, message, findings }] }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, keySafe } from './_shared/auth.mjs';
import { canReadLoan } from './_shared/access.mjs';
import { borrowerChecklist } from './_shared/borrower-intake-checklists.mjs';
// Deploy 236.743 — read the long-app record for the hasLLC answer (entity-doc gate).
import { loadRecord } from './_shared/borrower-info-keys.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-status error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId = url.searchParams.get('loanId') || '';
  const primaryClientId = url.searchParams.get('primaryClientId') || '';
  const ownerKey = url.searchParams.get('ownerKey') || '';
  if (!loanId) return json(400, { error: 'loanId required' });

  let loan = null, client = null;
  try {
    if (primaryClientId && ownerKey) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      loan = client && Array.isArray(client.loans)
        ? client.loans.find((l) => l && l.id === loanId) || null : null;
    }
  } catch (_) {}
  const perm = await canReadLoan(user, loan || { id: loanId, ownerKey }, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  // Find the review (best-effort; none yet = everything is "todo").
  const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let review = null;
  try {
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r) continue;
      if (r.source && r.source.loanId === loanId) { review = r; break; }
      if (r.address && loan && loan.address &&
          String(r.address).toLowerCase().trim() === String(loan.address).toLowerCase().trim()) { review = r; break; }
    }
  } catch (e) { console.warn('[borrower-intake-status] review lookup failed:', e && e.message); }

  const loanType = String((review && review.loanType) || (loan && loan.loanType) || '').toLowerCase();
  const docs = (review && review.docs) || {};

  // Deploy 236.743 — entity docs (Articles / Good Standing / Operating
  // Agreement / EIN) only apply when the loan vests in an LLC. Hide them only
  // on a POSITIVE "no LLC" signal: the loan has no vestingLLCs AND the long
  // app answered hasLLC = no. Unknown → keep the docs (safe default).
  let noEntity = false;
  try {
    const hasVesting = !!(loan && Array.isArray(loan.vestingLLCs) && loan.vestingLLCs.some((v) => v && v.name));
    if (!hasVesting && ownerKey && primaryClientId) {
      const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
      const rec = await loadRecord(biStore, ownerKey, primaryClientId, loanId, client);
      if (rec && rec.data && String(rec.data.hasLLC || '').toLowerCase() === 'no') noEntity = true;
    }
  } catch (e) { console.warn('[borrower-intake-status] hasLLC lookup failed:', e && e.message); }

  // Deploy 236.743 — Your SLA Team: the LO who owns the loan + every assigned
  // team member (loan.assignedProcessors, role-tagged since 236.662).
  const team = [];
  try {
    const ROLE_LABELS = { processor: 'Loan Processor', closer: 'Closer', manager: 'Processing Manager' };
    const profiles = getStore({ name: 'profiles', consistency: 'eventual' });
    let loName = '', loEmail = ownerKey || '';
    try {
      const p = await profiles.get(ownerKey, { type: 'json' });
      if (p) { loName = p.fullName || ''; loEmail = p.email || loEmail; }
    } catch (_) {}
    if (loEmail && loEmail.includes('@')) team.push({ name: loName, email: loEmail, role: 'Loan Officer' });
    const assigned = (loan && Array.isArray(loan.assignedProcessors)) ? loan.assignedProcessors : [];
    for (const a of assigned) {
      if (!a || !a.email) continue;
      if (team.some((t) => t.email === a.email)) continue;
      team.push({ name: a.name || '', email: a.email, role: ROLE_LABELS[a.role] || 'Loan Processor' });
    }
  } catch (e) { console.warn('[borrower-intake-status] team build failed:', e && e.message); }

  const items = borrowerChecklist(loanType, { noEntity }).map((item) => {
    const d = docs[item.slug] || null;
    const s = _itemState(d);
    return {
      slug: item.slug, label: item.label, hint: item.hint || '', optional: !!item.optional,
      multi: !!item.multi, templateUrl: item.templateUrl || '',
      status: s.status, accepted: s.accepted, uploaded: s.uploaded, uploadedCount: s.uploadedCount,
      manualReviewRequested: !!(d && d.manualReviewRequested),
      aiVerdict: (d && d.aiVerdict) || '',
      message: s.message,
      findings: s.findings,
    };
  });

  return json(200, {
    ok: true,
    loanType,
    address: (review && review.address) || (loan && loan.address) || '',
    items,
    team,
  });
}

function _itemState(d) {
  if (!d) return { status: 'todo', accepted: false, uploaded: false, uploadedCount: 0, message: '', findings: [] };
  const liveDocs = Array.isArray(d.documents) ? d.documents.filter((x) => x && !x.hidden) : [];
  const uploaded = !!(d.currentDocId || liveDocs.length);
  const uploadedCount = liveDocs.length || (d.currentDocId ? 1 : 0);
  const findings = (Array.isArray(d.aiFindings) ? d.aiFindings : [])
    .filter((f) => f && f.status === 'not_met').map((f) => f.detail || f.condition).filter(Boolean).slice(0, 3);

  if (d.verdict === 'approved') {
    return { status: 'accepted', accepted: true, uploaded: true, uploadedCount, message: 'Accepted ✓', findings: [] };
  }
  // Deploy 236.746 — processor-flagged issue beats every non-approved state:
  // the borrower sees WHAT was flagged and is prompted to re-submit.
  if (d.verdict === 'issues') {
    return { status: 'needs_fix', accepted: false, uploaded, uploadedCount,
      message: (d.flagReason
        ? 'Your loan team flagged an issue: ' + d.flagReason
        : 'Your loan team flagged an issue with this document.')
        + ' Please upload a corrected version.',
      findings: [] };
  }
  if (d.manualReviewRequested) {
    return { status: 'manual_review', accepted: false, uploaded: uploaded, uploadedCount,
      message: 'Manual review requested — a processor will take a look.', findings: [] };
  }
  if (!uploaded) {
    return { status: 'todo', accepted: false, uploaded: false, uploadedCount: 0, message: '', findings: [] };
  }
  if (d.aiVerdict === 'issues') {
    return { status: 'needs_fix', accepted: false, uploaded: true, uploadedCount,
      message: (d.aiNotes || 'We spotted a possible issue.') + ' Upload a corrected version, or request a manual review.', findings };
  }
  if (d.aiVerdict === 'needs_manual_review') {
    return { status: 'submitted', accepted: false, uploaded: true, uploadedCount,
      message: 'Received — a processor will review it.', findings: [] };
  }
  // approved-by-AI (but not yet processor-accepted) or plain submitted
  return { status: 'submitted', accepted: false, uploaded: true, uploadedCount,
    message: d.aiVerdict === 'approved' ? 'Looks good ✓ — submitted for review.' : 'Submitted for review.', findings: [] };
}
