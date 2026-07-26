/**
 * orphaned-quotes-list.mjs — GET /api/orphaned-quotes-list
 *
 * Admin-only diagnostic + recovery support endpoint. Walks every saved
 * quote in the `quotes` blob store and compares against the `clients`
 * blob store to find quotes that don't have a corresponding loan record
 * on any client for that owner.
 *
 * Why this exists: prior to the Deploy_143 fix, sizers could save a
 * quote without ever creating a client/loan record (the ClientBook.upsert
 * call short-circuited when borrower email was missing). Those quotes
 * show up in the Pipeline but have no Loan Details page. This endpoint
 * locates them so an admin tool can fold them back in.
 *
 * Returns: { orphans: [{ owner, address, borrower, borrowerEmail,
 *   borrowerPhone, toolType, savedAt, status, formData, hasEmail }, ...] }
 *
 * `hasEmail` is true when the quote's stored formData contains an email
 * — those can be auto-recovered. The rest need manual LO intervention.
 *
 * IMPORTANT: This endpoint is READ-ONLY. It does not modify any data.
 * Recovery happens via the standard Clients.upsert flow from the admin UI.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.386 — the loan-address map now comes from ONE paginated
// Postgres query and the quotes from the materialized quotes-index
// (one blob read), replacing a serial walk of every client + quote
// blob that ran 60s+ at current scale and timed out the function —
// the orphaned-sizers page just sat on "Loading…" forever.
import { db } from './_shared/supabase-db.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs';

// Normalize an address for matching. Mirrors the logic used in
// sla-api.js's Clients.upsert merge path and pipeline.html's loanLookup
// build. Two passes (full + street-prefix) so address-format drift
// between sizer save and client write doesn't produce false orphans.
function normAddr(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function streetPart(s) {
  return normAddr(s).split(',')[0].trim();
}

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('orphaned-quotes-list top-level error:', e);
    return json(500, {
      error: 'Server error: ' + ((e && e.message) || 'unknown'),
      stack: String((e && e.stack) || '').split('\n').slice(0, 5).join(' | ').slice(0, 500),
    });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  // 1) Build (owner → loan ids + normalized loan addresses) from
  //    Postgres. One paginated query instead of walking 2,800+ client
  //    blobs serially. A quote is "matched" if its loanId points at a
  //    real loan for that owner, or its address (full or street-only)
  //    lines up against any loan for the same owner.
  const loansByOwner = {};
  try {
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const rows = await db.select('loans', {
        select: 'id,address,owner_email',
        limit: PAGE,
        offset,
      });
      for (const r of (rows || [])) {
        if (!r) continue;
        const ownerKey = keySafe(normalizeEmail(r.owner_email || ''));
        if (!ownerKey) continue;
        const set = loansByOwner[ownerKey] || (loansByOwner[ownerKey] = { ids: new Set(), full: new Set(), street: new Set() });
        if (r.id) set.ids.add(r.id);
        if (r.address) {
          set.full.add(normAddr(r.address));
          const sp = streetPart(r.address);
          if (sp) set.street.add(sp);
        }
      }
      if ((rows || []).length < PAGE) break;
      offset += PAGE;
      if (offset > 200000) break;
    }
  } catch (e) {
    return json(500, { error: 'Failed to load loans from PG: ' + (e.message || 'unknown') });
  }

  // 2) Walk every quote. Any quote whose address doesn't match any loan
  //    for the same owner is an orphan.
  //
  // Status filter: include every quote that's still "live" — anything an
  // LO might still be working on. Exclude only terminal states (denied,
  // closed). Earlier versions of this endpoint over-filtered to just
  // active+submitted, missing orphans in the Awaiting Application and
  // In Processing columns of the Pipeline.
  const ACTIVE_STATUSES = new Set([
    'active',         // Quoted column
    'submitted',      // Submitted column
    'awaiting_app',   // Awaiting Application column
    'approved',       // In Processing column
    'on_hold',        // visible to admin; still recoverable
  ]);
  const orphans = [];
  let totalQuotesScanned = 0;
  let skippedByStatus = 0;
  let skippedNoAddress = 0;
  let matchedClean = 0;
  try {
    // Quotes from the materialized index — one blob read. Falls back
    // to the legacy per-blob walk only if the index doesn't exist.
    const { index, exists } = await quotesIndex.readIndex();
    if (!exists || !index || !index.byOwner) {
      return json(500, { error: 'quotes-index missing — run /api/admin-store-indexes-rebuild?store=quotes then retry' });
    }
    for (const ownerKey of Object.keys(index.byOwner)) {
      for (const quote of (index.byOwner[ownerKey] || [])) {
        if (!quote) continue;
        totalQuotesScanned++;
        if (!quote.address) { skippedNoAddress++; continue; }

        const status = quote.status || 'active';
        if (!ACTIVE_STATUSES.has(status)) { skippedByStatus++; continue; }

        const set = loansByOwner[ownerKey];
        // Deploy 236.386 — loanId is the strongest signal: a quote
        // whose loanId exists on this owner is linked, full stop.
        const qAddrFull = normAddr(quote.address);
        const qAddrStreet = streetPart(quote.address);
        const matched = set && (
          (quote.loanId && set.ids.has(quote.loanId)) ||
          (qAddrFull && set.full.has(qAddrFull)) ||
          (qAddrStreet && set.street.has(qAddrStreet))
        );
        if (matched) { matchedClean++; continue; }

        // The index's mini-formData carries the broker contact +
        // pricing summary; borrower email is top-level. The recover
        // endpoint re-fetches the FULL quote blob by quoteKey, so a
        // thin formData here only affects the list display.
        const fd = quote.formData || {};
        const borrowerEmail = (quote.borrowerEmail || fd.borrowerEmail || '').trim();
        const borrowerName  = (quote.borrower || fd.borrower || fd.borrowerName || '').trim();

        orphans.push({
          owner: ownerKey,
          quoteKey: ownerKey + '/' + keySafe(quote.id),
          address: quote.address,
          borrower: borrowerName,
          borrowerEmail,
          borrowerPhone: '',
          toolType: quote.toolType || 'dscr',
          savedAt: quote.savedAt || quote.updatedAt || null,
          status,
          hasEmail: !!borrowerEmail,
          formData: fd,
        });
      }
    }
  } catch (e) {
    return json(500, { error: 'Failed to scan quotes: ' + (e.message || 'unknown') });
  }

  // Sort most-recent first so the admin sees fresh stuff at the top
  orphans.sort((a, b) => {
    const aT = a.savedAt ? new Date(a.savedAt).getTime() : 0;
    const bT = b.savedAt ? new Date(b.savedAt).getTime() : 0;
    return bT - aT;
  });

  return json(200, {
    orphans,
    summary: {
      total: orphans.length,
      autoRecoverable: orphans.filter(o => o.hasEmail).length,
      needsManualFix: orphans.filter(o => !o.hasEmail).length,
    },
    // Diagnostics — surfaced in admin UI so we can verify the endpoint
    // is actually scanning the expected number of quotes/clients
    diagnostics: {
      totalQuotesScanned,
      skippedByStatus,
      skippedNoAddress,
      matchedClean,
      ownersWithLoans: Object.keys(loansByOwner).length,
      uniqueLoanAddressesIndexed: Object.values(loansByOwner)
        .reduce((sum, s) => sum + s.full.size, 0),
    },
  });
}
