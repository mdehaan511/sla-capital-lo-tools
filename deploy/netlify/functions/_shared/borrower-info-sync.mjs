/**
 * borrower-info-sync.mjs — Shared sync + auto-advance helpers (Deploy 173)
 *
 * These helpers fire after a borrower-info record is "completed" — either
 * by the borrower clicking Submit (via borrower-info-save) OR by an LO
 * clicking "Submit on behalf of client" (via borrower-info-save-auth).
 * Both paths need the same post-completion behavior:
 *
 *   1. syncPropertyFieldsToLoan(record) — writes property facts (beds,
 *      baths, sqft, prop type, purchase/refi, close date, etc.) onto
 *      the matching loan record, and borrower-profile facts (DOB, FICO,
 *      home address, marital status, companies, SSN) onto the client.
 *
 *   2. advanceQuoteToInProcessing(record) — flips matching quote(s) +
 *      the client.loans[*] record from `awaiting_app` to `approved` so
 *      the loan moves into the "In Processing" Pipeline column. Returns
 *      a diagnostic result the caller can log.
 *
 * Pre-Deploy 173 this logic only fired on the borrower path. LOs who
 * filled out the application on behalf of clients hit a "Save edits"
 * button that called save-auth — which had no post-completion behavior,
 * so the loan never moved to APPROVED and property fields never synced.
 */
import { getStore } from '@netlify/blobs';
// Deploy 222 (Phase 3) — auto-fire Baseline sync when loan flips to
// approved. Imported here so the same flip-to-approved code path that
// moves the loan to "In Processing" also pushes the record to Baseline.
// The helper is fire-and-await but never throws to the caller.
import { syncOnApproval as _baselineSyncOnApproval } from './baseline-sync.mjs';
// Deploy 226 — audit log: write "app_received" + "status" entries when
// the long app comes back and the loan flips awaiting_app → approved.
import { appendNoteEntry } from './notes-log.mjs';
// Deploy 228 — parse single-line Google formatted_address so the
// home address landing on the Client Profile has structured
// city/state/zip even when the borrower used single-line autocomplete
// in the long app.
import { parseAddress } from './address.mjs';

// Translate the long-form property-type slug to the loan-record slug.
// Long form may emit: sfh, sfr, 2-4, 5+, condo_w, condo_nw, townhome,
// manufactured, rural, portfolio. Loan-record/sizer uses: sfr, 2-4,
// condo, nw_condo, multi, portfolio.
export function normalizePropType(pt) {
  if (!pt) return '';
  const map = {
    sfh: 'sfr', sfr: 'sfr',
    '2-4': '2-4',
    '5+': 'multi', mfr: 'multi', multi: 'multi',
    condo: 'condo', condo_w: 'condo',
    nw_condo: 'nw_condo', condo_nw: 'nw_condo',
    townhome: 'sfr',     // loan-record has no townhome → bucket as sfr
    manufactured: 'sfr',
    rural: 'sfr',
    portfolio: 'portfolio',
  };
  return map[String(pt).toLowerCase()] || String(pt);
}

// Aggressive address normalization (handles "Street/St", trailing ", USA",
// punctuation differences). Used for matching the loan/quote address
// against the borrower-info record's known address — see Deploy 167.
function aggrNorm(s) {
  let x = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  x = x.replace(/,\s*(usa|us|united states)\.?$/i, '');
  x = x.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
       .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
       .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
       .replace(/\bcourt\b/g, 'ct').replace(/\bcircle\b/g, 'cir')
       .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
       .replace(/\btrail\b/g, 'trl').replace(/\bterrace\b/g, 'ter');
  x = x.replace(/[.,]/g, '');
  return x.trim();
}

