/**
 * admin-pg-diff.mjs — GET /api/admin-pg-diff?clientId=X&loanId=Y
 *
 * Phase 2 diagnostic. Reads a loan (and its parent client) from BOTH
 * the blob store AND Postgres, returns them side-by-side with a
 * field-level diff of the loan. If dual-write is working the diff
 * should be empty. Any drift = the mirror hook isn't firing (or is
 * failing silently on that path).
 *
 * Body / query: { clientId, loanId, owner? }
 * Response:
 *   {
 *     ok, clientMatch, loanMatch,
 *     blob: { loan, clientTop },
 *     pg:   { loan, clientTop },
 *     loanDiff: { field: { blob: ..., pg: ... }, ... },
 *     clientDiff: same shape
 *   }
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { projectClient, projectLoan } from './_shared/pg-projections.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-pg-diff error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

// Fields we care about for the loan-level diff. Skipping extra + notes_log
// content because those are noisy JSONB — we compare the SHAPE (length)
// instead so we surface "PG has 3 notes, blob has 4" but not the full
// text of each entry.
const LOAN_DIFF_FIELDS = [
  'status','processing_stage','tool_type','loan_type','loan_amt','rate',
  'points','purchase_price','prop_value','rehab_budget','arv','prop_type',
  'fico','prepay','dscr','broker_id','is_broker_loan','from_application',
  'funding_date','maturity_date','servicer_name','servicer_url',
  'sla_display_id','address','notes','updated_at','saved_at',
];
const CLIENT_DIFF_FIELDS = [
  'first_name','last_name','email','phone','entity_name','display_name',
  'is_broker','is_broker_placeholder','notes','updated_at',
];

function _diff(blobRow, pgRow, fields) {
  const out = {};
  for (const f of fields) {
    const b = blobRow && blobRow[f];
    const p = pgRow   && pgRow[f];
    // Loose equality — DB nulls vs empty strings shouldn't count as a
    // diff, and 0 vs '0' shouldn't either. Anything more subtle we
    // want to see.
    if (String(b == null ? '' : b) !== String(p == null ? '' : p)) {
      out[f] = { blob: b, pg: p };
    }
  }
  return out;
}

function _arrLenDiff(blobRow, pgRow, key) {
  const b = Array.isArray(blobRow && blobRow[key]) ? blobRow[key].length : 0;
  const p = Array.isArray(pgRow   && pgRow[key])   ? pgRow[key].length   : 0;
  return b !== p ? { blob: b, pg: p } : null;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get('clientId') || '').trim();
  const loanId   = String(url.searchParams.get('loanId')   || '').trim();
  if (!clientId || !loanId) return json(400, { error: 'clientId + loanId required' });

  // Which owner's blob namespace to read from. Admin default: self;
  // pass ?owner=<email> to point elsewhere.
  const selfEmail = normalizeEmail(user.email);
  const ownerParam = String(url.searchParams.get('owner') || '').trim();
  const ownerKey = ownerParam ? keySafe(normalizeEmail(ownerParam)) : keySafe(selfEmail);

  // ── Blob side ──
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const blobKey = ownerKey + '/' + keySafe(clientId);
  const blobClient = await clientsStore.get(blobKey, { type: 'json' }).catch(() => null);
  const blobLoan = blobClient && Array.isArray(blobClient.loans)
    ? blobClient.loans.find((l) => l && l.id === loanId)
    : null;
  const blobClientProjected = blobClient ? projectClient(blobClient, ownerKey) : null;
  const blobLoanProjected   = blobLoan   ? projectLoan(blobLoan, clientId, ownerKey) : null;

  // ── PG side ──
  const pgClient = await db.first('clients', { eq: { id: clientId } }).catch(() => null);
  const pgLoan   = await db.first('loans',   { eq: { id: loanId }   }).catch(() => null);

  const loanDiff = _diff(blobLoanProjected, pgLoan, LOAN_DIFF_FIELDS);
  const notesLogDiff = _arrLenDiff(blobLoanProjected, pgLoan, 'notes_log');
  if (notesLogDiff) loanDiff.notes_log_length = notesLogDiff;

  const clientDiff = _diff(blobClientProjected, pgClient, CLIENT_DIFF_FIELDS);
  const clientNotesLogDiff = _arrLenDiff(blobClientProjected, pgClient, 'notes_log');
  if (clientNotesLogDiff) clientDiff.notes_log_length = clientNotesLogDiff;

  return json(200, {
    ok: true,
    ownerKey,
    clientId,
    loanId,
    blobFound: { client: !!blobClient, loan: !!blobLoan },
    pgFound:   { client: !!pgClient,   loan: !!pgLoan },
    loanDiff,
    clientDiff,
    loanMatch:   Object.keys(loanDiff).length   === 0,
    clientMatch: Object.keys(clientDiff).length === 0,
    // Include timestamps for quick sanity even when matched.
    blobTs: {
      client_updated_at: blobClientProjected && blobClientProjected.updated_at,
      loan_updated_at:   blobLoanProjected   && blobLoanProjected.updated_at,
    },
    pgTs: {
      client_updated_at: pgClient && pgClient.updated_at,
      loan_updated_at:   pgLoan   && pgLoan.updated_at,
    },
  });
}
