/**
 * loan-followup-done.mjs — POST /api/loan-followup-done
 *
 * Deploy 236.823 — closing-anniversary borrower follow-ups (Mike). LOs check
 * in with borrowers 7 / 30 / 90 / 120 / 240 / 365 days after a loan closes.
 * The Closed Loans "Follow-ups" tab lists each pending anniversary; this
 * endpoint records that the LO made the touch (or undoes a mis-click).
 *
 * Stamps loan.anniversaryFollowUps[milestone] = { doneAt, doneBy, note } and
 * appends a Notes & Activity entry so the touch history lives on the loan.
 *
 * Body: { clientId, loanId, owner?, milestone: 'd7'|'d30'|'d90'|'d120'|'d240'|'d365',
 *         note?, undo? }
 * Auth: the loan's owner, or processor/admin (owner override).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

const MILESTONES = ['d7', 'd30', 'd90', 'd120', 'd240', 'd365'];
const MILESTONE_LABEL = { d7: '7-day', d30: '30-day', d90: '90-day', d120: '120-day', d240: '240-day', d365: '365-day' };

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-followup-done error:', e);
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
  if (!body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanId)   return json(400, { error: 'loanId required' });
  const milestone = String(body.milestone || '');
  if (!MILESTONES.includes(milestone)) return json(400, { error: 'milestone must be one of ' + MILESTONES.join(', ') });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin/processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(body.clientId), { type: 'json' }).catch(() => null);
  if (!client) return json(404, { error: 'Client not found' });
  const loan = (client.loans || []).find((l) => l && l.id === body.loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });

  const now = new Date().toISOString();
  const map = Object.assign({}, loan.anniversaryFollowUps || {});
  const label = MILESTONE_LABEL[milestone];

  if (body.undo) {
    if (!map[milestone]) return json(200, { ok: true, milestone, undone: false, alreadyClear: true });
    delete map[milestone];
    loan.anniversaryFollowUps = map;
  } else {
    if (map[milestone]) return json(200, { ok: true, milestone, entry: map[milestone], alreadyDone: true });
    const note = String(body.note || '').trim().slice(0, 2000);
    const meta = (user && user.user_metadata) || {};
    const authorName = meta.full_name || meta.fullName || user.email || '';
    map[milestone] = { doneAt: now, doneBy: selfEmail, note };
    loan.anniversaryFollowUps = map;
    appendNoteEntry(loan, {
      kind:  'status',
      text:  label + ' closing follow-up completed' + (note ? ' — ' + note : ''),
      author: authorName,
      authorEmail: selfEmail,
      meta: { via: 'anniversary_followup', milestone },
    });
  }
  loan.updatedAt = now;
  client.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, milestone, entry: map[milestone] || null, undone: !!body.undo });
}