export async function syncPropertyFieldsToLoan(record) {
  if (!record.ownerKey || !record.clientId) return;
  const data = record.data || {};

  const loanUpdates = {};
  if (data.bedrooms)        loanUpdates.bedrooms       = String(data.bedrooms);
  if (data.bathrooms)       loanUpdates.bathrooms      = String(data.bathrooms);
  if (data.sqft)            loanUpdates.sqft           = String(data.sqft);
  if (data.propertyType)    loanUpdates.propType       = normalizePropType(data.propertyType);
  if (data.currentLoanAmt)  loanUpdates.currentLoanAmt = String(data.currentLoanAmt);
  if (data.currentLoanAmount) loanUpdates.currentLoanAmt = String(data.currentLoanAmount);
  if (data.purchaseOrRefi)  loanUpdates.purchaseOrRefi = String(data.purchaseOrRefi);
  if (data.dscrPurchaseRefi) loanUpdates.purchaseOrRefi = String(data.dscrPurchaseRefi);
  if (data.planDescription) loanUpdates.projectDescription = String(data.planDescription);
  if (data.dscrCloseDate) loanUpdates.fundingDate = String(data.dscrCloseDate);
  if (data.ffCloseDate)   loanUpdates.fundingDate = String(data.ffCloseDate);

  // Borrower-level fields (live on the CLIENT record, reused across loans).
  // The form packs these into data.guarantors[0] for the primary borrower.
  const g0 = (Array.isArray(data.guarantors) && data.guarantors[0]) || {};
  const clientUpdates = {};
  if (data.borrowerFirstName) clientUpdates.firstName = String(data.borrowerFirstName);
  if (data.borrowerLastName)  clientUpdates.lastName  = String(data.borrowerLastName);
  if (data.borrowerEmail)     clientUpdates.email     = String(data.borrowerEmail).toLowerCase().trim();
  if (data.borrowerPhone)     clientUpdates.phone     = String(data.borrowerPhone);
  if (g0.dob)        clientUpdates.dob           = String(g0.dob);
  if (g0.fico)       clientUpdates.fico          = String(g0.fico);
  if (g0.marital)    clientUpdates.maritalStatus = String(g0.marital);
  if (g0.usCitizen)  clientUpdates.usCitizen     = String(g0.usCitizen);
  if (g0.address || g0.city || g0.state || g0.zip) {
    // Deploy 228 — parse the combined address string to recover any
    // embedded city/state/zip from a Google formatted_address. If the
    // separate fields are already populated they take precedence; if
    // they're blank but the address has the data inline, the parser
    // pulls it out. Also strips the redundant "City, ST ZIP, USA" tail
    // from the street so the street value is just the street line.
    const parsed = parseAddress(g0.address || '');
    const city  = String(g0.city  || '').trim() || parsed.city  || '';
    const state = String(g0.state || '').trim() || parsed.state || '';
    const zip   = String(g0.zip   || '').trim() || parsed.zip   || '';
    // When the original g0.address has commas we can confidently use
    // just the parsed street; otherwise keep the original input (it's
    // already just a street).
    const street = (parsed.street1 && String(g0.address || '').indexOf(',') >= 0)
      ? parsed.street1
      : (g0.address || '');
    clientUpdates.homeAddress = { street, city, state, zip };
  }
  if (g0.flips !== undefined && g0.flips !== '')      clientUpdates.flips    = String(g0.flips);
  if (g0.rentals !== undefined && g0.rentals !== '')  clientUpdates.rentals  = String(g0.rentals);
  if (g0.ssn_enc) clientUpdates.ssn_enc = g0.ssn_enc;

  let companiesUpdate = null;
  if (Array.isArray(data.companies) && data.companies.length > 0) {
    companiesUpdate = data.companies
      .filter((c) => c && (c.name || c.ein))
      .map((c) => {
        // Deploy 228 — same single-line address parse for the LLC
        // address. Without this, Client Profile companies entries show
        // a full address string in `address` but no separate
        // city/addrState/zip — and the sizer's "Companies" picker
        // displays them weirdly.
        const parsed = parseAddress(String(c.address || ''));
        const city      = String(c.city      || '').trim() || parsed.city  || '';
        const addrState = String(c.addrState || '').trim() || parsed.state || '';
        const zip       = String(c.zip       || '').trim() || parsed.zip   || '';
        const street    = (parsed.street1 && String(c.address || '').indexOf(',') >= 0)
          ? parsed.street1
          : String(c.address || '');
        return {
          id:        c.id || ('co_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
          name:      String(c.name  || ''),
          state:     String(c.state || ''),    // jurisdiction (filing state)
          ein:       String(c.ein   || ''),
          address:   street,
          city,
          addrState,                            // address state (where mail goes)
          zip,
        };
      });
  }

  if (Object.keys(loanUpdates).length === 0
      && Object.keys(clientUpdates).length === 0
      && !companiesUpdate) return;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${record.ownerKey}/${record.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client) return;
  if (!Array.isArray(client.loans)) client.loans = [];

  let changed = false;

  Object.keys(clientUpdates).forEach((k) => {
    const incoming = clientUpdates[k];
    const existing = client[k];
    const same = (typeof incoming === 'object')
      ? (JSON.stringify(existing) === JSON.stringify(incoming))
      : (existing === incoming);
    if (!same) {
      client[k] = incoming;
      changed = true;
    }
  });

  if (companiesUpdate) {
    const existing = Array.isArray(client.companies) ? client.companies : [];
    const merged = [];
    const seenIds = new Set();
    const norm = (s) => String(s || '').trim().toLowerCase();
    const ed = (s) => String(s || '').replace(/\D/g, '');
    const matchKey = (c) => norm(c.name) + '|' + ed(c.ein);
    const seenKeys = new Set();
    companiesUpdate.forEach((c) => {
      const k = matchKey(c);
      if ((c.name || c.ein) && seenKeys.has(k)) return;
      const match = existing.find((e) => e.id === c.id) ||
                    existing.find((e) => matchKey(e) === k && (c.name || c.ein));
      if (match) {
        merged.push(Object.assign({}, match, c, { id: match.id }));
        seenIds.add(match.id);
      } else {
        merged.push(c);
        seenIds.add(c.id);
      }
      if (c.name || c.ein) seenKeys.add(k);
    });
    existing.forEach((e) => {
      const k = matchKey(e);
      if (!seenIds.has(e.id) && !seenKeys.has(k)) {
        merged.push(e);
        seenIds.add(e.id);
        if (e.name || e.ein) seenKeys.add(k);
      }
    });
    if (JSON.stringify(client.companies) !== JSON.stringify(merged)) {
      client.companies = merged;
      changed = true;
    }
  }

  // Apply loan-level updates. Find the target loan with the same
  // fallback chain used in advanceQuoteToInProcessing.
  if (Object.keys(loanUpdates).length > 0) {
    let targetLoan = null;
    if (record.loanId) targetLoan = client.loans.find((l) => l.id === record.loanId);
    if (!targetLoan && client.loans.length === 1) targetLoan = client.loans[0];
    if (!targetLoan) {
      const awaiting = client.loans.filter((l) => l.status === 'awaiting_app');
      if (awaiting.length === 1) targetLoan = awaiting[0];
    }
    if (!targetLoan) {
      console.warn(
        'syncPropertyFieldsToLoan: no target loan resolved for',
        'clientId=' + record.clientId,
        'recordLoanId=' + (record.loanId || '(none)'),
        '— client has', client.loans.length, 'loans'
      );
    }
    if (targetLoan) {
      Object.keys(loanUpdates).forEach((k) => {
        if (targetLoan[k] !== loanUpdates[k]) {
          targetLoan[k] = loanUpdates[k];
          changed = true;
        }
      });
      if (changed) targetLoan.updatedAt = new Date().toISOString();
    }
  }

  if (changed) {
    client.updatedAt = new Date().toISOString();
    await clientsStore.setJSON(clientKey, client);
  }
}

// Flip matching quote(s) + client.loans[*] from awaiting_app → approved
// so the loan moves to the "In Processing" Pipeline column. Returns a
// diagnostic object so callers can log failures loudly.
export async function advanceQuoteToInProcessing(record) {
  if (!record.ownerKey || !record.clientId) {
    return { ok: false, reason: 'missing ownerKey or clientId on record', quotesUpdated: 0, loanUpdated: false };
  }
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${record.ownerKey}/${record.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client || !Array.isArray(client.loans)) {
    return { ok: false, reason: 'client not found or has no loans', quotesUpdated: 0, loanUpdated: false };
  }

  let targetLoan = null;
  if (record.loanId) targetLoan = client.loans.find((l) => l.id === record.loanId);
  if (!targetLoan && client.loans.length === 1) targetLoan = client.loans[0];
  if (!targetLoan) {
    const awaiting = client.loans.filter((l) => l.status === 'awaiting_app');
    if (awaiting.length === 1) targetLoan = awaiting[0];
  }
  if (!targetLoan || !targetLoan.address) {
    return {
      ok: false,
      reason: record.loanId
        ? `no loan matched loanId="${record.loanId}" (client has ${client.loans.length} loans)`
        : `no targetable loan (client has ${client.loans.length} loans, ${client.loans.filter(l => l.status === 'awaiting_app').length} awaiting_app)`,
      quotesUpdated: 0,
      loanUpdated: false,
    };
  }

  const target = aggrNorm(targetLoan.address);

  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  let quotesUpdated = 0;
  let quotesMatched = 0;
  try {
    const { blobs } = await quotesStore.list({ prefix: record.ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q || aggrNorm(q.address) !== target) continue;
      quotesMatched += 1;
      if (q.status === 'awaiting_app') {
        q.status = 'approved';
        q.updatedAt = new Date().toISOString();
        q.borrowerInfoCompletedAt = record.completedAt || new Date().toISOString();
        await quotesStore.setJSON(key, q);
        quotesUpdated += 1;
      }
    }
  } catch (e) {
    return { ok: false, reason: 'quote store error: ' + (e.message || 'unknown'), quotesUpdated, loanUpdated: false };
  }

  let loanUpdated = false;
  let advancedLoan = null; // capture the loan we flipped, for Baseline sync below
  for (const l of client.loans) {
    if (aggrNorm(l.address) === target && l.status === 'awaiting_app') {
      const prevStatus = l.status;
      l.status = 'approved';
      l.updatedAt = new Date().toISOString();
      l.borrowerInfoCompletedAt = record.completedAt || new Date().toISOString();
      // Deploy 226 — audit log entries: app_received + status flip.
      // System-authored because this fires on the borrower's submit, not
      // an LO action.
      appendNoteEntry(l, {
        kind:        'app_received',
        text:        'Borrower completed and submitted the long-form loan application.',
        author:      'SLA Platform',
        authorEmail: 'system@slacapital.com',
        meta:        { completedAt: l.borrowerInfoCompletedAt },
      });
      appendNoteEntry(l, {
        kind:        'status',
        text:        'Status: ' + prevStatus + ' → approved (long app complete → In Processing)',
        author:      'SLA Platform',
        authorEmail: 'system@slacapital.com',
        meta:        { from: prevStatus, to: 'approved', via: 'borrower-info-complete' },
      });
      loanUpdated = true;
      advancedLoan = l;
    }
  }
  if (loanUpdated) {
    // Deploy 222 (Phase 3) — auto-fire the Baseline sync on this
    // approval. The two trigger conditions (status='approved' AND
    // borrower_info.status='complete') are guaranteed met right here:
    // status flipped above, and we're being called BY a borrower-
    // info completion code path. The helper mutates advancedLoan in
    // place with the Baseline refs + sync-status fields, so the
    // single setJSON below persists both the status flip and the
    // Baseline state atomically.
    //
    // Wrapped in try/catch out of paranoia — the helper's contract
    // is "never throws" but a runtime bug must not block the loan
    // advance. Baseline failure is captured in the helper's audit
    // log and Slack alert.
    try {
      await _baselineSyncOnApproval(client, advancedLoan, record.ownerKey, record.advancedBy || 'auto:borrower-info-complete');
    } catch (e) {
      console.error('advanceQuoteToInProcessing: baseline sync threw, ignoring:', e && e.message);
    }
    try {
      await clientsStore.setJSON(clientKey, client);
    } catch (e) {
      return { ok: false, reason: 'client save error: ' + (e.message || 'unknown'), quotesUpdated, loanUpdated: false };
    }
  }

  if (loanUpdated) {
    return { ok: true, quotesUpdated, loanUpdated, quotesMatched };
  }
  const anyAwaiting = client.loans.some((l) => aggrNorm(l.address) === target && l.status === 'awaiting_app');
  if (!anyAwaiting && quotesMatched > 0) {
    return { ok: true, reason: 'loan was already past awaiting_app', quotesUpdated, loanUpdated: false, quotesMatched };
  }
  return {
    ok: false,
    reason: `no awaiting_app loan matched address "${targetLoan.address}" (normalized: "${target}"); ${quotesMatched} quote(s) matched address but none were in awaiting_app`,
    quotesUpdated,
    loanUpdated: false,
    quotesMatched,
  };
}
