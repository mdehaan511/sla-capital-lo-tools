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
 *
 * Deploy 236.387 — the "scan ALL client blobs cross-owner for this
 * email" walk is replaced by ONE Postgres query on clients.email with
 * the loans embedded (loans!client_id — the FK hint disambiguates
 * against loans.broker_id, same as client-get-pg.mjs). At 2,800+
 * client blobs the walk was 60s+ territory and could time out the
 * borrower portal. Rows are rebuilt to blob shape so all the
 * bucketing/enrichment logic below runs unchanged. The profiles walk
 * stays — ~14 records, needed for LO contact enrichment.
 */
import { getStore } from '@netlify/blobs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398
import {
  handleOptions, json, requireAuth, isAdmin, isSuperAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

// Deploy 236.387 — zero-dep PostgREST GET (same pattern as
// search-pg.mjs's _pgSelect). Built manually because the shared
// supabase-db helper can't express `ilike`, and we need a
// case-insensitive email match: the blob walk compared with
// normalizeEmail() on both sides, and PG stores clients.email
// verbatim from the blob — hand-typed mixed-case records exist, so a
// plain eq would silently report a registered borrower as
// unregistered.
async function _pgSelect(table, qs) {
  const url = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const resp = await fetch(url + '/rest/v1/' + table + '?' + qs, {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : []; }
  catch (_) { data = []; }
  if (!resp.ok) {
    const err = new Error('PostgREST GET ' + table + ' → HTTP ' + resp.status +
      (data && data.message ? ': ' + data.message : ''));
    err.status = resp.status;
    throw err;
  }
  return data || [];
}

// Rebuild blob-shaped records from PG rows — copied from
// client-get-pg.mjs so the bucketing code below reads the exact same
// field names the blob store held (camelCase + extra spread).
function _clientRowToBlobShape(c) {
  if (!c) return null;
  const loans = Array.isArray(c.loans) ? c.loans.map(_loanRowToBlobShape) : [];
  const out = {
    id:                    c.id,
    firstName:             c.first_name  || '',
    lastName:              c.last_name   || '',
    email:                 c.email       || '',
    phone:                 c.phone       || '',
    entityName:            c.entity_name || '',
    displayName:           c.display_name || '',
    _isBroker:             !!c.is_broker,
    notes:                 c.notes || '',
    createdAt:             c.created_at,
    updatedAt:             c.updated_at,
    createdBy:             c.created_by || '',
    loans,
  };
  // extra JSONB merged onto the top level so anything we haven't
  // promoted to a column still round-trips.
  Object.assign(out, c.extra || {});
  // Re-set loans in case extra had a stale key.
  out.loans = loans;
  return out;
}

function _loanRowToBlobShape(l) {
  if (!l) return null;
  const out = {
    id:                   l.id,
    address:              l.address           || '',
    status:               l.status            || 'active',
    processingStage:      l.processing_stage  || '',
    toolType:             l.tool_type         || '',
    loanType:             l.loan_type         || '',
    loanAmt:              l.loan_amt          || '',
    rate:                 l.rate              || '',
    points:               l.points            || '',
    purchasePrice:        l.purchase_price    || '',
    propValue:            l.prop_value        || '',
    propType:             l.prop_type         || '',
    brokerId:             l.broker_id         || '',
    _isBrokerLoan:        !!l.is_broker_loan,
    fromApplication:      !!l.from_application,
    prospectId:           l.prospect_id       || '',
    fundingDate:          l.funding_date      || '',
    maturityDate:         l.maturity_date     || '',
    servicerName:         l.servicer_name     || '',
    servicerUrl:          l.servicer_url      || '',
    slaDisplayId:         l.sla_display_id    || '',
    formData:             l.form_data || {},
    createdAt:            l.created_at,
    updatedAt:            l.updated_at,
    savedAt:              l.saved_at || l.updated_at,
  };
  // extra carries un-promoted fields the loan cards read (loanProduct,
  // propertyValue, …).
  Object.assign(out, l.extra || {});
  return out;
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const authedEmail = normalizeEmail(user.email || '');
  if (!authedEmail) return json(401, { error: 'No email on auth token' });

  // Deploy 236.306 — admin impersonation. When ?as=<email> is present
  // AND the caller is admin/super_admin, load that borrower's loans
  // instead of the caller's. Rejected 403 for non-admin callers so a
  // regular user can't peek at another borrower.
  const impersonateRaw = new URL(req.url).searchParams.get('as') || '';
  const impersonateEmail = normalizeEmail(impersonateRaw);
  let callerEmail = authedEmail;
  let impersonating = false;
  if (impersonateEmail && impersonateEmail !== authedEmail) {
    if (!isAdmin(user) && !isSuperAdmin(user)) {
      return json(403, { error: 'Impersonation requires admin' });
    }
    callerEmail = impersonateEmail;
    impersonating = true;
    console.log(`[borrower-loans] admin=${authedEmail} impersonating=${callerEmail}`);
  }

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

  // Find client records for this email cross-owner. Deploy 236.387 —
  // one PG query on clients.email with loans embedded, replacing the
  // full clients-store walk. ilike with no wildcards is a
  // case-insensitive equality match; `_` in an email is technically a
  // single-char LIKE wildcard, so exact (normalized) equality is
  // re-verified in JS before trusting a row — same predicate the old
  // walk applied to every blob. 200-row cap: one borrower email
  // matching even a dozen client records would be unusual.
  const matches = []; // { rec, ownerKey }
  try {
    const rows = await _pgSelect('clients',
      'select=' + encodeURIComponent('*,loans!client_id(*)') +
      '&email=ilike.' + encodeURIComponent(callerEmail) +
      '&order=updated_at.desc&limit=200');
    for (const row of (rows || [])) {
      if (!row) continue;
      if (normalizeEmail(row.email || '') !== callerEmail) continue;
      matches.push({
        rec:      _clientRowToBlobShape(row),
        ownerKey: keySafe(normalizeEmail(row.owner_email || '')),
      });
    }
  } catch (e) {
    console.warn('borrower-loans: clients lookup failed:', e && e.message);
  }

  // No client records → borrower is unregistered.
  if (!matches.length) {
    return json(200, {
      ok: true,
      isRegistered: false,
      impersonating: impersonating,
      impersonatedEmail: impersonating ? callerEmail : null,
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
    impersonating: impersonating,
    impersonatedEmail: impersonating ? callerEmail : null,
    client: {
      firstName: canonical.firstName || '',
      lastName:  canonical.lastName  || '',
      email:     canonical.email     || callerEmail,
      phone:     canonical.phone     || '',
    },
    loans: buckets,
  });
};
