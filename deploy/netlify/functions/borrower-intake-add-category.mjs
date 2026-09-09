/**
 * borrower-intake-add-category.mjs — POST /api/borrower-intake-add-category
 *
 * Deploy 236.918 — a borrower adds a document category to their own list.
 *
 * Team: "Is there a way for borrowers to add another tray/category, similar
 * to how we can add one from our view?" Until now the borrower document page
 * showed the fixed checklist only, and the upload endpoint refused any slug
 * that wasn't on it — so a borrower holding something we hadn't asked for
 * (a gift letter, a lease we didn't know about) had nowhere to put it.
 *
 * This mints a `borrower_<ts>_<rand>` tray in the loan's review — the same
 * shape staff-added custom trays have, in the `borrower` section so the team
 * sees it under Borrower in Doc Review — and the status/upload endpoints let
 * the borrower see it and upload into it. It has no rubric, so whatever lands
 * there is a manual review, never an automatic tick.
 *
 * Body: { loanId, primaryClientId, ownerKey, label }
 * Auth: canReadLoan (borrower grant; LO/admin short-circuit) — the same gate
 *       as intake-status / intake-upload. Refused in admin "view as".
 * Returns: { ok, slug, label, existing }   existing=true when a tray with
 *          that name was already there (returned rather than duplicated).
 */
import { getStore } from '@netlify/blobs';
import { sizerType, reviewTypeForLoan } from './_shared/loan-review-checklists.mjs'; // Deploy 236.934
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canReadLoan } from './_shared/access.mjs';
import { resolveViewAs, denyWrite } from './_shared/portal-view-as.mjs';
import {
  mintBorrowerTray, findBorrowerTrayByLabel, normalizeTrayLabel, borrowerTrayEntries,
} from './_shared/borrower-intake-custom.mjs';

const MAX_PER_LOAN = 15;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-add-category error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  // An admin looking at a borrower's portal must not add trays as them.
  const view = resolveViewAs(req, user);
  if (view.error) return view.error;
  const noWrite = denyWrite(view);
  if (noWrite) return noWrite;

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const { loanId, primaryClientId, ownerKey } = body;
  const label = normalizeTrayLabel(body.label);
  if (!loanId) return json(400, { error: 'loanId required' });
  if (label.length < 2) return json(400, { error: 'Give the document a name (at least 2 characters).' });

  // ── Same access check + review discovery as borrower-intake-upload ──
  let loan = null, client = null;
  try {
    if (primaryClientId && ownerKey) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      loan = client && Array.isArray(client.loans)
        ? client.loans.find((l) => l && l.id === loanId) || null
        : null;
    }
  } catch (_) {}
  const perm = await canReadLoan(user, loan || { id: loanId, ownerKey }, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let review = null;
  try {
    const { blobs } = await reviewsStore.list();
    // loanId match ALWAYS beats address match (236.762) — two loans on the
    // same property must not receive each other's trays.
    let byAddress = null;
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r) continue;
      if (r.source && r.source.loanId === loanId) { review = r; break; }
      if (!byAddress && r.address && loan && loan.address &&
          String(r.address).toLowerCase().trim() === String(loan.address).toLowerCase().trim()) { byAddress = r; }
    }
    if (!review) review = byAddress;
  } catch (e) { console.warn('[borrower-intake-add-category] review lookup failed:', e && e.message); }

  // Deploy 236.934 — the sizer type (guc/rtl/dscr), never loan.loanType: that is the
  // product label ('light'), and a review stored with it has no checklist.
  const loanType = sizerType(review && review.loanType) || reviewTypeForLoan(loan);
  if (!review) {
    review = {
      id:        'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      address:   loan ? (loan.address || '') : '',
      investor:  '', loanType, docs: {},
      sourceLoanSnapshot:   loan   || {},
      sourceClientSnapshot: client || {},
      source:    { kind: 'existing', loanId, clientId: primaryClientId || '', ownerKey: ownerKey || '' },
      borrowerName: (client ? ((client.firstName || '') + ' ' + (client.lastName || '')).trim() : ''),
      loanAmount:   loan ? (loan.loanAmt || '') : '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      createdBy: 'auto:borrower-intake',
    };
  }
  review.docs = review.docs || {};

  // Same name twice is almost always a double-click; hand back the tray they
  // already have instead of minting a twin.
  const dup = findBorrowerTrayByLabel(review.docs, label);
  if (dup) return json(200, { ok: true, slug: dup, label: review.docs[dup].label || label, existing: true });

  // Counted with the shared rule so the checklist's own borrower_loe never
  // eats one of the borrower's slots.
  const mine = borrowerTrayEntries(review.docs).length;
  if (mine >= MAX_PER_LOAN) {
    return json(400, { error: 'You have added the maximum number of extra documents for this loan. Ask your loan team to add more.' });
  }

  const self = normalizeEmail(user.email);
  const { slug, doc } = mintBorrowerTray(label, { addedBy: self });
  review.docs[slug] = doc;
  const now = new Date().toISOString();
  review.updatedAt = now;
  review.lastEditedBy = self;
  review.lastEditedAt = now;

  try { await reviewsStore.setJSON(keySafe(review.id), review); }
  catch (e) { return json(500, { error: 'Failed to save: ' + ((e && e.message) || 'unknown') }); }

  return json(200, { ok: true, slug, label: doc.label, existing: false });
}
