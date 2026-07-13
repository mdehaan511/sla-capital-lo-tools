/**
 * borrower-loans.mjs — GET /api/borrower-loans
 *
 * Powers the borrower-facing /my-loans/ page. Given the authenticated
 * user's email, scan the `clients` blob store cross-owner for records
 * matching that email, collect the loans, bucket them by status, and
 * enrich each loan with the owning LO's contact info.
 *
 * Response shape:
 *   {
 *     ok: true,
 *     isRegistered: true|false,   // false = email doesn't match any client
 *     client: { firstName, lastName, email, phone } | null,
 *     loans: {
 *       awaitingTerms: [ Loan ],  // status === 'awaiting_app'
 *       inProcessing:  [ Loan ],  // status in ('submitted','approved')
 *       closed:        [ Loan ],  // status === 'closed'
 *     }
 *   }
 * Loan = { id, clientId, address, loanAmt, propValue, loanType, product,
 *          status, statusLabel, savedAt, maturityDate, servicerName,
 *          servicerUrl, owner: { email, name, phone } }
 *
 * Auth: requires a valid JWT (Netlify Identity or Supabase — dual-auth).
 * NEVER exposes another borrower's data — only records whose `email`
 * matches the caller's authenticated email are returned.
 *
 * Deploy 236.305 — borrower portal Phase 1.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const callerEmail = normalizeEmail(user.email || '');
  if (!callerEmail) return json(401, { error: 'No email on auth token' });

  // Load profiles once — used to enrich each loan with the LO's real
  // name + phone. keySafe(email) → { email, fullName, phone }.
  const profilesByKey = {};
  try {
    const profiles = getStore({ name: 'profiles', consistency: 'eventual' });
    const { blobs } = await profiles.list();
    await Promise.all(blobs.map(async ({ key }) => {
      try {
        const p = await profiles.get(key, { type: 'json' });
        if (p && p.email) {
          profilesByKey[key] = {
            email:    String(p.email).toLowerCase().trim(),
            fullName: p.fullName || p.name || '',
            phone:    p.phone || '',
          };
        }
      } catch (_) { /* skip broken */ }
    }));
  } catch (e) {
    console.warn('borrower-loans: profiles load failed:', e && e.message);
  }

  // Scan clients cross-owner for records whose email matches the caller.
  // Parallelized in chunks of 40 to keep concurrent GETs sane. Same
  // pattern as prospects-save.mjs resolveOwner / findEmailMatch.
  const matches = []; // { key, rec, ownerKey }
  try {
    const clients = getStore({ name: 'clients', consistency: 'strong' });
    const { blobs } = await clients.list();
    const CHUNK = 40;
    for (let i = 0; i < blobs.length; i += CHUNK) {
      const chunk = blobs.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async ({ key }) => {
        try {
          const rec = await clients.get(key, { type: 'json' });
          if (!rec) return null;
          if (normalizeEmail(rec.email || '') !== callerEmail) return null;
          const slash = key.indexOf('/');
          const ownerKey = slash > 0 ? key.slice(0, slash) : '';
          return { key, rec, ownerKey };
        } catch (_) { return null; }
      }));
      for (const r of results) if (r) matches.push(r);
    }
  } catch (e) {
    console.warn('borrower-loans: clients scan failed:', e && e.message);
  }

  // No client records → borrower is unregistered.
  if (!matches.length) {
    return json(200, {
      ok: true,
      isRegistered: false,
      client: null,
      loans: { awaitingTerms: [], inProcessing: [], closed: [] },
    });
  }

  // Merge across records if the same borrower has clients under multiple
  // LOs. Pick the "canonical" contact info from the most recently updated
  // record; combine all loans.
  matches.sort((a, b) => {
    const at = new Date(a.rec.updatedAt || a.rec.createdAt || 0).getTime();
    const bt = new Date(b.rec.updatedAt || b.rec.createdAt || 0).getTime();
    return bt - at;
  });
  const canonical = matches[0].rec;

  const RTL_PRODUCTS = ['fix_flip', 'rtl', 'bridge', 'transactional'];
  const STATUS_LABEL = {
    active:       'Draft',
    on_hold:      'On Hold',
    submitted:    'Submitted for Processing',
    approved:     'In Processing',
    awaiting_app: 'Awaiting Terms Approval',
    denied:       'Declined',
    closed:       'Closed',
  };

  const buckets = { awaitingTerms: [], inProcessing: [], closed: [] };

  for (const m of matches) {
    const ownerKey = m.ownerKey;
    const prof = profilesByKey[ownerKey] || null;
    const ownerInfo = {
      email: prof ? prof.email : ownerKey.replace(/^__+/, ''),
      name:  prof ? (prof.fullName || prof.email) : '',
      phone: prof ? prof.phone : '',
    };
    const loans = Array.isArray(m.rec.loans) ? m.rec.loans : [];
    for (const l of loans) {
      if (!l || !l.id) continue;
      const status = String(l.status || 'active').toLowerCase();
      const isRtl = RTL_PRODUCTS.indexOf(l.toolType) >= 0
                 || RTL_PRODUCTS.indexOf(l.loanProduct) >= 0
                 || l.toolType === 'rtl';
      const loanCard = {
        id:            l.id,
        clientId:      m.rec.id,
        address:       l.address || '',
        loanAmt:       l.loanAmt || l.purchasePrice || '',
        propValue:     l.propValue || l.propertyValue || '',
        rate:          l.rate || '',
        loanType:      isRtl ? 'RTL' : 'DSCR',
        product:       l.loanProduct || l.toolType || (isRtl ? 'rtl' : 'dscr'),
        status:        status,
        statusLabel:   STATUS_LABEL[status] || status,
        savedAt:       l.savedAt || l.updatedAt || l.createdAt || '',
        // Closed-loan-only fields. servicer* are new — persist on the loan
        // record when a loan closes (via close.html or loan-details inline
        // edit). Fallback to empty string until populated.
        maturityDate:  l.maturityDate || '',
        servicerName:  l.servicerName || '',
        servicerUrl:   l.servicerUrl  || '',
        // RTL-specific: SiteWire is the draw-request portal for construction
        // + fix-and-flip draws. Every RTL loan gets the link.
        drawPortalUrl: isRtl ? 'https://portal.sitewire.co/' : '',
        owner:         ownerInfo,
        _isRtl:        isRtl,
      };
      if (status === 'awaiting_app') {
        buckets.awaitingTerms.push(loanCard);
      } else if (status === 'submitted' || status === 'approved') {
        buckets.inProcessing.push(loanCard);
      } else if (status === 'closed') {
        buckets.closed.push(loanCard);
      }
      // Other statuses (active, on_hold, denied) intentionally hidden
      // from the borrower — those are internal-only pipeline states.
    }
  }

  // Sort each bucket most-recent first.
  Object.keys(buckets).forEach(k => {
    buckets[k].sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
  });

  return json(200, {
    ok: true,
    isRegistered: true,
    client: {
      firstName: canonical.firstName || '',
      lastName:  canonical.lastName  || '',
      email:     canonical.email     || callerEmail,
      phone:     canonical.phone     || '',
    },
    loans: buckets,
  });
};
