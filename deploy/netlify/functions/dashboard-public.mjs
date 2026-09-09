/**
 * dashboard-public.mjs — GET /api/dashboard-public
 *
 * Deploy 236.334 — the home-page dashboards (Performance / Upcoming Closings /
 * Loans by State / Loans table), open to any signed-in user so LOs see the
 * same company-wide numbers the admin dashboard shows.
 *
 * Deploy 236.912 (Mike: "update the Home Page dashboards to show information
 * from within SLA instead of Baseline") — the rows now come from SLA's own
 * loans in Postgres, not the Baseline mirror. The response keeps the SAME
 * field contract the home widgets already read (Status / Substatus / Name /
 * Loan_Amount / Rate / Origination_Points / TPO_Premium / Origination /
 * Created_Date / Address_State), because sla-dashboard.html feeds its shared
 * formulas through exactly that shape via adaptLoan(). This file is a
 * server-side port of adaptLoan() + slaStatusOf() + extractStateFromName()
 * from sla-dashboard.html — KEEP THE TWO IN SYNC, they must agree on what
 * "won", "on hold" and "in scope" mean or the home page and the dashboard
 * will report different numbers for the same book.
 *
 * Returns: { ok, count, loans: [ … ], _source: 'postgres' }
 */
import { handleOptions, json, requireAuth, normalizeEmail } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

const PAGE = 1000;
// Promoted columns + the extra JSONB (disposition, finalLoanAmount, tpo*,
// savedAt all live in extra) + the borrower name for the no-address label.
const SELECT = 'id,client_id,owner_email,address,status,processing_stage,tool_type,loan_amt,rate,points,' +
  'funding_date,sla_display_id,created_at,extra,clients!client_id(first_name,last_name,entity_name)';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('dashboard-public error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const loans = [];
  for (let offset = 0; ; offset += PAGE) {
    // Stable order so paging never skips or repeats a row between pages.
    const rows = await db.select('loans', { select: SELECT, limit: PAGE, offset, order: { created_at: 'desc' } });
    for (const r of (rows || [])) {
      const row = adaptRow(r);
      if (row) loans.push(row);
    }
    if (!rows || rows.length < PAGE) break;
    if (offset > 100000) break;   // belt and braces — the book is ~1k loans
  }

  return json(200, { ok: true, count: loans.length, loans, _source: 'postgres' });
}

// The TPO premium on file, distinguishing "deliberately zero" from "nobody has
// filled this in". Returns a number (possibly 0) or '' when nothing is on file.
//
// A real positive premium anywhere in the chain wins. Failing that, the first
// value that is explicitly present and numeric is returned as-is — so a stored
// zero survives as 0 and the dashboard can stop nagging about it.
function resolveTpoPremium(values) {
  let explicit = null;
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = parseFloat(v);
    if (!isFinite(n)) continue;
    if (n > 0) return n;
    if (explicit === null) explicit = n;
  }
  return explicit === null ? '' : explicit;
}

// ── Port of sla-dashboard.html adaptLoan() ────────────────────────────────
function adaptRow(r) {
  if (!r || !r.id) return null;
  const ex = (r.extra && typeof r.extra === 'object') ? r.extra : {};
  const c = r.clients || {};
  const tool = String(r.tool_type || ex.toolType || '').toLowerCase();
  const rate = parseFloat(r.rate);
  // SLA stores rate as a percent-number (10.45); the shared renderers expect
  // the mirror's decimal (0.1045).
  const rateDec = isFinite(rate) ? (rate > 1 ? rate / 100 : rate) : '';
  const borrower = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.entity_name || '';
  // Deploy 236.933 (Mike): an explicit 0 is an ANSWER, not a blank.
  // This used to collapse both to '', so a DSCR loan where someone had
  // deliberately entered a zero premium was indistinguishable from one nobody
  // had filled in — and the dashboard flagged it yellow forever, with no way to
  // clear the warning. A positive value still wins over a zero further down the
  // chain; '' now means, and only means, nothing on file anywhere.
  // Mirrored in sla-dashboard.html adaptLoan() — keep the two in step.
  const tpo = resolveTpoPremium([ex.tpo, ex.tpoPremium, ex.tpoSpread]);
  const status = String(r.status || '').toLowerCase();
  const stage = String(r.processing_stage || '').toLowerCase();
  const disposition = String(ex.disposition || '').toLowerCase();
  const address = r.address || '';
  const id = String(r.id);

  return {
    Id:   r.sla_display_id || id,
    Name: address || ('(no address — ' + (borrower || 'unknown') + ')'),
    Status: slaStatusOf({ status, stage, disposition }),
    Substatus: tool === 'dscr' ? 'DSCR' : (tool === 'rtl' || tool === 'guc') ? 'RTL' : '',
    Loan_Amount: Number(ex.finalLoanAmount || r.loan_amt) || 0,
    Rate: rateDec,
    Origination_Points: r.points != null ? r.points : (ex.points != null ? ex.points : ''),
    TPO_Premium: tpo,
    Origination: String(r.funding_date || ex.fundingDate || '').slice(0, 10),
    Created_Date: String(r.created_at || ex.savedAt || '').slice(0, 10),
    Address_State: extractStateFromName(address),
    // SLA-side extras — the home page links rows to Loan Details with these.
    _slaLoanId: id,
    _clientId: r.client_id || '',
    _ownerKey: normalizeEmail(r.owner_email || ''),
    _borrower: borrower,
    _tool: tool.toUpperCase(),
    _slaStatusRaw: String(r.status || ''),
    _dispositionRaw: String(ex.disposition || ''),
    _stageRaw: String(r.processing_stage || ''),
    // Deploy 236.786 — financial scope: the money metrics track the
    // PROCESSING pipeline + closed book, never the Leads pipeline. In scope
    // once handed to processing (has a stage), approved, or closed/serviced.
    _finScope: !!stage || !!disposition ||
               ['closed', 'sold', 'liquidated', 'approved'].indexOf(status) >= 0,
    _isImport: /^l_baseline_/.test(id),
  };
}

