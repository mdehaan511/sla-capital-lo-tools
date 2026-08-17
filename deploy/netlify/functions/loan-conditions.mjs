/**
 * loan-conditions.mjs — POST /api/loan-conditions
 *
 * Deploy 236.560 — processing-team rollout, slice 2 (conditions management).
 * Per-loan underwriting conditions live on loan.conditions[]. The underwriter
 * adds them (templated or custom); the processor/closer clears them. Roles
 * aren't distinguished in-app, so any staff member (admin OR processor) may add
 * and clear — every change is audited (createdBy / clearedBy / updatedAt).
 *
 * Body (POST):
 *   { clientId, loanId, owner?, action, ... }
 *     action 'add'    : condition:{title,category,owner,priorTo,note}   → append
 *     action 'seed'   : conditions:[{...}, ...]                          → bulk append (templates)
 *     action 'update' : conditionId, patch:{...}                        → merge (status→clear stamps)
 *     action 'remove' : conditionId                                     → delete
 *
 * Auth mirrors loan-assign-processor: cross-owner (a processor on another LO's
 * loan) requires admin OR processor via canOverrideOwner. Strict writeClient.
 * Returns { ok, conditions } — the full updated list.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

const CATEGORIES = ['income', 'title', 'appraisal', 'insurance', 'entity', 'other'];
const OWNERS     = ['borrower', 'title', 'appraiser', 'internal'];
const STATUSES   = ['outstanding', 'received', 'cleared'];
const PRIOR_TO   = ['docs', 'funding'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-conditions error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _rid() {
  return 'cond_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function _one(v, allowed, dflt) {
  const s = String(v == null ? '' : v).toLowerCase().trim();
  return allowed.indexOf(s) >= 0 ? s : dflt;
}
// Sanitize a client-supplied condition into our shape (add/seed path).
function _clean(c, now, by) {
  c = c || {};
  return {
    id:        _rid(),
    title:     String(c.title || '').trim().slice(0, 300),
    category:  _one(c.category, CATEGORIES, 'other'),
    owner:     _one(c.owner, OWNERS, 'borrower'),
    status:    _one(c.status, STATUSES, 'outstanding'),
    priorTo:   _one(c.priorTo, PRIOR_TO, 'docs'),
    note:      String(c.note || '').trim().slice(0, 1000),
    createdAt: now,
    createdBy: by,
    updatedAt: now,
    clearedAt: null,
    clearedBy: null,
  };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId;
  const action = String(body.action || '').toLowerCase().trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (['add', 'seed', 'update', 'remove'].indexOf(action) < 0) {
    return json(400, { error: 'Invalid action' });
  }

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
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = client.loans[idx];
  if (!Array.isArray(loan.conditions)) loan.conditions = [];

  const now = new Date().toISOString();

  if (action === 'add') {
    if (!body.condition || !String(body.condition.title || '').trim()) {
      return json(400, { error: 'condition.title required' });
    }
    loan.conditions.push(_clean(body.condition, now, selfEmail));
  } else if (action === 'seed') {
    const arr = Array.isArray(body.conditions) ? body.conditions : [];
    const cleaned = arr.filter((c) => c && String(c.title || '').trim()).map((c) => _clean(c, now, selfEmail));
    if (!cleaned.length) return json(400, { error: 'no valid conditions to seed' });
    loan.conditions.push(...cleaned);
  } else if (action === 'update') {
    const cid = String(body.conditionId || '');
    const ci = loan.conditions.findIndex((c) => c && c.id === cid);
    if (ci < 0) return json(404, { error: 'Condition not found' });
    const prev = loan.conditions[ci];
    const p = body.patch || {};
    if (p.title    !== undefined) prev.title    = String(p.title).trim().slice(0, 300);
    if (p.category !== undefined) prev.category = _one(p.category, CATEGORIES, prev.category);
    if (p.owner    !== undefined) prev.owner    = _one(p.owner, OWNERS, prev.owner);
    if (p.priorTo  !== undefined) prev.priorTo  = _one(p.priorTo, PRIOR_TO, prev.priorTo);
    if (p.note     !== undefined) prev.note     = String(p.note).trim().slice(0, 1000);
    if (p.status   !== undefined) {
      const ns = _one(p.status, STATUSES, prev.status);
      if (ns !== prev.status) {
        prev.status = ns;
        if (ns === 'cleared') { prev.clearedAt = now; prev.clearedBy = selfEmail; }
        else                  { prev.clearedAt = null; prev.clearedBy = null; } // reopened
      }
    }
    prev.updatedAt = now;
  } else if (action === 'remove') {
    const cid = String(body.conditionId || '');
    const before = loan.conditions.length;
    loan.conditions = loan.conditions.filter((c) => c && c.id !== cid);
    if (loan.conditions.length === before) return json(404, { error: 'Condition not found' });
  }

  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, conditions: loan.conditions });
}
