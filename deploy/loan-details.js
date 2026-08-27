/**
 * loan-details.js — extracted from inline <script> block on
 * loan-details.html (Deploy 236.261, perf #3).
 *
 * ~6900 lines / ~400KB of the page were living inline, which meant
 * they redownloaded + re-parsed on every LO navigation to the
 * page — Netlify HTML now caches for 60s (Deploy 236.260) but the
 * JS itself deserves the same 'max-age=300, stale-while-
 * revalidate=86400' policy that every other .js file on the
 * site already carries. Extraction preserves 100% of the original
 * code — no behavior changes, no minification.
 *
 * Loaded from the same position as the inline block (bottom of
 * <body>) so DOM elements the script references are already
 * present when it runs.
 */

// ── E-signature feature flag ──────────────────────────────────────
// Was gated to super-admins during the PandaDoc-pilot phase. As of
// Deploy 185 the native eSign flow is the production path so this
// is on for everyone. The flag is kept (rather than ripping it out)
// in case we need to disable globally for an incident — flip to
// 'off' to hide.
var ESIGN_FEATURE = 'on';

function eSignVisible() {
  if (ESIGN_FEATURE === 'on')  return true;
  if (ESIGN_FEATURE === 'off') return false;
  return !!(_user && SLA && SLA.isSuperAdmin && SLA.isSuperAdmin(_user));
}

var _user = null;
var _clientId = null;
var _loanId = null;
var _client = null;
var _loan = null;
var _loEmail = null;

function escH(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { return String(s||'').replace(/"/g,'&quot;'); }
// Deploy 236.358 — cap at 2 decimals. Was: raw toLocaleString(), which
// rendered a monthly payment like 3024.6091 as '$3,024.609'. With the
// Intl options below whole-dollar amounts stay '$300,000' (min 0) and
// fractional amounts round to '$3,024.61' (max 2). Callers that need
// a strict '$3,024' form (already round via Math.round(n)) still get
// what they expect since the input is an integer.
function fmtM(n) {
  var v = Number(n);
  if (!v || isNaN(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
// Deploy 199: small helper for the Baseline panel + future status
// timestamps. Returns "2026-05-23 14:32 PM" style — locale, short.
function fmtDateTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}
// Deploy 236.647 — Product (RTL / DSCR / GUC) from toolType, and the FULL loan-
// type label (not the raw code like "light"). Labels come from FIN_DROPDOWNS
// (loanType_rtl / loanType_dscr, defined below) so there's one source of truth.
function _productLabel(l) {
  var t = String((l && l.toolType) || '').toLowerCase();
  return t === 'rtl' ? 'RTL' : (t === 'guc' ? 'GUC' : 'DSCR');
}
// Deploy 236.701 — GUC (ground-up construction) is an RTL-FAMILY product: it
// shares the RTL Loan Details layout (purchase price / build budget / ARV /
// LTP-LTC-LTARV, the UW tab, etc.), not the DSCR layout. So "is this the DSCR
// experience?" is true only when the loan is NEITHER rtl NOR guc. One helper,
// used everywhere isDscr was computed inline.
function _isDscrTool(tt) {
  var t = String(tt || '').toLowerCase();
  return t !== 'rtl' && t !== 'guc';
}
// Deploy 236.701 — GUC land/construction fields for the Loan Financials display.
function _isGucLoan(l) { return String((l && l.toolType) || '').toLowerCase() === 'guc'; }
function _loanTypeLabel(l) {
  var fd = (l && l.formData) || {};
  var t = String((l && l.toolType) || '').toLowerCase() === 'rtl' ? 'rtl' : 'dscr';
  var code = String((l && l.loanType) || fd.loanType || '');
  var opts = (typeof FIN_DROPDOWNS !== 'undefined' && FIN_DROPDOWNS['loanType_' + t]) || [];
  for (var i = 0; i < opts.length; i++) { if (opts[i].value === code) return opts[i].label; }
  // Deploy 236.692 — the exact label the sizer captured (matches the sizer's box).
  var storedLbl = String((l && l.loanTypeLabel) || fd.loanTypeLabel || '').trim();
  if (storedLbl) return storedLbl;
  if (code === 'transactional') return 'Transactional Funding (1-day)';
  if (code === 'construction')  return 'Construction';
  // Deploy 236.693 — a loanType that isn't a valid option for the loan's PROGRAM
  // (the toolType 'dscr'/'rtl' or blank — never captured by the Baseline
  // migration) shows UNSET (—) here for BOTH DSCR + RTL, matching the sizer,
  // instead of a bogus broad value like "dscr".
  return '';
}
// Deploy 236.691 — property-type label (matches the sizer / Property-tab options).
// Property Type is priced in the sizer, so it's shown (read-only) in Loan
// Financials and locked on the Property tab — one source of truth.
var _PROP_TYPE_LABELS = { sfr: 'SFR (1 Unit)', '2-4': '2–4 Unit', condo: 'Condo', nw_condo: 'Non-Warrantable Condo', multi: 'Multifamily', portfolio: 'Portfolio' };
function _propTypeLabel(l) {
  var code = String((l && l.propType) || '');
  return _PROP_TYPE_LABELS[code] || (l && l.propTypeLabel) || code || '—';
}

// Deploy 236.648 — read-only "Fees / Cash to Close" + "Cash Reserve Requirement"
// cards mirroring the sizer's rate sheet. Values recompute from the loan record
// (they're not stored), so the cards stay locked — no inputs — and always reflect
// the current pricing. RTL flat fees KEEP IN SYNC with rtl-sizer.html
// _rtlDefaultFees() ($2,150); DSCR flat fees reuse SLA_DSCR.FEES (dscr-pricing.js).
var LD_RTL_FLAT_FEES = [
  { label: 'Underwriting Fee',        amount: 600 },
  { label: 'Doc Prep Fee',            amount: 900 },
  { label: 'Legal / Document Review', amount: 500 },
  { label: 'Desktop Analysis',        amount: 150 },
];
function _fmtMoney0(n) {
  var v = Math.round(parseFloat(n) || 0);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
}
function _feeRow(label, amount, strong) {
  return '<div class="fee-row' + (strong ? ' fee-row-total' : '') + '">' +
    '<span class="fee-lbl">' + escH(label) + '</span>' +
    '<span class="fee-amt">' + _fmtMoney0(amount) + '</span></div>';
}
function _feesReserveHtml(l, isDscr, p) {
  var loanAmt   = parseFloat(p.loanAmt) || 0;
  var ratePct   = parseFloat(p.ratePct) || 0;
  var pts       = parseFloat(p.pointsNum) || 0;
  var rehab     = parseFloat(p.rehab) || 0;
  var down      = parseFloat(p.downPayment) || 0;
  var curLoan   = parseFloat(p.currentLoanAmt) || 0;
  var brokerPts = parseFloat(p.brokerFeePts) || 0;
  var isRefi    = !!p.isRefi;
  if (!loanAmt || !ratePct) return ''; // not yet priced — no fee sheet
  var origFee   = loanAmt * pts / 100;
  var brokerDol = brokerPts > 0 ? loanAmt * brokerPts / 100 : 0;
  var flat;
  if (isDscr) {
    var F = (typeof SLA_DSCR !== 'undefined' && SLA_DSCR.FEES) || { underwriting: 995, doc_prep: 700, legal_doc: 500, desktop_analysis: 120 };
    flat = [
      { label: 'Underwriting Fee',        amount: F.underwriting },
      { label: 'Doc Prep Fee',            amount: F.doc_prep },
      { label: 'Legal / Document Review', amount: F.legal_doc },
      { label: 'Desktop Analysis',        amount: F.desktop_analysis },
    ];
  } else {
    flat = (l._adminFees && Array.isArray(l._adminFees) && l._adminFees.length)
      ? l._adminFees.map(function(f){ return { label: f.label || f.name || 'Fee', amount: parseFloat(f.amount) || 0 }; })
      : LD_RTL_FLAT_FEES;
  }
  var flatTotal = 0; for (var i = 0; i < flat.length; i++) flatTotal += parseFloat(flat[i].amount) || 0;
  var totalFees = origFee + flatTotal + brokerDol;
  var ctc, ctcLabel;
  if (isRefi) {
    ctc = curLoan + totalFees - loanAmt;           // >0 borrower brings, <0 net TO borrower
    ctcLabel = ctc >= 0 ? 'Estimated Cash to Close' : 'Estimated Net to Borrower';
  } else {
    ctc = down + totalFees;
    ctcLabel = 'Estimated Cash to Close';
  }
  var rows = _feeRow('Origination (' + pts.toFixed(2) + ' pts)', origFee);
  for (var j = 0; j < flat.length; j++) rows += _feeRow(flat[j].label, flat[j].amount);
  if (brokerDol > 0) rows += _feeRow('Broker Fee (' + brokerPts.toFixed(2) + ' pts)', brokerDol);
  rows += _feeRow('Total Fees', totalFees, true);
  if (!isRefi) rows += _feeRow('Down Payment', down);
  rows += _feeRow(ctcLabel, Math.abs(ctc), true);
  var html = '<div class="section" id="ldFeesSection">' +
    '<div class="section-head"><h2>Fees / Cash to Close</h2><span class="section-tag tag-readonly">🔒 From rate sheet</span></div>' +
    '<div class="section-body"><div class="fee-card">' + rows + '</div>' +
    '<div class="fee-note">Calculated from the rate sheet / sizer — locked. Edit in the sizer to change.</div>' +
    '</div></div>';
  // Cash Reserve — RTL only, and not for transactional funding.
  if (!isDscr && String(l.loanType || '') !== 'transactional') {
    var moInt    = loanAmt * ratePct / 100 / 12;
    var hold6    = moInt * 6;
    var rehab20  = rehab * 0.20;
    var resTotal = ctc + hold6 + rehab20;
    var rr = _feeRow('Cash to Close', ctc) +
             _feeRow('6 Months Interest Reserve', hold6) +
             _feeRow('Rehab Reserve (20%)', rehab20) +
             _feeRow('Total Cash Reserve Requirement', resTotal, true);
    html += '<div class="section" id="ldReserveSection">' +
      '<div class="section-head"><h2>Cash Reserve Requirement</h2><span class="section-tag tag-readonly">🔒 From rate sheet</span></div>' +
      '<div class="section-body"><div class="fee-card">' + rr + '</div>' +
      '<div class="fee-note">Cash to Close + 6 months interest + 20% of rehab — from the sizer.</div>' +
      '</div></div>';
  }
  return html;
}

// Deploy 200: per-step pill strip for the Baseline panel. Steps are
// persisted on the loan record as a compact array (see baseline-sync-
// trigger.mjs). Each step is one of: entity / g1 / g2 / connect_g1 /
// connect_g2 / loan. Green pill = ok, red = failed; we trim the
// connect_* labels for compactness.
function renderBaselineSteps(steps) {
  if (!steps || !steps.length) return '';
  var STEP_LABELS = {
    entity:     'Entity',
    g1:         'Guarantor 1',
    g2:         'Guarantor 2',
    connect_g1: 'Link G1',
    connect_g2: 'Link G2',
    loan:       'Loan',
    loan_patch: 'Loan PATCH',
    precheck:   'Precheck',
  };
  var html = '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:4px">';
  steps.forEach(function(s) {
    var label = STEP_LABELS[s.step] || s.step;
    var color = s.ok ? 'var(--success, #1e6b3b)' : 'var(--danger, #7c1f1f)';
    var bg    = s.ok ? 'rgba(30,107,59,0.08)' : 'rgba(124,31,31,0.08)';
    var title = s.ok
      ? (label + ' ✓' + (s.status ? ' (HTTP ' + s.status + ')' : ''))
      : (label + ' ✕ ' + (s.error || 'failed') + (s.status ? ' (HTTP ' + s.status + ')' : ''));
    html += '<span title="' + escAttr(title) + '" style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:10.5px;font-weight:600;background:' + bg + ';color:' + color + ';border:1px solid ' + color + '">' +
      (s.ok ? '✓' : '✕') + ' ' + escH(label) +
    '</span>';
  });
  html += '</div>';
  return html;
}
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

function clientsKey(email) { return 'sla_clients_' + (email||''); }

// Deploy 236.330 (Tier 4) — freshness helper for the "Updated 2 min
// ago" indicator on Loan Details. Human-friendly relative-time
// output; refreshes every 30s via _startFreshnessRefresh() so the
// value stays honest without a full re-render.
function _formatFreshness(iso) {
  if (!iso) return '';
  var t = new Date(iso).getTime();
  if (!isFinite(t)) return '';
  var delta = Math.max(0, (Date.now() - t) / 1000); // seconds
  if (delta < 5)      return 'Updated just now';
  if (delta < 60)     return 'Updated ' + Math.round(delta) + 's ago';
  if (delta < 3600)   return 'Updated ' + Math.round(delta / 60) + 'm ago';
  if (delta < 86400)  return 'Updated ' + Math.round(delta / 3600) + 'h ago';
  if (delta < 604800) return 'Updated ' + Math.round(delta / 86400) + 'd ago';
  return 'Updated ' + new Date(iso).toLocaleDateString();
}
var _freshnessTimer = null;
function _startFreshnessRefresh() {
  if (_freshnessTimer) return;
  _freshnessTimer = setInterval(function() {
    var el = document.getElementById('ldFreshness');
    if (!el || !_loan) return;
    el.textContent = _formatFreshness(_loan.updatedAt || _loan.createdAt);
    el.title = _loan.updatedAt || _loan.createdAt || '';
  }, 30 * 1000);
}

// Deploy 236.61 — Baseline close-date lookup. Populated by a parallel
// fetch in onUser(); consumed when the Application Form section
// renders the "Desired Close Date" input. Stays null on fetch failure
// so the page falls back to local-only behavior.
// Deploy 236.63 — normalization upgraded to fold street suffixes /
// directionals / ", USA" so Baseline-typed and SLA Google-Places-
// formatted addresses agree. Mirrors baseline-close-dates.mjs +
// pipeline.html. Lookup tries three progressively looser keys.
var _baselineCloseDates = null;  // { byAddress: { <normAddr>: {closeDate, ...} } } or null
var _SUFFIX_MAP_LDX = {
  'street':'st','st.':'st',
  'avenue':'ave','ave.':'ave','av':'ave',
  'road':'rd','rd.':'rd',
  'drive':'dr','dr.':'dr',
  'boulevard':'blvd','blvd.':'blvd',
  'lane':'ln','ln.':'ln',
  'court':'ct','ct.':'ct',
  'circle':'cir','cir.':'cir',
  'place':'pl','pl.':'pl',
  'terrace':'ter','ter.':'ter',
  'parkway':'pkwy','pkwy.':'pkwy',
  'highway':'hwy','hwy.':'hwy',
  'square':'sq','sq.':'sq',
  'trail':'trl','trl.':'trl',
  'north':'n','south':'s','east':'e','west':'w',
  'northeast':'ne','northwest':'nw','southeast':'se','southwest':'sw',
};
function _normAddrLD(s) {
  var v = String(s || '')
    .toLowerCase()
    .replace(/,?\s*usa\s*$/i, '')
    .replace(/[,.#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  var toks = v.split(' ').map(function(t){ return _SUFFIX_MAP_LDX[t] || t; });
  return toks.join(' ');
}
function _streetKeyLD(s) {
  var norm = _normAddrLD(s);
  var m = norm.match(/^(\d+)\s+(.+)$/);
  if (!m) return '';
  var num = m[1];
  var rest = m[2]
    .replace(/^(n|s|e|w|ne|nw|se|sw)\b\s*/i, '')
    .replace(/\b(apt|unit|suite|ste|fl|floor|bldg)\b.*/i, '')
    .trim();
  var tail = rest.split(/\s+/).slice(0, 3).join(' ');
  return num + ' ' + tail;
}
function _baselineLookupLD(addr) {
  if (!addr || !_baselineCloseDates) return null;
  var k1 = _normAddrLD(addr);
  if (k1 && _baselineCloseDates[k1]) return _baselineCloseDates[k1];
  var k2 = _streetKeyLD(addr);
  if (k2 && _baselineCloseDates[k2]) return _baselineCloseDates[k2];
  var street1 = String(addr).split(',')[0].trim();
  var k3 = _normAddrLD(street1);
  if (k3 && _baselineCloseDates[k3]) return _baselineCloseDates[k3];
  return null;
}
function getBaselineCloseDateForLoan() {
  // Deploy 236.64 — temporarily disabled. The Baseline address matcher
  // is still missing for a chunk of loans, so the annotation under
  // the Desired Close Date input was showing the wrong value. The
  // lookup helpers (_normAddrLD, _streetKeyLD, _baselineLookupLD) and
  // the parallel fetch in onUser() all stay in place; flip this return
  // back to the real lookup once /api/baseline-close-dates?debug=<addr>
  // confirms the matcher is hitting reliably.
  return null;
  // eslint-disable-next-line no-unreachable
  if (!_baselineCloseDates || !_loan || !_loan.address) return null;
  var entry = _baselineLookupLD(_loan.address);
  return (entry && entry.closeDate) || null;
}

function init() {
  var params = new URLSearchParams(window.location.search);
  _clientId = params.get('clientId');
  _loanId   = params.get('loanId');
  // Phase 3 Supabase migration — short URL support. Was: hard-required
  // both clientId AND loanId (redirected to /clients if either was
  // missing). Now: loanId alone is enough because fetchLoan() reads
  // straight from Postgres by loanId and hydrates _clientId / _loEmail
  // from the response. Old three-param URLs still work — the fallback
  // path uses them when the loanId lookup misses (backfill lag, etc.).
  //
  // The Netlify rewrite /loan-details/:loanId → /loan-details.html?loanId=:loanId
  // uses status 200 (proxy) so the browser URL stays pretty
  // (/loan-details/l_xxx). Server sees the query param; browser's
  // window.location.search does NOT. That means URLSearchParams
  // above reads empty on a pretty URL. Fall back to parsing the
  // loanId out of the pathname when the query didn't have it.
  if (!_loanId) {
    var m = String(window.location.pathname || '').match(/^\/loan-details\/(l_[A-Za-z0-9_-]+)\/?$/);
    if (m) _loanId = m[1];
  }
  if (!_loanId) { window.location.href = '/clients.html'; return; }

  netlifyIdentity.on('init', function(user) {
    if (!user) { netlifyIdentity.open(); return; }
    onUser(user);
  });
  netlifyIdentity.on('login', function(user) { onUser(user); });
}

function onUser(user) {
  _user = user;
  _loEmail = user.email;
  // Deploy 236.317 — if the URL has ?owner=<lo>, respect it as the
  // authoritative loan-owner email immediately. Without this, an admin
  // who opens a cross-LO loan and clicks a mutation button (Add
  // Guarantor, Add Note, etc.) BEFORE fetchLoan()'s network call
  // resolves will send the request with no owner param — the backend
  // then looks under the admin's own namespace, fails with 404
  // "Primary client not found", and the mutation silently fails.
  // Reported specifically for the "Add Guarantor" flow. fetchLoan
  // still refines _loEmail from the byOwner response when it lands.
  try {
    var _p = new URLSearchParams(window.location.search);
    var _o = _p.get('owner');
    if (_o) _loEmail = _o;
  } catch (_) {}
  var navAdmin = document.getElementById('navAdminLink');
  if (navAdmin && window.SLA && SLA.isAdmin && SLA.isAdmin(user)) {
    navAdmin.style.display = 'inline-block'; var navSub=document.getElementById('navSubmissionsLink'); if(navSub) navSub.style.display='inline-block';
  }
  // Deploy 236.61 — fire the Baseline close-date lookup in parallel
  // with the loan fetch. Non-fatal on failure: a missing _baselineClose
  // Dates just means the "Desired Close Date" field renders without
  // its Baseline annotation. Calls render() again when the lookup
  // resolves so the annotation appears even on the cached first paint.
  if (window.SLA && SLA.Baseline && SLA.Baseline.Mirror && SLA.Baseline.Mirror.closeDates) {
    SLA.Baseline.Mirror.closeDates().then(function(r) {
      _baselineCloseDates = (r && r.byAddress) || {};
      if (_loan) { try { render(); } catch (_) {} }
    }).catch(function(){ _baselineCloseDates = {}; });
  } else {
    _baselineCloseDates = {};
  }

  // Deploy 194 (perf): stale-while-revalidate. First try the local
  // cache for instant paint. The cache is populated by any prior page
  // load (Clients page, Pipeline, etc.) within the last 5 minutes.
  // If found, render immediately; the fresh fetch still runs and
  // re-renders when it arrives. If not cached, skip directly to the
  // network fetch (no double-paint).
  var cachedFound = fetchLoanFromCache();
  if (cachedFound) {
    _client = cachedFound.client;
    _loan   = cachedFound.loan;
    render();
  }
  fetchLoan().then(function(found) {
    // Deploy 236.365 \u2014 verbose diagnostic logging on the not-found
    // path so Mike (or any admin) can share console output and I can
    // see exactly where the flow stalls. Kept prefixed with [SLA
    // loan-lookup] so it's easy to grep out later.
    if (!found || !found.loan) {
      console.log('[SLA loan-lookup] client-get for', _clientId, 'returned:', found);
    }
    // Deploy 236.356 \u2014 the not-found flow now distinguishes:
    //   found = null                           \u2192 client itself is gone
    //   found = { client, loan: null, ... }    \u2192 client exists, loan
    //                                             was moved (reassigned)
    //   found = { client, loan }               \u2192 happy path
    if (!found || !found.loan) {
      if (cachedFound) return; // already painted, leave it
      var clientId = _clientId || '';
      var loanId   = _loanId   || '';
      var paramsForOwner = new URLSearchParams(window.location.search);
      var ownerHref = paramsForOwner.get('owner');
      if (!found) {
        // Client itself couldn't be resolved. Deploy 236.362 \u2014 before
        // dead-ending, try to locate the loan by loanId alone. A client
        // merge (clients-merge-manual) folds the loser's loans into the
        // winner and deletes the loser blob \u2014 the URL then references
        // a client that genuinely no longer exists, but the loan lives
        // on under the winner. loan-locate consults the redirect map
        // (populated on merge, Deploy 236.362) so this resolves in one
        // blob read. On success we redirect; on failure we surface the
        // dead-end screen with the same actionable links loan-moved
        // uses.
        if (loanId && window.SLA && SLA.Loans && SLA.Loans.locate) {
          document.getElementById('pageContent').innerHTML =
            '<div style="padding:4rem;text-align:center;max-width:640px;margin:0 auto">' +
              '<h3 style="margin-bottom:12px">Client not found \u2014 checking loan location\u2026</h3>' +
              '<p style="color:var(--muted);margin-bottom:8px">The client may have been merged into another. Looking up the loan.</p>' +
            '</div>';
          console.log('[SLA loan-lookup] calling locate for loanId=' + loanId, {
            oldOwnerKey: ownerHref, oldClientId: clientId,
          });
          SLA.Loans.locate(loanId, {
            oldOwnerKey: ownerHref || undefined,
            oldClientId: clientId || undefined,
          }).then(function(locate) {
            console.log('[SLA loan-lookup] locate returned:', locate);
            if (locate && locate.found && locate.clientId && locate.ownerKey) {
              // Deploy 236.363 \u2014 guard against a redirect loop back to
              // the exact URL that just failed. If the index somehow
              // resolves to the same (owner, client) tuple that we
              // already tried and couldn't load, treat it as not-found
              // instead of infinite-redirecting.
              //
              // 236.373.2 \u2014 short-URL callers arrive here with clientId=''
              // (never in the URL), so the sameClient check always fails
              // and the guard never fires. Compare the DESTINATION URL to
              // the current URL instead: if they'd be identical, we'd
              // just reload into the same page and loop forever.
              var newUrl = SLA.urls.loanDetails(locate.loanId, { owner: locate.ownerKey });
              var here = window.location.pathname + window.location.search;
              if (newUrl === here) {
                console.log('[SLA loan-lookup] locate resolves to same URL \u2014 treat as not-found to avoid loop');
                _renderLoanNotLocatedScreen(clientId, loanId, ownerHref);
                return;
              }
              var sameOwner  = String(locate.ownerKey || '').toLowerCase() === String(ownerHref || '').toLowerCase();
              var sameClient = String(locate.clientId || '') === String(clientId || '');
              if (sameOwner && sameClient) {
                _renderLoanNotLocatedScreen(clientId, loanId, ownerHref);
                return;
              }
              document.getElementById('pageContent').innerHTML =
                '<div style="padding:4rem;text-align:center;max-width:640px;margin:0 auto">' +
                  '<h3 style="margin-bottom:12px">Loan moved \u2014 redirecting\u2026</h3>' +
                  '<p style="color:var(--muted);margin-bottom:12px">Found under ' + escH(locate.ownerKey || 'a new owner') + '. Opening now.</p>' +
                '</div>';
              setTimeout(function() { window.location.replace(newUrl); }, 400);
              return;
            }
            _renderLoanNotLocatedScreen(clientId, loanId, ownerHref, { locateResult: locate });
          }).catch(function(err) {
            console.error('[SLA loan-lookup] locate threw:', err);
            _renderLoanNotLocatedScreen(clientId, loanId, ownerHref, { locateError: (err && err.message) || String(err) });
          });
          return;
        }
        // No loanId in URL, or Loans.locate unavailable \u2192 the original
        // dead-end message. Should be rare (loanId is always in the
        // URL on a real loan-details visit).
        document.getElementById('pageContent').innerHTML =
          '<div style="padding:4rem;text-align:center;max-width:640px;margin:0 auto">' +
            '<h3 style="margin-bottom:12px">Client not found</h3>' +
            '<p style="color:var(--muted);margin-bottom:8px">The client <code style="background:#faf8f5;padding:2px 6px;border-radius:4px;font-family:\'DM Mono\',monospace;font-size:11px">' + escH(clientId) + '</code>' +
            (ownerHref ? ' under owner <code style="background:#faf8f5;padding:2px 6px;border-radius:4px;font-family:\'DM Mono\',monospace;font-size:11px">' + escH(ownerHref) + '</code>' : '') +
            " couldn't be loaded. It may have been deleted, or the URL bookmark is out of date.</p>" +
            '<p style="margin-top:20px"><a href="/clients.html">\u2190 Back to Clients</a></p>' +
          '</div>';
        return;
      }
      // Client resolved but the loan isn't on it \u2014 reassign moved it.
      // Deploy 236.356 \u2014 try to find where it landed via
      // /api/loan-locate (backed by the materialized clients-index)
      // and auto-redirect. Falls back to a helpful screen if the
      // loan can't be located (e.g. deleted, or index stale).
      document.getElementById('pageContent').innerHTML =
        '<div style="padding:4rem;text-align:center;max-width:640px;margin:0 auto">' +
          '<h3 style="margin-bottom:12px">This loan has been moved</h3>' +
          '<p style="color:var(--muted);margin-bottom:12px">Looking up its new location\u2026</p>' +
        '</div>';
      if (window.SLA && SLA.Loans && SLA.Loans.locate) {
        // Deploy 236.357 — pass the stale (owner, client) tuple so
        // the backend hits the redirect map directly (O(1)) and, on
        // an index-scan resolve, writes the redirect entry for the
        // next visitor.
        SLA.Loans.locate(loanId, {
          oldOwnerKey: ownerHref || undefined,
          oldClientId: clientId || undefined,
        }).then(function(locate) {
          if (locate && locate.found && locate.clientId && locate.ownerKey) {
            var newUrl = SLA.urls.loanDetails(locate.loanId, { owner: locate.ownerKey });
            // 236.373.2 \u2014 loop guard: if the resolved URL is the same
            // one we're already on, the loan is genuinely gone but the
            // index still lists it. Don't reload into ourselves.
            var here = window.location.pathname + window.location.search;
            if (newUrl === here) {
              _renderLoanNotLocatedScreen(clientId, loanId, ownerHref);
              return;
            }
            document.getElementById('pageContent').innerHTML =
              '<div style="padding:4rem;text-align:center;max-width:640px;margin:0 auto">' +
                '<h3 style="margin-bottom:12px">Loan moved \u2014 redirecting\u2026</h3>' +
                '<p style="color:var(--muted);margin-bottom:12px">Found under ' + escH(locate.ownerKey || 'a new owner') + '. Opening now.</p>' +
              '</div>';
            setTimeout(function() { window.location.replace(newUrl); }, 400);
            return;
          }
          // Not found anywhere. Show the actionable fallback.
          _renderLoanNotLocatedScreen(clientId, loanId, ownerHref);
        }).catch(function() {
          _renderLoanNotLocatedScreen(clientId, loanId, ownerHref);
        });
      } else {
        _renderLoanNotLocatedScreen(clientId, loanId, ownerHref);
      }
      return;
    }
    _client = found.client;
    _loan   = found.loan;
    render();
  }).catch(function(err) {
    if (!cachedFound) {
      document.getElementById('pageContent').innerHTML = '<div style="padding:4rem;text-align:center"><h3>Failed to load</h3><p>'+(err.message||'')+'</p><p><a href="/clients.html">\u2190 Back to Clients</a></p></div>';
    }
  });
}

// Deploy 236.356 \u2014 fallback screen when a moved loan can't be located
// anywhere (deleted, or the materialized index is out of sync). Gives
// the LO actionable next steps instead of a dead-end.
// Deploy 236.365 \u2014 optional { locateResult, locateError } param
// renders a collapsible diagnostic block so admins can share what
// actually came back from the locate call.
function _renderLoanNotLocatedScreen(clientId, loanId, ownerHref, diag) {
  var loanShort = loanId && loanId.length > 12 ? loanId.slice(0, 12) + '\u2026' : (loanId || '');
  var _diagBlock = '';
  if (diag) {
    var _diagJson = '';
    try { _diagJson = JSON.stringify(diag, null, 2); } catch (_) { _diagJson = String(diag); }
    var _isAdminUser = !!(window.SLA && SLA.isAdmin && SLA.isAdmin(_user));
    // Only admins get the raw JSON block; regular LOs don't need it.
    if (_isAdminUser) {
      _diagBlock =
        '<details style="margin-top:24px;text-align:left;max-width:520px;margin-left:auto;margin-right:auto">' +
          '<summary style="cursor:pointer;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600">Diagnostic (admin)</summary>' +
          '<pre style="background:#faf8f5;padding:12px 14px;border-radius:6px;font-family:\'DM Mono\',monospace;font-size:11px;color:#3f2f4d;overflow-x:auto;margin-top:8px;line-height:1.5">' +
            '<strong>URL params:</strong>\n' +
            '  clientId: ' + escH(clientId || '') + '\n' +
            '  loanId:   ' + escH(loanId || '') + '\n' +
            '  owner:    ' + escH(ownerHref || '') + '\n\n' +
            '<strong>Locate response:</strong>\n' + escH(_diagJson) +
          '</pre>' +
        '</details>';
    }
  }
  document.getElementById('pageContent').innerHTML =
    '<div style="padding:4rem 2rem;text-align:center;max-width:640px;margin:0 auto">' +
      '<h3 style="margin-bottom:12px">This loan couldn\'t be located</h3>' +
      '<p style="color:var(--muted);margin-bottom:12px">Loan <code style="background:#faf8f5;padding:2px 6px;border-radius:4px;font-family:\'DM Mono\',monospace;font-size:11px">' + escH(loanShort) + '</code> isn\'t on the client the URL points at, and the store walk didn\'t find it under any other client either.</p>' +
      '<p style="color:var(--muted);margin-bottom:6px;font-size:13px">Most common cause: a reassignment or client merge that left the loan orphaned. Open Pipeline to find its current tile, or check the old client for context.</p>' +
      '<div style="margin-top:24px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">' +
        '<a href="/pipeline.html" style="padding:10px 20px;background:var(--dark, #261A36);color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">Open Pipeline</a>' +
        '<a href="/client-details.html?clientId=' + encodeURIComponent(clientId) + (ownerHref ? '&owner=' + encodeURIComponent(ownerHref) : '') + '" style="padding:10px 20px;background:transparent;color:var(--muted);border:1.5px solid var(--border, #E4DFD4);text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">Open the old client</a>' +
      '</div>' +
      _diagBlock +
    '</div>';
}

// Deploy 236.103 \u2014 Processing-Pipeline badge content for the page
// subtitle. Prefers the new processingStage/processingSubstatus
// fields (set by the Kanban in 236.95 / auto-flow in 236.96); falls
// back to the legacy pipelineCol mapping when no stage is set yet.
// Returns { lbl, val, title } for rendering, or null when the loan
// isn't tracked in any pipeline column.
var _LD_STAGE_LABELS = {
  'new_loan':     'Intake',
  'processing':   'Processing',
  'underwriting': 'Underwriting',
  'pp_approved':  'Cleared to Close',
  'pp_closed':    'Closed',
};
function _pipelineBadgeContent(loan, pipelineColFallback) {
  var stage = String(loan && loan.processingStage || '').toLowerCase().trim();
  var sub   = String(loan && loan.processingSubstatus || '').trim();
  // Deploy 236.583 — a terminally-closed loan reads "Closed" even when its
  // processingStage was never advanced past an earlier stage (Baseline-closed
  // loans keep their pre-close stage). Status wins over the stale stage, so the
  // badge doesn't say "Processing: Underwriting" on a closed loan.
  var _st = String(loan && loan.status || '').toLowerCase().trim();
  if ((_st === 'closed' || _st === 'sold' || _st === 'liquidated') && stage !== 'pp_closed') {
    return { lbl: 'Processing:', val: 'Closed', title: 'Processing Pipeline: Closed' };
  }
  if (stage && _LD_STAGE_LABELS[stage]) {
    var label = _LD_STAGE_LABELS[stage];
    var val   = sub ? (label + ' \u00b7 ' + sub) : label;
    return {
      lbl:   'Processing:',
      val:   val,
      title: 'Processing Pipeline: ' + val,
    };
  }
  if (pipelineColFallback) {
    return {
      lbl:   'In Pipeline:',
      val:   pipelineColFallback,
      title: 'This loan is currently in the ' + pipelineColFallback + ' column of the Pipeline',
    };
  }
  return null;
}

// Deploy 236.103 \u2014 past-due Closing Date helpers. Past-due = the
// stored fundingDate is before today AND the loan isn't terminally
// closed (status !== 'closed' AND processingStage !== 'pp_closed').
// Used both on render and live as the LO edits the date input.
function _ldParseLocalDate(s) {
  if (!s) return null;
  var str = String(s).trim();
  var m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    var d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
    return isNaN(d.getTime()) ? null : d;
  }
  var d2 = new Date(str);
  return isNaN(d2.getTime()) ? null : d2;
}
function _ldIsLoanClosed(loan) {
  var st = String(loan && loan.status || '').toLowerCase();
  var stage = String(loan && loan.processingStage || '').toLowerCase();
  return st === 'closed' || st === 'liquidated' || stage === 'pp_closed';
}
function _ldIsCloseDatePastDueByDate(dateStr, loan) {
  if (_ldIsLoanClosed(loan)) return false;
  var d = _ldParseLocalDate(dateStr);
  if (!d) return false;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() < today.getTime();
}
function _ldIsCloseDatePastDue(loan) {
  return _ldIsCloseDatePastDueByDate(loan && loan.fundingDate, loan);
}
function _ldCloseDateClass(loan) {
  return _ldIsCloseDatePastDue(loan) ? 'past-due' : '';
}
function updateCloseDateClass() {
  var input = document.getElementById('af-fundingDate');
  var label = document.getElementById('ld-closeDateLabel');
  if (!input) return;
  var past = _ldIsCloseDatePastDueByDate(input.value, _loan);
  input.classList.toggle('past-due', past);
  if (label) label.style.display = past ? 'inline' : 'none';
}

// Deploy 194 (perf): synchronous lookup against localStorage cache so
// loan-details can paint without waiting on the network. Returns null
// if the cache is empty or the loan isn\u2019t in it; the caller then
// falls back to fetchLoan() exclusively.
function fetchLoanFromCache() {
  // Deploy 236.285 — skip cache entirely when arriving from an
  // apply-notify email (?fresh=1). The whole point of that link is
  // that the loan was just created and won't be in cache.
  try {
    var _p = new URLSearchParams(window.location.search);
    if (_p.get('fresh') === '1') return null;
  } catch (_) {}
  // Phase 3 — short URL support. Cache is keyed by clientId; without
  // it there's nothing to look up. PG lookup handles the render.
  if (!_clientId) return null;
  if (!window.SLA || !SLA.Clients || !SLA.Clients.listCached) return null;
  try {
    var clients = SLA.Clients.listCached();
    if (!Array.isArray(clients)) return null;
    for (var ci = 0; ci < clients.length; ci++) {
      if (clients[ci].id !== _clientId) continue;
      var loans = clients[ci].loans || [];
      for (var li = 0; li < loans.length; li++) {
        if (loans[li].id === _loanId) {
          return { client: clients[ci], loan: loans[li] };
        }
      }
    }
  } catch (e) { /* cache miss is fine, fall through */ }
  return null;
}

// Find the {client, loan} in the backend. Admins may pass ?owner= to view another LO's loan.
// Deploy 236.285 — ?fresh=1 (emitted on the "Open Loan Details" link in
// the apply-notify email) forces past the 5-min SWR cache in
// SLA.Clients.list(). Without it, a freshly-created loan would be
// invisible for up to 5 minutes because the recipient's cached clients
// list didn't include it yet.
function fetchLoan() {
  // Phase 3 Supabase migration — PG-first read path.
  //
  // 1. Try SLA.Loans.getPG(_loanId). Postgres knows about EVERY loan
  //    the migration has mirrored (Phase 1 backfill + Phase 2
  //    dual-write), no owner or clientId needed. Fastest path.
  //
  // 2. On PG miss (backfill lag, or a mutation that slipped past
  //    the mirror hook), fall back to the blob path. Requires
  //    _clientId — if the URL is loanId-only AND PG missed, we
  //    consult loan-locate to find (owner, clientId) then read
  //    from the blob.
  //
  // 3. The blob path (SLA.Clients.get) still returns
  //    { client, loan: null, loanMoved: true } when the client
  //    exists but the loanId isn't on it, so the "loan moved"
  //    redirect flow (Deploy 236.356+) keeps working for old
  //    bookmarks that point at pre-reassignment tuples.
  //
  // Downstream code expects _clientId + _loEmail to be populated
  // before render(). Both hydrate here whether we came from PG or
  // from the blob path.
  var params = new URLSearchParams(window.location.search);
  var ownerParam = params.get('owner');

  function _fromBlob() {
    // Original blob-store read path — preserved verbatim for the
    // Phase 3 fallback (backfill lag, mutation slipped past mirror,
    // etc.). See Deploy 236.345 / 236.356 comments in git history
    // for context.
    if (!_clientId) return Promise.resolve(null); // short URL + PG miss = truly not found
    return SLA.Clients.get(_clientId, ownerParam ? { owner: ownerParam } : {}).then(function(r) {
      if (!r || !r.client) return null;
      var client = r.client;
      var loans = client.loans || [];
      for (var i = 0; i < loans.length; i++) {
        if (loans[i].id === _loanId) {
          if (r.ownerKey) _loEmail = r.ownerKey;
          return { client: client, loan: loans[i] };
        }
      }
      return { client: client, loan: null, loanMoved: true, foundOwnerKey: r.ownerKey };
    }).catch(function() { return null; });
  }

  if (window.SLA && SLA.Loans && SLA.Loans.getPG) {
    return SLA.Loans.getPG(_loanId).then(function(pg) {
      if (pg && pg.loan && pg.client) {
        // Hydrate global state from the PG response so every
        // downstream component (which expects _clientId +
        // _loEmail set) works unchanged.
        if (pg.client.id) _clientId = pg.client.id;
        if (pg.ownerKey)  _loEmail  = pg.ownerKey;
        console.log('[SLA loan-lookup] PG hit for', _loanId);
        return { client: pg.client, loan: pg.loan };
      }
      // PG didn't have it — fall back to blob.
      console.log('[SLA loan-lookup] PG miss, falling back to blob for', _loanId);
      return _fromBlob();
    }).catch(function(err) {
      console.warn('[SLA loan-lookup] PG threw, falling back to blob:', err && err.message);
      return _fromBlob();
    });
  }
  // SLA.Loans.getPG isn't available (SDK didn't load cleanly).
  // Blob is the only source.
  return _fromBlob();
}

var STATUS_LABELS = { active:'Active', on_hold:'On Hold', submitted:'Submitted', approved:'Approved', denied:'Denied' };

function render() {
  var c = _client;
  var l = _loan;
  var fd = l.formData || {};
  // Deploy 236.330 (Tier 4) — kick off the freshness auto-refresh on
  // first render. Idempotent — the helper only starts the timer once.
  _startFreshnessRefresh();
  var isDscr = _isDscrTool(l.toolType);
  var status = l.status || 'active';
  var STATUS_LABELS = { active:'Active', on_hold:'On Hold', submitted:'Submitted', approved:'Approved', denied:'Denied' };
  // Deploy 236.643 — hoisted so the header status dropdown (next to Actions)
  // and the Actions-menu Merge button both see it.
  var _isAdminUser = !!(window.SLA && SLA.isAdmin && SLA.isAdmin(_user));

  // Map loan status → Pipeline column label, mirroring pipeline.html's
  // own bucket logic (lines ~717). Terminal statuses (on_hold, denied,
  // closed) don't appear in any pipeline column — we render nothing for
  // those so the badge doesn't lie.
  var PIPELINE_COLUMN = {
    active:       'Quoted',
    submitted:    'Submitted',
    awaiting_app: 'Awaiting Application',
    approved:     'In Processing',
  };
  var pipelineCol = PIPELINE_COLUMN[status] || null;

  // Sizer URL for "Open in Sizer" — passes clientId+loanId so the sizer
  // can pull the loan from the client record (works even when there's no
  // QuoteStore entry yet, e.g. for application-sourced loans).
  // Deploy 236.738 — GUC loans open in the GUC sizer (the label said "Open in
  // GUC Sizer" but this URL only knew DSCR vs RTL, so it landed on the RTL sizer).
  // Deploy 236.748 — Multifamily-program DSCR loans (loan.mfProgram, saved by
  // mf-dscr-sizer.html) reopen in the MF sizer.
  var sizerPage = isDscr ? (l.mfProgram ? '/mf-dscr-sizer.html' : '/dscr-sizer.html')
                : String(l.toolType || '').toLowerCase() === 'guc' ? '/guc-sizer.html'
                : '/rtl-sizer.html';
  var sizerParams = 'clientId=' + encodeURIComponent(c.id) + '&loanId=' + encodeURIComponent(l.id);
  if (l.address) sizerParams += '&loadQuote=' + encodeURIComponent(l.address);
  if (_loEmail && _user && _loEmail !== _user.email) sizerParams += '&owner=' + encodeURIComponent(_loEmail);
  var sizerUrl  = sizerPage + '?' + sizerParams;
  // Deploy 236.157 — Back now goes to the appropriate pipeline
  // (the page the LO most often arrived from), not to the
  // borrower's Client Details page. The breadcrumb's middle link
  // mirrors this; the borrower's name is still a click away via
  // the Contacts tab.
  // Deploy 236.634 — loans that have moved into the Processing pipeline
  // (approved / any processing stage) go BACK to processing-pipeline.html,
  // not the Leads pipeline — that's where they now live after the
  // sales→processing handoff.
  // Deploy 236.726 — Closed loans go back to /closed-loans.html (the servicing
  // Closed Loans page, open to everyone — LOs see their own read-only) instead
  // of the legacy /closed.html quotes list. Closed detection matches that
  // page's isClosedLoan(): status, processingStage, or Baseline status.
  var _backClosed = (function(){
    if (status === 'closed' || status === 'sold' || status === 'liquidated') return true;
    if (String(l.processingStage||'').toLowerCase().trim() === 'pp_closed') return true;
    var bl = String(l.baselineStatus||'').toLowerCase().replace(/[_\s]+/g,' ').trim();
    return (bl==='sold'||bl==='in servicing'||bl==='servicing'||bl==='liquidated'||bl==='paid off'||bl==='closed');
  })();
  var _backProcessing = !_backClosed && isInProcessing(l);
  var backPage  = _backClosed      ? '/closed-loans.html'
                : _backProcessing  ? '/processing-pipeline.html'
                :                    '/pipeline.html';
  var backLabel = _backClosed      ? 'Closed Loans'
                : _backProcessing  ? 'Processing Pipeline'
                :                    'Pipeline';
  var backUrl   = backPage;
  if (_loEmail && _user && _loEmail !== _user.email) backUrl += '?owner=' + encodeURIComponent(_loEmail);

  // Financial values — support flat or nested formData
  var loanAmt   = l.loanAmt    || fd.loanAmt    || '';
  var propVal   = l.propValue  || fd.propValue  || '';
  var loanType  = l.loanType   || fd.loanType   || '';
  // Deploy 236.40 — always render rate with 3 decimals to preserve
  // trailing zeros (6.350 instead of 6.35). The stored value can be
  // either a string like "6.350" (modern saves) or a number 6.35
  // (older records); normalize both paths through toFixed(3).
  // Deploy 236.210 — threshold-detect decimal-vs-percent. Baseline
  // imports store rate as a decimal (0.106 = 10.6%); SLA-native
  // saves store as already-percent (10.6). Anything <=1 gets
  // multiplied by 100. Same pattern loans.html:584 already uses.
  var _rateRaw  = l.rate       || fd._finalRate || '';
  var _rateNum  = parseFloat(_rateRaw);
  var _ratePct  = (isFinite(_rateNum) && _rateNum > 0 && _rateNum <= 1) ? _rateNum * 100 : _rateNum;
  var rate      = (_rateRaw && isFinite(_ratePct)) ? _ratePct.toFixed(3) : '';
  var buydown   = parseFloat(l.buydown  != null ? l.buydown  : (fd.buydown  != null ? fd.buydown  : 0)) || 0;
  // Points: use stored value, or compute from buydown (1 base + buydown)
  var rawPoints = l.points || fd._points || '';
  // If rawPoints is empty or '—', derive from buydown
  var pointsNum = rawPoints ? parseFloat(rawPoints) : (1 + buydown);
  if (isNaN(pointsNum)) pointsNum = 1 + buydown;
  var points    = pointsNum.toFixed(2) + ' pts';
  var fico      = l.fico       || fd.fico       || '';
  var ficoDisplay = l.ficoLabel || fd.ficoLabel || fico || '';
  var dscr      = l.dscr       || fd._dscr      || '';
  var loanPurpose = l.loanPurpose || fd.loanPurpose || '';
  var currentLoanAmt = l.currentLoanAmt || l.existingLoanAmt || fd.currentLoanAmt || fd.existingLoanAmt || '';
  // Deploy 236.133 — read both new (monthly*) and legacy (rent/taxes/
  // etc.) field names. Sizers + test-create-loan write monthlyRent,
  // monthlyTaxes, monthlyInsurance, monthlyHoa; older quote saves
  // and the inline editor flow now write those same names too.
  var rent      = l.monthlyRent      || l.rent      || fd.monthlyRent      || fd.rent      || '';
  var taxes     = l.monthlyTaxes     || l.taxes     || fd.monthlyTaxes     || fd.taxes     || '';
  var insurance = l.monthlyInsurance || l.insurance || fd.monthlyInsurance || fd.insurance || '';
  var hoa       = l.monthlyHoa       || l.hoa       || fd.monthlyHoa       || fd.hoa       || '';
  var appraisedValue = l.appraisedValue || fd.appraisedValue || '';
  var prepay    = l.prepay     || fd.prepay     || '';
  var isIO      = l.isIO       || fd.isIO       || '';
  // RTL specific
  var purchasePrice = l.purchasePrice || fd.purchasePrice || '';
  var rehabBudget   = l.rehabBudget   || fd.rehabBudget   || '';
  var arv           = l.arv           || fd.arv           || '';
  var experience    = l.experience    || fd.experience    || '';
  var experienceDisplay = l.experienceLabel || fd.experienceLabel || experience || '';
  var propTypeDisplay = l.propTypeLabel || fd.propTypeLabel || l.propType || fd.propType || '';
  var loanTerm      = l.loanTerm      || fd.loanTerm      || '';
  // Deploy 186 (bug 2 fix): Down Payment was previously gated on
  // _dpOverride being set, which meant it didn\u2019t appear on standard
  // (non-overridden) RTL loans even though the sizer computed it.
  // Pull from override first, then fall back to the pricing snapshot
  // captured at sizer save time.
  var downPayment = '';
  if (l._dpOverride && String(l._dpOverride) !== '') {
    downPayment = parseFloat(l._dpOverride) || '';
  } else if (l.pricingSnapshot && l.pricingSnapshot.downPayment) {
    downPayment = l.pricingSnapshot.downPayment;
  } else if (fd._pricingSnapshot && fd._pricingSnapshot.downPayment) {
    downPayment = fd._pricingSnapshot.downPayment;
  }

  // Deploy 236.103 — page-header now built into its own variable so
  // the post-render wrap can place it ABOVE the 2-column ld-layout
  // (instead of inside ld-main). That makes the Notes sidebar top
  // align with the Loan Financials top, not with the breadcrumb.
  var pageHeaderHtml = '<div class="page-header">' +
    '<div class="breadcrumb">' +
      '<a href="'+escAttr(backUrl)+'">'+escH(backLabel)+'</a>' +
      '<span class="breadcrumb-sep">›</span>' +
      '<span>Loan Details</span>' +
    '</div>' +
    '<div style="margin-bottom:12px"><a href="'+escAttr(backUrl)+'" class="back-btn"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7l5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> '+escH(backLabel)+'</a></div>' +
    // Deploy 236.73 — page-title row is a flex container so the Loan
    // Doc Review button (processor + admin only) can sit pushed-right
    // alongside the address. Regular LOs see just the address.
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">' +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
        '<div class="page-title">'+escH(l.address||'No address')+'</div>' +
        // Deploy 236.118 — Loan ID chip. Click to copy to clipboard.
        // Deploy 236.132 — display the SLA-YYYYMMDD-NNNN id (same
        // shape we push to Baseline) instead of the raw l_<ts>_<rand>
        // storage id. Stamped on the loan as slaDisplayId for new
        // loans; derived deterministically from id + fundingDate for
        // legacy loans so the displayed value stays stable.
        (function() {
          var displayId = (l.slaDisplayId && String(l.slaDisplayId).trim()) || _deriveSlaLoanIdClient(l);
          return '<span class="ld-loan-id" onclick="copyLoanId(this,\'' + escAttr(displayId) + '\')" title="Click to copy SLA loan ID (storage id: ' + escAttr(l.id || '') + ')">' +
            '<span class="ld-loan-id-label">Loan ID</span>' +
            '<span>' + escH(displayId || '(none)') + '</span>' +
          '</span>';
        })() +
        // Deploy 236.330 (Tier 4) — freshness chip. Passive
        // "Updated X ago" indicator so the LO can see at a glance
        // when the record last changed. Text refreshes every 30s
        // via _startFreshnessRefresh(). Empty title until the
        // helper populates it, so we don't flash "unknown" on
        // cached-first paint before the fetch resolves.
        '<span id="ldFreshness" class="ld-freshness" title="' + escAttr(l.updatedAt || '') + '" style="font-size:11.5px;color:var(--muted);font-family:DM Sans,sans-serif;font-weight:500">' +
          _formatFreshness(l.updatedAt || l.createdAt) +
        '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        // Deploy 236.643 — Change Status dropdown, admin-only, sits at the top
        // right next to the Actions dropdown (moved here from Loan Financials
        // per Mike). onchange → adminMoveStatus() (confirm-gated, audit-logged,
        // bypasses flow gates); a cancelled confirm resets the select.
        (_isAdminUser
          ? '<select id="adminStatusPick" onchange="adminMoveStatus()" title="Change loan status (admin) — bypasses flow gates, audit-logged in Notes" ' +
              'style="padding:9px 12px;border:1.5px solid var(--border, #E4DFD4);border-radius:8px;font-family:DM Sans,sans-serif;font-size:12px;font-weight:600;color:var(--dark);background:#fff;cursor:pointer;max-width:180px">' +
              '<option value="">Change Status…</option>' +
              '<option value="active">Quoted (active)</option>' +
              '<option value="on_hold">On Hold</option>' +
              '<option value="submitted">Submitted - Pending Review</option>' +
              '<option value="awaiting_app">Awaiting Application</option>' +
              '<option value="approved">In Processing (approved)</option>' +
              '<option value="closed">Closed</option>' +
              '<option value="denied">Declined</option>' +
              '<option value="cancelled">Cancelled</option>' +
            '</select>'
          : '') +
        // Deploy 236.102 — Actions dropdown aggregates the Rate Sheet
        // + Loan App buttons that used to clutter the Financials box.
        // The 6 buttons get moved into #ldActionsMenu by JS after
        // render so the menu reflects whatever the existing render
        // path produced (including conditional visibility).
        '<div class="ld-actions" id="ldActions">' +
          '<button type="button" class="ld-actions-btn" onclick="toggleLdActions(event)">' +
            '<svg width="14" height="14" viewBox="0 0 15 15" fill="none"><path d="M7.5 1.5L9 5h3.5l-2.8 2.5L10.5 11 7.5 9 4.5 11l0.8-3.5L2.5 5H6L7.5 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
            'Actions' +
            '<span class="caret">▾</span>' +
          '</button>' +
          '<div class="ld-actions-menu" id="ldActionsMenu">' +
            '<div class="ld-actions-empty">No actions available.</div>' +
          '</div>' +
        '</div>' +
        // Deploy 236.726 — Tasks button replaces the Loan Doc Review shortcut
        // here (Mike: too many tabs). Opens the Tasks modal; the open-task
        // count badge keeps its ldTabTasksCount id so _syncTasksTabCount
        // still feeds it. Doc Review itself is unchanged — it lives in the
        // Documents tab (the old button only jumped there anyway).
        '<button type="button" id="ldTasksBtn" onclick="openTasksModal()" ' +
          'style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:var(--gold, #C8813A);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:DM Sans,sans-serif;transition:opacity 0.15s">' +
          '<svg width="14" height="14" viewBox="0 0 15 15" fill="none"><path d="M2.5 4l1.5 1.5L7 2.5M2.5 8l1.5 1.5L7 6.5M2.5 12l1.5 1.5L7 10.5M9 4.5h4M9 8.5h4M9 12.5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          'Tasks' +
          '<span id="ldTabTasksCount" hidden style="background:#fff;color:var(--gold, #C8813A);border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;line-height:1.5"></span>' +
        '</button>' +
      '</div>' +
    '</div>' +
    '<div class="page-subtitle">' +
      '<span class="badge '+(l.toolType||'dscr')+'">'+((l.toolType||'dscr').toUpperCase())+'</span>' +
      '<span class="status-badge '+status+'">'+escH(STATUS_LABELS[status]||status)+'</span>' +
      // Deploy 236.103 — Processing Pipeline stage + substatus
      // replaces the static "In Pipeline" label. Pulls from
      // l.processingStage (set by the Kanban drag/drop in 236.95
      // and the auto-flow in 236.96); falls back to the old
      // pipelineCol mapping for loans that haven't been touched
      // since A.3 (so their processingStage is still empty).
      (function(){
        var pp = _pipelineBadgeContent(l, pipelineCol);
        if (!pp) return '';
        return '<span class="pipeline-badge" title="' + escAttr(pp.title) + '">' +
                 '<span class="lbl">' + escH(pp.lbl) + '</span>' + escH(pp.val) +
               '</span>';
      })() +
      // Broker Loan tag — Deploy 236.17 — now shows whenever the loan
      // is linked to a broker entity OR has any broker contact info,
      // not just when a non-zero broker fee was entered. Broker-app
      // submissions land here with no fee yet (LO sets it on sizer).
      ((parseFloat(l.brokerFee || 0) > 0)
        || (l.brokerId && String(l.brokerId).trim())
        || (l.brokerName && String(l.brokerName).trim())
        || (l.brokerEmail && String(l.brokerEmail).trim())
        ? '<span class="broker-loan-tag" title="This loan has a broker attached. See Broker Info below.">Broker Loan</span>'
        : '') +
      (c.firstName ? '<span style="color:var(--muted)">'+escH((c.firstName||'')+' '+(c.lastName||''))+'</span>' : '') +
    '</div>' +
  '</div>';

  // Deploy 236.103 — body starts fresh; header is assembled
  // separately above and re-stitched at the wrap step below.
  var html = '';

  // Deploy 236.102 — Processing Pipeline section removed per Mike.
  // Stage + substatus already live on the Processing Pipeline tile;
  // Close Date is captured in the Property & Application section
  // below. No need for a duplicate panel here.

  html += '<div class="two-col">';

  // LEFT COL — Financial details (read-only)
  html += '<div>';
  // Deploy 236.118 — id="loanFinancialsSection" so the tab restructure
  // can move this section into the Loan tab post-render.
  html += '<div class="section" id="loanFinancialsSection">' +
    '<div class="section-head"><h2>Loan Financials</h2></div>' +
    // Deploy 236.691 — reprice-as-portfolio warning. Set when a single-property
    // loan is converted to a portfolio without portfolio pricing; cleared when
    // re-priced through the sizer as a portfolio (or dismissed here).
    (l.needsRepricePortfolio
      ? '<div style="margin:0 0 12px;padding:10px 14px;background:#fdecea;border:1px solid #f5b5ae;border-left:4px solid #d93025;border-radius:8px;font-size:13px;color:#7c1f1f;display:flex;align-items:center;justify-content:space-between;gap:12px">' +
          '<span>⚠ <strong>Reprice as a Portfolio.</strong> This loan was converted to a portfolio but is still priced as a single property. Re-run the sizer as a Portfolio before it advances.</span>' +
          '<button type="button" onclick="dismissRepriceFlag()" title="Clear this flag (only after you\'ve confirmed the pricing)" style="flex:0 0 auto;padding:5px 10px;font-size:12px;font-weight:600;border:1px solid #f5b5ae;background:#fff;color:#7c1f1f;border-radius:6px;cursor:pointer;white-space:nowrap">Dismiss</button>' +
        '</div>'
      : '') +
    '<div class="section-body">';

  // Deploy 236.643 — the Loan Status changer moved OUT of Loan Financials up
  // to the page header, right next to the Actions dropdown (rendered in the
  // header build above). `_isAdminUser` is declared near the top of render().

  if (isDscr) {
    // Format loan purpose for display (e.g., "purchase" -> "Purchase")
    var purposeLabel = loanPurpose
      ? loanPurpose.charAt(0).toUpperCase() + loanPurpose.slice(1).replace(/_/g,' ')
      : '';
    // Item #12 + #4: prominent loan amount with override button.
    // When LO clicks Override, the field becomes editable and saving sets
    // loanAmtLocked=true so subsequent sizer re-saves don't blow it away.
    var lockedAttr = l.loanAmtLocked ? ' data-locked="1"' : '';
    html += '<div class="loan-hero"' + lockedAttr + '>' +
      '<div class="loan-hero-label">Loan Amount' + (l.loanAmtLocked ? ' <span class="loan-hero-lock">LO override</span>' : '') + '</div>' +
      '<div class="loan-hero-val" id="loanAmtDisplay">' + (loanAmt ? fmtM(loanAmt) : '<span class="empty">—</span>') + '</div>' +
      // Item #4: Reset to Max button when override is active
      (l.loanAmtLocked && l.maxLoan
        ? '<button type="button" class="loan-hero-reset" onclick="resetLoanAmtToMax()">Reset to Max ($' + Math.round(parseFloat(l.maxLoan)).toLocaleString() + ')</button>'
        : '') +
      '<button type="button" class="loan-hero-edit" onclick="overrideLoanAmt()">' + (l.loanAmtLocked ? 'Edit' : 'Override') + '</button>' +
    '</div>';
    // Deploy 164: pricing override tags on DSCR fin-grid. Note Rate cell
    // gets the gold "Overridden" pill when _rateOverride is set; a new
    // LTV cell only renders when _ltvOverride is set (LTV isn't shown
    // on DSCR Loan Details otherwise — it's implied by loanAmt/propVal).
    var _hasDscrRateOv = (l._rateOverride && String(l._rateOverride) !== '');
    var _hasDscrLtvOv  = (l._ltvOverride  && String(l._ltvOverride)  !== '');
    var _dscrOvTag = '<span class="override-tag" title="Manual override — applied by ' + escAttr(l._pricingOverrideBy || 'LO') + '">Overridden</span>';
    // Deploy 236.133 — live-recompute DSCR + LTV from the current
    // editable values, then flag a tier change vs the snapshot DSCR
    // saved by the sizer at quote time.
    var _liveDscr = _computeLiveDscr({
      loanAmt: parseFloat(loanAmt), rate: parseFloat(rate),
      rent: parseFloat(rent), taxes: parseFloat(taxes),
      insurance: parseFloat(insurance), hoa: parseFloat(hoa),
      isIO: isIO === 'yes',
    });
    var _liveDscrStr = (_liveDscr != null && isFinite(_liveDscr)) ? _liveDscr.toFixed(2) : '';
    var _snapDscr = parseFloat(dscr);
    // Deploy 236.134 — alert wording per Mike: "DSCR has changed.
    // Please reprice." Fires only when the live DSCR crosses a
    // pricing-tier boundary vs the sizer's quoted snapshot
    // (>=1.20 / 1.00-1.19 / <1.00).
    var _tierFlag = (isFinite(_snapDscr) && _liveDscr != null && _dscrTierOf(_snapDscr) !== _dscrTierOf(_liveDscr))
      ? '<span style="display:inline-block;margin-left:8px;padding:3px 9px;border-radius:10px;background:rgba(180,83,9,0.14);color:var(--warn, #7a5218);font-size:10px;font-weight:700;letter-spacing:0.02em;white-space:nowrap" title="Quoted: ' + _snapDscr.toFixed(2) + ' (' + _dscrTierLabel(_snapDscr) + ') · Live: ' + _liveDscrStr + ' (' + _dscrTierLabel(_liveDscr) + ')">⚠ DSCR has changed. Please reprice</span>'
      : '';
    // Appraised value drives LTV when set; falls back to propVal.
    var _ltvBaseVal = parseFloat(appraisedValue) || parseFloat(propVal);
    var _liveLtv = (isFinite(_ltvBaseVal) && _ltvBaseVal > 0 && parseFloat(loanAmt) > 0)
      ? (parseFloat(loanAmt) / _ltvBaseVal * 100) : null;
    var _liveLtvStr = (_liveLtv != null) ? _liveLtv.toFixed(1) + '%' : '';
    // Deploy 236.650 — DSCR grid reordered per Mike. "Property Value" replaces
    // the old Purchase-Price cell (which showed loanAmt). Existing Loan = 0 on a
    // purchase; Down Payment = 0 on a refi. "Am Type" (amortization) replaces the
    // Loan Type cell — Interest-Only, else the term structure (30-Year Fixed…).
    var _dscrIsRefi   = (loanPurpose === 'refi_co' || loanPurpose === 'refi_rt');
    var _dscrExisting = _dscrIsRefi ? (parseFloat(currentLoanAmt) || 0) : 0;
    var _dscrDownVal  = _dscrIsRefi ? 0
      : ((downPayment && parseFloat(downPayment)) ? parseFloat(downPayment)
        : (((parseFloat(purchasePrice) || 0) > (parseFloat(loanAmt) || 0)) ? (parseFloat(purchasePrice) - parseFloat(loanAmt)) : 0));
    // Deploy 236.691 — the "Am Type" cell shows whatever is in the sizer's Loan
    // Type box (l.loanType: 30-Year Fixed / 10-6 ARM / …), NOT an Interest-Only
    // override — the loan type is the amortization structure the sizer priced.
    var _dscrLtFull   = _loanTypeLabel(l);
    var _amType       = _dscrLtFull || '—';
    var _dscrLtvCell  = (_hasDscrLtvOv ? (parseFloat(l._ltvOverride) * 100).toFixed(1) + '%' : (_liveLtvStr || '<span class="empty">—</span>'));
    var _dscrRatioCell = (_liveDscrStr ? _liveDscrStr + 'x' : (dscr ? dscr + 'x' : '<span class="empty">Not yet quoted</span>'));
    var _dscrPrepay   = prepay
      ? (prepay==='54321'?'5yr (54321)':prepay==='321'?'3yr (321)':prepay==='320'?'2yr (320)':prepay==='300'?'1yr (300)':prepay==='5y6m'?'5Yr/6Mo':prepay==='none'?'None':prepay)
      : '<span class="empty">—</span>';
    // Deploy 236.759 — MF (5+) grid variant: show the /apply financials
    // (units, occupancy, other income, annual opex total) and drop the
    // monthly T/I/HOA cells (MF carries those inside the annual operating-
    // expense set on the Property tab). On a purchase, the value cell IS
    // the purchase price — label it that way (all DSCR).
    var _finIsMf = !!l.mfProgram; // 236.762 — marker only (see _isMfLoan)
    var _finIsPurchase = String(loanPurpose || '') === 'purchase';
    var _mfOpexTotal = ['opexTaxes','opexInsurance','opexFlood','opexUtilities','opexRepairs','opexMgmt','opexHOA','opexLandscaping']
      .reduce(function (sum, k) { return sum + (parseFloat(l[k]) || 0); }, 0);
    html += '<div class="fin-grid">' +
      // Row 1 — Note Rate | Points
      '<div class="fin-cell"><div class="fin-label">Note Rate' + (_hasDscrRateOv ? ' ' + _dscrOvTag : '') + '</div><div class="fin-val big">'+(rate ? rate+'%' : '<span class="empty">Not yet priced</span>')+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Points</div><div class="fin-val">'+(points||'<span class="empty">—</span>')+'</div></div>' +
      // Row 2 — Purchase Price (purchase) / Property Value (refi) | Loan Purpose
      '<div class="fin-cell"><div class="fin-label">'+(_finIsPurchase ? 'Purchase Price' : 'Property Value')+'</div><div class="fin-val">'+fmtM((_finIsPurchase && purchasePrice) ? purchasePrice : propVal)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Loan Purpose</div><div class="fin-val">'+(purposeLabel||'<span class="empty">—</span>')+'</div></div>' +
      // Row 3 — Existing Loan | Down Payment
      '<div class="fin-cell"><div class="fin-label">Existing Loan</div><div class="fin-val">'+_fmtMoney0(_dscrExisting)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Down Payment</div><div class="fin-val">'+_fmtMoney0(_dscrDownVal)+'</div></div>' +
      // Row 4 — Product | Am Type
      '<div class="fin-cell"><div class="fin-label">Product</div><div class="fin-val">'+escH(_productLabel(l))+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Am Type</div><div class="fin-val">'+escH(_amType)+'</div></div>' +
      // Row 5 — LTV | Appraised Value
      '<div class="fin-cell"><div class="fin-label">LTV' + (_hasDscrLtvOv ? ' ' + _dscrOvTag : '') + '</div><div class="fin-val">'+_dscrLtvCell+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Appraised Value</div><div class="fin-val">'+(appraisedValue ? fmtM(appraisedValue) : '<span class="empty">— click to add</span>')+'</div></div>' +
      // Row 6/7 — 1-4 unit: Monthly Rent + T/I/HOA. MF (5+): rent + the
      // /apply operating figures (units, occupancy, other income, opex).
      (_finIsMf
        // 236.762 — no "click to add" here: the MF cells are display-only
        // (edit rent in the MF Operating Statement on the Property tab).
        ? ('<div class="fin-cell"><div class="fin-label">Monthly Rent (all units)</div><div class="fin-val">'+(rent ? fmtM(rent) : '<span class="empty">—</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Other Income (mo)</div><div class="fin-val">'+(l.otherIncomeMo ? fmtM(l.otherIncomeMo) : '<span class="empty">—</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Units</div><div class="fin-val">'+(l.numUnits ? escH(String(l.numUnits)) : '<span class="empty">—</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Units Occupied</div><div class="fin-val">'+(l.unitsOccupied ? escH(String(l.unitsOccupied)) : '<span class="empty">—</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Operating Expenses (annual)</div><div class="fin-val">'+(_mfOpexTotal > 0 ? fmtM(_mfOpexTotal) : '<span class="empty">—</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Vacancy / Credit Loss</div><div class="fin-val">'+escH(String(l.vacancyPct || '5'))+'%</div></div>')
        : ('<div class="fin-cell"><div class="fin-label">Monthly Rent</div><div class="fin-val">'+(rent ? fmtM(rent) : '<span class="empty">— click to add</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Monthly Taxes</div><div class="fin-val">'+(taxes ? fmtM(taxes) : '<span class="empty">— click to add</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Monthly Insurance</div><div class="fin-val">'+(insurance ? fmtM(insurance) : '<span class="empty">— click to add</span>')+'</div></div>' +
           '<div class="fin-cell"><div class="fin-label">Monthly HOA</div><div class="fin-val">'+(hoa ? fmtM(hoa) : '<span class="empty">— click to add</span>')+'</div></div>')) +
      // Row 8 — DSCR | Prepayment Penalty
      '<div class="fin-cell"><div class="fin-label">DSCR' + _tierFlag + '</div><div class="fin-val'+(_liveDscr && _liveDscr >= 1.2 ? ' green' : '')+'">'+_dscrRatioCell+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Prepayment Penalty</div><div class="fin-val">'+_dscrPrepay+'</div></div>' +
      // Row 9 — FICO | Property Type (Deploy 236.691 — priced in the sizer, read-only here)
      '<div class="fin-cell"><div class="fin-label">FICO</div><div class="fin-val">'+(ficoDisplay||'<span class="empty">—</span>')+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Property Type</div><div class="fin-val">'+escH(_propTypeLabel(l))+'</div></div>' +
      // Trailing extras (conditional)
      (buydown > 0 ? '<div class="fin-cell"><div class="fin-label">Buy-Down Points</div><div class="fin-val">+'+buydown.toFixed(2)+' pts (↓ rate)</div></div>' : '') +
      (l.ref ? '<div class="fin-cell"><div class="fin-label">Referral Source</div><div class="fin-val">'+escH(l.ref)+'</div></div>' : '') +
      (parseFloat(l.brokerFee || 0) > 0
        ? '<div class="fin-cell"><div class="fin-label">Broker Fee</div><div class="fin-val">'+parseFloat(l.brokerFee).toFixed(2)+' pts</div></div>'
        : '') +
    '</div>';
  } else {
    // Item #4 + #12: hero loan amount with override
    var lockedAttr = l.loanAmtLocked ? ' data-locked="1"' : '';
    html += '<div class="loan-hero"' + lockedAttr + '>' +
      '<div class="loan-hero-label">Loan Amount' + (l.loanAmtLocked ? ' <span class="loan-hero-lock">LO override</span>' : '') + '</div>' +
      '<div class="loan-hero-val" id="loanAmtDisplay">' + (loanAmt ? fmtM(loanAmt) : '<span class="empty">—</span>') + '</div>' +
      // Item #4: Reset to Max button when override is active
      (l.loanAmtLocked && l.maxLoan
        ? '<button type="button" class="loan-hero-reset" onclick="resetLoanAmtToMax()">Reset to Max ($' + Math.round(parseFloat(l.maxLoan)).toLocaleString() + ')</button>'
        : '') +
      '<button type="button" class="loan-hero-edit" onclick="overrideLoanAmt()">' + (l.loanAmtLocked ? 'Edit' : 'Override') + '</button>' +
    '</div>';
    // Deploy 162: small "Overridden" tag next to rate/points/DP cells
    // when the matching pricing override is set on the loan record.
    // Visual cue so post-funding audits can spot manually-priced deals.
    var _hasRateOv   = (l._rateOverride   && String(l._rateOverride)   !== '');
    var _hasPointsOv = (l._pointsOverride && String(l._pointsOverride) !== '');
    var _hasDpOv     = (l._dpOverride     && String(l._dpOverride)     !== '');
    var _ovTag = '<span class="override-tag" title="Manual override — applied by ' + escAttr(l._pricingOverrideBy || 'LO') + '">Overridden</span>';
    // Deploy 196: derive actual-loan-amount metrics (monthly payment +
    // LTP/LTV/LTC/LTARV). All ratios are computed from the loanAmt that
    // will actually fund the loan — which may be an LO override below
    // the sizer's max — NOT the leverage caps that the sizer used to
    // size the loan. Hidden when the underlying inputs are missing or
    // the loan hasn't been priced yet.
    var _rtlLoanAmtNum  = parseFloat(loanAmt)      || 0;
    var _rtlRateDec     = parseFloat(rate)/100;
    if (!isFinite(_rtlRateDec) || _rtlRateDec <= 0) _rtlRateDec = 0;
    var _rtlPurchaseNum = parseFloat(purchasePrice) || 0;
    var _rtlRehabNum    = parseFloat(rehabBudget)   || 0;
    var _rtlArvNum      = parseFloat(arv)           || 0;
    // Dutch / Non-Dutch from loan record (saved by sizer Deploy 196).
    // Legacy loans saved before this field existed default to 'dutch'
    // — Deploy 197 flipped the default to match the new sizer behavior
    // (Dutch is the industry-standard private-lending structure).
    // Deploy 236.762 — GUC defaults non_dutch (matches Loan Terms 236.713).
    var _rtlIsDutch     = (l.dutchInterest || (fd && fd.dutchInterest) || (_isGucLoan(l) ? 'non_dutch' : 'dutch')) === 'dutch';
    // Rehab holdback proxy: any non-zero rehab budget means the loan
    // has an escrow component, so Non-Dutch will show a real start→max
    // dynamic. Bridge / refi / transactional all land here with rehab=0.
    var _rtlHasRehab    = _rtlRehabNum > 0;
    var _rtlMoMax       = (_rtlLoanAmtNum > 0 && _rtlRateDec > 0) ? (_rtlLoanAmtNum * _rtlRateDec / 12) : 0;
    var _rtlInitAdv     = _rtlHasRehab ? Math.max(0, _rtlLoanAmtNum - _rtlRehabNum) : _rtlLoanAmtNum;
    var _rtlMoStart     = (_rtlIsDutch || !_rtlHasRehab) ? _rtlMoMax
                          : ((_rtlInitAdv > 0 && _rtlRateDec > 0) ? (_rtlInitAdv * _rtlRateDec / 12) : 0);
    // Ratio denominators: on refis, "Purchase Price" is reused as the
    // as-is property value, so LTP becomes LTV; LTC/LTARV don't apply on
    // refis (no rehab/ARV path) — same convention as the sizer.
    var _rtlIsRefi      = (loanPurpose === 'cashout' || loanPurpose === 'rateterm');
    // Deploy 236.494 — LTP is the PURCHASE-side financing ÷ price, so it
    // must EXCLUDE the rehab holdback. Using the total loan (which bundles
    // the rehab escrow) made fix-flips read > 100% (e.g. 134.3%).
    // _rtlInitAdv = loanAmt − rehab holdback (= loanAmt when no rehab, so
    // this reduces to loan/price on bridge purchases and loan/as-is on refis).
    var _rtlLtpPct      = (_rtlPurchaseNum > 0) ? (_rtlInitAdv / _rtlPurchaseNum * 100) : null;
    var _rtlLtcPct      = (!_rtlIsRefi && (_rtlPurchaseNum + _rtlRehabNum) > 0)
                            ? (_rtlLoanAmtNum / (_rtlPurchaseNum + _rtlRehabNum) * 100) : null;
    var _rtlLtarvPct    = (!_rtlIsRefi && _rtlArvNum > 0)
                            ? (_rtlLoanAmtNum / _rtlArvNum * 100) : null;
    var _rtlLtpLbl      = _rtlIsRefi ? 'LTV' : 'LTP/LTV';
    function _rtlFmtMo(n) { return fmtM(n).replace(/\.00$/, '') + '/mo'; }
    function _rtlFmtPct(n){ return n != null ? n.toFixed(1) + '%' : '—'; }
    var _rtlMoCellHtml;
    if (_rtlMoMax <= 0) {
      _rtlMoCellHtml = '<div class="fin-val"><span class="empty">Not yet priced</span></div>';
    } else if (_rtlIsDutch) {
      _rtlMoCellHtml = '<div class="fin-val">'+_rtlFmtMo(_rtlMoMax)+'</div>' +
                       '<div class="fin-sub" style="font-size:11px;color:var(--muted);margin-top:2px">Dutch — flat</div>';
    } else if (Math.round(_rtlMoStart) !== Math.round(_rtlMoMax)) {
      _rtlMoCellHtml = '<div class="fin-val">'+_rtlFmtMo(_rtlMoStart)+' → '+_rtlFmtMo(_rtlMoMax)+'</div>' +
                       '<div class="fin-sub" style="font-size:11px;color:var(--muted);margin-top:2px">Non-Dutch — grows as rehab draws</div>';
    } else {
      _rtlMoCellHtml = '<div class="fin-val">'+_rtlFmtMo(_rtlMoMax)+'</div>';
    }

    // Deploy 236.647 — Initial Advance (loan minus rehab holdback) + LTAIV
    // (loan ÷ BPO AIV, l.aivBpo from the Property tab). Reorganized 2-col grid
    // per Mike: fixed rows, both cells always rendered so the pairing is stable.
    // Deploy 236.648 — Initial Advance = loanAmt − rehab (Mike's formula, also
    // = purchasePrice − downPayment). Computed live from the CURRENT loan amount
    // (_rtlInitAdv, line ~1048), not the sizer's stale pricingSnapshot which was
    // sized off the quote-time max and drifts when the LO overrides loanAmt.
    var _initAdvVal = _rtlInitAdv;
    var _aivBpoNum   = parseFloat(l.aivBpo) || 0;
    // Deploy 236.767 (Mike) — LTAIV is the AS-IS ratio, so it must run off the
    // INITIAL loan (the advance at close, rehab holdback excluded) ÷ BPO AIV.
    // Using the full loan (which bundles the rehab escrow) overstated it on
    // every fix-flip — same reasoning as LTP at line ~1250.
    var _rtlLtaivPct = (_aivBpoNum > 0 && _rtlInitAdv > 0) ? (_rtlInitAdv / _aivBpoNum * 100) : null;
    // Deploy 236.767 — BPO LTARV: the full loan (rehab included, since ARV is
    // the after-repair value) ÷ the BPO's OWN repaired value. Sits beside the
    // borrower-ARV LTARV so an LO can see the two diverge.
    var _arvBpoNum    = parseFloat(l.arvBpo) || 0;
    var _bpoLtarvPct  = (!_rtlIsRefi && _arvBpoNum > 0 && _rtlLoanAmtNum > 0)
                          ? (_rtlLoanAmtNum / _arvBpoNum * 100) : null;
    // Program max LTARV for THIS loan, straight from the live rate tables in
    // rtl-pricing.js (never duplicated here). Falls back to the 75% ceiling the
    // Loan Financials editor already warns on when the tier can't be resolved.
    var _maxLtarvPct  = _ldMaxLtarvPct(l, fico, experience);
    var _bpoLtarvOver = (_bpoLtarvPct != null && _maxLtarvPct > 0 && _bpoLtarvPct > _maxLtarvPct + 0.05);
    var _bpoAivUnder  = (_aivBpoNum > 0 && _rtlPurchaseNum > 0 && _aivBpoNum < _rtlPurchaseNum);
    var _ltFull = _loanTypeLabel(l);
    // Deploy 236.701 — GUC relabels + land rows in the shared RTL grid.
    var _isGuc = _isGucLoan(l);
    var _ownsLand = _isGuc && String(l.ownLand || '') === 'yes';
    html += '<div class="fin-grid">' +
      // Row 1 — Rate | Points
      '<div class="fin-cell"><div class="fin-label">Rate' + (_hasRateOv ? ' ' + _ovTag : '') + '</div><div class="fin-val big">'+(rate ? rate+'%' : '<span class="empty">Not yet priced</span>')+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Points' + (_hasPointsOv ? ' ' + _ovTag : '') + '</div><div class="fin-val">'+(points||'<span class="empty">—</span>')+'</div></div>' +
      // Row 2 — (GUC) Land Value | Construction Budget  ·  (RTL) Purchase Price | Rehab Budget
      '<div class="fin-cell"><div class="fin-label">'+(_isGuc?'Land Value':'Purchase Price')+'</div><div class="fin-val">'+fmtM(purchasePrice||loanAmt)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">'+(_isGuc?'Construction Budget':'Rehab Budget')+'</div><div class="fin-val">'+fmtM(rehabBudget)+'</div></div>' +
      // Row 3 — Down Payment | Initial Advance
      '<div class="fin-cell"><div class="fin-label">Down Payment'+(_hasDpOv ? ' ' + _ovTag : '')+'</div><div class="fin-val">'+fmtM(downPayment)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Initial Advance</div><div class="fin-val">'+fmtM(_initAdvVal)+'</div></div>' +
      // Row 4 — ARV | Monthly Payment
      '<div class="fin-cell"><div class="fin-label">ARV</div><div class="fin-val">'+fmtM(arv)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Monthly Payment</div>'+_rtlMoCellHtml+'</div>' +
      // Row 5 — Product | Loan Type (full label)
      '<div class="fin-cell"><div class="fin-label">Product</div><div class="fin-val">'+escH(_productLabel(l))+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">Loan Type</div><div class="fin-val">'+(_ltFull ? escH(_ltFull) : '<span class="empty">—</span>')+'</div></div>' +
      // Row 6 — Experience | FICO
      '<div class="fin-cell"><div class="fin-label">Experience</div><div class="fin-val">'+(experienceDisplay ? escH(experienceDisplay) : '<span class="empty">—</span>')+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">FICO</div><div class="fin-val">'+(ficoDisplay||'<span class="empty">—</span>')+'</div></div>' +
      // Row 7 — LTP/LTV | LTC
      '<div class="fin-cell"><div class="fin-label">'+_rtlLtpLbl+'</div><div class="fin-val">'+_rtlFmtPct(_rtlLtpPct)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">LTC</div><div class="fin-val">'+_rtlFmtPct(_rtlLtcPct)+'</div></div>' +
      // Row 8 — LTARV | LTAIV (LTAIV from the BPO AIV; "—" until aivBpo is set)
      '<div class="fin-cell"><div class="fin-label">LTARV</div><div class="fin-val">'+_rtlFmtPct(_rtlLtarvPct)+'</div></div>' +
      '<div class="fin-cell"><div class="fin-label">LTAIV</div><div class="fin-val">'+_rtlFmtPct(_rtlLtaivPct)+'</div></div>' +
      // Row 9 — BPO LTARV (Deploy 236.767, Mike): the loan ÷ the BPO's repaired
      // value, flagged red when it breaks this loan's program max.
      '<div class="fin-cell"><div class="fin-label">BPO LTARV' +
        (_maxLtarvPct > 0 ? ' <span style="text-transform:none;font-weight:400;color:var(--muted)">(max '+_maxLtarvPct.toFixed(0)+'%)</span>' : '') +
      '</div><div class="fin-val"' + (_bpoLtarvOver ? ' style="color:var(--danger,#b4432f)" title="Over the program max LTARV — the loan needs to be repriced."' : '') + '>' +
        _rtlFmtPct(_bpoLtarvPct) + (_bpoLtarvOver ? ' &#9888;' : '') +
      '</div></div>' +
      '<div class="fin-cell"><div class="fin-label">ARV (BPO)</div><div class="fin-val">'+(_arvBpoNum > 0 ? fmtM(_arvBpoNum) : '<span class="empty">—</span>')+'</div></div>' +
      // Property Type (Deploy 236.691 — priced in the sizer; read-only here + on the Property tab)
      '<div class="fin-cell"><div class="fin-label">Property Type</div><div class="fin-val">'+escH(_propTypeLabel(l))+'</div></div>' +
      // Deploy 236.701 — GUC land-ownership rows (from the sizer).
      (_isGuc ? '<div class="fin-cell"><div class="fin-label">Own the Land?</div><div class="fin-val">'+(_ownsLand?'Yes':'No')+'</div></div>' : '') +
      (_ownsLand ? '<div class="fin-cell"><div class="fin-label">Existing Land Debt</div><div class="fin-val">'+fmtM(l.landDebt||0)+'</div></div>' : '') +
      (_ownsLand ? '<div class="fin-cell"><div class="fin-label">Land Equity &#8594; Down Pmt</div><div class="fin-val">'+fmtM(l.landEquityCredit||0)+'</div></div>' : '') +
      // Trailing extras (conditional) — referral source + broker fee
      (l.ref ? '<div class="fin-cell"><div class="fin-label">Referral Source</div><div class="fin-val">'+escH(l.ref)+'</div></div>' : '') +
      (parseFloat(l.brokerFee || 0) > 0
        ? '<div class="fin-cell"><div class="fin-label">Broker Fee</div><div class="fin-val">'+parseFloat(l.brokerFee).toFixed(2)+' pts</div></div>'
        : '') +
    '</div>';
  }

  // Deploy 236.478 — the Funding Plan box moved OUT of here into its own
  // section directly below Property & Application (see fundingPlanSection).

  html += '<a href="'+escAttr(sizerUrl)+'" class="open-sizer-btn">' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 7.5h11M8.5 3l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    'Open in '+(isDscr?(l.mfProgram?'Multifamily DSCR':'DSCR'):(_isGucLoan(l)?'GUC':'RTL'))+' Sizer to Modify Financials' +
  '</a>';

  // Deploy 236.626 — if a signed rate-sheet envelope exists, this button downloads
  // the SIGNED copy instead of regenerating the unsigned sheet from the sizer.
  // refreshEnvelopes() sets _signedRateSheet + relabels the button once envelopes
  // load; downloadRateSheet() intercepts the click when a signed version is present.
  html += '<a id="ldDownloadRateSheetBtn" href="'+escAttr(sizerUrl + '&download=1')+'" class="open-sizer-btn term-sheet-btn" onclick="return downloadRateSheet(event)">' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 2v8M3.5 7l4 4 4-4M2 13h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<span id="ldRateSheetLabel">Download Rate Sheet</span>' +
  '</a>';

  // Deploy 236.578 — Proof of Funds letter. Generates the SLA POF letter as a
  // PDF download (jsPDF) for the borrower/broker. Uses the loan's assigned LO;
  // prompts for any missing fields (mainly the LO's phone) before printing.
  html += '<button type="button" id="ldPofBtn" class="open-sizer-btn" onclick="generatePofLetter()">' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 2h6l3 3v8H3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 2v3h3M5 8h5M5 10.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>' +
    'Print Proof of Funds Letter' +
  '</button>';

  // Deploy 236.42 — status gate dropped per Mike. Rate sheet is now
  // sendable in any loan status (previously gated to active /
  // submitted / awaiting_app / approved; terminal statuses were
  // hidden). Backend envelopes.mjs also dropped its status check so
  // the request actually goes through.
  if (eSignVisible()) {
    html += '<button type="button" id="ldSendRateSheetBtn" class="open-sizer-btn esign-btn" onclick="openSendForSignature()">' +
      '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 11s2-2 5.5-2 5.5 2 5.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M5 8c1-1 2-2 3-3l1 1c-1 1-2 2-3 3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
      'Send Rate Sheet for Signature' +
    '</button>';
  }

  // Deploy 236.82 — Generate Term Sheet button removed per Mike.
  // Functionality preserved in downloadTermSheet() for potential
  // future re-add; the button itself is no longer rendered.

  // Item #11: Gate the "Send Full Loan Application" button.
  // Enabled only after the loan has been submitted for review (status
  // submitted, awaiting_app, approved, or closed).
  var loanStatus = (_loan && _loan.status) || 'active';
  var canSendApp = ['submitted','awaiting_app','approved','closed'].indexOf(loanStatus) >= 0;
  var sendAppDisabled = canSendApp ? '' : ' disabled title="Available after the loan is submitted for review"';
  var sendAppExtraClass = canSendApp ? '' : ' send-app-disabled';

  html += '<button type="button" class="open-sizer-btn borrower-info-btn' + sendAppExtraClass + '" id="borrowerInfoBtn" onclick="openBorrowerInfoModal()"' + sendAppDisabled + '>' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="5" r="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 13c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    '<span id="borrowerInfoBtnLabel">Send Full Loan Application</span>' +
  '</button>';
  html += '<div id="borrowerInfoStatus" style="margin-top:6px;font-size:11px;color:var(--muted);text-align:center">' +
    (canSendApp ? '' : 'Submit the loan for review first to unlock.') +
  '</div>';

  // Review + Generate buttons — only enabled once the borrower has submitted
  // (status flips to 'complete'). Painted by refreshBorrowerInfoStatus.
  html += '<button type="button" class="open-sizer-btn review-app-btn" id="reviewAppBtn" onclick="openReviewLoanApp()" disabled style="margin-top:8px">' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 3l11 0M2 8l11 0M2 13l8 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    'Review Submitted Application' +
  '</button>';
  // Deploy 179: replaced the "Generate Loan Application (DOCX)" button
  // with a "Download Signed Application (PDF)" button. The application
  // is now signed by the borrower inline during the long-form flow,
  // and the signed PDF (with audit trail + ESIGN/UETA consent record)
  // is stored when they sign. The button is hidden until a signed
  // record exists for this loan — refreshSignedApplicationStatus()
  // unhides it.
  html += '<button type="button" class="open-sizer-btn term-sheet-btn" id="downloadSignedAppBtn" onclick="downloadSignedApp()" style="margin-top:8px;display:none">' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 2h6l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 2v3h3M7 7v4m-2-2l2 2 2-2" stroke="currentColor" stroke-width="1.5"/></svg>' +
    'Download Signed Application (PDF)' +
  '</button>';

  // Deploy 236.149 — separate bundle button removed; the existing
  // "Download Signed Application" button now downloads the full
  // regenerated bundle (signed app + all guarantor sections inline
  // + each guarantor's Credit Auth in the long-app format). One
  // entry point, one click.

  // Deploy 231 — Unsigned Loan Application PDF. Generated fresh from the
  // current borrower_info data, with [UNSIGNED — Filled by LO on behalf
  // of borrower] stamps replacing the signature glyphs. Useful when the
  // LO captured the long-app data via "Save on behalf" but the borrower
  // hasn't signed — gives the underwriter a readable snapshot without
  // chasing a signature. Renders only when there's borrower_info data
  // for this loan; refreshBorrowerInfoStatus() unhides it.
  html += '<button type="button" class="open-sizer-btn term-sheet-btn" id="downloadUnsignedAppBtn" onclick="downloadUnsignedApp()" style="margin-top:8px;display:none">' +
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 2h6l3 3v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 2v3h3M5 8h5M5 11h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    'Generate Application PDF (Unsigned)' +
  '</button>';

  // Deploy 236.764 — Reset Rate Lock (DSCR only; 45-day lock from the day
  // the loan application is signed). Rides into the Actions menu via
  // relocateActions; the click opens a Yes/No confirm modal.
  if (isDscr) {
    html += '<button type="button" class="open-sizer-btn" id="ldResetRateLockBtn" onclick="openResetRateLockModal()" style="margin-top:8px">' +
      '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 1.5a6 6 0 106 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13.5 1.5v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 4.5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      'Reset Rate Lock (45 days)' +
    '</button>';
  }

  // Deploy 236.770 — remove a denied/cancelled tag at any point in the
  // loan process (Mike: a nearly-closed loan sat invisible on the
  // Processing Pipeline behind a stale 'denied' with no way to clear it).
  // Renders only on denied/cancelled loans; rides into the Actions menu.
  var _reinstFrom = String((_loan && _loan.status) || '').toLowerCase();
  if (_reinstFrom === 'denied' || _reinstFrom === 'cancelled') {
    var _reinstLabel = _reinstFrom === 'denied' ? 'Denied' : 'Cancelled';
    html += '<button type="button" class="open-sizer-btn" id="ldReinstateBtn" onclick="openReinstateModal()" style="margin-top:8px">' +
      '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2.5 7.5l3.5 3.5 6.5-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      'Remove ' + _reinstLabel + ' Status' +
    '</button>';
  }
  // Small inline status under the button: signer name + signed-at + IP.
  // Hidden by default until refreshSignedApplicationStatus() fills it.
  html += '<div id="signedAppStatus" style="display:none;margin-top:10px;padding:10px 12px;background:#fff;border:1px solid var(--border, #E4DFD4);border-radius:6px;font-size:11.5px;line-height:1.5"></div>';

  // Deploy 167: manual "Move to In Processing" button. Visible only when
  // the loan is stuck in awaiting_app — i.e. the borrower has been sent
  // the loan application link but the auto-advance to approved didn't
  // fire (or fired and silently bailed due to address mismatch / missing
  // loanId on the borrower-info record / etc.). The button is gold
  // because it's an exceptional action; LOs shouldn't normally need it,
  // but it's the safety valve when the automatic transition breaks down.
  if (loanStatus === 'awaiting_app') {
    html += '<button type="button" class="open-sizer-btn" onclick="moveToInProcessing()" style="margin-top:14px;background:var(--gold);color:#fff;border-color:var(--gold)">' +
      '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 7.5h11M8.5 3l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      'Move to In Processing' +
    '</button>';
    html += '<div style="margin-top:6px;font-size:11px;color:var(--muted);text-align:center;font-style:italic">Use when the borrower has completed the application but the loan didn\'t auto-advance.</div>';
  }

  // Deploy 227 — the Send Rate Sheet for Signature button moved up to
  // sit directly below Download Rate Sheet (see earlier in this render).
  // Block formerly here has been removed; the upper placement is the
  // single source for the button.

  // Deploy 195 / Deploy 196 / Deploy 197: Cancel Loan + Decline Loan
  // moved further down in the action stack, just above "Delete this
  // loan", and restyled to match the rest of the action buttons (full-
  // width primary style with danger color) instead of the original
  // subtle text-only treatment. Block now lives below the envelope
  // history panel \u2014 see further down in this function.
  var _terminalForEnd = ['cancelled', 'denied', 'closed'];
  var _canEndLoan = _terminalForEnd.indexOf(loanStatus) < 0;

  // Deploy 195: Restore button \u2014 only visible when the loan is
  // currently cancelled. Reverts to the status the loan had immediately
  // before cancellation (stored in _cancelledFrom on the loan record).
  if (loanStatus === 'cancelled') {
    var restoreTarget = (l._cancelledFrom === 'awaiting_app') ? 'Awaiting Application' : 'In Processing';
    html += '<button type="button" class="open-sizer-btn" onclick="restoreCancelledLoan()" style="margin-top:14px;background:var(--gold);color:#fff;border-color:var(--gold)">' +
      '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3 7.5C3 5 5 3 7.5 3S12 5 12 7.5 10 12 7.5 12M3 7.5L1.5 6M3 7.5L4.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      'Restore Loan' +
    '</button>';
    html += '<div style="margin-top:6px;font-size:11px;color:var(--muted);text-align:center;font-style:italic">Will return to \u201c' + restoreTarget + '\u201d status.</div>';
  }

  // Envelope history panel — populated async by refreshEnvelopes()
  html += '<div id="envelopesPanel" class="envelopes-panel" style="margin-top:14px;display:none">' +
    '<div class="envelopes-panel-hdr">E-signature envelopes</div>' +
    '<div id="envelopesList"></div>' +
  '</div>';

  // Deploy 199/200 — Baseline LOS sync panel. Visible once the loan
  // has reached the approved gate OR has any Baseline sync history.
  // The Retry button is wired to /api/baseline-sync-trigger which
  // runs the full six-step orchestrator (entity → guarantors →
  // connect → loan). Mode is governed by BASELINE_DRY_RUN in the
  // Netlify env: default 'true' (dry-run, audit log only) — set to
  // the literal string 'false' to enable real Baseline calls.
  // Deploy 200 also surfaces per-step pass/fail pills from
  // _baselineLastSteps so the LO can see which step needs attention.
  // Deploy 236.641 — Baseline LOS sync log hidden for the Baseline→SLA
  // cutover (Mike). Code kept intact; flip this back to the commented
  // expression to re-enable if a sync ever needs surfacing again.
  var _showBaseline = false; // was: (loanStatus === 'approved') || !!l._baselineSyncStatus;
  if (_showBaseline) {
    var _bStatus = l._baselineSyncStatus || 'not_synced';
    var _bMode   = l._baselineSyncMode   || null;
    var _bAt     = l._baselineSyncedAt   || l._baselineLastAttemptAt || null;
    var _bErr    = l._baselineLastError  || null;
    var _bBy     = l._baselineLastAttemptBy || null;
    var _bEntId  = l._baselineEntityId   || null;
    var _bG1Id   = l._baselineGuarantor1Id || null;
    var _bG2Id   = l._baselineGuarantor2Id || null;
    var _bLoanId = l._baselineLoanId     || null;
    // Deploy 200 (Phase 2): per-step result strip. Persisted by the
    // trigger endpoint as a compact summary array so we can show
    // exactly which step failed without round-tripping to the audit
    // log. Each entry: { step, ok, status?, error? }.
    var _bSteps  = Array.isArray(l._baselineLastSteps) ? l._baselineLastSteps : [];
    // Deploy 207 (Phase 2.7.3): orchestrator debug bundle persisted
    // alongside the result so we can show what state the loan record
    // was in when the sync started, without needing to capture the
    // network response in DevTools.
    var _bDebug  = l._baselineLastDebug || null;

    var _bBadgeColor = _bStatus === 'synced'  ? 'var(--success, #1e6b3b)' :
                       _bStatus === 'partial' ? '#7a5218' :
                       _bStatus === 'failed'  ? 'var(--danger, #7c1f1f)' :
                                                'var(--muted, #7a7488)';
    var _bBadgeLabel = _bStatus === 'synced'     ? 'Synced'  :
                       _bStatus === 'partial'    ? 'Partial' :
                       _bStatus === 'failed'     ? 'Failed'  :
                                                   'Not synced';
    var _bBtnLabel = _bStatus === 'synced'  ? 'Re-sync to Baseline' :
                     _bStatus === 'partial' ? 'Retry Baseline sync' :
                     _bStatus === 'failed'  ? 'Retry Baseline sync' :
                                              'Send to Baseline';

    html += '<div class="envelopes-panel" style="margin-top:14px">' +
      '<div class="envelopes-panel-hdr" style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
        '<span>Baseline LOS</span>' +
        '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;background:#fff;border:1px solid var(--border, #E4DFD4);color:'+_bBadgeColor+'">'+escH(_bBadgeLabel)+'</span>' +
      '</div>' +
      '<div style="padding:10px 12px;font-size:12px;line-height:1.55;color:var(--text)">' +
        (_bMode ? '<div style="color:var(--muted);font-size:11px;margin-bottom:6px">Last sync ran in: <strong>'+escH(_bMode)+'</strong>'+(_bMode === 'dry-run' ? ' (audit log only — no HTTP calls made on that attempt)' : '')+'</div>' : '') +
        (_bAt ? '<div><strong style="font-weight:600">Last attempt:</strong> '+escH(fmtDateTime(_bAt))+(_bBy ? ' by '+escH(_bBy) : '')+'</div>' : '') +
        (_bErr ? '<div style="margin-top:6px;color:var(--danger, #7c1f1f);font-size:11.5px"><strong>Last error:</strong> '+escH(_bErr)+'</div>' : '') +
        (_bSteps.length ? renderBaselineSteps(_bSteps) : '') +
        // Deploy 207 — always show the debug block when present so it's
        // easy to copy/paste back. Tiny font, monospaced, in a
        // scrollable box. Renders the raw refs that came off the loan
        // record + the refs the orchestrator decided to use after
        // filtering. If they differ, the filter cleaned tainted state;
        // if both empty, the loan never had baseline metadata.
        (_bDebug ? '<details style="margin-top:10px;font-size:11px"><summary style="cursor:pointer;color:var(--muted);user-select:none">Diagnostic info (click to expand) — share if asked</summary>' +
          '<pre style="margin:6px 0 0;padding:8px;background:var(--bg, #f0ece5);border:1px solid var(--border, #E4DFD4);border-radius:6px;font-family:\'DM Mono\', monospace;font-size:10.5px;line-height:1.4;overflow-x:auto;white-space:pre-wrap">' + escH(JSON.stringify(_bDebug, null, 2)) + '</pre>' +
        '</details>' : '') +
        ((_bEntId || _bG1Id || _bG2Id || _bLoanId)
          ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border, #E4DFD4);font-family:\'DM Mono\', monospace;font-size:11px;color:var(--muted);line-height:1.7">' +
              (_bLoanId ? '<div><strong style="color:var(--text)">Loan:</strong> '+escH(_bLoanId)+'</div>' : '') +
              (_bEntId  ? '<div><strong style="color:var(--text)">Entity:</strong> '+escH(_bEntId)+'</div>' : '') +
              (_bG1Id   ? '<div><strong style="color:var(--text)">Guarantor 1:</strong> '+escH(_bG1Id)+'</div>' : '') +
              (_bG2Id   ? '<div><strong style="color:var(--text)">Guarantor 2:</strong> '+escH(_bG2Id)+'</div>' : '') +
            '</div>'
          : '') +
        '<button type="button" class="open-sizer-btn" onclick="triggerBaselineSync()" style="margin-top:12px">' +
          '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M2 7.5h11M8.5 3l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          escH(_bBtnLabel) +
        '</button>' +
        // Deploy 221 — "Reset Baseline link" button. Visible when any
        // Baseline ref is persisted (otherwise nothing to reset).
        // Use case: a loan stuck in a half-synced state (e.g. exists
        // in Baseline but missing Guarantor). Reset clears the SLA-
        // side refs; LO then manually deletes the orphan record in
        // Baseline UI and clicks Retry to create fresh.
        ((_bEntId || _bG1Id || _bG2Id || _bLoanId)
          ? '<button type="button" class="open-sizer-btn" onclick="resetBaselineLink()" style="margin-top:8px;background:transparent;color:var(--muted, #7a7488);border:1px dashed var(--border, #E4DFD4);font-size:12px">' +
              'Reset Baseline link (advanced)' +
            '</button>'
          : '') +
      '</div>' +
    '</div>';
  }

  // Deploy 236.355 — the Reassign / "Change Primary Guarantor"
  // button used to live here as a top-level action. It moved to the
  // Guarantor Info section on the Contacts tab, which is where the
  // LO is already looking at the current primary borrower's info —
  // discoverable in context instead of stranded up at the loan
  // header. See _renderChangePrimaryGuarantorRow() below.

  // Deploy 236.641 — the collapsible "Change Loan Status" box is dismantled:
  // its status <select> moved to the TOP of Loan Financials (admin), the
  // Baseline log is hidden, and these action buttons move into the Actions
  // menu at the top of the page. They render in a hidden holder so the
  // existing conditional-visibility (_canEndLoan / admin) is preserved;
  // relocateActions() moves them by id into #ldActionsMenu after render.
  var otherType = isDscr ? 'RTL' : 'DSCR';
  html += '<div id="ldStatusActionsHolder" style="display:none">' +
      '<button type="button" id="ldChangeTypeBtn" class="change-type-btn" onclick="openChangeTypeModal()" style="width:100%">' +
        '<svg width="13" height="13" viewBox="0 0 15 15" fill="none" style="vertical-align:-1px;margin-right:5px"><path d="M3 5h7l-2-2M12 10H5l2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        'Change to ' + otherType + ' Loan' +
      '</button>' +
      (_canEndLoan
        ? '<button type="button" id="ldCancelLoanBtn" class="open-sizer-btn" onclick="openCancelLoanModal()" style="margin-top:8px;background:#7C1F1F;color:#fff;border-color:#7C1F1F">' +
            '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M5 5l5 5M10 5l-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
            'Cancel Loan' +
          '</button>' +
          '<button type="button" id="ldDeclineLoanBtn" class="open-sizer-btn" onclick="openDeclineLoanModal()" style="margin-top:8px;background:#7C1F1F;color:#fff;border-color:#7C1F1F">' +
            '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="7.5" cy="7.5" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M4 7.5h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
            'Decline Loan' +
          '</button>'
        : '') +
      (_isAdminUser
        ? '<button type="button" id="ldMergeLoanBtn" class="open-sizer-btn" onclick="openMergeLoanModal()" style="margin-top:8px;background:rgba(133,77,14,0.10);color:#854d0e;border-color:rgba(133,77,14,0.40)">' +
            '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M4 3h3l2 2h3M4 12h3l2-2h3M11 5l-2-2M11 5l-2 2M11 10l-2-2M11 10l-2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            'Merge with another loan…' +
          '</button>'
        : '') +
      '<button type="button" id="ldDeleteLoanBtn" class="delete-loan-btn" onclick="deleteThisLoan()" style="margin-top:14px">' +
        '<svg width="13" height="13" viewBox="0 0 15 15" fill="none" style="vertical-align:-1px;margin-right:5px"><path d="M3 4h9M6 4V3a1 1 0 011-1h1a1 1 0 011 1v1M5 4l.5 8a1 1 0 001 1h3a1 1 0 001-1L11 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        'Delete this loan' +
      '</button>' +
  '</div>';

  html += '</div></div>'; // close section-body, section

  html += '</div>'; // close left col

  // RIGHT COL — Loan Terms (Deploy 236.641). This replaces the retired
  // "Property & Application" box: its physical fields (beds/baths/sqft/type/
  // rental) moved to the new Property tab, and Loan Purpose / Closing Date /
  // Description moved here. Term mechanics AUTO-DERIVE from the sizer/loan
  // when blank (fill-blanks only — a stored value always wins) and persist
  // via saveLoanTerms(). All users can edit their own loan (loan-fields-save
  // now allows owners; cross-owner override still needs staff).
  html += '<div>';
  // ---- auto-derive Loan Terms defaults (blank-fill) ----
  var _amortRaw = (l.isIO != null && l.isIO !== '') ? l.isIO : (fd.isIO != null ? fd.isIO : '');
  var _amortVal = (_amortRaw === true || _amortRaw === 'yes' || _amortRaw === 'io' || _amortRaw === 'interest_only' || _amortRaw === '1' || _amortRaw === 1) ? 'io'
                : (_amortRaw === false || _amortRaw === 'no' || _amortRaw === 'amortized' || _amortRaw === '0' || _amortRaw === 0) ? 'amortized' : '';
  if (!_amortVal) _amortVal = isDscr ? 'amortized' : 'io';
  var _lien = String(l.lienPosition || '').toLowerCase();
  if (_lien === '1' || _lien === '1st') _lien = 'first';
  if (_lien === '2' || _lien === '2nd') _lien = 'second';
  if (!_lien) _lien = 'first';
  var _ltTerm     = String(l.loanTerm || (isDscr ? '360' : '12'));
  // Deploy 236.644 — Origination Date === Closing Date (no separate field), and
  // First Payment + Maturity are non-editable, ALWAYS derived from the Closing
  // Date + Loan Term (recomputed live by recalcTermDates + on save). Prepayment
  // Penalty dropdown removed — it already shows in Loan Financials.
  var _ltOrig     = String(l.fundingDate || l.originationDate || '');
  var _ltFirstPay = _computeFirstPayment(_ltOrig) || '';
  var _ltMaturity = _addMonths(_ltOrig, parseInt(_ltTerm, 10)) || '';

  html += '<div class="section" id="loanTermsSection">' +
    '<div class="section-head"><h2>Loan Terms</h2><span class="section-tag tag-editable">Editable</span></div>' +
    '<div class="section-body">' +
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Loan Amount, Rate &amp; Points are managed in <strong>Loan Financials</strong>' + (isDscr ? '; TPO premium in <strong>Funding Plan</strong>.' : '.') + ' Blank terms auto-fill from the sizer.</div>' +
    '<div class="app-grid">' +
      '<div class="field"><label>Loan Purpose</label>' +
        '<select id="af-loanPurpose">' +
          '<option value="">Select…</option>' +
          '<option value="purchase"'+(l.loanPurpose==='purchase'?' selected':'')+'>Purchase</option>' +
          '<option value="refi_rt"'+(l.loanPurpose==='refi_rt'?' selected':'')+'>Rate/Term Refi</option>' +
          '<option value="refi_co"'+(l.loanPurpose==='refi_co'?' selected':'')+'>Cash-Out Refi</option>' +
          '<option value="refinance"'+(l.loanPurpose==='refinance'?' selected':'')+'>Refinance</option>' +
        '</select>' +
      '</div>' +
      '<div class="field"><label>Loan Term (months)</label><input type="number" id="lt-loanTerm" value="' + escAttr(_ltTerm) + '" min="0" oninput="recalcTermDates()" /></div>' +
      '<div class="field"><label>Amortization</label><select id="lt-isIO">' +
        '<option value="amortized"' + (_amortVal === 'amortized' ? ' selected' : '') + '>Fully Amortized</option>' +
        '<option value="io"' + (_amortVal === 'io' ? ' selected' : '') + '>Interest-Only</option>' +
      '</select></div>' +
      '<div class="field"><label>Lien Position</label><select id="lt-lienPosition">' +
        '<option value="first"' + (_lien === 'first' ? ' selected' : '') + '>First</option>' +
        '<option value="second"' + (_lien === 'second' ? ' selected' : '') + '>Second</option>' +
      '</select></div>' +
      // Deploy 236.713 — Interest Structure (RTL/GUC only; DSCR has no draw
      // structure). The Closed Loans Draws tab reads this for its computed UPB
      // and shows it read-only there — this box is THE place to change it.
      // Defaults: sizer-saved value, else GUC → Non-Dutch (only structure the
      // GUC program offers), else Dutch (system default since Deploy 197).
      (!isDscr ? (function(){
        var _ltDutch = String(l.dutchInterest || (fd && fd.dutchInterest) ||
          (String(l.toolType||'').toLowerCase()==='guc' ? 'non_dutch' : 'dutch')).toLowerCase()==='non_dutch' ? 'non_dutch' : 'dutch';
        return '<div class="field"><label>Interest Structure</label><select id="lt-dutchInterest">' +
          '<option value="dutch"' + (_ltDutch === 'dutch' ? ' selected' : '') + '>Dutch (full balance)</option>' +
          '<option value="non_dutch"' + (_ltDutch === 'non_dutch' ? ' selected' : '') + '>Non-Dutch (as drawn)</option>' +
        '</select></div>';
      })() : '') +
      // First Payment + Maturity — non-editable (Deploy 236.644); auto-calculated
      // from Closing Date + Loan Term by recalcTermDates(). Kept as disabled date
      // inputs so their .value is still readable in JS but the user can't edit.
      '<div class="field"><label>First Payment Date <span style="text-transform:none;font-weight:400;color:var(--muted)">(auto)</span></label><input type="date" id="lt-firstPaymentDate" value="' + escAttr(_ltFirstPay) + '" disabled title="Calculated from Closing Date + Loan Term" style="background:var(--bg,#f0ece5);color:var(--muted)" /></div>' +
      '<div class="field"><label>Maturity Date <span style="text-transform:none;font-weight:400;color:var(--muted)">(auto)</span></label><input type="date" id="lt-maturityDate" value="' + escAttr(_ltMaturity) + '" disabled title="Calculated from Closing Date + Loan Term" style="background:var(--bg,#f0ece5);color:var(--muted)" /></div>' +
      // Deploy 236.647 — Holdback (= Rehab Budget, already in Financials), Initial
      // Advance, and Down Payment removed from Loan Terms; Initial Advance + Down
      // Payment now live in the Loan Financials grid.
      // Deploy 236.61 — annotate the Desired Close Date input with
      // Baseline's Estimated_Close_Date when the address is known to
      // the mirror. Shown as a small line under the input so the LO
      // sees both the local value (editable, ahead of sync) and what
      // Baseline currently has on file. Defaults to nothing when the
      // lookup hasn't resolved yet or the loan isn't in the mirror.
      // Deploy 236.103 — past-due Closing Date highlight. Goes red
       // when the date is in the past AND the loan isn't closed
       // (status !== closed AND processingStage !== pp_closed).
       // _ldCloseDateClass and updateCloseDateClass keep it in sync
       // when the LO edits the date.
      '<div class="field"><label>Closing Date<span class="past-due-label" id="ld-closeDateLabel" style="display:' + (_ldIsCloseDatePastDue(l) ? 'inline' : 'none') + '">Past Due</span></label>' +
        '<input type="date" id="af-fundingDate" class="' + _ldCloseDateClass(l) + '" value="'+escAttr(l.fundingDate||'')+'" oninput="updateCloseDateClass();recalcTermDates()" />' +
        (function(){
          var bcd = getBaselineCloseDateForLoan();
          if (!bcd) return '';
          var ymd = String(bcd).match(/^(\d{4})-(\d{2})-(\d{2})/);
          var disp = bcd;
          if (ymd) {
            var d = new Date(parseInt(ymd[1],10), parseInt(ymd[2],10)-1, parseInt(ymd[3],10), 12, 0, 0);
            if (!isNaN(d.getTime())) {
              disp = d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
            }
          }
          var matchesLocal = (l.fundingDate && String(l.fundingDate).slice(0,10) === String(bcd).slice(0,10));
          var pillStyle = matchesLocal
            ? 'color:var(--muted)'
            : 'color:var(--gold-mid,#b5712d);font-weight:600';
          var note = matchesLocal ? ' (in sync)' : ' (Baseline value differs from local)';
          return '<div style="font-size:11px;margin-top:4px;' + pillStyle + '" title="Baseline Estimated Close Date">Baseline: ' + escH(disp) + escH(note) + '</div>';
        })() +
      '</div>' +
      '<div class="field span2"><label>Description of Project</label><textarea id="af-projectDescription" placeholder="Briefly describe the work the borrower plans to complete (F&amp;F loans only)">'+escH(l.projectDescription||'')+'</textarea></div>' +
      // Deploy 226 — Notes moved out of the Application Form section
      // and into a dedicated Notes audit log section rendered below.
      // The legacy free-form textarea is gone; new notes are timestamped
      // entries appended via the audit log UI, not the Save Changes
      // button (so app-form saves no longer touch loan.notes).
    '</div>' +
    '<div style="margin-top:16px;display:flex;align-items:center;gap:12px">' +
      '<button class="save-app-btn" onclick="saveLoanTerms()">Save Loan Terms</button>' +
      '<span id="loanTermsStatus" style="font-size:12px;color:var(--success);display:none">Saved ✓</span>' +
    '</div>' +
  '</div></div>'; // close section (Loan Terms)

  // ── Deploy 236.478 (feat): Funding Plan — its own section, directly
  // below Property & Application (per Mike's screenshot; moved out of the
  // Loan Financials card). Captures how the loan will be funded:
  //   • Funding Source dropdown (Stride / King Arthur Fund / SLA Capital
  //     / Correspondent / Other). "Other" reveals a one-time free-text
  //     name that is NOT added to any universal list (l.fundingSourceOther).
  //   • Investor — picked from the admin-managed Investors book. Options
  //     load async (populateFundingPlanInvestors); we snapshot the name
  //     onto the loan (l.investorName) so it survives the investor being
  //     removed from the book.
  //   • DSCR → "TPO" (premium; 1 TPO = 1 point, stored l.tpo).
  //     RTL  → "Buy Rate" (yield spread, stored l.buyRate).
  // No pricing math yet — stored only. Saved via saveFundingPlan()
  // (whole-client save, same path as the App-form fields).
  var _fpSrc   = String(l.fundingSource || '');
  var _fpOther = String(l.fundingSourceOther || '');
  var _fpSrcOpts = [
    ['', '— Select —'],
    ['stride', 'Stride'],
    ['king_arthur', 'King Arthur Fund'],
    ['sla_capital', 'SLA Capital'],
    ['correspondent', 'Correspondent'],
    ['other', 'Other'],
  ];
  var _fpSrcOptHtml = '';
  for (var _fpi = 0; _fpi < _fpSrcOpts.length; _fpi++) {
    var _fpo = _fpSrcOpts[_fpi];
    _fpSrcOptHtml += '<option value="' + _fpo[0] + '"' + (_fpo[0] === _fpSrc ? ' selected' : '') + '>' + escH(_fpo[1]) + '</option>';
  }
  var _fpPriceLabel = isDscr ? 'TPO (points)' : 'Buy Rate (%)';
  // Deploy 236.672 — the Baseline migration stored TPO on loan.tpoPremium; the
  // Funding Plan's own field is loan.tpo. Fall back to tpoPremium so migrated DSCRs
  // show their TPO (saving here rewrites it to the canonical loan.tpo).
  var _fpTpo        = (l.tpo != null && l.tpo !== '') ? l.tpo : (l.tpoPremium != null ? l.tpoPremium : '');
  var _fpPriceVal   = isDscr ? _fpTpo : (l.buyRate != null ? l.buyRate : '');
  var _fpPriceHint  = isDscr
    ? 'Third-party origination premium. 1 TPO = 1 point.'
    : 'Yield spread — the rate this loan is bought at.';
  html += '<div class="section" id="fundingPlanSection">' +
    '<div class="section-head"><h2>Funding Plan</h2><span class="section-tag tag-editable">Editable</span></div>' +
    '<div class="section-body">' +
      '<div class="app-grid">' +
        '<div class="field"><label>Funding Source</label>' +
          '<select id="fp-fundingSource" onchange="onFundingSourceChange()">' + _fpSrcOptHtml + '</select>' +
        '</div>' +
        '<div class="field" id="fp-otherWrap"' + (_fpSrc === 'other' ? '' : ' style="display:none"') + '><label>Other Source (one-time)</label>' +
          '<input type="text" id="fp-fundingSourceOther" value="' + escAttr(_fpOther) + '" placeholder="e.g. private lender name" maxlength="80" />' +
        '</div>' +
        '<div class="field"><label>Investor</label>' +
          '<select id="fp-investorId" data-current="' + escAttr(String(l.investorId || '')) + '">' +
            '<option value="">— None —</option>' +
            // Seed the current selection so it shows before the async book
            // loads; populateFundingPlanInvestors() replaces these options.
            (l.investorId ? '<option value="' + escAttr(String(l.investorId)) + '" selected>' + escH(l.investorName || 'Selected investor') + '</option>' : '') +
          '</select>' +
        '</div>' +
        '<div class="field"><label>' + _fpPriceLabel + '</label>' +
          '<input type="text" id="fp-pricing" value="' + escAttr(String(_fpPriceVal)) + '" placeholder="0" inputmode="decimal" />' +
          '<div style="font-size:11px;color:var(--muted);margin-top:4px">' + _fpPriceHint + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:16px;display:flex;align-items:center;gap:12px">' +
        '<button class="save-app-btn" onclick="saveFundingPlan()">Save Funding Plan</button>' +
        '<span id="fundingPlanStatus" style="font-size:12px;color:var(--success);display:none">Saved ✓</span>' +
      '</div>' +
    '</div>' +
  '</div>';

  // ── Deploy 236.641 — Property / Collateral section. Rendered here after the
  // two-col, then relocated to the new PROPERTY TAB (relocateSectionsToTabs).
  // Holds all collateral detail PLUS the physical fields (beds/baths/sq ft/
  // property type/rental type) that used to live in the now-retired Property &
  // Application box — REUSING their af-* ids so downstream references + the
  // long-app sync keep working. Carrying costs carry the monthly/annual toggle
  // (stored monthly). Saved via savePropertyCollateral() → loan-fields-save
  // (owner-editable since 236.641). _amortVal/_lien were computed
  // for the Loan Terms right-col above; only the carrying-cost bases are new.
  var _mTaxes = String(taxes || '');
  var _mIns   = String(insurance || '');
  var _mHoa   = String(hoa || '');
  // Deploy 236.759 — MF (5+) loans: the Property/Collateral box duplicated the
  // MF Operating Statement (units, rental type, carrying costs vs the annual
  // opex set). Mike: the Operating Statement becomes the SOLE Property-tab box
  // for MF, with the Valuation fields appended at its bottom. Portfolio loans
  // keep the P/C box (the per-property tabs live there).
  // Deploy 236.762 — key on the mfProgram MARKER only (not propType
  // 'multi'): legacy/Baseline DSCR loans can carry propType 'multi'
  // without being in the MF program, and stripping their P/C box +
  // monthly T/I/HOA cells left their displayed DSCR driven by fields
  // nobody could see or edit. Every real MF-program loan has the marker
  // (stamped by prospects-save and the MF sizer).
  // Deploy 236.767 (Mike) — AIV / ARV BPO become read-only once they've been
  // read off an uploaded BPO (loan.aivBpoFromBpo / arvBpoFromBpo). The BPO is
  // the authority; correcting them means uploading a corrected BPO.
  var _aivBpoLocked = !isDscr && l.aivBpoFromBpo === true;
  var _arvBpoLocked = !isDscr && l.arvBpoFromBpo === true;

  var _isMfLoan = !l.isPortfolio && !!l.mfProgram;
  if (!_isMfLoan)
  html += '<div class="section" id="propertyCollateralSection">' +
    '<div class="section-head"><h2>Property / Collateral</h2><span class="section-tag tag-editable">Editable</span>' +
      // Deploy 236.688 — convert a single-property loan into a Portfolio so more
      // properties can be added. Shown only when the loan isn't already a portfolio.
      (l.isPortfolio ? '' :
        '<button type="button" onclick="convertToPortfolio()" title="Convert this single-property loan into a portfolio so you can add multiple property details" style="margin-left:auto;padding:5px 12px;font-size:12px;font-weight:600;border:1px solid var(--border,#ddd8d0);background:#fff;border-radius:8px;cursor:pointer;color:var(--dark);white-space:nowrap">⊞ Convert to Portfolio</button>') +
    '</div>' +
    '<div class="section-body">' +
      // Deploy 236.657 — for a PORTFOLIO the property tabs ARE the whole section:
      // the loan-level physical / valuation / carrying-cost form is hidden and each
      // property carries its own values (with a Portfolio Total tab summing them).
      // Non-portfolio loans render the standard single-property form below.
      (l.isPortfolio ? '' : (
      // Physical characteristics — beds/baths/sq ft/type/rental moved here from
      // the retired Property & Application box (af-* ids preserved).
      '<div class="app-grid">' +
        '<div class="field"><label>Bedrooms</label><input type="number" id="af-bedrooms" value="'+escAttr(l.bedrooms||'')+'" placeholder="3" min="0" /></div>' +
        '<div class="field"><label>Bathrooms</label><input type="number" id="af-bathrooms" value="'+escAttr(l.bathrooms||'')+'" placeholder="2" min="0" step="0.5" /></div>' +
        '<div class="field"><label>Sq Footage</label><input type="number" id="af-sqft" value="'+escAttr(l.sqft||'')+'" placeholder="1800" min="0" /></div>' +
        '<div class="field"><label>Units</label><input type="number" id="pc-numUnits" value="' + escAttr(String(l.numUnits || '')) + '" min="0" /></div>' +
        // Deploy 236.691 — Property Type is priced in the sizer, so it's LOCKED
        // here (read-only) and mirrors Loan Financials + the sizer. Disabled so
        // the value still round-trips through savePropertyCollateral unchanged.
        '<div class="field"><label>Property Type <span style="text-transform:none;font-weight:400;color:var(--muted)">(from sizer)</span></label>' +
          '<select id="af-propType" disabled title="Property Type is set in the sizer / Loan Financials. Re-price in the sizer to change it." style="background:var(--bg,#f0ece5);color:var(--muted);cursor:not-allowed">' +
            '<option value="">Select…</option>' +
            '<option value="sfr"'+(l.propType==='sfr'?' selected':'')+'>SFR (1 Unit)</option>' +
            '<option value="2-4"'+(l.propType==='2-4'?' selected':'')+'>2–4 Unit</option>' +
            '<option value="condo"'+(l.propType==='condo'?' selected':'')+'>Condo</option>' +
            '<option value="nw_condo"'+(l.propType==='nw_condo'?' selected':'')+'>Non-Warrantable Condo</option>' +
            '<option value="multi"'+(l.propType==='multi'?' selected':'')+'>Multifamily</option>' +
            '<option value="portfolio"'+(l.propType==='portfolio'?' selected':'')+'>Portfolio</option>' +
          '</select>' +
        '</div>' +
        '<div class="field"><label>Rental Type</label>' +
          '<select id="af-rentalType">' +
            '<option value="">Select…</option>' +
            '<option value="ltr"'+(l.rentalType==='ltr'?' selected':'')+'>Long-Term Rental</option>' +
            '<option value="str"'+(l.rentalType==='str'?' selected':'')+'>Short-Term / Airbnb</option>' +
            '<option value="mtr"'+(l.rentalType==='mtr'?' selected':'')+'>Mid-Term Rental</option>' +
          '</select>' +
        '</div>' +
        '<div class="field"><label>Year Built</label><input type="number" id="pc-yearBuilt" value="' + escAttr(String(l.yearBuilt || '')) + '" min="0" placeholder="e.g. 1998" /></div>' +
        '<div class="field"><label>Stories / Floors</label><input type="number" id="pc-stories" value="' + escAttr(String(l.stories || '')) + '" min="0" step="0.5" /></div>' +
        '<div class="field"><label>Lot Size (sq ft)</label><input type="text" id="pc-lotSize" value="' + escAttr(String(l.lotSize || '')) + '" inputmode="decimal" /></div>' +
        '<div class="field"><label>County</label><input type="text" id="pc-propertyCounty" value="' + escAttr(String(l.propertyCounty || '')) + '" /></div>' +
        '<div class="field"><label>Flood Zone</label><input type="text" id="pc-floodZone" value="' + escAttr(String(l.floodZone || '')) + '" placeholder="e.g. X, AE, or No" /></div>' +
        '<div class="field"><label>Purchase Date</label><input type="date" id="pc-purchaseDate" value="' + escAttr(String(l.purchaseDate || '')) + '" /></div>' +
      '</div>' +
      '<h3 style="margin:18px 0 6px;font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em">Valuation</h3>' +
      // Deploy 236.759 — DSCR loans (1-4 AND 5+) get appraisals, not BPOs;
      // the value field is labeled "Appraised Value" there. RTL/GUC keep the
      // AIV/ARV BPO labels (BPOs are the bridge-side valuation product).
      '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Purchase Price' + (isDscr ? '' : ', Rehab Budget') + ' &amp; ARV (borrower) are in <strong>Loan Financials</strong>. ' + (isDscr ? 'The Appraised Value drives the loan terms.' : 'AIV / ARV BPO values drive the loan terms.') + '</div>' +
      '<div class="app-grid">' +
        '<div class="field"><label>As-Is Value (borrower)</label><input type="text" id="pc-propValue" value="' + escAttr(_ldUsdInput(l.propValue || '')) + '" inputmode="decimal" onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)" placeholder="$" /></div>' +
        // Deploy 236.767 (Mike) — once a BPO has been read, AIV/ARV BPO are the
        // BPO's own numbers and are LOCKED here; clicking explains why. Upload a
        // corrected BPO to change them. (DSCR keeps the editable Appraised Value.)
        '<div class="field"><label>' + (isDscr ? 'Appraised Value' : 'AIV BPO') +
          (_aivBpoLocked ? ' <span style="text-transform:none;font-weight:400;color:var(--muted)">(from BPO)</span>' : '') +
        '</label><input type="text" id="pc-aivBpo" value="' + escAttr(_ldUsdInput(l.aivBpo || '')) + '" inputmode="decimal"' +
          (_aivBpoLocked ? _BPO_LOCK_ATTRS('AIV BPO') : ' onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)"') +
        ' placeholder="$" /></div>' +
        (!isDscr ? '<div class="field"><label>ARV BPO' +
          (_arvBpoLocked ? ' <span style="text-transform:none;font-weight:400;color:var(--muted)">(from BPO)</span>' : '') +
        '</label><input type="text" id="pc-arvBpo" value="' + escAttr(_ldUsdInput(l.arvBpo || '')) + '" inputmode="decimal"' +
          (_arvBpoLocked ? _BPO_LOCK_ATTRS('ARV BPO') : ' onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)"') +
        ' placeholder="$" /></div>' : '') +
        '<div class="field"><label>Existing Debt</label><input type="text" id="pc-currentLoanAmt" value="' + escAttr(_ldUsdInput(l.currentLoanAmt || l.existingLoanAmt || '')) + '" inputmode="decimal" onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)" placeholder="$" /></div>' +
      '</div>' +
      '<h3 style="margin:18px 0 6px;font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em">Carrying Costs <span id="pc-carryModeLabel" style="text-transform:none;font-weight:500;letter-spacing:0">(monthly)</span></h3>' +
      '<div style="display:inline-flex;border:1px solid var(--border,#ddd8d0);border-radius:8px;overflow:hidden;margin-bottom:12px">' +
        '<button type="button" id="pc-carryMonthlyBtn" class="pc-seg active" onclick="pcCarryToggle(\'monthly\')">Monthly</button>' +
        '<button type="button" id="pc-carryAnnualBtn" class="pc-seg" onclick="pcCarryToggle(\'annual\')">Annual</button>' +
      '</div>' +
      '<div class="app-grid">' +
        '<div class="field"><label>Property Taxes</label><input type="text" id="pc-taxes" data-monthly="' + escAttr(_mTaxes) + '" value="' + escAttr(_ldUsdInput(_mTaxes)) + '" inputmode="decimal" oninput="pcCarryInput(this)" onfocus="_ldMoneyFocus(this)" onblur="pcCarryInput(this);_ldMoneyBlur(this)" placeholder="$" /></div>' +
        '<div class="field"><label>Insurance</label><input type="text" id="pc-insurance" data-monthly="' + escAttr(_mIns) + '" value="' + escAttr(_ldUsdInput(_mIns)) + '" inputmode="decimal" oninput="pcCarryInput(this)" onfocus="_ldMoneyFocus(this)" onblur="pcCarryInput(this);_ldMoneyBlur(this)" placeholder="$" /></div>' +
        '<div class="field"><label>HOA</label><input type="text" id="pc-hoa" data-monthly="' + escAttr(_mHoa) + '" value="' + escAttr(_ldUsdInput(_mHoa)) + '" inputmode="decimal" oninput="pcCarryInput(this)" onfocus="_ldMoneyFocus(this)" onblur="pcCarryInput(this);_ldMoneyBlur(this)" placeholder="$" /></div>' +
      '</div>'
      )) +
      // Deploy 236.655 / 236.657 — Portfolio properties: Portfolio Total (first,
      // default) + numbered tabs 1..N, with Add/Remove controls. The whole section
      // for a portfolio loan.
      (l.isPortfolio ? _portfolioTabsHtml(l) : '') +
      '<div style="margin-top:16px;display:flex;align-items:center;gap:12px">' +
        '<button class="save-app-btn" onclick="savePropertyCollateral()">Save Property / Collateral</button>' +
        '<span id="propCollStatus" style="font-size:12px;color:var(--success);display:none">Saved ✓</span>' +
      '</div>' +
    '</div>' +
  '</div>';

  // ── Deploy 236.750 — MF Operating Statement (Multifamily 5+ loans) ──
  // The NCF inputs behind the MF DSCR sizer's pricing: unit counts, income,
  // the 5%-standard vacancy (admin-editable), and annual operating expenses.
  // Rides into the Property tab via relocateSectionsToTabs. Saves through
  // loan-fields-save; the MF sizer reloads these on open.
  // Deploy 236.762 — marker-only gate (see _isMfLoan) + skip portfolio
  // loans so the MF box can't co-render valuation fields alongside the
  // portfolio Property/Collateral model.
  if (l.mfProgram && !l.isPortfolio) {
    var _mfFld = function (id, label, val, ph) {
      return '<div class="field"><label>' + label + '</label><input type="number" id="mfx-' + id + '" value="' + escAttr(val == null ? '' : val) + '" placeholder="' + (ph || '0') + '" min="0" /></div>';
    };
    var _mfAdminUser = !!(window.SLA && SLA.isAdmin && SLA.isAdmin(_user));
    html += '<div class="section" id="mfOpexSection">' +
      '<div class="section-head"><h2>MF Operating Statement</h2><span class="section-tag tag-editable">Editable</span></div>' +
      '<div class="section-body">' +
      '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Feeds the Multifamily sizer\'s NCF-based DSCR. CapEx reserves are fixed at $300/unit/year. Vacancy is standardized at 5%' + (_mfAdminUser ? ' (admin override below)' : ' — only an admin can change it') + '.</div>' +
      '<div class="app-grid">' +
        _mfFld('numUnits', 'Number of Units (5+)', l.numUnits, 'e.g. 12') +
        _mfFld('unitsOccupied', 'Units Occupied', l.unitsOccupied, 'e.g. 11') +
        // Deploy 236.762 — rent is editable HERE now: this box is the MF
        // loan's only Property-tab surface (the fin-grid cell is display-
        // only) and the sizer was the only other place to set it.
        _mfFld('rent', 'Total Monthly Rent (all units)', l.rent) +
        _mfFld('otherIncomeMo', 'Other Income (mo)', l.otherIncomeMo) +
        '<div class="field"><label>Vacancy / Credit Loss (%)</label><input type="number" id="mfx-vacancyPct" value="' + escAttr(l.vacancyPct || '5') + '" min="0" max="100" step="0.5"' + (_mfAdminUser ? '' : ' disabled title="5% standard — admin only"') + ' /></div>' +
        '<div class="field span2" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);align-self:end">Operating Expenses (Annual)</div>' +
        _mfFld('opexTaxes', 'Real Estate Taxes', l.opexTaxes) +
        _mfFld('opexInsurance', 'Property Insurance', l.opexInsurance) +
        _mfFld('opexFlood', 'Flood Insurance', l.opexFlood) +
        _mfFld('opexUtilities', 'Utilities', l.opexUtilities) +
        _mfFld('opexRepairs', 'Repairs & Maintenance', l.opexRepairs) +
        _mfFld('opexMgmt', 'Property Management Fee', l.opexMgmt) +
        _mfFld('opexHOA', 'HOA / Special Assessment', l.opexHOA) +
        _mfFld('opexLandscaping', 'Landscaping', l.opexLandscaping) +
      '</div>' +
      // Deploy 236.759 — Valuation lives HERE for MF loans: the Property/
      // Collateral box no longer renders for them (see _isMfLoan above), so
      // its valuation fields move to the bottom of the Operating Statement.
      // Same pc-* ids; saveMfOpex() picks them up alongside the opex set.
      // DSCR = appraisal product, hence "Appraised Value" (not BPO).
      '<h3 style="margin:18px 0 6px;font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em">Valuation</h3>' +
      '<div class="app-grid">' +
        '<div class="field"><label>As-Is Value (borrower)</label><input type="text" id="pc-propValue" value="' + escAttr(_ldUsdInput(l.propValue || '')) + '" inputmode="decimal" onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)" placeholder="$" /></div>' +
        '<div class="field"><label>Appraised Value</label><input type="text" id="pc-aivBpo" value="' + escAttr(_ldUsdInput(l.aivBpo || '')) + '" inputmode="decimal" onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)" placeholder="$" /></div>' +
        '<div class="field"><label>Existing Debt</label><input type="text" id="pc-currentLoanAmt" value="' + escAttr(_ldUsdInput(l.currentLoanAmt || l.existingLoanAmt || '')) + '" inputmode="decimal" onfocus="_ldMoneyFocus(this)" onblur="_ldMoneyBlur(this)" placeholder="$" /></div>' +
      '</div>' +
      '<div style="margin-top:16px;display:flex;align-items:center;gap:12px">' +
        '<button class="save-app-btn" onclick="saveMfOpex()">Save MF Operating Statement</button>' +
        '<span id="mfOpexStatus" style="font-size:12px;color:var(--success);display:none">Saved ✓</span>' +
      '</div>' +
    '</div></div>';
  }

  // Deploy 236.566 — Closing Coordination panel (CD/wire/funding milestones).
  // Renders only for Approved/Closed loans (or any loan whose closing has
  // already been started). Sits right below Funding Plan — same closing
  // workflow neighborhood. See renderClosingPanel() for the gating logic.
  html += renderClosingPanel(l);

  // Deploy 226 — Notes / audit log section. Replaces the old free-form
  // notes textarea with a scrollable timestamped log. Renders below the
  // Application Form section. Manual notes append via /api/loan-note-add;
  // status changes / reprices / decisions auto-write entries from their
  // respective backend endpoints.
  // Deploy 236.101 — ID on the outer div so post-render JS can move
  // this section into the right-side sticky sidebar.
  html +=
    '<div class="section" id="ldNotesSection">' +
      '<div class="section-head">' +
        '<h2>Notes &amp; Activity</h2>' +
        // Deploy 236.771 (Mike) — this pill used to just LABEL the notes feed
        // "Audit Log", which it isn't. It's now a real button opening the
        // field-level audit log (every change + who made it). Notes & Activity
        // itself is unchanged.
        '<button type="button" class="section-tag tag-editable" onclick="openAuditLogModal()" ' +
          'title="Every field change made to this loan, and who made it" ' +
          'style="cursor:pointer;border:none;font:inherit">Audit Log</button>' +
      '</div>' +
      '<div class="section-body">' +
        '<div class="notes-input-wrap">' +
          '<textarea id="noteInput" placeholder="Add a note about this loan — borrower contact, status checkpoint, conversation summary…" onkeydown="handleNoteKeydown(event)"></textarea>' +
          '<div class="notes-input-row">' +
            '<button class="btn-add" id="noteAddBtn" onclick="addNoteFromUI()">Add Note</button>' +
          '</div>' +
        '</div>' +
        '<div class="notes-status" id="noteStatus"></div>' +
        '<div class="notes-jumpbar">' +
          // Deploy 236.99 — Phase C filter chips. Reuses .btn-jump
          // styling so the row stays visually unified.
          '<span style="font-size:11px;color:var(--muted);align-self:center;margin-right:4px">Show:</span>' +
          '<button class="btn-jump active" id="noteFilterBtn_all"    onclick="setNoteFilter(\'all\')"    title="All entries">All</button>' +
          '<button class="btn-jump"        id="noteFilterBtn_status" onclick="setNoteFilter(\'status\')" title="Status changes, decisions, edits — anything the platform stamped">Status</button>' +
          '<button class="btn-jump"        id="noteFilterBtn_user"   onclick="setNoteFilter(\'user\')"   title="Free-form notes left by users">Notes</button>' +
          '<span style="flex:1"></span>' +
          '<button class="btn-jump active" id="noteJumpTopBtn" onclick="jumpNotesTo(\'top\')" title="Newest entries">↑ Top</button>' +
          '<button class="btn-jump" id="noteJumpBottomBtn" onclick="jumpNotesTo(\'bottom\')" title="Oldest entries">↓ Bottom</button>' +
        '</div>' +
        '<div class="notes-list" id="notesList">' +
          '<div class="notes-list-inner" id="notesListInner"></div>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Submit Loan section removed (Deploy 162): submission is handled
  // exclusively through Pipeline now to avoid two divergent submission
  // flows. The submitLoan() helper is still defined below in case
  // anything else calls it externally; harmless if unused.

  // Deploy 236.130 — "Linked Guarantor Clients" / "Auto-Linked at
  // Signing" section removed per Mike. The Guarantor Info tabs
  // already surface every linked guarantor (with their sub-form
  // links + signed Credit Auth downloads), so the separate panel
  // was redundant. The 236.84 block above this comment is gone.

  // Deploy 236.112 — Borrower Info section. Always renders (every
  // loan has a primary borrower = _client). When the loan has
  // linked guarantor clients (loan.guarantorClientIds, set when a
  // multi-borrower long-app is signed), tabs at the top of the
  // section let the LO switch between borrowers. Primary borrower
  // tab renders immediately from _client; guarantor tabs are
  // populated async by refreshBorrowerInfoPanes() (mirrors the
  // Linked Guarantor Clients fetch pattern).
  var _bwGuarantorIds = Array.isArray(l.guarantorClientIds) ? l.guarantorClientIds : [];
  var _bwHasMultiple  = _bwGuarantorIds.length > 0;
  var _bwPrimaryName  = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email || 'Guarantor 1';

  // Deploy 236.126 — Vesting LLC Info section (above Guarantor Info).
  // Deploy 236.130 — auto-fill source widened to the long loan
  // application's companies list (data.companies → client.companies,
  // synced by borrower-info-sync). The long-app companies block is
  // the borrower's own statement of which LLCs hold title, so it
  // beats the older single-entityName field. Fallback chain:
  //   1) loan.vestingLLCs (LO-edited override — always wins)
  //   2) client.companies (long-app source of truth)
  //   3) client.entityName (legacy single-LLC field)
  //   4) empty row
  function _initialVestingLLCs() {
    if (Array.isArray(l.vestingLLCs) && l.vestingLLCs.length) return l.vestingLLCs;
    if (Array.isArray(c.companies) && c.companies.length) {
      var fromCos = c.companies
        .filter(function(co) { return co && co.name; })
        .map(function(co) { return { name: co.name, ein: co.ein || '' }; });
      if (fromCos.length) return fromCos;
    }
    if (c.entityName) return [{ name: c.entityName }];
    return [{ name: '' }];
  }
  var _vestingLLCsInitial = _initialVestingLLCs();
  html +=
    '<div class="section" id="vestingLLCSection">' +
      '<div class="section-head"><h2>Vesting LLC Info</h2><span class="section-tag tag-editable">Editable</span></div>' +
      '<div class="section-body">' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">The LLC(s) on title for this loan. Auto-filled from the primary guarantor\'s entity. Edit or add additional LLCs if title is held by multiple entities (sub-entity / pass-through structures).</div>' +
        '<div id="vestingLLCList">' +
          _vestingLLCsInitial.map(function(v, i) {
            return _renderVestingLLCRow(v, i, _vestingLLCsInitial.length);
          }).join('') +
        '</div>' +
        '<button type="button" class="vesting-llc-add" onclick="addVestingLLCRow()">+ Add Another LLC</button>' +
        '<div class="vesting-llc-save-row">' +
          '<button type="button" class="vesting-llc-save-btn" id="vestingLLCSaveBtn" onclick="saveVestingLLCs()">Save Vesting LLCs</button>' +
          '<span class="vesting-llc-status" id="vestingLLCStatus"></span>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Deploy 236.126 — ownership map: { clientId: pct } for the primary
  // and every linked guarantor. Used by the per-pane % ownership input
  // and the "Check Guarantor Ownership %" banner.
  var _ownerships = (l.guarantorOwnership && typeof l.guarantorOwnership === 'object') ? l.guarantorOwnership : {};
  var _primaryOwnership = _ownerships[c.id] != null ? _ownerships[c.id] : '';

  // Deploy 236.327 — Borrower LLC fallback matches the Vesting LLC
  // section's chain so a broker deal doesn't show the broker company
  // here (c.entityName is the broker's when the primary client IS
  // the broker). Mike hit this: guarantor pane showed "Nexa Lending"
  // (broker) instead of "Summit Rental Group-AI, LLC" (vesting).
  //   1) loan.vestingLLCs[0].name — LO-set on this page
  //   2) client.companies[0].name — long-app-captured
  //   3) client.entityName        — legacy single-LLC field (broker
  //                                  contamination lives here)
  function _borrowerLLCDisplay(clientRec) {
    if (Array.isArray(l.vestingLLCs) && l.vestingLLCs.length && l.vestingLLCs[0].name) {
      return l.vestingLLCs[0].name;
    }
    if (Array.isArray(clientRec.companies) && clientRec.companies.length) {
      var co0 = clientRec.companies.find(function(co) { return co && co.name; });
      if (co0) return co0.name;
    }
    return clientRec.entityName || '';
  }
  var _bwPrimaryHtml  =
    '<div class="app-grid">' +
      '<div class="field"><label>Guarantor Name</label>' +
        '<input type="text"  id="bw-0-name"   value="' + escAttr(_bwPrimaryName) + '" readonly /></div>' +
      '<div class="field"><label>Borrower LLC</label>' +
        '<input type="text"  id="bw-0-entity" value="' + escAttr(_borrowerLLCDisplay(c)) + '" readonly placeholder="No entity on file" /></div>' +
      '<div class="field"><label>Email</label>' +
        '<input type="email" id="bw-0-email"  value="' + escAttr(c.email || '') + '" readonly /></div>' +
      '<div class="field"><label>Phone</label>' +
        '<input type="tel"   id="bw-0-phone"  value="' + escAttr(c.phone || '') + '" readonly /></div>' +
    '</div>' +
    _renderOwnershipField(c.id, _primaryOwnership, 0) +
    // Deploy 236.143 — Edit Guarantor button at bottom-right of
    // the pane. Per Mike: name + contact info are read-only here;
    // the LO edits on the Client Details page so changes propagate
    // to every loan that client is tied to (primary or guarantor
    // backref). Opens in a new tab so the LO doesn't lose the
    // loan-context in their current tab.
    // Deploy 236.147 — primary pane: skip the Download Application
    // button; primary's data is in the main signed loan app.
    _renderEditGuarantorButton(c.id, true);

  var _bwTabsHtml = '';
  if (_bwHasMultiple) {
    _bwTabsHtml = '<div class="bw-tabs" id="bwTabs">' +
      '<button type="button" class="bw-tab active" onclick="switchBorrowerTab(0)" data-bw-idx="0">' +
        '<span class="bw-tab-label">' + escH(_bwPrimaryName) + '</span>' +
        '<span class="bw-tab-sub">Guarantor 1 (Primary)</span>' +
      '</button>';
    _bwGuarantorIds.forEach(function(gid, i) {
      _bwTabsHtml +=
        '<button type="button" class="bw-tab" onclick="switchBorrowerTab(' + (i + 1) + ')" data-bw-idx="' + (i + 1) + '" id="bw-tab-' + (i + 1) + '">' +
          '<span class="bw-tab-label">Guarantor ' + (i + 2) + '</span>' +
          '<span class="bw-tab-sub">Loading…</span>' +
        '</button>';
    });
    _bwTabsHtml += '</div>';
  }
  var _bwPanesHtml = '<div class="bw-pane active" id="bw-pane-0">' + _bwPrimaryHtml + '</div>';
  _bwGuarantorIds.forEach(function(gid, i) {
    _bwPanesHtml +=
      '<div class="bw-pane loading" id="bw-pane-' + (i + 1) + '" data-client-id="' + escAttr(gid) + '">Loading guarantor info…</div>';
  });
  // Deploy 236.355 — Guarantor Info section:
  //   - Removed the "Editable" pill: name / contact fields on the
  //     Guarantor 1 tab are read-only (editing happens on Client
  //     Details so changes propagate to every loan tied to the
  //     client — see Deploy 236.143).
  // Deploy 236.367 — Change / Clear Primary Guarantor buttons moved
  // into the primary pane's own footer (see _renderEditGuarantorButton).
  // The previous standalone .change-primary-guarantor-row rendered
  // BELOW the pane but INSIDE the section-body; combined with its
  // border-top + the button's outlined styling it visually read as a
  // separate mini-card sitting below the Guarantor Info section
  // (Mike's report). Consolidating the buttons into the pane footer
  // puts every primary-affecting action in one obvious row.
  html +=
    '<div class="section" id="borrowerInfoSection">' +
      '<div class="section-head">' +
        '<h2>Guarantor Info</h2>' +
        // Deploy 236.130 — manual Add Guarantor entry point.
        '<button type="button" class="add-guarantor-btn" onclick="openAddGuarantorModal()">+ Add Guarantor</button>' +
      '</div>' +
      '<div class="section-body">' +
        _bwTabsHtml +
        _bwPanesHtml +
      '</div>' +
    '</div>';

  // Deploy 236.113 (Phase E) — Additional Contacts. The implicit
  // contacts (LO from ownerKey, Borrower from _client, Broker from
  // loan.broker* fields, Guarantors from the Borrower Info tabs)
  // each live in their own sections. This section is for everyone
  // else — Title Co, Insurance Agent, Inspector, etc. Async-loaded
  // by refreshLoanContacts() after the page paints.
  html +=
    '<div class="section" id="loanContactsSection">' +
      '<div class="section-head"><h2>Additional Contacts</h2><span class="section-tag tag-editable">Editable</span></div>' +
      '<div class="section-body">' +
        '<div class="contacts-toolbar">' +
          '<button class="btn-add-contact" onclick="openAddContactModal()">+ Add Vendor</button>' +
        '</div>' +
        '<div class="contacts-list" id="loanContactsList"><div class="contacts-empty">Loading contacts…</div></div>' +
      '</div>' +
    '</div>';

  // Broker Info section — Deploy 236.17 — now also renders for loans
  // that have a broker entity link OR any inline broker contact info,
  // not just when a non-zero broker fee was set. Apply.html broker-mode
  // submissions (Phase 3c) attach broker contact info but no fee until
  // the LO sets one in the sizer, so the prior `brokerFee > 0` gate
  // hid the broker from view immediately after the application landed.
  // Name/company/email/phone are editable inline (save via saveAppFields).
  // Broker Fee remains read-only here — set on the sizer.
  var hasBrokerInfo = parseFloat(l.brokerFee || 0) > 0
                   || (l.brokerId && String(l.brokerId).trim())
                   || (l.brokerName && String(l.brokerName).trim())
                   || (l.brokerEmail && String(l.brokerEmail).trim());
  if (hasBrokerInfo) {
    var brokerFeePts = parseFloat(l.brokerFee || 0) > 0 ? parseFloat(l.brokerFee).toFixed(2) : '';
    // Source badge — flag broker-app submissions visually.
    var sourceBadge = (l.fromApplication && (l.brokerEmail || l.brokerName))
      ? '<span class="section-tag" style="background:rgba(200,129,58,0.10);color:var(--gold-mid, #b5712d);border:1px solid rgba(200,129,58,0.28)">Submitted via Broker</span>'
      : '';
    // Link to broker book entry if we have a brokerId.
    var brokerBookLink = l.brokerId
      ? '<a href="/brokers.html" style="font-size:12px;color:var(--gold-mid, #b5712d);text-decoration:none;margin-left:8px" title="Open Broker Book">View in Broker Book →</a>'
      : '';
    // Deploy 236.327 — "Convert to standard deal" button. Deploy
    // 236.328 — broadened gate: any loan whose Broker Info section
    // is rendering (hasBrokerInfo=true above) gets the button, even
    // if _isBrokerLoan was never explicitly set. Legacy broker loans
    // from before Deploy 236.289's explicit toggle just have broker
    // contact fields with no _isBrokerLoan flag — those should still
    // be convertible. The server endpoint clears both.
    var convertBtn = '<button onclick="convertBrokerLoanToStandard()" style="margin-left:auto;font-size:12px;padding:6px 12px;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;cursor:pointer;font-family:inherit" title="Remove broker flag and clear broker contact fields">Remove Broker</button>';
    html +=
    '<div class="section" id="brokerInfoSection">' +
      '<div class="section-head" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px"><h2 style="margin:0">Broker Info</h2>' + sourceBadge + '<span class="section-tag tag-editable">Editable</span>' + brokerBookLink + convertBtn + '</div>' +
      '<div class="section-body">' +
        '<div class="app-grid">' +
          '<div class="field"><label>Broker Name</label>' +
            '<input type="text" id="af-brokerName" value="'+escAttr(l.brokerName||'')+'" placeholder="Broker name" />' +
          '</div>' +
          '<div class="field"><label>Broker Company</label>' +
            '<input type="text" id="af-brokerCompany" value="'+escAttr(l.brokerCompany||'')+'" placeholder="Company / brokerage" />' +
          '</div>' +
          '<div class="field"><label>Broker Email</label>' +
            '<input type="email" id="af-brokerEmail" value="'+escAttr(l.brokerEmail||'')+'" placeholder="broker@company.com" />' +
          '</div>' +
          '<div class="field"><label>Broker Phone</label>' +
            '<input type="tel" id="af-brokerPhone" value="'+escAttr(l.brokerPhone||'')+'" placeholder="(555) 123-4567" />' +
          '</div>' +
          // Broker Fee: read-only, set on the sizer. Empty when no fee yet.
          '<div class="field" style="grid-column:1/-1"><label>Broker Fee <span style="font-size:11px;color:var(--muted);font-weight:400">· Set on sizer</span></label>' +
            '<input type="text" value="'+(brokerFeePts ? brokerFeePts+' pts' : 'Not set — open sizer to add')+'" readonly style="background:rgba(120,116,136,0.08);cursor:not-allowed" />' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:14px;display:flex;align-items:center;gap:10px">' +
          '<button class="save-app-btn" onclick="saveAppFields()">Save Changes</button>' +
          '<span id="appStatus" style="display:none;color:var(--success);font-size:13px">Saved ✓</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Deploy 236.702 — General Contractor contact (GUC / ground-up construction
  // loans only). Records the GC as a contact on the loan so the processing team
  // + the GC-Review document have the contractor's details in one place.
  if (_isGucLoan(l)) {
    html +=
    '<div class="section" id="gcInfoSection">' +
      '<div class="section-head" style="display:flex;align-items:center;flex-wrap:wrap;gap:8px"><h2 style="margin:0">General Contractor</h2><span class="section-tag tag-editable">Editable</span></div>' +
      '<div class="section-body">' +
        '<div class="app-grid">' +
          '<div class="field"><label>GC Name</label>' +
            '<input type="text" id="af-gcName" value="'+escAttr(l.gcName||'')+'" placeholder="General contractor name" />' +
          '</div>' +
          '<div class="field"><label>GC Company</label>' +
            '<input type="text" id="af-gcCompany" value="'+escAttr(l.gcCompany||'')+'" placeholder="Company / firm" />' +
          '</div>' +
          '<div class="field"><label>GC Email</label>' +
            '<input type="email" id="af-gcEmail" value="'+escAttr(l.gcEmail||'')+'" placeholder="gc@company.com" />' +
          '</div>' +
          '<div class="field"><label>GC Phone</label>' +
            '<input type="tel" id="af-gcPhone" value="'+escAttr(l.gcPhone||'')+'" placeholder="(555) 123-4567" />' +
          '</div>' +
          '<div class="field" style="grid-column:1/-1"><label>GC License #</label>' +
            '<input type="text" id="af-gcLicense" value="'+escAttr(l.gcLicense||'')+'" placeholder="Contractor license number" />' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:14px;display:flex;align-items:center;gap:10px">' +
          '<button class="save-app-btn" onclick="saveGcContact()">Save Changes</button>' +
          '<span id="gcStatus" style="display:none;color:var(--success);font-size:13px">Saved ✓</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // Deploy 236.339 — Servicing Info section. Rendered when the loan
  // has reached a post-close state (closed / sold / funded / in_
  // servicing) OR already has any servicing metadata set (so an LO
  // who filled it in early doesn't lose the input on next render).
  // Values feed the borrower's /my-loans/ Closed card:
  //   - Maturity Date  → "Maturity Date" fact
  //   - Servicer Name  → button label
  //   - Servicer URL   → button href
  var _lstat = String(l.status || '').toLowerCase();
  var _isServicingStage =
       _lstat === 'closed' || _lstat === 'sold' || _lstat === 'funded'
    || _lstat === 'in_servicing' || _lstat === 'servicing' || _lstat === 'liquidated';
  var _hasServicing = !!(l.maturityDate || l.servicerName || l.servicerUrl);
  if (_isServicingStage || _hasServicing) {
    // Deploy 236.619 — Loan Amount + Loan Close Date shown read-only at the top of
    // the Servicing tab (reference facts; the canonical fields live on the Loan tab).
    var _svcAmt = fmtM(l.finalLoanAmount || l.loanAmt);
    var _svcClose = (function(){ var d = String(l.fundingDate || ''); var m = d.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (parseInt(m[2],10) + '/' + parseInt(m[3],10) + '/' + m[1]) : (d || '—'); })();
    html +=
    '<div class="section" id="servicingSection">' +
      '<div class="section-head"><h2>Servicing Info</h2><span class="section-tag tag-editable">Editable</span></div>' +
      '<div class="section-body">' +
        '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Shown to the borrower on their /my-loans page after close. The Servicer button links out to whatever URL you paste here (e.g. their servicer\'s login page).</div>' +
        '<div class="app-grid">' +
          '<div class="field"><label>Loan Amount</label><input type="text" value="' + escAttr(_svcAmt) + '" disabled /></div>' +
          '<div class="field"><label>Loan Close Date</label><input type="text" value="' + escAttr(_svcClose) + '" disabled /></div>' +
          '<div class="field"><label>Maturity Date</label>' +
            '<input type="date" id="sv-maturityDate" value="' + escAttr(l.maturityDate || '') + '" />' +
          '</div>' +
          // Deploy 236.628 — Servicer Name suggests Note Servicers from the Vendors
          // book (role note_servicer). datalist keeps free entry while offering the
          // shared list; refreshNoteServicers() fills #sv-servicerList after load.
          '<div class="field"><label>Servicer Name</label>' +
            '<input type="text" id="sv-servicerName" list="sv-servicerList" value="' + escAttr(l.servicerName || '') + '" placeholder="e.g. Servicing Pros" maxlength="80" />' +
            '<datalist id="sv-servicerList"></datalist>' +
          '</div>' +
          // Deploy 236.618 — full servicing field set (shared with the Closed Loans page).
          '<div class="field"><label>Servicer Loan #</label><input type="text" id="sv-servicerLoanNumber" value="' + escAttr(l.servicerLoanNumber || '') + '" maxlength="60" /></div>' +
          '<div class="field"><label>Payment Amount</label><input type="text" id="sv-paymentAmount" value="' + escAttr(l.paymentAmount || '') + '" placeholder="$" inputmode="decimal" /></div>' +
          '<div class="field"><label>Total UPB</label><input type="text" id="sv-upb" value="' + escAttr(l.upb || '') + '" placeholder="$" inputmode="decimal" /></div>' +
          '<div class="field"><label>Payoff Amount</label><input type="text" id="sv-payoffAmount" value="' + escAttr(l.payoffAmount || '') + '" placeholder="$" inputmode="decimal" /></div>' +
          '<div class="field"><label>Payoff Date</label><input type="date" id="sv-payoffDate" value="' + escAttr(l.payoffDate || '') + '" /></div>' +
          '<div class="field"><label>Investor</label><input type="text" id="sv-investorName" value="' + escAttr(l.investorName || '') + '" maxlength="120" /></div>' +
          '<div class="field"><label>Sold Rate / TPO</label><input type="text" id="sv-soldRate" value="' + escAttr(l.soldRate || '') + '" /></div>' +
          '<div class="field"><label>Sold Date</label><input type="date" id="sv-soldDate" value="' + escAttr(l.soldDate || '') + '" /></div>' +
          '<div class="field" style="grid-column:1/-1"><label>Servicer Portal URL</label>' +
            '<input type="url" id="sv-servicerUrl" value="' + escAttr(l.servicerUrl || '') + '" placeholder="https://servicerportal.example.com/" />' +
          '</div>' +
          // Deploy 236.622 — Collateral tracking (3 docs × date + location/custodian).
          '<div class="field" style="grid-column:1/-1;border-top:1px solid var(--border,#eee);margin-top:6px;padding-top:10px"><label style="font-weight:700">Collateral</label></div>' +
          '<div class="field"><label>Signed Originals</label><input type="date" id="sv-signedOriginalsDate" value="' + escAttr(l.signedOriginalsDate || '') + '" /></div>' +
          '<div class="field"><label>Signed Originals — Location</label><input type="text" id="sv-signedOriginalsLocation" value="' + escAttr(l.signedOriginalsLocation || '') + '" placeholder="e.g. Westover" maxlength="60" /></div>' +
          '<div class="field" style="grid-column:1/-1"><label>Signed Originals — Tracking #</label><input type="text" id="sv-signedOriginalsTracking" value="' + escAttr(l.signedOriginalsTracking || '') + '" placeholder="carrier tracking number" maxlength="60" /></div>' +
          '<div class="field"><label>Recorded DOT</label><input type="date" id="sv-recordedDotDate" value="' + escAttr(l.recordedDotDate || '') + '" /></div>' +
          '<div class="field"><label>Recorded DOT — Location</label><input type="text" id="sv-recordedDotLocation" value="' + escAttr(l.recordedDotLocation || '') + '" placeholder="e.g. Westover" maxlength="60" /></div>' +
          '<div class="field" style="grid-column:1/-1"><label>Recorded DOT — Tracking #</label><input type="text" id="sv-recordedDotTracking" value="' + escAttr(l.recordedDotTracking || '') + '" placeholder="carrier tracking number" maxlength="60" /></div>' +
          '<div class="field"><label>Final Title Policy</label><input type="date" id="sv-titlePolicyDate" value="' + escAttr(l.titlePolicyDate || '') + '" /></div>' +
          '<div class="field"><label>Final Title Policy — Location</label><input type="text" id="sv-titlePolicyLocation" value="' + escAttr(l.titlePolicyLocation || '') + '" placeholder="e.g. Westover" maxlength="60" /></div>' +
          '<div class="field" style="grid-column:1/-1"><label>Final Title Policy — Tracking #</label><input type="text" id="sv-titlePolicyTracking" value="' + escAttr(l.titlePolicyTracking || '') + '" placeholder="carrier tracking number" maxlength="60" /></div>' +
        '</div>' +
        '<div style="margin-top:14px;display:flex;align-items:center;gap:10px">' +
          '<button class="save-app-btn" onclick="saveServicingFields()">Save Changes</button>' +
          '<span id="servicingStatus" style="display:none;color:var(--success);font-size:13px">Saved ✓</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  html += '</div>'; // close right col
  html += '</div>'; // close two-col

  // Deploy 236.648 — read-only Fees/Cash-to-Close + Cash Reserve cards, sourced
  // from the rate sheet (recomputed from the loan record). Relocated onto the
  // Loan tab in relocateSectionsToTabs().
  html += _feesReserveHtml(l, isDscr, {
    loanAmt: loanAmt, ratePct: rate, pointsNum: pointsNum, rehab: rehabBudget,
    downPayment: (downPayment && parseFloat(downPayment)) ? downPayment
      : (((parseFloat(purchasePrice) || 0) > (parseFloat(loanAmt) || 0)) ? (parseFloat(purchasePrice) - parseFloat(loanAmt)) : 0),
    currentLoanAmt: currentLoanAmt, brokerFeePts: l.brokerFee,
    isRefi: isDscr ? (loanPurpose === 'refi_co' || loanPurpose === 'refi_rt') : (loanPurpose === 'cashout' || loanPurpose === 'rateterm'),
  });

  // Deploy 236.105 (Phase C — Tasks) — per-loan task list. Renders
  // a shell here; the list itself is populated by loadTasksList()
  // after the page paints (mirrors the notesLog pattern).
  html +=
    '<div class="section" id="tasksSection">' +
      '<div class="section-head"><h2>Tasks</h2><span class="section-tag tag-editable">Editable</span></div>' +
      '<div class="section-body">' +
        '<div class="tasks-add-row">' +
          '<input type="text"  id="taskTitleInput"    placeholder="New task — e.g. Order title insurance" onkeydown="handleTaskKeydown(event)" />' +
          '<input type="date"  id="taskDueInput"      title="Due date" />' +
          // Deploy 236.107 — assignee is a searchable user picker
          // (combobox) instead of a raw email input. Hidden inputs
          // hold the canonical email + display name that
          // addTaskFromUI submits; the visible input is what the
          // LO types to filter.
          '<div class="user-picker" id="taskAssigneePicker">' +
            '<input type="text" class="user-picker-input" id="taskAssigneeSearch" placeholder="Assignee (optional)" autocomplete="off"' +
              ' onfocus="openUserPicker(this)" onclick="openUserPicker(this)" oninput="filterUserPicker(this)" onkeydown="userPickerKeydown(event,this)" />' +
            '<input type="hidden" id="taskAssigneeInput" data-name="" />' +
          '</div>' +
          '<button class="btn-add-task" id="taskAddBtn" onclick="addTaskFromUI()">Add Task</button>' +
        '</div>' +
        '<div class="tasks-list" id="tasksList"><div class="tasks-empty">Loading tasks…</div></div>' +
      '</div>' +
    '</div>';

  // Deploy 236.101 — wrap the rendered body in a 2-column layout
  // with the Notes sidebar pinned right.
  // Deploy 236.118 — tab nav (Loan / Contacts / Documents / Tasks)
  // inside ld-main, BEFORE the section content. Sections render in
  // their natural order from the existing render path; post-render
  // JS (relocateSectionsToTabs) physically moves each into the
  // appropriate pane. Notes & Envelopes stay in the right sidebar
  // and are visible across all tabs.
  // Deploy 236.493 — Underwriting + Lightning Docs tabs. RTL loans only
  // for now (this field set is the RTL sheet; DSCR comes later). The
  // panes are filled by loan-uw-tab.js's SLA_UW_TAB.mount() post-render.
  // Deploy 236.511 — Underwriting + Lightning tabs now cover RTL AND DSCR.
  var _uwTt = String((l && l.toolType) || '').toLowerCase();
  // Deploy 236.603 — a blank toolType is a DSCR loan by the portal's own default:
  // isDscr (~677) is (toolType||'') !== 'rtl', and the header badge (~842) reads
  // (toolType||'dscr'). The old exact rtl|dscr match hid Underwriting + Lightning
  // Docs on DSCR loans whose toolType was never stamped — the badge still said
  // DSCR, Documents/Closing still showed, but these two tabs silently vanished.
  // Treat empty as DSCR so the gate matches the rest of the page.
  var _isRtlLoan = (_uwTt === 'rtl' || _uwTt === 'dscr' || _uwTt === 'guc' || _uwTt === '');
  // Deploy 236.602 — tab order + processing gate (per Mike). Order is
  // Loan · Contacts · Tasks · Documents · Underwriting · Closing · Lightning Docs.
  // Documents / Underwriting / Closing / Lightning Docs are processing-team tabs:
  // they only appear once the loan is In Processing (pushed to the pipeline) — the
  // sales team (pre-processing loans) sees just Loan / Contacts / Tasks. The
  // Funding Plan box now lives inside the Closing tab (relocateSectionsToTabs).
  // Underwriting + Lightning additionally require an RTL/DSCR loan.
  var _inProc = isInProcessing(l);
  var _uwOK   = _inProc && _isRtlLoan;
  var _tabDocuments    = _inProc ? '<button type="button" class="ld-tab" data-ld-tab="documents" onclick="switchLdTab(\'documents\')"><span class="ld-tab-icon">\u{1F4C4}</span>Documents</button>' : '';
  var _tabUnderwriting = _uwOK   ? '<button type="button" class="ld-tab" data-ld-tab="underwriting" onclick="switchLdTab(\'underwriting\')"><span class="ld-tab-icon">\u{1F4CB}</span>Underwriting</button>' : '';
  var _tabClosing      = _inProc ? '<button type="button" class="ld-tab" data-ld-tab="closing" onclick="switchLdTab(\'closing\')"><span class="ld-tab-icon">\u{1F3C1}</span>Closing</button>' : '';
  var _tabLightning    = _uwOK   ? '<button type="button" class="ld-tab" data-ld-tab="lightning" onclick="switchLdTab(\'lightning\')"><span class="ld-tab-icon">\u{26A1}</span>Lightning Docs</button>' : '';
  // Deploy 236.618 — Servicing tab (after Lightning Docs). Same gate as the
  // Servicing Info section built above (_isServicingStage / _hasServicing);
  // relocateSectionsToTabs moves #servicingSection into its pane.
  var _showServicingTab = (_isServicingStage || _hasServicing);
  var _tabServicing    = _showServicingTab ? '<button type="button" class="ld-tab" data-ld-tab="servicing" onclick="switchLdTab(\'servicing\')"><span class="ld-tab-icon">\u{1F4C8}</span>Servicing</button>' : '';
  // Deploy 236.721 — Draws tab (right of Servicing): live Sitewire draw data.
  // Same gate as Servicing plus a construction product (RTL/GUC) — DSCR loans
  // have no draw schedule. Content loads lazily on first open (ldDrawsLoad).
  var _showDrawsTab = _showServicingTab && (_uwTt === 'rtl' || _uwTt === 'guc');
  var _tabDraws     = _showDrawsTab ? '<button type="button" class="ld-tab" data-ld-tab="draws" onclick="switchLdTab(\'draws\')"><span class="ld-tab-icon">\u{1F3D7}\u{FE0F}</span>Draws</button>' : '';
  var tabsHtml =
    '<div class="ld-tabs" role="tablist">' +
      '<button type="button" class="ld-tab active" data-ld-tab="loan"     onclick="switchLdTab(\'loan\')"><span class="ld-tab-icon">\u{1F4B0}</span>Loan</button>' +
      // Deploy 236.641 — Property tab (to the right of Loan): all collateral +
      // the physical fields that used to live in Property & Application.
      '<button type="button" class="ld-tab"        data-ld-tab="property" onclick="switchLdTab(\'property\')"><span class="ld-tab-icon">\u{1F3E0}</span>Property</button>' +
      '<button type="button" class="ld-tab"        data-ld-tab="contacts" onclick="switchLdTab(\'contacts\')"><span class="ld-tab-icon">\u{1F465}</span>Contacts</button>' +
      // Deploy 236.726 — Tasks tab removed (too many tabs); Tasks is now a
      // modal opened from the header button (id ldTasksBtn, badge keeps the
      // ldTabTasksCount id).
      _tabDocuments +
      _tabUnderwriting +
      _tabClosing +
      _tabLightning +
      _tabServicing +
      _tabDraws +
    '</div>' +
    '<div class="ld-pane active" data-ld-pane="loan"     id="ldPaneLoan"></div>' +
    '<div class="ld-pane"        data-ld-pane="property" id="ldPaneProperty"></div>' +
    '<div class="ld-pane"        data-ld-pane="contacts" id="ldPaneContacts"></div>' +
    (_inProc ? '<div class="ld-pane" data-ld-pane="documents"    id="ldPaneDocuments"></div>' : '') +
    (_uwOK   ? '<div class="ld-pane" data-ld-pane="underwriting" id="ldPaneUnderwriting"></div>' : '') +
    (_inProc ? '<div class="ld-pane" data-ld-pane="closing"      id="ldPaneClosing"></div>' : '') +
    (_uwOK   ? '<div class="ld-pane" data-ld-pane="lightning"    id="ldPaneLightning"></div>' : '') +
    (_showServicingTab ? '<div class="ld-pane" data-ld-pane="servicing" id="ldPaneServicing"></div>' : '') +
    (_showDrawsTab ? '<div class="ld-pane" data-ld-pane="draws" id="ldPaneDraws"></div>' : '');
  // Deploy 236.126 — top-of-page warning banner placeholder.
  // computeGuarantorOwnershipBanner() fills this slot after render
  // based on loan.guarantorOwnership values + linked guarantor count.
  var topBannerSlot = '<div id="ldTopBanners"></div>';
  html = pageHeaderHtml +
         topBannerSlot +
         '<div class="ld-layout">' +
           '<div class="ld-main">' +
             tabsHtml +
             '<div class="ld-stage">' + html + '</div>' +
           '</div>' +
           '<aside class="ld-notes-sidebar" id="ldNotesSidebar"></aside>' +
         '</div>';

  document.getElementById('pageContent').innerHTML = html;

  // Move the notes section out of ld-main and into the sidebar.
  // The render() function builds notes inline with all other
  // sections (line ~1568) so existing init / event-wiring stays
  // unchanged; only the visual position moves. Run before
  // renderNotesLog() so the inner list renders in its final
  // location and scroll/sizing math is correct.
  (function relocateNotes() {
    var sect = document.getElementById('ldNotesSection');
    var bar  = document.getElementById('ldNotesSidebar');
    if (sect && bar && sect.parentNode !== bar) bar.appendChild(sect);
    // Deploy 236.765 — DSCR rate-lock counter strip at the TOP of the
    // sidebar, sized to sit in the same band as the tab row, with a
    // divider underneath that visually continues the tabs' underline;
    // the Notes & Activity box starts below it (Mike's layout).
    _renderRateLockCard();
  })();

  // Deploy 236.102 — move the 6 action buttons into the Actions
  // dropdown menu at the top of the page. Buttons are rendered in
  // their natural location by the existing render path (which keeps
  // conditional visibility intact); we just relocate them. Each
  // moved button gets the .ld-action-menu-item class so the CSS
  // overrides the full-width primary styling for the menu.
  (function relocateActions() {
    var menu = document.getElementById('ldActionsMenu');
    if (!menu) return;
    var ids = [
      'ldDownloadRateSheetBtn',
      'ldPofBtn',                 // Deploy 236.578 — Print Proof of Funds Letter
      'ldSendRateSheetBtn',
      'borrowerInfoBtn',          // Send Full Loan Application
      'reviewAppBtn',             // Review Submitted Application
      'downloadSignedAppBtn',     // Download Signed App (PDF)
      'downloadUnsignedAppBtn',   // Generate Application PDF (Unsigned)
      'ldResetRateLockBtn',       // Deploy 236.764 — Reset Rate Lock (DSCR)
      'ldReinstateBtn',           // Deploy 236.770 — Remove Denied/Cancelled Status
      // Deploy 236.641 — loan-level actions from the dismantled Change Loan
      // Status box now live in the Actions menu (Change Type + Merge, then the
      // destructive Cancel / Decline / Delete). Conditional buttons that
      // weren't rendered (non-admin, terminal status) simply aren't found.
      'ldChangeTypeBtn',
      'ldMergeLoanBtn',
      'ldCancelLoanBtn',
      'ldDeclineLoanBtn',
      'ldDeleteLoanBtn',
    ];
    var moved = 0;
    ids.forEach(function(id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.add('ld-action-menu-item');
      // Clear any inline margin-top / display:none-suppressing-CSS
      // that was needed when the button lived inline.
      el.style.marginTop = '';
      // Deploy 236.759 — PRESERVE display:none on gated buttons. This
      // used to blanket-clear display, which un-hid "Download Signed
      // Application" / "Generate Application PDF (Unsigned)" the moment
      // the menu built — and when the loan had no borrower-info record
      // at all, the status call 404'd and nothing ever re-hid them
      // (Mike saw Download Signed Application on a Quoted loan with no
      // signature). Buttons that render visible still get the clear so
      // the menu-item CSS governs their display.
      if (el.style.display !== 'none') el.style.display = '';
      menu.appendChild(el);
      moved++;
    });
    // Also relocate the status hint that lived under the borrower
    // info button (it carries the "Submit the loan first" message).
    var statusHint = document.getElementById('borrowerInfoStatus');
    if (statusHint && statusHint.textContent && statusHint.textContent.trim()) {
      statusHint.style.padding = '6px 16px 10px';
      statusHint.style.margin = '0';
      statusHint.style.textAlign = 'left';
      statusHint.style.fontSize = '11px';
      statusHint.style.color = 'var(--muted)';
      menu.appendChild(statusHint);
    } else if (statusHint) {
      // Empty hint — just hide so it doesn't add a blank line.
      statusHint.style.display = 'none';
    }
    if (moved > 0) {
      var empty = menu.querySelector('.ld-actions-empty');
      if (empty) empty.remove();
    }
  })();

  // Deploy 236.102 — move the E-Signature envelopes panel into the
  // right sidebar BELOW the Notes section, per Mike's spec.
  // Deploy 236.103 — also pulls the Signature Confirmations pane
  // (#signedAppStatus) into the same box so signed-app audit info
  // sits with the other e-signature evidence instead of next to
  // the Download button (which now lives in the Actions menu).
  (function relocateEnvelopes() {
    var panel = document.getElementById('envelopesPanel');
    var bar   = document.getElementById('ldNotesSidebar');
    if (!panel || !bar) return;
    var wrap = document.createElement('div');
    wrap.className = 'section';
    wrap.id = 'ldEnvelopesSection';
    wrap.style.marginTop = '20px';
    wrap.innerHTML =
      '<div class="section-head">' +
        '<h2>E-Signature Envelopes</h2>' +
        '<span class="section-tag tag-readonly">Audit trail</span>' +
      '</div>' +
      '<div class="section-body" id="ldEnvelopesBody"></div>';
    bar.appendChild(wrap);
    var body = document.getElementById('ldEnvelopesBody');
    while (panel.firstChild) body.appendChild(panel.firstChild);
    panel.remove();

    // Relocate the signedAppStatus pane (Signature Confirmations)
    // into the SAME box, just above the envelope cards list so the
    // pane reads as a summary line for the most recent signed app.
    // refreshSignedApplicationStatus() still finds the element by
    // ID after the move; only the visual position changes.
    var sigPane = document.getElementById('signedAppStatus');
    if (sigPane) {
      // Strip the inline border/margin that made sense when it sat
      // next to the (now-relocated) download button — the section
      // wrapper provides its own framing now.
      sigPane.style.marginTop = '';
      sigPane.style.border = '1px solid var(--border, #ddd8d0)';
      sigPane.style.borderRadius = '6px';
      // Insert at the TOP of the body so it sits above #envelopesList.
      body.insertBefore(sigPane, body.firstChild);
    }
  })();

  // Deploy 236.118 — Loan Details TABS. Move existing sections out
  // of the inline two-col / stack and into the appropriate pane.
  // Each section keeps its existing event wiring, IDs, and any
  // already-attached refreshers; only the visual position moves.
  (function relocateSectionsToTabs() {
    var paneLoan      = document.getElementById('ldPaneLoan');
    var paneProperty  = document.getElementById('ldPaneProperty'); // Deploy 236.641
    var paneContacts  = document.getElementById('ldPaneContacts');
    var paneDocuments = document.getElementById('ldPaneDocuments');
    var paneClosing   = document.getElementById('ldPaneClosing');
    var paneServicing = document.getElementById('ldPaneServicing'); // Deploy 236.618
    // Deploy 236.602 — Documents + Closing panes are processing-only, so they
    // may be absent on a pre-processing loan; only Loan/Contacts are required.
    // (236.726 — the Tasks pane no longer exists; Tasks moved to a modal.)
    if (!paneLoan || !paneContacts) return;

    // LOAN tab: the existing .two-col (Financials + Property/App
    // side-by-side) goes here intact. Any "left col" buttons
    // (Cancel/Decline/Delete/etc.) hang off the Financials section
    // and ride along.
    var stage = document.querySelector('.ld-stage');
    var twoCol = stage && stage.querySelector('.two-col');
    if (twoCol) paneLoan.appendChild(twoCol);

    // Deploy 236.641 — Loan Terms now lives in the two-col right column (it
    // replaced the Property & Application box), so it rides into paneLoan with
    // the two-col above. The Property / Collateral section is rendered after
    // the two-col and moves to the new PROPERTY tab. Fallback to paneLoan if
    // (defensively) the Property pane is missing.
    var _propColl = document.getElementById('propertyCollateralSection');
    if (_propColl) (paneProperty || paneLoan).appendChild(_propColl);
    // Deploy 236.750 — MF Operating Statement rides with it (MF loans only).
    var _mfOpex = document.getElementById('mfOpexSection');
    if (_mfOpex) (paneProperty || paneLoan).appendChild(_mfOpex);

    // Deploy 236.650 — keep the boxes narrow (half-width) and balance the two
    // columns: Fees/Cash-to-Close under Loan Terms (right col); Cash Reserve
    // under Loan Financials (left col, RTL only). loanTermsSection's parent is
    // the right column; loanFinancialsSection's parent is the left column.
    var _ltsParent = (function(){ var s = document.getElementById('loanTermsSection'); return s ? s.parentNode : null; })();
    var _finParent = (function(){ var s = document.getElementById('loanFinancialsSection'); return s ? s.parentNode : null; })();
    var _feesEl = document.getElementById('ldFeesSection');
    if (_feesEl) (_ltsParent || paneLoan).appendChild(_feesEl);
    var _resEl = document.getElementById('ldReserveSection');
    if (_resEl) (_finParent || paneLoan).appendChild(_resEl);

    // CONTACTS tab: vesting LLC info (top) / guarantor info /
    // linked guarantors / additional contacts / broker info. Plus a
    // new Team Members block we inject below.
    // Deploy 236.126 — vestingLLCSection added at the top.
    [
      'vestingLLCSection',
      'borrowerInfoSection',
      'linkedGuarantorsSection',
      'loanContactsSection',
      'brokerInfoSection',
      'gcInfoSection', // Deploy 236.702 — General Contractor (GUC loans)
    ].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) paneContacts.appendChild(el);
    });
    // Team Members card (new). Sources: LO from ownerKey (and the
    // _loEmail / profile lookup the page already does); Processor
    // placeholder until admin reassignment ships.
    paneContacts.appendChild(_buildTeamMembersSection());

    // Deploy 236.170 — Access Refactor PR #3. Borrower Portal
    // Access panel: invite a borrower email to view their loan +
    // upload documents via the (upcoming) borrower portal. Powered
    // by /api/borrower-invite (Netlify Identity invite + loan_access
    // grant) and /api/loan-access-list.
    // Deploy 236.172 — gated to admins-only per Mike while we're
    // still tire-kicking the flow. LOs will see it once the portal
    // is production-ready.
    if (window.SLA && SLA.isAdmin && SLA.isAdmin(_user)) {
      paneContacts.appendChild(_buildBorrowerAccessSection());
    }

    // DOCUMENTS tab: placeholder. Real implementation is Phase D
    // (the Loan Doc Review system already exists as its own page;
    // moving/embedding it is the next phase). For now surface a
    // deep link so processors can jump there in one click.
    if (paneDocuments) paneDocuments.appendChild(_buildDocumentsPlaceholder());

    // TASKS — Deploy 236.726: the existing #tasksSection moves wholesale into
    // a modal shell (opened by the header Tasks button) instead of a tab. All
    // of its event wiring / loadTasksList refreshers ride along untouched.
    var tasksSect = document.getElementById('tasksSection');
    if (tasksSect) _buildTasksModal(tasksSect);

    // CLOSING tab (Deploy 236.568; 236.602 — now processing-only, and the
    // Funding Plan box moved in here per Mike). Funding Plan sits on top, then
    // Closing Coordination. On a pre-processing loan there's no Closing pane, so
    // drop both sections entirely (they must not leak into the Loan view).
    var fpSect      = document.getElementById('fundingPlanSection');
    var closingSect = document.getElementById('closingSection');
    if (paneClosing) {
      if (fpSect)      paneClosing.appendChild(fpSect);
      if (closingSect) paneClosing.appendChild(closingSect);
    } else {
      if (fpSect)      fpSect.remove();
      if (closingSect) closingSect.remove();
    }
    // Deploy 236.618 — the Servicing Info section (built inside the Loan two-col)
    // moves into its own Servicing tab. Same gate as the tab, so paneServicing
    // exists whenever the section does; if not, leave it in place rather than drop.
    var servicingSect = document.getElementById('servicingSection');
    if (servicingSect && paneServicing) paneServicing.appendChild(servicingSect);
    // Sync the tasks count badge on the tab once tasks load. The
    // loadTasksList() called below will trigger a render; hook the
    // existing _tasks state via setTimeout (cheap, no listener
    // required).
    setTimeout(_syncTasksTabCount, 800);

    // Anything left over in .ld-stage that didn't match a section
    // ID stays put (will render below the tabs). Empty in practice
    // because we accounted for every emitted section above.

    // Tab from URL hash if present (#loan / #contacts / #documents
    // / #tasks). Default = loan.
    var hash = String(window.location.hash || '').replace('#', '').toLowerCase();
    // Deploy 236.726 — '#tasks' now opens the Tasks modal (the tab is gone);
    // stale links keep working.
    if (hash === 'tasks') setTimeout(openTasksModal, 300);
    var initial = ['loan','contacts','documents','closing'].indexOf(hash) >= 0 ? hash : 'loan';
    if (initial !== 'loan') switchLdTab(initial, true);
    // If the hash pointed to one of our LEGACY section IDs (e.g.
    // contacts.html's row-click writes #loanContactsSection), jump
    // to the right tab and scroll to the section.
    var sectionToTabHash = {
      'loanfinancialssection':    'loan',
      'propertyappsection':       'loan',
      'borrowerinfosection':      'contacts',
      'linkedguarantorssection':  'contacts',
      'loancontactssection':      'contacts',
      'brokerinfosection':        'contacts',
    };
    var lowerHash = hash.toLowerCase();
    // Deploy 236.726 — legacy task-section hashes open the modal now.
    if (lowerHash === 'tasksection' || lowerHash === 'tasksesection' || lowerHash === 'taskssection') {
      setTimeout(openTasksModal, 300);
    } else if (sectionToTabHash[lowerHash]) {
      switchLdTab(sectionToTabHash[lowerHash], true);
      setTimeout(function() {
        var t = document.getElementById(hash);
        if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);
    }
  })();

  // Deploy 236.124 — Loan Financials inline editor enhancement.
  // Runs after the section has been moved into the Loan tab. Adds
  // click-to-edit handlers to whitelisted fin-cells, lock icons +
  // threshold warnings to calculated cells, and the modified-fields
  // banner with Restore button at the top of the section.
  enhanceLoanFinancialsInlineEdit();

  // Deploy 236.126 — top-of-page guarantor-ownership banner.
  refreshOwnershipBanner();
  refreshBpoRepriceBanner();   // Deploy 236.767
  // Deploy 236.129 — top-of-page banner when a guarantor has
  // submitted / updated their sub-form (incl. signed Credit Auth).
  // Lets the LO know to re-bundle the main loan app if they want
  // the updated guarantor data reflected there.
  refreshGuarantorDocsBanner();

  // Async-load the envelope history for this loan. Doesn't block render.
  refreshEnvelopes();
  // Deploy 236.628 — populate the Note Servicer datalist if the Servicing section rendered.
  refreshNoteServicers();

  // Deploy 226 — render the Notes audit log into the section we just
  // emitted. Pulled into its own function so we can re-render after each
  // manual Add Note without bouncing through the whole page render.
  renderNotesLog();

  // Deploy 236.105 (Phase C — Tasks) — fetch + render this loan's
  // tasks. Async; the section shell already shows "Loading tasks…"
  // until the response lands.
  loadTasksList();

  // Deploy 236.112 — populate the guarantor borrower tabs. No-op
  // when the loan has no linked guarantors (single-borrower case
  // renders entirely from _client inline above, no fetch needed).
  refreshBorrowerInfoPanes();

  // Deploy 236.113 (Phase E) — populate the Additional Contacts list.
  refreshLoanContacts();

  // Deploy 236.108 — eagerly preload the user directory so the
  // assignee picker is instant on first click.
  if (typeof loadUserDirectory === 'function') {
    loadUserDirectory();
  }

  // Deploy 236.73 — async-check whether a loan review already exists
  // for this clientId+loanId, then label the button accordingly.
  refreshDocReviewButton();

  // Deploy 236.84 — populate the Linked Guarantor Clients section
  // (if rendered). Fetches each linked client via the existing
  // clients list and renders name + email + a link to the client
  // page. Non-blocking — the rest of the page is already painted.
  refreshLinkedGuarantors();

  // Deploy 236.477 — load the admin-managed Investors book into the
  // Funding Plan box's Investor dropdown. Async; the box already shows
  // the seeded current selection until this lands.
  populateFundingPlanInvestors();

  // Deploy 236.493 — mount the Underwriting + Lightning Docs tabs (RTL).
  // Self-contained in loan-uw-tab.js; fills #ldPaneUnderwriting +
  // #ldPaneLightning. refreshLoan keeps _loan/_client in sync on save.
  try {
    if (window.SLA_UW_TAB && document.getElementById('ldPaneUnderwriting') && (function(){ var t=String((_loan && _loan.toolType) || '').toLowerCase(); return t === 'rtl' || t === 'dscr' || t === 'guc' || t === ''; })()) {
      SLA_UW_TAB.mount({
        loan: _loan, clientId: _clientId, loanId: _loanId,
        // Deploy 236.510 — the borrowing entity name lives on the CLIENT
        // (loans don't always carry it), so pass it through for the UW
        // "Borrower Name" field (= entity name, per Mike).
        entityName: (_client && _client.entityName) || (_loan && _loan.entityName) || '',
        owner: (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null,
        refreshLoan: function (updated) {
          _loan = updated;
          var i = (_client && _client.loans || []).findIndex(function (x) { return x && x.id === _loanId; });
          if (i >= 0) _client.loans[i] = updated;
        },
      });
    }
  } catch (e) { console.warn('[SLA] UW tab mount failed:', e); }
}

// Deploy 236.112 — Borrower Info pane populator. The primary
// borrower tab paints inline at render time from _client. Guarantor
// tabs render as "Loading…" placeholders that this function fills
// once SLA.Clients.list resolves. Same fetch pattern as
// refreshLinkedGuarantors (which loads its own pool from the same
// list) — could share if we cared, but the duplication is cheap.
function refreshBorrowerInfoPanes() {
  if (!_loan) return;
  var ids = Array.isArray(_loan.guarantorClientIds) ? _loan.guarantorClientIds : [];
  if (!ids.length) return; // single-borrower case; nothing to fetch

  var p = SLA.isStaff(_user) ? SLA.Clients.list({ all: true, summary: true }) : SLA.Clients.list({ summary: true }); // Deploy 236.266
  p.then(function(r) {
    var pool = [];
    if (r.byOwner) {
      Object.keys(r.byOwner).forEach(function(k) {
        (r.byOwner[k] || []).forEach(function(c) { pool.push(c); });
      });
    } else {
      pool = r.clients || [];
    }
    var byId = {};
    pool.forEach(function(c) { if (c && c.id) byId[c.id] = c; });
    ids.forEach(function(id, i) {
      var idx = i + 1;
      var pane = document.getElementById('bw-pane-' + idx);
      var tab  = document.getElementById('bw-tab-'  + idx);
      if (!pane) return;
      var c = byId[id];
      if (!c) {
        pane.classList.remove('loading');
        pane.innerHTML = '<div style="padding:10px 12px;background:#fff;border:1px solid var(--border, #ddd8d0);border-radius:6px;font-size:12px;color:var(--muted)">Borrower record ' + escH(id) + ' not found (may belong to another LO).</div>';
        if (tab) {
          var sub = tab.querySelector('.bw-tab-sub');
          if (sub) sub.textContent = 'Not found';
        }
        return;
      }
      var name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email || 'Guarantor ' + idx;
      // Deploy 236.126 — ownership % for this guarantor (pulled from
      // loan.guarantorOwnership map keyed by the guarantor's client id).
      var ownerships = (_loan && _loan.guarantorOwnership && typeof _loan.guarantorOwnership === 'object') ? _loan.guarantorOwnership : {};
      var pct = ownerships[c.id] != null ? ownerships[c.id] : '';
      // Deploy 236.128 — sub-form invite link card. Each additional
      // guarantor's client record carries _subFormTokensByLoan
      // keyed by the loanId we're viewing, with { token, status,
      // completedAt }. Surface a copy-to-clipboard + status pill
      // here so the LO has a single click to send the link.
      var subFormHtml = '';
      var tokenEntry = c._subFormTokensByLoan && c._subFormTokensByLoan[_loanId];
      if (tokenEntry && tokenEntry.token) {
        subFormHtml = _renderSubFormLinkCard(tokenEntry, c);
      }
      pane.classList.remove('loading');
      pane.innerHTML =
        '<div class="app-grid">' +
          '<div class="field"><label>Guarantor Name</label>' +
            '<input type="text"  id="bw-' + idx + '-name"   value="' + escAttr(name) + '" readonly /></div>' +
          '<div class="field"><label>Borrower LLC</label>' +
            // Deploy 236.327 — same Borrower LLC fallback the primary
            // pane uses: prefer the loan's Vesting LLC (the entity
            // actually on title) over this guarantor's own entityName
            // (which for co-guarantors is often just their personal
            // holding company, not the deal's vesting entity).
            '<input type="text"  id="bw-' + idx + '-entity" value="' + escAttr(
              (Array.isArray(_loan.vestingLLCs) && _loan.vestingLLCs.length && _loan.vestingLLCs[0].name)
                || (Array.isArray(c.companies) && c.companies[0] && c.companies[0].name)
                || c.entityName || ''
            ) + '" readonly placeholder="No entity on file" /></div>' +
          '<div class="field"><label>Email</label>' +
            '<input type="email" id="bw-' + idx + '-email"  value="' + escAttr(c.email || '') + '" readonly /></div>' +
          '<div class="field"><label>Phone</label>' +
            '<input type="tel"   id="bw-' + idx + '-phone"  value="' + escAttr(c.phone || '') + '" readonly /></div>' +
        '</div>' +
        _renderOwnershipField(c.id, pct, idx) +
        subFormHtml +
        // Deploy 236.143 — same Edit Guarantor button as on the
        // primary pane. Replaces the previous inline-italic "Edit
        // this guarantor's contact info on their Client Details
        // page →" link. Changes on the client record propagate to
        // every loan this guarantor is tied to on next page load.
        // Deploy 236.147 — additional guarantors ALSO get the
        // Download Application button (isPrimary=false).
        // Deploy 236.630 — pass email + name so the Send Signing Link modal prefills.
        _renderEditGuarantorButton(c.id, false, c.email, name);
      if (tab) {
        var lbl = tab.querySelector('.bw-tab-label');
        var sub2 = tab.querySelector('.bw-tab-sub');
        if (lbl) lbl.textContent = name;
        if (sub2) sub2.textContent = 'Guarantor ' + (idx + 1);
      }
    });
  }).catch(function(err) {
    ids.forEach(function(_, i) {
      var pane = document.getElementById('bw-pane-' + (i + 1));
      if (pane) {
        pane.classList.remove('loading');
        pane.innerHTML = '<div style="padding:10px 12px;font-size:12px;color:var(--danger)">Failed to load: ' + escH(err && err.message || 'unknown') + '</div>';
      }
    });
  });
}

function switchBorrowerTab(idx) {
  document.querySelectorAll('#borrowerInfoSection .bw-tab').forEach(function(t) {
    t.classList.toggle('active', parseInt(t.dataset.bwIdx, 10) === idx);
  });
  document.querySelectorAll('#borrowerInfoSection .bw-pane').forEach(function(p) {
    p.classList.toggle('active', p.id === 'bw-pane-' + idx);
  });
}

// ════════════════════════════════════════════════════════════════════
// Deploy 236.126 — Vesting LLC Info + Guarantor % Ownership + banner
// ════════════════════════════════════════════════════════════════════

function _renderVestingLLCRow(entry, idx, total) {
  var name = (entry && entry.name) || '';
  var removeBtn = total > 1
    ? '<button type="button" class="vesting-llc-remove" onclick="removeVestingLLCRow(' + idx + ')">Remove</button>'
    : '<span></span>';
  return '<div class="vesting-llc-row" data-llc-idx="' + idx + '">' +
    '<input type="text" class="vesting-llc-name" value="' + escAttr(name) + '" placeholder="LLC name on title (e.g. 1234 Main St LLC)" />' +
    removeBtn +
  '</div>';
}

function addVestingLLCRow() {
  var list = document.getElementById('vestingLLCList');
  if (!list) return;
  var current = _collectVestingLLCs();
  current.push({ name: '' });
  list.innerHTML = current.map(function(v, i) {
    return _renderVestingLLCRow(v, i, current.length);
  }).join('');
}

function removeVestingLLCRow(idx) {
  var list = document.getElementById('vestingLLCList');
  if (!list) return;
  var current = _collectVestingLLCs();
  current.splice(idx, 1);
  if (!current.length) current.push({ name: '' }); // always keep at least one row
  list.innerHTML = current.map(function(v, i) {
    return _renderVestingLLCRow(v, i, current.length);
  }).join('');
}

function _collectVestingLLCs() {
  var out = [];
  document.querySelectorAll('#vestingLLCList .vesting-llc-name').forEach(function(input) {
    out.push({ name: input.value });
  });
  return out;
}

function saveVestingLLCs() {
  var btn = document.getElementById('vestingLLCSaveBtn');
  var status = document.getElementById('vestingLLCStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  if (status) { status.className = 'vesting-llc-status'; status.textContent = ''; }
  // Trim + drop empty rows on save (keep at least one even if blank).
  var llcs = _collectVestingLLCs()
    .map(function(v) { return { name: String(v.name || '').trim() }; })
    .filter(function(v) { return v.name; });
  var payload = { clientId: _clientId, loanId: _loanId, fields: { vestingLLCs: llcs } };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-field-edit', payload).then(function(r) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Vesting LLCs'; }
    if (status) { status.className = 'vesting-llc-status ok'; status.textContent = 'Saved ✓'; }
    if (r && r.loan) {
      _loan = r.loan;
      var lidx = (_client && _client.loans || []).findIndex(function(x) { return x && x.id === _loanId; });
      if (lidx >= 0) _client.loans[lidx] = r.loan;
    }
    setTimeout(function() { if (status) { status.textContent = ''; status.className = 'vesting-llc-status'; } }, 2500);
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Vesting LLCs'; }
    if (status) { status.className = 'vesting-llc-status err'; status.textContent = 'Save failed: ' + (err && err.message || 'unknown'); }
  });
}

// Deploy 236.143 — Edit Guarantor button. Per Mike: guarantor name
// and contact info on Loan Details are read-only; this button drops
// the LO into the Client Details page where the canonical edits
// happen. Opens in a new tab so the LO doesn't lose loan context.
// Since every loan reads guarantor data fresh from the client record
// on render, edits made on Client Details propagate to every loan
// that client is tied to on next page load — no extra sync needed.
// Deploy 236.146 — adds a sibling "Download Application" button
// that pulls a per-guarantor PDF (with decrypted SSN + signed
// Credit Auth pages stitched on) via authed fetch + blob URL.
// Deploy 236.147 — Download Application is hidden for the primary
// (Guarantor 1). Primary's data lives in the main signed loan app
// — the "Download Signed Application (PDF)" button on Financials
// is the right entry point. Only additional guarantors (2/3/4)
// have a separate sub-application worth downloading.
function _renderEditGuarantorButton(clientId, isPrimary, gEmail, gName) {
  if (!clientId) return '';
  var ownerSuffix = (_loEmail && _user && _loEmail !== _user.email)
    ? '&owner=' + encodeURIComponent(_loEmail) : '';
  var href = '/client-details.html?clientId=' + encodeURIComponent(clientId) + ownerSuffix;
  var downloadBtn = isPrimary ? '' :
    '<button type="button" class="bw-edit-guarantor-btn" onclick="downloadGuarantorApplication(this, \'' + escAttr(clientId) + '\')" ' +
       'title="Download this guarantor\'s full application as PDF (includes decrypted SSN and signed Credit Authorization if on file).">' +
      '<span class="bw-edit-icon">⬇</span> Download Application' +
    '</button>';
  // Deploy 236.629 — Send Signing Link. For a guarantor added AFTER the primary
  // borrower signed, no co-signer auth link was ever generated. This emails them
  // one (creates the secondary signer block on the signed application). Non-primary
  // only; the endpoint returns a clear message if Borrower 1 hasn't signed yet.
  var sendLinkBtn = isPrimary ? '' :
    '<button type="button" class="bw-edit-guarantor-btn" data-cs-client="' + escAttr(clientId) + '" data-cs-email="' + escAttr(gEmail || '') + '" data-cs-name="' + escAttr(gName || '') + '" onclick="openCosignerModal(this)" ' +
       'title="Send this guarantor a link to sign their own credit &amp; background authorization — email it and/or copy it to send manually. Use this if they were added after the primary borrower signed.">' +
      '<span class="bw-edit-icon">✉</span> Send Signing Link' +
    '</button>';
  // Deploy 236.366 — Remove Guarantor. Non-primary only (removing
  // the primary would orphan the loan). Mike's original use case:
  // broker loans get a co-guarantor added by accident before ready.
  var removeBtn = isPrimary ? '' :
    '<button type="button" class="bw-remove-guarantor-btn" onclick="removeGuarantorFromLoan(\'' + escAttr(clientId) + '\')" ' +
       'title="Unlink this guarantor from this loan. Their client record is kept — you can re-add them later or leave them for other loans they\'re tied to.">' +
      '<span class="bw-edit-icon">×</span> Remove Guarantor' +
    '</button>';
  // Deploy 236.705 — Make Primary. Non-primary only. Promotes this guarantor to
  // primary (moves loan ownership + relabels them Guarantor 1); the old primary
  // is demoted to a secondary guarantor and existing signatures are preserved.
  var makePrimaryBtn = isPrimary ? '' :
    '<button type="button" class="bw-edit-guarantor-btn" onclick="makePrimaryGuarantor(\'' + escAttr(clientId) + '\')" ' +
       'title="Make this guarantor the PRIMARY (Guarantor 1). The current primary becomes a secondary guarantor. Both parties keep their existing signatures — the application is just relabeled.">' +
      '<span class="bw-edit-icon">★</span> Make Primary' +
    '</button>';
  // Deploy 236.367 — primary-only buttons that used to live in a
  // standalone .change-primary-guarantor-row (which visually looked
  // like a separate mini-card underneath the section). Consolidated
  // into the primary pane footer so all primary-affecting actions
  // sit in one row alongside Edit Guarantor.
  var changePrimaryBtn = isPrimary
    ? '<button type="button" class="bw-edit-guarantor-btn" onclick="openReassignLoanModal()" ' +
        'title="Reassign this loan to a different primary guarantor. If the new person is a different borrower, the loan application will be reset.">' +
        '<span class="bw-edit-icon">⇄</span> Change Primary Guarantor' +
      '</button>'
    : '';
  var clearPrimaryBtn = isPrimary
    ? '<button type="button" class="bw-remove-guarantor-btn" onclick="clearPrimaryGuarantor()" ' +
        'title="For broker loans: wipe the primary guarantor and revert the loan to broker-only mode. Creates a Broker Deal placeholder client so the loan isn\'t orphaned. The loan application will be reset.">' +
        '<span class="bw-edit-icon">×</span> Clear Primary Guarantor' +
      '</button>'
    : '';
  // Deploy 236.705 — Delete Primary Guarantor. Primary pane, only when at least
  // one additional guarantor exists to promote. Removes the primary and promotes
  // Guarantor 2 to primary; the application is reset so the remaining parties
  // re-sign the corrected document.
  var _hasG2 = !!(_loan && Array.isArray(_loan.guarantorClientIds) && _loan.guarantorClientIds.length > 0);
  var deletePrimaryBtn = (isPrimary && _hasG2)
    ? '<button type="button" class="bw-remove-guarantor-btn" onclick="deletePrimaryGuarantor()" ' +
        'title="Remove the primary guarantor and promote Guarantor 2 to primary. The application is reset to awaiting-signatures so the remaining parties re-sign the corrected document.">' +
        '<span class="bw-edit-icon">×</span> Delete Primary Guarantor' +
      '</button>'
    : '';
  return '<div class="bw-pane-footer" style="gap:8px;flex-wrap:wrap">' +
    sendLinkBtn +
    downloadBtn +
    makePrimaryBtn +
    '<a class="bw-edit-guarantor-btn" href="' + escAttr(href) + '" target="_blank" rel="noopener" ' +
       'title="Open this guarantor\'s Client Details page in a new tab. Changes there sync to every loan this client is tied to.">' +
      '<span class="bw-edit-icon">✎</span> Edit Guarantor' +
    '</a>' +
    changePrimaryBtn +
    removeBtn +
    deletePrimaryBtn +
    clearPrimaryBtn +
  '</div>';
}

// Deploy 236.367 — Clear Primary Guarantor. Broker-mode revert flow.
// Uses the existing loan-reassign endpoint with:
//   - newClient: a placeholder "Broker Deal — <property>"
//   - resetApplication: true (wipes borrower_info + signed app)
//   - setBrokerFlag: true (stamps _isBrokerLoan on the loan)
// Redirects to the loan under the new placeholder client on success.
function clearPrimaryGuarantor() {
  if (!_client || !_loan) return;
  var address = (_loan.address || '').trim();
  // Extract the street portion for the placeholder name (before the
  // first comma). Falls back to a date-stamped label if there's no
  // address on the loan yet.
  var street = address.split(',')[0].trim();
  if (!street) {
    street = 'no address yet';
  }
  var placeholderLast = street.slice(0, 60); // reasonable cap
  var currentName = ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim() || _client.email || 'the current borrower';

  var confirmMsg = 'Revert this loan to broker-only mode?\n\n' +
    'This will:\n' +
    '  1. Move the loan off ' + currentName + ' onto a new "Broker Deal — ' + street + '" placeholder client\n' +
    '  2. Delete the loan application (long-app + signed PDF)\n' +
    '  3. Unlink co-guarantors and clear vesting LLC info\n' +
    '  4. Flip the loan into broker mode\n\n' +
    currentName + '\'s own client record is kept — this only affects THIS loan.\n\n' +
    'Continue?';
  if (!confirm(confirmMsg)) return;

  var body = {
    srcClientId: _client.id,
    loanId:      _loanId,
    newClient: {
      firstName:  'Broker Deal',
      lastName:   placeholderLast,
      email:      '',
      phone:      '',
      entityName: '',
    },
    resetApplication: true,
    setBrokerFlag:    true,
  };
  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  if (ownerOvr) body.owner = ownerOvr;

  SLA.Loans.reassign(body).then(function(resp) {
    if (typeof showToast === 'function') showToast('Cleared primary — loan reverted to broker mode');
    setTimeout(function() {
      var url = SLA.urls.loanDetails(resp.loanId, { owner: ownerOvr });
      window.location.href = url;
    }, 500);
  }).catch(function(err) {
    console.error('clearPrimaryGuarantor failed:', err);
    var msg = (err && err.message) || 'unknown error';
    if (typeof showToast === 'function') showToast('Clear failed: ' + msg);
  });
}

// Deploy 236.366 — click handler for the Remove Guarantor button.
// Confirms, calls SLA.Loans.removeGuarantor, reloads on success.
// Deploy 236.705 — helper: friendly label for a guarantor pane by client id.
function _guarantorPaneLabel(clientId, fallback) {
  var label = fallback || 'this guarantor';
  try {
    var panes = document.querySelectorAll('#borrowerInfoSection .bw-pane');
    for (var p = 0; p < panes.length; p++) {
      if (panes[p].getAttribute('data-client-id') === clientId) {
        var nameEl = panes[p].querySelector('input[id^="bw-"][id$="-name"]');
        if (nameEl && nameEl.value && nameEl.value.trim()) return nameEl.value.trim();
      }
    }
  } catch (_) {}
  return label;
}

// Deploy 236.705 — Make Primary (switch). Promote this guarantor to primary;
// the old primary is demoted to a secondary guarantor; signatures preserved.
function makePrimaryGuarantor(guarantorClientId) {
  if (!_client || !_loanId || !guarantorClientId) return;
  var label = _guarantorPaneLabel(guarantorClientId, 'this guarantor');
  var confirmMsg = 'Make ' + label + ' the PRIMARY guarantor on this loan?\n\n' +
    'The loan moves under their record and they become Guarantor 1. The current ' +
    'primary becomes a secondary guarantor. Both parties keep their existing ' +
    'signatures — the application is just relabeled and regenerated.';
  if (!confirm(confirmMsg)) return;
  var payload = { clientId: _client.id, loanId: _loanId, guarantorClientId: guarantorClientId, mode: 'switch' };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.Loans.makePrimary(payload).then(function(res) {
    if (typeof showToast === 'function') {
      showToast('Primary switched to ' + label + (res && res.signaturesPreserved ? ' — signatures preserved' : ''));
    }
    setTimeout(function() { window.location.reload(); }, 700);
  }).catch(function(err) {
    console.error('makePrimaryGuarantor failed:', err);
    if (typeof showToast === 'function') showToast('Make Primary failed: ' + ((err && err.message) || 'unknown error'));
  });
}

// Deploy 236.705 — Delete Primary Guarantor. Removes the primary and promotes
// Guarantor 2 to primary; the application is reset so the remaining parties
// re-sign the corrected document.
function deletePrimaryGuarantor() {
  if (!_client || !_loanId) return;
  var g2 = (_loan && Array.isArray(_loan.guarantorClientIds) && _loan.guarantorClientIds.length)
    ? _loan.guarantorClientIds[0] : '';
  if (!g2) {
    if (typeof showToast === 'function') showToast('No Guarantor 2 to promote — add a guarantor first, or use Clear Primary Guarantor.');
    return;
  }
  var g2Label = _guarantorPaneLabel(g2, 'Guarantor 2');
  var confirmMsg = 'Remove the primary guarantor and promote ' + g2Label + ' to primary?\n\n' +
    'The loan moves under ' + g2Label + '\'s record and the old primary is removed ' +
    'from this loan. Because a guarantor is being removed, the application is RESET ' +
    'to awaiting-signatures — the remaining parties must re-sign it. You\'ll need to ' +
    're-send the signing link.';
  if (!confirm(confirmMsg)) return;
  var payload = { clientId: _client.id, loanId: _loanId, guarantorClientId: g2, mode: 'delete_primary' };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.Loans.makePrimary(payload).then(function(res) {
    if (typeof showToast === 'function') {
      showToast('Primary removed — ' + g2Label + ' promoted. Application reset; re-send the signing link.');
    }
    setTimeout(function() { window.location.reload(); }, 800);
  }).catch(function(err) {
    console.error('deletePrimaryGuarantor failed:', err);
    if (typeof showToast === 'function') showToast('Delete Primary failed: ' + ((err && err.message) || 'unknown error'));
  });
}

function removeGuarantorFromLoan(guarantorClientId) {
  if (!_client || !_loanId || !guarantorClientId) return;
  // Try to pull a friendly label from the currently-loaded pane's
  // name field. Falls back to the raw id if the pane hasn't
  // hydrated yet.
  var label = 'this guarantor';
  try {
    var panes = document.querySelectorAll('#borrowerInfoSection .bw-pane');
    for (var p = 0; p < panes.length; p++) {
      if (panes[p].getAttribute('data-client-id') === guarantorClientId) {
        var nameEl = panes[p].querySelector('input[id^="bw-"][id$="-name"]');
        if (nameEl && nameEl.value && nameEl.value.trim()) {
          label = nameEl.value.trim();
        }
        break;
      }
    }
  } catch (_) {}
  var confirmMsg = 'Remove ' + label + ' as a guarantor on this loan?\n\n' +
    'Their client record is kept — this only unlinks them from THIS loan. ' +
    'Their ownership % and any pending subform invite for this loan will be cleared.\n\n' +
    'If the loan application was already signed, removing a guarantor MODIFIES the ' +
    'document, so it will be reset to awaiting-signatures and the remaining parties ' +
    'must re-sign it. You\'ll need to re-send the signing link.';
  if (!confirm(confirmMsg)) return;

  var payload = {
    clientId:          _client.id,
    loanId:            _loanId,
    guarantorClientId: guarantorClientId,
  };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;

  SLA.Loans.removeGuarantor(payload).then(function(res) {
    // Deploy 236.703 — if the signed application was reset, tell the LO the
    // remaining parties must re-sign (the signing affordances reappear on reload).
    if (res && res.applicationReset) {
      if (typeof showToast === 'function') showToast('Guarantor removed — application reset; remaining parties must re-sign. Re-send the signing link.');
    } else if (typeof showToast === 'function') {
      showToast('Guarantor removed');
    }
    setTimeout(function() { window.location.reload(); }, 600);
  }).catch(function(err) {
    console.error('removeGuarantorFromLoan failed:', err);
    var msg = (err && err.message) || 'unknown error';
    if (typeof showToast === 'function') showToast('Remove failed: ' + msg);
  });
}

// Deploy 236.146 — per-guarantor application download.
// Authed fetch + blob URL (same pattern as the bundle download +
// SLA.SignedApplication.download() since plain <a href> 401s).
// SSN is decrypted server-side and printed in the PDF — this
// endpoint is LO/admin-auth-gated.
function downloadGuarantorApplication(btn, guarantorClientId) {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  var originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Building...';
  var qs = '?clientId=' + encodeURIComponent(_client.id) +
           '&loanId='   + encodeURIComponent(_loanId) +
           '&guarantorClientId=' + encodeURIComponent(guarantorClientId) +
           ((_loEmail && _user && _loEmail !== _user.email)
             ? '&owner=' + encodeURIComponent(_loEmail) : '');
  SLA.getToken().then(function(token) {
    return fetch('/api/guarantor-application-download' + qs, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
  }).then(function(r) {
    if (!r.ok) {
      return r.json().catch(function() { return {}; }).then(function(d) {
        throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
      });
    }
    return r.blob().then(function(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="([^"]+)"/.exec(cd);
      a.download = m ? m[1] : 'guarantor-application.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    });
  }).then(function() {
    btn.disabled = false; btn.innerHTML = originalHTML;
  }).catch(function(err) {
    btn.disabled = false; btn.innerHTML = originalHTML;
    showToast('Download failed: ' + ((err && err.message) || 'unknown'));
  });
}

function _renderOwnershipField(clientId, pctValue, paneIdx) {
  return '<div class="bw-ownership-field">' +
    '<label for="bw-' + paneIdx + '-ownership">% Ownership of LLC</label>' +
    '<input type="number" id="bw-' + paneIdx + '-ownership" min="0" max="100" step="0.01" value="' + escAttr(pctValue) + '" placeholder="e.g. 50" ' +
      'data-client-id="' + escAttr(clientId) + '" onchange="saveGuarantorOwnership(this)" />' +
    '<span class="ow-suffix">%</span>' +
    '<span class="ow-status" data-status-for="' + escAttr(clientId) + '"></span>' +
  '</div>';
}

function saveGuarantorOwnership(input) {
  var clientId = input && input.dataset && input.dataset.clientId;
  if (!clientId) return;
  var raw = String(input.value || '').trim();
  var status = document.querySelector('.ow-status[data-status-for="' + clientId + '"]');
  if (status) { status.className = 'ow-status'; status.textContent = 'Saving…'; }
  // Build updated ownership map from current loan state + override.
  var ownerships = (_loan && _loan.guarantorOwnership && typeof _loan.guarantorOwnership === 'object')
    ? Object.assign({}, _loan.guarantorOwnership)
    : {};
  if (raw === '') {
    delete ownerships[clientId];
  } else {
    var n = parseFloat(raw);
    if (!isFinite(n) || n < 0 || n > 100) {
      if (status) { status.className = 'ow-status err'; status.textContent = 'Must be 0–100'; }
      return;
    }
    ownerships[clientId] = n;
  }
  var payload = { clientId: _clientId, loanId: _loanId, fields: { guarantorOwnership: ownerships } };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-field-edit', payload).then(function(r) {
    if (r && r.loan) {
      _loan = r.loan;
      var lidx = (_client && _client.loans || []).findIndex(function(x) { return x && x.id === _loanId; });
      if (lidx >= 0) _client.loans[lidx] = r.loan;
    }
    if (status) { status.className = 'ow-status ok'; status.textContent = 'Saved ✓'; }
    setTimeout(function() { if (status) { status.textContent = ''; status.className = 'ow-status'; } }, 1800);
    refreshOwnershipBanner();
    refreshBpoRepriceBanner();   // Deploy 236.767
  }).catch(function(err) {
    if (status) { status.className = 'ow-status err'; status.textContent = 'Save failed'; }
  });
}

// Deploy 236.128 — sub-form invite link card (rendered inside each
// additional-guarantor pane). Shows the URL the LO sends to the
// guarantor + a status pill (Pending / In Progress / Completed).
// The token is generated server-side by borrower-info-sign when
// the additional guarantor's client record is created. URL points
// at the public guarantor-subform.html page (token IS the auth).
function _renderSubFormLinkCard(tokenEntry, c) {
  var status = String(tokenEntry.status || 'pending').toLowerCase();
  var statusLabel = status === 'completed' ? 'Completed' :
                    status === 'in_progress' ? 'In Progress' :
                    status === 'completed_by_primary' ? 'Completed (by primary borrower)' :
                    'Pending — send the link';
  var url = window.location.origin + '/guarantor-subform.html?t=' + encodeURIComponent(tokenEntry.token);
  var emailBody = encodeURIComponent(
    'Hi ' + (c.firstName || '') + ',\n\n' +
    'You\'re listed as a guarantor on a loan we\'re working on. To complete your part of the application, please fill out the secure sub-form at this link:\n\n' +
    url + '\n\n' +
    'It collects your date of birth, credit, SSN (encrypted), addresses, citizenship, and the standard declarations. Should take 5-10 minutes.\n\n' +
    'Thanks!');
  var mailto = 'mailto:' + encodeURIComponent(c.email || '') +
               '?subject=' + encodeURIComponent('Complete your guarantor profile') +
               '&body=' + emailBody;
  return '<div class="subform-card">' +
    '<div class="sf-row">' +
      '<span class="sf-label">Sub-Form Link</span>' +
      '<span class="sf-pill ' + escAttr(status) + '">' + escH(statusLabel) + '</span>' +
      (tokenEntry.completedAt ? '<span style="font-size:11px;color:var(--muted);font-family:DM Mono,monospace">— ' + escH(new Date(tokenEntry.completedAt).toLocaleString()) + '</span>' : '') +
    '</div>' +
    '<div class="sf-url-row">' +
      '<input type="text" class="sf-url-input" readonly value="' + escAttr(url) + '" onclick="this.select()" />' +
      '<button type="button" class="sf-btn" onclick="copySubFormLink(this, \'' + escAttr(tokenEntry.token) + '\')">Copy</button>' +
      '<a class="sf-btn" href="' + escAttr(mailto) + '" style="text-decoration:none">Email</a>' +
    '</div>' +
    // Deploy 236.130 — Signed Authorizations block. Lists every
    // document this guarantor has signed via the sub-form. Currently
    // that's just the Credit Authorization (added in 236.129); the
    // shape is set up so future deploys can add more docs (e.g.
    // separate FCRA disclosure, ESIGN-only consent, OFAC ack) by
    // pushing another row into the list. Only renders when the
    // guarantor's sub-form is actually 'completed' (a separately-
    // captured signature, vs 'completed_by_primary' where the
    // primary borrower entered the data in the long app with no
    // standalone signature).
    (status === 'completed'
      ? '<div style="margin-top:10px;padding:10px 12px;background:rgba(37,105,64,0.05);border:1px solid rgba(37,105,64,0.20);border-radius:5px">' +
          '<div style="font-size:11px;font-weight:700;color:var(--success);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Signed Authorizations</div>' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px">' +
            '<span style="flex:1;min-width:200px">📄 Credit Authorization' +
              (tokenEntry.creditAuthSignedAt ? ' <span style="color:var(--muted);font-family:DM Mono,monospace;font-size:11px">— signed ' + escH(new Date(tokenEntry.creditAuthSignedAt).toLocaleString()) + '</span>' : '') +
            '</span>' +
            '<a class="sf-btn" href="/api/guarantor-credit-auth-download?t=' + encodeURIComponent(tokenEntry.token) + '" target="_blank" rel="noopener" style="text-decoration:none">View</a>' +
            '<a class="sf-btn" href="/api/guarantor-credit-auth-download?t=' + encodeURIComponent(tokenEntry.token) + '&download=1" style="text-decoration:none">Download</a>' +
          '</div>' +
        '</div>'
      : '') +
    '<div class="sf-hint">' +
      (status === 'completed'
        ? 'Guarantor has submitted their profile + signed Credit Authorization. ' +
          (tokenEntry.creditAuthSignedAt ? 'Signed ' + escH(new Date(tokenEntry.creditAuthSignedAt).toLocaleString()) + '.' : '') +
          ' Re-sharing the link lets them update fields (no re-sign required).'
        : status === 'completed_by_primary'
          ? 'The primary borrower already filled this guarantor\'s info in the long app. A signed Credit Authorization was NOT captured separately — send the link if you need them to sign their own.'
          : 'Send this link to the guarantor — they\'ll provide DOB, credit, SSN (encrypted), addresses, citizenship, declarations, AND sign the Credit Authorization. The link doesn\'t expire; status updates here when they save or submit.') +
    '</div>' +
  '</div>';
}

// ════════════════════════════════════════════════════════════════════
// Deploy 236.130 — Manual Add Guarantor modal
// ════════════════════════════════════════════════════════════════════
// LO clicks "+ Add Guarantor" in the Guarantor Info header → modal
// asks for Email / First / Last / Phone / % Ownership. Email blur
// scans the LO's existing clients locally; if a match is found, the
// modal pre-fills the rest from that contact and surfaces a green
// "Will link to existing contact" message. Save → POST → reload page.

var _agExistingMatch = null; // { client } when an existing contact matches
var _agAllClientsCache = null;

// ── Audit Log (Deploy 236.771, Mike) ────────────────────────────────
// The REAL audit log: every field-level change made to this loan from Loan
// Details or a sizer, with who made it. Distinct from Notes & Activity, which
// stays a human notes + milestone feed. Opened from the "Audit Log" pill.
function openAuditLogModal() {
  var existing = document.getElementById('alModalBg');
  if (existing) existing.remove();
  var bg = document.createElement('div');
  bg.className = 'ag-modal-bg';
  bg.id = 'alModalBg';
  bg.onclick = function(e) { if (e.target === bg) bg.remove(); };
  bg.innerHTML =
    '<div class="ag-modal" style="max-width:760px;width:100%;max-height:82vh;display:flex;flex-direction:column">' +
      '<h3 style="display:flex;align-items:center;justify-content:space-between;gap:12px">' +
        '<span>Audit Log</span>' +
        '<button type="button" onclick="document.getElementById(\'alModalBg\').remove()" ' +
          'style="background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:var(--muted)">&times;</button>' +
      '</h3>' +
      '<div class="ag-hint">Every change made to this loan from Loan Details or a sizer — field by field, with who made it and when.</div>' +
      '<div id="alBody" style="overflow:auto;flex:1;margin-top:10px">' +
        '<div style="color:var(--muted);padding:18px 2px">Loading…</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(bg);

  var qs = 'clientId=' + encodeURIComponent(_clientId || '') +
           '&loanId=' + encodeURIComponent(_loanId || '');
  var _alOwner = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  if (_alOwner) qs += '&owner=' + encodeURIComponent(_alOwner);
  SLA.api('GET', '/api/loan-change-log-get?' + qs).then(function(r) {
    _renderAuditLog((r && r.entries) || []);
  }).catch(function(err) {
    var body = document.getElementById('alBody');
    if (body) body.innerHTML = '<div style="color:var(--danger);padding:18px 2px">Couldn\'t load the audit log: ' +
      escH((err && err.message) || 'unknown') + '</div>';
  });
}

function _renderAuditLog(entries) {
  var body = document.getElementById('alBody');
  if (!body) return;
  if (!entries.length) {
    body.innerHTML = '<div style="color:var(--muted);padding:18px 2px">No changes recorded yet. ' +
      'Edits made from Loan Details or a sizer from here on will be listed here.</div>';
    return;
  }
  body.innerHTML = entries.map(function(e) {
    var when = e.at ? fmtDateTime(e.at) : '';
    var who  = escH(e.byName || e.by || 'Unknown');
    var src  = e.source ? '<span style="background:var(--bg,#f0ece5);border-radius:10px;padding:1px 8px;font-size:11px;color:var(--muted);margin-left:8px">' + escH(e.source) + '</span>' : '';
    var rows = (e.changes || []).map(function(c) {
      return '<tr>' +
        '<td style="padding:3px 10px 3px 0;color:var(--muted);white-space:nowrap;vertical-align:top">' + escH(c.label || c.field) + '</td>' +
        '<td style="padding:3px 8px 3px 0;color:var(--danger,#b4432f);text-decoration:line-through;word-break:break-word">' + (c.from ? escH(c.from) : '<span style="color:var(--muted);text-decoration:none">(empty)</span>') + '</td>' +
        '<td style="padding:3px 6px 3px 0;color:var(--muted)">&rarr;</td>' +
        '<td style="padding:3px 0;font-weight:600;word-break:break-word">' + (c.to ? escH(c.to) : '<span style="color:var(--muted);font-weight:400">(cleared)</span>') + '</td>' +
      '</tr>';
    }).join('');
    return '<div style="border:1px solid var(--border,#e6e0d8);border-radius:10px;padding:10px 12px;margin-bottom:10px">' +
      '<div style="font-size:12px;margin-bottom:6px">' +
        '<strong>' + who + '</strong>' + src +
        '<span style="float:right;color:var(--muted)">' + escH(when) + '</span>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' + rows + '</table>' +
    '</div>';
  }).join('');
}

function openAddGuarantorModal() {
  var existing = document.getElementById('agModalBg');
  if (existing) existing.remove();
  var bg = document.createElement('div');
  bg.className = 'ag-modal-bg';
  bg.id = 'agModalBg';
  bg.onclick = function(e) { if (e.target === bg) bg.remove(); };
  bg.innerHTML =
    '<div class="ag-modal">' +
      '<h3>Add Guarantor</h3>' +
      '<div class="ag-hint">Add an additional guarantor to this loan without re-routing through the long application. If their email matches an existing contact under you, we\'ll link to that contact and auto-fill the rest. The sub-form link is generated automatically.</div>' +
      '<div class="ag-match" id="agMatch"></div>' +
      '<div class="ag-field"><label>Email <span style="color:var(--danger)">*</span></label>' +
        '<div class="ag-email-wrap">' +
          '<input type="email" id="agEmail" placeholder="guarantor@email.com" autocomplete="off" />' +
          '<div class="ag-suggest" id="agSuggest" role="listbox"></div>' +
        '</div>' +
      '</div>' +
      '<div class="ag-row">' +
        '<div class="ag-field"><label>First Name <span style="color:var(--danger)">*</span></label>' +
          '<input type="text" id="agFirstName" /></div>' +
        '<div class="ag-field"><label>Last Name <span style="color:var(--danger)">*</span></label>' +
          '<input type="text" id="agLastName" /></div>' +
      '</div>' +
      '<div class="ag-row">' +
        '<div class="ag-field"><label>Phone</label>' +
          '<input type="tel" id="agPhone" placeholder="(555) 123-4567" /></div>' +
        '<div class="ag-field"><label>% Ownership of LLC</label>' +
          '<input type="number" id="agOwnership" min="0" max="100" step="0.01" placeholder="e.g. 25" /></div>' +
      '</div>' +
      '<div class="ag-err" id="agErr"></div>' +
      '<div class="ag-actions">' +
        '<button type="button" id="agCancel">Cancel</button>' +
        '<button type="button" class="primary" id="agSave">Add Guarantor</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(bg);
  document.getElementById('agCancel').onclick = function() { bg.remove(); };
  document.getElementById('agSave').onclick = saveAddGuarantor;
  // Deploy 236.131 — start fetching clients immediately so the
  // suggestion dropdown can filter on the first keystroke (was
  // 236.130: only on email blur).
  _agPrimeClientsCache();
  var emailEl = document.getElementById('agEmail');
  emailEl.addEventListener('input', _agOnEmailInput);
  emailEl.addEventListener('blur', function() {
    // Delay so a click on a suggestion fires first.
    setTimeout(_agHideSuggest, 180);
    _agConfirmExactMatch();
  });
  emailEl.addEventListener('keydown', _agSuggestKeydown);
  // Click-outside closes the dropdown (delegated on the modal bg).
  bg.addEventListener('click', function(e) {
    if (!e.target.closest('.ag-email-wrap')) _agHideSuggest();
  }, true);
  setTimeout(function() { try { emailEl.focus(); } catch (_) {} }, 50);
}

function _agPrimeClientsCache() {
  if (_agAllClientsCache) return;
  var p = SLA.isStaff(_user) ? SLA.Clients.list({ all: true, summary: true }) : SLA.Clients.list({ summary: true }); // Deploy 236.266
  p.then(function(r) {
    var pool = [];
    if (r && r.byOwner) {
      Object.keys(r.byOwner).forEach(function(k) { (r.byOwner[k] || []).forEach(function(c) { pool.push(c); }); });
    } else {
      pool = (r && r.clients) || [];
    }
    _agAllClientsCache = pool;
  }).catch(function() { /* silent */ });
}

// Filter the cached client list for the typed query (matches email,
// first name, last name — case-insensitive substring). Renders up to
// 5 rows in #agSuggest with click + keyboard handlers.
function _agOnEmailInput(e) {
  var q = String((e && e.target && e.target.value) || '').toLowerCase().trim();
  var box = document.getElementById('agSuggest');
  if (!box) return;
  // Clear the prior "exact match" green pill if user is still typing.
  var matchBox = document.getElementById('agMatch');
  if (matchBox && _agExistingMatch && q !== String(_agExistingMatch.client.email || '').toLowerCase()) {
    matchBox.classList.remove('show');
    matchBox.innerHTML = '';
    _agExistingMatch = null;
  }
  if (!q || q.length < 2 || !_agAllClientsCache) {
    _agHideSuggest();
    return;
  }
  var pool = _agAllClientsCache;
  var matches = pool.filter(function(c) {
    if (!c) return false;
    var em = String(c.email || '').toLowerCase();
    var nm = (String(c.firstName || '') + ' ' + String(c.lastName || '')).toLowerCase();
    return em.indexOf(q) >= 0 || nm.indexOf(q) >= 0;
  }).slice(0, 6);
  if (!matches.length) {
    box.innerHTML = '<div class="ag-suggest-empty">No matching contacts — this will create a new one on save.</div>';
    box.classList.add('show');
    return;
  }
  box.innerHTML = matches.map(function(c, i) {
    var name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email;
    return '<div class="ag-suggest-row" data-i="' + i + '" data-cid="' + escAttr(c.id || '') + '">' +
      '<div class="ag-suggest-name">' + escH(name) + '</div>' +
      '<div class="ag-suggest-meta">' + escH(c.email || '') +
        (c.phone ? ' · ' + escH(c.phone) : '') +
        (c.entityName ? ' · ' + escH(c.entityName) : '') +
      '</div>' +
    '</div>';
  }).join('');
  // Wire click handlers — capture matches[i] by id since DOM-stored
  // dataset only carries strings.
  box.querySelectorAll('.ag-suggest-row').forEach(function(row) {
    row.onclick = function() {
      var idx = parseInt(row.dataset.i, 10);
      var picked = matches[idx];
      if (picked) _agPickContact(picked);
    };
  });
  box.classList.add('show');
}

function _agSuggestKeydown(e) {
  var box = document.getElementById('agSuggest');
  if (!box || !box.classList.contains('show')) return;
  var rows = Array.prototype.slice.call(box.querySelectorAll('.ag-suggest-row'));
  if (!rows.length) return;
  var focusedIdx = rows.findIndex(function(r) { return r.classList.contains('focused'); });
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (focusedIdx >= 0) rows[focusedIdx].classList.remove('focused');
    var next = (focusedIdx + 1) % rows.length;
    rows[next].classList.add('focused');
    rows[next].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (focusedIdx >= 0) rows[focusedIdx].classList.remove('focused');
    var prev = (focusedIdx <= 0 ? rows.length : focusedIdx) - 1;
    rows[prev].classList.add('focused');
    rows[prev].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && focusedIdx >= 0) {
    e.preventDefault();
    rows[focusedIdx].click();
  } else if (e.key === 'Escape') {
    _agHideSuggest();
  }
}

function _agHideSuggest() {
  var box = document.getElementById('agSuggest');
  if (box) box.classList.remove('show');
}

function _agPickContact(c) {
  function setVal(id, v) { var el = document.getElementById(id); if (el) el.value = v || ''; }
  setVal('agEmail',     c.email);
  setVal('agFirstName', c.firstName);
  setVal('agLastName',  c.lastName);
  setVal('agPhone',     c.phone);
  _agExistingMatch = { client: c };
  var matchBox = document.getElementById('agMatch');
  if (matchBox) {
    matchBox.innerHTML =
      '✓ <strong>Linked to existing contact:</strong> ' +
      escH(((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email) +
      '. This guarantor will reuse that contact record.';
    matchBox.classList.add('show');
  }
  _agHideSuggest();
  // Move focus to ownership so the LO can finish.
  var own = document.getElementById('agOwnership');
  if (own) try { own.focus(); } catch (_) {}
}

// Called on blur — if the typed email is an exact match to a
// cached client AND the user hasn't already picked a suggestion,
// auto-confirm the match (mirrors the prior 236.130 behavior).
function _agConfirmExactMatch() {
  if (_agExistingMatch) return; // already picked
  var emailEl = document.getElementById('agEmail');
  if (!emailEl || !_agAllClientsCache) return;
  var email = String(emailEl.value || '').toLowerCase().trim();
  if (!email || email.indexOf('@') < 0) return;
  var match = _agAllClientsCache.find(function(c) {
    return c && String(c.email || '').toLowerCase().trim() === email;
  });
  if (match) _agPickContact(match);
}

function saveAddGuarantor() {
  var btn = document.getElementById('agSave');
  var err = document.getElementById('agErr');
  err.classList.remove('show'); err.textContent = '';
  function v(id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
  var email = v('agEmail').toLowerCase();
  var firstName = v('agFirstName');
  var lastName = v('agLastName');
  var phone = v('agPhone');
  var ownershipRaw = v('agOwnership');
  if (!email)     { err.textContent = 'Email is required.'; err.classList.add('show'); return; }
  if (!firstName) { err.textContent = 'First name is required.'; err.classList.add('show'); return; }
  if (!lastName)  { err.textContent = 'Last name is required.'; err.classList.add('show'); return; }
  var ownershipPct = null;
  if (ownershipRaw !== '') {
    var n = parseFloat(ownershipRaw);
    if (!isFinite(n) || n < 0 || n > 100) { err.textContent = 'Ownership must be 0-100.'; err.classList.add('show'); return; }
    ownershipPct = n;
  }
  btn.disabled = true; btn.textContent = 'Adding…';
  var payload = {
    clientId: _clientId,
    loanId:   _loanId,
    guarantor: { email, firstName, lastName, phone, ownershipPct },
  };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-add-guarantor', payload).then(function(r) {
    if (!r || !r.loan) {
      btn.disabled = false; btn.textContent = 'Add Guarantor';
      err.textContent = 'Server did not return the updated loan.'; err.classList.add('show'); return;
    }
    _loan = r.loan;
    var lidx = (_client && _client.loans || []).findIndex(function(x) { return x && x.id === _loanId; });
    if (lidx >= 0) _client.loans[lidx] = r.loan;
    var bg = document.getElementById('agModalBg');
    if (bg) bg.remove();
    _agAllClientsCache = null; // invalidate so subsequent opens re-scan
    render(); // re-render full page so the new tab + sub-form card appear
  }).catch(function(e) {
    btn.disabled = false; btn.textContent = 'Add Guarantor';
    err.textContent = 'Failed: ' + (e && e.message || 'unknown'); err.classList.add('show');
  });
}

function copySubFormLink(btn, token) {
  var url = window.location.origin + '/guarantor-subform.html?t=' + encodeURIComponent(token);
  var done = function() {
    var orig = btn.textContent;
    btn.classList.add('copied');
    btn.textContent = 'Copied ✓';
    setTimeout(function() { btn.classList.remove('copied'); btn.textContent = orig; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(done);
  } else {
    // Fallback — select the adjacent input + execCommand.
    var input = btn.parentElement.querySelector('.sf-url-input');
    if (input) { input.select(); try { document.execCommand('copy'); } catch (_) {} }
    done();
  }
}

// Sum every guarantor's recorded ownership. Returns { total, count,
// any } so the banner logic can distinguish "no data yet" (don't
// nag) from "data entered but doesn't add up to 51%".
function _computeOwnershipTotal() {
  var ownerships = (_loan && _loan.guarantorOwnership && typeof _loan.guarantorOwnership === 'object') ? _loan.guarantorOwnership : {};
  var keys = Object.keys(ownerships);
  var total = 0;
  keys.forEach(function(k) {
    var n = parseFloat(ownerships[k]);
    if (isFinite(n)) total += n;
  });
  return { total: total, count: keys.length, any: keys.length > 0 };
}

function refreshGuarantorDocsBanner() {
  var slot = document.getElementById('ldTopBanners');
  if (!slot) return;
  var existing = slot.querySelector('.ld-warning-banner[data-banner="gdocs"]');
  if (existing) existing.remove();
  var updatedAt = _loan && _loan._guarantorDocsUpdatedAt;
  if (!updatedAt) return;
  var banner = document.createElement('div');
  banner.className = 'ld-warning-banner';
  banner.setAttribute('data-banner', 'gdocs');
  // Style as informational (gold) rather than warning (orange) so it
  // doesn't look like an error — it's just a heads-up.
  banner.style.background = 'rgba(200,129,58,0.08)';
  banner.style.borderColor = 'rgba(200,129,58,0.30)';
  banner.style.color = 'var(--gold-mid, #b5712d)';
  banner.innerHTML =
    '<span class="ld-warning-icon">📄</span>' +
    '<div>' +
      '<strong>Guarantor sub-form updated</strong> — a guarantor submitted (or updated) their sub-form on ' +
      escH(new Date(updatedAt).toLocaleString()) +
      '. Their signed Credit Authorization is in the Contacts tab. ' +
      'If you\'ve already generated the main loan application, re-generate it to include the latest guarantor data.' +
    '</div>';
  slot.appendChild(banner);
}

// Deploy 236.767 (Mike) — BPO reprice notice at the top of Loan Details. Two
// triggers, either of which means the deal no longer prices the way it was
// quoted: (1) the BPO's as-is value came in BELOW the purchase price, or
// (2) BPO LTARV is over this loan's program max LTARV. RTL/GUC only — DSCR
// loans get an appraisal, not a BPO.
function refreshBpoRepriceBanner() {
  var slot = document.getElementById('ldTopBanners');
  if (!slot) return;
  var existing = slot.querySelector('.ld-warning-banner[data-banner="bpo-reprice"]');
  if (existing) existing.remove();

  var l = _loan;
  if (!l || _isDscrTool(l.toolType)) return;
  function n(v) { return parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; }
  var aiv = n(l.aivBpo), arvB = n(l.arvBpo), pp = n(l.purchasePrice), amt = n(l.loanAmt);

  var reasons = [];
  if (aiv > 0 && pp > 0 && aiv < pp) {
    reasons.push('the BPO as-is value (' + fmtM(aiv) + ') came in below the purchase price (' + fmtM(pp) + ')');
  }
  var maxL = _ldMaxLtarvPct(l, l.fico, l.experience);
  if (arvB > 0 && amt > 0 && maxL > 0) {
    var pct = amt / arvB * 100;
    if (pct > maxL + 0.05) {
      reasons.push('BPO LTARV is ' + pct.toFixed(1) + '%, over the ' + maxL.toFixed(0) + '% program max');
    }
  }
  if (!reasons.length) return;

  var banner = document.createElement('div');
  banner.className = 'ld-warning-banner';
  banner.setAttribute('data-banner', 'bpo-reprice');
  banner.style.background  = 'rgba(124,31,31,0.10)';
  banner.style.borderColor = 'rgba(124,31,31,0.40)';
  banner.style.color       = 'var(--danger, #7c1f1f)';
  banner.innerHTML =
    '<span class="ld-warning-icon">⛔</span>' +
    '<div>' +
      '<strong>This loan needs to be repriced due to the BPO</strong> — ' +
      reasons.join(', and ') + '. Re-run the sizer against the BPO values before this loan moves forward.' +
    '</div>';
  slot.appendChild(banner);
}

function refreshOwnershipBanner() {
  var slot = document.getElementById('ldTopBanners');
  if (!slot) return;
  // Remove just our banner — leaves any future banners other code
  // might inject into the same slot alone.
  var existing = slot.querySelector('.ld-warning-banner[data-banner="ownership"]');
  if (existing) existing.remove();

  var info = _computeOwnershipTotal();
  if (!info.any) return;        // no data entered yet — don't nag
  // Deploy 236.130 — flag two states:
  //   total < 51   → "Check Guarantor Ownership %" (incomplete; orange)
  //   total > 100  → "Ownership exceeds 100%" (impossible; red, stronger)
  // total in [51, 100] is healthy — no banner.
  var banner = document.createElement('div');
  banner.className = 'ld-warning-banner';
  banner.setAttribute('data-banner', 'ownership');
  if (info.total > 100) {
    banner.style.background  = 'rgba(124,31,31,0.10)';
    banner.style.borderColor = 'rgba(124,31,31,0.40)';
    banner.style.color       = 'var(--danger, #7c1f1f)';
    banner.innerHTML =
      '<span class="ld-warning-icon">⛔</span>' +
      '<div>' +
        '<strong>Guarantor ownership exceeds 100%</strong> — recorded total is ' +
        info.total.toFixed(2) + '% across ' + info.count + ' guarantor' + (info.count === 1 ? '' : 's') +
        '. This is impossible by definition; double-check each guarantor\'s % in the Contacts tab.' +
      '</div>';
    slot.appendChild(banner);
    return;
  }
  if (info.total >= 51) return; // healthy
  banner.innerHTML =
    '<span class="ld-warning-icon">⚠</span>' +
    '<div>' +
      '<strong>Check Guarantor Ownership %</strong> — recorded total is ' +
      info.total.toFixed(2) + '% across ' + info.count + ' guarantor' + (info.count === 1 ? '' : 's') +
      '. Diya requires combined ownership of <strong>51% or more</strong>. ' +
      'Open the Contacts tab → Guarantor Info to add ownership for additional guarantors.' +
    '</div>';
  slot.appendChild(banner);
}

// ════════════════════════════════════════════════════════════════════
// Deploy 236.118 — Loan Details TABS: switcher, hash sync, helpers
// ════════════════════════════════════════════════════════════════════
function switchLdTab(name, skipHash) {
  // Deploy 236.602 — if the requested tab isn't present (e.g. a processing-only
  // tab requested via a stale #hash on a pre-processing loan), fall back to Loan
  // so we never blank the pane area.
  if (!document.querySelector('.ld-tab[data-ld-tab="' + name + '"]')) name = 'loan';
  document.querySelectorAll('.ld-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.ldTab === name);
  });
  document.querySelectorAll('.ld-pane').forEach(function(p) {
    p.classList.toggle('active', p.dataset.ldPane === name);
  });
  // Deploy 236.721 — Draws pane loads its Sitewire data lazily on first open.
  if (name === 'draws') ldDrawsLoad(false);
  if (!skipHash) {
    try {
      var url = new URL(window.location.href);
      url.hash = name;
      history.replaceState(null, '', url.toString());
    } catch (_) { /* IE/older — ignore */ }
  }
}

// ── Deploy 236.721 — Draws tab (Sitewire) ──────────────────────────
// Mirrors the Closed Loans Draws tab for a single loan: budget rollup +
// per-draw rows with the wire-sent / reimbursement annotations, and the
// Dutch vs Non-Dutch UPB math (Deploy 236.710). Data comes from the same
// /api/sitewire-draws proxy, joined by slaDisplayId == Sitewire loan_number.
var _ldDrawsState = '';   // '' | 'loading' | 'ready' | 'error'
var _ldDrawsData  = null; // this loan's Sitewire entry (or null = no match)
var _ldDrawsErr   = '';
var LD_SW_STATUS = { drafting:'Drafting', pending_borrower:'Awaiting Borrower', inspecting:'Inspecting',
  pending:'Pending Lender', pending_capital_partner:'Awaiting Capital Partner', approved:'Approved' };
function _ldDrawsNum(v){ var n = parseFloat(String(v==null?'':v).replace(/[$,]/g,'')); return isFinite(n)?n:0; }
function _ldDrawsMoney(cents){ return '$' + Math.round(cents/100).toLocaleString(); }
function ldDrawsLoad(force){
  var pane = document.getElementById('ldPaneDraws');
  if (!pane || _ldDrawsState === 'loading') return;
  if (_ldDrawsState === 'ready' && !force) { ldDrawsRender(); return; }
  var num = String((_loan && _loan.slaDisplayId) || (_loan && _deriveSlaLoanIdClient(_loan)) || '').trim().toUpperCase();
  if (!num) { _ldDrawsState = 'error'; _ldDrawsErr = 'This loan has no SLA loan number to match against Sitewire.'; ldDrawsRender(); return; }
  _ldDrawsState = 'loading'; _ldDrawsErr = '';
  ldDrawsRender();
  SLA.Sitewire.draws([num], !!force).then(function(r){
    _ldDrawsData = (r && r.byLoanNumber && r.byLoanNumber[num]) || null;
    _ldDrawsState = 'ready';
    ldDrawsRender();
  }).catch(function(e){
    _ldDrawsState = 'error'; _ldDrawsErr = (e && e.message) || 'unknown error';
    ldDrawsRender();
  });
}
function ldDrawsRender(){
  var pane = document.getElementById('ldPaneDraws'); if (!pane) return;
  var l = _loan || {};
  var h = '<div class="section"><div class="section-head"><h2>Draws</h2>' +
    '<span class="section-tag">Sitewire</span>' +
    (_ldDrawsState==='ready' ? '<a href="#" style="margin-left:auto;font-size:12px" onclick="ldDrawsLoad(true);return false">Refresh</a>' : '') +
    '</div><div class="section-body">';
  if (_ldDrawsState === 'loading' || _ldDrawsState === '') {
    h += '<div style="color:var(--muted);padding:16px 0">Loading draw data from Sitewire…</div>';
  } else if (_ldDrawsState === 'error') {
    h += '<div style="color:var(--danger)">Failed to load draw data: ' + escH(_ldDrawsErr) +
      ' <a href="#" onclick="ldDrawsLoad(true);return false">Retry</a></div>';
  } else if (!_ldDrawsData) {
    h += '<div style="color:var(--muted)">No Sitewire property matches this loan’s number (' +
      escH(l.slaDisplayId || '') + '). Draws appear here once the property exists in Sitewire with the SLA loan number on it.</div>';
  } else {
    var e = _ldDrawsData;
    // Deploy 236.762 — GUC loans default NON-Dutch (matches the Loan Terms
    // editor's 236.713 default; GUC only offers as-drawn interest). The
    // blanket 'dutch' default overstated an unsaved GUC loan's UPB by the
    // whole undrawn budget.
    var isDutch = String(l.dutchInterest || (_isGucLoan(l) ? 'non_dutch' : 'dutch')).toLowerCase() !== 'non_dutch';
    var total = _ldDrawsNum(l.finalLoanAmount) || _ldDrawsNum(l.loanAmt);
    var initAdv = (total > 0) ? Math.max(0, total - (e.budget.budgetedCents||0)/100) : null;
    var upb = isDutch ? total : (initAdv != null ? initAdv + (e.budget.approvedCents||0)/100 : null);
    // Rollup tiles
    function tile(label, val){ return '<div style="flex:1;min-width:150px;background:var(--bg,#f7f4ee);border:1px solid var(--border);border-radius:8px;padding:12px 14px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:4px">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:600">' + val + '</div></div>'; }
    h += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
      tile('Construction Budget', _ldDrawsMoney(e.budget.budgetedCents||0)) +
      tile('Total Drawn', _ldDrawsMoney(e.budget.approvedCents||0)) +
      tile('Remaining Budget', _ldDrawsMoney(e.budget.balanceCents||0)) +
      tile('Current UPB', (upb != null && upb > 0) ? ('$' + Math.round(upb).toLocaleString()) : '—') +
      '</div>';
    h += '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Interest structure: <strong>' +
      (isDutch ? 'Dutch' : 'Non-Dutch') + '</strong> — ' +
      (isDutch ? 'UPB is the full loan balance.' : 'UPB grows as draws are approved (initial advance + drawn funds).') +
      ' Change it in Loan Terms on the Loan tab.</div>';
    var ds = (e.draws || []).slice();
    if (!ds.length) {
      h += '<div style="color:var(--muted)">No draws on this property yet.</div>';
    } else {
      // Running UPB after each approved draw (Non-Dutch only), in number order.
      var runningById = {};
      if (!isDutch && initAdv != null) {
        var run = initAdv;
        ds.slice().sort(function(a,b){ return (a.number||0)-(b.number||0); }).forEach(function(d){
          if (d.status === 'approved') { run += (d.approvedCents||0)/100; runningById[String(d.id)] = run; }
        });
      }
      var staff = !!(window.SLA && _user && ((SLA.isAdmin && SLA.isAdmin(_user)) || (SLA.isProcessor && SLA.isProcessor(_user))));
      h += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
        ['Draw #','Last Updated','Requested','Approved','Status','Wire Sent','Reimb. Requested','UPB After Draw'].map(function(t){
          return '<th style="text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap">'+t+'</th>';
        }).join('') + '</tr></thead><tbody>' +
        ds.map(function(d, i){
          var td = function(inner){ return '<td style="padding:8px 12px;border-bottom:1px solid var(--border);white-space:nowrap">' + inner + '</td>'; };
          var dm = (l.drawMeta && l.drawMeta[String(d.id)]) || {};
          var dateStr = d.updatedAt ? String(d.updatedAt).slice(0,10) : '';
          var stLbl = LD_SW_STATUS[d.status] || (d.status || '—');
          var stCol = d.status === 'approved' ? '#1e7d3c' : '#9a6b00';
          var wireCell, reimbCell;
          if (staff && d.id != null) {
            wireCell = '<input type="date" value="' + escAttr(dm.wireSentDate||'') + '" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:12px;background:var(--surface,#fff)" onchange="ldDrawMetaSave(' + Number(d.id) + ',\'wireSentDate\',this)">';
            reimbCell = '<input type="checkbox" style="width:15px;height:15px;cursor:pointer;vertical-align:middle" ' + (dm.reimbursementRequested?'checked':'') + ' onchange="ldDrawMetaSave(' + Number(d.id) + ',\'reimbursementRequested\',this)">';
          } else {
            wireCell = dm.wireSentDate ? escH(dm.wireSentDate) : '—';
            reimbCell = dm.reimbursementRequested ? '<span style="color:#1e7d3c;font-weight:600">✓</span>' : '—';
          }
          var runVal = runningById[String(d.id)];
          return '<tr>' +
            td(String(d.number || (i+1)) + (d.historical ? ' <span style="color:var(--muted)">(hist)</span>' : '')) +
            td(escH(dateStr || '—')) +
            td(d.requestedCents > 0 ? _ldDrawsMoney(d.requestedCents) : '—') +
            td(d.approvedCents > 0 ? _ldDrawsMoney(d.approvedCents) : '—') +
            td('<span style="color:'+stCol+';font-weight:600">' + escH(stLbl) + '</span>') +
            td(wireCell) + td(reimbCell) +
            td(runVal != null ? ('$' + Math.round(runVal).toLocaleString()) : '—') +
          '</tr>';
        }).join('') + '</tbody></table></div>';
    }
  }
  h += '</div></div>';
  pane.innerHTML = h;
}
// Per-draw annotation save — same field contract as the Closed Loans Draws tab
// (loan.drawMeta[sitewireDrawId], staff-only endpoint).
function ldDrawMetaSave(drawId, field, el){
  var l = _loan; if (!l) return;
  if (!l.drawMeta) l.drawMeta = {};
  var id = String(drawId);
  if (!l.drawMeta[id]) l.drawMeta[id] = {};
  var prev = l.drawMeta[id][field];
  var val = (field === 'reimbursementRequested') ? !!el.checked : String(el.value || '');
  l.drawMeta[id][field] = val;
  var patch = {}; patch[field] = val;
  var dm = {}; dm[id] = patch;
  el.disabled = true;
  SLA.api('POST', '/api/loan-servicing-update', { clientId: _clientId, loanId: _loanId, owner: _ldOwnerOverride(), drawMeta: dm })
    .then(function(){ el.disabled = false; })
    .catch(function(e){
      l.drawMeta[id][field] = prev;
      el.disabled = false;
      if (field === 'reimbursementRequested') el.checked = !!prev; else el.value = prev || '';
      showToast('Save failed: ' + ((e && e.message) || 'unknown'));
    });
}

// Deploy 236.132 — derive the SLA-YYYYMMDD-NNNN id for a loan.
// Mirrors the server's deriveBaselineLoanId() in baseline-sync.mjs
// so the displayed id matches what Baseline sees. Date portion uses
// loan.fundingDate when set, else loan.createdAt, else today (so a
// fresh loan still has a meaningful display id before the close
// date is locked in). Suffix is a deterministic djb2 hash of the
// internal id mod 10000, zero-padded — same SLA loan always shows
// the same SLA-... value.
function _deriveSlaLoanIdClient(loan) {
  if (!loan) return '';
  var stamp;
  function compact(s) { return String(s || '').slice(0, 10).replace(/-/g, ''); }
  if (loan.fundingDate)      stamp = compact(loan.fundingDate);
  else if (loan.createdAt)   stamp = compact(loan.createdAt);
  else {
    var d = new Date();
    stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }
  if (!/^\d{8}$/.test(stamp)) {
    var d2 = new Date();
    stamp = d2.getFullYear() + String(d2.getMonth() + 1).padStart(2, '0') + String(d2.getDate()).padStart(2, '0');
  }
  var s = String(loan.id || '');
  var hash = 0;
  for (var i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  var num = Math.abs(hash) % 10000;
  return 'SLA-' + stamp + '-' + String(num).padStart(4, '0');
}

function copyLoanId(el, id) {
  if (!id) return;
  function flash() {
    el.classList.add('copied');
    var lbl = el.querySelector('.ld-loan-id-label');
    var orig = lbl ? lbl.textContent : '';
    if (lbl) lbl.textContent = 'Copied';
    setTimeout(function() {
      el.classList.remove('copied');
      if (lbl) lbl.textContent = orig || 'Loan ID';
    }, 1200);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(id).then(flash).catch(flash);
  } else {
    flash(); // user-select:all makes the chip already easy to copy
  }
}

// Build the Team Members section that appears at the bottom of
// the Contacts tab. Deploy 236.351 — Loan Officer is now an
// editable dropdown for admins (was read-only). Non-admins still
// see the LO's name, not the email. Reassignment fires
// SLA.Admin.assignLo → cross-owner move of the loan + email +
// in-app reminder to the new LO. On success the page reloads at
// the loan's new URL (moved loans get a new clientId under the
// new owner's namespace).
function _buildTeamMembersSection() {
  var lo = _loEmail || '';
  var isAdminUser = !!(window.SLA && SLA.isAdmin && SLA.isAdmin(_user));
  var section = document.createElement('div');
  section.className = 'section';
  section.id = 'teamMembersSection';
  // Populated async once users-directory lands (loName lookup + full
  // roster for the picker). Renders with the email as a fallback
  // so the section is never blank while the directory loads.
  var loCardId = 'teamLoCard_' + Math.random().toString(36).slice(2, 6);
  var loCard =
    '<div id="' + loCardId + '" class="team-member' + (lo ? '' : ' unassigned') + '">' +
      '<div class="tm-role">Loan Officer</div>' +
      '<div class="tm-name">' + escH(lo || 'Unassigned') + '</div>' +
    '</div>';
  // Deploy 236.662 — the processing team is now a role-tagged LIST (Processor /
  // Closer / Processing Manager) rendered below the LO card; staff add/remove.
  var canAssignProc = !!(window.SLA && SLA.isProcessor && SLA.isProcessor(_user));
  var procTeamId = 'procTeam_' + Math.random().toString(36).slice(2, 6);
  section.innerHTML =
    '<div class="section-head"><h2>Team Members</h2>' +
      '<span class="section-tag ' + (isAdminUser ? 'tag-editable' : 'tag-readonly') + '">' +
        (isAdminUser ? 'Editable' : 'Read Only') +
      '</span>' +
    '</div>' +
    '<div class="section-body">' +
      '<div class="team-members-grid">' + loCard + '</div>' +
      '<div id="' + procTeamId + '" class="proc-team" style="margin-top:14px"></div>' +
      (isAdminUser
        ? '<div style="font-size:11px;color:var(--muted);margin-top:10px;font-style:italic">Reassigning the LO transfers the loan + all its data (borrower info, quotes, documents) to the new LO and notifies them by email + in-app.</div>'
        : ''
      ) +
    '</div>';
  setTimeout(function() { _hydrateTeamLoCard(loCardId, isAdminUser); }, 0);
  setTimeout(function() { _hydrateTeamProc(procTeamId, canAssignProc); }, 0);
  return section;
}

// Deploy 236.662 — role-tagged processing team. A loan can carry multiple
// members (Processor / Closer / Processing Manager). Source of truth is
// _loan.assignedProcessors[]; falls back to the legacy single assignedProcessor.
var PROC_ROLES = [
  { value: 'processor', label: 'Processor' },
  { value: 'closer',    label: 'Closer' },
  { value: 'manager',   label: 'Processing Manager' },
];
function _procRoleLabel(r) {
  for (var i = 0; i < PROC_ROLES.length; i++) { if (PROC_ROLES[i].value === r) return PROC_ROLES[i].label; }
  return 'Processor';
}
function _loanProcessors() {
  if (_loan && Array.isArray(_loan.assignedProcessors)) return _loan.assignedProcessors;
  if (_loan && _loan.assignedProcessor && _loan.assignedProcessor.email) {
    return [{ email: _loan.assignedProcessor.email, name: _loan.assignedProcessor.name || _loan.assignedProcessor.email, role: 'processor' }];
  }
  return [];
}

// Render the Processing Team block. Staff (processor/admin/super_admin) get
// add/remove controls; everyone else sees a read-only list.
function _hydrateTeamProc(containerId, canAssign) {
  var el = document.getElementById(containerId);
  if (!el) return;
  window.__procTeamContainer = containerId;
  var team = _loanProcessors();
  var listHtml = team.length
    ? team.map(function (p) {
        var nm = p.name || p.email || 'Assigned';
        var role = p.role || 'processor';
        var badge = '<span class="proc-role-badge proc-role-' + escAttr(role) + '">' + escH(_procRoleLabel(role)) + '</span>';
        var rm = canAssign ? '<button type="button" class="proc-remove" title="Remove from loan" onclick="_procTeamRemove(\'' + escAttr(String(p.email || '')) + '\')">&times;</button>' : '';
        return '<div class="proc-chip"><span class="proc-chip-name">' + escH(nm) + '</span>' + badge + rm + '</div>';
      }).join('')
    : '<div class="proc-empty">No processing team assigned yet.</div>';

  var html = '<div class="proc-team-head">Processing Team</div>' +
             '<div class="proc-team-list">' + listHtml + '</div>';
  if (canAssign) {
    html +=
      '<div class="proc-add-row">' +
        '<select id="' + containerId + '_person" class="proc-add-sel"><option value="">— Add team member —</option></select>' +
        '<select id="' + containerId + '_role" class="proc-add-sel">' +
          PROC_ROLES.map(function (r) { return '<option value="' + r.value + '">' + r.label + '</option>'; }).join('') +
        '</select>' +
        '<button type="button" class="proc-add-btn" onclick="_procTeamAdd(\'' + containerId + '\')">Add</button>' +
      '</div>' +
      '<div id="' + containerId + '_status" class="proc-team-status"></div>';
  }
  el.innerHTML = html;

  if (canAssign && window.SLA && SLA.Users && SLA.Users.directory) {
    SLA.Users.directory().then(function (r) {
      var users = (r && r.users) || [];
      var procs = users.filter(function (u) {
        var roles = (u.roles || []).map(function (x) { return String(x).toLowerCase(); });
        return roles.indexOf('processor') >= 0 || roles.indexOf('admin') >= 0 || roles.indexOf('super_admin') >= 0;
      });
      var sel = document.getElementById(containerId + '_person');
      if (!sel) return;
      procs.forEach(function (u) {
        var email = String(u.email || '').trim(); if (!email) return;
        var name = String(u.name || '').trim();
        var opt = document.createElement('option');
        opt.value = email;
        opt.setAttribute('data-name', name || email);
        opt.textContent = (name && name.toLowerCase() !== email.toLowerCase()) ? (name + ' (' + email + ')') : email;
        sel.appendChild(opt);
      });
    }).catch(function (err) { console.warn('proc team roster load failed:', err && err.message); });
  }
}

function _procTeamPost(body, containerId) {
  if (!_loan || !_client) return;
  body.clientId = _client.id; body.loanId = _loanId;
  if (_loEmail) body.owner = _loEmail; // preserve owner-scope (admin/processor cross-LO)
  var statusEl = document.getElementById(containerId + '_status');
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'Saving…'; }
  SLA.api('POST', '/api/loan-assign-processor', body).then(function (resp) {
    _loan.assignedProcessors = (resp && resp.assignedProcessors) || [];
    _loan.assignedProcessor  = (resp && resp.assignedProcessor) || null;
    _hydrateTeamProc(containerId, true);
    if (typeof showToast === 'function') showToast('Processing team updated');
  }).catch(function (err) {
    var msg = (err && err.message) || 'error';
    if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Failed: ' + msg; }
    if (typeof showToast === 'function') showToast('Update failed: ' + msg);
  });
}
function _procTeamAdd(containerId) {
  var pSel = document.getElementById(containerId + '_person');
  var rSel = document.getElementById(containerId + '_role');
  var email = pSel && pSel.value ? String(pSel.value) : '';
  if (!email) { return; }
  var opt = pSel.options[pSel.selectedIndex];
  var name = (opt && opt.getAttribute('data-name')) || email;
  var role = (rSel && rSel.value) ? rSel.value : 'processor';
  _procTeamPost({ processorEmail: email, processorName: name, role: role }, containerId);
}
function _procTeamRemove(email) {
  var containerId = window.__procTeamContainer;
  if (!containerId) return;
  _procTeamPost({ removeProcessor: email }, containerId);
}

// Deploy 236.351 — swap the placeholder LO card for the real one
// once the directory lands. For admins we render a <select> of
// all LOs; changing it fires _reassignLo. For non-admins we just
// show the LO's name (not the email) and a small subtitle with
// the email.
function _hydrateTeamLoCard(cardId, isAdminUser) {
  if (!window.SLA || !SLA.Users || !SLA.Users.directory) return;
  var card = document.getElementById(cardId);
  if (!card) return;
  SLA.Users.directory().then(function(r) {
    var users = (r && r.users) || [];
    // Deploy 236.352 — every SLA staff account is a Loan Officer per
    // Mike (Users = LOs, Admins = Sales Leaders, Super Admins = Owners,
    // all of whom can own loans). The only accounts NOT eligible are
    // pure borrower portal users. Include everyone else — no-role,
    // 'lo', 'admin', 'super_admin', 'processor' all show up.
    var loCandidates = users.filter(function(u) {
      var roles = (u.roles || []).map(function(r){ return String(r).toLowerCase(); });
      if (!roles.length) return true;
      // Exclude accounts whose ONLY role is 'borrower' (external
      // portal users). If they have any other role, keep them.
      var nonBorrowerRoles = roles.filter(function(r){ return r !== 'borrower'; });
      return nonBorrowerRoles.length > 0;
    });
    var currentLoEmail = String(_loEmail || '').toLowerCase();
    var currentLo = null;
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].email).toLowerCase() === currentLoEmail) { currentLo = users[i]; break; }
    }
    var currentName = (currentLo && currentLo.name) || _loEmail || 'Unassigned';

    if (!isAdminUser) {
      // Read-only for non-admins: show name over email.
      card.innerHTML =
        '<div class="tm-role">Loan Officer</div>' +
        '<div class="tm-name">' + escH(currentName) + '</div>' +
        (currentLo && currentLo.email && currentName !== _loEmail
          ? '<div class="tm-sub" style="font-size:11px;color:var(--muted);margin-top:2px">' + escH(currentLo.email) + '</div>'
          : ''
        );
      return;
    }

    // Admin: render a dropdown. Options sorted by name (directory
    // already returns sorted). Include a header option showing the
    // current LO so the selected state is obvious.
    var opts = loCandidates.map(function(u) {
      var name  = String(u.name || '').trim();
      var email = String(u.email || '').trim();
      var isSel = email.toLowerCase() === currentLoEmail;
      // If the profile has a full name distinct from the email
      // localpart, show "Name (email)". Otherwise just the email
      // — avoids the awkward "user@x.com (user@x.com)" duplication.
      var label = name && name.toLowerCase() !== email.toLowerCase()
        ? name + ' (' + email + ')'
        : email;
      return '<option value="' + escAttr(email) + '"' + (isSel ? ' selected' : '') + '>' +
        escH(label) +
      '</option>';
    }).join('');
    // If the current LO isn't in the directory (deleted account, etc)
    // prepend a placeholder so the select doesn't jump.
    var currentInDir = loCandidates.some(function(u){
      return String(u.email).toLowerCase() === currentLoEmail;
    });
    if (!currentInDir && _loEmail) {
      opts = '<option value="' + escAttr(_loEmail) + '" selected>' +
        escH(_loEmail) + ' (not in directory)</option>' + opts;
    }

    card.innerHTML =
      '<div class="tm-role">Loan Officer</div>' +
      '<select id="teamLoSelect" ' +
        'style="width:100%;padding:6px 8px;font-size:13px;font-family:inherit;border:1px solid var(--border);border-radius:6px;background:#fff;color:var(--text);cursor:pointer;margin-top:2px" ' +
        'onchange="_onTeamLoChange(this)">' +
        opts +
      '</select>' +
      '<div id="teamLoStatus" style="font-size:11px;color:var(--muted);margin-top:4px;min-height:14px"></div>';
    card.dataset.currentLoEmail = _loEmail || '';
  }).catch(function(err) {
    console.warn('team LO hydrate failed:', err && err.message);
  });
}

// Fired when the admin picks a new LO from the dropdown. Confirms,
// calls SLA.Admin.assignLo, then redirects to the loan's new URL
// (the moved loan gets a new clientId under the new owner).
function _onTeamLoChange(sel) {
  var newEmail = sel && sel.value;
  var currentEmail = _loEmail || '';
  if (!newEmail || String(newEmail).toLowerCase() === String(currentEmail).toLowerCase()) return;
  // Pull display name from the selected option's label.
  var newLabel = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : newEmail;
  var currentLabel = '';
  for (var i = 0; i < sel.options.length; i++) {
    if (String(sel.options[i].value).toLowerCase() === String(currentEmail).toLowerCase()) {
      currentLabel = sel.options[i].text;
      break;
    }
  }
  var confirmMsg = 'Reassign this loan from ' + (currentLabel || currentEmail) +
    ' to ' + newLabel + '?\n\nAll of the loan\'s data (borrower info, quotes, documents) will move to the new LO. They\'ll get an email and in-app notification.';
  if (!confirm(confirmMsg)) {
    // Revert the dropdown to the current LO.
    for (var j = 0; j < sel.options.length; j++) {
      if (String(sel.options[j].value).toLowerCase() === String(currentEmail).toLowerCase()) {
        sel.selectedIndex = j;
        break;
      }
    }
    return;
  }
  var statusEl = document.getElementById('teamLoStatus');
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = 'Reassigning…'; }
  sel.disabled = true;

  // ownerKey passed to loan-assign-lo is expected keySafed — but
  // keySafe only replaces :/\ so an email round-trips unchanged
  // via that path. We pass _loEmail as-is.
  SLA.Admin.assignLo(_loEmail, _clientId, _loanId, newEmail).then(function(r) {
    if (statusEl) { statusEl.style.color = 'var(--success)'; statusEl.textContent = 'Reassigned ✓ Redirecting…'; }
    if (typeof showToast === 'function') showToast('Loan reassigned to ' + newLabel);
    // The loan lives under a new clientId in the new owner's namespace.
    // Redirect so the page reflects the correct URL + fresh data.
    setTimeout(function() {
      var newUrl = SLA.urls.loanDetails(r.loanId, { owner: r.newOwnerEmail });
      window.location.href = newUrl;
    }, 700);
  }).catch(function(err) {
    console.error('assignLo failed:', err);
    var msg = (err && err.message) || 'unknown error';
    if (statusEl) { statusEl.style.color = 'var(--danger)'; statusEl.textContent = 'Failed: ' + msg; }
    if (typeof showToast === 'function') showToast('Reassign failed: ' + msg);
    sel.disabled = false;
    // Revert the dropdown.
    for (var k = 0; k < sel.options.length; k++) {
      if (String(sel.options[k].value).toLowerCase() === String(currentEmail).toLowerCase()) {
        sel.selectedIndex = k;
        break;
      }
    }
  });
}

// Deploy 236.170 — Access Refactor PR #3. Section renders the
// current list of borrower emails granted portal access to this
// loan + an inline form to invite a new one. Grants + revokes go
// through SLA.BorrowerAccess (loan-access-grant / -revoke) which
// itself gates on canEditLoan. Invite triggers a Netlify Identity
// invitation email with role='borrower' pre-set.
function _buildBorrowerAccessSection() {
  var section = document.createElement('div');
  section.className = 'section';
  section.id = 'borrowerAccessSection';
  section.innerHTML =
    '<div class="section-head"><h2>Borrower Portal Access</h2><span class="section-tag tag-editable">Editable</span></div>' +
    '<div class="section-body">' +
      '<p style="font-size:12px;color:var(--muted);margin-bottom:12px;line-height:1.5">Invite the borrower or a guarantor to the SLA portal to view this loan and upload requested documents. They sign in with Google or a one-click email link — no password.</p>' +
      // Deploy 236.534 — Supabase invite with Borrower / Broker choice + a status
      // line (recipient · date sent · last sign-in). Same as the doc-review panel.
      '<div id="ldInviteStatus" style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.55;min-height:14px"></div>' +
      // Deploy 236.590 — borrower invites are gated until the loan is In
      // Processing (see _gateBorrowerInvites): before that there's no rate
      // sheet / signed application to review borrower uploads against, so a
      // premature invite lets docs show "looks good" with no point of truth.
      // The Broker invite is intentionally NOT gated.
      '<div id="ldInviteGateNote" style="display:none;font-size:11px;color:var(--gold-mid,#b5712d);margin-bottom:8px;line-height:1.5"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
        '<button type="button" id="ldInviteBorrowerBtn" class="vesting-llc-save-btn" onclick="ldInvite(\'borrower\')" style="white-space:nowrap">✉ Invite Borrower</button>' +
        (_ldHasBrokerEmail() ? '<button type="button" class="add-guarantor-btn" onclick="ldInvite(\'broker\')" style="white-space:nowrap">✉ Invite Broker</button>' : '') +
      '</div>' +
      '<div id="borrowerAccessList" style="margin-bottom:12px"><div style="font-size:12px;color:var(--muted);font-style:italic">Loading…</div></div>' +
      // Deploy 236.592 — invite a GUARANTOR from a dropdown (only people already
      // on the loan can be invited). "+ Add Guarantor" opens the existing modal;
      // the new guarantor then appears in this dropdown after render().
      '<div style="font-size:12px;color:var(--muted);margin-bottom:6px">Invite a guarantor to the portal:</div>' +
      '<div style="display:flex;gap:8px;align-items:stretch;flex-wrap:wrap">' +
        '<select id="borrowerAccessGuarantorSelect" style="flex:1;min-width:220px;padding:8px 12px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:\'DM Sans\',sans-serif;background:#fff"><option value="">Loading guarantors…</option></select>' +
        '<button type="button" id="borrowerAccessSendBtn" class="vesting-llc-save-btn" onclick="inviteBorrowerAccess()" style="white-space:nowrap">Send Invite</button>' +
        '<button type="button" class="add-guarantor-btn" onclick="openAddGuarantorModal()" style="white-space:nowrap">+ Add Guarantor</button>' +
      '</div>' +
      '<div id="borrowerAccessStatus" style="margin-top:10px;font-size:12px;min-height:14px"></div>' +
    '</div>';
  setTimeout(function() { refreshBorrowerAccessList(); ldLoadInviteStatus(); _populateGuarantorSelect(); _gateBorrowerInvites(); }, 0);
  return section;
}
// Deploy 236.590 — "In Processing" predicate. A loan has entered the
// processing pipeline once its status is 'approved' (the entry point both
// pipeline boards agree on) or it carries any processingStage value, and it
// STAYS true through close (per Mike — late document requests). 'submitted'
// / 'active' (pre-approval) are NOT in processing.
function isInProcessing(loan) {
  if (!loan) return false;
  var st = String(loan.status || '').toLowerCase().trim();
  if (st === 'approved' || st === 'closed') return true;
  var stage = String(loan.processingStage || '').toLowerCase().trim();
  return ['new_loan', 'processing', 'underwriting', 'pp_approved', 'pp_closed'].indexOf(stage) >= 0;
}
// Grey out the two BORROWER invite controls until the loan is In Processing.
// The Broker invite is left alone.
function _gateBorrowerInvites() {
  var ok = isInProcessing(_loan);
  var btn   = document.getElementById('ldInviteBorrowerBtn');
  var send  = document.getElementById('borrowerAccessSendBtn');
  var sel   = document.getElementById('borrowerAccessGuarantorSelect');
  var note  = document.getElementById('ldInviteGateNote');
  var tip = 'Available once the loan reaches In Processing (an approved rate sheet + application to review uploads against).';
  [btn, send].forEach(function(el) {
    if (!el) return;
    el.disabled = !ok;
    el.style.opacity = ok ? '' : '0.45';
    el.style.cursor = ok ? '' : 'not-allowed';
    el.title = ok ? '' : tip;
  });
  // The guarantor dropdown is gated too; the "+ Add Guarantor" button is NOT
  // (adding a guarantor isn't a portal invite, so it's allowed at any stage).
  if (sel) { sel.disabled = !ok; sel.title = ok ? '' : tip; }
  if (note) {
    note.style.display = ok ? 'none' : '';
    note.textContent = ok ? '' : '🔒 Borrower invites unlock once this loan is In Processing.';
  }
}
// Deploy 236.592 — populate the guarantor dropdown from the loan's
// guarantorClientIds, resolved to client name/email via SLA.Clients.list (same
// admin-aware pattern as refreshLinkedGuarantors). render() rebuilds this section
// after a guarantor is added, so a newly-added guarantor appears automatically.
function _populateGuarantorSelect() {
  var sel = document.getElementById('borrowerAccessGuarantorSelect');
  if (!sel || !_loan) return;
  var ids = Array.isArray(_loan.guarantorClientIds) ? _loan.guarantorClientIds : [];
  // Deploy 236.627 — the PRIMARY borrower/guarantor (the _client, shown as
  // "Guarantor 1 (Primary)" in the Guarantor Info box above) belongs in this
  // list too. Previously the dropdown listed ONLY the additional
  // guarantorClientIds, so a loan whose only guarantor is the primary read "No
  // guarantors on this loan" even though one was clearly displayed — Mike's bug.
  // The Send Invite handler accepts any email; the backend recognizes the
  // primary's email as the borrower grant, so inviting them here is the same as
  // the "Invite Borrower" button.
  var primaryOpt = '';
  if (_client && _client.email) {
    var pname = ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim() || _client.email;
    primaryOpt = '<option value="' + escAttr(_client.email) + '">' + escH(pname) + ' — ' + escH(_client.email) + ' (Primary)</option>';
  }
  if (!ids.length) {
    // No ADDITIONAL guarantors — still offer the primary if we have their email.
    sel.innerHTML = primaryOpt
      ? ('<option value="">Choose a guarantor to invite…</option>' + primaryOpt)
      : '<option value="">No guarantors on this loan yet — use “+ Add Guarantor” →</option>';
    _gateBorrowerInvites();
    return;
  }
  var p = SLA.isStaff(_user) ? SLA.Clients.list({ all: true, summary: true }) : SLA.Clients.list({ summary: true });
  p.then(function(r) {
    var pool = [];
    if (r && r.byOwner) {
      Object.keys(r.byOwner).forEach(function(k) { (r.byOwner[k] || []).forEach(function(c) { pool.push(c); }); });
    } else {
      pool = (r && r.clients) || [];
    }
    var byId = {};
    pool.forEach(function(c) { if (c && c.id) byId[c.id] = c; });
    var opts = ['<option value="">Choose a guarantor to invite…</option>'];
    var withEmail = 0;
    if (primaryOpt) { opts.push(primaryOpt); withEmail++; }
    ids.forEach(function(id) {
      if (_client && id === _client.id) return; // don't list the primary twice
      var c = byId[id];
      if (!c || !c.email) return;
      var name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email;
      opts.push('<option value="' + escAttr(c.email) + '">' + escH(name) + ' — ' + escH(c.email) + '</option>');
      withEmail++;
    });
    if (!withEmail) opts = ['<option value="">Guarantors on file have no email — edit them or add one →</option>'];
    sel.innerHTML = opts.join('');
    _gateBorrowerInvites(); // re-apply the In-Processing disabled state
  }).catch(function() {
    // Even if the additional-guarantor lookup fails, keep the primary invitable.
    sel.innerHTML = primaryOpt
      ? ('<option value="">Choose a guarantor to invite…</option>' + primaryOpt)
      : '<option value="">Could not load guarantors</option>';
    _gateBorrowerInvites();
  });
}
// Deploy 236.534 — Borrower/Broker portal invite (Supabase) + live status,
// mirroring the doc-review panel's dr_invite. Reuses /api/borrower-intake-invite.
function _ldHasBrokerEmail() {
  return !!(_loan && ((_loan.brokerEmail && String(_loan.brokerEmail).trim()) ||
    (_loan.formData && _loan.formData.brokerEmail && String(_loan.formData.brokerEmail).trim())));
}
function ldInvite(recipient) {
  if (!_client || !_loanId) { showToast('Loan not loaded.'); return; }
  // Deploy 236.590 — borrower invites are gated until In Processing; broker is not.
  if (recipient === 'borrower' && !isInProcessing(_loan)) {
    showToast('This loan must be In Processing before you can invite the borrower.');
    return;
  }
  var el = document.getElementById('ldInviteStatus');
  if (el) el.textContent = 'Sending invite…';
  var body = { loanId: _loanId, primaryClientId: _client.id, recipient: recipient };
  if (_loEmail && _user && _loEmail !== _user.email) body.owner = _loEmail;
  SLA.api('POST', '/api/borrower-intake-invite', body).then(function(r) {
    if (r && r.ok) { showToast('Invite sent to ' + (r.email || recipient)); ldLoadInviteStatus(); refreshBorrowerAccessList(); }
    else if (el) el.textContent = 'Invite failed.';
  }).catch(function(err) {
    if (el) el.textContent = 'Invite failed: ' + (err && err.message || 'unknown');
  });
}
function ldLoadInviteStatus() {
  var el = document.getElementById('ldInviteStatus'); if (!el || !_loanId) return;
  var url = '/api/borrower-intake-invite?loanId=' + encodeURIComponent(_loanId) +
    (_loEmail && _user && _loEmail !== _user.email ? '&owner=' + encodeURIComponent(_loEmail) : '');
  SLA.api('GET', url).then(function(st) { el.innerHTML = ldRenderInviteStatus(st); }).catch(function() { el.innerHTML = ''; });
}
function ldRenderInviteStatus(st) {
  var lines = [];
  ['borrower', 'broker'].forEach(function(who) {
    var e = st && st[who];
    if (!e || !e.email) return;
    var sent = e.sentAt ? new Date(e.sentAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
    var last = e.lastSignInAt
      ? new Date(e.lastSignInAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
      : '<span style="color:#b5712d;font-weight:600">not yet logged in</span>';
    lines.push('<span style="font-weight:600;color:var(--text,#1a1520)">' + (who === 'broker' ? 'Broker' : 'Borrower') + ':</span> ' +
      escH(e.email) + ' &middot; invited ' + sent + ' &middot; last login ' + last);
  });
  return lines.join('<br>');
}
function refreshBorrowerAccessList() {
  var listEl = document.getElementById('borrowerAccessList');
  if (!listEl || !window.SLA || !SLA.BorrowerAccess) return;
  SLA.BorrowerAccess.list({ loanId: _loanId }).then(function(r) {
    var grants = (r && r.grants) || [];
    if (!grants.length) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);font-style:italic">No borrowers have portal access yet.</div>';
      return;
    }
    listEl.innerHTML = grants.map(function(g) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:#fff">' +
        '<div style="min-width:0">' +
          '<div style="font-weight:500;font-size:13px;word-break:break-all">' + escH(g.email) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:\'DM Mono\',monospace;margin-top:2px">' + escH(g.role || 'borrower') + ' · granted ' + (g.grantedAt ? new Date(g.grantedAt).toLocaleDateString() : 'unknown') + '</div>' +
        '</div>' +
        '<button type="button" onclick="revokeBorrowerAccess(\'' + escAttr(g.email) + '\')" style="font-size:11px;color:var(--danger,#7c1f1f);background:transparent;border:1px solid rgba(124,31,31,0.20);border-radius:4px;padding:5px 10px;cursor:pointer">Revoke</button>' +
      '</div>';
    }).join('');
  }).catch(function(err) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--danger,#7c1f1f)">Failed to load: ' + escH(err && err.message || 'unknown') + '</div>';
  });
}
function inviteBorrowerAccess() {
  // Deploy 236.592 — invite a GUARANTOR chosen from the dropdown (only people
  // already on the loan). To invite someone new, add them via "+ Add Guarantor".
  var sel = document.getElementById('borrowerAccessGuarantorSelect');
  var status = document.getElementById('borrowerAccessStatus');
  if (!sel || !_client || !_loanId) return;
  // Deploy 236.590 — gated until In Processing (see _gateBorrowerInvites).
  if (!isInProcessing(_loan)) {
    status.style.color = 'var(--danger,#7c1f1f)';
    status.textContent = 'This loan must be In Processing before you can invite a borrower.';
    return;
  }
  var email = (sel.value || '').trim().toLowerCase();
  if (!email || email.indexOf('@') < 0) {
    status.style.color = 'var(--danger,#7c1f1f)';
    status.textContent = 'Choose a guarantor to invite (or use “+ Add Guarantor” to add one).';
    return;
  }
  status.style.color = 'var(--muted)';
  status.textContent = 'Sending invite…';
  var payload = { email: email, loanId: _loanId, primaryClientId: _client.id };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.BorrowerAccess.invite(payload).then(function(r) {
    sel.value = '';
    status.style.color = 'var(--success,#166534)';
    // Deploy 236.589 — borrower invites now use Supabase magic-link / Google
    // (no passwords). Copy updated to match; the endpoint emails a sign-in link.
    status.textContent = r.alreadyMember
      ? '✓ ' + email + ' already has an account — access granted and a sign-in link sent.'
      : '✓ Invitation sent to ' + email + '. They\'ll get a secure sign-in link (or can log in with Google).';
    refreshBorrowerAccessList();
  }).catch(function(err) {
    status.style.color = 'var(--danger,#7c1f1f)';
    status.textContent = 'Failed: ' + (err && err.message || 'unknown');
  });
}
function revokeBorrowerAccess(email) {
  if (!confirm('Revoke ' + email + '\'s access to this loan? They\'ll lose portal visibility immediately.')) return;
  var payload = { email: email, loanId: _loanId, primaryClientId: _client && _client.id };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.BorrowerAccess.revoke(payload).then(function() {
    refreshBorrowerAccessList();
    showToast('Access revoked.');
  }).catch(function(err) {
    showToast('Revoke failed: ' + (err && err.message || 'unknown'));
  });
}

// Deploy 236.120 — Documents tab now embeds the AI Loan Doc
// Review (loan-review-detail.html) via iframe in ?embed=1 mode.
// The legacy simple loan-docs system (categories + upload bar)
// from 236.119 stays in the codebase / backend but is no longer
// the primary Documents UI. Mike's call: "The whole AI Doc Review
// functionality should be moved into that Doc Review tab on the
// loan details page."
//
// Flow:
//   1. On Documents tab mount, fetch /api/loan-reviews
//   2. Find the review whose source.loanId matches this loan
//   3. If found: render an iframe to loan-review-detail.html?id=...&embed=1
//   4. If not: render "Start Document Review" CTA that calls
//      /api/loan-reviews-save to create one, then refreshes.
//   5. Non-processor users get a friendly message instead of the
//      403 propagating up — loan-reviews-list requires processor
//      or admin role.

function _buildDocumentsPlaceholder() {
  // Name preserved from Phase D.0 (the placeholder) so the call
  // site in relocateSectionsToTabs() keeps working without edit.
  var wrap = document.createElement('div');
  wrap.id = 'documentsRoot';
  wrap.innerHTML =
    '<div id="docsLoading" style="padding:2.5rem;text-align:center;color:var(--muted);font-style:italic;font-size:13px">Loading document review…</div>';
  setTimeout(_initDocReviewPane, 0); // run after the pane mounts
  return wrap;
}

function _initDocReviewPane() {
  // Role gate: loan-reviews-list requires processor or admin.
  // For LOs/other users, show a friendly message + open-in-new-tab
  // link to the standalone AI Doc Review page (which has its own
  // role gate and will show the same denial there).
  if (!(SLA && SLA.isProcessor && SLA.isProcessor(_user))) {
    _renderDocsPaneMessage(
      'Document Review is processor / admin only',
      'Ask a processor to open this loan’s Document Review. They’ll see the checklist of pending items here.',
      null
    );
    return;
  }
  // Find an existing review for this loan.
  SLA.api('GET', '/api/loan-reviews').then(function(resp) {
    var reviews = (resp && resp.reviews) || [];
    // loan-reviews-list trims the source field via summarize() — to
    // match by loanId we need to either include source in the list
    // response or fall back to filtering by address/loanAmount.
    // Phase 1 fix: just match by loanId or address.
    var match = reviews.find(function(r) {
      if (r.source && r.source.loanId === _loanId) return true;
      // Address match (case-insensitive, normalized whitespace).
      var a = String(r.address || '').trim().toLowerCase();
      var b = String((_loan && _loan.address) || '').trim().toLowerCase();
      return a && a === b;
    });
    if (match) {
      _renderDocReviewIframe(match.id);
    } else {
      _renderDocReviewStarter();
    }
  }).catch(function(err) {
    _renderDocsPaneMessage(
      'Failed to load Document Review',
      escH(err && err.message || 'unknown'),
      null
    );
  });
}

function _renderDocReviewIframe(reviewId) {
  // Deploy 236.121 — kept the function name for the call sites
  // but it now mounts the loan-doc-review.js module directly into
  // the Documents tab root (no iframe). The module brings its own
  // styles, modals, and toast. onDeleted callback returns the tab
  // to the "Start Document Review" empty state.
  var root = document.getElementById('documentsRoot');
  if (!root) return;
  if (!(window.SLA && window.SLA.DocReview && window.SLA.DocReview.mount)) {
    root.innerHTML = '<div class="ld-pane-empty"><span class="empty-title">Doc Review module didn\'t load</span>Check the network tab for loan-doc-review.js. Hard-refresh (Ctrl+Shift+R) usually fixes this.</div>';
    return;
  }
  SLA.DocReview.mount(root, {
    reviewId: reviewId,
    user: _user,
    onDeleted: function() {
      // After delete/finalize, swap back to the "Start Document
      // Review" empty state so the LO can create a fresh review.
      _initDocReviewPane();
    },
  });
}

function _renderDocReviewStarter() {
  // No review exists yet — let the processor create one with one click.
  // Deploy 236.702 — GUC now has its own checklist (RTL/Colchis + construction
  // docs), so a GUC loan creates a 'guc' review; RTL stays 'rtl'; else 'dscr'.
  var _tt = String((_loan && _loan.toolType) || '').toLowerCase();
  var loanType = (_tt === 'guc') ? 'guc' : (_tt === 'rtl') ? 'rtl' : 'dscr';
  var root = document.getElementById('documentsRoot');
  if (!root) return;
  root.innerHTML =
    '<div class="ld-pane-empty">' +
      '<span class="empty-title">No Document Review yet</span>' +
      'Start a Document Review to see the checklist of items needed for this loan.<br>' +
      'Each item gets its own upload tray and AI-assisted verdict.' +
      '<button type="button" class="empty-link" id="startReviewBtn" style="cursor:pointer;border:none">Start Document Review</button>' +
    '</div>';
  document.getElementById('startReviewBtn').onclick = function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Creating…';
    SLA.api('POST', '/api/loan-reviews-save', {
      loanType: loanType,
      source: {
        kind:     'existing',
        clientId: _client.id,
        loanId:   _loanId,
        ownerKey: _loEmail || (_user && _user.email) || '',
      },
      address:           (_loan && _loan.address) || '',
      borrowerName:      ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim(),
      loanAmount:        (_loan && _loan.loanAmt) || 0,
      loEmail:           _loEmail || (_user && _user.email) || '',
      expectedCloseDate: (_loan && _loan.expectedCloseDate) || '',
    }).then(function(resp) {
      var newId = resp && resp.review && resp.review.id;
      if (!newId) throw new Error('Server did not return a review id');
      _renderDocReviewIframe(newId);
    }).catch(function(err) {
      btn.disabled = false;
      btn.textContent = 'Start Document Review';
      showToast('Could not start review: ' + (err && err.message || 'unknown'));
    });
  };
}

function _renderDocsPaneMessage(title, body, button) {
  var root = document.getElementById('documentsRoot');
  if (!root) return;
  root.innerHTML =
    '<div class="ld-pane-empty">' +
      '<span class="empty-title">' + escH(title) + '</span>' + body +
      (button ? button : '') +
    '</div>';
}

function loadDocsList() {
  var url = '/api/loan-docs-list?loanId=' + encodeURIComponent(_loanId) +
            (_loEmail && _user && _loEmail !== _user.email
              ? '&owner=' + encodeURIComponent(_loEmail) : '');
  SLA.api('GET', url).then(function(r) {
    _docs = (r && r.docs) || [];
    renderDocsList();
  }).catch(function(err) {
    var w = document.getElementById('docsListWrap');
    if (w) w.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--danger,#7c1f1f);font-size:13px">Failed to load: ' + escH(err && err.message || 'unknown') + '</div>';
  });
}

function renderDocsList() {
  var w = document.getElementById('docsListWrap');
  if (!w) return;
  if (!_docs.length) {
    w.innerHTML = '<div style="padding:2.5rem;text-align:center;color:var(--muted);font-style:italic;font-size:13px">No documents uploaded yet. Pick a category and click Choose File above.</div>';
    return;
  }
  var byCat = {};
  _docs.forEach(function(d) {
    var k = String(d.category || 'other');
    (byCat[k] = byCat[k] || []).push(d);
  });
  var html = '';
  DOC_CATEGORIES.forEach(function(c) {
    var arr = byCat[c.key] || [];
    if (!arr.length) return;
    html += '<div style="margin-bottom:22px">' +
      '<h3 style="font-family:Lora,serif;font-size:15px;font-weight:600;margin-bottom:8px;color:var(--dark,#261a36)">' + escH(c.label) +
      ' <span style="font-family:DM Mono,monospace;font-size:11px;color:var(--muted);font-weight:500">(' + arr.length + ')</span></h3>' +
      arr.map(_renderDocRow).join('') +
    '</div>';
  });
  // Forward-compat for any custom category keys.
  Object.keys(byCat).forEach(function(k) {
    if (DOC_CATEGORIES.some(function(c) { return c.key === k; })) return;
    html += '<div style="margin-bottom:22px"><h3 style="font-family:Lora,serif;font-size:15px;font-weight:600;margin-bottom:8px">' + escH(k) + '</h3>' + byCat[k].map(_renderDocRow).join('') + '</div>';
  });
  w.innerHTML = html;
}

function _renderDocRow(d) {
  var sizeKb = Math.max(1, Math.round((d.sizeBytes || 0) / 1024));
  var when = d.uploadedAt ? new Date(d.uploadedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  var ownerQuery = (_loEmail && _user && _loEmail !== _user.email)
    ? '&owner=' + encodeURIComponent(_loEmail) : '';
  var viewUrl = '/api/loan-docs-get?id=' + encodeURIComponent(d.id) + ownerQuery;
  var dlUrl   = viewUrl + '&download=1';
  return '<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:10px;align-items:center;padding:10px 14px;border:1px solid var(--border,#ddd8d0);border-radius:6px;margin-bottom:6px;background:#fff">' +
    '<div style="min-width:0">' +
      '<div style="font-weight:500;font-size:13px;word-break:break-all">' + escH(d.filename) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);font-family:DM Mono,monospace;margin-top:2px">' + sizeKb.toLocaleString() + ' KB · ' + escH(d.mimeType || '') + ' · ' + escH(when) + ' by ' + escH(d.uploadedByName || d.uploadedBy || '?') + '</div>' +
      (d.notes ? '<div style="font-size:12px;color:var(--text);margin-top:4px;font-style:italic">' + escH(d.notes) + '</div>' : '') +
    '</div>' +
    '<a href="' + escAttr(viewUrl) + '" target="_blank" rel="noopener" style="font-size:11px;color:var(--gold-mid,#b5712d);text-decoration:none;padding:5px 10px;border:1px solid var(--gold-border,rgba(200,129,58,0.28));border-radius:4px" title="Open in new tab">View</a>' +
    '<a href="' + escAttr(dlUrl) + '" style="font-size:11px;color:var(--gold-mid,#b5712d);text-decoration:none;padding:5px 10px;border:1px solid var(--gold-border,rgba(200,129,58,0.28));border-radius:4px" title="Download">Download</a>' +
    '<button type="button" onclick="deleteDoc(\'' + escAttr(d.id) + '\')" style="font-size:11px;color:var(--danger,#7c1f1f);background:transparent;border:1px solid rgba(124,31,31,0.20);border-radius:4px;padding:5px 9px;cursor:pointer" title="Delete">✕</button>' +
  '</div>';
}

function onDocFileChosen(input) {
  var file = input && input.files && input.files[0];
  if (!file) return;
  var category = (document.getElementById('docCategorySelect') || {}).value || 'other';
  var status = document.getElementById('docUploadStatus');
  status.textContent = 'Encoding ' + file.name + '…';
  status.style.color = 'var(--muted)';
  var reader = new FileReader();
  reader.onload = function() {
    var b64 = String(reader.result || '');
    var comma = b64.indexOf(',');
    if (comma >= 0) b64 = b64.slice(comma + 1);
    status.textContent = 'Uploading ' + file.name + '…';
    SLA.api('POST', '/api/loan-docs-upload', {
      clientId: _client.id,
      loanId:   _loanId,
      category: category,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      contentBase64: b64,
      owner: (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : undefined,
    }).then(function(r) {
      status.textContent = 'Uploaded ✓';
      status.style.color = 'var(--success, #256940)';
      if (r && r.doc) _docs.unshift(r.doc);
      renderDocsList();
      input.value = '';
      setTimeout(function() { status.textContent = ''; }, 2500);
    }).catch(function(err) {
      status.textContent = 'Upload failed: ' + (err && err.message || 'unknown');
      status.style.color = 'var(--danger, #7c1f1f)';
      input.value = '';
    });
  };
  reader.onerror = function() {
    status.textContent = 'Could not read file.';
    status.style.color = 'var(--danger, #7c1f1f)';
  };
  reader.readAsDataURL(file);
}

function deleteDoc(id) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  var idx = _docs.findIndex(function(d) { return d.id === id; });
  if (idx < 0) return;
  var removed = _docs.splice(idx, 1)[0];
  renderDocsList();
  SLA.api('POST', '/api/loan-docs-delete', {
    id: id,
    owner: (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : undefined,
  }).catch(function(err) {
    _docs.splice(idx, 0, removed);
    renderDocsList();
    showToast('Failed to delete: ' + (err && err.message || 'unknown'));
  });
}

// ── Deploy 236.726 — Tasks modal ───────────────────────────────────
// The Tasks tab became a modal (too many tabs). relocateSectionsToTabs
// hands the live #tasksSection node to _buildTasksModal, which wraps it
// in a fixed overlay appended to <body>; open/close just toggle display.
function _buildTasksModal(sect) {
  // Deploy 236.762 — render() runs several times per visit (cached paint,
  // fresh fetch, post-save repaints) and each run built a NEW body-appended
  // overlay with the same id, leaking duplicate task DOMs. Reuse-by-removal.
  var stale = document.getElementById('ldTasksModal');
  if (stale) stale.remove();
  var ov = document.createElement('div');
  ov.id = 'ldTasksModal';
  ov.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(30,25,18,0.45);z-index:1200;overflow:auto;padding:48px 16px;';
  ov.onclick = function(e){ if (e.target === ov) closeTasksModal(); };
  var box = document.createElement('div');
  box.style.cssText = 'max-width:760px;margin:0 auto;background:var(--surface, #fff);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.25);padding:8px 20px 20px;position:relative';
  var x = document.createElement('button');
  x.type = 'button';
  x.innerHTML = '&times;';
  x.title = 'Close';
  x.style.cssText = 'position:absolute;top:10px;right:14px;border:none;background:none;font-size:24px;line-height:1;cursor:pointer;color:var(--muted, #8a8377);z-index:1';
  x.onclick = closeTasksModal;
  box.appendChild(x);
  box.appendChild(sect);
  ov.appendChild(box);
  document.body.appendChild(ov);
}
function openTasksModal() {
  var ov = document.getElementById('ldTasksModal');
  if (ov) ov.style.display = 'block';
}
function closeTasksModal() {
  var ov = document.getElementById('ldTasksModal');
  if (ov) ov.style.display = 'none';
}

function _syncTasksTabCount() {
  var badge = document.getElementById('ldTabTasksCount');
  if (!badge) return;
  var arr = Array.isArray(_tasks) ? _tasks : [];
  var open = arr.filter(function(t) { return t && !t.completed; }).length;
  if (open <= 0) {
    badge.hidden = true;
    badge.textContent = '';
  } else {
    badge.hidden = false;
    badge.textContent = String(open);
  }
}

// ════════════════════════════════════════════════════════════════════
// Deploy 236.124 — Loan Financials inline editor (Phase B.2/B.3)
// ════════════════════════════════════════════════════════════════════
// Mike's spec:
//   1) Edits snapshot the prior value → can be restored to default
//      with a button + a banner shows the loan was manually modified.
//   2) Editing also flags the Rate Sheet + Loan App as needing
//      re-signing (via _signedDocsStale on the loan).
//   3) Downstream calcs (Down / Monthly Payment / LTV / LTC / LTARV)
//      recompute from the edited values on the next render. LTC /
//      LTARV / LTV that exceed program max highlight red with a
//      tooltip naming the violated threshold.
//   4) EDITABLE: Rate, Points, Purchase Price, Rehab Budget, ARV,
//      FICO, Loan Type, Experience, Broker Fee.
//      READ-ONLY (calculated): Down Payment, Monthly Payment,
//      LTV/LTP, LTC, LTARV.
//
// The enhancer is a post-render DOM walker rather than per-render-
// line wrappers — keeps the existing fin-grid emit code untouched
// and centralizes the editable/readonly policy in one place.

// Deploy 236.125 — FICO / Loan Type / Experience now render as
// selects that mirror the originating sizer's dropdowns. Options
// resolved per-modal-open from _loan.toolType so a DSCR loan sees
// DSCR option lists and an RTL loan sees RTL ones.
var FIN_DROPDOWNS = {
  // FICO buckets — sizer-matched. DSCR sizer uses string ranges
  // ("740-759"); RTL sizer uses bucket floor numbers ("740").
  // We mirror each verbatim so the value round-trips into the
  // sizer's pricing matrix correctly.
  fico_dscr: [
    { value: '780+',     label: '780+' },
    { value: '760-779',  label: '760–779' },
    { value: '740-759',  label: '740–759' },
    { value: '720-739',  label: '720–739' },
    { value: '700-719',  label: '700–719' },
    { value: '680-699',  label: '680–699' },
    { value: '660-679',  label: '660–679' },
    { value: '640-659',  label: '640–659' },
    { value: '620-639',  label: '620–639' },
    { value: '550-619',  label: '550–619' },
  ],
  fico_rtl: [
    { value: '740',  label: '740+' },
    { value: '720',  label: '720 – 739' },
    { value: '700',  label: '700 – 719' },
    { value: '680',  label: '680 – 699' },
    { value: '660',  label: '660 – 679' },
    { value: '640',  label: '640 – 659' },
    { value: '620',  label: '620 – 639' },
    { value: '550',  label: '550 – 619' },
  ],
  loanType_dscr: [
    { value: '30Y Fixed', label: '30-Year Fixed' },
    { value: '10/6 ARM',  label: '10/6 ARM' },
    { value: '7/6 ARM',   label: '7/6 ARM' },
    { value: '5/6 ARM',   label: '5/6 ARM' },
  ],
  loanType_rtl: [
    { value: 'light',         label: 'Light Rehab (<50% of Loan)' },
    { value: 'heavy',         label: 'Heavy Rehab (>50% of Loan)' },
    { value: 'bridge',        label: 'Bridge (No Rehab)' },
    { value: 'transactional', label: 'Transactional Funding (1-day)' },
  ],
  // Experience — RTL only (DSCR has no Experience cell). Sizer
  // stores the bucket floor (8/5/1); display label spells out the
  // tier so the LO knows what they're picking.
  experience_rtl: [
    { value: '8', label: '8+ projects (Tier 1)' },
    { value: '5', label: '4 – 7 projects (Tier 2)' },
    { value: '1', label: '0 – 3 projects (Tier 3)' },
  ],
};

var FIN_EDITABLE = [
  { label: 'Note Rate',         key: 'rate',             kind: 'number', step: '0.001', hint: 'Percent (e.g. 8.625)' },
  { label: 'Points',            key: 'points',           kind: 'number', step: '0.001', hint: 'Origination points (e.g. 1.5)' },
  { label: 'Purchase Price',    key: 'purchasePrice',    kind: 'money',  hint: 'Dollars' },
  { label: 'Rehab Budget',      key: 'rehabBudget',      kind: 'money',  hint: 'Dollars' },
  { label: 'ARV',               key: 'arv',              kind: 'money',  hint: 'After-repair value, dollars' },
  { label: 'FICO',              key: 'fico',             kind: 'select', dropdownBase: 'fico',       labelKey: 'ficoLabel',       hint: 'Middle credit score (matches sizer buckets)' },
  { label: 'Loan Type',         key: 'loanType',         kind: 'select', dropdownBase: 'loanType',                                hint: 'Product type — matches the originating sizer' },
  { label: 'Experience',        key: 'experience',       kind: 'select', dropdownBase: 'experience', labelKey: 'experienceLabel', hint: 'Investor experience tier' },
  { label: 'Broker Fee',        key: 'brokerFee',        kind: 'number', step: '0.001', hint: 'Points (e.g. 1.0)' },
  // Deploy 236.133 — DSCR-only inline editors. Editing any of
  // Rent / Taxes / Insurance / HOA recomputes DSCR live; the
  // DSCR cell flags a tier change if the new value crosses a
  // pricing-tier boundary vs the snapshot. Appraised Value drives
  // the LTV cell (calculated).
  { label: 'Monthly Rent',      key: 'monthlyRent',      kind: 'money',  hint: 'Dollars / month' },
  { label: 'Monthly Taxes',     key: 'monthlyTaxes',     kind: 'money',  hint: 'Dollars / month' },
  { label: 'Monthly Insurance', key: 'monthlyInsurance', kind: 'money',  hint: 'Dollars / month' },
  { label: 'Monthly HOA',       key: 'monthlyHoa',       kind: 'money',  hint: 'Dollars / month' },
  { label: 'Appraised Value',   key: 'appraisedValue',   kind: 'money',  hint: 'Dollars (post-appraisal)' },
];

function _resolveFinDropdownOptions(field) {
  // Deploy 236.701 — GUC uses the RTL-family dropdown sets (construction is an
  // RTL-family product), so it resolves loanType_rtl / propType_rtl etc.
  var _tt = String((_loan && _loan.toolType) || '').toLowerCase();
  var toolType = (_tt === 'rtl' || _tt === 'guc') ? 'rtl' : 'dscr';
  var key = field.dropdownBase + '_' + toolType;
  return FIN_DROPDOWNS[key] || FIN_DROPDOWNS[field.dropdownBase + '_rtl'] || [];
}

// Deploy 236.133 — DSCR live-recompute + tier classification.
// Used by the DSCR render to show a current DSCR derived from the
// editable rent/taxes/insurance/HOA fields (so edits update the
// display immediately on next render), and to flag tier changes
// vs the sizer's quoted DSCR snapshot.
//
// Formula: DSCR = rent / (P&I + taxes + insurance + HOA).
// P&I uses standard 30-year amortization unless IO is set, in
// which case the periodic payment is just interest (rate/12 * P).
// Returns null when inputs aren't sufficient to compute.
function _computeLiveDscr(o) {
  var p = o && o.loanAmt, r = o && o.rate, rent = o && o.rent;
  var t = (o && o.taxes) || 0, ins = (o && o.insurance) || 0, hoa = (o && o.hoa) || 0;
  if (!isFinite(p) || p <= 0) return null;
  if (!isFinite(r) || r <= 0) return null;
  if (!isFinite(rent) || rent <= 0) return null;
  var rMonthly = (r / 100) / 12;          // rate stored as percent
  var pi;
  if (o.isIO) {
    pi = p * rMonthly;
  } else {
    var n = 360;
    var pow = Math.pow(1 + rMonthly, n);
    pi = p * (rMonthly * pow) / (pow - 1);
  }
  var pitia = pi + (parseFloat(t) || 0) + (parseFloat(ins) || 0) + (parseFloat(hoa) || 0);
  if (!isFinite(pitia) || pitia <= 0) return null;
  return rent / pitia;
}
// DSCR tier classifier — matches the common Diya pricing
// breakpoints. >=1.20 = top, 1.00-1.19 = mid, <1.00 = below
// (exception territory). Crossing any boundary flips the cell's
// "tier changed" badge in the DSCR render.
function _dscrTierOf(v) {
  var n = parseFloat(v);
  if (!isFinite(n) || n <= 0) return 'unknown';
  if (n >= 1.20) return 'top';
  if (n >= 1.00) return 'mid';
  return 'below';
}
function _dscrTierLabel(v) {
  var t = _dscrTierOf(v);
  return t === 'top'   ? 'tier ≥1.20'
       : t === 'mid'   ? 'tier 1.00–1.19'
       : t === 'below' ? 'tier <1.00 (exception)'
       :                 '(no quote)';
}
// Calculated fields the LO cannot inline-edit. Note: "LTV" matches
// the DSCR grid; "LTP" matches the RTL "Loan to Price" cell that
// some sizers emit. Both lock the same way.
// Deploy 236.647 — Product / Initial Advance / LTAIV are derived, not editable.
var FIN_READONLY = ['Down Payment', 'Monthly Payment', 'LTV', 'LTP', 'LTP/LTV', 'LTC', 'LTARV', 'LTAIV', 'Product', 'Initial Advance'];

// Strip any trailing "Overridden" / "modified" / lock badge text
// the existing renderers tack onto the label so the match is exact.
function _finLabelClean(text) {
  return String(text || '')
    .replace(/\s*✎.*$/g, '')
    .replace(/\s*✨\s*modified\s*$/i, '')
    .replace(/\s*✅\s*$/g, '')
    .replace(/\s*Overridden\s*$/i, '')
    .replace(/\s*ὑ2.*$/g, '')
    .trim();
}

function enhanceLoanFinancialsInlineEdit() {
  var section = document.getElementById('loanFinancialsSection');
  if (!section) return;
  // body container — fall back to section itself if no inner wrapper
  var body = section.querySelector('.section-body') || section;

  // Remove any stale banner / classes left from the prior render so
  // we don't double-stack things on re-render.
  var oldBanner = body.querySelector('.fin-banner');
  if (oldBanner) oldBanner.remove();

  var modified = (_loan && Array.isArray(_loan._modifiedFields)) ? _loan._modifiedFields.slice() : [];
  var hasMods = modified.length > 0;

  // ── Top-of-section warning banner + Restore button ─────────────
  if (hasMods) {
    var labels = modified.map(function(k) {
      var f = FIN_EDITABLE.find(function(x){ return x.key === k; });
      return f ? f.label : k;
    });
    var banner = document.createElement('div');
    banner.className = 'fin-banner';
    banner.innerHTML =
      '<div class="fin-banner-msg">' +
        '<strong>⚠ ' + modified.length + ' field' + (modified.length === 1 ? '' : 's') +
        ' manually modified:</strong> ' + escH(labels.join(', ')) +
        '. The Rate Sheet and Loan Application may need to be re-signed to reflect the new values.' +
      '</div>' +
      '<button type="button" class="fin-banner-restore" onclick="restoreLoanFinancials()">↶ Restore to Original</button>';
    // Insert at the top of the section body — before fin-grid + any
    // button row.
    var sectionHead = body.querySelector('.section-head');
    if (sectionHead && sectionHead.nextSibling) {
      body.insertBefore(banner, sectionHead.nextSibling);
    } else {
      body.insertBefore(banner, body.firstChild);
    }
  }

  // ── Walk every fin-cell and decorate ───────────────────────────
  section.querySelectorAll('.fin-cell').forEach(function(cell) {
    // Wipe any modified badges from a prior render before adding
    // new ones (idempotent on re-render).
    var oldBadge = cell.querySelector('.fin-modified-badge');
    if (oldBadge) oldBadge.remove();
    cell.classList.remove('fin-cell-editable', 'fin-cell-calculated');
    var valEl = cell.querySelector('.fin-val');
    if (valEl) valEl.classList.remove('fin-warn');

    var labelEl = cell.querySelector('.fin-label');
    if (!labelEl) return;
    var labelText = _finLabelClean(labelEl.textContent);

    // EDITABLE?
    var editable = FIN_EDITABLE.find(function(f) { return labelText === f.label; });
    if (editable) {
      cell.classList.add('fin-cell-editable');
      cell.title = 'Click to edit ' + editable.label;
      cell.onclick = function(e) { e.stopPropagation(); openLoanFinInlineEdit(editable); };
      if (modified.indexOf(editable.key) >= 0) {
        var badge = document.createElement('span');
        badge.className = 'fin-modified-badge';
        badge.textContent = '✨ modified';
        var orig = _loan && _loan._originalValues && _loan._originalValues[editable.key];
        if (orig != null && orig !== '') badge.title = 'Original (calculator-generated): ' + orig;
        labelEl.appendChild(badge);
      }
      return;
    }

    // READ-ONLY (calculated)?
    if (FIN_READONLY.indexOf(labelText) >= 0) {
      cell.classList.add('fin-cell-calculated');
      cell.title = labelText + ' is calculated from the other fields and cannot be edited directly.';
      // Threshold warning — pull the rendered % from the val cell.
      if (valEl) {
        var pct = parseFloat(String(valEl.textContent || '').replace(/[^0-9.\-]/g, ''));
        if (isFinite(pct)) {
          var warn = false, msg = '';
          if (labelText === 'LTC' && pct > 95) {
            warn = true; msg = 'LTC ' + pct.toFixed(1) + '% exceeds the 95% program max — exception required.';
          } else if (labelText === 'LTARV' && pct > 75) {
            warn = true; msg = 'LTARV ' + pct.toFixed(1) + '% exceeds the 75% program max — exception required.';
          } else if ((labelText === 'LTV' || labelText === 'LTP') && pct > 80) {
            warn = true; msg = labelText + ' ' + pct.toFixed(1) + '% exceeds the 80% program max — exception required.';
          }
          if (warn) {
            valEl.classList.add('fin-warn');
            valEl.title = msg;
          }
        }
      }
    }
  });
}

function openLoanFinInlineEdit(field) {
  // Resolve current value from loan (with formData fallback — same
  // precedence the renderers use).
  var current = (_loan && _loan[field.key] != null && _loan[field.key] !== '')
    ? _loan[field.key]
    : (_loan && _loan.formData && _loan.formData[field.key] != null
        ? _loan.formData[field.key]
        : '');

  var bg = document.createElement('div');
  bg.className = 'fin-edit-bg';
  bg.onclick = function(e) { if (e.target === bg) bg.remove(); };

  var modal = document.createElement('div');
  modal.className = 'fin-edit-modal';

  var staleMsg;
  if (_loan && _loan._signedDocsStale) {
    staleMsg = 'Note: this loan\'s Rate Sheet / Loan App are already flagged as needing re-signing. Editing again keeps the flag set.';
  } else {
    staleMsg = 'Heads up: editing this field will flag the Rate Sheet and Loan App as needing re-signing.';
  }

  var inputHtml;
  if (field.kind === 'select') {
    var opts = _resolveFinDropdownOptions(field);
    inputHtml = '<select id="finEditInput">' + opts.map(function(o) {
      var sel = String(o.value) === String(current) ? ' selected' : '';
      return '<option value="' + escAttr(o.value) + '"' + sel + '>' + escH(o.label) + '</option>';
    }).join('') + '</select>';
  } else if (field.kind === 'money') {
    inputHtml = '<input id="finEditInput" type="number" step="1000" value="' + escAttr(current) + '" />';
  } else if (field.kind === 'int') {
    var minAttr = (field.min != null) ? ' min="' + field.min + '"' : '';
    var maxAttr = (field.max != null) ? ' max="' + field.max + '"' : '';
    inputHtml = '<input id="finEditInput" type="number" step="1"' + minAttr + maxAttr + ' value="' + escAttr(current) + '" />';
  } else if (field.kind === 'number') {
    inputHtml = '<input id="finEditInput" type="number" step="' + escAttr(field.step || '0.01') + '" value="' + escAttr(current) + '" />';
  } else {
    inputHtml = '<input id="finEditInput" type="text" value="' + escAttr(current) + '" />';
  }

  modal.innerHTML =
    '<h3>Edit ' + escH(field.label) + '</h3>' +
    '<div class="hint">Current value: <strong>' + escH(String(current || '(none)')) + '</strong>' +
      (field.hint ? ' · ' + escH(field.hint) : '') + '</div>' +
    '<div class="fin-stale-warning">' + escH(staleMsg) + '</div>' +
    inputHtml +
    '<div class="fin-edit-actions">' +
      '<button type="button" id="finEditCancelBtn">Cancel</button>' +
      '<button type="button" class="primary" id="finEditSaveBtn">Save</button>' +
    '</div>';

  bg.appendChild(modal);
  document.body.appendChild(bg);

  var input = document.getElementById('finEditInput');
  if (input) { try { input.focus(); input.select && input.select(); } catch (_) {} }

  document.getElementById('finEditCancelBtn').onclick = function() { bg.remove(); };
  document.getElementById('finEditSaveBtn').onclick = function() {
    saveLoanFinInlineEdit(field, input.value, bg, this);
  };
  if (input) {
    input.onkeydown = function(e) {
      if (e.key === 'Enter') { document.getElementById('finEditSaveBtn').click(); }
      else if (e.key === 'Escape') { bg.remove(); }
    };
  }
}

function saveLoanFinInlineEdit(field, newVal, bg, btn) {
  btn.disabled = true; btn.textContent = 'Saving…';
  var payload = { clientId: _clientId, loanId: _loanId, fields: {} };
  payload.fields[field.key] = newVal;
  // Deploy 236.125 — dropdown fields with a display label (FICO,
  // Experience) round-trip BOTH the value and the human-readable
  // label so Loan Details renders cleanly without rebuilding the
  // label from the value.
  if (field.kind === 'select' && field.labelKey) {
    var opts = _resolveFinDropdownOptions(field);
    var match = opts.find(function(o) { return String(o.value) === String(newVal); });
    if (match) payload.fields[field.labelKey] = match.label;
  }
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-financials-edit', payload).then(function(r) {
    if (!r || !r.loan) {
      btn.disabled = false; btn.textContent = 'Save';
      showToast('Save failed: server returned no loan.');
      return;
    }
    _loan = r.loan;
    var lidx = (_client && _client.loans || []).findIndex(function(l) { return l && l.id === _loanId; });
    if (lidx >= 0) _client.loans[lidx] = r.loan;
    // Deploy 236.216 — invalidate the SWR clients cache so a
    // subsequent "Open in Sizer" click reads the FRESH loan record
    // (with mirrored _rateOverride / _pointsOverride) instead of
    // the localStorage snapshot from before this edit. Without
    // this, the sizer's applyLockedOverride path pulled stale
    // formData and edits looked like they had never happened.
    try {
      localStorage.removeItem('sla_cache_clients');
      localStorage.removeItem('sla_cache_clients_all');
    } catch (_) {}
    bg.remove();
    // Re-render Loan Details — the existing render() pipeline rebuilds
    // every section from the new loan state. tabs / hash / sidebar
    // are all re-emitted; URL hash keeps the active tab.
    render();
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = 'Save';
    showToast('Save failed: ' + (err && err.message || 'unknown'));
  });
}

function restoreLoanFinancials() {
  var modCount = (_loan && _loan._modifiedFields || []).length;
  if (!confirm('Restore ' + modCount + ' manually-modified field' + (modCount === 1 ? '' : 's') +
               ' to the original calculator-generated values?\n\n' +
               'This will also flag the Rate Sheet and Loan App as needing re-signing.')) return;
  var payload = { clientId: _clientId, loanId: _loanId };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-financials-restore', payload).then(function(r) {
    if (!r || !r.loan) { showToast('Restore failed: server returned no loan.'); return; }
    _loan = r.loan;
    var lidx = (_client && _client.loans || []).findIndex(function(l) { return l && l.id === _loanId; });
    if (lidx >= 0) _client.loans[lidx] = r.loan;
    // Deploy 236.216 — same cache-clear rationale as saveLoanFinInlineEdit.
    try {
      localStorage.removeItem('sla_cache_clients');
      localStorage.removeItem('sla_cache_clients_all');
    } catch (_) {}
    render();
  }).catch(function(err) {
    showToast('Restore failed: ' + (err && err.message || 'unknown'));
  });
}

// ════════════════════════════════════════════════════════════════════
// Deploy 236.113 (Phase E — Contacts) — Additional Contacts on a loan
// ════════════════════════════════════════════════════════════════════
var _loanContacts = []; // contacts for the currently-viewed loan
var ROLE_LABELS = {
  title:     'Title Co',
  insurance: 'Insurance',
  inspector: 'Inspector',
  appraiser: 'Appraiser',
  surveyor:  'Surveyor',
  attorney:  'Attorney',
  contractor:'Contractor',
  realtor:   'Realtor',
  lender:    'Lender',
  escrow:    'Escrow',
  note_servicer: 'Note Servicer',
  other:     'Other',
};
function _contactOwnerParam() {
  if (_loEmail && _user && _loEmail.toLowerCase() !== _user.email.toLowerCase()) return _loEmail;
  return undefined;
}
function refreshLoanContacts() {
  if (!_client || !_loanId) return;
  var inner = document.getElementById('loanContactsList');
  if (!inner) return;
  inner.innerHTML = '<div class="contacts-empty">Loading contacts…</div>';
  var url = '/api/loan-contacts-list?loanId=' + encodeURIComponent(_loanId) + '&clientId=' + encodeURIComponent(_client.id);
  var owner = _contactOwnerParam();
  if (owner) url += '&owner=' + encodeURIComponent(owner);
  SLA.api('GET', url).then(function(resp) {
    _loanContacts = (resp && resp.contacts) || [];
    renderLoanContactsList();
  }).catch(function(err) {
    inner.innerHTML = '<div class="contacts-empty" style="color:var(--danger)">Failed to load contacts: ' + escH(err && err.message || 'unknown') + '</div>';
  });
}
function renderLoanContactsList() {
  var inner = document.getElementById('loanContactsList');
  if (!inner) return;
  var rows = (_loanContacts || []).slice().sort(function(a, b) {
    // Group by role then by name within group
    var ar = String(a.role || 'other'), br = String(b.role || 'other');
    if (ar < br) return -1; if (ar > br) return 1;
    var an = String(a.name || a.company || '').toLowerCase();
    var bn = String(b.name || b.company || '').toLowerCase();
    if (an < bn) return -1; if (an > bn) return 1;
    return 0;
  });
  if (!rows.length) {
    inner.innerHTML = '<div class="contacts-empty">No additional contacts yet. Use the row above to add a Title Co, Insurance Agent, etc. — LO, Borrower, Guarantors, and Broker each have their own sections.</div>';
    return;
  }
  inner.innerHTML = rows.map(_renderLoanContactRow).join('');
}
function _fmtPhoneDisplay(p) {
  var d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  if (d.length === 10) return '(' + d.slice(0,3) + ') ' + d.slice(3,6) + '-' + d.slice(6);
  return String(p || '');
}
function _renderLoanContactRow(c) {
  var role = String(c.role || 'other').toLowerCase();
  var roleLabel = c.roleLabel || ROLE_LABELS[role] || role;
  // When there's no name, promote company to the primary line so the row isn't
  // "(no name)". Company shows as a sub-line only when both are present.
  var name = c.name || c.company || '(no name)';
  var emailHtml = c.email
    ? '<a href="mailto:' + escAttr(c.email) + '" onclick="event.stopPropagation()" title="' + escAttr(c.email) + '">' + escH(c.email) + '</a>'
    : '<span class="muted">—</span>';
  var phoneHtml = c.phone
    ? '<a href="tel:' + escAttr(String(c.phone).replace(/[^\d+]/g, '')) + '" onclick="event.stopPropagation()">' + escH(_fmtPhoneDisplay(c.phone)) + '</a>'
    : '<span class="muted">—</span>';
  // Deploy 236.114 — row is clickable to edit; the delete button
  // stops propagation so clicking the X doesn't also open the modal.
  return '<div class="contact-row" data-contact-id="' + escAttr(c.id) + '" onclick="openEditContactModal(\'' + escAttr(c.id) + '\')" style="cursor:pointer" title="Click to edit">' +
    '<div><span class="ct-role ' + escAttr(role) + '">' + escH(roleLabel) + '</span></div>' +
    '<div class="ct-name">' +
      '<span class="ct-name-name">' + escH(name) + '</span>' +
      (c.company && c.name ? '<span class="ct-name-company">' + escH(c.company) + '</span>' : '') +
    '</div>' +
    '<div class="ct-info ct-email">' + emailHtml + '</div>' +
    '<div class="ct-info ct-phone">' + phoneHtml + '</div>' +
    '<button class="ct-delete" onclick="event.stopPropagation();deleteLoanContact(\'' + escAttr(c.id) + '\')" title="Delete contact">✕</button>' +
  '</div>';
}

// Deploy 236.114 — modal-based add/edit. Replaces the inline grid
// that was too cramped to read.
function openAddContactModal() {
  document.getElementById('ctModalEditId').value = '';
  document.getElementById('ctModalTitle').textContent = 'Add Vendor';
  document.getElementById('ctModalSaveBtn').textContent = 'Save Vendor';
  document.getElementById('ctModalRole').value = 'title';
  ['ctModalName','ctModalCompany','ctModalEmail','ctModalPhone'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Deploy 236.470 — show + reset the vendor search and load the directory.
  var _sw = document.getElementById('ctvSearchWrap'); if (_sw) _sw.style.display = '';
  var _si = document.getElementById('ctvSearch');     if (_si) _si.value = '';
  var _ss = document.getElementById('ctvSuggest');    if (_ss) { _ss.innerHTML = ''; _ss.classList.remove('show'); }
  _loadVendorPool();
  _resetContactModalStatus();
  document.getElementById('ctAddModal').classList.add('show');
  _wireContactModalEnter();
  setTimeout(function(){ var n = document.getElementById('ctvSearch') || document.getElementById('ctModalName'); if (n) n.focus(); }, 30);
}
// Deploy 236.326 — Enter submits the Add-Contact modal. Wire once
// per modal open; guard against duplicate handlers via _slaEnterBound.
function _wireContactModalEnter() {
  ['ctModalName','ctModalCompany','ctModalEmail','ctModalPhone'].forEach(function(id) {
    var el = document.getElementById(id);
    if (!el || el._slaEnterBound) return;
    el._slaEnterBound = true;
    el.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        var btn = document.getElementById('ctModalSaveBtn');
        if (btn && !btn.disabled) btn.click();
      }
    });
  });
}
function openEditContactModal(contactId) {
  var c = _loanContacts.find(function(x) { return x.id === contactId; });
  if (!c) return;
  document.getElementById('ctModalEditId').value = contactId;
  // Deploy 236.470 — no directory search when editing an existing vendor.
  var _sw = document.getElementById('ctvSearchWrap'); if (_sw) _sw.style.display = 'none';
  document.getElementById('ctModalTitle').textContent = 'Edit Vendor';
  document.getElementById('ctModalSaveBtn').textContent = 'Save Changes';
  document.getElementById('ctModalRole').value    = String(c.role || 'other').toLowerCase();
  document.getElementById('ctModalName').value    = c.name    || '';
  document.getElementById('ctModalCompany').value = c.company || '';
  document.getElementById('ctModalEmail').value   = c.email   || '';
  document.getElementById('ctModalPhone').value   = c.phone   || '';
  _resetContactModalStatus();
  document.getElementById('ctAddModal').classList.add('show');
  _wireContactModalEnter();
}
function closeAddContactModal() {
  document.getElementById('ctAddModal').classList.remove('show');
}

// ── Deploy 236.470 — vendor directory search inside the Add Vendor modal ──
// Type a name / company / email to auto-search every vendor already on file
// (deduped across loans); pick one to prefill the fields, or ignore it and
// type a brand-new vendor. Picking still creates a fresh loan-tied record on
// Save — it's a prefill convenience, not a link.
var _vendorSearchPool = null;   // deduped [{role,name,company,email,phone}]
var _vendorMatches    = [];     // current on-screen matches (for click lookup)
function _loadVendorPool() {
  if (_vendorSearchPool) return; // load once per page
  var qs = (window.SLA && SLA.isAdmin && SLA.isAdmin(_user)) ? '?all=1' : '';
  SLA.api('GET', '/api/loan-contacts-list' + qs).then(function(resp) {
    var all = (resp && resp.contacts) || [];
    var seen = {}, out = [];
    all.forEach(function(c) {
      var key = ((c.name || '') + '|' + (c.company || '') + '|' + (c.email || '')).toLowerCase().trim();
      if (key === '||' || seen[key]) return;   // skip blanks + dupes
      seen[key] = true;
      out.push({ role: c.role || 'other', name: c.name || '', company: c.company || '', email: c.email || '', phone: c.phone || '' });
    });
    _vendorSearchPool = out;
  }).catch(function() { _vendorSearchPool = []; });
}
function onVendorSearch() {
  var box = document.getElementById('ctvSuggest');
  var q = (document.getElementById('ctvSearch').value || '').toLowerCase().trim();
  if (!q) { box.innerHTML = ''; box.classList.remove('show'); return; }
  _vendorMatches = (_vendorSearchPool || []).filter(function(c) {
    var hay = ((c.name || '') + ' ' + (c.company || '') + ' ' + (c.email || '') + ' ' + (ROLE_LABELS[c.role] || c.role || '')).toLowerCase();
    return hay.indexOf(q) >= 0;
  }).slice(0, 8);
  if (!_vendorMatches.length) {
    box.innerHTML = '<div class="ctv-suggest-empty">No matching vendor — fill the fields below to add a new one.</div>';
    box.classList.add('show'); return;
  }
  box.innerHTML = _vendorMatches.map(function(c, i) {
    var meta = [ROLE_LABELS[c.role] || c.role, c.company, c.email].filter(Boolean).join(' · ');
    return '<div class="ctv-suggest-row" data-i="' + i + '" onclick="pickVendor(' + i + ')">' +
      '<div class="ctv-suggest-name">' + escH(c.name || c.company || '(no name)') + '</div>' +
      '<div class="ctv-suggest-meta">' + escH(meta) + '</div>' +
    '</div>';
  }).join('');
  box.classList.add('show');
}
function pickVendor(i) {
  var c = _vendorMatches[i];
  if (!c) return;
  document.getElementById('ctModalRole').value    = String(c.role || 'other').toLowerCase();
  document.getElementById('ctModalName').value    = c.name    || '';
  document.getElementById('ctModalCompany').value = c.company || '';
  document.getElementById('ctModalEmail').value   = c.email   || '';
  document.getElementById('ctModalPhone').value   = c.phone   || '';
  document.getElementById('ctvSearch').value = '';
  var box = document.getElementById('ctvSuggest'); box.innerHTML = ''; box.classList.remove('show');
}
function _resetContactModalStatus() {
  var s = document.getElementById('ctModalStatus');
  s.textContent = ''; s.className = 'ct-modal-status';
}
function submitContactModal() {
  var editId  = (document.getElementById('ctModalEditId') || {}).value || '';
  var role    = (document.getElementById('ctModalRole')   || {}).value || 'other';
  var name    = ((document.getElementById('ctModalName')    || {}).value || '').trim();
  var company = ((document.getElementById('ctModalCompany') || {}).value || '').trim();
  var email   = ((document.getElementById('ctModalEmail')   || {}).value || '').trim().toLowerCase();
  var phone   = ((document.getElementById('ctModalPhone')   || {}).value || '').trim();
  if (!name && !company && !email && !phone) {
    var s = document.getElementById('ctModalStatus');
    s.textContent = 'Add at least a name, company, email, or phone.';
    s.className = 'ct-modal-status err';
    return;
  }
  var btn = document.getElementById('ctModalSaveBtn');
  btn.disabled = true;
  var body = { clientId: _client.id, loanId: _loanId, role: role, name: name, company: company, email: email, phone: phone };
  if (editId) body.contactId = editId;
  var owner = _contactOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/loan-contacts-save', body).then(function(resp) {
    btn.disabled = false;
    if (resp && resp.contact) {
      if (editId) {
        var i = _loanContacts.findIndex(function(c) { return c.id === editId; });
        if (i >= 0) _loanContacts[i] = resp.contact;
      } else {
        _loanContacts.push(resp.contact);
      }
      renderLoanContactsList();
      closeAddContactModal();
    }
  }).catch(function(err) {
    btn.disabled = false;
    var s = document.getElementById('ctModalStatus');
    s.textContent = 'Failed: ' + (err && err.message || 'unknown');
    s.className = 'ct-modal-status err';
  });
}

function deleteLoanContact(contactId) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;
  var idx = _loanContacts.findIndex(function(c) { return c.id === contactId; });
  if (idx < 0) return;
  var removed = _loanContacts.splice(idx, 1)[0];
  renderLoanContactsList();
  var body = { contactId: contactId };
  var owner = _contactOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/loan-contacts-delete', body).catch(function(err) {
    _loanContacts.splice(idx, 0, removed);
    renderLoanContactsList();
    showToast('Failed to delete contact: ' + (err && err.message || 'unknown'));
  });
}

// Deploy 236.84 — Linked Guarantor Clients section populator.
// Reads _loan.guarantorClientIds (set by borrower-info-sign when the
// long-app is signed with 2+ guarantors), looks each one up via
// SLA.Clients.list, and renders a row per linked guarantor.
function refreshLinkedGuarantors() {
  var listEl = document.getElementById('linkedGuarantorsList');
  if (!listEl || !_loan) return;
  var ids = Array.isArray(_loan.guarantorClientIds) ? _loan.guarantorClientIds : [];
  if (!ids.length) return; // section won't be rendered

  // Admin viewing a cross-LO loan needs the all=true list.
  var p = SLA.isStaff(_user) ? SLA.Clients.list({ all: true, summary: true }) : SLA.Clients.list({ summary: true }); // Deploy 236.266
  p.then(function(r) {
    var pool = [];
    if (r.byOwner) {
      Object.keys(r.byOwner).forEach(function(k) {
        (r.byOwner[k] || []).forEach(function(c) { pool.push(c); });
      });
    } else {
      pool = r.clients || [];
    }
    var byId = {};
    pool.forEach(function(c) { if (c && c.id) byId[c.id] = c; });
    var rows = ids.map(function(id) {
      var c = byId[id];
      if (!c) {
        return '<div style="padding:10px 12px;background:#fff;border:1px solid var(--border, #E4DFD4);border-radius:6px;font-size:12px;color:var(--muted)">' +
          'Client ' + escH(id) + ' not found in your client list (may belong to another LO).' +
          '</div>';
      }
      var fullName = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email || c.id;
      var loanCount = Array.isArray(c.loans) ? c.loans.length : 0;
      var cdUrl = '/client-details.html?clientId=' + encodeURIComponent(c.id);
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#fff;border:1px solid var(--border, #E4DFD4);border-radius:6px;gap:1rem">' +
        '<div>' +
          '<div style="font-weight:600;font-size:13px;color:var(--text, #1a1520)">' + escH(fullName) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:DM Mono,monospace;margin-top:2px">' +
            (c.email ? escH(c.email) : '(no email)') +
            (c.phone ? ' &middot; ' + escH(c.phone) : '') +
            (loanCount ? ' &middot; ' + loanCount + ' loan' + (loanCount === 1 ? '' : 's') + ' on this client' : '') +
          '</div>' +
        '</div>' +
        '<a href="' + escAttr(cdUrl) + '" class="small-btn" style="padding:6px 12px;font-size:11px;font-weight:600;color:var(--gold, #C8813A);background:transparent;border:1px solid var(--gold-border, rgba(200,129,58,0.28));border-radius:5px;text-decoration:none;white-space:nowrap">Open Client →</a>' +
      '</div>';
    }).join('');
    listEl.innerHTML = rows;
  }).catch(function(err) {
    listEl.innerHTML = '<div style="padding:1rem;text-align:center;color:#7C1F1F;font-size:13px">Failed to load linked guarantors: ' + escH(err.message || 'Unknown') + '</div>';
  });
}

// ── Loan Doc Review entrypoint (Deploy 236.73) ────────────────────
// Two-state button on Loan Details for processors + admins. Looks
// up the in-progress reviews list and matches against (clientId,
// loanId) to decide whether to "Open" the existing review or
// "Start" a new one. Cached at module scope so openOrCreateDocReview()
// doesn't have to re-fetch on click.
var _existingReviewId = null;

function refreshDocReviewButton() {
  var btn = document.getElementById('docReviewBtn');
  var label = document.getElementById('docReviewBtnLabel');
  if (!btn || !label) return; // not rendered for this user (not a processor)

  SLA.LoanReviews.list({ status: 'in_progress' }).then(function(r) {
    var match = (r.reviews || []).find(function(rv) {
      return rv.source && rv.source.kind === 'existing'
          && rv.source.clientId === _clientId
          && rv.source.loanId === _loanId;
    });
    _existingReviewId = match ? match.id : null;
    label.textContent = match ? 'Open Loan Doc Review →' : 'Start Loan Doc Review';
    btn.disabled = false;
    btn.style.opacity = '1';
  }).catch(function(err) {
    label.textContent = 'Loan Doc Review (error)';
    btn.disabled = true;
    btn.style.opacity = '0.55';
    console.warn('refreshDocReviewButton failed:', err && err.message);
  });
}

function openOrCreateDocReview() {
  // Deploy 236.121 — Doc Review now lives inside the Documents
  // tab on this very page. The Actions-dropdown button just
  // jumps to that tab; the tab handles existing-vs-create on its
  // own via _initDocReviewPane() / _renderDocReviewStarter().
  if (typeof switchLdTab === 'function') switchLdTab('documents');
  // Old standalone-page flow kept below for reference but never
  // runs now that the early-return above always fires.
  return;
  if (_existingReviewId) {
    window.location.href = '/loan-review-detail.html?id=' + encodeURIComponent(_existingReviewId);
    return;
  }
  // No existing review — create one and navigate.
  if (!_client || !_loan) { showToast('Loan not loaded yet.'); return; }
  // Deploy 236.702 — GUC uses its own checklist (RTL/Colchis + construction docs).
  var _rtlT = String(_loan.toolType || '').toLowerCase();
  var loanType = (_rtlT === 'guc') ? 'guc' : (_rtlT === 'rtl') ? 'rtl' : 'dscr';
  var borrowerName = ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim();
  var btn = document.getElementById('docReviewBtn');
  var label = document.getElementById('docReviewBtnLabel');
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Creating…';
  var ownerKey = _loEmail || (_user && _user.email) || '';
  SLA.LoanReviews.create({
    loanType: loanType,
    source: { kind: 'existing', clientId: _clientId, loanId: _loanId, ownerKey: ownerKey },
    address: _loan.address || '',
    borrowerName: borrowerName,
    loanAmount: Number(_loan.loanAmt || 0),
    loEmail: ownerKey,
    expectedCloseDate: _loan.fundingDate || '',
  }).then(function(r) {
    if (r && r.review && r.review.id) {
      window.location.href = '/loan-review-detail.html?id=' + encodeURIComponent(r.review.id);
    } else {
      throw new Error('Server did not return a review id');
    }
  }).catch(function(err) {
    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Start Loan Doc Review';
    showToast('Failed to start review: ' + (err.message || 'Unknown error'));
  });
}

// ── Notes audit log (Deploy 226) ────────────────────────────────────

function renderNotesLog() {
  var inner = document.getElementById('notesListInner');
  if (!inner) return;
  var entries = (_loan && Array.isArray(_loan.notesLog)) ? _loan.notesLog.slice() : [];
  // Deploy 236.99 — apply the active note filter (All / Status / User).
  if (_noteFilter && _noteFilter !== 'all') {
    var allowed = NOTE_KIND_BUCKETS[_noteFilter] || [];
    entries = entries.filter(function(e) {
      return allowed.indexOf(String(e && e.kind || 'manual')) >= 0;
    });
  }
  // Newest first — sort by ISO timestamp descending.
  entries.sort(function(a, b) {
    var ta = String(a && a.ts || ''); var tb = String(b && b.ts || '');
    if (ta < tb) return 1;
    if (ta > tb) return -1;
    return 0;
  });
  // Append legacy `loan.notes` (free-form pre-audit-log text) as a single
  // entry at the very bottom (oldest). Keeps the existing data visible
  // without losing the chronology of new entries above it.
  var legacy = _loan && String(_loan.notes || '').trim();
  if (legacy) {
    entries.push({
      id: 'legacy',
      ts: _loan.createdAt || _loan.updatedAt || '',
      author: '',
      authorEmail: '',
      kind: 'legacy',
      text: legacy,
    });
  }
  if (!entries.length) {
    inner.innerHTML = '<div class="notes-empty">No notes yet. Add the first one above. Status updates, reprices, and admin decisions also land here automatically.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var when = formatNoteTime(e.ts);
    var kindLabel = noteKindLabel(e.kind);
    var who = e.author || e.authorEmail || (e.kind === 'legacy' ? 'Legacy note' : '');
    html +=
      '<div class="note-entry">' +
        '<div class="note-entry-head">' +
          (when ? '<span class="note-entry-time">' + escH(when) + '</span>' : '') +
          (who ? '<span class="note-entry-author">'+ escH(who) +'</span>' : '') +
          '<span class="note-entry-kind nk-' + escH(e.kind || 'manual') + '">' + escH(kindLabel) + '</span>' +
        '</div>' +
        '<div class="note-entry-body">' + escH(e.text || '') + '</div>' +
      '</div>';
  }
  inner.innerHTML = html;
  // Default to top (newest) — that's where the scroll position
  // naturally lands after innerHTML replacement, but make explicit.
  var list = document.getElementById('notesList');
  if (list) list.scrollTop = 0;
}

function formatNoteTime(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // Deploy 236.142 — explicit local-timezone rendering with a
    // TZ-abbrev label so the LO can see at a glance which zone
    // they're looking at. Default toLocaleString already uses the
    // browser's local TZ, but the previous output had no TZ
    // indicator — so a 5 PM UTC timestamp displayed as "1 PM"
    // looked like UTC to someone who expected ET. The explicit
    // timeZone: <browser default> + timeZoneName: 'short' makes
    // it unmistakable, e.g. "Oct 15, 2026, 1:00 PM EDT".
    var tz;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch (_) { tz = undefined; }
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short',
    });
  } catch (e) { return iso; }
}

function noteKindLabel(k) {
  switch (k) {
    case 'manual':        return 'Note';
    case 'submit':        return 'Submitted';
    case 'pre_discussed': return 'Pre-discussed';
    case 'reprice':       return 'Reprice';
    case 'decision':      return 'Decision';
    case 'decline':       return 'Declined';
    case 'app_sent':      return 'App sent';
    case 'app_received':  return 'App received';
    case 'status':        return 'Status';
    // Deploy 236.95/98 — new kinds from the Processing Pipeline
    // work (loan-processing-stage + loan-field-edit endpoints).
    case 'stage_change':  return 'Stage';
    case 'field_edit':    return 'Edit';
    case 'system':        return 'System';
    case 'legacy':        return 'Pre-audit-log';
    default:              return String(k || 'Note');
  }
}

// Deploy 236.99 (Phase C, partial) — notes filter. Mike asked for
// "All / Status Notes / User Notes" filtering. Kinds bucket into:
//   * status-side: 'status', 'stage_change', 'decision', 'app_sent',
//     'app_received', 'submit', 'pre_discussed', 'decline', 'reprice',
//     'field_edit', 'system' — anything the platform stamps
//   * user-side: 'manual', 'legacy' — the actual free-form notes
// `all` shows everything (default).
var NOTE_KIND_BUCKETS = {
  status: ['status','stage_change','decision','app_sent','app_received','submit','pre_discussed','decline','reprice','field_edit','system'],
  user:   ['manual','legacy'],
};
var _noteFilter = 'all';
function setNoteFilter(which) {
  _noteFilter = which;
  // Update button active states.
  ['all','status','user'].forEach(function(k) {
    var b = document.getElementById('noteFilterBtn_' + k);
    if (b) b.classList.toggle('active', k === which);
  });
  renderNotesLog();
}

// ════════════════════════════════════════════════════════════════════
// Deploy 236.105 (Phase C — Tasks) — per-loan tasks
// ════════════════════════════════════════════════════════════════════
var _tasks = []; // tasks for the currently-viewed loan
function _taskOwnerParam() {
  if (_loEmail && _user && _loEmail.toLowerCase() !== _user.email.toLowerCase()) return _loEmail;
  return undefined;
}
function _taskIsPastDue(t) {
  if (t && t.completed) return false;
  var d = t && t.dueDate ? _ldParseLocalDate(t.dueDate) : null;
  if (!d) return false;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.getTime() < today.getTime();
}
function _formatTaskDate(s) {
  var d = _ldParseLocalDate(s);
  if (!d) return s || '';
  var mo = d.getMonth() + 1, day = d.getDate(), yr = String(d.getFullYear()).slice(-2);
  return mo + '/' + day + '/' + yr;
}

function loadTasksList() {
  if (!_client || !_loanId) return;
  var inner = document.getElementById('tasksList');
  if (!inner) return;
  inner.innerHTML = '<div class="tasks-empty">Loading tasks…</div>';
  var url = '/api/tasks-list?loanId=' + encodeURIComponent(_loanId) + '&clientId=' + encodeURIComponent(_client.id);
  var owner = _taskOwnerParam();
  if (owner) url += '&owner=' + encodeURIComponent(owner);
  SLA.api('GET', url).then(function(resp) {
    _tasks = (resp && resp.tasks) || [];
    renderTasksList();
  }).catch(function(err) {
    inner.innerHTML = '<div class="tasks-empty" style="color:var(--danger)">Failed to load tasks: ' + escH(err && err.message || 'unknown') + '</div>';
  });
}

function renderTasksList() {
  var inner = document.getElementById('tasksList');
  // Deploy 236.118 — keep the tasks-tab count in sync with the
  // local _tasks state on every render. Cheap; safe to call even
  // when the tab badge element doesn't exist yet.
  if (typeof _syncTasksTabCount === 'function') _syncTasksTabCount();
  if (!inner) return;
  var sorted = (_tasks || []).slice().sort(function(a, b) {
    // Incomplete to top; within each group sort by due date ascending,
    // then by createdAt descending as tiebreaker.
    if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
    var ad = String(a.dueDate || ''), bd = String(b.dueDate || '');
    if (ad && bd) { if (ad < bd) return -1; if (ad > bd) return 1; }
    else if (ad) return -1;
    else if (bd) return 1;
    var ac = String(a.createdAt || ''), bc = String(b.createdAt || '');
    if (ac > bc) return -1;
    if (ac < bc) return 1;
    return 0;
  });
  if (!sorted.length) {
    inner.innerHTML = '<div class="tasks-empty">No tasks yet. Add the first one above. Use tasks to track docs to order, calls to make, follow-ups, etc.</div>';
    return;
  }
  inner.innerHTML = sorted.map(_renderTaskRow).join('');
}

function _renderTaskRow(t) {
  var past = _taskIsPastDue(t);
  var dueStr = t.dueDate ? _formatTaskDate(t.dueDate) : '';
  var assigneeStr = t.assignedToName || t.assignedTo || '—';
  return '<div class="task-row' + (t.completed ? ' done' : '') + (past ? ' past-due' : '') + '" data-task-id="' + escAttr(t.id) + '">' +
    '<input type="checkbox" class="task-check"' + (t.completed ? ' checked' : '') + ' onchange="toggleTaskComplete(\'' + escAttr(t.id) + '\', this.checked)" title="Mark complete" />' +
    '<div class="task-title" title="' + escAttr((t.description || '') + (t.createdByName ? '\nAdded by ' + t.createdByName : '')) + '">' + escH(t.title) + '</div>' +
    '<div class="task-due">' + (dueStr ? escH(dueStr) : '—') + '</div>' +
    '<div class="task-assignee" title="' + escAttr(t.assignedTo || '') + '">' + escH(assigneeStr) + '</div>' +
    '<button class="task-action" onclick="deleteTask(\'' + escAttr(t.id) + '\')" title="Delete task">✕</button>' +
  '</div>';
}

function handleTaskKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTaskFromUI();
  }
}

function addTaskFromUI() {
  var titleEl = document.getElementById('taskTitleInput');
  var dueEl   = document.getElementById('taskDueInput');
  var asnEl   = document.getElementById('taskAssigneeInput');     // hidden, holds picked email
  var asnSrch = document.getElementById('taskAssigneeSearch');    // visible text input
  var btn     = document.getElementById('taskAddBtn');
  if (!titleEl || !btn) return;
  var title = (titleEl.value || '').trim();
  if (!title) { titleEl.focus(); return; }
  var due = (dueEl && dueEl.value || '').trim();
  // Deploy 236.107 — pull canonical email from the hidden field
  // (set by pickUser when the LO chose someone from the dropdown).
  // The visible text input is a search box, not a value source.
  var asn      = (asnEl && asnEl.value || '').trim().toLowerCase();
  var asnName  = (asnEl && asnEl.dataset.name) || '';

  btn.disabled = true;
  var body = {
    clientId:       _client.id,
    loanId:         _loanId,
    title:          title,
    dueDate:        due,
    assignedTo:     asn,
    assignedToName: asnName,
  };
  var owner = _taskOwnerParam();
  if (owner) body.owner = owner;

  SLA.api('POST', '/api/tasks-save', body).then(function(resp) {
    btn.disabled = false;
    if (resp && resp.task) {
      _tasks.push(resp.task);
      renderTasksList();
      titleEl.value = '';
      if (dueEl) dueEl.value = '';
      if (asnEl)  { asnEl.value = ''; asnEl.dataset.name = ''; }
      if (asnSrch) { asnSrch.value = ''; asnSrch.classList.remove('picker-set'); }
      titleEl.focus();
    }
  }).catch(function(err) {
    btn.disabled = false;
    showToast('Failed to add task: ' + (err && err.message || 'unknown'));
  });
}

// ── Deploy 236.107 — Searchable user picker (combobox) ────────────
// Reusable on any page that loads sla-api.js. The picker structure
// is:
//   <div class="user-picker">
//     <input class="user-picker-input" ...>  (search text)
//     <input type="hidden" data-name="">      (canonical email + name)
//   </div>
// pickUser() writes to the hidden input; consumers read from it.
var _userDirectory   = null;
var _userDirLoading  = false;
function loadUserDirectory(cb) {
  if (_userDirectory) { cb && cb(_userDirectory); return; }
  if (_userDirLoading) { setTimeout(function(){ loadUserDirectory(cb); }, 80); return; }
  _userDirLoading = true;
  SLA.api('GET', '/api/users-directory').then(function(r) {
    _userDirectory = (r && r.users) || [];
    _userDirLoading = false;
    cb && cb(_userDirectory);
  }).catch(function(err) {
    console.warn('loadUserDirectory failed:', err && err.message);
    _userDirectory = [];
    _userDirLoading = false;
    cb && cb([]);
  });
}
function openUserPicker(input) {
  if (_userDirectory) {
    _renderUserPicker(input, input.value || '');
  } else {
    _showUserPickerLoading(input);
    loadUserDirectory(function() { _renderUserPicker(input, input.value || ''); });
  }
}
function _showUserPickerLoading(input) {
  var wrap = input.closest('.user-picker');
  if (!wrap) return;
  var listEl = wrap.querySelector('.user-picker-list');
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.className = 'user-picker-list';
    wrap.appendChild(listEl);
  }
  listEl.innerHTML = '<div class="user-picker-empty">Loading users…</div>';
  listEl.style.display = 'block';
  _positionUserPickerList(input, listEl);
}

// Deploy 236.111 — pin the dropdown to the input's bottom edge
// in viewport coordinates. position:fixed escapes the .section
// overflow that was clipping the list, but it also means CSS can't
// auto-align — we set top/left/width inline based on the input's
// bounding rect.
function _positionUserPickerList(input, listEl) {
  var r = input.getBoundingClientRect();
  listEl.style.top   = (r.bottom + 4) + 'px';
  listEl.style.left  = r.left + 'px';
  listEl.style.width = r.width + 'px';
}
function filterUserPicker(input) {
  // Typing in the search box clears any previously-picked value
  // so the hidden field doesn't lie about what's currently shown.
  var wrap = input.closest('.user-picker');
  var hidden = wrap && wrap.querySelector('input[type="hidden"]');
  if (hidden && hidden.value) {
    hidden.value = '';
    hidden.dataset.name = '';
    input.classList.remove('picker-set');
  }
  loadUserDirectory(function() { _renderUserPicker(input, input.value || ''); });
}
function _renderUserPicker(input, query) {
  var wrap = input.closest('.user-picker');
  if (!wrap) return;
  // Remove old list if present, then re-create.
  var listEl = wrap.querySelector('.user-picker-list');
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.className = 'user-picker-list';
    wrap.appendChild(listEl);
  }
  var q = String(query || '').toLowerCase().trim();
  var matches = (_userDirectory || []).filter(function(u) {
    if (!q) return true;
    return (u.email || '').toLowerCase().indexOf(q) >= 0 ||
           (u.name  || '').toLowerCase().indexOf(q) >= 0;
  });
  var html = '';
  // Always offer "Clear" so the LO can unassign.
  html += '<div class="user-picker-item picker-clear" onmousedown="event.preventDefault();pickUser(this,\'\',\'\')">Unassigned</div>';
  if (!matches.length) {
    html += '<div class="user-picker-empty">No matches for "' + escH(q) + '"</div>';
  } else {
    html += matches.map(function(u) {
      var safeEmail = escAttr(u.email);
      var safeName  = escAttr(u.name || '');
      return '<div class="user-picker-item" onmousedown="event.preventDefault();pickUser(this,\'' + safeEmail + '\',\'' + safeName + '\')">' +
        '<div class="up-name">' + escH(u.name || u.email) + '</div>' +
        (u.name ? '<div class="up-email">' + escH(u.email) + '</div>' : '') +
      '</div>';
    }).join('');
  }
  listEl.innerHTML = html;
  listEl.style.display = 'block';
  _positionUserPickerList(input, listEl);
}
function pickUser(itemEl, email, name) {
  var wrap = itemEl.closest('.user-picker');
  if (!wrap) return;
  var input  = wrap.querySelector('.user-picker-input');
  var hidden = wrap.querySelector('input[type="hidden"]');
  var listEl = wrap.querySelector('.user-picker-list');
  if (email) {
    input.value = name || email;
    hidden.value = email;
    hidden.dataset.name = name || '';
    input.classList.add('picker-set');
  } else {
    input.value = '';
    hidden.value = '';
    hidden.dataset.name = '';
    input.classList.remove('picker-set');
  }
  if (listEl) listEl.style.display = 'none';
}
function userPickerKeydown(e, input) {
  // Escape closes the dropdown; Enter on a focused list item picks
  // it. For a simple v1 we let the native focus/blur drive — the
  // outside-click handler below closes on blur.
  if (e.key === 'Escape') {
    var wrap = input.closest('.user-picker');
    var listEl = wrap && wrap.querySelector('.user-picker-list');
    if (listEl) listEl.style.display = 'none';
  }
}
// Close any open user-picker dropdown when clicking outside or
// when the page scrolls. Bound once at script load via event
// delegation so re-renders don't need to re-wire.
// Deploy 236.111 — scroll close is necessary now that the list
// is position:fixed; without it the dropdown would float over
// the wrong spot after the user scrolls. Capture-phase scroll
// listener catches nested scrollers (Notes sidebar, etc.) too.
(function bindUserPickerOutsideClose() {
  if (window._userPickerOutsideBound) return;
  window._userPickerOutsideBound = true;
  function closeAll() {
    document.querySelectorAll('.user-picker-list').forEach(function(el) { el.style.display = 'none'; });
  }
  document.addEventListener('click', function(e) {
    if (e.target && e.target.closest && e.target.closest('.user-picker')) return;
    closeAll();
  });
  // Deploy 236.112 — scroll close MUST skip scrolls originating
  // inside the dropdown itself, otherwise the wheel scrolling the
  // user list collapses the menu. The capture phase saw every
  // scroll, including the internal one. Filter by target.
  window.addEventListener('scroll', function(e) {
    var t = e.target;
    if (t && t.nodeType === 1) {
      if (t.classList && t.classList.contains('user-picker-list')) return;
      if (t.closest && t.closest('.user-picker-list')) return;
    }
    closeAll();
  }, true);
  window.addEventListener('resize', closeAll);
})();

function toggleTaskComplete(taskId, completed) {
  var idx = _tasks.findIndex(function(t) { return t.id === taskId; });
  if (idx < 0) return;
  var task = _tasks[idx];
  // Optimistic flip in local state so the row updates immediately.
  var prevCompleted = task.completed;
  task.completed = !!completed;
  renderTasksList();
  var body = {
    clientId: _client.id,
    loanId:   _loanId,
    taskId:   taskId,
    completed: !!completed,
  };
  var owner = _taskOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/tasks-save', body).then(function(resp) {
    if (resp && resp.task) {
      _tasks[idx] = resp.task;
      renderTasksList();
    }
  }).catch(function(err) {
    task.completed = prevCompleted;
    renderTasksList();
    showToast('Failed to update task: ' + (err && err.message || 'unknown'));
  });
}

function deleteTask(taskId) {
  if (!confirm('Delete this task? This cannot be undone.')) return;
  var idx = _tasks.findIndex(function(t) { return t.id === taskId; });
  if (idx < 0) return;
  var removed = _tasks.splice(idx, 1)[0];
  renderTasksList();
  var body = { taskId: taskId };
  var owner = _taskOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/tasks-delete', body).catch(function(err) {
    // Revert on failure.
    _tasks.splice(idx, 0, removed);
    renderTasksList();
    showToast('Failed to delete task: ' + (err && err.message || 'unknown'));
  });
}

// Deploy 227 — two-button Top/Bottom toggle. List is sorted newest-first
// so "Top" = scrollTop=0 (newest) and "Bottom" = scrollTop=scrollHeight
// (oldest including the legacy entry, if any).
function jumpNotesTo(where) {
  var list = document.getElementById('notesList');
  if (!list) return;
  if (where === 'bottom') list.scrollTop = list.scrollHeight;
  else                    list.scrollTop = 0;
  // Reflect which end is active in the button styling.
  var top = document.getElementById('noteJumpTopBtn');
  var bot = document.getElementById('noteJumpBottomBtn');
  if (top) top.classList.toggle('active', where !== 'bottom');
  if (bot) bot.classList.toggle('active', where === 'bottom');
}

function handleNoteKeydown(e) {
  // Ctrl+Enter / Cmd+Enter to submit, mirroring chat patterns LOs are
  // already familiar with.
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    addNoteFromUI();
  }
}

function addNoteFromUI() {
  var ta = document.getElementById('noteInput');
  var btn = document.getElementById('noteAddBtn');
  var stat = document.getElementById('noteStatus');
  if (!ta || !_loan || !_client) return;
  var text = String(ta.value || '').trim();
  if (!text) {
    stat.className = 'notes-status err';
    stat.textContent = 'Type a note first.';
    return;
  }
  btn.disabled = true;
  var originalLabel = btn.textContent;
  btn.textContent = 'Saving…';
  stat.className = 'notes-status';
  stat.textContent = '';

  var ownerOverride = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Loans.addNote(_client.id, _loan.id, { text: text, kind: 'manual', owner: ownerOverride }).then(function(r) {
    if (r && r.entry) {
      if (!Array.isArray(_loan.notesLog)) _loan.notesLog = [];
      _loan.notesLog.push(r.entry);
    }
    ta.value = '';
    btn.disabled = false; btn.textContent = originalLabel;
    stat.className = 'notes-status ok';
    stat.textContent = 'Note saved';
    setTimeout(function(){ if (stat.textContent === 'Note saved') stat.textContent = ''; }, 2500);
    renderNotesLog();
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = originalLabel;
    stat.className = 'notes-status err';
    stat.textContent = 'Save failed: ' + (err.message || 'unknown');
  });
}

// Item #4: LO can override the loan amount on Loan Details. Setting the
// `loanAmtLocked` flag prevents future sizer re-saves from overwriting it.
// Item #5: when LO changes loan amount, ALSO update the matching saved quote
// so downstream consumers (term sheet, rate sheet PDF) see the override.
function syncOverrideToQuote() {
  if (!_loan || !_loan.address) return Promise.resolve();
  if (!window.SLA || !SLA.Quotes) return Promise.resolve();
  // Admin viewing another LO's loan: list the OWNER's quotes, not the current
  // user's. Otherwise we'd find no match.
  var listOpts = {};
  // Deploy 236.266 — same override for processors viewing another
  // LO's loan (staff = admin OR processor).
  if (_loEmail && _user && _loEmail !== _user.email && SLA.isStaff && SLA.isStaff(_user)) {
    listOpts.all = true;
  }
  return SLA.Quotes.list(listOpts).then(function(r) {
    var quotes = (r && r.quotes) || (r && r.byOwner ? Object.values(r.byOwner).flat() : []);
    var targetFull = String(_loan.address).toLowerCase().trim();
    var targetStreet = targetFull.split(',')[0].trim().replace(/\s+/g, ' ');
    // Match by full address first, then fall back to street-segment
    var match = quotes.find(function(q) {
      return String(q.address || '').toLowerCase().trim() === targetFull;
    });
    if (!match) {
      match = quotes.find(function(q) {
        var qFull = String(q.address || '').toLowerCase().trim();
        var qStreet = qFull.split(',')[0].trim().replace(/\s+/g, ' ');
        return qStreet && targetStreet && qStreet === targetStreet;
      });
    }
    if (!match) {
      console.warn('syncOverrideToQuote: no matching quote for', _loan.address);
      return;
    }
    // Update both top-level loanAmt and formData.loanAmt
    var updated = Object.assign({}, match);
    if (!updated.formData) updated.formData = {};
    updated.formData.loanAmt = _loan.loanAmt;
    updated.formData.loanAmtLocked = !!_loan.loanAmtLocked;
    updated.loanAmt = _loan.loanAmt;
    updated.updatedAt = new Date().toISOString();
    if (_loEmail && _user && _loEmail !== _user.email) updated._owner = _loEmail;
    return SLA.Quotes.save(updated);
  }).catch(function(err) {
    console.warn('syncOverrideToQuote failed:', err);
  });
}

// Item #4: revert override back to the sizer-computed max loan amount
function resetLoanAmtToMax() {
  if (!_loan || !_client) return;
  if (!_loan.maxLoan) { showToast('No max loan on file'); return; }
  if (!confirm('Reset loan amount to maximum allowable from sizer?\n\n$' + Math.round(parseFloat(_loan.maxLoan)).toLocaleString())) return;
  _loan.loanAmt = String(_loan.maxLoan);
  _loan.loanAmtLocked = false;
  _loan.updatedAt = new Date().toISOString();
  persistClient().then(function() {
    return syncOverrideToQuote();
  }).then(function() {
    showToast('Loan amount reset to maximum');
    if (typeof render === 'function') render();
  }).catch(function(err) {
    showToast('Reset failed: ' + (err.message || 'unknown'));
  });
}

function overrideLoanAmt() {
  if (!_loan || !_client) return;
  var displayEl = document.getElementById('loanAmtDisplay');
  var heroEl    = displayEl ? displayEl.closest('.loan-hero') : null;
  if (!displayEl) return;
  var btn = heroEl.querySelector('.loan-hero-edit');
  // Replace display with input, swap button to Save
  var current = (_loan.loanAmt || '').toString().replace(/[^0-9.]/g, '');
  displayEl.outerHTML = '<input type="number" min="0" step="1000" id="loanAmtInput" class="loan-hero-input" value="' + current + '" />';
  btn.textContent = 'Save';
  btn.onclick = function() {
    var input = document.getElementById('loanAmtInput');
    var newAmt = (input.value || '').toString();
    if (!newAmt) { showToast('Enter a loan amount'); return; }
    _loan.loanAmt = newAmt;
    _loan.loanAmtLocked = true;
    _loan.updatedAt = new Date().toISOString();
    persistClient().then(function() {
      return syncOverrideToQuote();
    }).then(function() {
      showToast('Loan amount overridden — saved');
      // Re-render the page so the hero shows the locked badge
      if (typeof render === 'function') render();
    }).catch(function(err) {
      showToast('Save failed: ' + (err.message || 'unknown'));
    });
  };
}

// Save the current _client back via SLA.Clients.save, ensuring _loan changes
// are persisted to the parent client record.
function persistClient() {
  // Find the matching loan in client.loans and replace it
  if (!_client.loans) _client.loans = [];
  var idx = _client.loans.findIndex(function(l){ return l.id === _loan.id; });
  if (idx >= 0) _client.loans[idx] = _loan;
  else _client.loans.unshift(_loan);
  var saveOpts = _client;
  if (_loEmail && _user && _loEmail !== _user.email) {
    saveOpts = Object.assign({}, _client, { _owner: _loEmail });
  }
  return SLA.Clients.save(saveOpts);
}

// Deploy 236.327 — flip a broker loan back to a standard deal.
// Clears the broker flag + all broker contact fields on the server;
// server appends an audit note to the loan's notesLog. Confirmation
// only — no undo modal, so the audit trail is the recovery path.
function convertBrokerLoanToStandard() {
  if (!_loan || !_client) return;
  // Deploy 236.328 — allow any loan with broker contact info, not
  // just those with the explicit _isBrokerLoan flag. Legacy loans
  // predate the flag but still show up as broker deals visually.
  var hasBrokerInfo = _loan._isBrokerLoan
    || (_loan.brokerName    && String(_loan.brokerName).trim())
    || (_loan.brokerEmail   && String(_loan.brokerEmail).trim())
    || (_loan.brokerCompany && String(_loan.brokerCompany).trim())
    || (_loan.brokerId      && String(_loan.brokerId).trim())
    || (parseFloat(_loan.brokerFee || 0) > 0);
  if (!hasBrokerInfo) {
    showToast('This loan has no broker info to remove.');
    return;
  }
  var brokerName = _loan.brokerName || _loan.brokerCompany || 'broker';
  if (!confirm(
    'Remove the broker from this loan?\n\n' +
    'This will:\n' +
    '  • Clear the broker contact info (' + brokerName + ')\n' +
    '  • Remove the broker flag\n' +
    '  • Add an audit-log entry\n\n' +
    'The Broker Info section will disappear from Loan Details. If you need to add a broker back later, open the sizer and toggle "Broker Deal" on.'
  )) return;
  var payload = { clientId: _clientId, loanId: _loanId, isBroker: false };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-set-broker-flag', payload).then(function(r) {
    if (!r || !r.loan) { showToast('Failed to remove broker: server returned no loan.'); return; }
    _loan = r.loan;
    var lidx = (_client && _client.loans || []).findIndex(function(x) { return x && x.id === _loanId; });
    if (lidx >= 0) _client.loans[lidx] = r.loan;
    showToast('Broker removed.');
    render();
  }).catch(function(err) {
    showToast('Failed to remove broker: ' + (err && err.message || 'unknown'));
  });
}

// Deploy 236.339 — save the Servicing Info section (maturity date,
// servicer name, servicer URL). Server does the URL sanity check +
// audit-log entry; on success we splice the returned loan into the
// local client + re-render so the Servicer button URL / Maturity
// display update immediately.
function saveServicingFields() {
  if (!_loan || !_client) return;
  var _sv = function(id){ return (document.getElementById(id) || {}).value || ''; };
  var payload = {
    clientId: _clientId,
    loanId:   _loanId,
    maturityDate: _sv('sv-maturityDate'),
    servicerName: _sv('sv-servicerName'),
    servicerUrl:  _sv('sv-servicerUrl'),
    // Deploy 236.618 — the rest of the servicing fields (shared with the Closed Loans page).
    servicerLoanNumber: _sv('sv-servicerLoanNumber'),
    paymentAmount:      _sv('sv-paymentAmount'),
    upb:                _sv('sv-upb'),
    payoffAmount:       _sv('sv-payoffAmount'),
    payoffDate:         _sv('sv-payoffDate'),
    investorName:       _sv('sv-investorName'),
    soldRate:           _sv('sv-soldRate'),
    soldDate:           _sv('sv-soldDate'),
    // Deploy 236.622 — collateral tracking (3 docs × date + location).
    signedOriginalsDate:     _sv('sv-signedOriginalsDate'),
    signedOriginalsLocation: _sv('sv-signedOriginalsLocation'),
    signedOriginalsTracking: _sv('sv-signedOriginalsTracking'),
    recordedDotDate:         _sv('sv-recordedDotDate'),
    recordedDotLocation:     _sv('sv-recordedDotLocation'),
    recordedDotTracking:     _sv('sv-recordedDotTracking'),
    titlePolicyDate:         _sv('sv-titlePolicyDate'),
    titlePolicyLocation:     _sv('sv-titlePolicyLocation'),
    titlePolicyTracking:     _sv('sv-titlePolicyTracking'),
  };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  var status = document.getElementById('servicingStatus');
  var btn = document.querySelector('#servicingSection .save-app-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  SLA.api('POST', '/api/loan-servicing-set', payload).then(function(r) {
    if (!r || !r.loan) { showToast('Servicing save failed: server returned no loan.'); return; }
    _loan = r.loan;
    var lidx = (_client && _client.loans || []).findIndex(function(x) { return x && x.id === _loanId; });
    if (lidx >= 0) _client.loans[lidx] = r.loan;
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    if (status) { status.style.display = ''; setTimeout(function(){ status.style.display = 'none'; }, 2200); }
    render();
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
    showToast('Servicing save failed: ' + (err && err.message || 'unknown'));
  });
}

// Deploy 236.641 — saveAppFields is now ONLY the Broker Info (Contacts tab)
// save. The property/application fields it used to write moved to the Property
// tab (savePropertyCollateral) and the Loan Terms box (saveLoanTerms); leaving
// them here would double-write via the whole-client path and clobber unsaved
// edits in those tabs. Broker Fee stays out — that's a sizer pricing decision.
function saveAppFields() {
  if (!_loan || !_client) return;
  var bn = document.getElementById('af-brokerName');
  if (!bn) { showToast('Nothing to save here'); return; }
  var appFields = {
    brokerName:    bn.value.trim(),
    brokerCompany: (document.getElementById('af-brokerCompany')||{value:''}).value.trim(),
    brokerEmail:   (document.getElementById('af-brokerEmail')  ||{value:''}).value.trim().toLowerCase(),
    brokerPhone:   (document.getElementById('af-brokerPhone')  ||{value:''}).value.trim(),
    updatedAt:     new Date().toISOString(),
  };

  // Update the loan inside the client and save the whole client back
  var loans = _client.loans || [];
  var idx = loans.findIndex(function(l){ return l.id === _loanId; });
  if (idx < 0) return;
  loans[idx] = Object.assign({}, loans[idx], appFields);
  _loan = loans[idx];
  _client.loans = loans;

  var saveOpts = _client;
  if (_loEmail && _user && _loEmail !== _user.email) {
    saveOpts = Object.assign({}, _client, { _owner: _loEmail });
  }
  SLA.Clients.save(saveOpts).then(function() {
    var s = document.getElementById('appStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function(){ s.style.display = 'none'; }, 2500); }
    showToast('Broker info saved');
  }).catch(function(err) {
    showToast('Save failed: ' + (err.message || 'unknown error'));
  });
}

// Deploy 236.702 — save the General Contractor contact (GUC loans). Mirrors
// saveAppFields (whole-client save through SLA.Clients.save), writing the gc*
// fields onto the loan record.
function saveGcContact() {
  if (!_loan || !_client) return;
  var gn = document.getElementById('af-gcName');
  if (!gn) { showToast('Nothing to save here'); return; }
  var fields = {
    gcName:    gn.value.trim(),
    gcCompany: (document.getElementById('af-gcCompany') || { value: '' }).value.trim(),
    gcEmail:   (document.getElementById('af-gcEmail')   || { value: '' }).value.trim().toLowerCase(),
    gcPhone:   (document.getElementById('af-gcPhone')   || { value: '' }).value.trim(),
    gcLicense: (document.getElementById('af-gcLicense') || { value: '' }).value.trim(),
    updatedAt: new Date().toISOString(),
  };
  var loans = _client.loans || [];
  var idx = loans.findIndex(function(l){ return l.id === _loanId; });
  if (idx < 0) return;
  loans[idx] = Object.assign({}, loans[idx], fields);
  _loan = loans[idx];
  _client.loans = loans;
  var saveOpts = _client;
  if (_loEmail && _user && _loEmail !== _user.email) {
    saveOpts = Object.assign({}, _client, { _owner: _loEmail });
  }
  SLA.Clients.save(saveOpts).then(function() {
    var s = document.getElementById('gcStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function(){ s.style.display = 'none'; }, 2500); }
    showToast('General Contractor saved');
  }).catch(function(err) {
    showToast('Save failed: ' + (err.message || 'unknown error'));
  });
}

// ── Deploy 236.477 — Funding Plan box handlers ──────────────────────
// Show/hide the one-time "Other source" free-text when the Funding
// Source dropdown is (or isn't) set to "Other".
function onFundingSourceChange() {
  var srcEl = document.getElementById('fp-fundingSource');
  var wrap  = document.getElementById('fp-otherWrap');
  if (!srcEl || !wrap) return;
  wrap.style.display = (srcEl.value === 'other') ? '' : 'none';
}

// Load the org-wide Investors book and fill the Investor dropdown,
// preserving the loan's current selection. If the current investor was
// deleted from the book, keep a "(removed)" stub so the value + name
// still render. Non-blocking; failures leave the seeded option in place.
function populateFundingPlanInvestors() {
  var sel = document.getElementById('fp-investorId');
  if (!sel || !window.SLA || !SLA.Investors || typeof SLA.Investors.list !== 'function') return;
  var current = sel.getAttribute('data-current') || '';
  SLA.Investors.list().then(function(r) {
    var list = (r && r.investors) || [];
    var html = '<option value="">— None —</option>';
    var found = false;
    for (var i = 0; i < list.length; i++) {
      var inv = list[i];
      if (!inv || !inv.id) continue;
      var idStr = String(inv.id);
      // Deploy 236.478 — show the loan types the investor buys (was company).
      var _lt = (Array.isArray(inv.loanTypes) && inv.loanTypes.length) ? ' (' + inv.loanTypes.join(', ') + ')' : '';
      var label = String(inv.name || 'Investor') + _lt;
      var isCur = (idStr === current);
      if (isCur) found = true;
      html += '<option value="' + escAttr(idStr) + '"' + (isCur ? ' selected' : '') + '>' + escH(label) + '</option>';
    }
    if (current && !found) {
      var nm = (_loan && _loan.investorName) || 'Selected investor';
      html += '<option value="' + escAttr(current) + '" selected>' + escH(nm + ' (removed)') + '</option>';
    }
    sel.innerHTML = html;
  }).catch(function() { /* leave seeded option */ });
}

// Persist the Funding Plan onto the loan. Whole-client save (same path
// as saveAppFields) — no dedicated endpoint needed. DSCR stores tpo,
// RTL stores buyRate; the "Other" free-text is only kept when Other is
// the selected source. investorName is snapshotted from the picked
// option so it survives the investor being removed from the book.
function saveFundingPlan() {
  if (!_loan || !_client) return;
  var srcEl   = document.getElementById('fp-fundingSource');
  var otherEl = document.getElementById('fp-fundingSourceOther');
  var invEl   = document.getElementById('fp-investorId');
  var priceEl = document.getElementById('fp-pricing');
  if (!srcEl) return;
  // Match render()'s isDscr (line ~669) EXACTLY so the stored pricing
  // key (tpo vs buyRate) always agrees with the label the box showed.
  var isDscr = _isDscrTool(_loan.toolType);
  var src = srcEl.value || '';
  var invName = '';
  if (invEl && invEl.value && invEl.options[invEl.selectedIndex]) {
    invName = invEl.options[invEl.selectedIndex].text || '';
    invName = invName.replace(/ \(removed\)$/, '');
  }
  var fields = {
    fundingSource:      src,
    fundingSourceOther: (src === 'other' && otherEl) ? otherEl.value.trim() : '',
    investorId:         invEl ? invEl.value : '',
    investorName:       invName,
  };
  var priceRaw = priceEl ? priceEl.value.trim() : '';
  if (isDscr) fields.tpo = priceRaw; else fields.buyRate = priceRaw;

  // Deploy 236.672 — was SLA.Clients.save (the brittle upsert that silently dropped
  // these fields). Now the deterministic clientId+loanId write, exactly like Loan
  // Terms / Property so it actually persists.
  var btn = document.querySelector('#fundingPlanSection .save-app-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  SLA.Loans.saveFields(_clientId, _loanId, fields, _ldOwnerOverride()).then(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Funding Plan'; }
    _ldMergeLoan(fields);
    var s = document.getElementById('fundingPlanStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function(){ s.style.display = 'none'; }, 2500); }
    showToast('Funding plan saved');
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Funding Plan'; }
    showToast('Funding plan save failed: ' + (err && err.message || 'unknown error'));
  });
}

// ── Deploy 236.640 — Loan Terms + Property/Collateral saves ──────────
// Both POST to /api/loan-fields-save (SLA.Loans.saveFields) — the
// deterministic clientId+loanId write, staff-only server-side. On success
// we merge the applied fields into the in-memory _loan/_client so re-renders
// + sibling sections stay consistent without a full refetch. Carrying costs
// are stored MONTHLY regardless of the display toggle.
var _pcCarryMode = 'monthly';

// ── Deploy 236.641 — Loan Terms auto-derivation date helpers ─────────
// Used by render() to fill blank term dates from the sizer/loan. Parse
// YYYY-MM-DD only (the value of <input type="date">); return the same.
function _ldParseYmd(s) {
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}
function _ldToYmd(d) {
  if (!d || isNaN(d.getTime())) return '';
  var mm = String(d.getMonth() + 1); if (mm.length < 2) mm = '0' + mm;
  var dd = String(d.getDate());      if (dd.length < 2) dd = '0' + dd;
  return d.getFullYear() + '-' + mm + '-' + dd;
}
// Add N calendar months to a YYYY-MM-DD (day-of-month preserved; JS Date
// rolls day overflow forward, which is fine for our term/maturity math).
function _addMonths(ymd, months) {
  var d = _ldParseYmd(ymd);
  if (!d || !isFinite(months)) return '';
  d.setMonth(d.getMonth() + months);
  return _ldToYmd(d);
}
// First payment = the 1st of the month two months out from the origination/
// closing date (e.g. close Aug 20 → first payment Oct 1) — the standard
// full-month-plus convention, matching the closed-loans first-payment logic.
function _computeFirstPayment(ymd) {
  var d = _ldParseYmd(ymd);
  if (!d) return '';
  return _ldToYmd(new Date(d.getFullYear(), d.getMonth() + 2, 1, 12, 0, 0));
}
// Deploy 236.644 — keep the non-editable First Payment + Maturity fields in
// sync with the current Closing Date + Loan Term inputs (wired to their oninput).
function recalcTermDates() {
  var closing = _ldVal('af-fundingDate');
  var term = _ldNum('lt-loanTerm');
  var fp = document.getElementById('lt-firstPaymentDate');
  var mt = document.getElementById('lt-maturityDate');
  if (fp) fp.value = _computeFirstPayment(closing) || '';
  if (mt) mt.value = _addMonths(closing, parseInt(term, 10)) || '';
}

function _ldOwnerOverride() {
  return (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
}
function _ldMergeLoan(fields) {
  if (!_client || !Array.isArray(_client.loans)) return;
  var idx = _client.loans.findIndex(function(l){ return l.id === _loanId; });
  if (idx < 0) return;
  _client.loans[idx] = Object.assign({}, _client.loans[idx], fields);
  _loan = _client.loans[idx];
}
// Read a numeric field — strip currency/formatting, keep digits/./-.
function _ldNum(id) {
  var el = document.getElementById(id);
  if (!el) return '';
  return String(el.value == null ? '' : el.value).replace(/[^0-9.\-]/g, '').trim();
}
function _ldVal(id) {
  var el = document.getElementById(id);
  return el ? String(el.value == null ? '' : el.value).trim() : '';
}
// Deploy 236.672 — USD display for the editable money fields on the Property tab
// (As-Is Value, AIV/ARV BPO, Existing Debt, Taxes, Insurance, HOA). Format on blur
// ($1,234.56), strip to a plain number on focus for easy editing. The savers
// (_ldNum / _pcCarryMonthly) already strip non-numeric, so this is persist-safe.
function _ldUsdInput(v) {
  var raw = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
  if (raw === '' || raw === '-' || raw === '.') return '';
  var n = parseFloat(raw);
  if (!isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
// Deploy 236.767 (Mike) — this loan's PROGRAM MAX LTARV, as a percent (e.g. 75).
// Read from the LIVE Colchis tables in rtl-pricing.js (SLA_RTL) so the ceiling
// can never drift from what the sizer priced against — pricing constants are
// never duplicated here. LTARV only applies to rehab loans (light/heavy); bridge
// and transactional have no ARV path, so they return 0 (= no cap, no flag).
// If the FICO/experience tier can't be resolved we fall back to 75%, matching
// the ceiling the Loan Financials editor has always warned on.
function _ldMaxLtarvPct(l, fico, experience) {
  try {
    var R = (typeof window !== 'undefined') ? window.SLA_RTL : null;
    var lt = String((l && l.loanType) || '').toLowerCase();
    if (lt !== 'light' && lt !== 'heavy') return 0;
    if (!R || !R.MAX_LTARV || typeof R.fk !== 'function' || typeof R.ei !== 'function') return 75;
    var ptRaw = String((l && l.propType) || '').toLowerCase();
    var pt = (ptRaw === 'mfr' || ptRaw === 'multi') ? 'mfr' : 'sfr';
    var f = parseFloat(fico) || 0;
    var e = parseFloat(experience) || 0;
    if (!f) return 75;
    var tbl = R.MAX_LTARV[lt] && R.MAX_LTARV[lt][pt] && R.MAX_LTARV[lt][pt][R.fk(f)];
    var dec = tbl ? tbl[R.ei(e)] : 0;
    return (dec > 0) ? dec * 100 : 75;
  } catch (err) { return 75; }
}

// Deploy 236.767 (Mike) — AIV/ARV BPO are read straight off the uploaded BPO,
// so the inputs are locked. Clicking one explains why instead of silently
// ignoring the click. Attributes are built here so the markup stays readable.
function _BPO_LOCK_ATTRS(label) {
  return ' readonly title="Read from the uploaded BPO — upload a corrected BPO to change it."' +
    ' onclick="_ldBpoLocked(\'' + label + '\')" onfocus="this.blur();_ldBpoLocked(\'' + label + '\')"' +
    ' style="background:var(--bg,#f0ece5);color:var(--muted);cursor:not-allowed"';
}
function _ldBpoLocked(label) {
  alert(label + ' is read directly from the uploaded BPO and can\'t be edited here.\n\n' +
    'It drives LTAIV and BPO LTARV, so it has to match the BPO on file. ' +
    'To change it, upload a corrected BPO in the Documents tab.');
}

function _ldMoneyFocus(el) { if (el) el.value = String(el.value == null ? '' : el.value).replace(/[^0-9.\-]/g, ''); }
function _ldMoneyBlur(el)  { if (el) el.value = _ldUsdInput(el.value); }
function _pcFmt(n) {
  // Carrying-cost display (also used by the monthly/annual toggle) — now USD.
  return _ldUsdInput(n);
}
// Keep each carrying input's canonical MONTHLY value on data-monthly as the
// user edits, so the monthly/annual toggle never accumulates rounding error.
function pcCarryInput(el) {
  if (!el) return;
  var raw = String(el.value == null ? '' : el.value).replace(/[^0-9.\-]/g, '').trim();
  if (raw === '') { el.setAttribute('data-monthly', ''); return; }
  var v = parseFloat(raw);
  if (!isFinite(v)) { el.setAttribute('data-monthly', ''); return; }
  var monthly = (_pcCarryMode === 'annual') ? v / 12 : v;
  el.setAttribute('data-monthly', String(Math.round(monthly * 100) / 100));
}
// Toggle the display between monthly and annual. Recomputes each input from
// its data-monthly base (×12 for annual) so repeated toggles are lossless.
function pcCarryToggle(mode) {
  _pcCarryMode = (mode === 'annual') ? 'annual' : 'monthly';
  var annual = _pcCarryMode === 'annual';
  var ids = ['pc-taxes', 'pc-insurance', 'pc-hoa'];
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (!el) continue;
    var dm = el.getAttribute('data-monthly');
    if (dm == null || dm === '') { el.value = ''; continue; }
    var base = parseFloat(dm) || 0;
    el.value = _pcFmt(annual ? base * 12 : base);
  }
  var mb = document.getElementById('pc-carryMonthlyBtn');
  var ab = document.getElementById('pc-carryAnnualBtn');
  if (mb && ab) {
    if (annual) { ab.classList.add('active'); mb.classList.remove('active'); }
    else { mb.classList.add('active'); ab.classList.remove('active'); }
  }
  var lbl = document.getElementById('pc-carryModeLabel');
  if (lbl) lbl.textContent = annual ? '(annual)' : '(monthly)';
}
// The monthly value to persist for a carrying-cost field (data-monthly is kept
// current by pcCarryInput; fall back to converting the raw display).
function _pcCarryMonthly(id) {
  var el = document.getElementById(id);
  if (!el) return '';
  var dm = el.getAttribute('data-monthly');
  if (dm != null && dm !== '') return String(dm);
  var raw = String(el.value == null ? '' : el.value).replace(/[^0-9.\-]/g, '').trim();
  if (raw === '') return '';
  var v = parseFloat(raw);
  if (!isFinite(v)) return '';
  return String(Math.round((_pcCarryMode === 'annual' ? v / 12 : v) * 100) / 100);
}

// Deploy 236.750 — MF Operating Statement save (Multifamily 5+ loans).
function saveMfOpex() {
  if (!_loan || !_client) return;
  var ids = ['numUnits','unitsOccupied','rent','otherIncomeMo','vacancyPct','opexTaxes','opexInsurance',
    'opexFlood','opexUtilities','opexRepairs','opexMgmt','opexHOA','opexLandscaping'];
  var fields = {};
  ids.forEach(function (k) {
    var el = document.getElementById('mfx-' + k);
    if (el && !el.disabled) fields[k] = el.value;
  });
  // Deploy 236.759 — the MF box carries the Valuation fields now (the
  // Property/Collateral box doesn't render for MF loans). Send them only
  // when the inputs exist so older cached pages don't clobber to 0.
  ['propValue', 'aivBpo', 'currentLoanAmt'].forEach(function (k) {
    var el = document.getElementById('pc-' + k);
    if (el) fields[k] = _ldNum('pc-' + k);
  });
  var btn = document.querySelector('#mfOpexSection .save-app-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  SLA.Loans.saveFields(_clientId, _loanId, fields, _ldOwnerOverride()).then(function () {
    if (btn) { btn.disabled = false; btn.textContent = 'Save MF Operating Statement'; }
    _ldMergeLoan(fields);
    var s = document.getElementById('mfOpexStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function () { s.style.display = 'none'; }, 2500); }
    showToast('MF operating statement saved');
  }).catch(function (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save MF Operating Statement'; }
    showToast('Save failed: ' + (err && err.message || 'unknown error'));
  });
}

function saveLoanTerms() {
  if (!_loan || !_client) return;
  var isDscr = _isDscrTool(_loan.toolType);
  // Deploy 236.644 — Origination Date === Closing Date; First Payment + Maturity
  // are non-editable and recomputed here from Closing Date + Loan Term so a save
  // always persists dates consistent with the current inputs. Prepay removed.
  var _closing = _ldVal('af-fundingDate');
  var _termN = _ldNum('lt-loanTerm');
  var fields = {
    loanTerm:         _termN,
    lienPosition:     _ldVal('lt-lienPosition'),
    originationDate:  _closing,
    firstPaymentDate: _computeFirstPayment(_closing) || '',
    maturityDate:     _addMonths(_closing, parseInt(_termN, 10)) || '',
    // Deploy 236.641 — Loan Purpose / Closing Date / Description moved into
    // the Loan Terms box from the retired Property & Application section.
    loanPurpose:        _ldVal('af-loanPurpose'),
    fundingDate:        _closing,
    projectDescription: _ldVal('af-projectDescription'),
  };
  // Amortization: only send when explicitly chosen — a blank select must not
  // stamp isIO=false (the backend's _truthy('') would wrongly mark amortized).
  var amort = _ldVal('lt-isIO');
  if (amort === 'io' || amort === 'amortized') fields.isIO = amort;
  // Deploy 236.713 — Interest Structure (RTL/GUC only; element absent on DSCR).
  var dEl = document.getElementById('lt-dutchInterest');
  if (dEl && (dEl.value === 'dutch' || dEl.value === 'non_dutch')) fields.dutchInterest = dEl.value;
  // Deploy 236.647 — Holdback / Initial Advance / Down Payment removed from Loan
  // Terms (see render). Initial Advance + Down Payment are derived/shown in Loan
  // Financials; Holdback == Rehab Budget.
  var btn = document.querySelector('#loanTermsSection .save-app-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  SLA.Loans.saveFields(_clientId, _loanId, fields, _ldOwnerOverride()).then(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Loan Terms'; }
    var merged = Object.assign({}, fields);
    if (fields.isIO === 'io') merged.isIO = true;
    else if (fields.isIO === 'amortized') merged.isIO = false;
    else delete merged.isIO;
    _ldMergeLoan(merged);
    var s = document.getElementById('loanTermsStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function(){ s.style.display = 'none'; }, 2500); }
    showToast('Loan terms saved');
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Loan Terms'; }
    showToast('Save failed: ' + (err && err.message || 'unknown error'));
  });
}

function savePropertyCollateral() {
  if (!_loan || !_client) return;
  var isDscr = _isDscrTool(_loan.toolType);
  var fields = {
    // Physical fields moved from the retired Property & Application box (af-* ids)
    bedrooms:         _ldNum('af-bedrooms'),
    bathrooms:        _ldNum('af-bathrooms'),
    sqft:             _ldNum('af-sqft'),
    propType:         _ldVal('af-propType'),
    rentalType:       _ldVal('af-rentalType'),
    numUnits:         _ldNum('pc-numUnits'),
    yearBuilt:        _ldNum('pc-yearBuilt'),
    stories:          _ldNum('pc-stories'),
    lotSize:          _ldNum('pc-lotSize'),
    propertyCounty:   _ldVal('pc-propertyCounty'),
    floodZone:        _ldVal('pc-floodZone'),
    purchaseDate:     _ldVal('pc-purchaseDate'),
    propValue:        _ldNum('pc-propValue'),
    aivBpo:           _ldNum('pc-aivBpo'),
    currentLoanAmt:   _ldNum('pc-currentLoanAmt'),
    monthlyTaxes:     _pcCarryMonthly('pc-taxes'),
    monthlyInsurance: _pcCarryMonthly('pc-insurance'),
    monthlyHoa:       _pcCarryMonthly('pc-hoa'),
  };
  if (!isDscr) fields.arvBpo = _ldNum('pc-arvBpo');
  // Deploy 236.655 — Portfolio: the loan-level Beds/Baths/SqFt fields aren't
  // rendered (they live per-property), so don't send them (would clobber to 0).
  // Collect the per-property tabs and persist the array + count instead.
  if (_loan.isPortfolio) {
    delete fields.bedrooms; delete fields.bathrooms; delete fields.sqft;
    var _pfProps = pfCollect();
    fields.isPortfolio   = true;
    // Deploy 236.691 — a portfolio loan's Property Type is always 'portfolio'
    // (the single-property af-propType select isn't rendered in portfolio mode,
    // so set it explicitly instead of clobbering it to empty).
    fields.propType      = 'portfolio';
    fields.propertyCount = _pfProps.length;
    fields.properties    = _pfProps;
    // Deploy 236.691 — persist the reprice-as-portfolio flag set at conversion.
    if (_loan.needsRepricePortfolio) fields.needsRepricePortfolio = true;
  }
  var btn = document.querySelector('#propertyCollateralSection .save-app-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  SLA.Loans.saveFields(_clientId, _loanId, fields, _ldOwnerOverride()).then(function() {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Property / Collateral'; }
    _ldMergeLoan(fields);
    var s = document.getElementById('propCollStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function(){ s.style.display = 'none'; }, 2500); }
    showToast('Property / collateral saved');
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Property / Collateral'; }
    showToast('Save failed: ' + (err && err.message || 'unknown error'));
  });
}

// Deploy 236.688 — convert an existing single-property loan into a Portfolio.
// Seeds Property 1 from the loan's current single-property fields, flips the
// loan into portfolio mode IN MEMORY (not persisted until the user clicks Save
// Property / Collateral), re-renders, and lands on the Property tab so they can
// add the remaining properties. Reversible — navigating away without saving
// leaves the loan as a single property.
function convertToPortfolio() {
  if (!_loan || _loan.isPortfolio) return;
  var _wasPortfolioPriced = (String(_loan.propType || '').toLowerCase() === 'portfolio');
  var _msg = 'Convert this loan to a Portfolio?\n\nThe loan’s current property becomes Property 1, and you can add more below. Nothing is saved until you click "Save Property / Collateral".';
  if (!_wasPortfolioPriced) {
    _msg += '\n\n⚠ This loan was priced as "' + (_propTypeLabel(_loan) || _loan.propType || 'a single property') + '", not a Portfolio. It will be FLAGGED to be re-priced as a Portfolio so it doesn’t advance with the wrong pricing.';
  }
  if (!confirm(_msg)) return;
  var ptMap = { sfr: 'sfh', sfh: 'sfh', '2-4': '2-4' };
  var p1 = {
    address:          _loan.address || '',
    propType:         ptMap[String(_loan.propType || '').toLowerCase()] || '',
    bedrooms:         String(_loan.bedrooms || ''),
    bathrooms:        String(_loan.bathrooms || ''),
    sqft:             String(_loan.sqft || ''),
    propValue:        String(_loan.propValue || ''),
    appraisedValue:   String(_loan.aivBpo || ''),
    existingDebt:     String(_loan.currentLoanAmt || _loan.existingLoanAmt || ''),
    monthlyRent:      String(_loan.monthlyRent || _loan.rent || ''),
    monthlyTaxes:     String(_loan.monthlyTaxes || _loan.taxes || ''),
    monthlyInsurance: String(_loan.monthlyInsurance || _loan.insurance || ''),
    monthlyHoa:       String(_loan.monthlyHoa || _loan.hoa || ''),
  };
  _loan.isPortfolio   = true;
  _loan.propType      = 'portfolio';
  _loan.properties    = [p1];
  _loan.propertyCount = 1;
  // Deploy 236.691 — flag for repricing when it wasn't already priced as a
  // Portfolio, so it can't quietly advance on single-property pricing.
  if (!_wasPortfolioPriced) _loan.needsRepricePortfolio = true;
  render();
  if (typeof switchLdTab === 'function') switchLdTab('property');
  showToast(_wasPortfolioPriced
    ? 'Converted to Portfolio — add your other properties, then click Save Property / Collateral.'
    : '⚠ Converted to Portfolio — FLAGGED to be re-priced as a Portfolio. Add properties + Save.');
}

// Deploy 236.691 — clear the reprice-as-portfolio flag (after confirming pricing).
function dismissRepriceFlag() {
  if (!_loan || !_loan.needsRepricePortfolio) return;
  if (!confirm('Clear the “Reprice as Portfolio” flag?\n\nOnly do this once you’ve confirmed the loan is correctly priced as a portfolio.')) return;
  _loan.needsRepricePortfolio = false;
  SLA.Loans.saveFields(_clientId, _loanId, { needsRepricePortfolio: false }, _ldOwnerOverride()).then(function() {
    showToast('Reprice flag cleared.');
    render();
  }).catch(function(err) {
    _loan.needsRepricePortfolio = true;
    showToast('Failed to clear: ' + (err && err.message || 'unknown'));
    render();
  });
}

// ── Deploy 236.655 — Portfolio properties (multi-property loans) ──────
// Rendered inside the Property / Collateral section for loans where
// loan.isPortfolio is true. Numbered tabs 1..N (each a full property
// form) plus a read-only "Portfolio Total" tab that live-sums the
// numeric fields. Add/Remove controls change the tab count. The tabs are
// collected + persisted by savePropertyCollateral() (one save button).
var _pfActive = 0;

function _pfPanelHtml(i, p, active) {
  p = p || {};
  function opt(v, o, lbl) { return '<option value="' + o + '"' + (v === o ? ' selected' : '') + '>' + lbl + '</option>'; }
  var pt = String(p.propType || '');
  return '<div class="pf-panel pf-prop-panel" id="pf-panel-' + i + '" data-idx="' + i + '" style="display:' + (active ? 'block' : 'none') + '">' +
    '<div class="app-grid">' +
      '<div class="field" style="grid-column:1/-1"><label>Address</label><input type="text" id="pfp_' + i + '_address" value="' + escAttr(p.address || '') + '" placeholder="123 Main St, City, ST 00000" /></div>' +
      '<div class="field"><label>Property Type</label><select id="pfp_' + i + '_propType">' +
        '<option value="">Select…</option>' + opt(pt, 'sfh', 'Single Family') + opt(pt, '2-4', '2–4 Unit') +
      '</select></div>' +
      '<div class="field"><label>Bedrooms</label><input type="number" id="pfp_' + i + '_bedrooms" min="0" value="' + escAttr(p.bedrooms || '') + '" oninput="pfRecalcTotals()" /></div>' +
      '<div class="field"><label>Bathrooms</label><input type="number" id="pfp_' + i + '_bathrooms" min="0" step="0.5" value="' + escAttr(p.bathrooms || '') + '" oninput="pfRecalcTotals()" /></div>' +
      '<div class="field"><label>Sq Footage</label><input type="number" id="pfp_' + i + '_sqft" min="0" value="' + escAttr(p.sqft || '') + '" oninput="pfRecalcTotals()" /></div>' +
      // Deploy 236.657 — per-property valuation (Mike): Property Value, Appraised
      // Value, Existing Debt. Summed on the Portfolio Total tab.
      '<div class="field"><label>Property Value</label><input type="text" inputmode="decimal" id="pfp_' + i + '_propValue" value="' + escAttr(p.propValue || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
      '<div class="field"><label>Appraised Value</label><input type="text" inputmode="decimal" id="pfp_' + i + '_appraisedValue" value="' + escAttr(p.appraisedValue || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
      '<div class="field"><label>Existing Debt</label><input type="text" inputmode="decimal" id="pfp_' + i + '_existingDebt" value="' + escAttr(p.existingDebt || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
      '<div class="field"><label>Monthly Rent</label><input type="text" inputmode="decimal" id="pfp_' + i + '_monthlyRent" value="' + escAttr(p.monthlyRent || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
      '<div class="field"><label>Monthly Taxes</label><input type="text" inputmode="decimal" id="pfp_' + i + '_monthlyTaxes" value="' + escAttr(p.monthlyTaxes || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
      '<div class="field"><label>Monthly Insurance</label><input type="text" inputmode="decimal" id="pfp_' + i + '_monthlyInsurance" value="' + escAttr(p.monthlyInsurance || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
      '<div class="field"><label>Monthly HOA</label><input type="text" inputmode="decimal" id="pfp_' + i + '_monthlyHoa" value="' + escAttr(p.monthlyHoa || '') + '" oninput="pfRecalcTotals()" placeholder="$" /></div>' +
    '</div>' +
  '</div>';
}

function _pfSumProps(props, field) {
  var s = 0;
  for (var i = 0; i < props.length; i++) {
    var n = parseFloat(String((props[i] || {})[field] || '').replace(/[^0-9.]/g, ''));
    if (isFinite(n)) s += n;
  }
  return s;
}

function _pfTotalsPanelHtml(active, props) {
  props = props || [];
  function tf(id, lbl, val) { return '<div class="field"><label>' + lbl + '</label><input type="text" id="' + id + '" value="' + escAttr(val) + '" readonly /></div>'; }
  function m(field) { return _pfFmtMoney(_pfSumProps(props, field)); }
  function num(field) { return String(_pfSumProps(props, field)); }
  return '<div class="pf-panel pf-total-panel" id="pf-panel-total" style="display:' + (active ? 'block' : 'none') + '">' +
    '<div class="app-grid">' +
      tf('pft-bedrooms', 'Total Bedrooms', num('bedrooms')) +
      tf('pft-bathrooms', 'Total Bathrooms', num('bathrooms')) +
      tf('pft-sqft', 'Total Sq Footage', num('sqft')) +
      tf('pft-propValue', 'Total Property Value', m('propValue')) +
      tf('pft-appraisedValue', 'Total Appraised Value', m('appraisedValue')) +
      tf('pft-existingDebt', 'Total Existing Debt', m('existingDebt')) +
      tf('pft-monthlyRent', 'Total Monthly Rent', m('monthlyRent')) +
      tf('pft-monthlyTaxes', 'Total Monthly Taxes', m('monthlyTaxes')) +
      tf('pft-monthlyInsurance', 'Total Monthly Insurance', m('monthlyInsurance')) +
      tf('pft-monthlyHoa', 'Total Monthly HOA', m('monthlyHoa')) +
    '</div>' +
    '<div style="font-size:12px;color:var(--muted);margin-top:8px">Totals are calculated live from the property tabs.</div>' +
  '</div>';
}

function _pfInner(props) {
  var n = props.length;
  var showTotal = n > 1;
  // Deploy 236.657 — Portfolio Total tab is FIRST and the default active tab.
  var tabs = '';
  if (showTotal) tabs += '<button type="button" class="pf-tab pf-tab-total active" id="pf-tabbtn-total" onclick="pfShowTab(\'total\')">Portfolio Total</button>';
  for (var i = 0; i < n; i++) {
    var propActive = (!showTotal && i === 0);
    tabs += '<button type="button" class="pf-tab' + (propActive ? ' active' : '') + '" id="pf-tabbtn-' + i + '" onclick="pfShowTab(' + i + ')">' + (i + 1) + '</button>';
  }
  var panels = '';
  if (showTotal) panels += _pfTotalsPanelHtml(true, props);       // default-visible
  for (var j = 0; j < n; j++) { panels += _pfPanelHtml(j, props[j], (!showTotal && j === 0)); }
  return '<div id="pfTabs" class="pf-tabs">' + tabs + '</div>' +
         '<div id="pfPanels">' + panels + '</div>' +
         '<div style="margin-top:12px;display:flex;gap:10px">' +
           '<button type="button" class="pf-addbtn" onclick="pfAdd()">+ Add Property</button>' +
           '<button type="button" class="pf-rmbtn" id="pfRemoveBtn" onclick="pfRemove()"' + (n > 1 ? '' : ' disabled') + '>− Remove Property</button>' +
         '</div>';
}

function _portfolioTabsHtml(l) {
  var props = (l && Array.isArray(l.properties)) ? l.properties.slice() : [];
  var count = parseInt(l && l.propertyCount, 10) || 0;
  if (count < props.length) count = props.length;
  if (count < 1) count = 1;
  while (props.length < count) props.push({});
  // Default active tab: Portfolio Total when there's more than one property.
  _pfActive = (props.length > 1) ? 'total' : 0;
  return '<div class="pf-wrap"><h3 style="margin:20px 0 8px;font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em">Portfolio Properties</h3>' +
    '<div id="portfolioTabsWrap">' + _pfInner(props) + '</div></div>';
}

function pfShowTab(which) {
  var wrap = document.getElementById('pfPanels');
  if (!wrap) return;
  var panels = wrap.querySelectorAll('.pf-panel');
  for (var i = 0; i < panels.length; i++) panels[i].style.display = 'none';
  var tabs = document.querySelectorAll('#pfTabs .pf-tab');
  for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
  if (which === 'total') {
    var tp = document.getElementById('pf-panel-total'); if (tp) tp.style.display = 'block';
    var tb = document.getElementById('pf-tabbtn-total'); if (tb) tb.classList.add('active');
    pfRecalcTotals();
    _pfActive = 'total';
  } else {
    var p = document.getElementById('pf-panel-' + which); if (p) p.style.display = 'block';
    var b = document.getElementById('pf-tabbtn-' + which); if (b) b.classList.add('active');
    _pfActive = which;
  }
  var rm = document.getElementById('pfRemoveBtn');
  if (rm) {
    var propCount = wrap.querySelectorAll('.pf-prop-panel').length;
    rm.disabled = !(propCount > 1 && which !== 'total');
  }
}

function _pfInputVal(i, field, money) {
  var el = document.getElementById('pfp_' + i + '_' + field);
  if (!el) return '';
  var v = String(el.value || '').trim();
  return money ? v.replace(/[^0-9.]/g, '') : v;
}

function pfCollect() {
  var out = [];
  var wrap = document.getElementById('pfPanels');
  if (!wrap) return out;
  var panels = wrap.querySelectorAll('.pf-prop-panel');
  for (var i = 0; i < panels.length; i++) {
    var idx = panels[i].getAttribute('data-idx');
    out.push({
      address: _pfInputVal(idx, 'address'), propType: _pfInputVal(idx, 'propType'),
      bedrooms: _pfInputVal(idx, 'bedrooms'), bathrooms: _pfInputVal(idx, 'bathrooms'),
      sqft: _pfInputVal(idx, 'sqft'),
      propValue: _pfInputVal(idx, 'propValue', true), appraisedValue: _pfInputVal(idx, 'appraisedValue', true),
      existingDebt: _pfInputVal(idx, 'existingDebt', true),
      monthlyRent: _pfInputVal(idx, 'monthlyRent', true), monthlyTaxes: _pfInputVal(idx, 'monthlyTaxes', true),
      monthlyInsurance: _pfInputVal(idx, 'monthlyInsurance', true), monthlyHoa: _pfInputVal(idx, 'monthlyHoa', true)
    });
  }
  return out;
}

function _pfSum(field) {
  var wrap = document.getElementById('pfPanels');
  var sum = 0;
  if (!wrap) return 0;
  var panels = wrap.querySelectorAll('.pf-prop-panel');
  for (var i = 0; i < panels.length; i++) {
    var idx = panels[i].getAttribute('data-idx');
    var el = document.getElementById('pfp_' + idx + '_' + field);
    if (!el) continue;
    var n = parseFloat(String(el.value || '').replace(/[^0-9.]/g, ''));
    if (isFinite(n)) sum += n;
  }
  return sum;
}

function _pfFmtMoney(n) { n = parseFloat(n) || 0; return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function pfRecalcTotals() {
  if (!document.getElementById('pf-panel-total')) return;
  function setV(id, val, money) { var e = document.getElementById(id); if (e) e.value = money ? _pfFmtMoney(val) : String(val || 0); }
  setV('pft-bedrooms', _pfSum('bedrooms'));
  setV('pft-bathrooms', _pfSum('bathrooms'));
  setV('pft-sqft', _pfSum('sqft'));
  setV('pft-propValue', _pfSum('propValue'), true);
  setV('pft-appraisedValue', _pfSum('appraisedValue'), true);
  setV('pft-existingDebt', _pfSum('existingDebt'), true);
  setV('pft-monthlyRent', _pfSum('monthlyRent'), true);
  setV('pft-monthlyTaxes', _pfSum('monthlyTaxes'), true);
  setV('pft-monthlyInsurance', _pfSum('monthlyInsurance'), true);
  setV('pft-monthlyHoa', _pfSum('monthlyHoa'), true);
}

function pfAdd() {
  var props = pfCollect();
  if (props.length >= 10) { showToast('Maximum of 10 properties'); return; }
  props.push({});
  var wrap = document.getElementById('portfolioTabsWrap');
  if (wrap) { wrap.innerHTML = _pfInner(props); pfShowTab(props.length - 1); }
}

function pfRemove() {
  var props = pfCollect();
  if (props.length <= 1) return;
  var idx = (_pfActive === 'total') ? (props.length - 1) : (parseInt(_pfActive, 10) || 0);
  // Deploy 236.660 — confirm before removing so a stray click doesn't drop a
  // property. Name the property by address (falls back to its number).
  var _addr = (props[idx] && props[idx].address) ? props[idx].address : ('Property ' + (idx + 1));
  if (!confirm('Remove ' + _addr + ' from this loan?\n\nThe property is deleted from the portfolio when you click Save Property / Collateral.')) return;
  props.splice(idx, 1);
  var wrap = document.getElementById('portfolioTabsWrap');
  if (wrap) { wrap.innerHTML = _pfInner(props); pfShowTab(Math.min(idx, props.length - 1)); }
}

// ── Deploy 236.566 — Closing Coordination ────────────────────────────
// The step order + labels. The backend (loan-closing-save.mjs) whitelists
// the same keys; keep the two lists in sync if steps change.
var CLOSING_STEP_DEFS = [
  ['cd_sent',     'Closing docs / CD sent'],
  ['docs_signed', 'Docs signed & returned'],
  ['wire_sent',   'Wire sent'],
  ['funded',      'Funded'],
  ['recorded',    'Recorded'],
];

// Build the Closing Coordination section HTML for a loan. Returns '' when the
// loan isn't at (or past) the closing table — Approved / Closed stage, a
// 'closed' status, or a closing already started. Also called by
// refreshClosingPanel() for in-place updates (no full-page re-render).
function renderClosingPanel(l) {
  if (!l) return '';
  // Deploy 236.568 — Closing is now its own tab and shows on EVERY loan, so
  // no stage gate: always render the panel (empty steps until the closer
  // starts working it). Kept as a function so refreshClosingPanel() can
  // re-inject just this section after a milestone toggle.
  var obj   = (l.closing && typeof l.closing === 'object') ? l.closing : {};
  var steps = (obj.steps && typeof obj.steps === 'object') ? obj.steps : {};

  var done = 0, rows = '';
  for (var i = 0; i < CLOSING_STEP_DEFS.length; i++) {
    var key = CLOSING_STEP_DEFS[i][0], label = CLOSING_STEP_DEFS[i][1];
    var st = steps[key] || {};
    var isDone = !!st.done;
    if (isDone) done++;
    var stamp = (isDone && st.at)
      ? '<span style="font-size:11px;color:var(--muted);margin-left:8px">' + escH(fmtDateTime(st.at)) + (st.by ? ' · ' + escH(st.by) : '') + '</span>'
      : '';
    rows +=
      '<label style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#eee);cursor:pointer">' +
        '<input type="checkbox" ' + (isDone ? 'checked ' : '') + 'onchange="toggleClosingStep(\'' + key + '\', this)" style="width:16px;height:16px;flex:none" />' +
        '<span style="flex:1;' + (isDone ? 'text-decoration:line-through;color:var(--muted)' : '') + '">' + escH(label) + '</span>' +
        stamp +
      '</label>';
  }
  var pct = Math.round((done / CLOSING_STEP_DEFS.length) * 100);

  return '<div class="section" id="closingSection">' +
    '<div class="section-head"><h2>Closing Coordination</h2><span class="section-tag tag-editable">' + done + '/' + CLOSING_STEP_DEFS.length + '</span></div>' +
    '<div class="section-body">' +
      '<div style="height:6px;background:var(--border,#eee);border-radius:3px;overflow:hidden;margin-bottom:14px">' +
        '<div style="height:100%;width:' + pct + '%;background:var(--success,#166534);transition:width .2s"></div>' +
      '</div>' +
      rows +
      '<div class="app-grid" style="margin-top:16px">' +
        '<div class="field"><label>Title / Escrow Company</label><input type="text" id="cl-titleCompany" value="' + escAttr(obj.titleCompany || '') + '" maxlength="120" /></div>' +
        '<div class="field"><label>Title Contact</label><input type="text" id="cl-titleContact" value="' + escAttr(obj.titleContact || '') + '" placeholder="name / phone / email" maxlength="120" /></div>' +
        '<div class="field"><label>Wire Amount</label><input type="text" id="cl-wireAmount" value="' + escAttr(obj.wireAmount || '') + '" placeholder="$" inputmode="decimal" /></div>' +
        '<div class="field"><label>Scheduled Funding Date</label><input type="date" id="cl-scheduledFundingDate" value="' + escAttr(obj.scheduledFundingDate || '') + '" /></div>' +
      '</div>' +
      '<div class="field" style="margin-top:12px"><label>Closing Notes</label><textarea id="cl-notes" rows="2" placeholder="wire instructions confirmed, funding conditions, etc.">' + escH(obj.notes || '') + '</textarea></div>' +
      '<div style="margin-top:14px;display:flex;align-items:center;gap:12px">' +
        '<button class="save-app-btn" onclick="saveClosingFields()">Save Closing Details</button>' +
        '<span id="closingStatus" style="font-size:12px;color:var(--success);display:none">Saved ✓</span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

// Replace the closing section in place (no full-page re-render — the panel is
// low on the page and a full render would jump the scroll to the top).
function refreshClosingPanel() {
  var el = document.getElementById('closingSection');
  if (!el || !_loan) return;
  var next = renderClosingPanel(_loan);
  if (!next) { el.remove(); return; }
  el.outerHTML = next;
}

// Owner param for cross-LO admin edits (matches saveFundingPlan's guard).
function _closingOwner() {
  return (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
}

// Toggle one milestone. The server stamps at/by; we mirror the returned
// closing object onto the in-memory loan and refresh just this panel.
function toggleClosingStep(step, el) {
  if (!_loan || !_client) return;
  var done = !!(el && el.checked);
  var body = { clientId: _client.id, loanId: _loanId, step: step, done: done };
  var owner = _closingOwner(); if (owner) body.owner = owner;
  if (el) el.disabled = true;
  SLA.api('POST', '/api/loan-closing-save', body).then(function(r) {
    if (r && r.closing) _loan.closing = r.closing;
    refreshClosingPanel();
    showToast(done ? 'Marked complete' : 'Marked incomplete');
  }).catch(function(err) {
    if (el) { el.disabled = false; el.checked = !done; } // revert the toggle
    showToast('Closing update failed: ' + (err && err.message || 'unknown'));
  });
}

// Save the free-text coordination fields as one batch.
function saveClosingFields() {
  if (!_loan || !_client) return;
  var fields = {
    titleCompany:         (document.getElementById('cl-titleCompany')        || {}).value || '',
    titleContact:         (document.getElementById('cl-titleContact')        || {}).value || '',
    wireAmount:           (document.getElementById('cl-wireAmount')          || {}).value || '',
    scheduledFundingDate: (document.getElementById('cl-scheduledFundingDate')|| {}).value || '',
    notes:                (document.getElementById('cl-notes')              || {}).value || '',
  };
  var body = { clientId: _client.id, loanId: _loanId, fields: fields };
  var owner = _closingOwner(); if (owner) body.owner = owner;
  var btn = document.querySelector('#closingSection .save-app-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  SLA.api('POST', '/api/loan-closing-save', body).then(function(r) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Closing Details'; }
    if (r && r.closing) _loan.closing = r.closing;
    var s = document.getElementById('closingStatus');
    if (s) { s.style.display = 'inline'; setTimeout(function(){ s.style.display = 'none'; }, 2500); }
    showToast('Closing details saved');
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Closing Details'; }
    showToast('Closing save failed: ' + (err && err.message || 'unknown error'));
  });
}

// ── Deploy 236.578 — Proof of Funds Letter ───────────────────────────
// Generates the SLA Capital POF letter as a downloadable PDF (jsPDF) from the
// template Mike supplied. Uses the loan's ASSIGNED LO (owner) for the
// name/email/phone; property address + borrower first name come from the loan.
// Anything missing (in practice the LO phone) is asked for in a modal first,
// and a newly-entered phone is saved back to the LO's profile for next time.

function _pofFmtPhone(raw) {
  var d = String(raw || '').replace(/[^\d]/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return String(raw || '').trim(); // not a standard 10-digit US number — leave as typed
}
function _pofFmtDate(dt) {
  var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return m[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
}
// Deploy 236.760 — purchase price for the letter body.
// Deploy 236.762 — only format entries that are PURE currency ("1000000",
// "$1,000,000", "1000000.50"). The old strip-then-parse mangled shorthand:
// "1M cash" → "$1", "500k" → "$500" — a POF letter stating a $1 purchase.
// Anything with letters or other symbols prints exactly as typed.
function _pofFmtMoney(raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (/^[$\s0-9,\.]+$/.test(s)) {
    var n = parseFloat(s.replace(/[^0-9.]/g, ''));
    if (isFinite(n) && n > 0) return '$' + Math.round(n).toLocaleString('en-US');
  }
  return s;
}

// Actions-menu entry point.
function generatePofLetter() {
  if (!_loan || !_client) { showToast('Loan not loaded yet.'); return; }
  var loEmail = String(_loEmail || '').toLowerCase();
  if (!loEmail) {
    showToast('Assign a Loan Officer first (Contacts → Team Members), then print the letter.');
    if (typeof switchLdTab === 'function') switchLdTab('contacts');
    return;
  }
  var known = {
    propertyAddress: (_loan.address || '').trim(),
    // Deploy 236.580 — the letter names the GUARANTOR by full name (first +
    // last), not just a first name.
    guarantorName:   ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim(),
    // Deploy 236.760 — the first sentence now states the purchase price.
    // From the loan when it has one (purchases keep propValue = price);
    // otherwise the modal asks for it.
    purchasePrice:   String(_loan.purchasePrice
                       || (_loan.formData && _loan.formData.purchasePrice)
                       || (String(_loan.loanPurpose || '') === 'purchase' ? (_loan.propValue || '') : '')
                       || '').trim(),
    loEmail:         loEmail,
    loName:          '',
    loPhone:         '',
  };
  var finish = function () { _pofDecide(known); };
  // Pull the assigned LO's name + phone from the directory (phone added 236.578).
  if (window.SLA && SLA.Users && SLA.Users.directory) {
    SLA.Users.directory().then(function (r) {
      var users = (r && r.users) || [];
      for (var i = 0; i < users.length; i++) {
        if (String(users[i].email).toLowerCase() === loEmail) {
          known.loName  = (users[i].name  || '').trim();
          known.loPhone = _pofFmtPhone(users[i].phone || '');
          break;
        }
      }
      finish();
    }).catch(finish);
  } else { finish(); }
}

function _pofDecide(f) {
  var missing = [];
  if (!f.propertyAddress) missing.push('propertyAddress');
  if (!f.guarantorName)   missing.push('guarantorName');
  if (!f.purchasePrice)   missing.push('purchasePrice'); // Deploy 236.760
  if (!f.loName)          missing.push('loName');
  if (!f.loPhone)         missing.push('loPhone');
  if (!missing.length) { _pofRender(f); return; }
  _pofOpenModal(f, missing);
}

function _pofOpenModal(f, missing) {
  var labels = {
    propertyAddress: 'Property Address',
    guarantorName:   'Guarantor Name (First & Last)',
    purchasePrice:   'Purchase Price', // Deploy 236.760
    loName:          'Loan Officer Name',
    loPhone:         'Loan Officer Phone Number',
  };
  var old = document.getElementById('pofModal'); if (old) old.remove();
  var rows = '';
  missing.forEach(function (k) {
    rows += '<div style="margin-bottom:12px">' +
      '<label style="display:block;font-size:12px;font-weight:600;color:var(--dark,#261A36);margin-bottom:4px">' + escH(labels[k]) + '</label>' +
      '<input type="text" id="pof-' + k + '" value="' + escAttr(f[k] || '') + '"' +
        (k === 'loPhone' ? ' placeholder="(555) 123-4567" inputmode="tel"' : '') +
        ' style="width:100%;padding:9px 10px;border:1.5px solid var(--border,#E4DFD4);border-radius:6px;font-family:inherit;font-size:13px;box-sizing:border-box" />' +
    '</div>';
  });
  var phoneNote = (missing.indexOf('loPhone') >= 0)
    ? '<div style="font-size:11px;color:var(--muted,#7a7488);margin:-2px 0 10px">This number will be saved to the Loan Officer’s profile for next time.</div>'
    : '';
  var wrap = document.createElement('div');
  wrap.id = 'pofModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9500;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.innerHTML =
    '<div style="background:#fff;max-width:460px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.25)">' +
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border,#E4DFD4)">' +
        '<div style="font-family:\'Lora\',serif;font-size:17px;font-weight:600;color:var(--dark,#261A36)">Proof of Funds Letter</div>' +
        '<div style="font-size:12px;color:var(--muted,#7a7488);margin-top:2px">A few details are needed before printing.</div>' +
      '</div>' +
      '<div style="padding:18px 20px">' + rows + phoneNote +
        '<div id="pofModalErr" style="font-size:12px;color:var(--danger,#7c1f1f);min-height:14px"></div>' +
      '</div>' +
      '<div style="padding:14px 20px;border-top:1px solid var(--border,#E4DFD4);display:flex;justify-content:flex-end;gap:10px;background:#faf8f3">' +
        '<button type="button" id="pofCancelBtn" style="font-size:13px;padding:8px 16px;border:1px solid var(--border,#E4DFD4);background:#fff;border-radius:6px;cursor:pointer;font-family:inherit">Cancel</button>' +
        '<button type="button" id="pofGenBtn" style="font-size:13px;padding:8px 18px;border:none;background:var(--accent,#C8813A);color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">Generate PDF</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  wrap._pofFields = f;
  wrap._pofMissing = missing;
  wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
  document.getElementById('pofCancelBtn').addEventListener('click', function () { wrap.remove(); });
  document.getElementById('pofGenBtn').addEventListener('click', _pofModalSubmit);
  var firstInput = wrap.querySelector('input'); if (firstInput) firstInput.focus();
}

function _pofModalSubmit() {
  var wrap = document.getElementById('pofModal'); if (!wrap) return;
  var f = Object.assign({}, wrap._pofFields);
  var missing = wrap._pofMissing || [];
  var err = document.getElementById('pofModalErr');
  missing.forEach(function (k) {
    var el = document.getElementById('pof-' + k);
    if (el) f[k] = el.value.trim();
  });
  var reqLabels = { propertyAddress: 'Property Address', guarantorName: 'Guarantor Name', purchasePrice: 'Purchase Price', loName: 'Loan Officer Name', loPhone: 'Loan Officer Phone Number' };
  for (var k in reqLabels) {
    if (!f[k]) { if (err) err.textContent = reqLabels[k] + ' is required.'; return; }
  }
  f.loPhone = _pofFmtPhone(f.loPhone);

  var btn = document.getElementById('pofGenBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  var savePhone = (missing.indexOf('loPhone') >= 0 && f.loPhone);
  var done = function () { wrap.remove(); _pofRender(f); };
  if (savePhone) { _pofSaveLoPhone(f.loEmail, f.loPhone).then(done, done); }
  else { done(); }
}

// Save the LO's phone to their profile. Own profile → full self-save; another
// LO (admin generating on their behalf) → owner-override endpoint (admin-gated).
function _pofSaveLoPhone(loEmail, phone) {
  var self = String((_user && _user.email) || '').toLowerCase();
  if (loEmail && loEmail === self) {
    return (window.SLA && SLA.Profile && SLA.Profile.update)
      ? SLA.Profile.update({ phone: phone }).then(function () { showToast('Saved your phone to your profile.'); })
      : Promise.resolve();
  }
  return SLA.api('POST', '/api/profile-update', { phone: phone, owner: loEmail })
    .then(function () { showToast('Saved phone to the Loan Officer’s profile.'); })
    .catch(function () { /* non-fatal — still print the letter */ });
}

// Render + download the POF letter PDF. Deploy 236.579 — load the SLA logo from
// its ABSOLUTE path first (the nav <img> uses a RELATIVE src that resolves wrong
// under the /loan-details/<id> short URL, so grabbing `nav img` produced a
// broken image → no letterhead). Same-origin image → canvas isn't tainted.
function _pofRender(f) {
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    showToast('PDF library still loading — try again in a moment.');
    return;
  }
  var img = new Image();
  img.onload  = function () { _pofBuildPdf(f, img); };
  img.onerror = function () { _pofBuildPdf(f, null); };
  img.src = '/SLA_Capital_Logo_2_1.png';
}

function _pofBuildPdf(f, logoImg) {
  var JsPDF = window.jspdf.jsPDF;
  var doc = new JsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  var W = doc.internal.pageSize.getWidth();
  var lm = 72, rm = W - 72; // 1-inch margins
  var y = 54;

  // Letterhead.
  try {
    if (logoImg && logoImg.naturalWidth > 0) {
      var logoW = 130;
      var logoH = (logoImg.naturalHeight / logoImg.naturalWidth) * logoW;
      var os = 2;
      var c = document.createElement('canvas');
      c.width = Math.round(logoW * os); c.height = Math.round(logoH * os);
      var cx = c.getContext('2d');
      cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(logoImg, 0, 0, c.width, c.height);
      // Deploy 236.580 — center the letterhead logo.
      doc.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', (W - logoW) / 2, y, logoW, logoH);
      y += logoH + 26;
    } else { throw new Error('no logo'); }
  } catch (e) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(38, 26, 54);
    doc.text('SLA Capital', W / 2, y + 14, { align: 'center' }); y += 42;
  }

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  var line = function (txt, gap) { doc.text(String(txt || ''), lm, y); y += (gap || 16); };
  var para = function (txt, gap) {
    var lines = doc.splitTextToSize(String(txt || ''), rm - lm);
    doc.text(lines, lm, y);
    y += lines.length * 15 + (gap || 8);
  };

  line(_pofFmtDate(new Date()), 26);
  doc.setFont('helvetica', 'bold'); line('Re: ' + f.propertyAddress, 22); doc.setFont('helvetica', 'normal');
  line('To whom it may concern,', 20);
  // Deploy 236.760 — Mike's wording: one "preapproved" (the old sentence
  // said it twice) + the purchase price stated explicitly.
  para('Our client ' + f.guarantorName + ' is preapproved and has funding sources available with our company to purchase the subject with a purchase price of ' + _pofFmtMoney(f.purchasePrice) + '.', 12);
  para('These funds are available at the request of Sir Lends A Lot LLC DBA SLA Capital during normal banking hours.', 12);
  para('Please do not hesitate to contact us at our office at ' + f.loPhone + ' at anytime between 9am and 5pm PST Monday through Friday.', 22);
  line('Thank You,', 30);
  doc.setFont('helvetica', 'bold'); line(f.loName, 16); doc.setFont('helvetica', 'normal');
  line('Loan Officer - Sir Lends A Lot LLC', 16);
  line(f.loEmail, 16);
  line(f.loPhone, 16);

  var safeAddr = String(f.propertyAddress || 'Loan').replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'Loan';
  doc.save('Proof of Funds - ' + safeAddr + '.pdf');
  showToast('Proof of Funds letter downloaded.');
}

// ── Deploy 236.764 — DSCR rate lock (45 days from application signing) ──
// rateLockStart is stamped at sign time (borrower-info-sync) and by the
// Reset action; legacy signed loans fall back to borrowerInfoCompletedAt.
function _rateLockInfo(l) {
  if (!l) return null;
  if (String(l.toolType || '').toLowerCase() !== 'dscr') return null;
  var dead = ['closed', 'cancelled', 'denied', 'sold', 'liquidated', 'paid_off'];
  if (dead.indexOf(String(l.status || '').toLowerCase()) >= 0) return null;
  var start = l.rateLockStart || l.borrowerInfoCompletedAt || '';
  var t = Date.parse(start);
  if (!isFinite(t)) return null;
  var expiresMs = t + 45 * 86400000;
  var days = Math.ceil((expiresMs - Date.now()) / 86400000);
  var d = new Date(expiresMs);
  return {
    start: start, expiresMs: expiresMs, days: days,
    dateStr: (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(),
  };
}

// Deploy 236.765 — the rate-lock counter renders as a compact STRIP at the
// top of the right sidebar, sized to the same ~40px band as the tab row,
// followed by a 2px divider that visually continues the tabs' underline
// across the sidebar; Notes & Activity starts below (Mike's layout).
// Shared by the page render (relocateNotes) and the reset-modal repaint.
function _renderRateLockCard() {
  var bar = document.getElementById('ldNotesSidebar');
  var oldCard = document.getElementById('rateLockCard'); if (oldCard) oldCard.remove();
  var oldDiv  = document.getElementById('rateLockDivider'); if (oldDiv) oldDiv.remove();
  if (!bar) return;
  var rl = _rateLockInfo(_loan);
  if (!rl) return;
  var col = rl.days <= 10 ? '#7c1f1f' : (rl.days <= 15 ? '#b5712d' : 'var(--dark, #261a36)');
  var line = rl.days > 0
    ? 'Lock Expires in <strong>' + rl.days + ' day' + (rl.days === 1 ? '' : 's') + '</strong> on <strong>' + escH(rl.dateStr) + '</strong>'
    : 'Rate lock <strong>EXPIRED</strong> on <strong>' + escH(rl.dateStr) + '</strong>';
  var strip = document.createElement('div');
  strip.id = 'rateLockCard';
  strip.title = '45-day rate lock from application signing' + ((_loan && _loan.rateLockStart) ? '' : ' (derived from long-app completion)');
  // 41px min-height + the divider's 2px lands the divider on the same
  // y as the tabs' underline (measured live: tab row bottom = strip
  // top + 43px).
  strip.style.cssText = 'min-height:41px;display:flex;align-items:center;gap:8px;font-size:13.5px;color:' + col + ';padding:0 2px';
  strip.innerHTML = '<span style="font-size:16px">🔒</span><span style="line-height:1.35">' + line + '</span>';
  var divider = document.createElement('div');
  divider.id = 'rateLockDivider';
  divider.style.cssText = 'border-bottom:2px solid ' + (rl.days <= 10 ? 'rgba(124,31,31,0.45)' : 'var(--border, #ddd8d0)') + ';margin-bottom:20px';
  bar.insertBefore(divider, bar.firstChild);
  bar.insertBefore(strip, divider);
  // Deploy 236.765b — self-align: measure the tabs' underline and pad the
  // strip so the divider lands on exactly the same y (font rendering
  // makes a hardcoded height drift a pixel or two across browsers).
  try {
    var tabsEl = document.querySelector('.ld-tabs');
    if (tabsEl) {
      var delta = Math.round(tabsEl.getBoundingClientRect().bottom - divider.getBoundingClientRect().bottom);
      if (delta > 0 && delta < 30) strip.style.minHeight = (41 + delta) + 'px';
    }
  } catch (_) {}
}

// Deploy 236.770 — Yes/No confirm before removing a denied/cancelled tag.
// The loan returns to 'approved' when it has a processing stage (it stays
// exactly where it was on the Processing Pipeline), else 'active'.
function openReinstateModal() {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  var from = String((_loan && _loan.status) || '').toLowerCase();
  if (from !== 'denied' && from !== 'cancelled') { showToast('Loan is not denied or cancelled.'); return; }
  var label = from === 'denied' ? 'denied' : 'cancelled';
  var hasStage = !!String((_loan && _loan.processingStage) || '').trim();
  var old = document.getElementById('reinstateModal'); if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'reinstateModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9500;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.innerHTML =
    '<div style="background:#fff;max-width:440px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.25)">' +
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border,#E4DFD4)">' +
        '<div style="font-family:\'Lora\',serif;font-size:17px;font-weight:600;color:var(--dark,#261A36)">Remove ' + (from === 'denied' ? 'Denied' : 'Cancelled') + ' Status</div>' +
      '</div>' +
      '<div style="padding:18px 20px;font-size:14px;line-height:1.5">' +
        'Are you sure you want to remove the <strong>' + label + '</strong> tag and reinstate this loan?' +
        '<div style="font-size:12px;color:var(--muted,#7a7488);margin-top:6px">' +
          (hasStage
            ? 'The loan returns to <strong>Approved</strong> and reappears in its current Processing Pipeline stage.'
            : 'The loan returns to <strong>Active</strong> on the Sales pipeline.') +
        '</div>' +
      '</div>' +
      '<div style="padding:14px 20px;border-top:1px solid var(--border,#E4DFD4);display:flex;justify-content:flex-end;gap:10px;background:#faf8f3">' +
        '<button type="button" id="reinstNoBtn" style="font-size:13px;padding:8px 18px;border:1px solid var(--border,#E4DFD4);background:#fff;border-radius:6px;cursor:pointer;font-family:inherit">No</button>' +
        '<button type="button" id="reinstYesBtn" style="font-size:13px;padding:8px 18px;border:none;background:var(--gold,#C8813A);color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">Yes — Reinstate Loan</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
  document.getElementById('reinstNoBtn').addEventListener('click', function () { wrap.remove(); });
  document.getElementById('reinstYesBtn').addEventListener('click', function () {
    var btn = document.getElementById('reinstYesBtn');
    btn.disabled = true; btn.textContent = 'Reinstating…';
    var body = { clientId: _client.id, loanId: _loanId };
    if (_loEmail && _user && _loEmail !== _user.email) body.owner = _loEmail;
    SLA.api('POST', '/api/loan-status-reinstate', body).then(function (r) {
      showToast('Loan reinstated — status is now ' + (r.status || 'active') + '.');
      // Status touches most of the page's render — a clean reload is the
      // reliable repaint.
      setTimeout(function () { location.reload(); }, 700);
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Yes — Reinstate Loan';
      showToast('Reinstate failed: ' + ((err && err.message) || 'unknown'));
    });
  });
}

function openResetRateLockModal() {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  var old = document.getElementById('rateLockResetModal'); if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'rateLockResetModal';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9500;display:flex;align-items:center;justify-content:center;padding:20px';
  wrap.innerHTML =
    '<div style="background:#fff;max-width:420px;width:100%;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.25)">' +
      '<div style="padding:16px 20px;border-bottom:1px solid var(--border,#E4DFD4)">' +
        '<div style="font-family:\'Lora\',serif;font-size:17px;font-weight:600;color:var(--dark,#261A36)">Reset Rate Lock</div>' +
      '</div>' +
      '<div style="padding:18px 20px;font-size:14px;line-height:1.5">' +
        'Are you sure you want to reset the rate lock?' +
        '<div style="font-size:12px;color:var(--muted,#7a7488);margin-top:6px">The lock restarts at <strong>45 days from today</strong> and the expiration reminder emails re-arm.</div>' +
      '</div>' +
      '<div style="padding:14px 20px;border-top:1px solid var(--border,#E4DFD4);display:flex;justify-content:flex-end;gap:10px;background:#faf8f3">' +
        '<button type="button" id="rlResetNoBtn" style="font-size:13px;padding:8px 18px;border:1px solid var(--border,#E4DFD4);background:#fff;border-radius:6px;cursor:pointer;font-family:inherit">No</button>' +
        '<button type="button" id="rlResetYesBtn" style="font-size:13px;padding:8px 18px;border:none;background:var(--gold,#C8813A);color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">Yes — Reset to 45 Days</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
  document.getElementById('rlResetNoBtn').addEventListener('click', function () { wrap.remove(); });
  document.getElementById('rlResetYesBtn').addEventListener('click', function () {
    var btn = document.getElementById('rlResetYesBtn');
    btn.disabled = true; btn.textContent = 'Resetting…';
    var body = { clientId: _client.id, loanId: _loanId };
    if (_loEmail && _user && _loEmail !== _user.email) body.owner = _loEmail;
    SLA.api('POST', '/api/loan-rate-lock-reset', body).then(function (r) {
      wrap.remove();
      _ldMergeLoan({ rateLockStart: r.rateLockStart });
      if (_loan && _loan.rateLockNotified) delete _loan.rateLockNotified;
      showToast('Rate lock reset — 45 days from today.');
      // Deploy 236.765 — repaint via the shared builder (single source
      // for the strip + divider markup).
      _renderRateLockCard();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Yes — Reset to 45 Days';
      showToast('Reset failed: ' + ((err && err.message) || 'unknown'));
    });
  });
}

function deleteThisLoan() {
  if (!_client || !_loan) return;
  var addr = _loan.address || 'this loan';
  if (!confirm('Delete ' + addr + '?\n\nThis cannot be undone. The loan will be removed from the client record and any saved quote will be deleted.')) return;

  var opts = { loanId: _loanId };
  // If admin is acting on another LO's data, thread the owner through
  if (_loEmail && _user && _loEmail !== _user.email) opts._owner = _loEmail;

  SLA.Clients.delete(_clientId, opts).then(function(r) {
    // Also clear from QuoteStore so it doesn't haunt the saved-quotes panel
    try {
      if (_loan.address && window.QuoteStore) {
        QuoteStore.deleteQuote(_loEmail, _loan.toolType || 'dscr', _loan.address);
      }
    } catch (e) {}

    showToast('Loan deleted');
    // Bounce back to the client page (with owner param if applicable)
    var dest = '/client-details.html?clientId=' + encodeURIComponent(_clientId);
    if (_loEmail && _user && _loEmail !== _user.email) {
      dest += '&owner=' + encodeURIComponent(_loEmail);
    }
    setTimeout(function(){ window.location.href = dest; }, 600);
  }).catch(function(err) {
    showToast('Delete failed: ' + (err.message || 'unknown error'));
  });
}

// ── Move to In Processing (manual advance) ────────────────────────
// Safety-valve action for when the automatic awaiting_app → approved
// transition (in borrower-info-save.mjs > advanceQuoteToInProcessing)
// silently bailed. Most common cause is address-string mismatch
// between the client's loan record and the saved quote — the borrower
// completes the app, the form-submit handler updates the borrower-info
// record's status to 'complete', but the address-match-based quote
// bump never finds a quote and the loan stays at awaiting_app.
//
// ── Deploy 236.229 (Broker Phase E) — deferred borrower-info capture ──
// Broker loans defer borrower info at submit (Phase D). When the LO
// advances the loan to Approved ("In Processing"), the gate below
// requires them to fill in Guarantor 1 (+ optional co-guarantors)
// before the status change proceeds. Backend endpoint creates or
// links client records for each guarantor and populates guarantors[].
function _brokerLoanNeedsBorrowerInfo() {
  if (!_loan) return false;
  if (!_loan._isBrokerLoan) return false;
  if (_loan._borrowerInfoPending === false) return false;
  // Defensive: if pending flag was never set (older broker loans) but
  // guarantors[] is empty, still gate the advance.
  var gs = Array.isArray(_loan.guarantors) ? _loan.guarantors : [];
  var hasReal = gs.some(function(g) {
    return g && (g.firstName || g.lastName || g.email);
  });
  return !hasReal;
}

var _brokerCaptureRowCount = 1;
var _brokerCaptureCallback = null;
function openBrokerBorrowerCaptureModal(onSuccess) {
  _brokerCaptureCallback = onSuccess || null;
  _brokerCaptureRowCount = 1;
  var existing = document.getElementById('brokerBorrowerCaptureModal');
  if (existing) existing.remove();
  var m = document.createElement('div');
  m.id = 'brokerBorrowerCaptureModal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9500;display:flex;align-items:center;justify-content:center;padding:24px';
  m.innerHTML =
    '<div style="background:#fff;max-width:720px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;border-radius:14px">' +
      '<div style="padding:18px 22px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
        '<div>' +
          '<div style="font-family:\'Lora\',serif;font-size:18px;font-weight:600;color:var(--dark)">Borrower Info Required</div>' +
          '<div style="font-size:12px;color:var(--muted);margin-top:2px">This broker loan needs Guarantor 1 (and any co-guarantors) before advancing to In Processing.</div>' +
        '</div>' +
        '<button type="button" onclick="closeBrokerBorrowerCaptureModal()" style="font-size:22px;background:transparent;border:none;color:var(--muted);cursor:pointer;padding:0 6px">×</button>' +
      '</div>' +
      '<div id="brokerCaptureBody" style="padding:18px 22px;overflow:auto;flex:1">' +
        _brokerCaptureRowHtml(1) +
        '<div id="brokerCaptureRows"></div>' +
        '<div style="margin-top:10px"><button type="button" onclick="brokerCaptureAddRow()" style="font-size:12px;padding:6px 12px;border:1px dashed var(--border);background:transparent;border-radius:6px;cursor:pointer;font-family:inherit;color:var(--muted)">+ Add another guarantor</button></div>' +
        '<div style="margin-top:1.5rem;padding-top:14px;border-top:1px solid var(--border)">' +
          '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:8px">Vesting entity (optional)</div>' +
          '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">' +
            '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">LLC / Entity Name</label><input type="text" id="brokerCaptureEntity" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
            '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">EIN</label><input type="text" id="brokerCaptureEin" placeholder="XX-XXXXXXX" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
          '</div>' +
        '</div>' +
        '<div id="brokerCaptureErr" style="margin-top:12px;color:#b91c1c;font-size:12px;display:none"></div>' +
      '</div>' +
      '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;background:#faf8f3">' +
        '<button type="button" onclick="closeBrokerBorrowerCaptureModal()" style="font-size:13px;padding:8px 18px;border:1px solid var(--border);background:#fff;border-radius:6px;cursor:pointer;font-family:inherit">Cancel</button>' +
        '<button type="button" id="brokerCaptureSubmit" onclick="submitBrokerBorrowerCapture()" style="font-size:13px;padding:8px 18px;border:1px solid var(--gold);background:var(--gold);color:#fff;border-radius:6px;cursor:pointer;font-family:inherit;font-weight:600">Save & Advance</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
}
function closeBrokerBorrowerCaptureModal() {
  var m = document.getElementById('brokerBorrowerCaptureModal'); if (m) m.remove();
  _brokerCaptureCallback = null;
}
function _brokerCaptureRowHtml(n) {
  var isFirst = (n === 1);
  return '<div id="brokerCaptureRow_' + n + '" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<div style="font-size:12px;font-weight:700;color:var(--dark);text-transform:uppercase;letter-spacing:0.05em">Guarantor ' + n + (isFirst ? ' (primary)' : '') + '</div>' +
      (isFirst ? '' : '<button type="button" onclick="brokerCaptureRemoveRow(' + n + ')" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);background:transparent;border-radius:4px;cursor:pointer;color:var(--muted)">Remove</button>') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">First Name *</label><input type="text" data-cap="firstName" data-row="' + n + '" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
      '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">Last Name *</label><input type="text" data-cap="lastName" data-row="' + n + '" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
      '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">Email *</label><input type="email" data-cap="email" data-row="' + n + '" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
      '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">Phone</label><input type="tel" data-cap="phone" data-row="' + n + '" placeholder="(555) 555-5555" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
      '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">DOB</label><input type="date" data-cap="dob" data-row="' + n + '" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
      '<div><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">% Ownership of LLC</label><input type="number" data-cap="ownershipPct" data-row="' + n + '" min="0" max="100" step="0.01" placeholder="e.g. 50" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
      '<div style="grid-column:span 2"><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:3px">SSN (optional here — captured on the long-app if you skip)</label><input type="text" data-cap="ssn" data-row="' + n + '" placeholder="XXX-XX-XXXX" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px" /></div>' +
    '</div>' +
  '</div>';
}
function brokerCaptureAddRow() {
  if (_brokerCaptureRowCount >= 4) return;
  _brokerCaptureRowCount++;
  var el = document.getElementById('brokerCaptureRows');
  if (el) el.insertAdjacentHTML('beforeend', _brokerCaptureRowHtml(_brokerCaptureRowCount));
}
function brokerCaptureRemoveRow(n) {
  var row = document.getElementById('brokerCaptureRow_' + n);
  if (row) row.remove();
}
function submitBrokerBorrowerCapture() {
  var err = document.getElementById('brokerCaptureErr');
  err.style.display = 'none'; err.textContent = '';
  var rows = document.querySelectorAll('[id^="brokerCaptureRow_"]');
  var guarantors = [];
  for (var i = 0; i < rows.length; i++) {
    var rowEl = rows[i];
    var g = {};
    ['firstName','lastName','email','phone','dob','ssn','ownershipPct'].forEach(function(k) {
      var input = rowEl.querySelector('[data-cap="' + k + '"]');
      if (input) g[k] = String(input.value || '').trim();
    });
    if (!g.firstName && !g.lastName && !g.email) continue; // fully blank row → skip
    if (!g.firstName || !g.lastName) { err.textContent = 'Guarantor ' + (i+1) + ' needs first + last name.'; err.style.display=''; return; }
    if (!g.email || g.email.indexOf('@') < 0) { err.textContent = 'Guarantor ' + (i+1) + ' needs a valid email.'; err.style.display=''; return; }
    guarantors.push(g);
  }
  if (!guarantors.length) { err.textContent = 'Enter at least one guarantor.'; err.style.display=''; return; }

  var btn = document.getElementById('brokerCaptureSubmit');
  btn.disabled = true; btn.textContent = 'Saving…';
  var payload = {
    clientId:   _client.id,
    loanId:     _loanId,
    guarantors: guarantors,
    entityName: (document.getElementById('brokerCaptureEntity') || {}).value || '',
    entityEin:  (document.getElementById('brokerCaptureEin')    || {}).value || '',
  };
  if (_loEmail && _user && _loEmail !== _user.email) payload.owner = _loEmail;
  SLA.api('POST', '/api/loan-broker-borrower-capture', payload).then(function(r) {
    if (!r || !r.ok) throw new Error((r && r.error) || 'unknown');
    _loan = r.loan;
    var lidx = (_client && _client.loans || []).findIndex(function(l) { return l && l.id === _loanId; });
    if (lidx >= 0) _client.loans[lidx] = r.loan;
    var cb = _brokerCaptureCallback;
    closeBrokerBorrowerCaptureModal();
    showToast('Borrower info saved — ' + r.guarantors.length + ' guarantor' + (r.guarantors.length === 1 ? '' : 's') + ' captured.');
    if (cb) setTimeout(cb, 100);
  }).catch(function(e) {
    btn.disabled = false; btn.textContent = 'Save & Advance';
    err.textContent = 'Failed: ' + (e && e.message || 'unknown'); err.style.display='';
  });
}

// Hits POST /api/loan-advance-status which updates both the client
// loan record AND any matching quotes (using more permissive address
// normalization). Stamps audit fields so we can spot manually-advanced
// loans in retrospect.
function moveToInProcessing() {
  if (!_loan || !_client) return;
  if (_loan.status !== 'awaiting_app') {
    showToast('Loan is not in Awaiting Application state.');
    return;
  }
  // Deploy 236.229 (Broker Phase E) — broker loans deferred borrower
  // capture at submit time (Phase D). Before allowing the advance,
  // require the LO or broker to fill in Guarantor 1 (and optional
  // co-guarantors) so guarantors[] is populated and the Loan App PDF
  // can render correctly.
  if (_brokerLoanNeedsBorrowerInfo()) {
    openBrokerBorrowerCaptureModal(function onCaptured() {
      // Recurse — flag is now cleared; second call falls through to
      // the standard confirm/advance path.
      moveToInProcessing();
    });
    return;
  }
  if (!confirm('Move this loan to "In Processing"?\n\nUse this only when the borrower has confirmed completion of the loan application but the loan didn\'t auto-advance.')) return;

  var btnTextEl = event && event.currentTarget;
  if (btnTextEl) { btnTextEl.disabled = true; btnTextEl.style.opacity = '0.6'; }

  // _client.id is the canonical client identifier on this page — every
  // other call site in loan-details uses it. Earlier Deploy 167 typo'd
  // this as _client.clientId which doesn't exist on the loaded object,
  // so the request body had clientId=undefined and the server bailed
  // with "clientId required".
  var body = { clientId: _client.id, loanId: _loanId, newStatus: 'approved' };
  // Cross-LO admin: include owner override when acting on another LO's loan
  if (_loEmail && _user && _loEmail !== _user.email) body.owner = _loEmail;

  // Deploy 236.504 — use SLA.getToken() (Supabase-aware) for the Bearer
  // token, NOT netlifyIdentity.currentUser().jwt() which is null (→ crash)
  // for Google/Supabase-logged-in LOs. getToken() handles both auth
  // systems and returns '' (clean 401) rather than throwing.
  SLA.getToken().then(function(token) {
    return fetch('/api/loan-advance-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
  })
  .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, status: r.status, body: j }; }); })
  .then(function(resp) {
    if (!resp.ok || !resp.body.success) {
      var msg = (resp.body && resp.body.error) || ('Request failed (' + resp.status + ')');
      showToast('Move failed: ' + msg);
      if (btnTextEl) { btnTextEl.disabled = false; btnTextEl.style.opacity = ''; }
      return;
    }
    var qInfo = resp.body.quotesUpdated > 0
      ? ' (' + resp.body.quotesUpdated + ' quote' + (resp.body.quotesUpdated === 1 ? '' : 's') + ' synced)'
      : '';
    showToast('Loan moved to In Processing' + qInfo);
    // Update local state + redirect to Pipeline so the LO sees it in
    // the right column. The Loan Details page would also re-render
    // correctly, but Pipeline is where they'll want to verify it
    // landed in the right place.
    setTimeout(function() {
      window.location.href = '/pipeline.html';
    }, 900);
  })
  .catch(function(err) {
    showToast('Move failed: ' + (err.message || 'unknown error'));
    if (btnTextEl) { btnTextEl.disabled = false; btnTextEl.style.opacity = ''; }
  });
}

// Deploy 227 — Admin / super-admin only. Manually move the loan to any
// status. Backend gates: loan-advance-status.mjs accepts any allowed
// status when isAdmin(user). Audit-logged on the loan via the kind=status
// entry the endpoint writes.
function adminMoveStatus() {
  if (!_loan || !_client) return;
  if (!(window.SLA && SLA.isAdmin && SLA.isAdmin(_user))) {
    showToast('Admin only');
    return;
  }
  var sel = document.getElementById('adminStatusPick');
  var msg = document.getElementById('adminStatusMsg');
  // Deploy 236.643 — the control lives in the page header now (next to Actions)
  // with no inline message line, so fall back to a toast when #adminStatusMsg
  // is absent.
  function _say(t, err){ if (msg) { msg.textContent = t; msg.style.color = err ? '#7c1f1f' : 'var(--muted)'; } else if (err) { showToast(t); } }
  if (!sel) return;
  var target = sel.value;
  if (!target) return;
  if (target === _loan.status) { _say('Loan is already in that status.', true); sel.value = ''; return; }
  var labelMap = {
    active: 'Quoted', on_hold: 'On Hold', submitted: 'Submitted',
    awaiting_app: 'Awaiting Application', approved: 'In Processing',
    closed: 'Closed', denied: 'Declined', cancelled: 'Cancelled',
  };
  var human = labelMap[target] || target;
  // Deploy 236.229 (Broker Phase E) — same gate as moveToInProcessing:
  // broker loans need borrower info before advancing to approved.
  if (target === 'approved' && _brokerLoanNeedsBorrowerInfo()) {
    openBrokerBorrowerCaptureModal(function onCaptured() { adminMoveStatus(); });
    return;
  }
  function doMove() {
    _say('Moving…', false);
    var body = { clientId: _client.id, loanId: _loanId, newStatus: target };
    if (_loEmail && _user && _loEmail !== _user.email) body.owner = _loEmail;

    SLA.getToken().then(function(token) {
      return fetch('/api/loan-advance-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body),
      });
    })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, status: r.status, body: j }; }); })
    .then(function(resp) {
      if (!resp.ok || !resp.body.success) {
        var emsg = (resp.body && resp.body.error) || ('Request failed (' + resp.status + ')');
        _say('Failed: ' + emsg, true);
        if (sel) sel.value = '';
        return;
      }
      showToast('Status moved to ' + human);
      // Reload the page to re-render with the new status — easier than
      // hand-patching every status-dependent block on the page.
      setTimeout(function(){ window.location.reload(); }, 600);
    })
    .catch(function(err) {
      _say('Failed: ' + (err.message || 'unknown'), true);
      if (sel) sel.value = '';
    });
  }

  // Deploy 236.686 — closing is terminal, so require an explicit "I verified the
  // loan info is correct" attestation via a modal (parity with the Processing
  // Pipeline drag-to-Closed flow) instead of a bare confirm.
  if (target === 'closed') {
    _openCloseVerifyModal((_loan && _loan.address) || '', doMove, function(){ if (sel) sel.value = ''; });
    return;
  }
  if (!confirm('Manually move this loan to "' + human + '"?\n\nThis bypasses the normal flow. The change will be visible in the Notes audit log.')) { sel.value = ''; return; }
  doMove();
}

// Deploy 236.686 — shared close-confirmation modal (self-contained; no static
// markup needed). Requires the user to attest the loan info is verified before
// the "Move to Closed" button enables. onConfirm fires on confirm; onCancel on
// cancel / backdrop click / X.
function _openCloseVerifyModal(address, onConfirm, onCancel) {
  var _e = function(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  var bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;background:rgba(38,26,54,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem';
  bg.innerHTML =
    '<div style="background:#fff;border-radius:12px;padding:24px;max-width:460px;width:100%;font-family:DM Sans,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,0.3)">' +
      '<h3 style="margin:0 0 8px;font-size:16px;color:#1a1520">🏁 Move loan to Closed?</h3>' +
      '<p style="font-size:13px;color:#7a7488;line-height:1.5;margin:0 0 4px">' +
        (address ? '<strong style="color:#1a1520">' + _e(address) + '</strong><br>' : '') +
        'This marks the loan Closed and moves it into the Closed pipeline.</p>' +
      '<label style="display:flex;align-items:flex-start;gap:10px;margin:16px 0 4px;font-size:13.5px;line-height:1.5;cursor:pointer;color:#1a1520">' +
        '<input type="checkbox" id="_cvChk" style="margin-top:2px;width:16px;height:16px;flex:0 0 auto;cursor:pointer" />' +
        '<span>I have verified that <strong>all of the loan information is correct</strong>.</span></label>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">' +
        '<button type="button" id="_cvCancel" style="padding:9px 16px;font-size:13px;font-weight:600;border:1px solid #ddd8d0;background:#fff;border-radius:8px;cursor:pointer;font-family:DM Sans,sans-serif">Cancel</button>' +
        '<button type="button" id="_cvOk" disabled style="padding:9px 16px;font-size:13px;font-weight:600;border:none;background:#C8813A;color:#fff;border-radius:8px;cursor:not-allowed;opacity:0.5;font-family:DM Sans,sans-serif">Move to Closed</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(bg);
  function close() { if (bg.parentNode) bg.parentNode.removeChild(bg); }
  var chk = bg.querySelector('#_cvChk');
  var ok = bg.querySelector('#_cvOk');
  chk.addEventListener('change', function(){ ok.disabled = !chk.checked; ok.style.opacity = chk.checked ? '1' : '0.5'; ok.style.cursor = chk.checked ? 'pointer' : 'not-allowed'; });
  bg.querySelector('#_cvCancel').addEventListener('click', function(){ close(); if (onCancel) onCancel(); });
  ok.addEventListener('click', function(){ if (!chk.checked) return; close(); if (onConfirm) onConfirm(); });
  bg.addEventListener('click', function(e){ if (e.target === bg) { close(); if (onCancel) onCancel(); } });
}

// ── Cancel Loan / Restore Cancelled Loan ──────────────────────────
// Deploy 195: cancellation is for loans that were approved (i.e. moved
// to "In Processing") but never closed \u2014 borrower backed out,
// financing fell through, deal restructured. Distinct from `denied`
// (we declined to lend) and from `closed` (loan funded). Cancelled
// loans live on their own page (`cancelled.html`) so they don\u2019t
// clutter the active pipeline but remain accessible.
//
// Backend at /api/loan-cancel enforces the eligibility rules
// (only awaiting_app or approved can be cancelled). Restore reverts
// to whichever status the loan had right before cancel \u2014 stored on
// the loan record as _cancelledFrom.
// Deploy 196: status → human label map shared by Cancel + Decline modal subs.
var _STATUS_LABEL_FOR_END = {
  active:        'Quoted',
  on_hold:       'On Hold',   // Deploy 236.371 — on_hold is now cancel/decline-able
  submitted:     'Submitted',
  awaiting_app:  'Awaiting Application',
  approved:      'In Processing',
};
function openCancelLoanModal() {
  if (!_loan) return;
  // Deploy 196: widened to all non-terminal statuses. Mirrors the
  // CANCEL_FROM list in loan-cancel.mjs — keep them in sync.
  // Deploy 236.371 (hotfix): added 'on_hold'. It was missing from BOTH
  // this list and the backend's, while _terminalForEnd (which decides
  // whether the button renders) treats on_hold as non-terminal — so the
  // button appeared and then this guard rejected it with a message that
  // was flatly untrue. Message corrected to name the real terminal set.
  // Deploy 236.575 — allow cancel from ANY non-terminal status (matches
  // _canEndLoan / loan-cancel.mjs). New / early / empty-status loans were
  // wrongly rejected here with a misleading "already terminal" toast, so LOs
  // deleted the contact instead. Cancel keeps the loan + contact.
  var _termStatuses = ['cancelled', 'denied', 'closed', 'sold', 'liquidated'];
  if (_termStatuses.indexOf(String(_loan.status || '').toLowerCase()) >= 0) {
    showToast('This loan is already closed, declined, or cancelled and cannot be cancelled again.');
    return;
  }
  var sub = document.getElementById('cancelLoanSub');
  if (sub) {
    var fromLabel = _STATUS_LABEL_FOR_END[_loan.status] || _loan.status || 'New';
    sub.innerHTML = 'This loan will be moved from <strong>' + fromLabel + '</strong> to <strong>Cancelled</strong>. ' +
      'It will no longer appear on the Pipeline or in the default Loans view, but stays accessible from the Cancelled view if it needs to be restored later.';
  }
  document.getElementById('cancelReason').value = '';
  document.getElementById('cancelLoanStatus').textContent = '';
  document.getElementById('cancelLoanStatus').className = 'bi-status';
  document.getElementById('cancelLoanBtn').disabled = false;
  document.getElementById('cancelLoanBtn').textContent = 'Cancel loan';
  document.getElementById('cancelLoanModal').classList.add('show');
}

// ── Decline Loan ───────────────────────────────────────────────────
// Deploy 196: distinct from Cancel — Decline is OUR decision to not
// fund the loan, where Cancel is the borrower's / deal's drop-off.
// Backend at /api/loan-decline mirrors the loan-cancel flow.
function openDeclineLoanModal() {
  if (!_loan) return;
  // Deploy 236.371 (hotfix): added 'on_hold' — mirrors DECLINE_FROM in
  // loan-decline.mjs. Declining a loan that's parked on hold is a normal
  // outcome; it was blocked behind a false "already terminal" toast.
  var allowed = ['active', 'on_hold', 'submitted', 'awaiting_app', 'approved'];
  if (allowed.indexOf(_loan.status) < 0) {
    showToast('This loan is already closed, declined, or cancelled and cannot be declined.');
    return;
  }
  var sub = document.getElementById('declineLoanSub');
  if (sub) {
    var fromLabel = _STATUS_LABEL_FOR_END[_loan.status] || _loan.status;
    sub.innerHTML = 'This loan will be moved from <strong>' + fromLabel + '</strong> to <strong>Declined</strong>. ' +
      'Use this when SLA has decided not to lend on the deal. The loan will leave the Pipeline and move to the Declined tab on Decisions, where an admin can restore it if needed.';
  }
  document.getElementById('declineReason').value = '';
  document.getElementById('declineLoanStatus').textContent = '';
  document.getElementById('declineLoanStatus').className = 'bi-status';
  document.getElementById('declineLoanBtn').disabled = false;
  document.getElementById('declineLoanBtn').textContent = 'Decline loan';
  document.getElementById('declineLoanModal').classList.add('show');
}
function closeDeclineLoanModal() {
  document.getElementById('declineLoanModal').classList.remove('show');
}
function confirmDeclineLoan() {
  if (!_loan || !_client) return;
  var reason = (document.getElementById('declineReason').value || '').trim();
  var statusEl = document.getElementById('declineLoanStatus');
  var btn = document.getElementById('declineLoanBtn');
  btn.disabled = true;
  btn.textContent = 'Declining…';
  statusEl.className = 'bi-status';
  statusEl.textContent = '';

  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Loans.decline(_client.id, _loanId, reason, ownerOvr).then(function(resp) {
    statusEl.className = 'bi-status ok';
    statusEl.textContent = '✓ Loan declined' + (resp.warning ? ' — ' + resp.warning : '');
    if (resp.loan) {
      _loan = resp.loan;
      var loans = _client.loans || [];
      var idx = loans.findIndex(function(x) { return x.id === _loanId; });
      if (idx >= 0) loans[idx] = resp.loan;
    } else {
      _loan.status = 'denied';
    }
    setTimeout(function() {
      closeDeclineLoanModal();
      render();
    }, 700);
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = 'Decline loan';
    statusEl.className = 'bi-status err';
    statusEl.textContent = 'Failed: ' + ((err && err.message) || 'unknown error');
  });
}

function closeCancelLoanModal() {
  document.getElementById('cancelLoanModal').classList.remove('show');
}

// ── Reassign Loan (Deploy 236.81) ─────────────────────────────────
// Move the current loan from its current client to a different one.
// Two paths: pick an existing client or create one inline. Backend
// also moves borrower_info / signed_application / quotes /
// loan_reviews so cross-store records don't orphan.
var _reassignTab = 'existing';
var _reassignClients = [];
var _reassignSelectedId = null;

function openReassignLoanModal() {
  if (!_client || !_loan) { showToast('Loan not loaded'); return; }
  // Reset state
  _reassignTab = 'existing';
  _reassignSelectedId = null;
  document.getElementById('reassignSearch').value = '';
  ['reassignNewFirstName','reassignNewLastName','reassignNewEmail','reassignNewPhone','reassignNewEntity'].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('reassignStatus').className = 'bi-status';
  document.getElementById('reassignStatus').textContent = '';
  // Deploy 236.353 — reset the "different borrower" checkbox each open.
  var _rrCbx = document.getElementById('reassignResetAppCbx');
  if (_rrCbx) _rrCbx.checked = false;
  var _rrWarn = document.getElementById('reassignResetWarning');
  if (_rrWarn) _rrWarn.style.display = 'none';
  reassignSwitchTab('existing');
  document.getElementById('reassignLoanModal').classList.add('show');
  // Load this LO's clients (fresh fetch — small enough that we
  // don't need to share with the cache layer).
  document.getElementById('reassignClientList').innerHTML =
    '<div style="padding:1.25rem;text-align:center;color:var(--muted);font-size:13px">Loading clients…</div>';
  // Deploy 236.266 — processors also need cross-LO client list here
  // (reassign target picker).
  // Deploy 236.345 — summary is enough for the picker (only reads
  // id/firstName/lastName/email/phone/loans.length).
  var p = SLA.isStaff(_user)
    ? SLA.Clients.list({ all: true, summary: true })
    : SLA.Clients.list({ summary: true });
  p.then(function(r) {
    var clients = [];
    if (r.byOwner) {
      Object.keys(r.byOwner).forEach(function(ownerKey) {
        (r.byOwner[ownerKey] || []).forEach(function(c) { clients.push(c); });
      });
    } else {
      clients = r.clients || [];
    }
    _reassignClients = clients.filter(function(c) { return c && !c.deleted; });
    renderReassignClientList();
  }).catch(function(err) {
    document.getElementById('reassignClientList').innerHTML =
      '<div style="padding:1.25rem;text-align:center;color:#7C1F1F;font-size:13px">Failed to load clients: ' + escH(err.message || 'Unknown') + '</div>';
  });
}

function closeReassignLoanModal() {
  document.getElementById('reassignLoanModal').classList.remove('show');
  var btn = document.getElementById('reassignConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Reassign loan';
}

// ── Deploy 236.232/233: Merge Loan (admin, two-stage) ─────────
// STAGE 1 (pick): list every OTHER loan at the same street across
// owners; admin picks one as loser.
// STAGE 2 (review): side-by-side field diff. Admin picks winner
// value per differing field, can swap winner/loser roles. Confirm
// sends winnerOverrides to /api/loans-merge-manual (Deploy 236.233).
//
// Two "sides" throughout — sideA and sideB, each holding a
// {ownerKey, clientId, loanId, loan (full record), client (full)}.
// _mergeWinnerSide = 'A' | 'B' tells which is currently the winner.
// Starts with sideA = this loan, sideB = picked candidate,
// _mergeWinnerSide = 'A'. Swap flips the assignment.
var _mergeLoanCandidates = [];        // stage-1 pick pool
var _mergeLoanSelectedKey = null;     // ownerKey|clientId|loanId
var _mergeClientPool = null;          // full pool cached across stages
var _mergeSideA = null;               // { ownerKey, clientId, loanId, loan, client }
var _mergeSideB = null;
var _mergeWinnerSide = 'A';           // 'A' or 'B'
var _mergePicks = {};                 // { fieldName: 'A' | 'B' } — which side's value goes on winner

function _mergeStreetKey(addr) {
  return String(addr || '').toLowerCase().trim().replace(/\s+/g, ' ').split(',')[0].trim();
}

function openMergeLoanModal() {
  if (!_client || !_loan) { showToast('Loan not loaded'); return; }
  _mergeLoanSelectedKey = null;
  _mergeClientPool = null;
  _mergeSideA = null;
  _mergeSideB = null;
  _mergeWinnerSide = 'A';
  _mergePicks = {};

  // Reset to stage 1.
  document.getElementById('mergeStagePick').style.display = '';
  document.getElementById('mergeStageReview').style.display = 'none';
  document.getElementById('mergeBackBtn').style.display = 'none';
  var btn = document.getElementById('mergeLoanConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Next: Review fields';
  document.getElementById('mergeLoanHeading').textContent = 'Merge Another Loan Into This One';
  document.getElementById('mergeLoanSub').textContent = "Pick which loan to merge in. On the next step you'll review every field side-by-side and choose which value survives.";
  document.getElementById('mergeLoanStatus').className = 'bi-status';
  document.getElementById('mergeLoanStatus').textContent = '';

  var name = ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim() || _client.email || '';
  var winnerLine = (_loan.address || '') + ' — ' + name + ' — ' + (_loan.id || '');
  document.getElementById('mergeWinnerLine').textContent = winnerLine;

  document.getElementById('mergeLoanModal').classList.add('show');
  document.getElementById('mergeLoserList').innerHTML =
    '<div style="padding:1.25rem;text-align:center;color:var(--muted);font-size:13px">Loading candidates…</div>';

  var p = SLA.isStaff(_user) ? SLA.Clients.list({ all: true, summary: true }) : SLA.Clients.list({ summary: true }); // Deploy 236.266
  p.then(function(r) {
    var pool = [];
    if (r.byOwner) {
      Object.keys(r.byOwner).forEach(function(ownerKey) {
        (r.byOwner[ownerKey] || []).forEach(function(c) {
          pool.push({ ownerKey: ownerKey, client: c });
        });
      });
    } else {
      var myKey = (_user && _user.email || '').toLowerCase();
      (r.clients || []).forEach(function(c) { pool.push({ ownerKey: myKey, client: c }); });
    }
    _mergeClientPool = pool;

    var thisStreet = _mergeStreetKey(_loan.address);
    var thisLoanId = _loan.id;
    var candidates = [];
    pool.forEach(function(row) {
      var c = row.client;
      if (!c || c.deleted || !Array.isArray(c.loans)) return;
      c.loans.forEach(function(l) {
        if (!l || !l.id || l.id === thisLoanId) return;
        var st = _mergeStreetKey(l.address);
        if (!st || !thisStreet || st !== thisStreet) return;
        candidates.push({
          ownerKey: row.ownerKey,
          clientId: c.id,
          loanId: l.id,
          address: l.address || '',
          borrower: ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email || '',
          loanAmt: l.loanAmt || 0,
          propTypeLabel: l.propTypeLabel || l.propType || '',
          toolType: String(l.toolType || l._toolType || 'dscr').toUpperCase(),
          status: l.status || '',
          updatedAt: l.updatedAt || l.createdAt || '',
        });
      });
    });
    _mergeLoanCandidates = candidates;
    _renderMergeLoserList();
  }).catch(function(err) {
    document.getElementById('mergeLoserList').innerHTML =
      '<div style="padding:1.25rem;text-align:center;color:#7C1F1F;font-size:13px">Failed to load candidates: ' + escH(err.message || 'Unknown') + '</div>';
  });
}

function _renderMergeLoserList() {
  var container = document.getElementById('mergeLoserList');
  if (!_mergeLoanCandidates.length) {
    container.innerHTML = '<div style="padding:1.25rem;text-align:center;color:var(--muted);font-size:13px">No other loans found at this street address. Merge is for cleaning up same-address dupes — if the two loans are at different addresses, use Reassign instead.</div>';
    return;
  }
  var myOwner = (_user && _user.email || '').toLowerCase();
  container.innerHTML = _mergeLoanCandidates.map(function(cand) {
    var selKey = cand.ownerKey + '|' + cand.clientId + '|' + cand.loanId;
    var isSel = (_mergeLoanSelectedKey === selKey);
    var amt = cand.loanAmt ? '$' + Math.round(cand.loanAmt).toLocaleString() : '—';
    var updated = cand.updatedAt ? new Date(cand.updatedAt).toLocaleDateString() : '';
    var loLabel = cand.ownerKey === myOwner ? 'This LO' : cand.ownerKey;
    return '<div onclick="pickMergeLoser(\'' + escAttr(selKey) + '\')" style="padding:12px 14px;border-bottom:1px solid var(--border, #E4DFD4);cursor:pointer;background:' + (isSel ? 'rgba(133,77,14,0.08)' : '#fff') + ';border-left:3px solid ' + (isSel ? '#854d0e' : 'transparent') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<div style="font-size:14px;font-weight:600;color:var(--dark)">' + escH(cand.borrower) + '</div>' +
        '<div style="font-size:11px;color:var(--muted)">' + escH(updated) + '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--muted);margin-bottom:4px">' + escH(cand.address) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;font-size:11px">' +
        '<span style="background:rgba(200,129,58,0.10);color:#7a4a13;padding:1px 7px;border-radius:10px;font-weight:600">' + escH(cand.toolType) + '</span>' +
        (cand.propTypeLabel ? '<span style="background:rgba(30,64,175,0.08);color:#1e3a8a;padding:1px 7px;border-radius:10px">' + escH(cand.propTypeLabel) + '</span>' : '') +
        '<span style="background:#f4f3ee;color:var(--dark);padding:1px 7px;border-radius:10px">' + escH(amt) + '</span>' +
        '<span style="background:#f4f3ee;color:var(--muted);padding:1px 7px;border-radius:10px">' + escH(cand.status) + '</span>' +
        '<span style="background:rgba(133,77,14,0.08);color:#854d0e;padding:1px 7px;border-radius:10px">LO: ' + escH(loLabel) + '</span>' +
      '</div>' +
      '<div style="font-size:10px;color:var(--muted);font-family:monospace;margin-top:5px">' + escH(cand.loanId) + '</div>' +
    '</div>';
  }).join('');
}

function pickMergeLoser(selKey) {
  _mergeLoanSelectedKey = (_mergeLoanSelectedKey === selKey) ? null : selKey;
  document.getElementById('mergeLoanConfirmBtn').disabled = !_mergeLoanSelectedKey;
  _renderMergeLoserList();
}

function closeMergeLoanModal() {
  document.getElementById('mergeLoanModal').classList.remove('show');
}

// Called when the primary button is clicked. On stage 1 it advances
// to stage 2 (review); on stage 2 it commits the merge.
function confirmMergeLoan() {
  var reviewPane = document.getElementById('mergeStageReview');
  if (reviewPane.style.display === 'none') {
    _enterMergeReviewStage();
  } else {
    _commitMergeReview();
  }
}

// ── Stage transitions ──────────────────────────────────────────
function _enterMergeReviewStage() {
  if (!_mergeLoanSelectedKey || !_loan || !_client) return;
  var parts = _mergeLoanSelectedKey.split('|');
  if (parts.length !== 3) return;
  var loserOwner = parts[0], loserClientId = parts[1], loserLoanId = parts[2];

  // Locate the picked candidate's FULL client + loan record from the
  // cached pool so we can diff every field, not just the summary.
  var pickedClient = null, pickedLoan = null;
  (_mergeClientPool || []).forEach(function(row) {
    if (pickedLoan) return;
    if (row.ownerKey !== loserOwner) return;
    if (!row.client || row.client.id !== loserClientId) return;
    var l = (row.client.loans || []).find(function(x) { return x && x.id === loserLoanId; });
    if (l) { pickedClient = row.client; pickedLoan = l; }
  });
  if (!pickedLoan) { showToast('Picked loan not found — try reopening the merge modal.'); return; }

  // Side A = this loan (default winner). Side B = picked candidate.
  _mergeSideA = {
    ownerKey: (_loEmail || (_user && _user.email) || '').toLowerCase(),
    clientId: _client.id, loanId: _loan.id,
    loan: _loan, client: _client,
  };
  _mergeSideB = {
    ownerKey: loserOwner,
    clientId: loserClientId, loanId: loserLoanId,
    loan: pickedLoan, client: pickedClient,
  };
  _mergeWinnerSide = 'A';
  _mergePicks = {}; // reset — will default to winner's value

  document.getElementById('mergeStagePick').style.display = 'none';
  document.getElementById('mergeStageReview').style.display = '';
  document.getElementById('mergeBackBtn').style.display = '';
  document.getElementById('mergeLoanHeading').textContent = 'Review Merge — Pick Values Per Field';
  document.getElementById('mergeLoanSub').textContent = 'For each row, pick which side\'s value survives on the merged loan. The Winner is kept; the Loser is removed. Use "Swap" to flip roles.';
  var btn = document.getElementById('mergeLoanConfirmBtn');
  btn.disabled = false;
  btn.textContent = 'Commit Merge';

  _renderMergeReview();
}

function mergeBackToPick() {
  document.getElementById('mergeStagePick').style.display = '';
  document.getElementById('mergeStageReview').style.display = 'none';
  document.getElementById('mergeBackBtn').style.display = 'none';
  document.getElementById('mergeLoanHeading').textContent = 'Merge Another Loan Into This One';
  document.getElementById('mergeLoanSub').textContent = "Pick which loan to merge in. On the next step you'll review every field side-by-side and choose which value survives.";
  var btn = document.getElementById('mergeLoanConfirmBtn');
  btn.disabled = !_mergeLoanSelectedKey;
  btn.textContent = 'Next: Review fields';
}

function swapMergeSides() {
  _mergeWinnerSide = (_mergeWinnerSide === 'A') ? 'B' : 'A';
  // Flip every pick so a "keep A" stays "keep A" (value-preserving swap).
  // Actually no — user wants to re-decide. Reset picks on swap so
  // defaults align with the new winner.
  _mergePicks = {};
  _renderMergeReview();
}

// ── Stage 2 rendering ──────────────────────────────────────────
// The fields we show side-by-side. Order matters — most-important
// first. If both sides are empty on a field, it's hidden.
var _MERGE_LOAN_FIELDS = [
  'address', 'loanAmt', 'purchasePrice', 'status', 'propType', 'propTypeLabel',
  'toolType', 'fico', 'notes', 'bedrooms', 'bathrooms', 'sqft',
  'projectDescription', 'fundingDate', 'brokerName', 'brokerCompany',
  'lockDate', 'rate', 'points', 'ltv', 'dscr', 'occupancy',
];
var _MERGE_CLIENT_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'entityName', 'displayName',
];

function _mergeGetField(side, field, kind) {
  if (!side) return '';
  var src = kind === 'client' ? side.client : side.loan;
  if (!src) return '';
  var v = src[field];
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function _renderMergeReview() {
  var winner = (_mergeWinnerSide === 'A') ? _mergeSideA : _mergeSideB;
  var loser  = (_mergeWinnerSide === 'A') ? _mergeSideB : _mergeSideA;
  var winnerLabel = _mergeSideLabel(winner) + '  ·  KEPT';
  var loserLabel  = _mergeSideLabel(loser)  + '  ·  REMOVED';

  document.getElementById('mergeWinnerCard').innerHTML =
    '<div style="font-size:10px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Winner</div>' +
    '<div style="font-weight:600;color:var(--dark);margin-bottom:2px">' + escH(winnerLabel) + '</div>' +
    '<div style="font-size:11px;color:var(--muted);font-family:monospace">' + escH(winner.loanId) + '</div>';

  document.getElementById('mergeLoserCard').innerHTML =
    '<div style="font-size:10px;font-weight:700;color:#7C1F1F;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Loser</div>' +
    '<div style="font-weight:600;color:var(--dark);margin-bottom:2px">' + escH(loserLabel) + '</div>' +
    '<div style="font-size:11px;color:var(--muted);font-family:monospace">' + escH(loser.loanId) + '</div>';

  var rows = [];
  // Loan fields.
  _MERGE_LOAN_FIELDS.forEach(function(f) {
    var vW = _mergeGetField(winner, f, 'loan');
    var vL = _mergeGetField(loser,  f, 'loan');
    if (!vW && !vL) return;
    rows.push(_mergeRowHtml('loan', f, vW, vL));
  });
  // Client fields.
  if (_MERGE_CLIENT_FIELDS.length) {
    rows.push('<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin:8px 0 4px 0;padding:0 4px">Client fields</div>');
  }
  _MERGE_CLIENT_FIELDS.forEach(function(f) {
    var vW = _mergeGetField(winner, f, 'client');
    var vL = _mergeGetField(loser,  f, 'client');
    if (!vW && !vL) return;
    rows.push(_mergeRowHtml('client', f, vW, vL));
  });
  if (!rows.length) rows.push('<div style="padding:1rem;text-align:center;color:var(--muted);font-size:13px">Both loans share the same values on all tracked fields. Merge is safe — winner keeps everything, loser is removed.</div>');
  document.getElementById('mergeFieldDiff').innerHTML = rows.join('');
}

function _mergeSideLabel(side) {
  if (!side) return '';
  var c = side.client || {};
  var l = side.loan || {};
  var name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email || '';
  var amt = l.loanAmt ? '$' + Math.round(l.loanAmt).toLocaleString() : '';
  return (name || '(no borrower)') + (amt ? '  ·  ' + amt : '') + '  ·  LO: ' + side.ownerKey;
}

function _mergeRowHtml(kind, field, vW, vL) {
  var pickKey = kind + '.' + field;
  var currentPick = _mergePicks[pickKey];
  // Default pick: winner wins non-empty conflicts; when winner is empty,
  // default to loser (gap-fill). User can override either way.
  if (!currentPick) currentPick = vW ? 'W' : (vL ? 'L' : 'W');
  var sameValue = (vW === vL);
  var wSel = currentPick === 'W';
  var lSel = currentPick === 'L';
  var label = field;

  var wBox = '<label style="flex:1;display:flex;gap:8px;align-items:flex-start;cursor:pointer;padding:8px 10px;border-radius:6px;background:' + (wSel ? 'rgba(21,128,61,0.08)' : '#fff') + ';border:1.5px solid ' + (wSel ? '#166534' : 'var(--border, #E4DFD4)') + ';transition:all 0.12s">' +
    '<input type="radio" name="mergepick_' + escAttr(pickKey) + '" ' + (wSel ? 'checked' : '') + ' onchange="setMergePick(\'' + escAttr(pickKey) + '\', \'W\')" style="margin-top:2px" />' +
    '<div style="flex:1;min-width:0"><div style="font-size:10px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Winner value</div><div style="font-size:12px;color:var(--dark);word-break:break-word;white-space:pre-wrap">' + (vW ? escH(vW) : '<em style="color:var(--muted)">(empty)</em>') + '</div></div>' +
  '</label>';

  var lBox = '<label style="flex:1;display:flex;gap:8px;align-items:flex-start;cursor:pointer;padding:8px 10px;border-radius:6px;background:' + (lSel ? 'rgba(124,31,31,0.08)' : '#fff') + ';border:1.5px solid ' + (lSel ? '#7C1F1F' : 'var(--border, #E4DFD4)') + ';transition:all 0.12s">' +
    '<input type="radio" name="mergepick_' + escAttr(pickKey) + '" ' + (lSel ? 'checked' : '') + ' onchange="setMergePick(\'' + escAttr(pickKey) + '\', \'L\')" style="margin-top:2px" />' +
    '<div style="flex:1;min-width:0"><div style="font-size:10px;color:#7C1F1F;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Loser value</div><div style="font-size:12px;color:var(--dark);word-break:break-word;white-space:pre-wrap">' + (vL ? escH(vL) : '<em style="color:var(--muted)">(empty)</em>') + '</div></div>' +
  '</label>';

  return '<div style="padding:8px 4px;border-bottom:1px dashed var(--border, #E4DFD4)">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<div style="font-size:12px;font-weight:600;color:var(--dark)">' + escH(label) + (kind === 'client' ? ' <span style="font-size:10px;color:var(--muted);font-weight:400">(client)</span>' : '') + '</div>' +
      (sameValue ? '<span style="font-size:10px;color:#166534;background:rgba(21,128,61,0.08);padding:1px 8px;border-radius:10px;font-weight:600">Same value</span>' : '') +
    '</div>' +
    '<div style="display:flex;gap:8px">' + wBox + lBox + '</div>' +
  '</div>';
}

function setMergePick(pickKey, side) {
  _mergePicks[pickKey] = side; // 'W' or 'L'
  _renderMergeReview();
}

// ── Commit ────────────────────────────────────────────────────
function _commitMergeReview() {
  var winner = (_mergeWinnerSide === 'A') ? _mergeSideA : _mergeSideB;
  var loser  = (_mergeWinnerSide === 'A') ? _mergeSideB : _mergeSideA;
  if (!winner || !loser) return;

  // Compose winnerOverrides — only include fields where the user's
  // pick DIFFERS from what the winner already has, so the audit is
  // clean and the backend gap-fill still runs for everything else.
  var winnerOverrides = {};
  // Loan-level picks.
  _MERGE_LOAN_FIELDS.forEach(function(f) {
    var vW = _mergeGetField(winner, f, 'loan');
    var vL = _mergeGetField(loser,  f, 'loan');
    if (!vW && !vL) return;
    var pickKey = 'loan.' + f;
    var pick = _mergePicks[pickKey] || (vW ? 'W' : 'L');
    if (pick === 'L' && vL !== vW) winnerOverrides[f] = _mergeRawField(loser, f, 'loan');
    // Also handle "user picked W but W is empty and L is non-empty"
    // — that means the user wants to force W's empty value (clear).
    if (pick === 'W' && !vW && vL) winnerOverrides[f] = '';
  });
  // Client-level picks — piggyback via a separate payload since the
  // endpoint gap-fills the client itself. We don't have client-field
  // overrides on the backend yet, so surface a note if any client
  // picks would force a "loser wins" — those get skipped for now.
  var skippedClientPicks = [];
  _MERGE_CLIENT_FIELDS.forEach(function(f) {
    var vW = _mergeGetField(winner, f, 'client');
    var vL = _mergeGetField(loser,  f, 'client');
    if (!vW && !vL) return;
    var pickKey = 'client.' + f;
    var pick = _mergePicks[pickKey] || (vW ? 'W' : 'L');
    // Backend already gap-fills client fields; only note if user
    // picked LOSER when WINNER has a value (that's the only case
    // that won't happen automatically).
    if (pick === 'L' && vL && vL !== vW) skippedClientPicks.push(f);
  });

  var summary = 'MERGE — Winner: ' + _mergeSideLabel(winner) + '\n\nLoser (removed): ' + _mergeSideLabel(loser) + '\n\n' +
    Object.keys(winnerOverrides).length + ' loan field(s) will use the loser\'s value.\n' +
    (skippedClientPicks.length ? '\nNote: ' + skippedClientPicks.length + ' client field pick(s) [' + skippedClientPicks.join(', ') + '] can\'t be applied — client-field overrides aren\'t supported by the backend yet. Winner client keeps its values.\n' : '') +
    '\nThis cannot be undone. Proceed?';
  if (!confirm(summary)) return;

  var btn = document.getElementById('mergeLoanConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Merging…';
  var statusEl = document.getElementById('mergeLoanStatus');
  statusEl.className = 'bi-status';
  statusEl.textContent = '';

  SLA.api('POST', '/api/loans-merge-manual', {
    winner: { ownerKey: winner.ownerKey, clientId: winner.clientId, loanId: winner.loanId },
    loser:  { ownerKey: loser.ownerKey,  clientId: loser.clientId,  loanId: loser.loanId  },
    winnerOverrides: winnerOverrides,
  }).then(function(r) {
    if (!r || !r.ok) {
      btn.disabled = false;
      btn.textContent = 'Commit Merge';
      statusEl.className = 'bi-status err';
      statusEl.textContent = 'Merge failed: ' + ((r && r.error) || 'unknown');
      return;
    }
    var picked = (r.overriddenPickFields || []).length;
    var filled = (r.filledFields || []).length;
    showToast('Merge complete — ' + picked + ' picked, ' + filled + ' gap-filled.');
    closeMergeLoanModal();
    // Winner might have been the OTHER loan — navigate to whichever
    // is the winner's loan-details page, threading owner if needed.
    var dest = SLA.urls.loanDetails(winner.loanId, { owner: winner.ownerKey });
    setTimeout(function() { window.location.href = dest; }, 700);
  }).catch(function(err) {
    btn.disabled = false;
    btn.textContent = 'Commit Merge';
    statusEl.className = 'bi-status err';
    statusEl.textContent = 'Merge failed: ' + (err && err.message || 'unknown');
  });
}

// Get raw (non-stringified) field value for the winnerOverrides payload.
function _mergeRawField(side, field, kind) {
  if (!side) return '';
  var src = kind === 'client' ? side.client : side.loan;
  if (!src) return '';
  var v = src[field];
  return (v == null) ? '' : v;
}

function reassignSwitchTab(tab) {
  _reassignTab = tab;
  document.getElementById('reassignTabExisting').classList.toggle('reassign-tab-active', tab === 'existing');
  document.getElementById('reassignTabNew').classList.toggle('reassign-tab-active', tab === 'new');
  document.getElementById('reassignPaneExisting').style.display = tab === 'existing' ? '' : 'none';
  document.getElementById('reassignPaneNew').style.display      = tab === 'new'      ? '' : 'none';
  updateReassignBtn();
}

function renderReassignClientList() {
  var q = (document.getElementById('reassignSearch').value || '').toLowerCase().trim();
  var container = document.getElementById('reassignClientList');
  var filtered = _reassignClients.filter(function(c) {
    if (!q) return true;
    var hay = ((c.firstName || '') + ' ' + (c.lastName || '') + ' ' + (c.email || '') + ' ' + (c.entityName || '')).toLowerCase();
    return hay.indexOf(q) >= 0;
  });
  if (!filtered.length) {
    container.innerHTML = '<div style="padding:1.25rem;text-align:center;color:var(--muted);font-size:13px">' +
      (q ? 'No clients match your search.' : 'No other clients yet.') + '</div>';
    return;
  }
  container.innerHTML = filtered.slice(0, 100).map(function(c) {
    var sel = (_reassignSelectedId === c.id) ? ' selected' : '';
    var isCurrent = (c.id === _client.id);
    var nm = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || (c.email || '(unnamed)');
    var meta = [];
    if (c.email) meta.push(c.email);
    if (c.entityName) meta.push(c.entityName);
    if (Array.isArray(c.loans) && c.loans.length) meta.push(c.loans.length + ' loan' + (c.loans.length === 1 ? '' : 's'));
    return '<div class="reassign-client-row' + sel + '" onclick="' +
      (isCurrent ? "showToast('That is the current client for this loan.')" : "reassignSelectClient('" + escAttr(c.id) + "')") +
      '">' +
      '<div class="rc-name">' + escH(nm) +
      (isCurrent ? '<span class="rc-current">current</span>' : '') +
      '</div>' +
      (meta.length ? '<div class="rc-meta">' + escH(meta.join(' · ')) + '</div>' : '') +
      '</div>';
  }).join('');
}

function reassignSelectClient(id) {
  _reassignSelectedId = id;
  renderReassignClientList();
  updateReassignBtn();
}

function updateReassignBtn() {
  var btn = document.getElementById('reassignConfirmBtn');
  // Deploy 236.354 — the "different borrower" checkbox is now required.
  // Every reassign in practice represents a real borrower swap; Mike
  // hit the case where he reassigned without checking and got a stale
  // app on the new guarantor. Forcing the click keeps the LO
  // intentional about clearing the app. If a records-fix-only reassign
  // ever comes up (same person, wrong client entry) we can revisit —
  // safer default is "app resets, LO acknowledges."
  var haveTarget;
  if (_reassignTab === 'existing') {
    haveTarget = !!_reassignSelectedId;
  } else {
    var fn = (document.getElementById('reassignNewFirstName').value || '').trim();
    var ln = (document.getElementById('reassignNewLastName').value || '').trim();
    var em = (document.getElementById('reassignNewEmail').value || '').trim();
    haveTarget = !!(fn || ln || em);
  }
  var cbx = document.getElementById('reassignResetAppCbx');
  var acknowledged = !!(cbx && cbx.checked);
  btn.disabled = !(haveTarget && acknowledged);
}

// Deploy 236.353 — show/hide the "what gets cleared" warning as the
// checkbox toggles. Deploy 236.354 — also refreshes the confirm
// button's enabled state (checkbox is now required to submit).
function _onReassignResetToggle() {
  var cbx  = document.getElementById('reassignResetAppCbx');
  var warn = document.getElementById('reassignResetWarning');
  if (warn) warn.style.display = (cbx && cbx.checked) ? 'block' : 'none';
  if (typeof updateReassignBtn === 'function') updateReassignBtn();
}

function confirmReassignLoan() {
  if (!_client || !_loan) return;
  var statusEl = document.getElementById('reassignStatus');
  var btn = document.getElementById('reassignConfirmBtn');

  // Deploy 236.353 — extra confirm() when the LO opted to reset the
  // application. The reassign itself is reversible-ish (they can
  // re-reassign back) but the app-clear DELETES borrower_info +
  // signed_applications. Force a second-guess click before firing.
  var resetCbx = document.getElementById('reassignResetAppCbx');
  var resetApplication = !!(resetCbx && resetCbx.checked);
  if (resetApplication) {
    var picked = '';
    if (_reassignTab === 'existing') {
      var found = _reassignClients.find(function(c){ return c && c.id === _reassignSelectedId; });
      if (found) picked = ((found.firstName || '') + ' ' + (found.lastName || '')).trim() || found.email || 'the selected client';
    } else {
      var fn = (document.getElementById('reassignNewFirstName').value || '').trim();
      var ln = (document.getElementById('reassignNewLastName').value  || '').trim();
      picked = (fn + ' ' + ln).trim() || (document.getElementById('reassignNewEmail').value || '').trim() || 'the new client';
    }
    var current = ((_client.firstName || '') + ' ' + (_client.lastName || '')).trim() || _client.email || 'the current borrower';
    var confirmMsg = 'This will:\n\n' +
      '  1. Move the loan from ' + current + ' to ' + picked + '\n' +
      '  2. DELETE the existing loan application (long-app + signed PDF)\n' +
      '  3. Unlink co-guarantors and clear vesting LLC info\n\n' +
      'The new borrower will need to fill out the application from scratch.\n\n' +
      'Continue?';
    if (!confirm(confirmMsg)) return;
  }

  btn.disabled = true;
  btn.textContent = 'Reassigning…';
  statusEl.className = 'bi-status';
  statusEl.textContent = '';

  var body = { srcClientId: _client.id, loanId: _loanId };
  if (_reassignTab === 'existing') {
    body.destClientId = _reassignSelectedId;
  } else {
    body.newClient = {
      firstName: (document.getElementById('reassignNewFirstName').value || '').trim(),
      lastName:  (document.getElementById('reassignNewLastName').value || '').trim(),
      email:     (document.getElementById('reassignNewEmail').value || '').trim(),
      phone:     (document.getElementById('reassignNewPhone').value || '').trim(),
      entityName:(document.getElementById('reassignNewEntity').value || '').trim(),
    };
  }
  if (resetApplication) body.resetApplication = true;
  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  if (ownerOvr) body.owner = ownerOvr;

  SLA.Loans.reassign(body).then(function(resp) {
    statusEl.className = 'bi-status ok';
    var bits = [];
    if (resp.destClientCreated) bits.push('new client created');
    if (resp.clearedBorrowerInfo)   bits.push('long-app cleared');
    else if (resp.movedBorrowerInfo) bits.push('long-app moved');
    if (resp.clearedSignedApp)      bits.push('signed app cleared');
    else if (resp.movedSignedApp)   bits.push('signed app moved');
    if (resp.unlinkedGuarantors)    bits.push(resp.unlinkedGuarantors + ' co-guarantor' + (resp.unlinkedGuarantors === 1 ? '' : 's') + ' unlinked');
    if (resp.movedQuotes)       bits.push(resp.movedQuotes + ' quote' + (resp.movedQuotes === 1 ? '' : 's') + ' updated');
    if (resp.movedReviews)      bits.push(resp.movedReviews + ' doc review' + (resp.movedReviews === 1 ? '' : 's') + ' updated');
    statusEl.textContent = '✓ Loan reassigned' + (bits.length ? ' (' + bits.join(', ') + ')' : '') + '. Loading the loan under the new client…';
    // Navigate to the loan-details URL under the new client. We need
    // the loan to still be the same loanId, just under a different
    // parent client.
    setTimeout(function() {
      var url = SLA.urls.loanDetails(resp.loanId, { owner: ownerOvr });
      window.location.href = url;
    }, 800);
  }).catch(function(err) {
    statusEl.className = 'bi-status err';
    statusEl.textContent = '⚠ ' + (err && err.message || 'Reassign failed');
    btn.disabled = false;
    btn.textContent = 'Reassign loan';
  });
}

// Wire search + new-form input listeners once the page is loaded.
document.addEventListener('DOMContentLoaded', function() {
  var s = document.getElementById('reassignSearch');
  if (s) s.addEventListener('input', renderReassignClientList);
  ['reassignNewFirstName','reassignNewLastName','reassignNewEmail','reassignNewPhone','reassignNewEntity'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('input', updateReassignBtn);
  });
});

function confirmCancelLoan() {
  if (!_loan || !_client) return;
  var reason = (document.getElementById('cancelReason').value || '').trim();
  var statusEl = document.getElementById('cancelLoanStatus');
  var btn = document.getElementById('cancelLoanBtn');
  btn.disabled = true;
  btn.textContent = 'Cancelling\u2026';
  statusEl.className = 'bi-status';
  statusEl.textContent = '';

  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Loans.cancel(_client.id, _loanId, reason, ownerOvr).then(function(resp) {
    statusEl.className = 'bi-status ok';
    statusEl.textContent = '\u2713 Loan cancelled' + (resp.warning ? ' \u2014 ' + resp.warning : '');
    // Update local state so the page re-renders with the new badge +
    // shows the Restore button instead of Cancel.
    if (resp.loan) {
      _loan = resp.loan;
      // Mutate the loan inside _client.loans too so future renders
      // (e.g. if another control causes a re-render) see the change.
      var loans = _client.loans || [];
      var idx = loans.findIndex(function(x) { return x.id === _loanId; });
      if (idx >= 0) loans[idx] = resp.loan;
    } else {
      _loan.status = 'cancelled';
    }
    setTimeout(function() {
      closeCancelLoanModal();
      render();
    }, 700);
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = 'Cancel loan';
    statusEl.className = 'bi-status err';
    statusEl.textContent = 'Failed: ' + ((err && err.message) || 'unknown error');
  });
}

function restoreCancelledLoan() {
  if (!_loan || !_client) return;
  if (_loan.status !== 'cancelled') {
    showToast('Loan is not cancelled.');
    return;
  }
  if (!confirm('Restore this loan?\n\nIt will return to its prior status (Awaiting Application or In Processing) and reappear in Pipeline and Loans.')) return;

  var btn = event && event.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Loans.uncancel(_client.id, _loanId, ownerOvr).then(function(resp) {
    showToast('Loan restored to ' + (resp.newStatus === 'awaiting_app' ? 'Awaiting Application' : 'In Processing'));
    if (resp.loan) {
      _loan = resp.loan;
      var loans = _client.loans || [];
      var idx = loans.findIndex(function(x) { return x.id === _loanId; });
      if (idx >= 0) loans[idx] = resp.loan;
    }
    setTimeout(function() { render(); }, 700);
  }).catch(function(err) {
    showToast('Restore failed: ' + ((err && err.message) || 'unknown'));
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  });
}

// ── Baseline LOS sync (Deploy 199 — Phase 1) ──────────────────────
// Click handler for the "Send to Baseline" / "Retry Baseline sync"
// button rendered by the Baseline panel. Calls /api/baseline-sync-
// trigger which (in Phase 1) runs the orchestrator in forced dry-run
// mode — the audit log records every "step" with the would-have-been-
// sent payload, but no HTTP calls reach Baseline. The backend persists
// the resulting refs (entity / guarantor / loan IDs) onto the loan
// record so the panel reflects sync progress immediately.
function triggerBaselineSync() {
  if (!_client || !_loan) return;
  var addr = _loan.address || 'this loan';
  var already = (_loan._baselineSyncStatus === 'synced');
  var msg = already
    ? 'Re-sync ' + addr + ' to Baseline?\n\nThis will create new records in Baseline if any IDs no longer match. Most often you want to retry only when the prior sync failed or was partial.'
    : 'Send ' + addr + ' to Baseline?\n\nThis will create the entity (if applicable), each guarantor, connect them, and create the loan.';
  if (!confirm(msg)) return;

  var btn = event && event.currentTarget;
  var originalLabel = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = 'Syncing…'; }

  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Baseline.trigger(_client.id, _loanId, ownerOvr).then(function(resp) {
    // Backend already persisted refs + status onto the loan; pull
    // fresh client/loan and re-render so the panel reflects the new
    // state (instead of trusting the response shape ourselves).
    var summary = resp && resp.loanStatus;
    if (summary === 'synced') {
      showToast('Baseline sync complete' + (resp.mode === 'dry-run' ? ' (dry-run — no API calls)' : ''));
    } else if (summary === 'partial') {
      showToast('Baseline sync partial — see admin log');
    } else {
      showToast('Baseline sync failed: ' + (resp.error || 'unknown'));
    }
    // Refresh the page state. The simplest correct thing is a soft
    // reload via the page's loader; if that's not exposed, fall back
    // to window.location.reload().
    setTimeout(function() {
      if (typeof loadLoan === 'function') {
        loadLoan().then(render);
      } else {
        window.location.reload();
      }
    }, 600);
  }).catch(function(err) {
    showToast('Baseline sync request failed: ' + ((err && err.message) || 'unknown'));
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.innerHTML = originalLabel; }
  });
}

// Deploy 221 — Reset Baseline link. Clears the SLA-side persisted
// refs (_baselineEntityId / _baselineGuarantor1Id / _baselineLoanId /
// etc.) so the next "Send to Baseline" creates fresh records. Used to
// recover from a half-synced state — e.g. when a loan was created in
// Baseline BEFORE the person↔entity connection existed, and Baseline
// therefore can't auto-derive the Guarantor. No way to fix the existing
// Baseline loan record via PATCH; only path is to recreate it.
//
// Warning shown to user since this is a destructive-ish action — they
// have to know to manually delete the orphan Baseline records to avoid
// duplicates.
function resetBaselineLink() {
  if (!_client || !_loan) return;
  var msg =
    'Reset the Baseline link for this loan?\n\n' +
    'This clears the locally-stored Baseline IDs so the next "Send to Baseline" creates fresh records. ' +
    'It does NOT delete the existing Baseline-side records — you should manually delete the orphaned loan ' +
    'in Baseline UI BEFORE clicking Retry, otherwise a duplicate will be created.\n\n' +
    'Use this when a loan got stuck in a half-synced state (e.g. exists in Baseline but missing Guarantor).';
  if (!confirm(msg)) return;

  var btn = event && event.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = 'Resetting…'; }

  var ownerOvr = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Baseline.reset(_client.id, _loanId, ownerOvr).then(function(resp) {
    showToast('Baseline refs cleared. Delete the orphan Baseline record(s), then click Send to Baseline.');
    setTimeout(function() { window.location.reload(); }, 800);
  }).catch(function(err) {
    showToast('Reset failed: ' + ((err && err.message) || 'unknown'));
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'Reset Baseline link (advanced)'; }
  });
}

// ── Change Loan Type (DSCR ↔ RTL) ─────────────────────────────────
// Rebuild the loan in the other sizer. Borrower + address info carries
// over; pricing and product-specific fields get cleared. Status reverts
// to active (Quoted in the Pipeline). Sent envelopes from before this
// change are filtered out by refreshEnvelopes() going forward.
function openChangeTypeModal() {
  if (!_loan) return;
  var isDscr = _isDscrTool(_loan.toolType);
  var target = isDscr ? 'RTL' : 'DSCR';
  var addr = _loan.address || 'this loan';
  document.getElementById('ctTitle').textContent = 'Change to ' + target + ' loan?';
  document.getElementById('ctSub').textContent = 'Switching ' + addr + ' from ' + (isDscr ? 'DSCR' : 'RTL') + ' to ' + target + '.';
  document.getElementById('ctTargetType').textContent = target;
  document.getElementById('ctConfirmBtn').disabled = false;
  document.getElementById('changeTypeOverlay').classList.add('open');
}
function closeChangeTypeModal() {
  document.getElementById('changeTypeOverlay').classList.remove('open');
}
function confirmChangeType() {
  if (!_clientId || !_loanId) return;
  var btn = document.getElementById('ctConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Rebuilding…';

  var body = { clientId: _clientId, loanId: _loanId };
  // Cross-owner — admin acting on another LO's loan
  if (_loEmail && _user && _loEmail !== _user.email) body.owner = _loEmail;

  // Deploy 236.541 — use SLA.getToken() (Supabase-aware), NOT _user.jwt():
  // for Google/Supabase-logged-in LOs _user has no .jwt() (or is null), so the
  // old call threw and the "Change loan type" button hung on "Rebuilding…".
  // getToken() handles both auth systems and returns '' (clean 401) not a crash.
  // Last unguarded .jwt() callsite in this file ([[project_netlify_jwt_crash_class]]).
  SLA.getToken().then(function(token) {
    return fetch('/api/loan-change-type', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }).then(function(r) {
    return r.json().then(function(j) { return { status: r.status, body: j }; });
  }).then(function(resp) {
    if (resp.status !== 200 || !resp.body || !resp.body.success) {
      var msg = (resp.body && resp.body.error) || ('HTTP ' + resp.status);
      btn.disabled = false;
      btn.innerHTML = 'Yes, change to <span id="ctTargetType">' + (resp.body.newToolType || '').toUpperCase() + '</span>';
      showToast('Change failed: ' + msg);
      return;
    }
    // Success — bounce to the new sizer with the loan prefilled
    showToast('Loan rebuilt — opening ' + resp.body.newToolType.toUpperCase() + ' sizer');
    setTimeout(function() {
      window.location.href = resp.body.redirectUrl;
    }, 500);
  }).catch(function(err) {
    btn.disabled = false;
    showToast('Change failed: ' + (err && err.message || 'network error'));
  });
}

// ── E-signature (envelopes) ─────────────────────────────────
// Native eSign as of Deploy 185. The "send" creates an envelope with
// per-signer tokens and emails each signer an invitation. Signers
// review + sign on /term-sheet-sign.html. When all signers complete,
// the PDFs are stamped (signature page appended) and emailed to
// everyone. See netlify/functions/_shared/native-esign.mjs.
//
// State of the open modal — rebuilt each time the modal opens:
var _esSignerCount = 0;

// Deploy 236.156 — single-signer redesign that mirrors the Send
// Loan Application flow. Pre-fills the primary borrower on the
// loan, lets the LO either email the link or just generate it
// to copy and text. Resets the link-display row + status on
// every open so a re-open after a successful send shows a fresh
// modal, not the stale "Copy" UI from last time.
function openSendForSignature() {
  document.getElementById('esDocRateSheet').checked = true;
  document.getElementById('esDocLoanApp').checked = false;
  document.getElementById('esMessage').value = '';
  document.getElementById('esStatusMsg').textContent = '';
  document.getElementById('esStatusMsg').className = 'bi-status';
  document.getElementById('esSendBtn').disabled = false;
  _esLatestUrl = '';
  document.getElementById('esLinkInput').value = '';
  document.getElementById('esLinkRow').style.display = 'none';

  document.getElementById('esSignerFirst').value = (_client && _client.firstName) || '';
  document.getElementById('esSignerLast').value  = (_client && _client.lastName)  || '';
  document.getElementById('esSignerEmail').value = (_client && _client.email)     || '';
  var cb = document.getElementById('esSendEmailCb');
  cb.checked = true;
  if (!cb._esWired) {
    cb._esWired = true;
    cb.addEventListener('change', _esRefreshSubmitLabel);
  }
  _esRefreshSubmitLabel();

  document.getElementById('esignModal').classList.add('show');
}

var _esLatestUrl = '';

// Toggle button label between "Send for Signature" / "Generate
// Link" so the action matches the email-checkbox state.
function _esRefreshSubmitLabel() {
  var btn = document.getElementById('esSendBtn');
  if (!btn) return;
  var sendEmail = document.getElementById('esSendEmailCb').checked;
  btn.textContent = sendEmail ? 'Send for Signature' : 'Generate Link';
  // Hide / show the email input row to match the checkbox state.
  var emailRow = document.getElementById('esEmailRow');
  if (emailRow) emailRow.style.display = sendEmail ? 'block' : 'none';
}

// Wire the checkbox once the DOM is parsed. Falls through quietly
// if the modal hasn't been injected yet (the listener is added on
// first openSendForSignature() call as a safety net).
document.addEventListener('DOMContentLoaded', function() {
  var cb = document.getElementById('esSendEmailCb');
  if (cb && !cb._esWired) {
    cb._esWired = true;
    cb.addEventListener('change', _esRefreshSubmitLabel);
  }
});

function esCopyLink() {
  var url = document.getElementById('esLinkInput').value;
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function() {
      var b = document.getElementById('esCopyBtn');
      var orig = b.textContent;
      b.textContent = 'Copied!';
      setTimeout(function() { b.textContent = orig; }, 1500);
    }).catch(function() { prompt('Copy this link:', url); });
  } else {
    prompt('Copy this link:', url);
  }
}

function closeEsignModal() {
  document.getElementById('esignModal').classList.remove('show');
}

function esAddSigner(fn, ln, em) {
  if (_esSignerCount >= 6) {
    showToast('Maximum 6 signers per envelope.');
    return;
  }
  _esSignerCount++;
  var idx = _esSignerCount;
  var row = document.createElement('div');
  row.className = 'es-signer-row';
  row.dataset.idx = idx;
  row.innerHTML =
    '<input type="text"  class="es-fn"    placeholder="First name" value="' + escAttr(fn || '') + '" />' +
    '<input type="text"  class="es-ln"    placeholder="Last name"  value="' + escAttr(ln || '') + '" />' +
    '<input type="email" class="es-email" placeholder="email@example.com" value="' + escAttr(em || '') + '" />' +
    '<button type="button" class="es-signer-rm" title="Remove signer" onclick="esRemoveSigner(' + idx + ')">&times;</button>';
  document.getElementById('esSignerList').appendChild(row);
  // Disable the remove button on the only signer (must keep at least one)
  esRefreshRemoveButtons();
}

function esRemoveSigner(idx) {
  var row = document.querySelector('.es-signer-row[data-idx="' + idx + '"]');
  if (row) row.parentNode.removeChild(row);
  esRefreshRemoveButtons();
}

function esRefreshRemoveButtons() {
  var rows = document.querySelectorAll('.es-signer-row');
  rows.forEach(function(r) {
    var btn = r.querySelector('.es-signer-rm');
    if (btn) btn.disabled = (rows.length <= 1);
  });
}

function _esIsValidEmail(s) {
  if (!s) return false;
  var t = String(s).trim();
  if (t.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(t);
}

function esSubmit() {
  var status = document.getElementById('esStatusMsg');
  status.className = 'bi-status';
  status.textContent = '';

  // Deploy 236.156 — single-signer flow. The signer is always
  // the primary borrower on the loan; the LO can edit the name
  // / email here before sending. Docs are hard-coded to the
  // Rate Sheet (the multi-doc Loan App option was retired).
  var docs = [{ kind: 'rate_sheet', name: 'Rate Sheet — ' + (_loan.address || 'No address') }];

  var fnEl = document.getElementById('esSignerFirst');
  var lnEl = document.getElementById('esSignerLast');
  var emEl = document.getElementById('esSignerEmail');
  var sendEmail = document.getElementById('esSendEmailCb').checked;
  var fn = fnEl.value.trim();
  var ln = lnEl.value.trim();
  var em = emEl.value.trim().toLowerCase();
  [fnEl, lnEl, emEl].forEach(function(el) { el.classList.remove('has-err'); });

  var hasErr = false;
  if (!fn) { fnEl.classList.add('has-err'); hasErr = true; }
  if (!ln) { lnEl.classList.add('has-err'); hasErr = true; }
  // Email is required when emailing; recommended even for link-only
  // (we store it on the envelope for tracking + audit-trail). If
  // link-only and the LO left it blank, fall back to a placeholder
  // so the envelope record still has a contact email field.
  if (sendEmail) {
    if (!_esIsValidEmail(em)) { emEl.classList.add('has-err'); hasErr = true; }
  } else if (em && !_esIsValidEmail(em)) {
    emEl.classList.add('has-err'); hasErr = true;
  }
  if (hasErr) {
    status.className = 'bi-status err';
    status.textContent = sendEmail
      ? 'Enter first name, last name, and a valid email — or uncheck the email option to generate a link only.'
      : 'Enter first name and last name. Email is optional when generating a link.';
    return;
  }

  // Envelope record needs a contact email even on the link-only path
  // (for the audit trail and the signer-list display). Stub one in
  // from the loan ID if the LO didn't supply one.
  var signers = [{
    firstName: fn,
    lastName:  ln,
    email:     em || ('no-email-' + (_loanId || 'loan').slice(-8) + '@unspecified.sla'),
  }];

  var btn = document.getElementById('esSendBtn');
  btn.disabled = true;
  btn.textContent = sendEmail ? 'Sending…' : 'Generating…';
  status.className = 'bi-status';
  status.textContent = 'Generating rate sheet PDF…';

  // ── Capture rate sheet PDF base64 (only if rate_sheet was selected) ──
  // The PDF generator lives in the sizer pages. We load the matching
  // sizer in a popup with ?signatureMode=1 so it generates the PDF and
  // posts the base64 back via postMessage. If no rate_sheet, we skip
  // the capture step.
  // (Deploy 185: the invisible PandaDoc anchor tags in the sizer PDFs
  // are now no-ops but harmless — they\u2019re plain white-on-white text
  // that doesn\u2019t affect rendering. Removing them is a sizer cleanup
  // for a future deploy.)
  var needsPdf = docs.some(function(d) { return d.kind === 'rate_sheet'; });

  function postCreate(pdfBase64, sigCoords) {
    // Hard gate: Netlify functions reject request bodies over 6 MB at
    // the gateway level. Pre-flight check the PDF size.
    if (pdfBase64 && pdfBase64.length > 5_000_000) {
      btn.disabled = false; _esRefreshSubmitLabel();
      status.className = 'bi-status err';
      status.textContent = 'Generated PDF is too large for direct send (' + Math.round(pdfBase64.length / 1024) + ' KB base64). Please contact support.';
      console.error('[SLA esign] PDF base64 too large:', pdfBase64.length);
      return;
    }
    if (pdfBase64) {
      console.log('[SLA esign] posting envelope create. PDF base64 size:', pdfBase64.length, 'bytes; sigCoords:', sigCoords);
    }
    // Every doc must now have pdfBase64 — the native flow stamps the
    // actual PDF. Loan-app sends here would need a separately-generated
    // PDF; for now the only doc kind in the UI is rate_sheet.
    var docsToSend = docs.map(function(d) {
      if (d.kind === 'rate_sheet' && pdfBase64) {
        return {
          kind: d.kind, name: d.name, pdfBase64: pdfBase64,
          // Deploy 186: pass through the signature-line coordinates so
          // the backend can stamp the typed signature on the line.
          sigCoords: sigCoords || null,
        };
      }
      return d;
    }).filter(function(d) { return !!d.pdfBase64; });

    if (docsToSend.length === 0) {
      btn.disabled = false;
      _esRefreshSubmitLabel();
      status.className = 'bi-status err';
      status.textContent = 'No documents had PDF bytes to send. Please pick a Rate Sheet.';
      return;
    }

    var ownerForCall = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
    status.textContent = 'Saving envelope\u2026';
    SLA.Envelopes.create({
      clientId: _clientId,
      loanId:   _loanId,
      docs:     docsToSend,
      signers:  signers,
      message:  document.getElementById('esMessage').value.trim(),
    }, ownerForCall).then(function(resp) {
      var env = resp && resp.envelope;
      if (!env) throw new Error('Envelope create returned no record');
      // Deploy 236.156 \u2014 second-phase send respects the email
      // checkbox. When unchecked, skipEmail:true tells the
      // backend to generate signing tokens + return the URLs
      // without sending any invitation emails. The LO copies
      // the displayed link and texts it to the borrower.
      status.textContent = sendEmail ? 'Sending invitation\u2026' : 'Generating signing link\u2026';
      return SLA.Envelopes.send(env.id, ownerForCall, { skipEmail: !sendEmail }).then(function(sendResp) {
        var senv = (sendResp && sendResp.envelope) || env;
        var signingUrl = (sendResp && Array.isArray(sendResp.signingUrls) && sendResp.signingUrls[0]) || '';
        _esLatestUrl = signingUrl;

        // Display the link (every flow surfaces it so the LO can
        // re-share via text even after an email send).
        if (signingUrl) {
          document.getElementById('esLinkInput').value = signingUrl;
          document.getElementById('esLinkRow').style.display = 'flex';
        }

        status.className = 'bi-status ok';
        if (!sendEmail) {
          status.textContent = '\u2713 Link generated. Copy and text it to the borrower.';
        } else if (senv.status === 'sent') {
          status.textContent = '\u2713 Sent to ' + (signers[0].email) + '. Link is shown below to share again.';
        } else if (senv.status === 'partial_send_failure') {
          status.textContent = '\u26A0 Email send failed \u2014 copy the link below and share it manually.';
        } else {
          status.textContent = '\u2713 Envelope ' + senv.status + '.';
        }
        if (sendResp && sendResp.warning) {
          status.textContent += ' (' + sendResp.warning + ')';
        }
        // Flip the primary action so closing isn't the only path.
        btn.disabled = false;
        btn.textContent = sendEmail ? 'Resend' : 'Regenerate Link';
        refreshEnvelopes();
      });
    }).catch(function(err) {
      btn.disabled = false;
      _esRefreshSubmitLabel();
      status.className = 'bi-status err';
      status.textContent = 'Failed: ' + (err.message || 'unknown error');
    });
  }

  if (!needsPdf) {
    postCreate(null, null);
    return;
  }

  // Open the matching sizer in a small popup window to generate the PDF.
  // We use window.open instead of a hidden iframe because Netlify Identity's
  // session can fail to initialize in iframes (the widget races on cookie
  // access in some browsers, redirecting the iframe to '/' before the auth
  // state propagates), which means the postMessage never fires and we time
  // out. A real popup shares storage with the parent same-origin and
  // authenticates reliably.
  // Deploy 236.87 — GUC routing: a saved GUC loan must reopen in the GUC sizer.
  var _tt = String(_loan.toolType || '').toLowerCase();
  // Deploy 236.748 — MF-program loans reopen in the Multifamily sizer.
  var sizerPage = _tt === 'rtl' ? '/rtl-sizer.html' : _tt === 'guc' ? '/guc-sizer.html'
                : _loan.mfProgram ? '/mf-dscr-sizer.html' : '/dscr-sizer.html';
  var sizerParams = 'clientId=' + encodeURIComponent(_clientId) +
                    '&loanId=' + encodeURIComponent(_loanId) +
                    '&signatureMode=1';
  if (_loan.address) sizerParams += '&loadQuote=' + encodeURIComponent(_loan.address);
  if (_loEmail && _user && _loEmail !== _user.email) {
    sizerParams += '&owner=' + encodeURIComponent(_loEmail);
  }

  var popup = window.open(
    sizerPage + '?' + sizerParams,
    'sla_pdfgen_' + Date.now(),
    'width=900,height=700,scrollbars=yes,resizable=yes'
  );
  if (!popup || popup.closed || typeof popup.closed === 'undefined') {
    btn.disabled = false; _esRefreshSubmitLabel();
    status.className = 'bi-status err';
    status.textContent = 'Popup blocked. Allow popups for this site, or open the sizer manually and try again.';
    return;
  }

  var settled = false;
  function onMsg(event) {
    if (!event.data || event.data.type !== 'sla_rate_sheet_pdf') return;
    if (settled) return;
    settled = true;
    window.removeEventListener('message', onMsg);
    try { popup.close(); } catch (_) {}
    if (!event.data.ok) {
      btn.disabled = false; btn.textContent = 'Queue Envelope';
      status.className = 'bi-status err';
      status.textContent = 'Could not generate rate sheet PDF: ' + (event.data.error || 'unknown');
      return;
    }
    // Deploy 186: forward sigCoords so the backend can stamp the typed
    // signature on the visible signature line of the rate sheet.
    postCreate(event.data.pdfBase64, event.data.sigCoords || null);
  }
  window.addEventListener('message', onMsg);

  // Safety timeout. Auth init + quote autoload + PDF gen can take a while
  // on slow connections, so we give it 25s before giving up. If the user
  // closed the popup themselves, surface that as a different message.
  var poll = setInterval(function() {
    if (settled) { clearInterval(poll); return; }
    if (popup.closed) {
      clearInterval(poll);
      settled = true;
      window.removeEventListener('message', onMsg);
      btn.disabled = false; btn.textContent = 'Queue Envelope';
      status.className = 'bi-status err';
      status.textContent = 'PDF generator window was closed before it finished. Try again.';
    }
  }, 600);

  setTimeout(function() {
    if (settled) return;
    clearInterval(poll);
    settled = true;
    window.removeEventListener('message', onMsg);
    try { popup.close(); } catch (_) {}
    btn.disabled = false; btn.textContent = 'Queue Envelope';
    status.className = 'bi-status err';
    status.textContent = 'Rate sheet generation timed out (25s). Try again, or generate the PDF in the sizer first.';
  }, 25000);
}

// Re-pull this loan's envelopes from the server and render the panel.
// Deploy 236.626 — the Download Rate Sheet button prefers the SIGNED copy.
// _signedRateSheet is { envelopeId, docIdx } when a completed envelope for this
// loan contains a signed rate-sheet doc; null otherwise. Set by refreshEnvelopes().
var _signedRateSheet = null;
function _findSignedRateSheet(envs) {
  var best = null, bestTs = -1;
  (envs || []).forEach(function(e) {
    if (!e || e.status !== 'completed') return;   // only fully-signed + stamped
    var docs = e.docs || [];
    for (var i = 0; i < docs.length; i++) {
      if (docs[i] && docs[i].kind === 'rate_sheet') {
        var ts = new Date(e.completedAt || e.updatedAt || e.createdAt || 0).getTime();
        if (ts >= bestTs) { bestTs = ts; best = { envelopeId: e.id, docIdx: i }; }
        break;
      }
    }
  });
  return best;
}
function _applyRateSheetBtn() {
  var label = document.getElementById('ldRateSheetLabel');
  var btn = document.getElementById('ldDownloadRateSheetBtn');
  if (!label || !btn) return;
  if (_signedRateSheet) {
    label.textContent = 'Download Signed Rate Sheet';
    btn.title = 'Downloads the fully-signed rate sheet.';
  } else {
    label.textContent = 'Download Rate Sheet';
    btn.removeAttribute('title');
  }
}
// Called from the button's inline onclick. Returns false (and downloads the signed
// PDF) when a signed rate sheet exists; returns true to let the href regenerate the
// unsigned sheet from the sizer otherwise.
function downloadRateSheet(ev) {
  if (_signedRateSheet) {
    if (ev && ev.preventDefault) ev.preventDefault();
    showToast('Downloading signed rate sheet…');
    downloadEnvelopeFinal(_signedRateSheet.envelopeId, _signedRateSheet.docIdx, null);
    return false;
  }
  return true;
}

// Deploy 236.628 — fill the Note Servicer datalist (#sv-servicerList in the
// Servicing section) from the org-wide Vendors note-servicer list. No-op if the
// section isn't rendered. Cached across renders in _noteServicerNames.
var _noteServicerNames = null;
function refreshNoteServicers() {
  var dl = document.getElementById('sv-servicerList');
  if (!dl) return;
  function fill(names) {
    dl.innerHTML = (names || []).map(function(nm) {
      return '<option value="' + escAttr(nm) + '"></option>';
    }).join('');
  }
  if (_noteServicerNames) { fill(_noteServicerNames); return; }
  if (!(window.SLA && SLA.NoteServicers && SLA.NoteServicers.list)) return;
  SLA.NoteServicers.list().then(function(r) {
    _noteServicerNames = (r && r.names) || [];
    fill(_noteServicerNames);
  }).catch(function() {});
}

function refreshEnvelopes() {
  if (!_clientId || !_loanId) return;
  // Feature-flagged: ESIGN_FEATURE at the top of this file. Default
  // 'on' as of Deploy 185 (native eSign is production). Setting to
  // 'off' globally hides the panel and skips the list call.
  if (!eSignVisible()) return;
  var panel = document.getElementById('envelopesPanel');
  var listEl = document.getElementById('envelopesList');
  if (!panel || !listEl) return;
  var opts = { clientId: _clientId, loanId: _loanId };
  // Cross-owner: admin viewing another LO's loan → ask for that owner's envelopes
  if (_loEmail && _user && _loEmail !== _user.email) opts.owner = _loEmail;
  SLA.Envelopes.list(opts).then(function(resp) {
    var envs = (resp && resp.envelopes) || [];
    // Hide envelopes created before the most recent loan-type change.
    // After a type change, anything signed for the old product is
    // superseded — the LO is starting over. We don't delete from storage
    // (legal/audit record stays intact), just don't display them.
    if (_loan && _loan._typeChangedAt) {
      var changeTs = new Date(_loan._typeChangedAt).getTime();
      envs = envs.filter(function(e) {
        var envTs = new Date(e.createdAt || 0).getTime();
        return envTs > changeTs;
      });
    }
    // Deploy 236.626 — surface a signed rate sheet for the Download button (runs
    // even when the panel is empty, so the button resets correctly).
    _signedRateSheet = _findSignedRateSheet(envs);
    _applyRateSheetBtn();
    if (!envs.length) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    listEl.innerHTML = envs.map(renderEnvelopeCard).join('');
  }).catch(function(err) {
    // Quiet failure — don't pollute the loan-details page with envelope errors
    console.warn('refreshEnvelopes failed:', err && err.message);
  });
}

function renderEnvelopeCard(env) {
  var status = env.status || 'queued';
  var docNames = (env.docs || []).map(function(d) {
    return d.kind === 'rate_sheet' ? 'Rate Sheet' : 'Loan App';
  }).join(' + ');
  var when = env.createdAt ? new Date(env.createdAt).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';

  // Mode badge: legacy PandaDoc envelopes vs native (Deploy 185).
  // Native envelopes get no badge by default; legacy ones get a
  // read-only indicator so the LO knows refresh/resend won\u2019t work.
  var isLegacy = (env.envelopeMode === 'pandadoc-legacy') ||
                 (!env.envelopeMode && env.pandadocMode);
  var modeBadge = isLegacy
    ? '<span class="env-mode-badge disabled">legacy</span>'
    : '';

  // Per-signer state — surfaces signed/pending so the LO can chase down
  // who hasn\u2019t signed yet without going into PandaDoc (now retired).
  var signersHtml = '';
  if (env.signers && env.signers.length) {
    signersHtml = '<div class="env-signers" style="margin-top:8px;font-size:11.5px;line-height:1.7">';
    env.signers.forEach(function(s, idx) {
      var nm = escH((s.firstName || '') + ' ' + (s.lastName || ''));
      var em = escH(s.email || '');
      var hasSigned = !!(s.hasSigned || s.signedAt);
      var stateBadge;
      if (hasSigned) {
        var when2 = s.signedAt ? new Date(s.signedAt).toLocaleString([], { month: 'short', day: 'numeric' }) : '';
        stateBadge = '<span style="color:#256940;font-weight:600">\u2713 signed' + (when2 ? ' ' + escH(when2) : '') + '</span>';
      } else {
        stateBadge = '<span style="color:#9B5E1D;font-weight:600">pending</span>';
      }
      var resendBtn = '';
      if (!hasSigned && !isLegacy && status !== 'completed' && status !== 'voided') {
        resendBtn = ' <button data-action="resend-signer" data-id="' + escAttr(env.id) + '" data-signer="' + idx + '" ' +
          'style="font-size:10px;padding:2px 7px;margin-left:6px;background:transparent;color:var(--gold,#C8813A);border:1px solid var(--gold,#C8813A);border-radius:3px;cursor:pointer">Resend</button>';
      }
      var resendInfo = '';
      if (s.resendCount && s.resendCount > 0) {
        resendInfo = ' <span style="color:var(--muted,#7A7488);font-size:10.5px">(resent ' + s.resendCount + 'x)</span>';
      }
      signersHtml += '<div>\u2022 ' + nm + ' &lt;' + em + '&gt; \u2014 ' + stateBadge + resendInfo + resendBtn + '</div>';
    });
    signersHtml += '</div>';
  }

  // Per-doc download buttons when envelope is completed
  var downloadsHtml = '';
  if (status === 'completed' && !isLegacy && env.docs && env.docs.length) {
    downloadsHtml = '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">';
    env.docs.forEach(function(d, idx) {
      downloadsHtml += '<button data-action="download-final" data-id="' + escAttr(env.id) + '" data-doc="' + idx + '" ' +
        'style="font-size:11px;font-weight:600;padding:5px 11px;background:#fff;color:var(--gold,#C8813A);border:1px solid var(--gold,#C8813A);border-radius:4px;cursor:pointer">' +
        '\u2193 ' + escH(d.name || ('Doc ' + (idx + 1))) +
      '</button>';
    });
    downloadsHtml += '</div>';
  }

  var canVoid = !isLegacy && status !== 'completed' && status !== 'voided' && status !== 'expired';
  var canRefresh = !isLegacy && status !== 'completed' && status !== 'voided' && status !== 'expired';

  var actionsArr = [];
  if (canRefresh) actionsArr.push('<button data-action="refresh" data-id="' + escAttr(env.id) + '">Refresh status</button>');
  if (canVoid)    actionsArr.push('<button data-action="void"    data-id="' + escAttr(env.id) + '">Cancel envelope</button>');
  var actionsHtml = actionsArr.length
    ? '<div class="env-card-actions">' + actionsArr.join('') + '</div>'
    : '';

  // Optional error display
  var errHtml = '';
  if (status === 'failed' && env.sendError) {
    errHtml = '<div class="env-card-meta" style="color:var(--danger);margin-top:4px">Error: ' + escH(env.sendError) + '</div>';
  } else if (status === 'partial_send_failure') {
    errHtml = '<div class="env-card-meta" style="color:#9B5E1D;margin-top:4px">Some invitation emails failed. Use Resend per-signer above.</div>';
  } else if (status === 'completed_stamping_failed') {
    errHtml = '<div class="env-card-meta" style="color:var(--danger);margin-top:4px">All signed, but PDF stamping failed: ' + escH(env.sendError || 'unknown') + '</div>';
  }

  var legacyNote = isLegacy
    ? '<div class="env-card-meta" style="color:var(--muted,#7A7488);margin-top:4px;font-style:italic">Legacy PandaDoc envelope \u2014 read only. Create a new envelope to send for signature.</div>'
    : '';

  return (
    '<div class="env-card">' +
      '<div class="env-card-top">' +
        '<div><strong>' + escH(docNames) + '</strong> ' + modeBadge + '</div>' +
        '<span class="env-status-badge ' + status + '">' + escH(status) + '</span>' +
      '</div>' +
      '<div class="env-card-meta">' +
        (when ? 'Created ' + escH(when) : '') +
      '</div>' +
      signersHtml +
      downloadsHtml +
      errHtml +
      legacyNote +
      actionsHtml +
    '</div>'
  );
}

// Delegate envelope card button clicks. Using delegation rather than
// inline onclick so escaping is simpler and the markup stays clean.
document.addEventListener('click', function(e) {
  var btn = e.target.closest && e.target.closest('.env-card-actions button, .env-card [data-action]');
  if (!btn) return;
  var action = btn.dataset.action;
  var id     = btn.dataset.id;
  if (!action || !id) return;
  if (action === 'refresh')       refreshEnvelopeStatus(id);
  else if (action === 'void')     voidEnvelope(id);
  else if (action === 'resend-signer') resendEnvelopeSigner(id, parseInt(btn.dataset.signer, 10), btn);
  else if (action === 'download-final') downloadEnvelopeFinal(id, parseInt(btn.dataset.doc, 10), btn);
});

function refreshEnvelopeStatus(envelopeId) {
  var owner = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  showToast('Refreshing\u2026');
  SLA.Envelopes.refresh(envelopeId, owner).then(function(resp) {
    if (resp && resp.changed) {
      showToast('Status updated to ' + (resp.envelope && resp.envelope.status));
    } else {
      showToast('No status change' + (resp && resp.note ? ' \u2014 ' + resp.note : ''));
    }
    refreshEnvelopes();
  }).catch(function(err) {
    showToast('Refresh failed: ' + (err.message || 'unknown'));
  });
}

function voidEnvelope(envelopeId) {
  if (!confirm('Cancel this envelope? All outstanding signing links will be invalidated. Signers who haven\u2019t signed yet will get an error if they click their link.')) return;
  var owner = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Envelopes.void(envelopeId, owner).then(function() {
    showToast('Envelope cancelled');
    refreshEnvelopes();
  }).catch(function(err) {
    showToast('Failed to cancel: ' + (err.message || 'unknown'));
  });
}

// Deploy 185: rotate one signer\u2019s token + resend their invitation email.
function resendEnvelopeSigner(envelopeId, signerIndex, btn) {
  if (!confirm('Send a new signing link to this signer? The old link will stop working.')) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
  var owner = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Envelopes.resendSigner(envelopeId, signerIndex, owner).then(function(resp) {
    if (resp && resp.emailedAt) {
      showToast('New signing link sent');
    } else {
      showToast('Token rotated but email may have failed \u2014 check delivery logs');
    }
    refreshEnvelopes();
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
    showToast('Resend failed: ' + (err.message || 'unknown'));
  });
}

// Deploy 185: download a signed copy of one doc from a completed envelope.
function downloadEnvelopeFinal(envelopeId, docIdx, btn) {
  var originalText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading\u2026'; }
  var owner = (_loEmail && _user && _loEmail !== _user.email) ? _loEmail : null;
  SLA.Envelopes.downloadFinal(envelopeId, docIdx, { owner: owner }).then(function() {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }).catch(function(err) {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
    showToast('Download failed: ' + (err.message || 'unknown'));
  });
}

function submitLoan() {
  var status = _loan.status || 'active';
  if (status !== 'active' && status !== 'on_hold') {
    showToast('This loan has already been submitted or decided.');
    return;
  }
  var notes = (document.getElementById('ld-submitNotes') || {}).value || '';
  notes = String(notes).trim();

  // Update the loan status in the client record
  var loans = _client.loans || [];
  var idx = loans.findIndex(function(l){ return l.id === _loanId; });
  if (idx < 0) { showToast('Loan not found.'); return; }
  loans[idx].status    = 'submitted';
  loans[idx].updatedAt = new Date().toISOString();
  // Persist underwriter notes on the loan record so they show on:
  //   1. The Submissions page (when UW is reviewing)
  //   2. The Notes section on this Loan Details page (history)
  //   3. The Slack notification (already happens below)
  if (notes) {
    loans[idx].submitNotes = notes;
    loans[idx].submitNotesAt = new Date().toISOString();
    // Append to free-form notes with a timestamped header so it's clear
    // these were UW notes from a submit event (vs. ad-hoc LO notes).
    var ts = new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    var header = '— Submitted for UW review (' + ts + ') —';
    var existingNotes = String(loans[idx].notes || '').trim();
    loans[idx].notes = existingNotes
      ? (existingNotes + '\n\n' + header + '\n' + notes)
      : (header + '\n' + notes);
  }
  _loan = loans[idx];
  _client.loans = loans;

  var saveOpts = _client;
  if (_loEmail && _user && _loEmail !== _user.email) {
    saveOpts = Object.assign({}, _client, { _owner: _loEmail });
  }

  SLA.Clients.save(saveOpts).then(function() {
    // Also reflect status in QuoteStore (Saved Quotes) — and forward the
    // submit notes so the Submissions page (which reads from quotes) sees
    // them on the card.
    try {
      if (window.QuoteStore) {
        var toolType = _loan.toolType || 'dscr';
        var extra = notes ? { submitNotes: notes } : {};
        QuoteStore.updateStatus(_loEmail, toolType, _loan.address, 'submitted', extra);
      }
    } catch(e) {}

    // Fire Slack notification (webhook from Settings backend)
    SLA.Settings.getAll().then(function(s) {
      var webhookUrl = (s && s.slack_webhook && s.slack_webhook.value) || '';
      if (webhookUrl) postSlackNotification(webhookUrl, notes);
      showToast(webhookUrl
        ? '\u2713 Loan submitted - Slack notification sent'
        : '\u2713 Loan submitted (configure Slack webhook in Admin)');
      render();
    }).catch(function() {
      showToast('\u2713 Loan submitted');
      render();
    });
  }).catch(function(err) {
    showToast('Submit failed: ' + (err.message || 'unknown error'));
  });
}

function postSlackNotification(webhookUrl, notes) {
  var user = _user;
  var loName  = user && user.user_metadata && user.user_metadata.full_name || '';
  var loEmail = user && user.email || '';
  var loPhone = user && user.user_metadata && user.user_metadata.phone || '';
  var c = _client;
  var l = _loan;
  var isDscr = _isDscrTool(l.toolType);
  var loanAmt = l.loanAmt || l.purchasePrice || '';
  var amtFmt  = loanAmt ? '$'+Number(loanAmt).toLocaleString() : '-';
  // Deploy 236.40 — show 3 decimals on the rate to preserve trailing zeros.
  // Deploy 236.210 — same threshold-detect as the main loan render:
  // Baseline imports store rate as decimal (0.106), SLA-native as
  // percent (10.6). <=1 → *100.
  var _rateNumSlack = parseFloat(l.rate);
  var _ratePctSlack = (isFinite(_rateNumSlack) && _rateNumSlack > 0 && _rateNumSlack <= 1) ? _rateNumSlack * 100 : _rateNumSlack;
  var rate    = (l.rate && isFinite(_ratePctSlack)) ? _ratePctSlack.toFixed(3)+'%' : '-';
  var points  = l.points || '-';
  var dateStr = new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  var loLine  = [loName, loPhone, loEmail].filter(Boolean).join(' | ');
  var blocks = [
    { type:'header', text:{ type:'plain_text', text:':house: New Loan Submitted - SLA Capital', emoji:true } },
    { type:'section', fields:[
      { type:'mrkdwn', text:'*Address*\n'+(l.address||'-') },
      { type:'mrkdwn', text:'*Borrower*\n'+((c.firstName||'')+' '+(c.lastName||'')).trim() },
      { type:'mrkdwn', text:'*Tool*\n'+(isDscr?'DSCR':'RTL / Fix & Flip') },
      { type:'mrkdwn', text:'*Loan Amount*\n'+amtFmt },
      { type:'mrkdwn', text:'*Rate / Points*\n'+rate+' / '+points },
      { type:'mrkdwn', text:'*Loan Officer*\n'+(loLine||'-') }
    ]},
    { type:'section', fields:[
      { type:'mrkdwn', text:'*Submitted*\n'+dateStr }
    ]}
  ];
  if (notes) blocks.push({ type:'section', text:{ type:'mrkdwn', text:'*Notes*\n'+notes }});
  blocks.push({ type:'divider' });
  blocks.push({ type:'context', elements:[{ type:'mrkdwn', text:'View in SLA Capital -> Clients -> Loan Details' }] });
  try {
    fetch(webhookUrl, {
      method:'POST', mode:'no-cors',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ blocks: blocks })
    });
  } catch(e) {}
}

// ── Generate Term Sheet (XLSX from server template) ─────
function downloadTermSheet() {
  if (!_loan || !_client) { showToast('Loan not loaded yet'); return; }
  showToast('Generating term sheet…');
  SLA.getToken().then(function(token) {
    var body = {
      clientId: _client.id,
      loanId: _loan.id,
    };
    if (_loEmail && _user && _loEmail !== _user.email) body._owner = _loEmail;
    return fetch('/api/termsheet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    });
  }).then(function(r) {
    if (!r.ok) {
      return r.json().catch(function(){ return {}; }).then(function(d) {
        throw new Error((d && d.error) || ('HTTP ' + r.status));
      });
    }
    // Pull filename from header if present
    var disp = r.headers.get('Content-Disposition') || '';
    var m = disp.match(/filename="?([^"]+)"?/);
    var filename = m ? m[1] : 'SLA_Term_Sheet.xlsx';
    return r.blob().then(function(blob) { return { blob: blob, filename: filename }; });
  }).then(function(out) {
    var url = URL.createObjectURL(out.blob);
    var a = document.createElement('a');
    a.href = url; a.download = out.filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    showToast('Term sheet downloaded');
  }).catch(function(err) {
    showToast('Failed: ' + (err.message || 'unknown error'));
  });
}

// ── Review submitted loan app (opens borrower-info.html in review mode) ──
function openReviewLoanApp() {
  if (!_client) { showToast('Client not loaded'); return; }
  var url = '/borrower-info.html?clientId=' + encodeURIComponent(_client.id);
  // Pass loanId so borrower-info.html loads the per-loan record (Deploy 168)
  if (_loanId) url += '&loanId=' + encodeURIComponent(_loanId);
  if (_loEmail && _user && _loEmail !== _user.email) {
    url += '&owner=' + encodeURIComponent(_loEmail);
  }
  window.open(url, '_blank');
}

// ── Borrower Info Request modal ─────────────────────────
// State for the modal: holds the latest response from the request endpoint
// so the user can re-copy the link after sending.
var _biLatestUrl = '';

function openBorrowerInfoModal() {
  if (!_client) { showToast('Client not loaded'); return; }
  // Reset modal state
  _biLatestUrl = '';
  var modal = document.getElementById('biModal');
  document.getElementById('biLinkRow').style.display = 'none';
  document.getElementById('biLinkInput').value = '';
  document.getElementById('biStatusMsg').textContent = '';
  document.getElementById('biStatusMsg').className = 'bi-status';
  document.getElementById('biSendEmailCb').checked = true;
  // Prefill priority: client email → loan's broker email → blank.
  // Broker deals often have an empty client email (the "client" is a
  // broker shell) but a valid brokerEmail on the loan record. Without
  // this, the LO saw an empty email field + a "Client has no email"
  // error on Generate.
  var _biPrefillEmail = (_client.email || '').toLowerCase();
  if (!_biPrefillEmail && _loan && _loan.brokerEmail) {
    _biPrefillEmail = String(_loan.brokerEmail).toLowerCase();
  }
  document.getElementById('biEmailInput').value = _biPrefillEmail;
  document.getElementById('biEmailRow').style.display = 'block';
  document.getElementById('biSendBtn').textContent = 'Generate Link';
  document.getElementById('biSendBtn').disabled = false;
  document.getElementById('biTitle').textContent = 'Send Full Loan Application — ' + ((_client.firstName||'') + ' ' + (_client.lastName||'')).trim();

  // Show existing-info notice if borrower already started/completed.
  // Deploy 236.59 — also surface the EXISTING link in the copy-row when
  // the application is pending or in_progress, mirroring the same fix
  // that pipeline.html got in 236.44. Lets the LO grab the link the
  // borrower already received without rotating their token (which
  // would invalidate any in-flight sign-in attempt the borrower had
  // open from the original email). Borrower-info-status.mjs has been
  // returning `token` + `link` on the GET since 236.44; we just
  // weren't consuming them on this modal.
  var info = document.getElementById('biExistingInfo');
  info.style.display = 'none';
  info.innerHTML = '';
  if (window.SLA && SLA.BorrowerInfo && SLA.BorrowerInfo.status) {
    // Capture the loanId at request time. The LO might navigate between
    // loans while the fetch is in flight; we only want to populate the
    // modal if it's still showing the same loan.
    var statusLoanId = _loanId;
    SLA.BorrowerInfo.status(_client.id, { loanId: statusLoanId }).then(function(r) {
      if (!r || !r.exists) return;
      // Drop the response if the modal is gone OR the loan changed.
      if (_loanId !== statusLoanId) return;
      var s = r.status;
      var msg = '';
      if (s === 'in_progress') msg = '<strong>In progress.</strong> Borrower has started but not finished. Generating a new link will replace the old one — copy the existing link below to share it again without invalidating it.';
      else if (s === 'complete') msg = '<strong>Already complete.</strong> The borrower has submitted this application. Copy the link below to reshare, or generate a new link to reset their data.';
      else if (s === 'pending')  msg = '<strong>Link already sent.</strong> Generating a new link will invalidate the previous one — copy the existing link below to share it again without rotating the token.';
      if (msg) {
        info.innerHTML = msg;
        info.style.display = 'block';
        document.getElementById('biSendBtn').textContent = 'Replace Link';
      }
      // Populate the existing link for ANY status where a token still
      // exists (pending, in_progress, complete). Mike: "I want a way to
      // see the existing loan application that got sent without having
      // to generate a new one." Previously gated to pending/in_progress
      // only — completed apps had to be regenerated just to reshare.
      if (r.link) {
        _biLatestUrl = r.link;
        document.getElementById('biLinkInput').value = r.link;
        document.getElementById('biLinkRow').style.display = 'flex';
      } else if (r.token) {
        // Token exists but the URL couldn't be built (env.URL missing).
        // Surface it so the LO doesn't assume they need to regenerate.
        var st = document.getElementById('biStatusMsg');
        st.className = 'bi-status';
        st.textContent = 'Existing application already sent — the link URL couldn\'t be built (env misconfig). Click Replace Link to generate a fresh one.';
      }
    }).catch(function(){});
  }

  // Toggle the email field visibility on checkbox change
  document.getElementById('biSendEmailCb').onchange = function() {
    document.getElementById('biEmailRow').style.display = this.checked ? 'block' : 'none';
  };

  modal.classList.add('show');
}

function closeBorrowerInfoModal() {
  document.getElementById('biModal').classList.remove('show');
}

function biSendOrCopy() {
  if (!_client) return;
  var sendEmail = document.getElementById('biSendEmailCb').checked;
  var email = document.getElementById('biEmailInput').value.trim();
  if (sendEmail && (!email || !email.includes('@'))) {
    var s = document.getElementById('biStatusMsg');
    s.className = 'bi-status err';
    s.textContent = 'Enter a valid email address, or uncheck the email option.';
    return;
  }

  var btn = document.getElementById('biSendBtn');
  btn.disabled = true;
  btn.textContent = sendEmail ? 'Sending…' : 'Generating…';
  var status = document.getElementById('biStatusMsg');
  status.textContent = '';
  status.className = 'bi-status';

  var opts = { sendEmail: sendEmail, loanId: _loanId };
  if (sendEmail) opts.email = email;
  if (_loEmail && _user && _loEmail !== _user.email) opts._owner = _loEmail;

  SLA.BorrowerInfo.request(_client.id, opts).then(function(resp) {
    btn.disabled = false; btn.textContent = 'Replace Link';
    _biLatestUrl = resp.url || '';
    document.getElementById('biLinkInput').value = _biLatestUrl;
    document.getElementById('biLinkRow').style.display = 'flex';
    status.className = 'bi-status ok';
    status.textContent = sendEmail
      ? (resp.emailed ? '✓ Link sent to ' + email : 'Link generated. (Email send failed; copy the link instead.)')
      : '✓ Link generated.';
    refreshBorrowerInfoStatus();
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = 'Generate Link';
    status.className = 'bi-status err';
    status.textContent = 'Failed: ' + (err.message || 'unknown error');
  });
}

function biCopyLink() {
  var url = document.getElementById('biLinkInput').value;
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function(){
      var b = document.getElementById('biCopyBtn');
      var orig = b.textContent;
      b.textContent = 'Copied!';
      setTimeout(function(){ b.textContent = orig; }, 1500);
    }).catch(function(){ prompt('Copy this link:', url); });
  } else {
    prompt('Copy this link:', url);
  }
}

// Backdrop close
document.addEventListener('click', function(e) {
  var bg = document.getElementById('biModal');
  if (e.target === bg) closeBorrowerInfoModal();
});

// ── Status refresh: shows current borrower-info state on the button ──
function refreshBorrowerInfoStatus() {
  if (!_client) return;
  if (!window.SLA || !SLA.BorrowerInfo || !SLA.BorrowerInfo.status) return;
  var btn   = document.getElementById('borrowerInfoBtn');
  var label = document.getElementById('borrowerInfoBtnLabel');
  var note  = document.getElementById('borrowerInfoStatus');
  if (!btn || !label || !note) return;

  var opts = { loanId: _loanId };
  if (_loEmail && _user && _loEmail !== _user.email) opts._owner = _loEmail;

  SLA.BorrowerInfo.status(_client.id, opts).then(function(r) {
    if (!r) return;
    btn.classList.remove('complete','in-progress');
    var s = r.status;
    var reviewBtn = document.getElementById('reviewAppBtn');
    var canReview = (s === 'complete' || s === 'in_progress');
    if (reviewBtn) reviewBtn.disabled = !canReview;
    // Deploy 179: the old DOCX-generation button was removed; signing
    // now happens inline in the borrower form and produces a signed
    // PDF stored in the signed_applications blob store. Refresh that
    // status whenever borrower-info status changes since the two are
    // tightly coupled (a complete borrower-info record usually has a
    // signed PDF too).
    refreshSignedApplicationStatus();
    // Deploy 231 — show the "Generate Application PDF (Unsigned)"
    // button whenever borrower_info exists for this loan (any status
    // beyond 'pending'). The signed PDF button still has its own
    // gating; the unsigned button is for when there's data to render
    // but no signature event. Both can be visible simultaneously —
    // signed for the legal copy, unsigned for the working snapshot.
    var unsignedBtn = document.getElementById('downloadUnsignedAppBtn');
    if (unsignedBtn) {
      var hasData = (s === 'complete' || s === 'in_progress');
      unsignedBtn.style.display = hasData ? '' : 'none';
    }
    // Don't override the gated default state when nothing's happened yet
    if (s === 'complete') {
      btn.classList.add('complete');
      label.textContent = 'Loan App Complete — Resend Link';
      note.textContent = 'Submitted ' + (r.completedAt ? new Date(r.completedAt).toLocaleDateString() : '');
    } else if (s === 'in_progress') {
      btn.classList.add('in-progress');
      label.textContent = 'Loan App — In Progress';
      note.textContent = 'Last activity: ' + (r.lastSavedAt ? new Date(r.lastSavedAt).toLocaleString() : 'unknown');
    } else if (s === 'pending') {
      btn.classList.add('in-progress');
      label.textContent = 'Loan App — Link Sent';
      note.textContent = 'Sent ' + (r.sentAt ? new Date(r.sentAt).toLocaleDateString() : 'recently') + '. Awaiting borrower.';
    } else {
      // Only reset when no record exists yet
      if (!btn.disabled) {
        label.textContent = 'Send Full Loan Application';
        note.textContent = '';
      }
    }
  }).catch(function(){});
}

// ── Signed Application status + download (Deploy 179) ───────────
// Fired alongside refreshBorrowerInfoStatus whenever the borrower-info
// state changes. Hits /api/signed-application?meta=1 to see if a signed
// PDF exists for this loan; if so unhides the download button and the
// inline status pane showing signer name, signed-at, IP, seal validity.
function refreshSignedApplicationStatus() {
  if (!_client || !_loanId) return;
  if (!window.SLA || !SLA.SignedApplication) return;
  var btn = document.getElementById('downloadSignedAppBtn');
  var pane = document.getElementById('signedAppStatus');
  if (!btn || !pane) return;

  var opts = {};
  if (_loEmail && _user && _loEmail !== _user.email) opts.owner = _loEmail;

  SLA.SignedApplication.meta(_client.id, _loanId, opts).then(function(meta) {
    if (!meta || !meta.audit) {
      btn.style.display = 'none';
      pane.style.display = 'none';
      _setStaleSignedAppBtn(false);
      return;
    }
    var a = meta.audit;
    // Deploy 236.44 — stale-signed-app detection. If the loan has been
    // re-priced (rate/loanAmt/points/term change → 'reprice' note entry)
    // after the borrower signed, the on-file signed PDF no longer
    // matches the current loan terms. Hide the download button entirely
    // and surface a "Send Updated App for Signature" button instead so
    // the LO doesn't accidentally share a stale signed app with Diya.
    // The status pane (signer name, signedAt, IP, seal) still renders
    // so the audit history is visible.
    var staleSince = _findStaleRepriceAfter(a.signedAt);
    if (staleSince) {
      btn.style.display = 'none';
      _setStaleSignedAppBtn(true, staleSince);
    } else {
      btn.style.display = '';
      _setStaleSignedAppBtn(false);
    }
    pane.style.display = '';
    var when = a.signedAt ? new Date(a.signedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown';
    var sealOK = meta.sealValid;

    // Deploy 180: status can be 'awaiting_borrower2' if borrower 2
    // hasn\u2019t signed yet. In that case the "Signed" header is
    // qualified and we show borrower 2\u2019s pending row.
    var b2Pending = meta.status === 'awaiting_borrower2'
      || (meta.borrower2 && meta.borrower2.hasPendingSignature);
    var b2 = meta.borrower2 || null;

    var html = '';
    if (b2Pending) {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<strong style="color:#9B5E1D">\u2713 Borrower 1 signed</strong>' +
        '<span style="font-size:10px;color:var(--muted,#7A7488)">awaiting Borrower 2</span>' +
        '</div>';
    } else {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
        '<strong style="color:var(--success, #1F7A4A)">\u2713 Fully signed</strong>' +
        (sealOK ? '<span style="font-size:10px;color:var(--muted,#7A7488)">audit seal verified</span>'
                : '<span style="font-size:10px;color:#9b1d20;font-weight:600">audit seal INVALID</span>') +
        '</div>';
    }
    html += '<div><span style="color:var(--muted,#7A7488)">Borrower 1:</span> ' + escH(a.signerName || '') + ' \u2014 ' + escH(when) + '</div>';
    if (a.ipAddress) html += '<div><span style="color:var(--muted,#7A7488)">IP:</span> ' + escH(a.ipAddress) + '</div>';
    if (a.geolocation) html += '<div><span style="color:var(--muted,#7A7488)">Location:</span> ' + escH(a.geolocation) + '</div>';

    if (b2) {
      if (b2.audit && b2.audit.signedAt) {
        var b2when = new Date(b2.audit.signedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        html += '<div style="margin-top:4px"><span style="color:var(--muted,#7A7488)">Borrower 2:</span> ' + escH(b2.audit.signerName || b2.name || '') + ' \u2014 ' + escH(b2when) + '</div>';
      } else {
        var invited = b2.invitedAt ? new Date(b2.invitedAt).toLocaleString('en-US', { dateStyle: 'medium' }) : '';
        var b2email = b2.email || '';
        html += '<div style="margin-top:4px"><span style="color:var(--muted,#7A7488)">Borrower 2:</span> ' +
          escH(b2.name || b2email || 'co-borrower') +
          (b2email ? ' &lt;' + escH(b2email) + '&gt;' : '') +
          ' \u2014 <span style="color:#9B5E1D">awaiting signature</span>' +
          (invited ? ' (invited ' + escH(invited) + ')' : '') +
          '</div>';
        // Deploy 182: Resend B2 link button. LO can rotate the b2 token
        // and re-send the auth email if the borrower lost the original.
        html += '<div style="margin-top:8px"><button type="button" id="resendB2Btn" ' +
          'onclick="resendBorrower2Link()" ' +
          'style="font-size:11.5px;font-weight:600;background:var(--gold,#C8813A);color:#fff;border:0;padding:6px 12px;border-radius:4px;cursor:pointer">' +
          'Resend Borrower 2 signing link' +
          '</button></div>';
      }
    }
    html += '<div><span style="color:var(--muted,#7A7488)">Consent version:</span> v' + escH(a.consentVersion || '?') + '</div>';
    pane.innerHTML = html;
  }).catch(function() {
    btn.style.display = 'none';
    pane.style.display = 'none';
    _setStaleSignedAppBtn(false);
  });
}

// Deploy 236.44 — return the timestamp of the most recent 'reprice'
// audit-log entry on the current loan that's NEWER than the signed
// date, or null if none. The loan's notesLog is built by the various
// status-change endpoints; the 'reprice' kind specifically fires from
// loan-update-from-sizer when rate / loanAmt / points / term changes.
function _findStaleRepriceAfter(signedIso) {
  if (!_loan || !signedIso) return null;
  var signedMs = new Date(signedIso).getTime();
  if (!isFinite(signedMs)) return null;
  var entries = (_loan.notesLog || []).filter(function(e) {
    return e && e.kind === 'reprice' && e.ts;
  });
  var newest = null;
  for (var i = 0; i < entries.length; i++) {
    var t = new Date(entries[i].ts).getTime();
    if (isFinite(t) && t > signedMs && (!newest || t > newest)) newest = t;
  }
  return newest ? new Date(newest).toISOString() : null;
}

// Deploy 236.44 — show/hide the "Send Updated App for Signature"
// replacement button when the on-file signed PDF no longer matches
// the current loan terms. Inserted right after the (now-hidden)
// downloadSignedAppBtn. Clicking it opens borrower-info.html in
// generate-link mode for this loan.
function _setStaleSignedAppBtn(show, staleSince) {
  var existingBtn = document.getElementById('staleSignedAppBtn');
  if (!show) {
    if (existingBtn) existingBtn.style.display = 'none';
    return;
  }
  if (!existingBtn) {
    var downloadBtn = document.getElementById('downloadSignedAppBtn');
    if (!downloadBtn || !downloadBtn.parentNode) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'staleSignedAppBtn';
    btn.className = 'open-sizer-btn esign-btn';
    btn.style.marginTop = '8px';
    btn.onclick = function() { sendUpdatedAppForSignature(); };
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 15 15" fill="none">' +
        '<path d="M2 11s2-2 5.5-2 5.5 2 5.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
        '<path d="M5 8c1-1 2-2 3-3l1 1c-1 1-2 2-3 3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
      '</svg>' +
      'Send Updated App for Signature';
    // Insert immediately after the (hidden) download button so it
    // takes the same slot in the action stack.
    downloadBtn.parentNode.insertBefore(btn, downloadBtn.nextSibling);
    existingBtn = btn;
  }
  existingBtn.style.display = '';
  // Update title to expose the reason on hover.
  if (staleSince) {
    existingBtn.title = 'Loan terms were updated after the borrower signed (last reprice: ' +
      new Date(staleSince).toLocaleString() + '). The signed PDF on file is stale.';
  }
}

// Deploy 236.44 — open borrower-info.html in LO-driven generate-link
// flow for this loan. Reuses the borrower-info-request endpoint which
// rotates the token (invalidating the stale link) so the borrower
// resigns against the updated terms.
function sendUpdatedAppForSignature() {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  var url = '/borrower-info.html?clientId=' + encodeURIComponent(_client.id) +
            '&loanId=' + encodeURIComponent(_loanId);
  if (_loEmail) url += '&owner=' + encodeURIComponent(_loEmail);
  window.open(url, '_blank');
}

// Deploy 236.149 \u2014 "Download Signed Application" now downloads
// the full regenerated bundle (signed app + every guarantor's
// data inline in long-app format + every Credit Auth inline).
// Hits /api/loan-bundle-download via authed fetch + blob URL
// (plain <a href> 401s \u2014 same pattern as
// SLA.SignedApplication.download()). The separate "Download Full
// Application Bundle" button is gone; one button, one click.
function downloadSignedApp() {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  var btn = document.getElementById('downloadSignedAppBtn');
  var originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Building application\u2026';
  var qs = '?clientId=' + encodeURIComponent(_client.id) +
           '&loanId='   + encodeURIComponent(_loanId) +
           ((_loEmail && _user && _loEmail !== _user.email)
             ? '&owner=' + encodeURIComponent(_loEmail) : '');
  SLA.getToken().then(function(token) {
    return fetch('/api/loan-bundle-download' + qs, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
  }).then(function(r) {
    if (!r.ok) {
      return r.json().catch(function() { return {}; }).then(function(d) {
        throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
      });
    }
    return r.blob().then(function(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="([^"]+)"/.exec(cd);
      a.download = m ? m[1] : 'loan-application.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    });
  }).then(function() {
    btn.disabled = false; btn.innerHTML = originalHTML;
  }).catch(function(err) {
    btn.disabled = false; btn.innerHTML = originalHTML;
    showToast('Download failed: ' + ((err && err.message) || 'unknown'));
  });
}

// Deploy 231 \u2014 Generate the UNSIGNED internal-use PDF. Hits the
// unsigned-render endpoint which builds fresh from the current
// borrower_info data each call.
function downloadUnsignedApp() {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  var btn = document.getElementById('downloadUnsignedAppBtn');
  var originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Generating\u2026';
  var opts = {};
  if (_loEmail && _user && _loEmail !== _user.email) opts.owner = _loEmail;
  SLA.SignedApplication.downloadUnsigned(_client.id, _loanId, opts).then(function() {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }).catch(function(err) {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
    showToast('Generate failed: ' + ((err && err.message) || 'unknown'));
  });
}

// Deploy 182: Resend the borrower-2 signing link. Rotates the b2 token
// server-side and emails a fresh link. UI shows immediate feedback and
// refreshes the status pane so the new \u201Cinvited\u201D timestamp shows.
function resendBorrower2Link() {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  if (!confirm('Send a new signing link to Borrower 2? The old link will stop working.')) return;
  var btn = document.getElementById('resendB2Btn');
  var originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending\u2026';
  var opts = {};
  if (_loEmail && _user && _loEmail !== _user.email) opts.owner = _loEmail;
  SLA.SignedApplication.resendBorrower2(_client.id, _loanId, opts).then(function(resp) {
    if (resp.emailedAt) {
      showToast('New signing link sent to ' + (resp.b2Email || 'borrower 2'));
    } else {
      showToast('Token rotated, but email delivery may have failed \u2014 check the LO inbox or RESEND_API_KEY.');
    }
    // Refresh the status pane to show the new invited timestamp
    refreshSignedApplicationStatus();
  }).catch(function(err) {
    btn.disabled = false;
    btn.textContent = originalText;
    showToast('Resend failed: ' + ((err && err.message) || 'unknown'));
  });
}

// Deploy 236.629/630 — send a signing link to a guarantor added AFTER Borrower 1
// signed. Opens a modal (mirroring the "Send Full Loan Application" modal) where
// the LO verifies/edits the email, chooses whether to email it, and always gets
// the copyable link to send manually. The backend creates the co-signer block on
// the signed application + (optionally) emails them.
var _csGuarantorId = '';
function openCosignerModal(btn) {
  if (!_client || !_loanId) { showToast('Loan not loaded'); return; }
  _csGuarantorId = (btn && btn.dataset && btn.dataset.csClient) || (typeof btn === 'string' ? btn : '');
  if (!_csGuarantorId) return;
  var email = (btn && btn.dataset && btn.dataset.csEmail) || '';
  var name  = (btn && btn.dataset && btn.dataset.csName) || '';
  document.getElementById('csTitle').textContent = 'Send Signing Link' + (name ? ' — ' + name : '');
  document.getElementById('csEmailInput').value = email;
  var cb = document.getElementById('csSendEmailCb');
  cb.checked = true;
  document.getElementById('csEmailRow').style.display = 'block';
  document.getElementById('csLinkRow').style.display = 'none';
  document.getElementById('csLinkInput').value = '';
  var st = document.getElementById('csStatusMsg'); st.textContent = ''; st.className = 'bi-status';
  var sb = document.getElementById('csSendBtn'); sb.disabled = false; sb.textContent = 'Send & Get Link';
  cb.onchange = function() {
    document.getElementById('csEmailRow').style.display = this.checked ? 'block' : 'none';
    document.getElementById('csSendBtn').textContent = this.checked ? 'Send & Get Link' : 'Get Link';
  };
  document.getElementById('csModal').classList.add('show');
}
function closeCosignerModal() {
  document.getElementById('csModal').classList.remove('show');
}
function csCopyLink() {
  var url = document.getElementById('csLinkInput').value;
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function() {
      var b = document.getElementById('csCopyBtn');
      var orig = b.textContent; b.textContent = 'Copied!';
      setTimeout(function() { b.textContent = orig; }, 1500);
    }).catch(function() { prompt('Copy this link:', url); });
  } else {
    prompt('Copy this link:', url);
  }
}
function csSendOrGenerate() {
  if (!_client || !_loanId || !_csGuarantorId) return;
  var sendEmail = document.getElementById('csSendEmailCb').checked;
  var email = document.getElementById('csEmailInput').value.trim();
  var st = document.getElementById('csStatusMsg');
  if (sendEmail && (!email || email.indexOf('@') < 0)) {
    st.className = 'bi-status err';
    st.textContent = 'Enter a valid email, or turn off the email option to just get the link.';
    return;
  }
  var btn = document.getElementById('csSendBtn');
  btn.disabled = true; btn.textContent = sendEmail ? 'Sending…' : 'Generating…';
  st.className = 'bi-status'; st.textContent = '';
  var opts = { sendEmail: sendEmail };
  if (email) opts.email = email;
  if (_loEmail && _user && _loEmail !== _user.email) opts.owner = _loEmail;
  SLA.SignedApplication.sendCosignerLink(_client.id, _loanId, _csGuarantorId, opts).then(function(resp) {
    btn.disabled = false; btn.textContent = sendEmail ? 'Resend & Get Link' : 'Get Link';
    if (resp && resp.link) {
      document.getElementById('csLinkInput').value = resp.link;
      document.getElementById('csLinkRow').style.display = 'flex';
    }
    st.className = 'bi-status ok';
    st.textContent = sendEmail
      ? (resp && resp.emailedAt ? '✓ Signing link sent to ' + (resp.email || email) + ' — link is below to share too.'
                                : 'Link ready below. (The email may not have gone through — copy the link to send it manually.)')
      : '✓ Link ready — copy it below to send however you like.';
    refreshSignedApplicationStatus();
  }).catch(function(err) {
    btn.disabled = false; btn.textContent = sendEmail ? 'Send & Get Link' : 'Get Link';
    st.className = 'bi-status err';
    st.textContent = (err && err.message) || 'Could not create the link.';
  });
}

// Hook the status refresh into the existing render() call.
// We monkey-patch by wrapping the original render so we don't need to find it.
var _origRender = (typeof render === 'function') ? render : null;
if (_origRender) {
  window.render = function() {
    var r = _origRender.apply(this, arguments);
    setTimeout(refreshBorrowerInfoStatus, 100); // give DOM time to mount the button
    return r;
  };
}

init();

// Deploy 236.102 — Actions dropdown toggle + click-outside close.
// Bound once at script load via event delegation so re-renders don't
// need to re-wire. The .open class on .ld-actions drives CSS.
function toggleLdActions(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  var wrap = document.getElementById('ldActions');
  if (!wrap) return;
  wrap.classList.toggle('open');
}
document.addEventListener('click', function(e) {
  var wrap = document.getElementById('ldActions');
  if (!wrap || !wrap.classList.contains('open')) return;
  if (e.target && e.target.closest && e.target.closest('#ldActions')) {
    // Click inside the menu — if it's on a menu item, close after the
    // action fires so the user sees the result without lingering UI.
    if (e.target.closest('.ld-action-menu-item')) {
      wrap.classList.remove('open');
    }
    return;
  }
  wrap.classList.remove('open');
});
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var wrap = document.getElementById('ldActions');
  if (wrap && wrap.classList.contains('open')) wrap.classList.remove('open');
});

// ════════════════════════════════════════════════════════════════════
// Deploy 236.98 (Phase B.1) — Processing Pipeline section on Loan
// Details. Renders an embedded summary + editors when the loan is in
// processing. Shares the loan-processing-stage endpoint with
// processing-pipeline.html so an edit here updates the tile there
// and vice versa. Close date uses the narrow loan-field-edit
// endpoint (no sizer round-trip needed).
// ════════════════════════════════════════════════════════════════════
var PP_STAGE_LABELS = {
  '':              '(none)',
  'new_loan':      'Intake',
  'processing':    'Processing',
  'underwriting':  'Underwriting',
  'pp_approved':   'Cleared to Close',
  'pp_closed':     'Closed',
};
var PP_STAGE_ORDER = ['new_loan', 'processing', 'underwriting', 'pp_approved', 'pp_closed'];
// Loaded from /api/settings.processing_substatuses on first render.
// Same shape as the Processing Pipeline page.
var _ppSubstatuses = null; // null = not loaded yet; {} = loaded empty
function _ppEnsureSubstatusesLoaded(cb) {
  if (_ppSubstatuses) { cb && cb(); return; }
  if (!window.SLA || !SLA.api) { _ppSubstatuses = {}; cb && cb(); return; }
  SLA.api('GET', '/api/settings').then(function(s) {
    var raw = s && s.processing_substatuses;
    _ppSubstatuses = (raw && typeof raw === 'object') ? raw : {};
    cb && cb();
  }).catch(function() { _ppSubstatuses = {}; cb && cb(); });
}

function _ppColumnFor(loan) {
  var stage = String(loan.processingStage || '').toLowerCase().trim();
  if (PP_STAGE_ORDER.indexOf(stage) >= 0) return stage;
  var status = String(loan.status || '').toLowerCase().trim();
  if (status === 'closed' || status === 'liquidated') return 'pp_closed';
  if (status === 'approved') return 'new_loan';
  return null;
}

function _ppParseLocalDate(s) {
  if (!s) return null;
  var str = String(s).trim();
  var m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    var d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
    return isNaN(d.getTime()) ? null : d;
  }
  var d2 = new Date(str);
  return isNaN(d2.getTime()) ? null : d2;
}
function _ppDaysUntilClose(s) {
  var d = _ppParseLocalDate(s);
  if (!d) return null;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function renderProcessingPipelineSection(loan, client) {
  var col = _ppColumnFor(loan);
  if (!col) return ''; // not in processing, render nothing

  // Substatus picker depends on substatuses being loaded. If they
  // aren't yet, kick off the load and trigger a re-render when
  // they arrive. The first paint shows the section without the
  // picker — it pops in on the second paint.
  _ppEnsureSubstatusesLoaded(function() {
    var sect = document.getElementById('ppSection');
    if (sect) sect.innerHTML = _ppRenderInner(loan, client, col);
  });

  return '<div class="pp-section" id="ppSection">' + _ppRenderInner(loan, client, col) + '</div>';
}

function _ppRenderInner(loan, client, col) {
  var subs = (_ppSubstatuses && _ppSubstatuses[col]) || [];
  var currentSubstatus = loan.processingSubstatus || '';
  var closeDate = loan.fundingDate || '';
  var days = _ppDaysUntilClose(closeDate);
  var pastDue   = days != null && days < 0 && col !== 'pp_closed';
  var closeSoon = days != null && days >= 0 && days <= 5;
  var closeCls  = pastDue ? ' past' : (closeSoon ? ' soon' : '');

  var stageOpts = PP_STAGE_ORDER.map(function(s) {
    var sel = s === col ? ' selected' : '';
    return '<option value="' + s + '"' + sel + '>' + escH(PP_STAGE_LABELS[s]) + '</option>';
  }).join('');

  var substatusBlock;
  if (subs.length > 0) {
    var subOpts = '<option value="">— substatus —</option>' +
      subs.map(function(s) {
        var sel = s === currentSubstatus ? ' selected' : '';
        return '<option value="' + escAttr(s) + '"' + sel + '>' + escH(s) + '</option>';
      }).join('');
    substatusBlock =
      '<div class="pp-cell">' +
        '<div class="pp-label">Substatus</div>' +
        '<select class="pp-select" id="ppSubstatusSel" onchange="_ppOnSubstatusChange(this)">' + subOpts + '</select>' +
      '</div>';
  } else {
    substatusBlock =
      '<div class="pp-cell">' +
        '<div class="pp-label">Substatus</div>' +
        '<div class="pp-empty">' + (currentSubstatus ? escH(currentSubstatus) : 'No substatuses configured for this column. Admins can add them on the Processing Pipeline page.') + '</div>' +
      '</div>';
  }

  return (
    '<div class="pp-head">' +
      '<h2>Processing Pipeline</h2>' +
      '<span class="pp-pill">In ' + escH(PP_STAGE_LABELS[col]) + '</span>' +
    '</div>' +
    '<div class="pp-body">' +
      '<div class="pp-cell">' +
        '<div class="pp-label">Stage</div>' +
        '<select class="pp-select" id="ppStageSel" onchange="_ppOnStageChange(this)">' + stageOpts + '</select>' +
      '</div>' +
      substatusBlock +
      '<div class="pp-cell">' +
        '<div class="pp-label">Close Date' + (pastDue ? ' — PAST DUE' : (closeSoon ? ' — closing in ' + days + ' day' + (days === 1 ? '' : 's') : '')) + '</div>' +
        '<input type="date" class="pp-input' + closeCls + '" id="ppCloseDateInput" value="' + escAttr(closeDate) + '" onchange="_ppOnCloseDateChange(this)" />' +
      '</div>' +
    '</div>'
  );
}

function _ppCurrentStage() {
  return _ppColumnFor(_loan) || '';
}
function _ppOwnerParam() {
  var selfKey = (_user && _user.email || '').toLowerCase().replace(/@/g, '_at_').replace(/\./g, '_dot_');
  if (_loEmail && _user && _loEmail.toLowerCase() !== _user.email.toLowerCase()) {
    return _loEmail.toLowerCase().replace(/@/g, '_at_').replace(/\./g, '_dot_');
  }
  return undefined;
}

function _ppOnStageChange(sel) {
  var newStage = sel.value;
  var current = _ppCurrentStage();
  if (newStage === current) return;
  var newIdx = PP_STAGE_ORDER.indexOf(newStage);
  var curIdx = PP_STAGE_ORDER.indexOf(current);
  if (curIdx >= 0 && newIdx >= 0 && newIdx < curIdx) {
    if (!confirm('Move this loan BACK to "' + PP_STAGE_LABELS[newStage] + '"? It is currently in "' + PP_STAGE_LABELS[current] + '".')) {
      sel.value = current;
      return;
    }
  }
  sel.disabled = true;
  var body = { clientId: _client.id, loanId: _loan.id, newStage: newStage };
  var owner = _ppOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/loan-processing-stage', body).then(function(resp) {
    if (resp && resp.loan) _loan = resp.loan;
    if (SLA.cache && SLA.cache.clear) SLA.cache.clear('clients');
    showToast && showToast('Moved to ' + PP_STAGE_LABELS[newStage]);
    render();
  }).catch(function(err) {
    sel.disabled = false;
    sel.value = current;
    showToast('Failed to move stage: ' + (err && err.message ? err.message : 'unknown'));
  });
}

function _ppOnSubstatusChange(sel) {
  var newSub = sel.value || '';
  var current = _loan.processingSubstatus || '';
  if (newSub === current) return;
  sel.disabled = true;
  var body = { clientId: _client.id, loanId: _loan.id, newStage: _ppCurrentStage(), substatus: newSub };
  var owner = _ppOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/loan-processing-stage', body).then(function(resp) {
    if (resp && resp.loan) _loan = resp.loan;
    if (SLA.cache && SLA.cache.clear) SLA.cache.clear('clients');
    showToast && showToast(newSub ? 'Substatus: ' + newSub : 'Substatus cleared');
    render();
  }).catch(function(err) {
    sel.disabled = false;
    sel.value = current;
    showToast('Failed to update substatus: ' + (err && err.message ? err.message : 'unknown'));
  });
}

function _ppOnCloseDateChange(input) {
  var newDate = input.value || '';
  var current = _loan.fundingDate || '';
  if (newDate === current) return;
  input.disabled = true;
  var body = { clientId: _client.id, loanId: _loan.id, fields: { fundingDate: newDate } };
  var owner = _ppOwnerParam();
  if (owner) body.owner = owner;
  SLA.api('POST', '/api/loan-field-edit', body).then(function(resp) {
    if (resp && resp.loan) _loan = resp.loan;
    if (SLA.cache && SLA.cache.clear) SLA.cache.clear('clients');
    showToast && showToast(newDate ? 'Close date: ' + newDate : 'Close date cleared');
    render();
  }).catch(function(err) {
    input.disabled = false;
    input.value = current;
    showToast('Failed to save close date: ' + (err && err.message ? err.message : 'unknown'));
  });
}