// ── Port of sla-dashboard.html slaStatusOf() ──────────────────────────────
// Collapses SLA's status + processingStage + disposition into the status
// vocabulary the shared classifiers (isWon / isOnHold / isArchived) read.
function slaStatusOf({ status, stage, disposition }) {
  const d = disposition.replace(/\s+/g, '_');
  if (d === 'sold') return 'sold';
  if (d === 'paid_off' || d === 'payoff') return 'liquidated';
  if (d === 'servicing' || d === 'pending_sale' || d === 'post_close') return 'in_servicing';
  if (stage === 'pp_closed') return 'closed';
  if (status === 'sold') return 'sold';
  if (status === 'closed') return 'closed';
  if (status === 'liquidated') return 'liquidated';
  if (status === 'denied') return 'declined';
  if (status === 'cancelled') return 'withdrawn';
  if (status === 'on_hold') return 'on_hold';
  if (status === 'approved') {
    if (stage === 'underwriting') return 'underwriting';
    if (stage === 'processing' || stage === 'new_loan') return 'in_processing';
    return 'approved';
  }
  if (status === 'submitted') return 'submitted';
  return 'lead';
}

// ── Port of sla-dashboard.html extractStateFromName() ─────────────────────
const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH ' +
  'NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC').split(' '));
const STATE_NAMES = [
  ['alabama','AL'],['alaska','AK'],['arizona','AZ'],['arkansas','AR'],['california','CA'],['colorado','CO'],
  ['connecticut','CT'],['delaware','DE'],['florida','FL'],['georgia','GA'],['hawaii','HI'],['idaho','ID'],
  ['illinois','IL'],['indiana','IN'],['iowa','IA'],['kansas','KS'],['kentucky','KY'],['louisiana','LA'],
  ['maine','ME'],['maryland','MD'],['massachusetts','MA'],['michigan','MI'],['minnesota','MN'],['mississippi','MS'],
  ['missouri','MO'],['montana','MT'],['nebraska','NE'],['nevada','NV'],['new hampshire','NH'],['new jersey','NJ'],
  ['new mexico','NM'],['new york','NY'],['north carolina','NC'],['north dakota','ND'],['ohio','OH'],['oklahoma','OK'],
  ['oregon','OR'],['pennsylvania','PA'],['rhode island','RI'],['south carolina','SC'],['south dakota','SD'],
  ['tennessee','TN'],['texas','TX'],['utah','UT'],['vermont','VT'],['virginia','VA'],['washington','WA'],
  ['west virginia','WV'],['wisconsin','WI'],['wyoming','WY'],['district of columbia','DC'],
];
function extractStateFromName(name) {
  if (!name) return '';
  const s = String(name);
  let m = s.match(/,\s*([A-Z]{2})(?:\s|,|$)/);
  if (m && US_STATES.has(m[1])) return m[1];
  m = s.match(/\b([A-Za-z]{2})[,\s]+\d{5}(?:-\d{4})?\b/);
  if (m && US_STATES.has(m[1].toUpperCase())) return m[1].toUpperCase();
  // Full-name pass: streets are named after states too ("Maryland Ave,
  // Cincinnati, Ohio") — the state is the name closest to the END.
  const lower = ' ' + s.toLowerCase().replace(/,/g, ' ') + ' ';
  let bestIdx = -1, bestCode = '';
  for (const [nm, code] of STATE_NAMES) {
    const at = lower.lastIndexOf(' ' + nm + ' ');
    if (at > bestIdx) { bestIdx = at; bestCode = code; }
  }
  return bestCode;
}
