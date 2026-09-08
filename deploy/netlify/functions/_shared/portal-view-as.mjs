/**
 * _shared/portal-view-as.mjs — Deploy 236.895 (Mike)
 *
 * "Can we make a way so that I can see a borrower's portal as an admin."
 *
 * Every borrower-portal endpoint derives everything it does from
 * `normalizeEmail(user.email)`. So an admin view is one substitution: resolve
 * the EFFECTIVE borrower email once, at the top, and let the rest of the
 * endpoint carry on unchanged.
 *
 *   /api/borrower-portal-loans?viewAs=someone@example.com
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not impersonation. The admin's own token is what's presented, their own
 * identity is what gets logged, and **every write is refused** while viewing
 * (`denyWrite`). An admin who needs to change a borrower's record does it on
 * Loan Details, under their own name, where it lands in the audit log — not
 * through a portal wearing the borrower's face.
 *
 * No new data is exposed: an admin can already see all of it on Loan Details.
 * This shows the same facts arranged the way the borrower sees them, which is
 * the point — "what is my borrower actually looking at right now".
 */
import { json, isAdmin, normalizeEmail } from './auth.mjs';

/**
 * @returns {{email:string, viewingAs:boolean, actor:string, error:Response|null}}
 *   `email`     the borrower whose portal to render (the caller's own, normally)
 *   `viewingAs` true when an admin is looking at someone else's portal
 *   `error`     a ready-to-return Response when the request must be refused
 */
export function resolveViewAs(req, user) {
  const self = normalizeEmail(user.email);
  let target = '';
  try {
    target = normalizeEmail(new URL(req.url).searchParams.get('viewAs') || '');
  } catch (e) { /* malformed URL — treat as no viewAs */ }

  if (!target || target === self) {
    return { email: self, viewingAs: false, actor: self, error: null };
  }

  // Deliberately isAdmin, not canOverrideOwner: reading a borrower's portal is
  // a different question from working another LO's loan, and this is the
  // narrow end to start from. Widening later is a one-line change.
  if (!isAdmin(user)) {
    return { email: self, viewingAs: false, actor: self, error: json(403, { error: 'Admin only' }) };
  }
  if (target.indexOf('@') < 0) {
    return { email: self, viewingAs: false, actor: self, error: json(400, { error: 'viewAs must be an email address' }) };
  }

  // An admin reading a borrower's view is worth a line in the log — the whole
  // point of keeping the admin's own identity on the request.
  console.log('[view-as] ' + self + ' is viewing the portal as ' + target);
  return { email: target, viewingAs: true, actor: self, error: null };
}

/**
 * Refuse a write attempted while viewing as someone else.
 * Returns a Response to return, or null when the write may proceed.
 */
export function denyWrite(ctx) {
  if (!ctx || !ctx.viewingAs) return null;
  return json(403, {
    error: 'Read-only: you are viewing this portal as ' + ctx.email +
           '. Make changes from Loan Details so they are recorded under your name.',
    viewingAs: ctx.email,
  });
}
