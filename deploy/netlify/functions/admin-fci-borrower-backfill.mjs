/**
 * admin-fci-borrower-backfill.mjs — POST /api/admin-fci-borrower-backfill
 *
 * Deploy 236.810 (Mike) — the Baseline-imported closed loans carry a client
 * record with NO name, NO email and NO company at all. FCI has a borrower name,
 * email and mobile for every loan it services, so this fills ours in.
 *
 * Per loan, from FCI's borrowerEmail:
 *   • a client under the same owner ALREADY has that email  → link that client
 *     to the loan (see "linking" below) and leave both records alone otherwise
 *   • no client has it, and the loan's own client is an empty husk → fill the
 *     husk in place with FCI's name / email / phone
 *   • no client has it, and the loan's client has a NAME but no email → add the
 *     email (and phone/company only where those are blank too). Adding an email
 *     to a record that has none destroys nothing, and this is most of the real
 *     population — see needsEmailOnly()
 *   • the client already has an email and it DISAGREES with FCI's → leave it
 *     alone and report it; a sync must not overwrite contact details a human
 *     entered
 *
 * Every write fills BLANKS ONLY. No existing value is ever replaced.
 *
 * ── Why we fill the husk instead of creating a new client ────────────
 * Loans are NESTED under a client blob, so "create the client and move the loan"
 * means changing the loan's clientId — and clientId is a composite key for
 * borrower_info, doc reviews, loan_access grants and every /loan-details URL
 * anyone has bookmarked. Filling the husk produces exactly the record a fresh
 * create would, with none of that breakage. The husk IS the borrower's client
 * record; it was just never populated.
 *
 * ── Linking, when the borrower already exists elsewhere ──────────────
 * Same reason, so the loan is NOT moved. The existing client is attached to the
 * loan through the normal guarantor linkage (loan.guarantorClientIds — the same
 * mechanism Loan Details uses), which is additive and reversible, and the husk
 * still gets the contact details so the loan itself is reachable. Anything that
 * would move a loan between clients is reported, never done.
 *
 * ── Entity names ─────────────────────────────────────────────────────
 * FCI's borrowerFullName is frequently an entity, and often BOTH, newline
 * separated: "Ryle Knox Real Estate LLC\nRylee Knox". We split that into
 * company + person rather than jamming an LLC into firstName.
 *
 * Body: { dryRun (default TRUE), limit, apply }
 * Admin/processor only. Strict writeClient throughout.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { findClientByEmail } from './_shared/client-lookup.mjs';
import { fciConfigured, fciPortfolio } from './_shared/fci-api.mjs';

// Matches an entity marker ANYWHERE in the line, not just at the end. FCI has
// real values like "Xarnest, LLC - 002, Protec" where the suffix is mid-string;
// anchoring to $ read that whole thing as a person called "Xarnest,".
// Deliberately no bare "CO" — it would swallow surnames like "Cortez".
const ENTITY_RE = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|COMPANY|LP|LLP|TRUST|PARTNERS|HOLDINGS|PROPERTIES|PROPERTY|GROUP|REALTY|CAPITAL|VENTURES|ENTERPRISES|CONSULTING|MANAGEMENT|INVESTMENTS?|SOLUTIONS|DEVELOPMENT|CONTRACTING|RENOVATIONS?|ASSOCIATES|FUND|HOMES|ESTATE)\b/i;

/** "Ryle Knox Real Estate LLC\nRylee Knox" → { company, firstName, lastName } */
export function splitBorrowerName(raw) {
  const lines = String(raw || '')
    .split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  let company = '', person = '';
  for (const line of lines) {
    if (!company && ENTITY_RE.test(line)) { company = line; continue; }
    if (!person) person = line;
  }
  // A single line that isn't an entity is the person.
  if (!company && !person && lines.length) person = lines[0];
  let firstName = '', lastName = '';
  if (person) {
    const parts = person.split(/\s+/).filter(Boolean);
    firstName = parts.shift() || '';
    // Drop a middle INITIAL ("Timothy G Roberts" → Timothy / Roberts) but keep
    // real multi-word surnames ("Van Der Berg") intact.
    const rest = parts.filter((p, i) => !(i === 0 && parts.length > 1 && /^[A-Za-z]\.?$/.test(p)));
    lastName = rest.join(' ');
  }
  return { company, firstName, lastName };
}

