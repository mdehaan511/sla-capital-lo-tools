/**
 * loan-servicing-set.mjs — POST /api/loan-servicing-set
 *
 * Deploy 236.339 — save post-close servicing metadata (maturity
 * date, servicer name, servicer portal URL) on a loan. Borrower
 * portal (/my-loans/) reads these to render the "Servicer" button
 * + Maturity Date fact on Closed loan cards; the fields are pulled
 * through by borrower-loans.mjs already.
 *
 * Body: { clientId, loanId, maturityDate?, servicerName?, servicerUrl?, owner? }
 *   Any field omitted / null is left unchanged. Passing an empty
 *   string clears the field (so an LO can un-set a servicer).
 *
 * Response: { ok: true, loan }
 *
 * Auth: LO owns the loan → OK. Admin / processor → owner override.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';

// Basic URL sanitization — accept http(s) only, otherwise reject.
// Prevents an LO from accidentally pasting a `javascript:` or
// malformed URL that would break the borrower's rendered link.
function sanitizeUrl(raw) {
  if (raw == null) return { ok: true, value: undefined };
  const s = String(raw).trim();
  if (s === '') return { ok: true, value: '' };
  const withScheme = /^https?:\/\//i.test(s) ? s : ('https://' + s);
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: 'URL must start with https:// or http://' };
    }
    return { ok: true, value: u.toString() };
  } catch (_) {
    return { ok: false, reason: 'Invalid servicer URL' };
  }
}

function sanitizeDate(raw) {
  if (raw == null) return { ok: true, value: undefined };
  const s = String(raw).trim();
  if (s === '') return { ok: true, value: '' };
  // Accept ISO YYYY-MM-DD (HTML date input format) or anything Date
  // can parse. Store as YYYY-MM-DD.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, value: s };
  const d = new Date(s);
  if (!isFinite(d.getTime())) return { ok: false, reason: 'Invalid maturity date' };
  return { ok: true, value: d.toISOString().slice(0, 10) };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-servicing-set error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = String(body.clientId || '').trim();
  const loanId   = String(body.loanId   || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  // Validate all three fields up-front so partial success doesn't
  // leave the loan in a mixed state.
  const url  = sanitizeUrl(body.servicerUrl);
  if (!url.ok)  return json(400, { error: url.reason });
  const mat  = sanitizeDate(body.maturityDate);
  if (!mat.ok)  return json(400, { error: mat.reason });
  const name = body.servicerName != null ? String(body.servicerName).trim() : undefined;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let primaryKey = ownerKey + '/' + keySafe(clientId);
  let primary;
  try { primary = await clientsStore.get(primaryKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }

  // Cross-namespace recovery (Deploy 236.317 pattern) — admin/processor
  // whose payload dropped `owner` still finds the loan under any owner.
  if (!primary && canOverrideOwner(user).ok) {
    try {
      const { blobs } = await clientsStore.list();
      const wantSuffix = '/' + keySafe(clientId);
      for (const { key } of blobs) {
        if (!key.endsWith(wantSuffix)) continue;
        const rec = await clientsStore.get(key, { type: 'json' });
        if (rec && rec.id === clientId) {
          primary = rec;
          primaryKey = key;
          const slash = key.indexOf('/');
          if (slash > 0) ownerKey = key.slice(0, slash);
          break;
        }
      }
    } catch (_) {}
  }
  if (!primary) return json(404, { error: 'Client not found' });
  if (!Array.isArray(primary.loans)) return json(404, { error: 'Client has no loans array' });

  const loanIdx = primary.loans.findIndex((l) => l && l.id === loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = primary.loans[loanIdx];

  const before = {
    maturityDate: loan.maturityDate || '',
    servicerName: loan.servicerName || '',
    servicerUrl:  loan.servicerUrl  || '',
  };

  if (mat.value  !== undefined) loan.maturityDate = mat.value;
  if (name       !== undefined) loan.servicerName = name;
  if (url.value  !== undefined) loan.servicerUrl  = url.value;
  // Deploy 236.618 — additional servicing scalars (Loan Details Servicing tab +
  // Closed Loans page). Dates from the HTML date inputs are already YYYY-MM-DD;
  // the rest are trimmed strings. Any field omitted is left unchanged.
  ['servicerLoanNumber', 'paymentAmount', 'upb', 'payoffAmount', 'payoffDate', 'investorName', 'soldRate', 'soldDate',
   // Deploy 236.622 — collateral tracking: 3 docs × date + location(custodian).
   'signedOriginalsDate', 'signedOriginalsLocation', 'signedOriginalsTracking',
   'recordedDotDate', 'recordedDotLocation', 'recordedDotTracking',
   'titlePolicyDate', 'titlePolicyLocation', 'titlePolicyTracking'].forEach((k) => {
    if (body[k] != null) loan[k] = String(body[k]).trim();
  });
  loan.updatedAt = new Date().toISOString();

  // Audit entry — only when something actually changed.
  const changed = [];
  if (loan.maturityDate !== before.maturityDate) changed.push('maturity date');
  if (loan.servicerName !== before.servicerName) changed.push('servicer name');
  if (loan.servicerUrl  !== before.servicerUrl)  changed.push('servicer URL');
  if (changed.length) {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(loan, {
      kind: 'servicing_updated',
      text: 'Updated servicing info: ' + changed.join(', ') + '.',
      author,
      authorEmail: user.email || '',
      meta: {
        before,
        after: {
          maturityDate: loan.maturityDate || '',
          servicerName: loan.servicerName || '',
          servicerUrl:  loan.servicerUrl  || '',
        },
      },
    });
  }

  primary.loans[loanIdx] = loan;
  primary.updatedAt = new Date().toISOString();
  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  try { await writeClient(ownerKey, primary, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan });
}
