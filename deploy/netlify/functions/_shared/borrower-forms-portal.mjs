/**
 * _shared/borrower-forms-portal.mjs — Deploy 237.039 (Mike)
 *
 * The borrower-PORTAL path for borrower forms (W-9 / PM questionnaire / VOM…).
 * Until now a form could only be reached through a token link a processor
 * sent from a Doc Review tray. Mike wants the DSCR ones (PM questionnaire,
 * VOM) completed straight from the portal checklist, the way RTL borrowers
 * fill the Track Record and Scope of Work tools. So: same form definitions,
 * same renderer, same tray filing — but the auth is the borrower's portal
 * login + loan grant instead of a token.
 *
 * resolvePortalForm() turns (user, loanId, formId) into everything the
 * info/submit endpoints need: the form, the loan + client context, the
 * review + tray, and who to notify. Returns { error: Response } on any
 * refusal so the caller can just `return r.error`.
 */
import { json, keySafe, normalizeEmail } from './auth.mjs';
import { roleOf } from './access.mjs';
import { resolveViewAs } from './portal-view-as.mjs';
import { hasLoanGrant, listAccessibleLoans } from './loan-access-store.mjs';
import { locateLoan } from './loan-locate.mjs';
import { findReviewForLoan } from './loan-review-auto-attach.mjs';
import { sizerType, reviewTypeForLoan, findCategory } from './loan-review-checklists.mjs';
import { formById, ctxSnapshot } from './borrower-forms.mjs';

export async function resolvePortalForm({ req, user, loanId, formId, staffRef }) {
  const form = formById(formId);
  if (!form || !form.portal) return { error: json(400, { error: 'This form is not available online' }) };
  loanId = String(loanId || '');
  if (!loanId) return { error: json(400, { error: 'loanId required' }) };

  // Staff = any role that is not portal-side; admins may ?viewAs= (read-only).
  const staff = ['borrower', 'viewer', 'broker'].indexOf(roleOf(user)) < 0;
  const view = resolveViewAs(req, user);
  if (view.error) return { error: view.error };
  const selfEmail = normalizeEmail(view.email || user.email);

  let ownerKey = '', clientId = '';
  if (!staff || view.viewingAs) {
    if (!(await hasLoanGrant(selfEmail, loanId))) return { error: json(403, { error: 'No access to this loan' }) };
    const grants = await listAccessibleLoans(selfEmail).catch(() => []);
    const g = (grants || []).find((x) => x && x.loanId === loanId) || {};
    ownerKey = g.ownerKey || ''; clientId = g.primaryClientId || '';
  } else {
    ownerKey = (staffRef && staffRef.owner) || ''; clientId = (staffRef && staffRef.clientId) || '';
  }
  const found = await locateLoan({ ownerKey: ownerKey ? keySafe(normalizeEmail(ownerKey)) : '', clientId, loanId, allowScan: false });
  if (!found || !found.loan || !found.client) return { error: json(404, { error: 'Loan not found' }) };
  const { loan, client } = found;

  const review = await findReviewForLoan({ ownerKey: found.ownerKey, clientId: found.clientId, loanId, address: loan.address || '' });
  if (!review) return { error: json(409, { error: 'Your loan team has not started your document checklist yet — please check back soon.' }) };
  const loanType = sizerType(review.loanType) || reviewTypeForLoan(loan);
  if (form.loanTypes && form.loanTypes.indexOf(loanType) < 0) return { error: json(400, { error: 'This form does not apply to this loan type' }) };

  // The tray normally exists (the review was minted from the checklist); an
  // older review without it gets the standard tray seeded so the filing lands.
  review.docs = review.docs || {};
  let seeded = false;
  if (!review.docs[form.slug]) {
    const cat = findCategory(form.slug);
    if (!cat) return { error: json(409, { error: 'This form is not on your loan checklist' }) };
    review.docs[form.slug] = {
      slug: form.slug, section: cat.section, label: cat.label, conditions: cat.conditions || '',
      verdict: 'pending', required: !cat.optional, processorNotes: '', naReason: '', uploads: [], history: [],
      createdAt: new Date().toISOString(),
    };
    seeded = true;
  }

  const ownerEmail = [ownerKey, client.ownerEmail, client.owner, loan.loEmail, loan.ownerEmail]
    .map((e) => normalizeEmail(e || '')).find((e) => e.indexOf('@') > 0) || '';
  const borrowerName = [client.firstName, client.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ');
  const ctx = Object.assign(ctxSnapshot(loan, client), { sender: { name: '', title: '', phone: '', email: ownerEmail } });
  return {
    form, staff, viewingAs: !!view.viewingAs, selfEmail, loanType,
    ownerKey: found.ownerKey, clientId: found.clientId, loanId, address: loan.address || '',
    review, tray: review.docs[form.slug], slug: form.slug, seeded, ctx, ownerEmail, borrowerName,
    to: (!staff || view.viewingAs) ? selfEmail : normalizeEmail(client.email || selfEmail),
  };
}