const _has = (v) => !!String(v == null ? '' : v).trim();

/** A client nobody has filled in: no email, no name, no company. */
function isHusk(c) {
  if (!c) return true;
  return !_has(c.email) && !_has(c.firstName) && !_has(c.lastName)
      && !_has(c.company) && !_has(c.entityName);
}

/**
 * Deploy 236.811 — a client with a NAME but no EMAIL.
 *
 * The first pass treated these as "already filled in" and skipped them, which
 * put 11 loans in the conflict bucket reading `ours: (no email)` — the exact
 * case that was supposed to be fixed. Adding an email to a record that has none
 * destroys nothing, so these get the email (and phone/company only where those
 * are also blank). The name the team entered is never touched.
 */
function needsEmailOnly(c) {
  return !!c && !_has(c.email) && (_has(c.firstName) || _has(c.lastName) || _has(c.company) || _has(c.entityName));
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-fci-borrower-backfill error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });
  if (!fciConfigured()) return json(503, { error: 'FCI_API_TOKEN is not set on this site' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = !(body.apply === true || body.dryRun === false);
  const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 200;
  const actor = normalizeEmail(user.email);

  const rows = await fciPortfolio();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // Index our loans by the FCI account the sync stamped.
  const byAccount = new Map();  // account -> [{ownerKey, clientId, loanId}]
  const { blobs } = await clientsStore.list();
  const CONC = 40;
  for (let i = 0; i < blobs.length; i += CONC) {
    const chunk = blobs.slice(i, i + CONC);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' }).then((c) => ({ key, c })).catch(() => ({ key, c: null }))));
    for (const { key, c } of recs) {
      const slash = key.indexOf('/'); if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      if (!c || !Array.isArray(c.loans)) continue;
      for (const loan of c.loans) {
        const acct = loan && String(loan.servicerLoanNumber || '').trim();
        if (!acct) continue;
        if (!byAccount.has(acct)) byAccount.set(acct, []);
        byAccount.get(acct).push({ ownerKey, clientId: c.id, loanId: loan.id });
      }
    }
  }

  const plan = [], skipped = [], errors = [];
  const counts = { fill_husk: 0, fill_email: 0, link_existing: 0, already_named: 0, no_fci_email: 0, not_linked: 0, conflict: 0 };

  for (const row of rows) {
    const acct = String(row.loanAccount || '').trim();
    const email = normalizeEmail(row.borrowerEmail || '');
    const targets = byAccount.get(acct) || [];

    if (!targets.length) { counts.not_linked++; continue; }
    if (!email || !email.includes('@')) {
      counts.no_fci_email++;
      skipped.push({ account: acct, reason: 'FCI has no borrower email' });
      continue;
    }

    const name = splitBorrowerName(row.borrowerFullName);
    for (const t of targets) {
      const client = await clientsStore
        .get(t.ownerKey + '/' + keySafe(t.clientId), { type: 'json' }).catch(() => null);
      if (!client) { errors.push({ account: acct, error: 'client vanished' }); continue; }

      const husk = isHusk(client);
      const emailOnly = needsEmailOnly(client);

      // A named client that already carries an email: nothing to do, unless the
      // email genuinely disagrees with FCI's — and that we only ever report.
      if (!husk && !emailOnly) {
        if (normalizeEmail(client.email || '') === email) counts.already_named++;
        else {
          counts.conflict++;
          skipped.push({
            account: acct, loanId: t.loanId, reason: 'client email differs from FCI',
            ours: client.email || '', fci: email,
            name: ((client.firstName || '') + ' ' + (client.lastName || '')).trim(),
          });
        }
        continue;
      }

      // Does this borrower already exist as a client under the same owner?
      const existing = await findClientByEmail(t.ownerKey, email, clientsStore).catch(() => null);
      const action = (existing && existing.client && existing.client.id !== t.clientId)
        ? 'link_existing'
        : (husk ? 'fill_husk' : 'fill_email');
      counts[action]++;
      plan.push({
        action, account: acct, ownerKey: t.ownerKey, clientId: t.clientId, loanId: t.loanId,
        email, company: name.company, firstName: name.firstName, lastName: name.lastName,
        phone: String(row.borrowerMobilePhone || '').trim(),
        existingClientId: existing && existing.client ? existing.client.id : '',
        existingName: existing && existing.client
          ? ((existing.client.firstName || '') + ' ' + (existing.client.lastName || '')).trim() : '',
      });
    }
  }

  plan.sort((a, b) => (a.ownerKey + a.clientId + a.loanId).localeCompare(b.ownerKey + b.clientId + b.loanId));

  // ── Apply ──────────────────────────────────────────────────────────
  let filled = 0, linked = 0, noop = 0;
  if (!dryRun) {
    const now = new Date().toISOString();
    for (const p of plan.slice(0, limit)) {
      try {
        const key = p.ownerKey + '/' + keySafe(p.clientId);
        const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
        if (!client) { errors.push({ account: p.account, error: 'client vanished before write' }); continue; }
        // Re-check against the CURRENT record. This is normally a NO-OP, not a
        // failure: one FCI account maps to several SLA loan records that share a
        // client (the 236.720 reconcile stamped every duplicate of a property),
        // so once the first row writes, the rest legitimately find the email
        // already there. Counting those as errors made a clean run of 18 report
        // "8 errors". They are counted separately as noop.
        if (_has(client.email)) { noop++; continue; }
        if (!isHusk(client) && !needsEmailOnly(client)) { noop++; continue; }

        // The email is the whole point and is always safe to add (we only get
        // here when the record has none). Everything else fills BLANKS ONLY —
        // never overwrite a name or company a human typed.
        client.email = p.email;
        if (p.firstName && !_has(client.firstName)) client.firstName = p.firstName;
        if (p.lastName && !_has(client.lastName)) client.lastName = p.lastName;
        if (p.company && !_has(client.company) && !_has(client.entityName)) client.company = p.company;
        if (p.phone && !_has(client.phone)) client.phone = p.phone;
        client.updatedAt = now;
        client._fciBorrowerBackfillAt = now;
        client._fciBorrowerBackfillBy = actor;

        if (p.action === 'link_existing' && p.existingClientId) {
          // Additive + reversible. The loan is NOT moved — see the header.
          const loan = (client.loans || []).find((l) => l && l.id === p.loanId);
          if (loan) {
            const ids = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
            if (ids.indexOf(p.existingClientId) < 0) ids.push(p.existingClientId);
            loan.guarantorClientIds = ids;
            loan.updatedAt = now;
          }
          linked++;
        } else {
          filled++;
        }

        await writeClient(p.ownerKey, client, { clientsStore });
      } catch (e) {
        errors.push({ account: p.account, error: 'write failed: ' + ((e && e.message) || '') });
      }
    }
  }

  return json(200, {
    ok: true, dryRun,
    fciLoans: rows.length,
    counts,
    planned: plan.length,
    applied: dryRun ? 0 : (filled + linked),
    filled, linked, noop,
    errors: errors.length,
    sample: plan.slice(0, 12).map((p) =>
      p.action + ' | ' + p.account + ' | ' + (p.company || '(no entity)') + ' | ' +
      ((p.firstName + ' ' + p.lastName).trim() || '(no person)') + ' | ' + p.email),
    skipped: skipped.slice(0, 25),
    errorDetail: errors.slice(0, 15),
  });
}
