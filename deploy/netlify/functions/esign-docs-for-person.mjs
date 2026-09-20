/**
 * esign-docs-for-person.mjs — GET /api/esign-docs-for-person
 *
 * Deploy 237.167 (Mike): "once completed [e-signed docs] should be able to be linked to
 * the profiles of people (borrowers, brokers, investors) and be able to be seen in their
 * profiles as documents."
 *
 * Every EXECUTED e-sign document that belongs to one person, newest first — for the
 * Documents section on client-details.html (borrowers AND brokers, which are clients with
 * _isBroker and open on that same page) and on the investor record.
 *
 * Query: ?kind=client|broker|investor & id=<record id> [& owner=<ownerKey for a client>]
 *
 * The person record is loaded HERE rather than trusted from the caller, so a viewer can
 * only ask "what does this record have" and never "what does this email address have".
 *
 * Read-only. Ends in -for-person so the owner "view as user" read allowlist accepts it
 * (see project_owner_view_as: new read POSTs must end -list/-get/-find/-fetch/-search —
 * this is a GET, which that gate lets through, but keep it read-only regardless).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { listSummaries, flattenSummaries } from './_shared/esign-docs.mjs';
import { docsForPerson } from './_shared/esign-people.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const url = new URL(req.url);
    const kind = String(url.searchParams.get('kind') || '').toLowerCase();
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) return json(400, { error: 'id required' });
    if (['client', 'broker', 'investor'].indexOf(kind) < 0) {
      return json(400, { error: 'kind must be client, broker or investor' });
    }

    const selfEmail = normalizeEmail(user.email);
    const staff = isAdmin(user) || isProcessor(user);

    // ── load the person ───────────────────────────────────────────────────
    let person = null;
    if (kind === 'investor') {
      // Investors are org-wide (investors-save.mjs keys them by id alone).
      const store = getStore({ name: 'investors', consistency: 'strong' });
      person = await store.get(keySafe(id), { type: 'json' }).catch(() => null);
    } else {
      // Clients and brokers are owner-scoped. Default to the caller's own book; an
      // explicit owner needs staff, the same rule every other cross-owner read uses.
      let ownerKey = keySafe(selfEmail);
      const wanted = String(url.searchParams.get('owner') || '').trim();
      if (wanted && normalizeEmail(wanted) !== selfEmail) {
        if (!staff) return json(403, { error: 'Owner override requires admin' });
        ownerKey = keySafe(normalizeEmail(wanted));
      }
      const store = getStore({ name: 'clients', consistency: 'strong' });
      person = await store.get(ownerKey + '/' + keySafe(id), { type: 'json' }).catch(() => null);
    }
    if (!person) return json(404, { error: 'Record not found' });

    // listSummaries() is a byOwner MAP -- flatten it. Reading every owner's documents
    // here is deliberate: the e-sign index is org-wide and visibleTo() below is the gate
    // that decides who may see what, so scoping the SCAN would hide a document that the
    // viewer is entitled to (the Nikki Rickard broker agreement, signed under mike@, on
    // a broker record owned by jeremy@). Deploy 237.201.
    const summaries = flattenSummaries(await listSummaries());
    // No kind filter: record ids are unique by prefix (c_* / inv_*), and a broker IS a
    // client, so a link filed as 'client' must still show on the broker view of the
    // same record.
    const docs = docsForPerson(summaries, person, '', { email: selfEmail, staff });
    return json(200, { ok: true, docs, count: docs.length });
  } catch (e) {
    console.error('esign-docs-for-person error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
