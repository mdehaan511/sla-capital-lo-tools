/**
 * loan-uw-field-save.mjs — POST /api/loan-uw-field-save
 *
 * Deploy 236.492 (Phase 1b) — persists a single Underwriting or Lightning
 * Docs field onto the loan, with a full provenance stamp + append-only
 * audit trail. Every change records WHO made it (or that AI did) and, for
 * AI, a note of where the value came from — exactly per Mike's spec.
 *
 * Body:
 *   {
 *     clientId, loanId,
 *     dataset: 'uw' | 'lightning' | 'loan',   // 'loan' since Deploy 237.246: arvBpo / aivBpo only
 *     key:      string,              // field key from loan-uw-fields.js
 *     value:    any,                 // scalar, or {type,balance,weight} for accounts
 *     source?:  'loan'|'const'|'calc'|'doc'|'manual',
 *     sourceNote?: string,           // human note of where it came from
 *     isAI?:    boolean,             // true when an AI agent proposed it
 *     aiNote?:  string,              // AI provenance ("Title Commitment, p.2")
 *     verified?: boolean,            // human-confirmed (AI values start false)
 *     owner?:   'other@lo.com',      // admin/processor cross-LO override
 *   }
 *
 * Storage on the loan:
 *   loan.uwData / loan.lightningData = { [key]: entry }
 *   entry = { value, source, sourceNote, isAI, aiNote, verified,
 *             by, byName, at }
 *   loan.uwAudit / loan.lightningAudit = [ { key, from, to, by, byName,
 *             isAI, aiNote, at }, ... ]  (append-only, capped)
 *
 * Response: { ok: true, loan, entry }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs'; // Deploy 237.246
import { queueTruthRefreshIfMaterial } from './_shared/review-truth.mjs';    // Deploy 237.246

const AUDIT_CAP = 2000; // keep the audit bounded so the blob stays small
// Deploy 237.246 -- the loan fields an underwriter may set from the key-metrics panel.
const LOAN_KEYS = { arvBpo: 'ARV', aivBpo: 'AIV' };

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-uw-field-save error:', e);
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

  const clientId = String(body.clientId || '');
  const loanId   = String(body.loanId || '');
  const dataset  = String(body.dataset || '');
  const key      = String(body.key || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (dataset !== 'uw' && dataset !== 'lightning' && dataset !== 'loan') {
    return json(400, { error: "dataset must be 'uw', 'lightning' or 'loan'" });
  }
  if (!key) return json(400, { error: 'key required' });
  if (dataset === 'loan' && !LOAN_KEYS[key]) return json(400, { error: 'That loan field cannot be set here' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) return json(404, { error: 'Client has no loans array' });

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });

  const loan = client.loans[idx];
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  const now = new Date().toISOString();

  // Deploy 237.246 (Mike: "temporarily editable ... not saved without confirmation") --
  // dataset 'loan': the underwriter adopts a what-if ARV (or AIV) from the key-metrics
  // panel, after confirming it. This writes the REAL loan field the ratios, Loan
  // Financials and the trade tapes read (arvBpo / aivBpo), unlocks the Property tab's
  // input (the number is no longer the BPO's), and leaves a marker so the panel can say
  // who set it and what the valuation read -- and so a re-read of that same valuation
  // figure does not quietly undo the decision (uw-field-write honours the marker; a NEW
  // figure from a valuation supersedes it). Audit: a uwAudit entry + the loan change log.
  if (dataset === 'loan') {
    const n = Number(String(body.value == null ? '' : body.value).replace(/[^0-9.\-]/g, ''));
    if (!isFinite(n) || n <= 0) return json(400, { error: LOAN_KEYS[key] + ' must be a number above zero' });
    const before = Object.assign({}, loan);
    const prior = loan[key] == null ? '' : String(loan[key]);
    const wasFromBpo = loan[key + 'FromBpo'] === true;
    loan.uwAudit = Array.isArray(loan.uwAudit) ? loan.uwAudit : [];
    loan[key] = String(n);
    loan[key + 'FromBpo'] = false;
    const marker = {
      value: String(n), replaced: prior, replacedFromBpo: wasFromBpo,
      by: user.email || '', byName: authorName, at: now, note: String(body.sourceNote || '').slice(0, 300),
    };
    loan[key + 'UwOverride'] = marker;
    loan.uwAudit.push({
      key, action: 'override', from: prior || undefined, to: String(n),
      by: user.email || '', byName: authorName, isAI: false, aiNote: '', note: marker.note, at: now,
    });
    if (loan.uwAudit.length > AUDIT_CAP) loan.uwAudit = loan.uwAudit.slice(loan.uwAudit.length - AUDIT_CAP);
    loan.updatedAt = now;
    client.loans[idx] = loan;
    client.updatedAt = now;
    try { await writeClient(ownerKey, client, { clientsStore }); }
    catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }
    // After the write, best-effort: the Audit Log entry and the doc review's point of truth.
    try {
      await recordLoanChanges({
        ownerKey, clientId, loanId, actor: selfEmail, actorName: authorName || selfEmail,
        source: 'Key metrics (' + LOAN_KEYS[key] + ' set by underwriting)', changes: diffLoan(before, loan),
      });
    } catch (e) { console.warn('loan-uw-field-save: change log failed (non-fatal):', e && e.message); }
    try { await queueTruthRefreshIfMaterial({ ownerKey, clientId, loanId, before, after: loan, actorEmail: selfEmail, reason: LOAN_KEYS[key] + ' set by underwriting' }); }
    catch (e) { console.warn('loan-uw-field-save: truth refresh queue failed (non-fatal):', e && e.message); }
    return json(200, { ok: true, loan, entry: marker });
  }

  const dataField  = dataset === 'uw' ? 'uwData'  : 'lightningData';
  const auditField = dataset === 'uw' ? 'uwAudit' : 'lightningAudit';
  loan[dataField]  = (loan[dataField] && typeof loan[dataField] === 'object') ? loan[dataField] : {};
  loan[auditField] = Array.isArray(loan[auditField]) ? loan[auditField] : [];

  const prior = loan[dataField][key] || null;

  // Deploy 236.500 (Phase 3) — CONFIRM path. A human is validating an
  // existing (typically AI-proposed) value without retyping it. We keep the
  // original value + AI provenance intact and stamp WHO confirmed + when, so
  // the audit shows both "AI proposed" and "human confirmed". Costly-mistake
  // domain: a confirm must never silently mutate the value.
  if (body.confirm === true) {
    if (!prior) return json(404, { error: 'Nothing to confirm for ' + key });
    prior.verified       = true;
    prior.verifiedBy     = user.email || '';
    prior.verifiedByName = authorName;
    prior.verifiedAt     = now;
    loan[dataField][key] = prior;
    loan[auditField].push({
      key: key, action: 'confirm', to: prior.value,
      by: user.email || '', byName: authorName, isAI: false, at: now,
    });
    if (loan[auditField].length > AUDIT_CAP) {
      loan[auditField] = loan[auditField].slice(loan[auditField].length - AUDIT_CAP);
    }
    loan.updatedAt = now;
    client.loans[idx] = loan;
    client.updatedAt = now;
    try { await writeClient(ownerKey, client, { clientsStore }); }
    catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }
    return json(200, { ok: true, loan, entry: prior });
  }

  // AI-proposed values start UNVERIFIED unless the caller explicitly
  // confirms; human edits are verified by definition (a person typed them).
  const isAI = body.isAI === true;
  const verified = isAI ? (body.verified === true) : true;

  const entry = {
    value:      (body.value === undefined ? '' : body.value),
    source:     String(body.source || (isAI ? 'doc' : 'manual')),
    sourceNote: String(body.sourceNote || ''),
    isAI:       isAI,
    aiNote:     isAI ? String(body.aiNote || '') : '',
    verified:   verified,
    by:         isAI ? 'ai' : (user.email || ''),
    byName:     isAI ? (body.aiNote ? 'AI' : 'AI') : authorName,
    at:         now,
  };

  loan[dataField][key] = entry;

  loan[auditField].push({
    key:    key,
    from:   prior ? prior.value : undefined,
    to:     entry.value,
    by:     entry.by,
    byName: entry.byName,
    isAI:   isAI,
    aiNote: entry.aiNote,
    at:     now,
  });
  // Keep the audit bounded (oldest trimmed) so the loan blob stays small.
  if (loan[auditField].length > AUDIT_CAP) {
    loan[auditField] = loan[auditField].slice(loan[auditField].length - AUDIT_CAP);
  }

  loan.updatedAt = now;
  client.loans[idx] = loan;
  client.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan, entry });
}
