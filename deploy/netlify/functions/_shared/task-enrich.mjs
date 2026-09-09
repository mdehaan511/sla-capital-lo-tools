/**
 * _shared/task-enrich.mjs — Deploy 236.931
 *
 * Mike: "on that tasks page, for Loan column put the address instead of the
 * loan number and also for Assignee put Assignee name instead of email."
 *
 * A task record carries loanId + assignedTo (an email) and, only when the
 * picker supplied one, assignedToName. tasks-list decorates every task on
 * the way out with `address` (PG loans — one query per response) and a
 * display name for the assignee / creator (profiles store, read BY KEY per
 * distinct email — never a scan), so every surface reading tasks (Tasks
 * page, the Loan Details card, the nav badge) sees the same thing. Nothing
 * here is persisted; a loader failure just leaves the client to fall back.
 */
import { getStore } from '@netlify/blobs';
import { db } from './supabase-db.mjs';
import { keySafe, normalizeEmail } from './auth.mjs';

/** 'carl.davis@slacapital.com' → 'Carl Davis'; 'sara.s@…' → 'Sara S'; '' → ''. Pure. */
export function prettyNameFromEmail(email) {
  const local = String(email || '').trim().toLowerCase().split('@')[0];
  if (!local) return '';
  if (local === 'system') return 'SLA Platform';
  return local.split(/[._-]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The name a profile record carries, in the shapes this codebase has used. Pure. */
export function profileName(p) {
  if (!p || typeof p !== 'object') return '';
  const meta = p.user_metadata || {};
  const full = String(p.fullName || p.full_name || meta.full_name || meta.fullName || p.displayName || p.name || '').trim();
  if (full) return full;
  return [p.firstName, p.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
}

/** Decorate tasks in place from the two lookup maps. Pure given the maps. */
export function applyEnrichment(tasks, addrByLoan = {}, nameByEmail = {}) {
  const nameFor = (email) => {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return '';
    return nameByEmail[e] || prettyNameFromEmail(e);
  };
  for (const t of tasks || []) {
    if (!t || typeof t !== 'object') continue;
    const addr = addrByLoan[String(t.loanId || '')];
    if (addr) t.address = addr;
    else if (t.address == null) t.address = '';
    if (!String(t.assignedToName || '').trim()) t.assignedToName = nameFor(t.assignedTo);
    if (!String(t.createdByName || '').trim()) t.createdByName = nameFor(t.createdBy);
  }
  return tasks;
}

function _chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Best-effort loaders + applyEnrichment. Never throws. */
export async function enrichTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return list;

  const addrByLoan = {};
  try {
    const ids = Array.from(new Set(list.map((t) => String((t && t.loanId) || '')).filter(Boolean)));
    for (const chunk of _chunk(ids, 100)) {
      const rows = await db.select('loans', { select: 'id,address', in: { id: chunk }, limit: chunk.length });
      for (const r of rows || []) if (r && r.id && r.address) addrByLoan[r.id] = String(r.address);
    }
  } catch (e) { console.warn('task-enrich: address lookup failed (non-fatal):', e && e.message); }

  const nameByEmail = {};
  try {
    const emails = Array.from(new Set(list.flatMap((t) => [t && t.assignedTo, t && t.createdBy])
      .map((e) => String(e || '').trim().toLowerCase()).filter((e) => e && e.indexOf('@') > 0)));
    const store = getStore({ name: 'profiles', consistency: 'eventual' });
    await Promise.all(emails.map(async (e) => {
      const p = await store.get(keySafe(normalizeEmail(e)), { type: 'json' }).catch(() => null);
      const n = profileName(p);
      if (n) nameByEmail[e] = n;
    }));
  } catch (e) { console.warn('task-enrich: name lookup failed (non-fatal):', e && e.message); }

  return applyEnrichment(list, addrByLoan, nameByEmail);
}
