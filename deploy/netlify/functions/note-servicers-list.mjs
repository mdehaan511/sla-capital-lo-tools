/**
 * note-servicers-list.mjs — GET /api/note-servicers-list
 *
 * Deploy 236.628 — returns the org-wide list of Note Servicers. A Note Servicer
 * is just a Vendor (loan-contacts) whose role is 'note_servicer', added on the
 * Vendors page. This endpoint scans the loan-contacts store across all owners and
 * returns the distinct note-servicer names so any Note Servicer dropdown in the
 * app (Close Out modal, Servicing editor, Loan Details Servicing tab) can offer
 * them. Readable by ANY authenticated user (it's a small shared reference list,
 * just names — no sensitive data); management (add/edit/delete) happens through
 * the normal Vendors flow (loan-contacts-save / -delete).
 *
 * The display name for a servicer is its Company (the servicer's business name),
 * falling back to the contact Name.
 *
 * Response: {
 *   names: ['BSI Financial', 'FCI Lender Services', ...],   // distinct, sorted
 *   servicers: [{ id, name, company, email, phone, ownerKey }, ...]
 * }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const store = getStore({ name: 'loan-contacts', consistency: 'strong' });
    const { blobs } = await store.list();
    const servicers = [];
    await Promise.all(blobs.map(async ({ key }) => {
      const c = await store.get(key, { type: 'json' }).catch(() => null);
      if (!c || String(c.role || '').toLowerCase() !== 'note_servicer') return;
      servicers.push({
        id: c.id, name: c.name || '', company: c.company || '',
        email: c.email || '', phone: c.phone || '', ownerKey: c.ownerKey || '',
      });
    }));

    // Distinct display names (company preferred), case-insensitive dedupe, sorted.
    const seen = new Set();
    const names = [];
    servicers
      .map((s) => (s.company || s.name || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .forEach((nm) => {
        const k = nm.toLowerCase();
        if (!seen.has(k)) { seen.add(k); names.push(nm); }
      });

    return json(200, { names, servicers });
  } catch (e) {
    console.error('note-servicers-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
