/**
 * admin-broker-name-audit.mjs — GET /api/admin-broker-name-audit
 *
 * Deploy 237.212 (Mike, reporting Jeremy's quotes): "the Broker name needs to
 * be correct ... I imagine its effecting others as well."
 *
 * The defect: broker-link resolved a broker by EMAIL and adopted whatever
 * client held that address — name and all — then four save endpoints stamped
 * that name onto the loan. When the only record holding the broker's email
 * was a placeholder borrower ("Chris TBD"), the loan's Broker Info took the
 * placeholder's name and the same record showed up again as Guarantor 1.
 *
 * This finds loans wearing that signature. READ-ONLY on purpose: the true
 * broker name was overwritten, so only a human knows what it should be. The
 * report gives whoever fixes it everything needed — the loan, the LO, the
 * name on the card, the parent client and the broker email — and Broker Info
 * on Loan Details is already editable.
 *
 * Admin only. ?owner=<email> narrows it to one LO.
 */
import { handleOptions, json, requireAuth, isAdmin, normalizeEmail } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

const SELECT = 'id,owner_email,address,status,extra,' +
  'clients!client_id(id,first_name,last_name,email,is_broker)';

const _nm = (s) => String(s || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
const _em = (s) => String(s || '').toLowerCase().trim();

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    const url = new URL(req.url);
    const onlyOwner = normalizeEmail(url.searchParams.get('owner') || '');

    const opts = { select: SELECT, limit: 10000 };
    if (onlyOwner) opts.eq = { owner_email: onlyOwner };
    const rows = await db.select('loans', opts);

    const suspects = [];
    let withBroker = 0;

    for (const r of (rows || [])) {
      const x = r.extra || {};
      const brokerEmail = _em(x.brokerEmail);
      const brokerName = String(x.brokerName || '').trim();
      if (!brokerEmail && !brokerName) continue;
      withBroker++;

      const c = r.clients || {};
      const clientName = String(((c.first_name || '') + ' ' + (c.last_name || '')).trim());
      const clientEmail = _em(c.email);
      const g0 = (Array.isArray(x.guarantors) && x.guarantors[0]) || null;
      const g0Email = _em(g0 && g0.email);
      const g0Name = g0 ? String(((g0.firstName || '') + ' ' + (g0.lastName || '')).trim() || g0.name || '') : '';

      const reasons = [];
      // The signature: the loan's broker name IS the parent client's name,
      // and that client holds the broker's email.
      if (brokerName && clientName && _nm(brokerName) === _nm(clientName) &&
          brokerEmail && clientEmail === brokerEmail && !c.is_broker) {
        reasons.push('broker name came from a client that is not flagged as a broker');
      }
      // A placeholder that reached the broker field.
      if (/\bTBD\b/i.test(brokerName)) reasons.push('broker name looks like a placeholder');
      // The guarantor wearing the broker's address.
      if (g0Email && brokerEmail && g0Email === brokerEmail) {
        reasons.push('guarantor 1 carries the broker email');
      }
      // Broker and guarantor are literally the same person on the card.
      if (brokerName && g0Name && _nm(brokerName) === _nm(g0Name)) {
        reasons.push('broker and guarantor 1 have the same name');
      }
      if (!reasons.length) continue;

      suspects.push({
        loanId: r.id,
        owner: r.owner_email,
        address: r.address || '',
        status: r.status || '',
        brokerName,
        brokerEmail,
        client: { id: c.id || '', name: clientName, email: clientEmail, isBroker: !!c.is_broker },
        guarantor1: g0 ? { name: g0Name, email: g0Email } : null,
        reasons,
        loanUrl: '/loan-details/' + r.id + (r.owner_email ? '?owner=' + encodeURIComponent(r.owner_email) : ''),
      });
    }

    suspects.sort((a, b) => String(a.owner).localeCompare(String(b.owner)) || String(a.address).localeCompare(String(b.address)));

    return json(200, {
      ok: true,
      scanned: (rows || []).length,
      withBrokerInfo: withBroker,
      suspectCount: suspects.length,
      suspects,
      note: 'Read-only. The real broker name was overwritten, so fix these on Loan Details → Broker Info (editable). ' +
            'Deploy 237.212 stops new ones: a record matched by email can no longer rename the broker.',
    });
  } catch (e) {
    console.error('admin-broker-name-audit error:', (e && e.message) || e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
