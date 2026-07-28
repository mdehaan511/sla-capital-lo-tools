/**
 * pii-audit.mjs — Phase F3 (borrower-portal hardening).
 *
 * Durable audit trail for staff access to borrower PII. One row per
 * successful reveal/download, written to public.pii_access_log (see
 * db/migrations/008_pii_access_log.sql).
 *
 * FAIL-OPEN by contract: logPiiAccess() NEVER throws and NEVER blocks
 * the response. If the table doesn't exist yet (migration 008 not run),
 * or Postgres is briefly unavailable, we swallow the error and move on.
 * The audit log is important, but it must never be the reason a loan
 * officer can't reveal an SSN or download a doc mid-deal.
 *
 * Call it AFTER all auth/authorization checks pass and the resource is
 * confirmed present — so the log records actual PII *disclosures*, not
 * 401/403/404 attempts.
 *
 * Awaited by callers (not fire-and-forget): a detached promise can be
 * dropped when the Lambda freezes right after the response, silently
 * losing audit rows. One extra ~50–100ms PG round-trip on these
 * low-frequency endpoints is an acceptable price for a reliable trail.
 *
 * Usage:
 *   import { logPiiAccess } from './_shared/pii-audit.mjs';
 *   await logPiiAccess(req, context, {
 *     action: 'ssn_reveal', resource: 'ssn',
 *     actorEmail: user.email, actorRole: isAdmin(user) ? 'admin' : 'lo',
 *     ownerEmail: owner, clientId, loanId,
 *   });
 */
import { db } from './supabase-db.mjs';
import { clientIp } from './rate-limit.mjs';

function _ua(req) {
  try {
    if (req && req.headers && typeof req.headers.get === 'function') {
      return String(req.headers.get('user-agent') || '').slice(0, 400);
    }
  } catch (_) { /* ignore */ }
  return '';
}

/**
 * @param {Request} req      the incoming request (for IP + user-agent)
 * @param {object}  context  Netlify function context (for context.ip)
 * @param {object}  fields   { action, resource?, actorEmail?, actorRole?,
 *                             ownerEmail?, clientId?, loanId?, resourceId?,
 *                             detail? }
 * @returns {Promise<void>}  resolves regardless of success/failure
 */
export async function logPiiAccess(req, context, fields) {
  try {
    const f = fields || {};
    const row = {
      action:      String(f.action || 'access'),
      resource:    String(f.resource || ''),
      actor_email: String(f.actorEmail || ''),
      actor_role:  String(f.actorRole || ''),
      owner_email: String(f.ownerEmail || ''),
      client_id:   f.clientId ? String(f.clientId) : null,
      loan_id:     f.loanId ? String(f.loanId) : null,
      resource_id: f.resourceId ? String(f.resourceId) : null,
      detail:      f.detail ? String(f.detail).slice(0, 500) : null,
      ip:          String(clientIp(req, context) || ''),
      user_agent:  _ua(req),
    };
    await db.insert('pii_access_log', [row]);
  } catch (e) {
    // Fail-open: log to the function console (Phase A beacon picks it up)
    // and return. Never rethrow — the caller's response must not depend
    // on the audit write succeeding.
    console.warn('[pii-audit] log write failed (non-fatal):', e && e.message);
  }
}
