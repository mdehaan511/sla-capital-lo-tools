/**
 * quotes.js — Saved Quotes Storage Module
 * Shared by dscr-sizer.html, rtl-sizer.html, and saved-quotes.html.
 *
 * Backend storage:
 *   - Persisted in the `quotes` Netlify Blobs store, via the SLA.Quotes API
 *     (see sla-api.js → /api/quotes*).
 *   - In-memory cache on the page; reads are synchronous (for back-compat
 *     with all existing callers) and served from that cache.
 *   - Writes update the cache immediately AND fire-and-forget to the backend.
 *
 * Usage:
 *   1. Page must include sla-api.js before quotes.js.
 *   2. After login, call QuoteStore.init() once — this returns a Promise
 *      that resolves when the backend load finishes. Render after it resolves
 *      to avoid flashing empty state.
 *   3. All existing synchronous calls (loadAll, saveQuote, deleteQuote, etc.)
 *      continue to work and now hit the backend under the hood.
 */

var QuoteStore = (function () {
  'use strict';

  // ── Internal state ──────────────────────────────────────────────
  // All quotes the current user owns, as a single array. Each quote
  // has toolType ('dscr' or 'rtl'), address, formData, etc.
  var _cache = [];
  var _loaded = false;
  var _loadPromise = null;

  // Flat cache of *all* users' quotes (admin-only, populated by loadAllUsers()).
  var _adminCache = null;

  // ── Helpers ─────────────────────────────────────────────────────
  function normalizeAddress(addr) {
    return (addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Deploy 236.7 (critical fix) — quote identity by LOAN, not address.
  //
  // Old behavior: quotes were keyed by `q_<tool>_<address>`. When two loans
  // existed at the same property (e.g. a borrower with poor credit applies,
  // then their partner with better credit applies for the same address),
  // the second quote save OVERWROTE the first because the storage key
  // collided. Pipeline tiles routed via address-based lookup also misrouted
  // to whichever loan won the address race.
  //
  // New behavior: a quote sourced from a known loan (_editingLoanId on
  // formData) gets a unique-per-loan ID and stores clientId/loanId at the
  // top level so the pipeline / saved-quotes panel can route via the loan
  // reference directly. Standalone quotes (typed into the sizer with no
  // loan loaded yet) keep the legacy address-based ID until the LO opens
  // a real loan record.
  function findIdxBy(toolType, opts) {
    opts = opts || {};
    // Most specific match first — by stored loanId on the quote.
    if (opts.loanId) {
      var iL = _cache.findIndex(function (q) {
        return q.toolType === toolType && q.loanId === opts.loanId;
      });
      if (iL >= 0) return iL;
    }
    // Then by explicit quoteId (used by deleteQuote when caller has the id).
    if (opts.quoteId) {
      var iQ = _cache.findIndex(function (q) { return q.id === opts.quoteId; });
      if (iQ >= 0) return iQ;
    }
    // Then by address. Prefer quotes that DON'T already have a loanId —
    // those belong to another loan at the same address, not this one.
    if (opts.address) {
      var norm = normalizeAddress(opts.address);
      var iA1 = _cache.findIndex(function (q) {
        return q.toolType === toolType && normalizeAddress(q.address) === norm && !q.loanId;
      });
      if (iA1 >= 0) return iA1;
      // Last-resort: any quote at this address. Only hit when there's no
      // loanId disambiguator — preserves the pre-fix behavior for purely
      // legacy data.
      return _cache.findIndex(function (q) {
        return q.toolType === toolType && normalizeAddress(q.address) === norm;
      });
    }
    return -1;
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    var d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function formatDateShort(isoStr) {
    if (!isoStr) return '—';
    var d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Init: load quotes for the current user from backend ─────────
  function init() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = SLA.Quotes.list().then(function (r) {
      _cache = (r && r.quotes) || [];
      _loaded = true;
      return _cache;
    }).catch(function (err) {
      console.warn('QuoteStore.init failed:', err);
      _cache = [];
      _loaded = true;
      return _cache;
    });
    return _loadPromise;
  }

  // ── Synchronous reads (served from cache) ───────────────────────
  function loadAll(userEmail, toolType) {
    // userEmail is ignored — the backend already scopes to the current user.
    if (!_loaded && !_loadPromise) init(); // lazy init
    return _cache.filter(function (q) { return q.toolType === toolType; });
  }

  function loadAllTools(userEmail) {
    if (!_loaded && !_loadPromise) init();
    // Return a fresh copy so callers can sort/mutate without affecting cache.
    return _cache.slice().sort(function (a, b) {
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  function getQuote(userEmail, toolType, addrKey, opts) {
    // opts.loanId — preferred match key (Deploy 236.7). Falls back to
    // address-only lookup for legacy quotes saved before this deploy.
    var idx = findIdxBy(toolType, {
      loanId: opts && opts.loanId,
      address: addrKey,
    });
    return idx >= 0 ? _cache[idx] : null;
  }

  // ── Mutations (update cache + fire-and-forget to backend) ────────
  function saveQuote(userEmail, toolType, formData, ownerOverride) {
    var addrKey = normalizeAddress(formData.address);
    var now = new Date().toISOString();
    // Deploy 236.7 — loanId/clientId from the sizer's editing state.
    // When set, this is the canonical identity of the loan this quote
    // represents and overrides address as the dedupe key.
    var loanId   = String((formData && formData._editingLoanId)   || '').trim() || null;
    var clientId = String((formData && formData._editingClientId) || '').trim() || null;

    var idx = findIdxBy(toolType, { loanId: loanId, address: formData.address });

    var quote;
    if (idx >= 0) {
      quote = Object.assign({}, _cache[idx], {
        address:   formData.address || '',
        borrower:  formData.borrower || '',
        updatedAt: now,
        toolType:  toolType,
        formData:  formData,
        // preserve status and savedAt
      });
      // Backfill loanId/clientId on legacy quotes that didn't have them
      // (the LO has now opened this quote inside a real loan context).
      if (loanId   && !quote.loanId)   quote.loanId   = loanId;
      if (clientId && !quote.clientId) quote.clientId = clientId;
      _cache[idx] = quote;
    } else {
      // ID strategy: unique-per-loan when we know the loan, address-based
      // as a legacy fallback. Standalone quotes (no _editingLoanId yet)
      // still get the old address-keyed id so existing single-loan flows
      // work unchanged.
      var idSuffix = loanId
        ? String(loanId).replace(/[^a-z0-9]+/gi, '_').toLowerCase()
        : String(addrKey || Date.now()).replace(/[^a-z0-9]+/g, '_');
      quote = {
        id:        'q_' + toolType + '_' + idSuffix,
        address:   formData.address || '',
        borrower:  formData.borrower || '',
        savedAt:   now,
        updatedAt: now,
        toolType:  toolType,
        status:    'active',
        formData:  formData,
        loanId:    loanId   || '',
        clientId:  clientId || '',
      };
      _cache.unshift(quote);
    }

    // Denormalize a few top-level numeric fields so users-stats (and any
    // server-side reporting) can sum without parsing formData.
    var fd = formData || {};
    quote.loanAmt  = fd.loanAmt || fd.purchasePrice || '';
    quote.loanType = fd.loanType || quote.loanType || '';

    // Cross-LO save: when admin is editing another LO's quote (sizer
    // opened with `?owner=joe@...`), `_owner` tells the backend to
    // persist under Joe's key, not Admin's. Without this, the save
    // creates a brand-new quote under Admin's owner key — looks like a
    // duplicate in the Pipeline's all-LOs view.
    var payload = ownerOverride ? Object.assign({}, quote, { _owner: ownerOverride }) : quote;

    // Persist (fire-and-forget; log failures)
    SLA.Quotes.save(payload).catch(function (err) {
      console.warn('QuoteStore.saveQuote persist failed:', err);
    });
    return quote;
  }

  function deleteQuote(userEmail, toolType, addrOrKey, opts) {
    // Deploy 236.7 — opts.loanId is preferred when caller knows the loan
    // identity. addrOrKey is kept as the third arg for back-compat (most
    // callers pass an address); we also try matching it as a quote id.
    var idx = findIdxBy(toolType, {
      loanId:  opts && opts.loanId,
      quoteId: addrOrKey,
      address: addrOrKey,
    });
    if (idx < 0) return;
    var removed = _cache[idx];
    _cache.splice(idx, 1);
    if (removed && removed.id) {
      SLA.Quotes.delete(removed.id).catch(function (err) {
        console.warn('QuoteStore.deleteQuote persist failed:', err);
      });
    }
  }

  function updateStatus(userEmail, toolType, addrKey, status, extraFields, opts) {
    // Deploy 236.7 — opts.loanId preferred over address. Same fallback
    // chain as deleteQuote.
    var idx = findIdxBy(toolType, {
      loanId:  opts && opts.loanId,
      address: addrKey,
    });
    if (idx < 0) return false;
    _cache[idx].status = status;
    _cache[idx].updatedAt = new Date().toISOString();
    // Allow callers to splice in additional fields at the same time —
    // e.g. submitNotes when transitioning to "submitted". This avoids a
    // second round-trip and keeps the quote consistent with the loan
    // record that the same caller is updating.
    if (extraFields && typeof extraFields === 'object') {
      Object.keys(extraFields).forEach(function (k) {
        _cache[idx][k] = extraFields[k];
      });
    }
    SLA.Quotes.save(_cache[idx]).catch(function (err) {
      console.warn('QuoteStore.updateStatus persist failed:', err);
    });
    return true;
  }

  // ── Admin: load all users' quotes ───────────────────────────────
  function loadAllUsers() {
    return SLA.Quotes.list({ all: true }).then(function (r) {
      _adminCache = (r && r.byOwner) || {};
      return _adminCache;
    });
  }

  /**
   * Flat list of all quotes across all users, for admin views.
   * Each item is annotated with `userEmail` (the storage owner key).
   * Call loadAllUsers() first and then this.
   */
  function getAllUsersFlat() {
    if (!_adminCache) return [];
    var flat = [];
    Object.keys(_adminCache).forEach(function (owner) {
      (_adminCache[owner] || []).forEach(function (q) {
        flat.push(Object.assign({}, q, { userEmail: owner }));
      });
    });
    flat.sort(function (a, b) { return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0); });
    return flat;
  }

  function getAdminCache() { return _adminCache; }

  // ── Inline Panel (used inside sizer pages) ─────────────────────
  var STATUS_COLORS = {
    active:   { bg: 'rgba(200,129,58,0.1)',  color: '#9a5f20',  label: '' },
    approved: { bg: 'rgba(37,105,64,0.1)',   color: '#256940',  label: '✓ Approved' },
    on_hold:  { bg: 'rgba(122,82,24,0.12)',  color: '#7a5218',  label: '⏸ On Hold' },
    denied:   { bg: 'rgba(124,31,31,0.1)',   color: '#7c1f1f',  label: '✕ Denied' },
  };

  function buildPanel(userEmail, toolType, onLoad, onDelete) {
    var panel = document.createElement('div');
    panel.id = 'quotesPanel';
    panel.style.cssText = 'background:#fff;border:1px solid var(--border);border-radius:var(--r);overflow:hidden';

    var header = document.createElement('div');
    header.style.cssText = 'padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none';
    // Item #9: drop the count badge — we cap at 3 anyway
    header.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 3h12M2 6h8M2 9h10M2 12h6" stroke="var(--gold)" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '<span style="font-size:13px;font-weight:600;color:var(--text)">Recent Quotes</span>' +
      '</div>' +
      '<svg id="quotesChevron" width="12" height="12" viewBox="0 0 12 12" fill="none" style="transition:transform 0.2s;transform:rotate(-90deg)">' +
        '<path d="M2 4l4 4 4-4" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';

    var body = document.createElement('div');
    body.id = 'quotesBody';
    body.style.cssText = 'display:none;max-height:320px;overflow-y:auto';

    header.addEventListener('click', function () {
      var open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      document.getElementById('quotesChevron').style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
    });

    // Deploy 236.7 — loan-details URL by loanId (was: by address, which
    // collided when two loans shared an address). The address index is
    // kept ONLY as a fallback for legacy quotes that haven't yet been
    // re-saved with a stored loanId/clientId.
    var loanLinkById = {};   // loanId → URL
    var loanLinkByAddr = {}; // normAddr → URL (legacy fallback)
    function refreshLoanLinks() {
      if (!window.SLA || !SLA.Clients) return;
      SLA.Clients.list().then(function(r) {
        var clients = (r && r.clients) || [];
        var norm = function(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); };
        clients.forEach(function(c) {
          (c.loans || []).forEach(function(l) {
            if (!l.id) return;
            var url = 'loan-details.html?clientId=' + encodeURIComponent(c.id) + '&loanId=' + encodeURIComponent(l.id);
            loanLinkById[l.id] = url;
            if (l.address) {
              // Address fallback: last-write-wins is fine here because
              // it's only used when the quote has NO stored loanId.
              loanLinkByAddr[norm(l.address)] = url;
            }
          });
        });
        renderBody(); // re-render with links populated
      }).catch(function(){});
    }

    function renderBody() {
      var qs = loadAll(userEmail, toolType);
      // Item #9: hide approved (in-processing), awaiting_app, closed quotes
      // — those have moved past the "recently quoted" stage
      qs = qs.filter(function(q) {
        var s = q.status || 'active';
        return s !== 'approved' && s !== 'awaiting_app' && s !== 'closed';
      });

      if (!qs.length) {
        body.innerHTML = '<div style="padding:24px;text-align:center;font-size:13px;color:var(--muted)">No saved quotes yet.<br>Price a loan and click <strong>Save Quote</strong>.</div>';
        return;
      }

      body.innerHTML = '';
      var norm = function(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); };
      qs.slice(0, 3).forEach(function (q, i) {
        var s = STATUS_COLORS[q.status] || STATUS_COLORS.active;
        // Deploy 236.7 — prefer the stored loanId. Address fallback only
        // fires for legacy quotes saved before this fix.
        var url = (q.loanId && loanLinkById[q.loanId]) || loanLinkByAddr[norm(q.address)];
        var addrHtml = url
          ? '<a href="' + url + '" style="color:inherit;text-decoration:none;border-bottom:1px solid transparent;transition:border-color 0.15s" onmouseover="this.style.borderBottomColor=\'var(--gold)\';this.style.color=\'var(--gold)\'" onmouseout="this.style.borderBottomColor=\'transparent\';this.style.color=\'\'">' + escHtml(q.address || 'No address') + '</a>'
          : escHtml(q.address || 'No address');
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 18px;' +
          (i < Math.min(qs.length, 3) - 1 ? 'border-bottom:1px solid var(--border);' : '');
        row.innerHTML =
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + addrHtml + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px;font-family:\'DM Mono\',monospace">' +
              (q.borrower ? escHtml(q.borrower) + ' · ' : '') + formatDateShort(q.updatedAt) +
            '</div>' +
          '</div>' +
          (q.status && q.status !== 'active'
            ? '<span style="font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;background:' + s.bg + ';color:' + s.color + ';white-space:nowrap">' + s.label + '</span>'
            : '') +
          '<button class="q-load-btn" style="font-size:12px;font-weight:600;padding:5px 11px;border-radius:20px;border:1px solid var(--gold-border);background:var(--gold-light);color:var(--gold-mid);cursor:pointer;font-family:\'DM Sans\',sans-serif;white-space:nowrap;transition:all 0.15s">Load</button>' +
          '<button class="q-del-btn" style="font-size:12px;padding:5px 10px;border-radius:20px;border:1px solid rgba(124,31,31,0.15);background:none;color:var(--danger);cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:all 0.15s" title="Delete">✕</button>';

        row.querySelector('.q-load-btn').addEventListener('click', function () {
          onLoad(q);
          body.style.display = 'none';
          document.getElementById('quotesChevron').style.transform = 'rotate(-90deg)';
        });
        row.querySelector('.q-del-btn').addEventListener('click', function (e) {
          e.stopPropagation();
          if (confirm('Delete saved quote for:\n' + q.address + '?')) {
            // Deploy 236.7 — delete by quote.id (unambiguous) instead of
            // address. Falls through to address-based match for legacy
            // quotes without an id field (shouldn't happen but defensive).
            deleteQuote(userEmail, toolType, q.id || q.address, { loanId: q.loanId });
            renderBody();
            if (onDelete) onDelete(q);
          }
        });
        body.appendChild(row);
      });
    }

    renderBody();
    refreshLoanLinks();
    panel._renderBody = renderBody;
    panel.appendChild(header);
    panel.appendChild(body);
    return panel;
  }

  // ── Public API ──────────────────────────────────────────────────
  return {
    init:            init,
    loadAllUsers:    loadAllUsers,
    getAllUsersFlat: getAllUsersFlat,
    getAdminCache:   getAdminCache,
    saveQuote:       saveQuote,
    deleteQuote:     deleteQuote,
    getQuote:        getQuote,
    loadAll:         loadAll,
    loadAllTools:    loadAllTools,
    updateStatus:    updateStatus,
    buildPanel:      buildPanel,
    formatDate:      formatDate,
    formatDateShort: formatDateShort,
  };
})();
