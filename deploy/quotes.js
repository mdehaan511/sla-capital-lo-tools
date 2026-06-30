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
    // Deploy 236.11 — try quoteId FIRST. It's the most specific
    // identifier and unique by construction (it's the storage key).
    // When the caller knows the exact quote (e.g. the saved-quotes
    // panel passing q.id from a row click), this must win over
    // loanId — because two quote records can legitimately share a
    // loanId (e.g. the address-keyed legacy quote + the new
    // loanId-keyed quote both stamped with the same loanId during
    // the 236.7 transition). loanId-first would otherwise return the
    // wrong record and a delete-by-id would nuke the wrong tile.
    if (opts.quoteId) {
      var iQ = _cache.findIndex(function (q) { return q.id === opts.quoteId; });
      if (iQ >= 0) return iQ;
    }
    // Then by stored loanId on the quote.
    if (opts.loanId) {
      var iL = _cache.findIndex(function (q) {
        return q.toolType === toolType && q.loanId === opts.loanId;
      });
      if (iL >= 0) return iL;
    }
    // Then by address. Prefer quotes that DON'T already have a loanId —
    // those are legacy quotes that can still adopt this loan's identity
    // on save without trampling another loan's record.
    //
    // Deploy 236.49 — propType joins address as a fallback discriminator.
    // Without this, a borrower's Portfolio-DSCR quote at 456 Oak would
    // collide with their individual SFR-DSCR quote at the same address.
    // We only enforce propType when BOTH sides have one set (legacy
    // quotes without propType fall through to address-only matching, so
    // the fix is fully backwards-compatible).
    if (opts.address) {
      var norm = normalizeAddress(opts.address);
      var incomingPt = String((opts && opts.propType) || '').toLowerCase().trim();
      function _qPtOK(q) {
        if (!incomingPt) return true;
        var qPt = String((q.formData && q.formData.propType) || q.propType || '').toLowerCase().trim();
        if (!qPt) return true;
        return qPt === incomingPt;
      }
      var iA1 = _cache.findIndex(function (q) {
        return q.toolType === toolType
            && normalizeAddress(q.address) === norm
            && !q.loanId
            && _qPtOK(q);
      });
      if (iA1 >= 0) return iA1;
      // Last-resort: any quote at this address. Deploy 236.9 — ONLY fire
      // when the caller didn't supply a loanId. If we DO have a loanId
      // expectation and no matching-or-unstamped quote exists, we MUST
      // return -1 so the caller creates a brand-new quote for this
      // loan. Hitting a quote that belongs to a different loanId would
      // silently overwrite that other loan's record (the exact bug
      // 236.7 was supposed to fix end-to-end — turns out the save-side
      // collision survived in this fallback).
      if (!opts.loanId) {
        return _cache.findIndex(function (q) {
          return q.toolType === toolType
              && normalizeAddress(q.address) === norm
              && _qPtOK(q);
        });
      }
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
    // Deploy 236.49 — propType joins the dedup key so a portfolio quote
    // at 456 Oak coexists with an SFR quote at the same address. See
    // findIdxBy for full rationale.
    var propType = String((formData && formData.propType) || '').toLowerCase().trim() || null;

    var idx = findIdxBy(toolType, { loanId: loanId, address: formData.address, propType: propType });

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
      // Deploy 236.49 — when there's no loanId, include propType in the
      // suffix so a portfolio quote at 456 Oak gets a different ID than
      // a sfr quote at the same address. Without this, the brand-new
      // saves collide on the storage key even though findIdxBy now
      // distinguishes them. Existing single-property flows still produce
      // the same id (most loans have propType=sfr which appends "_sfr"
      // — old quotes saved without this suffix continue to round-trip
      // unchanged since we never look up by the synthetic id).
      var idSuffix = loanId
        ? String(loanId).replace(/[^a-z0-9]+/gi, '_').toLowerCase()
        : (String(addrKey || Date.now()) + (propType ? '_' + propType : '')).replace(/[^a-z0-9]+/g, '_');
      // Deploy 236.9 — when a fresh quote is being created for an
      // already-existing loan (the most common case after the 236.7
      // bug-rescue flow), inherit the loan's current status from
      // formData._loanStatus (stashed by loadFromClientLoan) instead
      // of resetting to 'active'. Without this, saving from the sizer
      // would visually demote a loan that's already in Awaiting App /
      // Submitted / Approved back to Quoted in the pipeline.
      var initialStatus = String((formData && formData._loanStatus) || '').trim() || 'active';
      quote = {
        id:        'q_' + toolType + '_' + idSuffix,
        address:   formData.address || '',
        borrower:  formData.borrower || '',
        savedAt:   now,
        updatedAt: now,
        toolType:  toolType,
        status:    initialStatus,
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

  // Deploy 236.136 — per Mike: the multi-quote "Recent Quotes"
  // accordion in the sizers is replaced with a single "Open Loan
  // Details" button keyed off the URL's clientId+loanId. Older
  // call sites (DSCR + RTL sizers) still call buildPanel() with
  // onLoad/onDelete callbacks; those are now unused but kept in
  // the signature so the sizer code doesn't have to change. The
  // returned element exposes a no-op _renderBody() to satisfy the
  // sizers' "re-render after save" hook.
  function buildPanel(userEmail, toolType, onLoad, onDelete) {
    var params  = new URLSearchParams(window.location.search);
    var cid     = params.get('clientId');
    var lid     = params.get('loanId');
    var owner   = params.get('owner');
    var panel   = document.createElement('div');
    panel.id    = 'quotesPanel';
    panel._renderBody = function() {}; // no-op shim for sizer compat

    // When the sizer is opened standalone (no clientId/loanId in
    // the URL), there's no Loan Details page to jump to yet. Hide
    // the panel entirely so the sizer's hero spacing stays clean.
    if (!cid || !lid) {
      panel.style.display = 'none';
      return panel;
    }

    var url = 'loan-details.html?clientId=' + encodeURIComponent(cid) +
              '&loanId='   + encodeURIComponent(lid) +
              (owner ? '&owner=' + encodeURIComponent(owner) : '');
    panel.style.cssText = 'background:#fff;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;display:flex;align-items:center;justify-content:space-between;padding:14px 18px;gap:12px';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M2 3h12M2 6h8M2 9h10M2 12h6" stroke="var(--gold)" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '<span style="font-size:13px;font-weight:600;color:var(--text)">You\'re editing an existing loan</span>' +
      '</div>' +
      '<a href="' + url + '" style="font-size:12px;font-weight:600;padding:7px 14px;background:var(--gold,#C8813A);color:#fff;border-radius:20px;text-decoration:none;white-space:nowrap;transition:background 0.10s" ' +
        'onmouseover="this.style.background=\'var(--gold-mid, #b5712d)\'" onmouseout="this.style.background=\'var(--gold, #C8813A)\'">' +
        'Open Loan Details →' +
      '</a>';
    return panel;
  }

  // Deploy 236.136 — legacy buildPanel kept here in case a future
  // page (e.g. saved-quotes.html) still wants the multi-row picker
  // UI. Not currently called from the sizers.
  function buildPanelLegacy(userEmail, toolType, onLoad, onDelete) {
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

  // Deploy 236.51 — backfill the resolved loanId/clientId onto a cached
  // quote after Clients.upsert creates a new loan. The save flow in the
  // sizers calls QuoteStore.saveQuote BEFORE ClientBook.upsert resolves,
  // so the quote always lands with empty loanId/clientId on a brand-new
  // save. Without this stamp, the Pipeline canonical dedup (236.45)
  // falls back to address-lookup, which is ambiguous when two loans
  // share an address (the Portfolio-vs-SFR case from 236.49) — and the
  // new quote collapses into the older quote's tile.
  function stampLoanIdOnQuote(quoteId, loanId, clientId, ownerOverride) {
    if (!quoteId || !loanId) return null;
    var idx = _cache.findIndex(function (q) { return q.id === quoteId; });
    if (idx < 0) return null;
    var q = _cache[idx];
    if (q.loanId === loanId && q.clientId === (clientId || q.clientId)) return q; // already stamped
    q.loanId = loanId;
    if (clientId) q.clientId = clientId;
    if (q.formData) {
      q.formData._editingLoanId   = loanId;
      if (clientId) q.formData._editingClientId = clientId;
    }
    q.updatedAt = new Date().toISOString();
    _cache[idx] = q;
    var payload = ownerOverride ? Object.assign({}, q, { _owner: ownerOverride }) : q;
    SLA.Quotes.save(payload).catch(function (err) {
      console.warn('QuoteStore.stampLoanIdOnQuote persist failed:', err);
    });
    return q;
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
    stampLoanIdOnQuote: stampLoanIdOnQuote,
  };
})();
