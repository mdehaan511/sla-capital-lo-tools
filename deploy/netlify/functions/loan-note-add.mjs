/**
 * loan-note-add.mjs — POST /api/loan-note-add
 *
 * Deploy 226 — appends a single entry to a loan's notesLog audit trail.
 * Used by the manual "Add Note" box on Loan Details, and by the
 * pipeline pre-discussed submit flow for the long-form details capture.
 *
 * Body: { clientId, loanId, text, kind?, meta?, owner? }
 *   - kind defaults to 'manual'
 *   - owner is admin-only override (route to another LO's record)
 *
 * Returns: { ok: true, entry, loan }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';
// Deploy 237.050 (Mike) -- @-mentions: roster check + bell + email fan-out.
import { db } from './_shared/supabase-db.mjs';
import { pushUserNotification } from './_shared/user-notifications.mjs';
import { notifyMention, getOwnerReplyTo } from './_shared/email.mjs';

const ALLOWED_KINDS = new Set([
  'manual', 'submit', 'pre_discussed', 'reprice',
  'decision', 'decline', 'app_sent', 'app_received',
  'status', 'system',
]);

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-note-add error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Body required' });
  if (!body.clientId || !body.loanId) return json(400, { error: 'clientId and loanId required' });

  const text = String(body.text || '').trim();
  if (!text) return json(400, { error: 'text required' });
  if (text.length > 8000) return json(400, { error: 'text too long (max 8000 chars)' });

  const kind = body.kind || 'manual';
  if (!ALLOWED_KINDS.has(kind)) return json(400, { error: 'Invalid kind' });

  // Deploy 237.050 (Mike) -- @-mentions of SLA users. The composer sends
  // [{email, name}] for the people picked from the users directory; keep only
  // real team members (sla_user_roles; domain check if the table read fails),
  // never the author, deduped. Fan-out happens AFTER the note is saved.
  let mentions = [];
  if (kind === 'manual' && Array.isArray(body.mentions) && body.mentions.length) {
    const seen = new Set();
    const raw = body.mentions.slice(0, 20).map((m) => ({
      email: normalizeEmail(typeof m === 'string' ? m : ((m && m.email) || '')),
      name: String((m && m.name) || '').replace(/[<>]/g, '').trim().slice(0, 80),
    })).filter((m) => m.email && m.email.indexOf('@') > 0 && m.email !== normalizeEmail(user.email) && !seen.has(m.email) && seen.add(m.email));
    if (raw.length) {
      let roster = null;
      try {
        const rows = await db.select('sla_user_roles', { select: 'email,roles' });
        roster = new Set((rows || []).map((r) => normalizeEmail(r.email || '')).filter(Boolean));
      } catch (e) { console.warn('loan-note-add: roster read failed, falling back to the team domain:', e && e.message); }
      mentions = raw.filter((m) => (roster ? roster.has(m.email) : /@slacapital\.com$/.test(m.email)));
    }
  }

  // Resolve owner — admin can override, otherwise it's the caller.
  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);
  const key = `${ownerKey}/${keySafe(body.clientId)}`;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client;
  try {
    client = await clientsStore.get(key, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load client' });
  }
  if (!client) return json(404, { error: 'Client not found' });

  const loans = Array.isArray(client.loans) ? client.loans : [];
  const idx = loans.findIndex((l) => l && l.id === body.loanId);
  if (idx < 0) return json(404, { error: 'Loan not found' });
  const loan = loans[idx];

  // Best-effort author display name from the Netlify Identity user metadata.
  const meta = (user && user.user_metadata) || {};
  const author = meta.full_name || meta.fullName || user.email || '';

  const entry = appendNoteEntry(loan, {
    kind,
    text,
    author,
    authorEmail: user.email || '',
    meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
  });
  if (mentions.length) entry.mentions = mentions; // Deploy 237.050 -- rendered as highlights on Loan Details
  loan.updatedAt = new Date().toISOString();

  try {
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient.
    // (Note: the PG mirror used to be keyed by the raw owner email
    // here — now normalized to ownerKey like every other endpoint.)
    await writeClient(ownerKey, client, { clientsStore });
  } catch (e) {
    return json(500, { error: 'Failed to save client' });
  }

  // Deploy 237.050 -- mention fan-out, after the save so a notification never
  // points at a note that failed to persist. Best-effort: never fails the note.
  let notified = 0;
  if (mentions.length) {
    const loanUrl = 'https://portal.slacapital.ai/loan-details/' + encodeURIComponent(loan.id) + '?owner=' + encodeURIComponent(owner);
    const borrower = ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || client.entityName || '';
    const snippet = text.length > 160 ? text.slice(0, 157) + '...' : text;
    const fromEmail = normalizeEmail(user.email);
    let replyTo = '';
    try { replyTo = await getOwnerReplyTo(keySafe(fromEmail)); } catch (_) {}
    await Promise.all(mentions.map(async (m) => {
      try {
        await pushUserNotification(m.email, {
          kind: 'mention', fromEmail, fromName: author, loanId: loan.id, clientId: client.id, owner,
          address: loan.address || '', borrower, noteId: entry.id, snippet,
        });
        notified++;
      } catch (e) { console.warn('loan-note-add: notification push failed for', m.email, e && e.message); }
      try { await notifyMention({ toEmail: m.email, fromEmail, fromName: author, address: loan.address || '', borrower, text, loanUrl, replyTo }); }
      catch (e) { console.warn('loan-note-add: mention email failed for', m.email, e && e.message); }
    }));
  }

  return json(200, { ok: true, entry, loan, notified });
}
