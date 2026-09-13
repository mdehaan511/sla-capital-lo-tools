/**
 * _shared/client-save-merge.mjs — Deploy 236.999 (whole-app cleanup scan)
 *
 * Keeps a SUMMARY round-trip from destroying data in clients-save.
 *
 * SLA.Clients.list() returns summary-projected records (Deploy 236.346): no
 * addresses, companies cut to { id, name }, loans without notesLog / notes /
 * submittedAt. Several pages take a record from that list, change one thing
 * and send the whole client to /api/clients-save (Pipeline's pre-discuss and
 * Submit-for-UW paths did; the Clients page ClientBook helper still can).
 * clients-save already restored loan keys the payload OMITTED, but:
 *   - the CLIENT itself was replaced wholesale → home/mailing addresses,
 *     company EINs/addresses and every other field the summary doesn't
 *     carry were wiped;
 *   - the page started a fresh notesLog array on the summary loan and pushed
 *     one entry, so the key was PRESENT and replaced the loan's entire
 *     notes history;
 *   - submittedAt was re-stamped on every submit.
 *
 * Rules (the same omission rule the loan merge already follows):
 *   1. A client-level key present on the stored record but ABSENT from the
 *      payload is kept. To clear a field, send it as '' / null.
 *   2. Company entries matched by id (else by name) get their missing
 *      sub-fields back. A company left out of the array stays removed.
 *   3. A loan's notesLog is the UNION of stored and incoming entries by
 *      entry id (incoming wins for an id present in both), in timestamp
 *      order. Notes are edited/deleted through loan-note-edit / loan-note-pin,
 *      never through clients-save, so a union can't resurrect a deletion.
 *   4. A loan's submittedAt keeps the EARLIEST value — it records the first
 *      submission.
 *
 * Pure (no IO) so scripts/client-save-merge-test.mjs can exercise it.
 */
export function preserveOmittedClientFields(existing, record) {
  if (!existing || !record || typeof existing !== 'object' || typeof record !== 'object') return record;

  // 1. Client-level keys the payload omitted.
  for (const k of Object.keys(existing)) {
    if (!(k in record)) record[k] = existing[k];
  }

  // 2. Company sub-fields.
  if (Array.isArray(existing.companies) && Array.isArray(record.companies)) {
    const byId = new Map();
    const byName = new Map();
    for (const co of existing.companies) {
      if (!co || typeof co !== 'object') continue;
      if (co.id) byId.set(co.id, co);
      if (co.name) byName.set(String(co.name).toLowerCase().trim(), co);
    }
    record.companies = record.companies.map((co) => {
      if (!co || typeof co !== 'object') return co;
      const prior = (co.id && byId.get(co.id)) || (co.name && byName.get(String(co.name).toLowerCase().trim())) || null;
      if (!prior) return co;
      const out = { ...co };
      for (const k of Object.keys(prior)) {
        if (!(k in co)) out[k] = prior[k];
      }
      return out;
    });
  }

  // 3 + 4. Loan collections.
  if (Array.isArray(existing.loans) && Array.isArray(record.loans)) {
    const priorById = new Map();
    for (const l of existing.loans) {
      if (l && l.id) priorById.set(l.id, l);
    }
    const when = (n) => String((n && (n.ts || n.at || n.createdAt)) || '');
    record.loans = record.loans.map((l) => {
      if (!l || typeof l !== 'object' || !l.id) return l;
      const prior = priorById.get(l.id);
      if (!prior) return l;
      if (Array.isArray(prior.notesLog) && prior.notesLog.length) {
        const incoming = Array.isArray(l.notesLog) ? l.notesLog : [];
        const ids = new Set(incoming.map((n) => n && n.id).filter(Boolean));
        const missing = prior.notesLog.filter((n) => n && n.id && !ids.has(n.id));
        if (missing.length) {
          l.notesLog = missing.concat(incoming).sort((a, b) => when(a).localeCompare(when(b)));
        }
      }
      if (prior.submittedAt && l.submittedAt && String(l.submittedAt) > String(prior.submittedAt)) {
        l.submittedAt = prior.submittedAt;
      }
      return l;
    });
  }

  return record;
}
