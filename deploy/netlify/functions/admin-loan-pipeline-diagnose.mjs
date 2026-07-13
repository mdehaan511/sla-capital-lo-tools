/**
 * admin-loan-pipeline-diagnose.mjs
 *   GET /api/admin-loan-pipeline-diagnose?clientId=&loanId=&owner=
 *
 * Deploy 236.312 — admin diagnostic. Given a (clientId, loanId, owner)
 * triple, load the client's blob, find the loan, load every quote in the
 * same owner namespace, and report back with:
 *   - loan record (status, address, rate, fromApplication, prospectId)
 *   - matching quote(s) if any
 *   - a `visibility` block that walks the pipeline's filter rules and
 *     names the specific reason the tile is hidden (or 'should_be_visible'
 *     if nothing hides it).
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

// Matches pipeline.html's exclusion set for active-column visibility.
const HIDDEN_STATUSES = new Set([
  'on_hold', 'denied', 'closed', 'cancelled', 'liquidated', 'sold',
]);

// Address normalization comparable to pipeline.html's _normAddr.
function normAddr(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/,\s*(usa|us|united states)\.?$/i, '');
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-loan-pipeline-diagnose error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get('clientId') || '').trim();
  const loanId   = String(url.searchParams.get('loanId')   || '').trim();
  const owner    = String(url.searchParams.get('owner')    || '').trim();
  if (!clientId || !loanId || !owner) {
    return json(400, { error: 'clientId, loanId, owner all required' });
  }
  const ownerKey = keySafe(normalizeEmail(owner));

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);
  const client = await clientsStore.get(clientKey, { type: 'json' });
  if (!client) {
    return json(200, {
      found: false,
      reason: 'client_not_found',
      probedKey: clientKey,
      ownerKey,
    });
  }

  const loan = (client.loans || []).find((l) => l && l.id === loanId);
  if (!loan) {
    return json(200, {
      found: false,
      reason: 'loan_not_found_on_client',
      client: {
        id:         client.id,
        loEmail:    client.loEmail,
        _isBroker:  !!client._isBroker,
        loanCount:  (client.loans || []).length,
        loanIds:    (client.loans || []).map((l) => l && l.id),
      },
      ownerKey,
    });
  }

  // Look for matching quotes in the same owner namespace.
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const loanAddrNorm = normAddr(loan.address || '');
  const matchingQuotes = [];
  try {
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q) continue;
      const byId    = q.loanId === loanId;
      const byAddr  = !q.loanId && loanAddrNorm && normAddr(q.address || '') === loanAddrNorm;
      if (byId || byAddr) {
        matchingQuotes.push({
          key,
          id:         q.id,
          loanId:     q.loanId || null,
          status:     q.status,
          address:    q.address,
          matchedBy:  byId ? 'loanId' : 'address',
        });
      }
    }
  } catch (e) {
    matchingQuotes.push({ error: 'quote scan failed: ' + (e.message || 'unknown') });
  }

  // Pipeline visibility walk.
  const loanStatus = String(loan.status || 'active').toLowerCase();
  const hasQuote = matchingQuotes.some((q) => !q.error);
  const isUnpricedAutoCreate =
    loan.fromApplication
    && !loan.rate
    && !(loan.formData && loan.formData._finalRate);

  const visibility = { verdict: 'should_be_visible', reasons: [] };
  if (HIDDEN_STATUSES.has(loanStatus)) {
    visibility.verdict = 'hidden';
    visibility.reasons.push(
      `loan.status '${loanStatus}' is in pipeline's hidden set ` +
      `(on_hold, denied, closed, cancelled, liquidated, sold).`
    );
  }
  if (!hasQuote && isUnpricedAutoCreate) {
    visibility.verdict = 'hidden';
    visibility.reasons.push(
      'No matching quote AND loan is an unpriced auto-create ' +
      '(fromApplication=true, no rate, no formData._finalRate) — ' +
      'synthetic tile suppressed by Deploy 236.292.'
    );
  }
  if (!hasQuote && !isUnpricedAutoCreate) {
    visibility.notes = visibility.notes || [];
    visibility.notes.push('No matching quote in the owner namespace — pipeline would render a synthetic tile.');
  }

  // Also: is the tile currently in the LO's own pipeline load, or does
  // it require the admin "All" scope? Answer: this loan lives under
  // ownerKey; a non-admin logged in as anyone other than `owner` won't
  // see it. Any staff (admin/processor) on the All scope will.
  visibility.scopeNote =
    `This record lives under ownerKey='${ownerKey}'. It is only in the ` +
    `default (self-only) pipeline for the user whose keysafed email = ` +
    `that ownerKey. Everyone else must use the All scope to see it.`;

  return json(200, {
    found: true,
    ownerKey,
    client: {
      id:         client.id,
      loEmail:    client.loEmail,
      _isBroker:  !!client._isBroker,
      loanCount:  (client.loans || []).length,
    },
    loan: {
      id:                loan.id,
      status:            loan.status,
      address:           loan.address,
      rate:              loan.rate,
      loanAmt:           loan.loanAmt,
      loanType:          loan.loanType || loan.product,
      fromApplication:   !!loan.fromApplication,
      prospectId:        loan.prospectId || null,
      createdAt:         loan.createdAt,
      updatedAt:         loan.updatedAt,
      formDataFinalRate: loan.formData && loan.formData._finalRate,
      _owner:            loan._owner,
      processingStage:   loan.processingStage,
    },
    matchingQuotes,
    visibility,
  });
}
