/**
 * _shared/notes-log.mjs — Append-only audit log for loan notes.
 *
 * Deploy 226 — replaced the free-form `loan.notes` string with a
 * structured `loan.notesLog` array so the Loan Details page can
 * render a timestamped audit trail. Old records still have the
 * legacy `loan.notes` field; it's shown as a single bottom entry
 * but never appended to by anything new.
 *
 * Entry shape:
 *   {
 *     id:     'n_<timestamp>_<random>',   // unique id (for React-style keys / dedupe)
 *     ts:     '2026-05-26T22:01:43.000Z',  // ISO timestamp
 *     author: 'Mike DeHaan',               // display name (best-effort)
 *     authorEmail: 'mike@slacapital.com',  // email of the actor
 *     kind:   'manual' | 'submit' | 'pre_discussed' | 'reprice' |
 *             'decision' | 'decline' | 'app_sent' | 'app_received' |
 *             'status' | 'system',
 *     text:   '...',                       // free-form body
 *     meta?:  { ... },                     // per-kind structured fields
 *   }
 *
 * Callers MUTATE the passed-in loan object directly (push onto
 * loan.notesLog). The caller is responsible for saving the client
 * record back to the blob store afterwards.
 */

export function makeNoteId() {
  return 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Append a single entry to loan.notesLog. Creates the array if missing.
 * Returns the entry that was appended (with id + ts filled in).
 *
 * @param {object} loan — the loan object (will be mutated)
 * @param {object} entry — partial entry. ts + id are auto-filled if missing.
 */
export function appendNoteEntry(loan, entry) {
  if (!loan || typeof loan !== 'object') return null;
  if (!Array.isArray(loan.notesLog)) loan.notesLog = [];

  const e = {
    id:          entry.id    || makeNoteId(),
    ts:          entry.ts    || new Date().toISOString(),
    author:      entry.author || '',
    authorEmail: entry.authorEmail || '',
    kind:        entry.kind  || 'manual',
    text:        String(entry.text || '').trim(),
  };
  if (entry.meta && typeof entry.meta === 'object') {
    e.meta = entry.meta;
  }
  loan.notesLog.push(e);
  return e;
}

/**
 * Convenience — append a "system" entry from a backend caller where the
 * actor is the SLA platform itself (not a real LO/admin user).
 */
export function appendSystemNote(loan, kind, text, meta) {
  return appendNoteEntry(loan, {
    kind:        kind || 'system',
    text:        text || '',
    author:      'SLA Platform',
    authorEmail: 'system@slacapital.com',
    meta:        meta || undefined,
  });
}

/**
 * Detect a meaningful change between old and new loan values for the
 * "reprice" auto-entry. Returns a human-readable summary string + a
 * meta object with from/to values, or null if nothing meaningful changed.
 *
 * "Meaningful" = rate, loanAmt, points, or term differs.
 */
export function describeReprice(oldLoan, newLoan) {
  if (!oldLoan || !newLoan) return null;
  const changes = [];
  const meta = {};

  const fields = [
    ['rate',    'Rate',          (v) => v == null || v === '' ? null : (Number(v).toFixed(3) + '%')],
    ['loanAmt', 'Loan amount',   (v) => v == null || v === '' ? null : ('$' + Number(v).toLocaleString())],
    ['points',  'Points',        (v) => v == null || v === '' ? null : (Number(v).toFixed(2))],
    ['term',    'Term (months)', (v) => v == null || v === '' ? null : String(v)],
  ];
  for (const [key, label, fmt] of fields) {
    const a = oldLoan[key];
    const b = newLoan[key];
    // Loose numeric comparison so '10.5' and 10.5 don't flag as changes.
    const aNum = a == null || a === '' ? null : Number(a);
    const bNum = b == null || b === '' ? null : Number(b);
    if (aNum === bNum) continue;
    const aStr = fmt(a);
    const bStr = fmt(b);
    if (aStr === bStr) continue; // formatted strings match (e.g. precision-only diff)
    changes.push(label + ': ' + (aStr || '—') + ' → ' + (bStr || '—'));
    meta[key] = { from: a == null ? null : a, to: b == null ? null : b };
  }
  if (!changes.length) return null;
  return { text: 'Reprice — ' + changes.join('; '), meta };
}
