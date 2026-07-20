/**
 * client-get-pg.mjs — GET /api/client-get-pg?clientId=&owner=
 *
 * Phase 4b of the data migration. Postgres-backed drop-in for
 * /api/client-get. Same response shape:
 *   { client: <client row projected to blob shape, with loans[]>,
 *     ownerKey: <email>,
 *     _source: 'postgres' }
 *
 * Uses the same FK-disambiguated embed as clients-list-pg
 * (loans!client_id(*)) — the loans table has TWO fks to clients
 * (client_id + broker_id), so PostgREST needs the source-column
 * hint to pick the parent relation.
 *
 * Auth: LO gets own scope; admin/processor can pass ?owner= for
 * cross-LO fetches. Cross-namespace recovery is unnecessary here —
 * PG lookups are by primary key, not by (owner, id) tuple, so the
 * clientId alone is enough.
 */
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { db } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('client-get-pg error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

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
    companies:             c.companies || [],
    homeAddress:           c.home_address || null,
    mailingAddress:        c.mailing_address || null,
    hasSSN:                !!c.ssn_enc,
    ssnLast4:              c.ssn_last4 || '',
    fico:                  c.fico || '',
    dob:                   c.dob || '',
    _isBroker:             !!c.is_broker,
    _isBrokerPlaceholder:  !!c.is_broker_placeholder,
    notes:                 c.notes || '',
    notesLog:              c.notes_log || [],
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
    loanAmtLocked:        !!l.loan_amt_locked,
    rate:                 l.rate              || '',
    points:               l.points            || '',
    purchasePrice:        l.purchase_price    || '',
    propValue:            l.prop_value        || '',
    rehabBudget:          l.rehab_budget      || '',
    arv:                  l.arv               || '',
    propType:             l.prop_type         || '',
    fico:                 l.fico              || '',
    prepay:               l.prepay            || '',
    dscr:                 l.dscr              || '',
    brokerId:             l.broker_id         || '',
    _isBrokerLoan:        !!l.is_broker_loan,
    fromApplication:      !!l.from_application,
    prospectId:           l.prospect_id       || '',
    fundingDate:          l.funding_date      || '',
    maturityDate:         l.maturity_date     || '',
    servicerName:         l.servicer_name     || '',
    servicerUrl:          l.servicer_url      || '',
    slaDisplayId:         l.sla_display_id    || '',
    guarantorClientIds:   l.guarantor_client_ids || [],
    guarantorOwnership:   l.guarantor_ownership || {},
    vestingLLCs:          l.vesting_llcs || [],
    formData:             l.form_data || {},
    notes:                l.notes || '',
    notesLog:              l.notes_log || [],
    createdAt:            l.created_at,
    updatedAt:            l.updated_at,
    savedAt:              l.saved_at || l.updated_at,
  };
  Object.assign(out, l.extra || {});
  return out;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const clientId   = String(url.searchParams.get('clientId') || '').trim();
  const ownerParam = String(url.searchParams.get('owner') || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });

  const selfEmail = normalizeEmail(user.email);
  const isStaff   = canOverrideOwner(user).ok;

  // Single lookup with embedded loans. PK on clients.id makes this
  // O(1). Owner filtering happens after fetch so we can still
  // 404-not-403 for non-staff LOs peeking at other owners' records.
  const row = await db.first('clients', {
    eq: { id: clientId },
    select: '*,loans!client_id(*)',
  }).catch((e) => {
    console.warn('client-get-pg: lookup failed:', e && e.message);
    return null;
  });
  if (!row) return json(404, { error: 'Client not found' });

  // Owner scope enforcement. LOs only see their own; admins see any.
  if (!isStaff) {
    if (normalizeEmail(row.owner_email) !== selfEmail) {
      return json(404, { error: 'Client not found' }); // don't leak existence
    }
  } else if (ownerParam) {
    // Admin passed an owner hint. If it doesn't match the actual
    // owner, still return the record (they can see any) but log a
    // hint mismatch so any future forensics can spot stale refs.
    const wanted = normalizeEmail(ownerParam);
    const actual = normalizeEmail(row.owner_email);
    if (wanted && actual && wanted !== actual) {
      console.log('[client-get-pg] owner hint mismatch',
        { clientId, hint: wanted, actual });
    }
  }

  return json(200, {
    client:   _clientRowToBlobShape(row),
    ownerKey: keySafe(row.owner_email),
    _source:  'postgres',
  });
}
