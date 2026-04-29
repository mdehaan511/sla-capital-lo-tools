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

  function getQuote(userEmail, toolType, addrKey) {
    var norm = normalizeAddress(addrKey);
    return _cache.find(function (q) {
      return q.toolType === toolType && normalizeAddress(q.address) === norm;
    }) || null;
  }

  // ── Mutations (update cache + fire-and-forget to backend) ────────
  function saveQuote(userEmail, toolType, formData) {
    var addrKey = normalizeAddress(formData.address);
    var now = new Date().toISOString();

    var idx = _cache.findIndex(function (q) {
      return q.toolType === toolType && normalizeAddress(q.address) === addrKey;
    });

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
      _cache[idx] = quote;
    } else {
      quote = {
        id:        'q_' + toolType + '_' + String(addrKey || Date.now()).replace(/[^a-z0-9]+/g, '_'),
        address:   formData.address || '',
        borrower:  formData.borrower || '',
        savedAt:   now,
        updatedAt: now,
        toolType:  toolType,
        status:    'active',
        formData:  formData,
      };
      _cache.unshift(quote);
    }

    // Denormalize a few top-level numeric fields so users-stats (and any
    // server-side reporting) can sum without parsing formData.
    var fd = formData || {};
    quote.loanAmt  = fd.loanAmt || fd.purchasePrice || '';
    quote.loanType = fd.loanType || quote.loanType || '';

    // Persist (fire-and-forget; log failures)
    SLA.Quotes.save(quote).catch(function (err) {
      console.warn('QuoteStore.saveQuote persist failed:', err);
    });
    return quote;
  }

  function deleteQuote(userEmail, toolType, addrOrKey) {
    var norm = normalizeAddress(addrOrKey);
    var removed = null;
    _cache = _cache.filter(function (q) {
      if (q.toolType === toolType && normalizeAddress(q.address) === norm) {
        removed = q; return false;
      }
      return true;
    });
    if (removed && removed.id) {
      SLA.Quotes.delete(removed.id).catch(function (err) {
        console.warn('QuoteStore.deleteQuote persist failed:', err);
      });
    }
  }

  function updateStatus(userEmail, toolType, addrKey, status) {
    var norm = normalizeAddress(addrKey);
    var idx = _cache.findIndex(function (q) {
      return q.toolType === toolType && normalizeAddress(q.address) === norm;
    });
    if (idx < 0) return false;
    _cache[idx].status = status;
    _cache[idx].updatedAt = new Date().toISOString();
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

    // Cache of address → loan-details URL, populated async after first list call
    var loanLinkCache = {};
    function refreshLoanLinks() {
      if (!window.SLA || !SLA.Clients) return;
      SLA.Clients.list().then(function(r) {
        var clients = (r && r.clients) || [];
        var norm = function(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); };
        clients.forEach(function(c) {
          (c.loans || []).forEach(function(l) {
            if (l.address && l.id) {
              loanLinkCache[norm(l.address)] = 'loan-details.html?clientId=' + encodeURIComponent(c.id) + '&loanId=' + encodeURIComponent(l.id);
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
        var url = loanLinkCache[norm(q.address)];
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
            deleteQuote(userEmail, toolType, q.address);
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
