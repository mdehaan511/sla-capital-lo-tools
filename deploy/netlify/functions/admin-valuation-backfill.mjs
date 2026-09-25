/**
 * admin-valuation-backfill.mjs — POST /api/admin-valuation-backfill (admin)
 *
 * Deploy 237.275 (Mike: "make sure we grab that from the appropriate document when uploaded and
 * use that for the Colchis and Trade tapes").
 *
 * A BPO / appraisal that was READ but whose AIV / ARV never reached the loan still holds the
 * reading on its tray (aiExtractedFields) -- the background reviewer threw at its write for three
 * weeks (fixed 237.223), so eight RTL loans (4113 Rambling Road among them) had a read BPO and an
 * empty AIV / ARV, and the tape fell back to the borrower's ARV. This walks every RTL / GUC review
 * and puts that reading on the loan through the same writeFieldProposals a fresh read uses (the
 * FromBpo stamp, the Audit Log entry, the Postgres mirror). **No AI is called.**
 *
 *   - Only aivBpo / arvBpo, only answers the AI marked found, only positive numbers.
 *   - A tray read before the AIV question existed contributes its As-Is answer as the AIV.
 *   - A loan that already carries a DOCUMENT figure for a key (FromBpo, or an underwriter's
 *     matching override) is left alone for that key; a typed estimate is replaced.
 *   - The appraisal is applied after the BPO, so it wins when both were read (as on the tape).
 *
 * Body: { dryRun?: boolean (default TRUE -- pass false to write), loanIds?: string[] }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail } from './_shared/auth.mjs';
import { fieldsForSlug } from './_shared/uw-field-map.mjs';
import { buildProposals, writeFieldProposals } from './_shared/uw-field-write.mjs';

const KEYS = ['aivBpo', 'arvBpo'];
const SLUGS = ['bpo_valuation', 'appraisal']; // applied in this order: the appraisal wins
const n = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0;

// Does the loan already carry a figure a DOCUMENT (or underwriting) put there for this key?
export function hasDocValue(loan, key) {
  const v = n(loan && loan[key]);
  if (!(v > 0)) return false;
  if (loan[key + 'FromBpo'] === true) return true;
  const ov = loan[key + 'UwOverride'];
  return !!(ov && typeof ov === 'object' && n(ov.value) === v);
}

// The tray's reading as loan proposals (aivBpo / arvBpo only).
export function trayValuationProposals(slug, tray, loanType) {
  const spec = (fieldsForSlug(slug, loanType) || []).filter((f) => f.dataset === 'loan' && KEYS.indexOf(f.key) >= 0);
  if (!spec.length || !tray || !tray.aiExtractedFields) return [];
  const ef = Object.assign({}, tray.aiExtractedFields);
  const found = (k) => !!(ef[k] && ef[k].found === true && n(ef[k].value) > 0);
  if (!found('aivBpo') && found('asIsPrice')) ef.aivBpo = Object.assign({}, ef.asIsPrice);
  const label = slug === 'appraisal' ? 'Appraisal' : 'BPO / Valuation';
  return (buildProposals(spec, ef, label) || []).filter((p) => KEYS.indexOf(p.key) >= 0 && n(p.value) > 0);
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const body = (await readJsonBody(req)) || {};
    const dryRun = body.dryRun !== false;
    const only = Array.isArray(body.loanIds) && body.loanIds.length ? new Set(body.loanIds.map(String)) : null;
    const actor = normalizeEmail(user.email || '') || 'admin';

    const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const { blobs } = await reviewStore.list();
    const out = { dryRun, reviews: blobs.length, withReading: 0, alreadyOnLoan: 0, noLoan: 0, updated: 0, errors: 0, loans: [] };

    for (const { key } of blobs) {
      const review = await reviewStore.get(key, { type: 'json' }).catch(() => null);
      const src = review && review.source;
      if (!src || src.kind !== 'existing' || !src.loanId || !src.clientId || !src.ownerKey) continue;
      if (only && !only.has(String(src.loanId))) continue;
      const docs = review.docs || {};
      const perSlug = [];
      for (const slug of SLUGS) {
        const d = docs[slug];
        if (!d || d.hidden || d.verdict === 'na') continue;
        const props = trayValuationProposals(slug, d, review.loanType);
        if (props.length) perSlug.push({ slug, props });
      }
      if (!perSlug.length) continue;
      out.withReading += 1;

      const client = await clientsStore.get(keySafe(src.ownerKey) + '/' + keySafe(src.clientId), { type: 'json' }).catch(() => null);
      const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === src.loanId) : null;
      if (!loan) { out.noLoan += 1; continue; }
      const want = KEYS.filter((k) => !hasDocValue(loan, k));
      const apply = perSlug.map((x) => ({ slug: x.slug, props: x.props.filter((p) => want.indexOf(p.key) >= 0) })).filter((x) => x.props.length);
      if (!apply.length) { out.alreadyOnLoan += 1; continue; }

      const row = { loanId: src.loanId, owner: src.ownerKey, address: loan.address || review.address || '', status: loan.status || '',
        before: { aivBpo: loan.aivBpo || '', arvBpo: loan.arvBpo || '' }, after: {} };
      apply.forEach((x) => x.props.forEach((p) => { row.after[p.key] = { value: String(n(p.value)), from: x.slug }; }));
      if (!dryRun) {
        try {
          for (const x of apply) await writeFieldProposals(src, x.props, actor);
          row.written = true; out.updated += 1;
        } catch (e) {
          row.error = (e && e.message) || 'write failed'; out.errors += 1;
        }
      }
      out.loans.push(row);
    }
    return json(200, out);
  } catch (e) {
    console.error('admin-valuation-backfill error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
